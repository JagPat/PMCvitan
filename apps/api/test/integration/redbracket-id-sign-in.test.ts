/**
 * Redbracket ID A3 — PMC's sign-in and password setup through Redbracket ID, against a local fake of the issuer
 * (test/unit-support/fake-issuer.ts answers the same paths id.vitan.in does, and records every request it gets).
 *
 * The proofs Jagrut's spec asks for before any deploy (2 Nov 2026):
 * - switch off: a sign-in opens no connection to the issuer (the fake records nothing, and nothing asks id.vitan.in);
 * - switch on: a password set at the issuer signs in, a wrong one does not, and the API answers JSON with no redirect
 *   (the browser never leaves PMC's own site);
 * - an old PMC bcrypt hash (and the old local password) never reaches the issuer;
 * plus the fresh-join rule, the 4 s limit, the break-glass for company admins, the per-person limit and role claims.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { startFakeIssuer, type FakeIssuer } from '../unit-support/fake-issuer';

const ENV = ['IDENTITY_OIDC', 'IDENTITY_ISSUER', 'IDENTITY_ISSUER_ENDPOINT', 'IDENTITY_CLIENT_ID', 'IDENTITY_REDIRECT_URI', 'IDENTITY_SERVICE_TOKEN', 'THROTTLE_DISABLED'] as const;

describe('Redbracket ID sign-in (live PostgreSQL, fake issuer)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let fake: FakeIssuer;
  const codes = new Map<string, string>();
  const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
  const made: string[] = [];

  beforeAll(async () => {
    for (const name of ENV) saved[name] = process.env[name];
    t = await createTestApp({ capturePasswordCode: (email, code) => codes.set(email, code) });
    f = await createTwoProjectFixture(t.prisma);
    fake = await startFakeIssuer({ redirectUri: 'http://127.0.0.1:1/cb' });
  });

  afterAll(async () => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    if (made.length) {
      await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: made } }, { actorUserId: { in: made } }] } });
      await t.prisma.passwordCredentialChallenge.deleteMany({ where: { userId: { in: made } } });
      await t.prisma.membership.deleteMany({ where: { userId: { in: made } } });
      await t.prisma.orgMembership.deleteMany({ where: { userId: { in: made } } });
      await t.prisma.user.deleteMany({ where: { id: { in: made } } });
    }
    await f?.cleanup();
    await fake?.close();
    await t?.close();
  });

  beforeEach(() => {
    process.env.THROTTLE_DISABLED = 'true';
    process.env.IDENTITY_OIDC = '1';
    process.env.IDENTITY_ISSUER = fake.issuer;
    process.env.IDENTITY_ISSUER_ENDPOINT = fake.url;
    process.env.IDENTITY_CLIENT_ID = fake.clientId;
    process.env.IDENTITY_REDIRECT_URI = 'http://127.0.0.1:1/cb';
    process.env.IDENTITY_SERVICE_TOKEN = fake.serviceToken;
    fake.requests.length = 0;
    fake.force = {};
    fake.delayMs = 0;
    fake.hold = false;
    fake.oversize = null;
    fake.createAnswersNoId = false;
    fake.spoil = 'none';
  });

  afterEach(() => vi.restoreAllMocks());

  const http = () => request(t.app.getHttpServer());
  const login = (email: string, password: string) => http().post('/auth/login').send({ email, password });
  const sub = (token: string) => (t.app.get(JwtService).verify(token) as { sub: string; role: string }).sub;
  const role = (token: string) => (t.app.get(JwtService).verify(token) as { sub: string; role: string }).role;

  async function setPassword(email: string, password: string, status: number) {
    const requested = await http().post('/auth/password/request').send({ email }).expect(201);
    const code = codes.get(email);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await http().post('/auth/password/verify').send({ requestId: requested.body.requestId, code }).expect(201);
    return http().post('/auth/password/complete').send({ setupToken: verified.body.setupToken, password }).expect(status);
  }

  /** An account of PMC's own, invited onto project A and never set up. */
  async function invitee(label: string, role = 'pmc') {
    const email = `rbid-${label}-${Date.now()}@test.local`;
    const user = await t.prisma.user.create({ data: { projectId: f.projectA.id, role, name: label, email } });
    made.push(user.id);
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: user.id, role, status: 'active' } });
    return user;
  }

  it('switch off (unset, "true", "1 ", "0"): today\'s bcrypt sign-in, and nothing asks the issuer or id.vitan.in', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const triesBefore = await t.prisma.signInAttempt.count();
    const user = await invitee('off');
    await t.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash('the local passphrase', 4) } });
    for (const value of [undefined, 'true', '1 ', '0']) {
      if (value === undefined) delete process.env.IDENTITY_OIDC;
      else process.env.IDENTITY_OIDC = value;
      const ok = await login(user.email!, 'the local passphrase').expect(201);
      expect(sub(ok.body.token)).toBe(user.id);
      await login(user.email!, 'not the passphrase').expect(401);
    }
    // and with the issuer left at its default (https://id.vitan.in)
    delete process.env.IDENTITY_OIDC;
    delete process.env.IDENTITY_ISSUER;
    delete process.env.IDENTITY_ISSUER_ENDPOINT;
    await login(user.email!, 'the local passphrase').expect(201);
    expect(fake.requests).toHaveLength(0);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url instanceof Request ? url.url : url).includes('id.vitan.in'))).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await t.prisma.signInAttempt.count()).toBe(triesBefore);
  });

  it('switch on: an invitation set up on PMC\'s screen makes the issuer person; that password signs in, a wrong one does not', async () => {
    const user = await invitee('invite');
    const done = await setPassword(user.email!, 'a long issuer passphrase', 201);
    expect(done.headers.location).toBeUndefined();
    expect(sub(done.body.token)).toBe(user.id);
    const person = [...fake.people.values()].find((p) => p.email === user.email);
    expect(person).toMatchObject({ password: 'a long issuer passphrase', verified: true });
    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id }, include: { platformPersonLink: true } });
    expect(row.passwordHash).toBeNull(); // no second master password at PMC
    expect(row.platformPersonLink).toMatchObject({ issuer: fake.issuer, subject: person!.userId, matchedOn: 'invite' });

    const ok = await login(user.email!, 'a long issuer passphrase').expect(201);
    expect(ok.headers.location).toBeUndefined();
    expect(ok.body).toEqual({ token: expect.any(String), role: 'pmc', projectId: f.projectA.id, name: 'invite' });
    expect(sub(ok.body.token)).toBe(user.id);
    // the browser never leaves PMC: the API alone ran the code flow, and never followed the issuer's redirect
    expect(fake.requests.map((r) => r.path.split('?')[0])).toEqual(expect.arrayContaining(['/oauth/v2/authorize', '/v2/sessions', '/oauth/v2/token']));
    expect(fake.requests.some((r) => r.path.startsWith('/cb'))).toBe(false);

    fake.requests.length = 0;
    const wrong = await login(user.email!, 'not the issuer passphrase').expect(401);
    expect(wrong.body.message).toBe('Invalid email or password');
    expect(fake.requests.some((r) => r.path === '/oauth/v2/token')).toBe(false);

    // a later request is PMC's own session: the issuer is not asked
    fake.requests.length = 0;
    await http().get('/me/memberships').set('Authorization', `Bearer ${ok.body.token}`).expect(200);
    expect(fake.requests).toHaveLength(0);
  });

  it('forgot password, switch on: resets the same issuer person, never writes a PMC password', async () => {
    const user = await invitee('reset');
    await setPassword(user.email!, 'the first issuer passphrase', 201);
    const before = [...fake.people.values()].filter((p) => p.email === user.email);
    await setPassword(user.email!, 'the second issuer passphrase', 201);
    const after = [...fake.people.values()].filter((p) => p.email === user.email);
    expect(after).toHaveLength(1);
    expect(after[0]!.userId).toBe(before[0]!.userId);
    await login(user.email!, 'the first issuer passphrase').expect(401);
    await login(user.email!, 'the second issuer passphrase').expect(201);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBeNull();
  });

  it('an old PMC account joins fresh: no hash or old password reaches the issuer, the old row is retired, roles are not copied', async () => {
    const old = await invitee('old');
    const hash = await bcrypt.hash('the old local passphrase', 4);
    await t.prisma.user.update({ where: { id: old.id }, data: { passwordHash: hash, emailVerifiedAt: new Date() } });
    const person = fake.addPerson(old.email!, 'my redbracket passphrase');

    // a session the old account opened with the switch off (today's sign-in) works until the account is retired
    process.env.IDENTITY_OIDC = '0';
    const before = await login(old.email!, 'the old local passphrase').expect(201);
    await http().get('/me/memberships').set('Authorization', `Bearer ${before.body.token}`).expect(200);
    process.env.IDENTITY_OIDC = '1';
    fake.requests.length = 0;

    // the old local password is not the issuer's
    await login(old.email!, 'the old local passphrase').expect(401);
    const first = await login(old.email!, 'my redbracket passphrase').expect(401);
    expect(first.body.message).toMatch(/not on any PMC project yet/);

    for (const r of fake.requests) {
      expect(r.body).not.toContain(hash);
      expect(r.body).not.toContain('$2a$');
      expect(r.body).not.toContain('$2b$');
    }
    expect(fake.requests.filter((r) => r.path === '/v2/sessions').map((r) => JSON.parse(r.body).checks.password.password))
      .toEqual(['the old local passphrase', 'my redbracket passphrase']);

    const retired = await t.prisma.user.findUniqueOrThrow({ where: { id: old.id }, include: { identityRetirement: true, memberships: true } });
    expect(retired.email).toBe(`${old.email}#retired-${old.id}`);
    expect(retired.identityRetirement).toMatchObject({ email: old.email });
    expect(retired.memberships).toHaveLength(1); // the old account's work and seats stay where they were
    // retiring moved its credential version on: the session it opened before is over
    await http().get('/me/memberships').set('Authorization', `Bearer ${before.body.token}`).expect(401);
    const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! }, include: { platformPersonLink: true, memberships: true } });
    made.push(fresh.id);
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.passwordHash).toBeNull();
    expect(fresh.memberships).toHaveLength(0);
    expect(fresh.platformPersonLink).toMatchObject({ subject: person.userId, matchedOn: 'signup' });
    // the new account is set up from its first moment: its owner cannot "correct" it as an unaccepted invitation
    expect(fresh.emailVerifiedAt).toBeInstanceOf(Date);
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: fresh.id, role: 'member' } });
    await http()
      .patch(`/orgs/${f.orgA.id}/members/${fresh.id}/invitation-email`)
      .set('Authorization', `Bearer ${t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id)}`)
      .send({ email: `taken-over-${Date.now()}@test.local` })
      .expect(400);

    // seated by PMC (here: as a client), the issuer's role-looking claims change nothing
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: fresh.id, role: 'client', status: 'active' } });
    const ok = await login(old.email!, 'my redbracket passphrase').expect(201);
    expect(sub(ok.body.token)).toBe(fresh.id);
    expect(role(ok.body.token)).toBe('client');
    expect(await t.prisma.user.count({ where: { email: { startsWith: old.email! } } })).toBe(2);
  });

  it('an issuer person whose email is not verified gets no account: nothing retired, nothing linked', async () => {
    const old = await invitee('unverified');
    await t.prisma.user.update({ where: { id: old.id }, data: { passwordHash: await bcrypt.hash('the old local passphrase', 4), emailVerifiedAt: new Date() } });
    const person = fake.addPerson(old.email!, 'an unverified redbracket passphrase', false);
    await login(old.email!, 'an unverified redbracket passphrase').expect(401);
    const still = await t.prisma.user.findUniqueOrThrow({ where: { id: old.id }, include: { identityRetirement: true, platformPersonLink: true } });
    expect([still.email, still.credentialVersion, still.identityRetirement, still.platformPersonLink]).toEqual([old.email, old.credentialVersion, null, null]);
    expect(await t.prisma.user.count({ where: { email: { startsWith: old.email! } } })).toBe(1);
    expect(await t.prisma.platformPersonLink.count({ where: { subject: person.userId } })).toBe(0);
  });

  it('an invitation is not accepted by a plain sign-in, and an issuer person who already has the email is not taken over', async () => {
    const user = await invitee('hubuser');
    const person = fake.addPerson(user.email!, 'my existing hub passphrase');
    const pending = await login(user.email!, 'my existing hub passphrase').expect(401);
    expect(pending.body.message).toMatch(/invitation is waiting/);

    const refused = await setPassword(user.email!, 'a different new passphrase', 400);
    expect(refused.body.message).toMatch(/already has a Redbracket ID/);
    expect(fake.people.get(person.userId)!.password).toBe('my existing hub passphrase');
    expect(fake.requests.some((r) => r.path.includes('/password') || r.path === '/v2/users/human')).toBe(false);

    const joined = await setPassword(user.email!, 'my existing hub passphrase', 201);
    expect(sub(joined.body.token)).toBe(user.id);
    expect(await t.prisma.platformPersonLink.findUnique({ where: { userId: user.id } })).toMatchObject({ subject: person.userId, matchedOn: 'invite' });
  });

  it('issuer unavailable (down, 5xx, past 4 s): "unavailable" for an ordinary person; a company owner may use the PMC password', async () => {
    const user = await invitee('down');
    await setPassword(user.email!, 'a long issuer passphrase', 201);
    const owner = await t.prisma.user.update({ where: { id: f.ownerUser.id }, data: { passwordHash: await bcrypt.hash('the owner local passphrase', 4) } });

    fake.force = { '/v2/sessions': 503 };
    const down = await login(user.email!, 'a long issuer passphrase').expect(503);
    expect(down.body.message).toBe('Sign-in is unavailable just now. Try again in a few minutes.');
    await login(owner.email!, 'the owner local passphrase').expect(201);
    await login(owner.email!, 'not the owner passphrase').expect(503);

    fake.force = {};
    // an issuer that never answers: PMC's own 4 s abort ends the wait (the fake holds until it closes; no stopwatch)
    fake.hold = true;
    await login(user.email!, 'a long issuer passphrase').expect(503);
    fake.hold = false;

    // switched on with its settings incomplete: unavailable too, never today's sign-in for an ordinary person
    delete process.env.IDENTITY_SERVICE_TOKEN;
    fake.requests.length = 0;
    await login(user.email!, 'a long issuer passphrase').expect(503);
    expect(fake.requests).toHaveLength(0);
  }, 20_000);

  it('a spoiled id token is not a sign-in', async () => {
    const user = await invitee('spoil');
    await setPassword(user.email!, 'a long issuer passphrase', 201);
    for (const spoil of ['issuer', 'alg-none', 'alg-hs256', 'state', 'nonce', 'audience', 'expired', 'signature'] as const) {
      fake.spoil = spoil;
      await t.prisma.signInAttempt.deleteMany(); // eight tries in a row would spend the per-person limit
      const r = await login(user.email!, 'a long issuer passphrase');
      // an answer PMC cannot trust after the password step is the issuer misbehaving: unavailable, never a sign-in
      expect(r.status).toBe(503);
      expect(r.body.token).toBeUndefined();
    }
  });

  it('a setup code is spent before the issuer is written to, and completing a reset is not counted against the limit', async () => {
    const user = await invitee('spent');
    // three full resets inside 15 minutes: each request is counted, its completion is not
    for (const n of [1, 2, 3]) await setPassword(user.email!, `issuer passphrase number ${n}`, 201);

    const requested = await http().post('/auth/password/request').send({ email: user.email }).expect(201);
    const verified = await http().post('/auth/password/verify').send({ requestId: requested.body.requestId, code: codes.get(user.email!) }).expect(201);
    fake.force = { '/v2/users/': 503 };
    await http().post('/auth/password/complete').send({ setupToken: verified.body.setupToken, password: 'the fourth passphrase' }).expect(503);
    fake.force = {};
    fake.requests.length = 0;
    // the code went with the first try: the same setup token drives nothing more at the issuer
    await http().post('/auth/password/complete').send({ setupToken: verified.body.setupToken, password: 'the fifth passphrase' }).expect(400);
    expect(fake.requests).toHaveLength(0);
    await login(user.email!, 'issuer passphrase number 3').expect(201);
  });

  it('the per-person limit: the sixth try in 15 minutes asks the issuer nothing', async () => {
    const user = await invitee('limit');
    for (let i = 0; i < 5; i += 1) await login(user.email!, `wrong passphrase ${i}`).expect(401);
    fake.requests.length = 0;
    const limited = await login(user.email!, 'wrong passphrase 6').expect(429);
    expect(limited.body.retryAfter).toBeGreaterThan(0);
    expect(fake.requests).toHaveLength(0);
    const rows = await t.prisma.signInAttempt.findMany({ take: 1 });
    expect(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(user.email!);
  });

  it('a test account address is never linked or retired', async () => {
    const qa = await t.prisma.user.create({ data: { projectId: f.projectA.id, role: 'pmc', name: 'qa', email: `qa.rbid${Date.now().toString(36).replace(/[0-9]/g, 'x')}@vitan.in`, passwordHash: 'x', emailVerifiedAt: new Date() } });
    made.push(qa.id);
    fake.addPerson(qa.email!, 'a qa passphrase');
    const r = await login(qa.email!, 'a qa passphrase').expect(401);
    expect(r.body.message).toMatch(/operator door/);
    expect(await t.prisma.user.findUniqueOrThrow({ where: { id: qa.id } })).toMatchObject({ email: qa.email });
  });
});
