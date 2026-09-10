import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EmailService } from './email.service';

/** Every mail this file's configured-path tests hand to the transport. `vi.mock` is hoisted,
 *  so the unconfigured-path suites above never reach it. */
const sent: Array<Record<string, string>> = [];
vi.mock('nodemailer', () => ({
  createTransport: () => ({ sendMail: async (mail: Record<string, string>) => { sent.push(mail); return {}; } }),
}));

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

  it('does not place a supplied password-credential code in the legacy OTP store', async () => {
    const svc = new EmailService();
    await expect(svc.sendPasswordCredentialCode('member@example.com', '654321')).resolves.toEqual({ live: false });
    await expect(svc.verifyOtp('member@example.com', '654321')).resolves.toBe(false);
  });
});

describe('EmailService.sendMemberInvite', () => {
  beforeEach(() => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
  });

  const invite = { name: 'Vitan Growth OS', context: 'the Ambli project', role: 'pmc', signInUrl: 'https://pms.vitan.in' };

  it('reports not-live without SMTP and does NOT throw — unlike the two code senders', async () => {
    await expect(new EmailService().sendMemberInvite('growthos@vitan.in', invite)).resolves.toEqual({ live: false });
  });

  // A code sender fails closed in production (P1-1). The invite must not: it hangs off a
  // membership write that has already committed, so throwing would report a durable add as failed.
  it('still does not throw in production without SMTP', async () => {
    process.env.NODE_ENV = 'production';
    try {
      await expect(new EmailService().sendMemberInvite('growthos@vitan.in', invite)).resolves.toEqual({ live: false });
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });

  it('carries no sign-in code, and never touches the OTP store', async () => {
    const svc = new EmailService();
    await svc.sendMemberInvite('growthos@vitan.in', invite);
    // Nothing was minted, so no code can verify against this address.
    await expect(svc.verifyOtp('growthos@vitan.in', '123456')).resolves.toBe(false);
  });

  describe('with SMTP configured', () => {
    beforeEach(() => {
      sent.length = 0;
      process.env.SMTP_HOST = 'smtp.zoho.in';
      process.env.SMTP_USER = 'no-reply@vitan.in';
      process.env.SMTP_PASS = 'secret';
    });

    afterEach(() => {
      delete process.env.SMTP_HOST;
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
    });

    it('addresses the invitee, names where they were added, and links the app', async () => {
      await expect(new EmailService().sendMemberInvite('GrowthOS@Vitan.in', invite)).resolves.toEqual({ live: true });
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toBe('growthos@vitan.in');
      expect(sent[0].subject).toBe('You have been added to Vitan PMC');
      expect(sent[0].text).toContain('the Ambli project');
      expect(sent[0].text).toContain('https://pms.vitan.in');
      expect(sent[0].html).toContain('href="https://pms.vitan.in"');
      // No credential material anywhere in the body.
      expect(sent[0].text).not.toMatch(/\d{6}/);
    });

    it('omits the link when no web app origin is configured', async () => {
      await new EmailService().sendMemberInvite('growthos@vitan.in', { ...invite, signInUrl: null });
      expect(sent[0].text).toContain('Open the Vitan PMC app');
      expect(sent[0].html).not.toContain('<a href');
    });

    it('escapes caller-supplied text so an operator-typed name cannot inject markup', async () => {
      await new EmailService().sendMemberInvite('growthos@vitan.in', { ...invite, name: '<img src=x onerror=alert(1)>' });
      expect(sent[0].html).not.toContain('<img');
      expect(sent[0].html).toContain('&lt;img');
    });
  });
});
