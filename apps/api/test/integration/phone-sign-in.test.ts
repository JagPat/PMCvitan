import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { PHONE_SIGN_IN_PURPOSE, PhoneSignInService, ResendWait } from '../../src/auth/phone-sign-in.service';

/**
 * #827 one-screen sign-in, server unit (replaces #856). With mail configured and no SMS provider, a phone
 * sign-in's code is emailed to the account that owns the number, as a durable challenge row under the credential
 * lock — and only to an account whose email is established (a password set or the address verified).
 */
describe('phone sign-in code by email (live PostgreSQL)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let mailFails = false;
  const mailbox: Array<{ to: string; code: string }> = [];
  const SMS_KEYS = ['MSG91_AUTH_KEY', 'MSG91_TEMPLATE_ID', 'TELEGRAM_GATEWAY_TOKEN', 'FAST2SMS_API_KEY'];
  const saved: Record<string, string | undefined> = {};
  const run = Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
  const PHONE = { member: `91${run}01`, client: `91${run}02`, stranger: `91${run}03`, unknown: `91${run}04` };

  beforeAll(async () => {
    for (const k of [...SMS_KEYS, 'THROTTLE_DISABLED', 'AUTH_ALLOW_PHONE_SIGNUP']) saved[k] = process.env[k];
    for (const k of SMS_KEYS) delete process.env[k];
    process.env.THROTTLE_DISABLED = 'true';
    process.env.AUTH_ALLOW_PHONE_SIGNUP = 'true'; // even with phone signup on, an emailed code never provisions
    t = await createTestApp({
      capturePhoneCode: (to, code) => {
        if (mailFails) throw new Error('smtp down');
        mailbox.push({ to, code });
      },
    });
    f = await createTwoProjectFixture(t.prisma);
    // the member's email is established; the client was invited and has not set up a password yet; the stranger
    // has an established email but no active membership
    await t.prisma.user.update({ where: { id: f.memberUser.id }, data: { phone: PHONE.member, emailVerifiedAt: new Date() } });
    await t.prisma.user.update({ where: { id: f.clientUser.id }, data: { phone: PHONE.client } });
    await t.prisma.user.update({ where: { id: f.strangerUser.id }, data: { phone: PHONE.stranger, emailVerifiedAt: new Date() } });
  });

  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    mailbox.length = 0;
    mailFails = false;
    // each case starts outside every number's resend wait
    (t.app.get(PhoneSignInService) as unknown as { resendWait: ResendWait }).resendWait = new ResendWait();
  });

  const http = () => request(t.app.getHttpServer());
  const ask = (phone: string) => http().post('/auth/otp/request').send({ phone });
  const redeem = (phone: string, code: string) => http().post('/auth/otp/verify').send({ phone, code });
  const liveChallenges = (userId: string) =>
    t.prisma.passwordCredentialChallenge.count({ where: { userId, purpose: PHONE_SIGN_IN_PURPOSE, consumedAt: null } });

  it('emails a 4-digit code to the established account that owns the number, and the code signs that account in once', async () => {
    const asked = await ask(PHONE.member).expect(201);
    expect(asked.body).toEqual({ sent: true, live: true, channel: 'email', codeLength: 4 });
    expect(mailbox).toEqual([{ to: (await t.prisma.user.findUniqueOrThrow({ where: { id: f.memberUser.id } })).email, code: expect.stringMatching(/^\d{4}$/) }]);
    const { code } = mailbox[0];

    const signedIn = await redeem(PHONE.member, code).expect(201);
    expect(t.app.get(JwtService).verify(signedIn.body.token)).toMatchObject({ sub: f.memberUser.id });
    expect(await liveChallenges(f.memberUser.id)).toBe(0);
    expect(await t.prisma.securityAuditEvent.count({ where: { targetUserId: f.memberUser.id, action: 'auth.phone_sign_in' } })).toBe(1);
    await redeem(PHONE.member, code).expect(401); // used once
  });

  it('answers an unknown number, an invited account and an account with no access exactly as a known one, and mails nothing', async () => {
    for (const phone of [PHONE.unknown, PHONE.client, PHONE.stranger]) {
      const asked = await ask(phone).expect(201);
      expect(asked.body).toEqual({ sent: true, live: true, channel: 'email', codeLength: 4 });
    }
    expect(mailbox).toEqual([]);
    expect(await liveChallenges(f.clientUser.id)).toBe(0);
    expect(await liveChallenges(f.strangerUser.id)).toBe(0);
    await redeem(PHONE.unknown, '1234').expect(401);
    expect(await t.prisma.user.count({ where: { phone: PHONE.unknown } })).toBe(0); // never provisions
  });

  it('keeps the per-number resend wait, for known and unknown numbers alike', async () => {
    await ask(PHONE.member).expect(201);
    await ask(PHONE.member).expect(429);
    await ask(PHONE.unknown).expect(201);
    await ask(PHONE.unknown).expect(429);
    expect(mailbox).toHaveLength(1);
  });

  it('a resend whose email fails answers 503 and leaves the code already delivered working', async () => {
    await ask(PHONE.member).expect(201);
    const first = mailbox[0].code;
    (t.app.get(PhoneSignInService) as unknown as { resendWait: ResendWait }).resendWait = new ResendWait(0);
    mailFails = true;
    await ask(PHONE.member).expect(503);
    await redeem(PHONE.member, first).expect(201);
  });

  it('a newer code retires the older one', async () => {
    (t.app.get(PhoneSignInService) as unknown as { resendWait: ResendWait }).resendWait = new ResendWait(0);
    await ask(PHONE.member).expect(201);
    await ask(PHONE.member).expect(201);
    const [older, newer] = mailbox.map((m) => m.code);
    if (older !== newer) await redeem(PHONE.member, older).expect(401);
    await redeem(PHONE.member, newer).expect(201);
  });

  it('five wrong tries burn the code', async () => {
    await ask(PHONE.member).expect(201);
    const { code } = mailbox[0];
    const wrong = code === '1111' ? '2222' : '1111';
    for (let i = 0; i < 5; i += 1) await redeem(PHONE.member, wrong).expect(401);
    await redeem(PHONE.member, code).expect(401);
  });

  it('a code stops working once the account’s email is not the address it was mailed to', async () => {
    await ask(PHONE.member).expect(201);
    const { code } = mailbox[0];
    const before = await t.prisma.user.findUniqueOrThrow({ where: { id: f.memberUser.id } });
    await t.prisma.user.update({ where: { id: f.memberUser.id }, data: { email: `moved-${before.email}` } });
    try {
      await redeem(PHONE.member, code).expect(401);
    } finally {
      await t.prisma.user.update({ where: { id: f.memberUser.id }, data: { email: before.email } });
    }
  });

  it('an administrator cannot correct the email of an account that can receive these codes', async () => {
    const owner = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: f.memberUser.id, role: 'member' } });
    try {
      await http()
        .patch(`/orgs/${f.orgA.id}/members/${f.memberUser.id}/invitation-email`)
        .set('Authorization', `Bearer ${owner}`)
        .send({ email: `corrected-${run}@test.local` })
        .expect(400);
    } finally {
      await t.prisma.orgMembership.delete({ where: { orgId_userId: { orgId: f.orgA.id, userId: f.memberUser.id } } });
    }
  });

  it('two redemptions of one code at once sign in exactly once', async () => {
    await ask(PHONE.member).expect(201);
    const { code } = mailbox[0];
    const results = await Promise.all([redeem(PHONE.member, code), redeem(PHONE.member, code)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
  });
});
