import { describe, it, expect, beforeEach } from 'vitest';
import { EmailService } from './email.service';

describe('EmailService (dev stub — no SMTP)', () => {
  beforeEach(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  it('reports unconfigured and returns a 6-digit dev code', async () => {
    const svc = new EmailService();
    expect(svc.configured).toBe(false);
    const { live, devCode } = await svc.sendOtp('Jp@Vitan.in');
    expect(live).toBe(false);
    expect(devCode).toMatch(/^\d{6}$/);
  });

  it('verifies case-insensitively, once, and rejects wrong/expired codes', async () => {
    const svc = new EmailService();
    const { devCode } = await svc.sendOtp('jp@vitan.in');
    expect(await svc.verifyOtp('jp@vitan.in', '000000')).toBe(false);
    expect(await svc.verifyOtp('JP@VITAN.IN', devCode!)).toBe(true); // case-insensitive
    expect(await svc.verifyOtp('jp@vitan.in', devCode!)).toBe(false); // single-use
  });

  it('goes configured once SMTP env is present', () => {
    process.env.SMTP_HOST = 'smtp.zoho.in';
    process.env.SMTP_USER = 'no-reply@vitan.in';
    process.env.SMTP_PASS = 'secret';
    expect(new EmailService().configured).toBe(true);
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  it('P1-1: in production with no SMTP, refuses (503) instead of returning the code', async () => {
    process.env.NODE_ENV = 'production';
    try {
      const svc = new EmailService();
      await expect(svc.sendOtp('jp@vitan.in')).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });
});
