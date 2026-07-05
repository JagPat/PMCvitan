import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SmsService } from './sms.service';

// With no provider configured the service is in dev-stub mode.
describe('SmsService (dev stub)', () => {
  beforeEach(() => {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;
    delete process.env.TELEGRAM_GATEWAY_TOKEN;
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
