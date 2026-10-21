import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { PHONE_SIGN_IN_PURPOSE, PhoneSignInService, ResendWait } from '../../src/auth/phone-sign-in.service';
import { EmailService } from '../../src/platform/email.service';

/**
 * #871: a phone sign-in code whose mail send fails ambiguously keeps its row (live PostgreSQL).
 *
 *   A timeout or dropped connection may come after the provider took the mail, so the code that arrives must still
 *   sign in, as a password-credential code does (#806 B1), with its full life and tries. A send the provider
 *   certainly refused (the nodemailer shapes of an envelope or message refusal, a refused connection, or a transport
 *   that cannot be built) retires its row, so a code no inbox holds never takes one of the three live places a later
 *   send needs. Every failure answers the same 503 with its message (the owner's choice on #867), and the resend wait
 *   is given back. Signals only: each send outcome is forced by the capture transport; no clock is read or faked.
 */
describe('phone sign-in: a failed send keeps its code only when the mail may have gone (live PostgreSQL)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let mode: 'ok' | 'refused550' | 'refused451' | 'refusedConnect' | 'timeout' = 'ok';
  const mailbox: { to: string; code: string }[] = [];
  const SMS_KEYS = ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID', 'TELEGRAM_GATEWAY_TOKEN', 'FAST2SMS_API_KEY'];
  const saved: Record<string, string | undefined> = {};
  const run = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
  const MEMBER = `91${run}31`;
  const FAILED = { statusCode: 503, error: 'Service Unavailable', message: 'Could not send the sign-in code. Please try again.' };
  const smtpError = (message: string, props: Record<string, unknown>) => Object.assign(new Error(message), props);

  beforeAll(async () => {
    for (const k of [...SMS_KEYS, 'THROTTLE_DISABLED']) saved[k] = process.env[k];
    for (const k of SMS_KEYS) delete process.env[k];
    process.env.THROTTLE_DISABLED = 'true';
    t = await createTestApp({
      capturePhoneCode: (to, code) => {
        if (mode === 'refused550') throw smtpError("Can't send mail - all recipients were rejected", { code: 'EENVELOPE', responseCode: 550, command: 'RCPT TO' });
        if (mode === 'refused451') throw smtpError('Message failed', { code: 'EMESSAGE', responseCode: 451, command: 'DATA' });
        if (mode === 'refusedConnect') throw smtpError('connect ECONNREFUSED 127.0.0.1:587', { code: 'ESOCKET', command: 'CONN', syscall: 'connect', errno: -111 });
        mailbox.push({ to, code }); // the provider took it
        if (mode === 'timeout') throw smtpError('Timeout', { code: 'ETIMEDOUT', command: 'CONN' });
      },
    });
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.user.update({ where: { id: f.memberUser.id }, data: { phone: MEMBER, emailVerifiedAt: new Date() } });
  });

  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    await t.prisma.passwordCredentialChallenge.updateMany({
      where: { purpose: PHONE_SIGN_IN_PURPOSE, consumedAt: null, userId: f.memberUser.id },
      data: { consumedAt: new Date() },
    });
    mailbox.length = 0;
    mode = 'ok';
    (t.app.get(PhoneSignInService) as unknown as { resendWait: ResendWait }).resendWait = new ResendWait();
  });

  const http = () => request(t.app.getHttpServer());
  const ask = (phone: string) => http().post('/auth/otp/request').send({ phone, acceptEmailCode: true });
  const redeem = (phone: string, code: string) => http().post('/auth/otp/verify').send({ phone, code });
  const liveChallenges = () =>
    t.prisma.passwordCredentialChallenge.count({ where: { userId: f.memberUser.id, purpose: PHONE_SIGN_IN_PURPOSE, consumedAt: null } });
  const memberEmail = async () => (await t.prisma.user.findUniqueOrThrow({ where: { id: f.memberUser.id } })).email!.toLowerCase();

  async function signsInAfterRecovery() {
    mode = 'ok';
    await ask(MEMBER).expect(201);
    expect(mailbox.map((m) => m.to)).toEqual([await memberEmail()]); // a code is mailed to the member
    const signedIn = await redeem(MEMBER, mailbox[0].code).expect(201);
    expect(t.app.get(JwtService).verify(signedIn.body.token)).toMatchObject({ sub: f.memberUser.id });
  }

  it('a send that times out after the provider took the mail answers 503, and the code that arrives signs in once, with its full life', async () => {
    mode = 'timeout';
    const asked = await ask(MEMBER);
    expect([asked.status, asked.body]).toEqual([503, FAILED]);
    expect(mailbox.map((m) => m.to)).toEqual([await memberEmail()]);
    expect(await liveChallenges()).toBe(1);
    const [row] = await t.prisma.passwordCredentialChallenge.findMany({ where: { userId: f.memberUser.id, purpose: PHONE_SIGN_IN_PURPOSE, consumedAt: null } });
    expect(row.attempts).toBe(0);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(10 * 60_000); // "expires as usual"

    mode = 'ok';
    const signedIn = await redeem(MEMBER, mailbox[0].code).expect(201);
    expect(t.app.get(JwtService).verify(signedIn.body.token)).toMatchObject({ sub: f.memberUser.id });
    expect(await liveChallenges()).toBe(0);
    await redeem(MEMBER, mailbox[0].code).expect(401); // used once
  });

  it('three certain refusals (550 at RCPT TO), then mail recovers: the next request mails a code that signs in', async () => {
    mode = 'refused550';
    for (let i = 0; i < 3; i += 1) {
      const asked = await ask(MEMBER); // an immediate retry is allowed after each failure
      expect([asked.status, asked.body]).toEqual([503, FAILED]);
    }
    expect(mailbox).toEqual([]);
    expect(await liveChallenges()).toBe(0); // no inbox holds these codes
    await signsInAfterRecovery();
  });

  it('a transient refusal of the message itself (451 to DATA) also leaves no row', async () => {
    mode = 'refused451';
    const asked = await ask(MEMBER);
    expect([asked.status, asked.body]).toEqual([503, FAILED]);
    expect(await liveChallenges()).toBe(0);
  });

  it('a provider that refused the connection leaves no row', async () => {
    mode = 'refusedConnect';
    const asked = await ask(MEMBER);
    expect([asked.status, asked.body]).toEqual([503, FAILED]);
    expect(await liveChallenges()).toBe(0);
  });

  it('a send that throws before the provider is reached leaves no row', async () => {
    const email = t.app.get(EmailService) as unknown as { tx: () => unknown };
    const real = email.tx;
    email.tx = () => {
      throw new Error('transport cannot be built');
    };
    try {
      for (let i = 0; i < 3; i += 1) {
        const asked = await ask(MEMBER);
        expect([asked.status, asked.body]).toEqual([503, FAILED]);
      }
      expect(await liveChallenges()).toBe(0);
    } finally {
      email.tx = real;
    }
    await signsInAfterRecovery();
  });
});
