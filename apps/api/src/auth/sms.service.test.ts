import { describe, it, expect, beforeEach } from 'vitest';
import { SmsService } from './sms.service';

// With no MSG91 provider configured the service is in dev-stub mode.
describe('SmsService (dev stub)', () => {
  beforeEach(() => {
    delete process.env.MSG91_AUTH_KEY;
    delete process.env.MSG91_TEMPLATE_ID;
  });

  it('reports non-live and returns a 4-digit dev code', async () => {
    const sms = new SmsService();
    expect(sms.live).toBe(false);
    const { live, devCode } = await sms.sendOtp('9876543210');
    expect(live).toBe(false);
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

  it('goes live once both MSG91 env vars are present', () => {
    process.env.MSG91_AUTH_KEY = 'key';
    process.env.MSG91_TEMPLATE_ID = 'tpl';
    expect(new SmsService().live).toBe(true);
  });
});
