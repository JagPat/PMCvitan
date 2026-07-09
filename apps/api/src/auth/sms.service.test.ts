import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SmsService } from './sms.service';

// With no provider configured the service is in dev-stub mode.
describe('SmsService (dev stub)', () => {
  beforeEach(() => {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;
    delete process.env.TELEGRAM_GATEWAY_TOKEN;
    delete process.env.FAST2SMS_API_KEY;
  });

  it('reports non-live and returns a 4-digit dev code, channel=stub', async () => {
    const sms = new SmsService();
    expect(sms.live).toBe(false);
    expect(sms.channel).toBe('stub');
    const { live, channel, devCode } = await sms.sendOtp('9876543210');
    expect(live).toBe(false);
    expect(channel).toBe('stub');
    expect(devCode).toMatch(/^\d{4}$/);
  });

  it('verifies the issued code, once, and rejects wrong codes', async () => {
    const sms = new SmsService();
    const { devCode } = await sms.sendOtp('9876543210');
    expect(await sms.verifyOtp('9876543210', '0000')).toBe(false);
    expect(await sms.verifyOtp('9876543210', devCode!)).toBe(true);
    // code is single-use — a replay fails
    expect(await sms.verifyOtp('9876543210', devCode!)).toBe(false);
  });

  it('rejects verification for a phone that never requested a code', async () => {
    const sms = new SmsService();
    expect(await sms.verifyOtp('9000000000', '1234')).toBe(false);
  });

  it('goes live once both MSG91 env vars are present (channel=sms)', () => {
    process.env.MSG91_AUTH_KEY = 'key';
    process.env.MSG91_TEMPLATE_ID = 'tpl';
    const sms = new SmsService();
    expect(sms.live).toBe(true);
    expect(sms.channel).toBe('sms');
  });
});

// Telegram Gateway channel: live delivery of a code we generate, verified locally.
describe('SmsService (Telegram Gateway)', () => {
  beforeEach(() => {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;
    delete process.env.FAST2SMS_API_KEY;
    process.env.TELEGRAM_GATEWAY_TOKEN = 'tg-token';
  });
  afterEach(() => {
    delete process.env.TELEGRAM_GATEWAY_TOKEN;
    vi.restoreAllMocks();
  });

  it('sends via Telegram (E.164), reports live with no devCode, and verifies locally', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { request_id: 'r1' } }) });
    vi.stubGlobal('fetch', fetchMock);

    const sms = new SmsService();
    expect(sms.channel).toBe('telegram');
    const r = await sms.sendOtp('9876543210');
    expect(r.live).toBe(true);
    expect(r.channel).toBe('telegram');
    expect(r.devCode).toBeUndefined();

    // called the Telegram Gateway with an E.164 number and a 4-digit code
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gatewayapi.telegram.org/sendVerificationMessage');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.phone_number).toBe('+919876543210');
    expect(String(body.code)).toMatch(/^\d{4}$/);

    // verify uses the locally-stored code (Telegram is not remote-verified)
    expect(await sms.verifyOtp('9876543210', '0000')).toBe(false);
    expect(await sms.verifyOtp('9876543210', String(body.code))).toBe(true);
  });

  it('throws when the Telegram Gateway rejects the send', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ ok: false, error: 'PHONE_INVALID' }) }));
    await expect(new SmsService().sendOtp('9876543210')).rejects.toThrow();
  });
});

// Fast2SMS channel: real SMS via the DLT-exempt `otp` route, code generated + verified locally.
describe('SmsService (Fast2SMS)', () => {
  beforeEach(() => {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;
    delete process.env.TELEGRAM_GATEWAY_TOKEN;
    process.env.FAST2SMS_API_KEY = 'f2s-key';
  });
  afterEach(() => {
    delete process.env.FAST2SMS_API_KEY;
    vi.restoreAllMocks();
  });

  it('sends via Fast2SMS (otp route, 10-digit), reports live with no devCode, verifies locally', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ return: true, request_id: 'r1', message: ['sent'] }) });
    vi.stubGlobal('fetch', fetchMock);

    const sms = new SmsService();
    expect(sms.channel).toBe('fast2sms');
    const r = await sms.sendOtp('9876543210');
    expect(r.live).toBe(true);
    expect(r.channel).toBe('fast2sms');
    expect(r.devCode).toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0];
    const u = new URL(url as string);
    expect(u.origin + u.pathname).toBe('https://www.fast2sms.com/dev/bulkV2');
    expect(u.searchParams.get('route')).toBe('otp');
    expect(u.searchParams.get('numbers')).toBe('9876543210');
    const code = u.searchParams.get('variables_values')!;
    expect(code).toMatch(/^\d{4}$/);
    // the API key travels in the header, never the query string
    expect((init as { headers: Record<string, string> }).headers.authorization).toBe('f2s-key');
    expect(u.searchParams.get('authorization')).toBeNull();

    // locally verified (single-use)
    expect(await sms.verifyOtp('9876543210', '0000')).toBe(false);
    expect(await sms.verifyOtp('9876543210', code)).toBe(true);
    expect(await sms.verifyOtp('9876543210', code)).toBe(false);
  });

  it('throws when Fast2SMS rejects the send (return:false)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ return: false, message: 'Invalid Authentication' }) }));
    await expect(new SmsService().sendOtp('9876543210')).rejects.toThrow();
  });

  it('takes priority over the Telegram Gateway when both are configured', () => {
    process.env.TELEGRAM_GATEWAY_TOKEN = 'tg';
    expect(new SmsService().channel).toBe('fast2sms');
    delete process.env.TELEGRAM_GATEWAY_TOKEN;
  });
});
