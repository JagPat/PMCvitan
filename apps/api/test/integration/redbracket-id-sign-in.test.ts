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
import { Logger, UnauthorizedException } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia, wipeMembershipTransitionsVia, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { startFakeIssuer, type FakeIssuer } from '../unit-support/fake-issuer';
import { AuthService } from '../../src/auth/auth.service';
import { EmailService } from '../../src/platform/email.service';
import { IdentitySignInService } from '../../src/auth/identity/identity-sign-in.service';
import { PHONE_SIGN_IN_PURPOSE } from '../../src/auth/phone-sign-in.service';
import { PasswordCredentialsService } from '../../src/auth/password-credentials.service';
import { SignInAttempts } from '../../src/auth/identity/sign-in-attempts';
import { IdentityClient } from '../../src/auth/identity/identity-client';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
import { lockOrgStanding, orgStandingLockKey } from '../../src/common/readiness-lock';
import { Prisma } from '@prisma/client';

const ENV = ['IDENTITY_OIDC', 'IDENTITY_ISSUER', 'IDENTITY_ISSUER_ENDPOINT', 'IDENTITY_CLIENT_ID', 'IDENTITY_REDIRECT_URI', 'IDENTITY_SERVICE_TOKEN', 'THROTTLE_DISABLED', 'OPS_TOKEN'] as const;

describe('Redbracket ID sign-in (live PostgreSQL, fake issuer)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let fake: FakeIssuer;
  const codes = new Map<string, string>();
  /** each "your password was set/changed" email, as address and kind, in order */
  const changedMail: string[] = [];
  const mailOf = (email: string) => changedMail.filter((m) => m.startsWith(`${email} `));
  const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
  const made: string[] = [];

  beforeAll(async () => {
    for (const name of ENV) saved[name] = process.env[name];
    t = await createTestApp({ capturePasswordCode: (email, code) => codes.set(email, code), capturePasswordChanged: (email, kind) => changedMail.push(`${email} ${kind}`) });
    f = await createTwoProjectFixture(t.prisma);
    fake = await startFakeIssuer({ redirectUri: 'http://127.0.0.1:1/cb' });
  });

  afterAll(async () => {
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    if (made.length) {
      // the re-seat case's decision and recorded team acts (immutable evidence: the sanctioned test resets)
      const projectId = f.projectA.id;
      // the guards case approves a decision (immutable register rows) and opens a change request; as change-control
      await sanctionedReset(t.prisma, ['LabourDemandSlice', 'LabourRequirementSpec', 'MaterialRequirementSpec', 'DecisionApprovalRevision'], { cascade: true });
      await t.prisma.changeRequest.deleteMany({ where: { decision: { projectId } } });
      await wipeDecisionEvents(t.prisma, { decision: { projectId } });
      await wipeDecisionsVia(t.prisma, async (tx) => {
        await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
        await tx.decision.deleteMany({ where: { projectId } });
      });
      await wipeMembershipTransitionsVia(t.prisma, made);
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
    fake.afterPasswordSet = null;
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
    // the switch is on: the screen is told the password chosen next is the one Redbracket ID password
    expect(verified.body.sharedPassword).toBe(true);
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
    expect(wrong.body.code).toBeUndefined(); // A5: a wrong password names no code, so the web keeps its words
    expect(fake.requests.some((r) => r.path === '/oauth/v2/token')).toBe(false);

    // a later request is PMC's own session: the issuer is not asked
    fake.requests.length = 0;
    await http().get('/me/memberships').set('Authorization', `Bearer ${ok.body.token}`).expect(200);
    expect(fake.requests).toHaveLength(0);
  });

  it('a reset ends the PMC sessions before the issuer password changes, whatever fails after it', async () => {
    const me = (token: string) => http().get('/me/memberships').set('Authorization', `Bearer ${token}`);
    // a linked person: the issuer takes the new password, then is down for the sign-in that follows
    const user = await invitee('revoke');
    await setPassword(user.email!, 'the first issuer passphrase', 201);
    const before = (await login(user.email!, 'the first issuer passphrase').expect(201)).body.token as string;
    await me(before).expect(200);
    fake.force = { '/v2/sessions': 503 };
    await setPassword(user.email!, 'the second issuer passphrase', 503);
    expect([...fake.people.values()].find((p) => p.email === user.email)!.password).toBe('the second issuer passphrase');
    await me(before).expect(401);
    fake.force = {};

    // the issuer down for the password write itself (it may or may not have taken it): the old session is ended too
    const second = (await login(user.email!, 'the second issuer passphrase').expect(201)).body.token as string;
    fake.force = { '/v2/users/': 503 }; // the password write (`/v2/users/{id}/password`); the lookup is `/v2/users`
    await setPassword(user.email!, 'a passphrase never taken', 503);
    await me(second).expect(401);
    fake.force = {};
    // that unclear write keeps its claim for its lease (A4a): let the lease run out before the next setup
    await t.prisma.passwordCredentialChallenge.updateMany({
      where: { userId: user.id, setupTokenExpiresAt: null, setupTokenHash: { not: null } },
      data: { consumedAt: new Date(Date.now() - 3 * 60_000) },
    });

    // the per-person quota (shared by sign-in and reset requests) is spent by now; the steps below come a quarter hour on
    await t.prisma.signInAttempt.deleteMany({});

    // the PMC transaction after the issuer write failing, with a session the new password opened in between: both end
    const again = (await login(user.email!, 'the second issuer passphrase').expect(201)).body.token as string;
    const auth = t.app.get(AuthService);
    let between = '';
    vi.spyOn(IdentitySignInService.prototype as unknown as { settlePassword: () => Promise<never> }, 'settlePassword').mockImplementationOnce(async () => {
      between = (await auth.signInUser(await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } }))).token;
      throw new Error('the database went away');
    });
    await setPassword(user.email!, 'the third issuer passphrase', 500);
    expect(between).not.toBe('');
    await me(again).expect(401);
    await me(between).expect(401);

    // an account with no issuer person yet: a person is made, then the issuer is down
    const local = await invitee('revoke-local');
    await t.prisma.user.update({ where: { id: local.id }, data: { passwordHash: await bcrypt.hash('the local passphrase', 4), emailVerifiedAt: new Date() } });
    process.env.IDENTITY_OIDC = '0';
    const old = (await login(local.email!, 'the local passphrase').expect(201)).body.token as string;
    process.env.IDENTITY_OIDC = '1';
    await me(old).expect(200);
    fake.force = { '/v2/sessions': 503 };
    await setPassword(local.email!, 'a new issuer passphrase', 503);
    expect([...fake.people.values()].some((p) => p.email === local.email)).toBe(true);
    await me(old).expect(401);
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
    expect(first.body.code).toBe('no-project'); // A5: the web words it from this code

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
    const unverified = await login(old.email!, 'an unverified redbracket passphrase').expect(401);
    expect(unverified.body).toMatchObject({ statusCode: 401, message: 'Your email is not confirmed yet. Use "Set or reset password" to confirm it.', code: 'email-unverified' });
    const still = await t.prisma.user.findUniqueOrThrow({ where: { id: old.id }, include: { identityRetirement: true, platformPersonLink: true } });
    expect([still.email, still.credentialVersion, still.identityRetirement, still.platformPersonLink]).toEqual([old.email, old.credentialVersion, null, null]);
    expect(await t.prisma.user.count({ where: { email: { startsWith: old.email! } } })).toBe(1);
    expect(await t.prisma.platformPersonLink.count({ where: { subject: person.userId } })).toBe(0);
  });

  it('an invitation is not accepted by a plain sign-in, and the emailed code sets the Redbracket ID password of an issuer person who already has the email', async () => {
    const user = await invitee('hubuser');
    const person = fake.addPerson(user.email!, 'my existing hub passphrase');
    const pending = await login(user.email!, 'my existing hub passphrase').expect(401);
    expect(pending.body.message).toMatch(/invitation is waiting/);
    expect(pending.body.code).toBe('invite-pending');

    // Jagrut, 4 Nov 2026: the code proved the mailbox, so the typed password becomes the one Redbracket ID password
    const joined = await setPassword(user.email!, 'a different new passphrase', 201);
    expect(sub(joined.body.token)).toBe(user.id);
    expect(fake.people.get(person.userId)!.password).toBe('a different new passphrase');
    expect(fake.requests.some((r) => r.path === '/v2/users/human')).toBe(false); // the same person, never a second one
    expect(await t.prisma.platformPersonLink.findUnique({ where: { userId: user.id } })).toMatchObject({ subject: person.userId, matchedOn: 'invite' });
    expect(mailOf(user.email!)).toEqual([`${user.email} changed`]);
    // the trail says what happened: a reset of a password Hub and rb use too, not an enrolment
    const trail = await t.prisma.securityAuditEvent.findMany({ where: { targetUserId: user.id, action: { not: 'auth.password_requested' } }, select: { action: true } });
    expect(trail.map((e) => e.action)).toEqual(['auth.password_reset']);
    // the old issuer password no longer works anywhere; the new one does
    await login(user.email!, 'my existing hub passphrase').expect(401);
    await login(user.email!, 'a different new passphrase').expect(201);
  });

  it('forgot password: an established account whose issuer person exists resets that password and joins fresh, as a sign-in would', async () => {
    const old = await invitee('forgot');
    await t.prisma.user.update({ where: { id: old.id }, data: { passwordHash: await bcrypt.hash('the old local passphrase', 4), emailVerifiedAt: new Date() } });
    const person = fake.addPerson(old.email!, 'a forgotten redbracket passphrase', false);
    const rbSession = fake.openSession(person.userId); // someone signed in on rb with the old password

    // the new account holds no seat until the team re-seats the person (the RUNBOOK "Redbracket ID re-seat")
    const reset = await setPassword(old.email!, 'the remembered new passphrase', 401);
    expect(reset.body.code).toBe('no-project');
    const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! }, include: { platformPersonLink: true } });
    made.push(fresh.id);
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.platformPersonLink).toMatchObject({ subject: person.userId });
    // the issuer person now holds the new password, and the email the code proved is marked verified there
    expect(fake.people.get(person.userId)).toMatchObject({ password: 'the remembered new passphrase', verified: true });
    expect(await t.prisma.identityRetirement.count({ where: { userId: old.id } })).toBe(1);
    expect(mailOf(old.email!)).toEqual([`${old.email} changed`]);
    expect(await t.prisma.securityAuditEvent.findMany({ where: { targetUserId: fresh.id, action: 'auth.password_reset' } })).toHaveLength(1);
    // the person's issuer sessions end (not awaited by the setup): the rb sign-in with the old password is gone
    await vi.waitFor(() => expect(fake.sessionsOf(person.userId)).toEqual([]));
    expect(fake.sessionsOf(person.userId)).not.toContain(rbSession);
    // an unverified person with only a password was asked about other ways in before anything was written
    const asked = fake.requests.findIndex((r) => r.path === '/zitadel.user.v2.UserService/ListAuthenticationMethodTypes');
    const written = fake.requests.findIndex((r) => r.path.endsWith('/password'));
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(asked).toBeLessThan(written);
  });

  it('an unverified issuer person who holds another way in (a passkey) is left as it is: nothing written, no email', async () => {
    const user = await invitee('prehijack');
    const person = fake.addPerson(user.email!, 'a pre-registered passphrase', false);
    person.methods = ['AUTHENTICATION_METHOD_TYPE_PASSKEY'];
    const refused = await setPassword(user.email!, 'the owner new passphrase', 409);
    expect(refused.body.code).toBe('needs-help');
    expect(fake.people.get(person.userId)).toMatchObject({ password: 'a pre-registered passphrase', verified: false });
    expect(fake.requests.some((r) => r.path.endsWith('/password') || r.path.includes('UpdateUser'))).toBe(false);
    expect(mailOf(user.email!)).toEqual([]);
  });

  it('the notice goes once the issuer took the password, even when a later step fails', async () => {
    const user = await invitee('latefail');
    const person = fake.addPerson(user.email!, 'the old hub passphrase');
    fake.force = { '/v2/sessions': 503 }; // the sign-in that proves the new password cannot reach the issuer
    await setPassword(user.email!, 'the new hub passphrase', 503);
    expect(fake.people.get(person.userId)!.password).toBe('the new hub passphrase');
    expect(mailOf(user.email!)).toEqual([`${user.email} changed`]);
  });

  it('a failed notice (even one rejected with nothing) never fails the setup or escapes as an unhandled rejection', async () => {
    const user = await invitee('mailfail');
    fake.addPerson(user.email!, 'the old hub passphrase');
    const mail = t.app.get(EmailService);
    const spy = vi.spyOn(mail, 'sendPasswordChanged').mockImplementation(() => Promise.reject(undefined));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    await setPassword(user.email!, 'the new hub passphrase', 201);
    expect(spy).toHaveBeenCalledWith(user.email, 'changed');
    await vi.waitFor(() => expect(warn.mock.calls.some(([m]) => String(m).includes('password-changed email failed: undefined'))).toBe(true));
  });

  it('a sign-in that links the person to another account while the password is being set: that account is signed out, and this setup refused', async () => {
    const user = await invitee('race');
    const other = await invitee('racer');
    const person = fake.addPerson(user.email!, 'the old hub passphrase');
    const before = (await t.prisma.user.findUniqueOrThrow({ where: { id: other.id } })).credentialVersion;
    fake.afterPasswordSet = async () => {
      await t.prisma.platformPersonLink.create({ data: { userId: other.id, issuer: fake.issuer, subject: person.userId, matchedOn: 'invite' } });
    };
    const refused = await setPassword(user.email!, 'the racing new passphrase', 409);
    expect(refused.body.code).toBe('needs-help');
    // the password had already changed: the person is told, and the racing account's sessions end
    expect(mailOf(user.email!)).toEqual([`${user.email} changed`]);
    expect((await t.prisma.user.findUniqueOrThrow({ where: { id: other.id } })).credentialVersion).toBe(before + 1);
    expect(await t.prisma.platformPersonLink.findUnique({ where: { userId: user.id } })).toBeNull();
    // the trail keeps the refused-after-write case: on the account signed out, naming the person and where the code went
    const trail = await t.prisma.securityAuditEvent.findMany({ where: { targetUserId: other.id, action: 'auth.password_reset_refused_linked' } });
    expect(trail.map((e) => [e.actorUserId, e.payload])).toEqual([[user.id, { issuerPerson: person.userId, codeSentTo: user.id }]]);
    expect(JSON.stringify(trail)).not.toContain('passphrase');
  });

  it('a first try that fails leaves an unverified person exactly as they were, and the retry is still asked about other ways in', async () => {
    const user = await invitee('retrycheck');
    const person = fake.addPerson(user.email!, 'the pre-registered passphrase', false);
    fake.force = { [`/v2/users/${person.userId}/password`]: 400 }; // the issuer refuses the typed password (its policy)
    const first = await setPassword(user.email!, 'a refused new passphrase', 400);
    expect(first.body.code).toBe('password-rejected');
    expect(fake.people.get(person.userId)).toMatchObject({ verified: false, password: 'the pre-registered passphrase' });
    fake.force = {};
    person.methods = ['AUTHENTICATION_METHOD_TYPE_PASSKEY']; // the pre-registrant adds a passkey meanwhile
    const retry = await setPassword(user.email!, 'the owner second passphrase', 409);
    expect(retry.body.code).toBe('needs-help');
    expect(fake.people.get(person.userId)).toMatchObject({ verified: false, password: 'the pre-registered passphrase' });
    // a verified unlinked person with another way in is asked too, and left as it is
    person.verified = true;
    await setPassword(user.email!, 'the owner third passphrase', 409);
    expect(fake.people.get(person.userId)!.password).toBe('the pre-registered passphrase');
  });

  it('a sign-in that proved the OLD password before a reset and settles after it gets no session', async () => {
    for (const kind of ['established', 'invitee'] as const) {
      const a = await invitee(`oldpw${kind}`);
      if (kind === 'established') {
        await t.prisma.user.update({ where: { id: a.id }, data: { passwordHash: await bcrypt.hash('the old local passphrase', 4), emailVerifiedAt: new Date() } });
      }
      fake.addPerson(a.email!, 'the old shared passphrase');
      // the racer's login is held after its issuer proof, before PMC's settle
      let open!: () => void;
      let proved!: () => void;
      const gate = new Promise<void>((r) => (open = r));
      const reached = new Promise<void>((r) => (proved = r));
      const real = IdentityClient.prototype.login;
      vi.spyOn(IdentityClient.prototype, 'login').mockImplementation(async function (this: IdentityClient, email: string, pw: string) {
        const r = await real.call(this, email, pw);
        if (pw === 'the old shared passphrase') { proved(); await gate; }
        return r;
      });
      const racer = login(a.email!, 'the old shared passphrase');
      const racing = racer.then((r) => r);
      await reached;
      await setPassword(a.email!, 'the requester new passphrase', kind === 'established' ? 401 : 201);
      open();
      const r = await racing;
      // the settle reads the account and its credential version before the proof and refuses when either moved
      expect(r.status).toBe(401);
      expect(r.body.token).toBeUndefined();
      expect(['needs-help', 'password-changed']).toContain(r.body.code);
      const fresh = await t.prisma.user.findFirst({ where: { email: a.email! } });
      if (fresh && fresh.id !== a.id) made.push(fresh.id);
      vi.restoreAllMocks();
    }
  });

  it('an issuer person linked to another PMC account is left as it is: that account resets it', async () => {
    const user = await invitee('linkedelsewhere');
    const other = await invitee('holder');
    const person = fake.addPerson(user.email!, 'the holder redbracket passphrase');
    await t.prisma.platformPersonLink.create({ data: { userId: other.id, issuer: fake.issuer, subject: person.userId, matchedOn: 'invite' } });

    const refused = await setPassword(user.email!, 'a takeover passphrase', 409);
    expect(refused.body.code).toBe('needs-help');
    expect(fake.people.get(person.userId)!.password).toBe('the holder redbracket passphrase');
    expect(fake.requests.some((r) => r.path.includes('/password') || r.path === '/v2/users/human')).toBe(false);
    expect(mailOf(user.email!)).toEqual([]);
  });

  it('a retired account never signs in again: a phone code sent before or after, any door, all refused', async () => {
    const auth = t.app.get(AuthService, { strict: false });
    const old = await invitee('phone');
    const phone = `+9197${String(Date.now()).slice(-8)}`;
    await t.prisma.user.update({ where: { id: old.id }, data: { phone, passwordHash: await bcrypt.hash('the old local passphrase', 4), emailVerifiedAt: new Date() } });
    fake.addPerson(old.email!, 'my redbracket passphrase');
    const early = await auth.requestOtp({ phone, projectId: f.projectA.id });
    expect(early.devCode).toBeTruthy();

    await login(old.email!, 'my redbracket passphrase').expect(401); // joins fresh: the old row is retired
    const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! } });
    made.push(fresh.id);
    expect(fresh.id).not.toBe(old.id);
    expect(await t.prisma.user.findUniqueOrThrow({ where: { id: old.id }, select: { phone: true } })).toEqual({ phone }); // the number stays on the old row

    // the code sent before retirement, and one sent after, find the retired row by its number and are refused
    await expect(auth.verifyOtp({ phone, code: early.devCode!, projectId: f.projectA.id })).rejects.toThrow(/moved to Redbracket ID/);
    const late = await auth.requestOtp({ phone, projectId: f.projectA.id });
    await expect(auth.verifyOtp({ phone, code: late.devCode!, projectId: f.projectA.id })).rejects.toThrow(/moved to Redbracket ID/);
    // every door issues through the same access rule, which refuses the retired row whatever proved who it is
    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: old.id } });
    await expect(auth.signInUser(row)).rejects.toThrow(/moved to Redbracket ID/);
    // A5: the refusal names itself, so the web words it instead of reading a wrong password or a wrong code
    const refusal: unknown = await auth.signInUser(row).then(() => null, (e: unknown) => e);
    expect(refusal).toBeInstanceOf(UnauthorizedException);
    expect((refusal as UnauthorizedException).getResponse()).toEqual(expect.objectContaining({ code: 'retired' }));
  });

  it('break-glass after joining: a re-seated admin uses the PMC password of the account their first sign-in replaced', async () => {
    const old = await invitee('admin');
    await t.prisma.user.update({ where: { id: old.id }, data: { passwordHash: await bcrypt.hash('the admin local passphrase', 4), emailVerifiedAt: new Date() } });
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: old.id, role: 'admin' } });
    fake.addPerson(old.email!, 'the admin redbracket passphrase');
    await login(old.email!, 'the admin redbracket passphrase').expect(401); // joins fresh, holding nothing yet
    const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! } });
    made.push(fresh.id);
    expect(fresh.passwordHash).toBeNull();

    fake.force = { '/v2/sessions': 503 };
    // not yet re-seated: the new account administers nothing, so no break-glass
    await login(old.email!, 'the admin local passphrase').expect(503);
    // re-seated as the company's admin (A4's operator step): the old PMC password opens the NEW account
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: fresh.id, role: 'admin' } });
    const glass = await login(old.email!, 'the admin local passphrase').expect(201);
    expect(sub(glass.body.token)).toBe(fresh.id);
    await login(old.email!, 'not the admin passphrase').expect(503);
    // an ordinary joined person has no break-glass, whatever their old account held
    const plain = await invitee('plain');
    await t.prisma.user.update({ where: { id: plain.id }, data: { passwordHash: await bcrypt.hash('the plain local passphrase', 4), emailVerifiedAt: new Date() } });
    fake.addPerson(plain.email!, 'the plain redbracket passphrase');
    fake.force = {};
    await login(plain.email!, 'the plain redbracket passphrase').expect(401);
    made.push((await t.prisma.user.findUniqueOrThrow({ where: { email: plain.email! } })).id);
    fake.force = { '/v2/sessions': 503 };
    await login(plain.email!, 'the plain local passphrase').expect(503);
  });

  it('break-glass asks the admin standing again under the company lock: a demotion before or during issuance is refused', async () => {
    const identity = t.app.get(IdentitySignInService);
    const auth = t.app.get(AuthService);
    /** an old admin who joined fresh and was re-seated as the company admin; returns the new account */
    const reseated = async (label: string) => {
      const old = await invitee(label);
      await t.prisma.user.update({ where: { id: old.id }, data: { passwordHash: await bcrypt.hash(`the ${label} local passphrase`, 4), emailVerifiedAt: new Date() } });
      fake.addPerson(old.email!, `the ${label} redbracket passphrase`);
      fake.force = {};
      await login(old.email!, `the ${label} redbracket passphrase`).expect(401);
      const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! } });
      made.push(fresh.id);
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: fresh.id, role: 'admin' } });
      fake.force = { '/v2/sessions': 503 };
      return fresh;
    };

    // demoted after the password check, before the session: refused, no token
    const before = await reseated('demoted');
    const outcome = await identity.login({ email: before.email!, password: 'the demoted local passphrase' }, '127.0.0.1');
    expect(outcome).toMatchObject({ breakGlass: { settle: expect.any(Function) }, account: { id: before.id } });
    await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgA.id, userId: before.id } });
    const lines = vi.spyOn(IdentitySignInService.prototype as unknown as { line: (r: string, a: string, o: string) => void }, 'line');
    await expect(auth.signInIdentity(outcome)).rejects.toMatchObject({ status: 503 });
    // the try's one line says it was refused, never "accepted"
    expect(lines.mock.calls.map((c) => c[2])).toEqual(['issuer unavailable; break-glass refused: no longer a company owner or admin']);

    // demoted by a writer holding the company key while the session waits on it: the session sees the demotion
    const during = await reseated('during');
    const held = await identity.login({ email: during.email!, password: 'the during local passphrase' }, '127.0.0.1');
    expect(held.breakGlass).toBeDefined();
    let release!: () => void;
    const go = new Promise<void>((r) => { release = r; });
    let holding!: () => void;
    const isHolding = new Promise<void>((r) => { holding = r; });
    const writer = t.prisma.$transaction(async (tx) => {
      await lockOrgStanding(tx, f.orgA.id);
      await tx.orgMembership.deleteMany({ where: { orgId: f.orgA.id, userId: during.id } });
      holding();
      await go;
    }, { timeout: 20_000 });
    await isHolding;
    const signing = auth.signInIdentity(held).then(() => 'signed', (err: { status?: number }) => err.status);
    const waiting = async () => (await t.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n;
    const deadline = Date.now() + 10_000;
    while ((await waiting()) < 1) {
      if (Date.now() > deadline) { release(); await writer; await signing; throw new Error('the session never waited on the company key'); }
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    await writer;
    expect(await signing).toBe(503);

    // still an admin: the same path signs in
    const kept = await reseated('kept');
    const keptOutcome = await identity.login({ email: kept.email!, password: 'the kept local passphrase' }, '127.0.0.1');
    lines.mockClear();
    // everything the session reads, the retirement check included, runs on the transaction's own connection: the root
    // client would need a second one, which a full pool never gives back while the transaction waits on it
    const rootReads = vi.spyOn(t.prisma.identityRetirement, 'count');
    const ok = await auth.signInIdentity(keptOutcome);
    expect(rootReads).not.toHaveBeenCalled();
    rootReads.mockRestore();
    expect(sub(ok.token)).toBe(kept.id);
    expect(lines.mock.calls.map((c) => c[2])).toEqual(['issuer unavailable; break-glass password accepted']);

    // the transaction closed by the server (its time ran out while the process was busy): unavailable, never a 500
    const late = await identity.login({ email: kept.email!, password: 'the kept local passphrase' }, '127.0.0.1');
    lines.mockClear();
    vi.spyOn(t.prisma, '$transaction').mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Transaction already closed: timeout', { code: 'P2028', clientVersion: 'test' }));
    await expect(auth.signInIdentity(late)).rejects.toMatchObject({ status: 503 });
    expect(lines.mock.calls.map((c) => c[2])).toEqual(['issuer unavailable; break-glass refused: transaction timed out']);
  }, 30_000);

  it('break-glass takes the company keys in ascending order: holding the lower one while it waits for the higher', async () => {
    const identity = t.app.get(IdentitySignInService);
    const auth = t.app.get(AuthService);
    const stamp = Date.now();
    // made in descending id order, so neither insertion order nor chance gives ascending
    const high = await t.prisma.org.create({ data: { id: `zz-rbid-${stamp}`, name: 'High', slug: `zz-rbid-${stamp}` } });
    const low = await t.prisma.org.create({ data: { id: `aa-rbid-${stamp}`, name: 'Low', slug: `aa-rbid-${stamp}` } });
    try {
      const old = await invitee('twokeys');
      await t.prisma.user.update({ where: { id: old.id }, data: { passwordHash: await bcrypt.hash('the twokeys local passphrase', 4), emailVerifiedAt: new Date() } });
      fake.addPerson(old.email!, 'the twokeys redbracket passphrase');
      await login(old.email!, 'the twokeys redbracket passphrase').expect(401);
      const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! } });
      made.push(fresh.id);
      await t.prisma.orgMembership.create({ data: { orgId: high.id, userId: fresh.id, role: 'admin' } });
      await t.prisma.orgMembership.create({ data: { orgId: low.id, userId: fresh.id, role: 'owner' } });
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: fresh.id, role: 'admin' } }); // where its projects are
      expect(await new OrgsParticipant().administeredCompanyIds(t.prisma, fresh.id)).toEqual([low.id, f.orgA.id, high.id].sort());
      expect([low.id, f.orgA.id, high.id].sort()).toEqual([low.id, f.orgA.id, high.id]);
      fake.force = { '/v2/sessions': 503 };
      const outcome = await identity.login({ email: fresh.email!, password: 'the twokeys local passphrase' }, '127.0.0.1');

      let release!: () => void;
      const go = new Promise<void>((r) => { release = r; });
      let holding!: () => void;
      const isHolding = new Promise<void>((r) => { holding = r; });
      const writer = t.prisma.$transaction(async (tx) => {
        await lockOrgStanding(tx, high.id);
        holding();
        await go;
      }, { timeout: 20_000 });
      await isHolding;
      const signing = auth.signInIdentity(outcome).then((r) => r, (err: unknown) => err);
      const waiting = async () => (await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n;
      const deadline = Date.now() + 10_000;
      while ((await waiting()) < 1) {
        if (Date.now() > deadline) { release(); await writer; await signing; throw new Error('the session never waited on the higher key'); }
        await new Promise((r) => setTimeout(r, 20));
      }
      // waiting for the higher key, the session already holds the lower one
      const lowFree = await t.prisma.$transaction(async (tx) =>
        (await tx.$queryRaw<Array<{ got: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${orgStandingLockKey(low.id)}, 0)) AS got`)[0]!.got);
      release();
      await writer;
      const result = await signing;
      expect(lowFree).toBe(false);
      expect(sub((result as { token: string }).token)).toBe(fresh.id);
    } finally {
      await t.prisma.orgMembership.deleteMany({ where: { orgId: { in: [high.id, low.id] } } });
      await t.prisma.org.deleteMany({ where: { id: { in: [high.id, low.id] } } });
    }
  }, 30_000);

  it('a linked person whose email the issuer will not mark verified is not told the setup worked', async () => {
    const user = await invitee('unmarked');
    await setPassword(user.email!, 'the first issuer passphrase', 201);
    const person = [...fake.people.values()].find((p) => p.email === user.email)!;
    person.verified = false;
    const done = ['auth.password_reset', 'auth.password_enrolled'];
    const successes = () => t.prisma.securityAuditEvent.count({ where: { targetUserId: user.id, action: { in: done } } });
    const before = await successes();
    fake.force = { '/zitadel.user.v2.UserService/UpdateUser': 400 };
    const refused = await setPassword(user.email!, 'the second issuer passphrase', 409);
    expect(refused.body.token).toBeUndefined();
    expect(refused.body.message).toBe('This email cannot be set up here. Ask your PMC for help.');
    expect(refused.body.code).toBe('needs-help'); // A5: its own code, never the setup-running one
    expect(person.verified).toBe(false);
    expect(person.password).toBe('the first issuer passphrase'); // refused before the password was written
    expect(await successes()).toBe(before); // no success recorded
    // the issuer down for the same step is "unavailable", never success
    fake.force = { '/zitadel.user.v2.UserService/UpdateUser': 503 };
    await setPassword(user.email!, 'the third issuer passphrase', 503);
    expect(person.password).toBe('the first issuer passphrase');
    fake.force = {};
    await setPassword(user.email!, 'the fourth issuer passphrase', 201);
    expect(person.verified).toBe(true);
  });

  it('a reset code sent before retirement is refused after it, switch on or off: nothing reaches the issuer, the old hash stays', async () => {
    const old = await invitee('resetrace');
    const hash = await bcrypt.hash('the old local passphrase', 4);
    await t.prisma.user.update({ where: { id: old.id }, data: { passwordHash: hash, emailVerifiedAt: new Date() } });
    fake.addPerson(old.email!, 'my redbracket passphrase');
    const codeFor = async () => {
      const requested = await http().post('/auth/password/request').send({ email: old.email }).expect(201);
      const verified = await http().post('/auth/password/verify').send({ requestId: requested.body.requestId, code: codes.get(old.email!) }).expect(201);
      return verified.body.setupToken as string;
    };
    const onToken = await codeFor();
    const offToken = await codeFor();
    await login(old.email!, 'my redbracket passphrase').expect(401); // joins fresh: the old row is retired
    made.push((await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! } })).id);

    fake.requests.length = 0;
    await http().post('/auth/password/complete').send({ setupToken: onToken, password: 'a brand new passphrase' }).expect(400);
    expect(fake.requests).toHaveLength(0);
    process.env.IDENTITY_OIDC = '0';
    await http().post('/auth/password/complete').send({ setupToken: offToken, password: 'another new passphrase' }).expect(400);
    process.env.IDENTITY_OIDC = '1';
    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: old.id }, select: { passwordHash: true } });
    expect(row.passwordHash).toBe(hash); // break-glass reads this hash: it never changes after retirement
  });

  it('a project switch signs with the caller\'s own token version, and never for a retired account', async () => {
    const auth = t.app.get(AuthService, { strict: false });
    const live = await invitee('switch-live');
    await t.prisma.user.update({ where: { id: live.id }, data: { passwordHash: await bcrypt.hash('the local passphrase', 4), emailVerifiedAt: new Date() } });
    // the version moved on during the request (a reset or a retirement committing): the new token is dead too
    const before = (await t.prisma.user.findUniqueOrThrow({ where: { id: live.id } })).credentialVersion;
    await t.prisma.user.update({ where: { id: live.id }, data: { credentialVersion: { increment: 1 } } });
    const stale = await auth.switchProject(live.id, f.projectA.id, before);
    await http().get('/me/memberships').set('Authorization', `Bearer ${stale.token}`).expect(401);

    const old = await invitee('switch-old');
    await t.prisma.user.update({ where: { id: old.id }, data: { passwordHash: await bcrypt.hash('the old local passphrase', 4), emailVerifiedAt: new Date() } });
    fake.addPerson(old.email!, 'my redbracket passphrase');
    const version = (await t.prisma.user.findUniqueOrThrow({ where: { id: old.id } })).credentialVersion;
    await login(old.email!, 'my redbracket passphrase').expect(401);
    made.push((await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! } })).id);
    await expect(auth.switchProject(old.id, f.projectA.id, version)).rejects.toThrow(/moved to Redbracket ID/);
    await expect(auth.switchProject(old.id, f.projectA.id, version + 1)).rejects.toThrow(/moved to Redbracket ID/);
  });

  it('break-glass reads only the retirement made with the account (same moment, linked at sign-up), never an older one', async () => {
    const { breakGlassHash } = await import('../../src/auth/identity/identity-accounts');
    const u1 = await invitee('chain');
    const email = u1.email!;
    const h1 = await bcrypt.hash('u1 local passphrase', 4);
    await t.prisma.user.update({ where: { id: u1.id }, data: { passwordHash: h1, emailVerifiedAt: new Date() } });
    const p1 = fake.addPerson(email, 'first redbracket passphrase');
    await login(email, 'first redbracket passphrase').expect(401);
    const u2 = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    made.push(u2.id);
    expect(await breakGlassHash(t.prisma, u2)).toBe(h1);
    // an operator frees the address (SQL only: no app path rewrites a verified account's email), and a later account
    // takes it: an invitation linked to another issuer person, then an established account that joins fresh
    await t.prisma.user.update({ where: { id: u2.id }, data: { email: `moved-${u2.id}@test.local` } });
    fake.people.delete(p1.userId);
    const u3 = await invitee('chain-later');
    await t.prisma.user.update({ where: { id: u3.id }, data: { email } });
    await t.prisma.platformPersonLink.create({ data: { userId: u3.id, issuer: fake.issuer, subject: `other-${Date.now()}`, matchedOn: 'invite' } });
    expect(await breakGlassHash(t.prisma, await t.prisma.user.findUniqueOrThrow({ where: { id: u3.id } }))).toBeNull();
    await t.prisma.user.update({ where: { id: u3.id }, data: { email: `moved-${u3.id}@test.local` } });
    const u4 = await invitee('chain-joiner');
    const h4 = await bcrypt.hash('u4 local passphrase', 4);
    await t.prisma.user.update({ where: { id: u4.id }, data: { email, passwordHash: h4, emailVerifiedAt: new Date() } });
    fake.addPerson(email, 'second redbracket passphrase');
    await login(email, 'second redbracket passphrase').expect(401);
    const u5 = await t.prisma.user.findUniqueOrThrow({ where: { email } });
    made.push(u5.id);
    expect(await breakGlassHash(t.prisma, u5)).toBe(h4); // its own predecessor, never U1
    // and an account linked by its invitation never reads a retirement, even one stamped with its own moment
    const u6 = await invitee('chain-invite');
    const at = (await t.prisma.user.findUniqueOrThrow({ where: { id: u6.id } })).createdAt;
    await t.prisma.platformPersonLink.create({ data: { userId: u6.id, issuer: fake.issuer, subject: `invite-${Date.now()}`, matchedOn: 'invite' } });
    const u7 = await invitee('chain-stamped');
    await t.prisma.user.update({ where: { id: u7.id }, data: { passwordHash: h1, email: `stamped-${u7.id}@test.local` } });
    await t.prisma.identityRetirement.create({ data: { userId: u7.id, email: u6.email!, retiredAt: at } });
    expect(await breakGlassHash(t.prisma, await t.prisma.user.findUniqueOrThrow({ where: { id: u6.id } }))).toBeNull();
  });

  it('a reset that joins an established account fresh is recorded on the new account; the old one records its retirement', async () => {
    const old = await invitee('trail');
    await t.prisma.user.update({ where: { id: old.id }, data: { passwordHash: await bcrypt.hash('the old local passphrase', 4), emailVerifiedAt: new Date() } });
    const lines = vi.spyOn(IdentitySignInService.prototype as unknown as { line: (r: string, a: string, o: string) => void }, 'line');
    const done = await setPassword(old.email!, 'a new redbracket passphrase', 401); // set at the issuer; the new account holds no project
    expect(done.body.message).toMatch(/not on any PMC project yet/);
    expect(done.body.code).toBe('no-project');
    // one try, one line: the fresh join is reported by the setup alone, never also as a sign-in
    expect(lines.mock.calls.map((c) => [c[0], c[2]])).toEqual([['password', 'set, new account']]);
    const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! } });
    made.push(fresh.id);
    expect(fresh.id).not.toBe(old.id);
    const onFresh = await t.prisma.securityAuditEvent.findMany({ where: { targetUserId: fresh.id }, select: { action: true, actorUserId: true, payload: true, correlationId: true } });
    expect(onFresh).toEqual([{ action: 'auth.password_enrolled', actorUserId: fresh.id, payload: { codeSentTo: old.id }, correlationId: expect.any(String) }]);
    const onOld = await t.prisma.securityAuditEvent.findMany({ where: { targetUserId: old.id }, select: { action: true, actorUserId: true, correlationId: true } });
    expect(onOld.map((e) => e.action).sort()).toEqual(['auth.identity_retired', 'auth.password_requested']);
    const retiredEvent = onOld.find((e) => e.action === 'auth.identity_retired')!;
    expect(retiredEvent.actorUserId).toBe(fresh.id);
    expect(retiredEvent.correlationId).toBe(onFresh[0]!.correlationId); // both name the reset code that did it
  });

  it('a setup that claimed its code holds the address: the invitation email can no longer be corrected, even after the setup failed', async () => {
    const user = await invitee('claimed');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: user.id, role: 'member' } });
    const correct = (email: string) =>
      http()
        .patch(`/orgs/${f.orgA.id}/members/${user.id}/invitation-email`)
        .set('Authorization', `Bearer ${t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id)}`)
        .send({ email });
    // a code asked for and never used is revoked by a correction, which stays open
    await http().post('/auth/password/request').send({ email: user.email }).expect(201);
    await correct(`rbid-claimed-typo-${Date.now()}@test.local`).expect(200);
    // a redeemed phone code (spent and verified, with no expiry of its own) proves nothing about the address
    await t.prisma.passwordCredentialChallenge.create({
      data: { userId: user.id, purpose: PHONE_SIGN_IN_PURPOSE, otpHash: 'redeemed', expiresAt: new Date(Date.now() + 600_000), verifiedAt: new Date(), consumedAt: new Date() },
    });
    // and a code that was only revoked (spent by that correction) never holds the address
    const first = `rbid-claimed-first-${Date.now()}@test.local`;
    await correct(first).expect(200);
    // the code is claimed, then the issuer goes down before the person is made: the setup fails, the claim stands
    fake.force = { '/v2/users': 503 };
    await setPassword(first, 'a passphrase never set', 503);
    const claimed = await t.prisma.passwordCredentialChallenge.findMany({ where: { userId: user.id, purpose: 'password_setup_or_reset', verifiedAt: { not: null }, setupTokenExpiresAt: null } });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ verifiedAt: expect.any(Date), consumedAt: expect.any(Date) });
    const refused = await correct(`rbid-claimed-second-${Date.now()}@test.local`).expect(400);
    expect(refused.body.message).toMatch(/already confirmed by a password setup/);
    const row = await t.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.email).toBe(first);
    expect(await t.prisma.securityAuditEvent.count({ where: { targetUserId: user.id, action: 'auth.invitation_email_changed' } })).toBe(2); // the two corrections before the claim, none after
    // and the setup itself is not blocked: with the issuer back, a new code finishes it on the same address
    fake.force = {};
    await setPassword(first, 'a long issuer passphrase', 201);
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

  it('sign-in and reset requests share one quota, and a refusal names the real wait of the window that refused it', async () => {
    const attempts = new SignInAttempts(t.prisma);
    const t0 = new Date('2026-11-02T10:00:00.000Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);
    // one address: three reset requests and two sign-ins are the five a pair may make; the sixth try is refused
    const pairEmail = `rbid-quota-pair-${Date.now()}@test.local`;
    for (const [i, kind] of (['reset', 'sign-in', 'reset', 'sign-in', 'reset'] as const).entries()) {
      expect((await attempts.count(kind, pairEmail, '10.0.0.1', at(i * 1000))).allowed).toBe(true);
    }
    const pair = await attempts.count('sign-in', pairEmail, '10.0.0.1', at(5000));
    expect(pair.allowed).toBe(false);
    // the fifth newest counted try (at +1 s) leaves the 15-minute window at +901 s
    expect(pair.retryAfterSeconds).toBe(900 - 4);
    // ten tries from ten addresses fill the email's hour; the eleventh, from a fresh address, waits most of an hour
    const emailOnly = `rbid-quota-email-${Date.now()}@test.local`;
    for (let i = 0; i < 10; i += 1) {
      expect((await attempts.count(i % 2 ? 'reset' : 'sign-in', emailOnly, `10.0.1.${i}`, at(i * 1000))).allowed).toBe(true);
    }
    const hour = await attempts.count('reset', emailOnly, '10.0.2.1', at(20_000));
    expect(hour.allowed).toBe(false);
    // the tenth newest counted try (at +1 s) leaves the hour at +3601 s
    expect(hour.retryAfterSeconds).toBe(3600 - 19);
    await t.prisma.signInAttempt.deleteMany({ where: { at: { gte: t0, lt: at(60_000) } } });
  });

  it('a reset request turned away by the limit answers as a sent one and logs one line', async () => {
    const user = await invitee('reset-limit');
    for (let i = 0; i < 5; i += 1) await http().post('/auth/password/request').send({ email: user.email }).expect(201);
    const lines = vi.spyOn(IdentitySignInService.prototype as unknown as { line: (r: string, a: string, o: string) => void }, 'line');
    const notSent = vi.spyOn(PasswordCredentialsService.prototype as unknown as { notSent: (id: string) => unknown }, 'notSent');
    const limited = await http().post('/auth/password/request').send({ email: user.email }).expect(201);
    expect(limited.body).toEqual({ accepted: true, requestId: expect.any(String) });
    expect(lines.mock.calls.map((c) => [c[0], c[2]])).toEqual([['password request', 'limited']]);
    expect(notSent).not.toHaveBeenCalled();
  });

  it('a password proof the issuer gave before a reset committed opens no session; the new password signs in', async () => {
    const user = await invitee('proof-race');
    await setPassword(user.email!, 'the old issuer passphrase', 201);
    await t.prisma.signInAttempt.deleteMany({});
    const original = IdentityClient.prototype.login;
    // the issuer accepts the old password; before PMC settles that sign-in, a whole reset runs and finishes
    vi.spyOn(IdentityClient.prototype, 'login').mockImplementationOnce(async function (this: IdentityClient, ...args: Parameters<IdentityClient['login']>) {
      const proof = await original.apply(this, args);
      await setPassword(user.email!, 'the new issuer passphrase', 201);
      return proof;
    });
    const lines = vi.spyOn(IdentitySignInService.prototype as unknown as { line: (r: string, a: string, o: string) => void }, 'line');
    const raced = await login(user.email!, 'the old issuer passphrase').expect(401);
    expect(raced.body.message).toBe('Your password was just changed. Sign in with the new one.');
    expect(raced.body.code).toBe('password-changed');
    expect(raced.body.token).toBeUndefined();
    expect(lines.mock.calls.filter((c) => c[0] === 'login').map((c) => c[2])).toEqual(['password changed during sign-in']);
    await login(user.email!, 'the old issuer passphrase').expect(401);
    const ok = await login(user.email!, 'the new issuer passphrase').expect(201);
    expect(sub(ok.body.token)).toBe(user.id);
  });

  it('a linked account whose PMC email no longer names it is not signed in by the issuer email', async () => {
    const user = await invitee('moved-email');
    await setPassword(user.email!, 'a long issuer passphrase', 201);
    const issuerEmail = user.email!;
    await t.prisma.user.update({ where: { id: user.id }, data: { email: `moved-${Date.now()}@test.local` } });
    const r = await login(issuerEmail, 'a long issuer passphrase').expect(401);
    expect(r.body.message).toBe('This email cannot be set up here. Ask your PMC for help.');
    expect(r.body.code).toBe('needs-help');
  });

  it('the issuer email naming another PMC account than the linked one opens no session', async () => {
    const linked = await invitee('linked-elsewhere');
    await setPassword(linked.email!, 'a long issuer passphrase', 201);
    const issuerEmail = linked.email!;
    await t.prisma.user.update({ where: { id: linked.id }, data: { email: `elsewhere-${Date.now()}@test.local` } });
    const other = await t.prisma.user.create({ data: { projectId: f.projectA.id, role: 'pmc', name: 'other', email: issuerEmail, emailVerifiedAt: new Date() } });
    made.push(other.id);
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: other.id, role: 'pmc', status: 'active' } });
    const lines = vi.spyOn(IdentitySignInService.prototype as unknown as { line: (r: string, a: string, o: string) => void }, 'line');
    const r = await login(issuerEmail, 'a long issuer passphrase').expect(401);
    expect(r.body).toMatchObject({ message: 'This email cannot be set up here. Ask your PMC for help.', code: 'needs-help' });
    expect(r.body.token).toBeUndefined();
    expect(lines.mock.calls.map((c) => c[2])).toEqual(['email names another account']);
  });

  it('a sign-in whose settle transaction the server closed (its time ran out on the account lock) is unavailable, never a 500', async () => {
    const user = await invitee('lock-held');
    await setPassword(user.email!, 'a long issuer passphrase', 201);
    const lines = vi.spyOn(IdentitySignInService.prototype as unknown as { line: (r: string, a: string, o: string) => void }, 'line');
    // the settle is the sign-in's only transaction: closed by the server as a lock held past its time closes it
    const tx = vi.spyOn(t.prisma, '$transaction').mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('Transaction already closed: timeout', { code: 'P2028', clientVersion: 'test' }));
    const r = await login(user.email!, 'a long issuer passphrase').expect(503);
    expect(tx).toHaveBeenCalledTimes(1);
    expect(r.body.message).toBe('Sign-in is unavailable just now. Try again in a few minutes.');
    expect(lines.mock.calls.map((c) => c[2])).toEqual(['transaction timed out']);
    // any other failure stays what it is
    vi.spyOn(t.prisma, '$transaction').mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' }));
    await login(user.email!, 'a long issuer passphrase').expect(500);
  });

  it('a completion that waited before its claim still holds the account for a whole lease from the claim (Codex 4450806612)', async () => {
    const user = await invitee('late-claim');
    await setPassword(user.email!, 'the first issuer passphrase', 201);
    await t.prisma.signInAttempt.deleteMany({});
    const codeFor = async () => {
      const requested = await http().post('/auth/password/request').send({ email: user.email }).expect(201);
      const verified = await http().post('/auth/password/verify').send({ requestId: requested.body.requestId, code: codes.get(user.email!) }).expect(201);
      return verified.body.setupToken as string;
    };
    const older = await codeFor();
    const original = IdentityClient.prototype.find;
    let reached!: () => void;
    const atIssuer = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const go = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(IdentityClient.prototype, 'find').mockImplementationOnce(async function (this: IdentityClient, ...args: Parameters<IdentityClient['find']>) {
      reached();
      await go;
      return original.apply(this, args);
    });
    // the older completion's own clock reads 3 min back (as if it had waited that long before its claim, longer than the
    // lease): the lease must still start at the claim itself, so the account is held from then
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() - 3 * 60_000 });
    let first: Promise<{ status: number }>;
    try {
      first = http().post('/auth/password/complete').send({ setupToken: older, password: 'the older passphrase A' }).then((r) => r);
      await atIssuer;
    } finally {
      vi.useRealTimers();
    }
    const claim = await t.prisma.passwordCredentialChallenge.findFirstOrThrow({ where: { userId: user.id, setupTokenExpiresAt: null, setupTokenHash: { not: null } }, orderBy: { consumedAt: 'desc' } });
    expect(Date.now() - claim.consumedAt!.getTime()).toBeLessThan(60_000); // stamped when the claim was taken
    const newer = await codeFor();
    const second = await http().post('/auth/password/complete').send({ setupToken: newer, password: 'the newer passphrase B' }).expect(409);
    expect(second.body.code).toBe('setup-running');
    release();
    expect((await first!).status).toBe(201);
    expect([...fake.people.values()].find((p) => p.email === user.email)?.password).toBe('the older passphrase A');
    await t.prisma.signInAttempt.deleteMany({});
  });

  it('one password setup at a time per account: a second, claimed while the first is at the issuer, is refused and changes nothing', async () => {
    const user = await invitee('one-at-a-time');
    await setPassword(user.email!, 'the first issuer passphrase', 201);
    await t.prisma.signInAttempt.deleteMany({});
    const codeFor = async () => {
      const requested = await http().post('/auth/password/request').send({ email: user.email }).expect(201);
      const verified = await http().post('/auth/password/verify').send({ requestId: requested.body.requestId, code: codes.get(user.email!) }).expect(201);
      return verified.body.setupToken as string;
    };
    const older = await codeFor();
    // the older completion is held at its first issuer step (its code is already claimed) until the newer one has run
    const original = IdentityClient.prototype.find;
    let reached!: () => void;
    const atIssuer = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const go = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(IdentityClient.prototype, 'find').mockImplementationOnce(async function (this: IdentityClient, ...args: Parameters<IdentityClient['find']>) {
      reached();
      await go;
      return original.apply(this, args);
    });
    const first = http().post('/auth/password/complete').send({ setupToken: older, password: 'the older passphrase A' }).then((r) => r);
    await atIssuer;
    // a new code asked for meanwhile (a claimed code is not revoked by the request)
    const newer = await codeFor();
    const second = await http().post('/auth/password/complete').send({ setupToken: newer, password: 'the newer passphrase B' }).expect(409);
    expect(second.body.message).toBe('Another password setup for this account is still finishing. Try again in a minute.');
    expect(second.body.code).toBe('setup-running'); // the web matches this code, not the words
    release();
    expect((await first).status).toBe(201);
    // the issuer holds A, the only password a setup reported set
    const person = [...fake.people.values()].find((p) => p.email === user.email);
    expect(person?.password).toBe('the older passphrase A');
    await login(user.email!, 'the older passphrase A').expect(201);
    // the refused code was spent by nothing: it was never claimed, and it still works now the account is free
    await http().post('/auth/password/complete').send({ setupToken: newer, password: 'the newer passphrase B' }).expect(201);
    await t.prisma.signInAttempt.deleteMany({});

    // a completion that fails before its issuer write (here, at the lookup) frees the account at once
    fake.force = { '/v2/users': 503 };
    await setPassword(user.email!, 'never reaches the issuer', 503);
    fake.force = {};
    await t.prisma.signInAttempt.deleteMany({});
    await setPassword(user.email!, 'the third issuer passphrase', 201);

    // a verified code cancelled by a newer request keeps its hash (it was never claimed), and holds nothing: the newer
    // code completes at once
    await t.prisma.signInAttempt.deleteMany({});
    const cancelled = await codeFor();
    const replacement = await codeFor();
    expect(await t.prisma.passwordCredentialChallenge.count({
      where: { userId: user.id, verifiedAt: { not: null }, consumedAt: { not: null }, setupTokenExpiresAt: { not: null }, setupTokenHash: { not: null } },
    })).toBeGreaterThan(0);
    await http().post('/auth/password/complete').send({ setupToken: cancelled, password: 'a cancelled passphrase' }).expect(400);
    await http().post('/auth/password/complete').send({ setupToken: replacement, password: 'the replacement passphrase' }).expect(201);

    // an issuer write with no clear answer (here it landed, and PMC timed out) may still land: the claim keeps the
    // account for its lease, so a newer setup cannot report success and then be overwritten by the late write
    await t.prisma.signInAttempt.deleteMany({});
    const writeOriginal = IdentityClient.prototype.setPassword;
    vi.spyOn(IdentityClient.prototype, 'setPassword').mockImplementationOnce(async function (this: IdentityClient, ...args: Parameters<IdentityClient['setPassword']>) {
      await writeOriginal.apply(this, args);
      return 'down';
    });
    await setPassword(user.email!, 'the unclear passphrase', 503);
    const afterUnclear = await codeFor();
    const held = await http().post('/auth/password/complete').send({ setupToken: afterUnclear, password: 'the passphrase after it' }).expect(409);
    expect(held.body.message).toBe('Another password setup for this account is still finishing. Try again in a minute.');
    expect(held.body.code).toBe('setup-running');
    expect([...fake.people.values()].find((p) => p.email === user.email)?.password).toBe('the unclear passphrase');
    // its lease run out, the next setup proceeds
    await t.prisma.passwordCredentialChallenge.updateMany({
      where: { userId: user.id, setupTokenExpiresAt: null, setupTokenHash: { not: null } },
      data: { consumedAt: new Date(Date.now() - 3 * 60_000) },
    });
    await t.prisma.signInAttempt.deleteMany({});
    await http().post('/auth/password/complete').send({ setupToken: afterUnclear, password: 'the passphrase after it' }).expect(201);
    expect([...fake.people.values()].find((p) => p.email === user.email)?.password).toBe('the passphrase after it');

    // a completion that never ended (its process stopped) holds the account only for its lease
    await t.prisma.signInAttempt.deleteMany({});
    const stuck = await t.prisma.passwordCredentialChallenge.create({
      data: { userId: user.id, purpose: 'password_setup_or_reset', otpHash: 'stuck', expiresAt: new Date(), verifiedAt: new Date(), consumedAt: new Date(), setupTokenHash: `stuck-${Date.now()}` },
    });
    const blocked = await codeFor();
    await http().post('/auth/password/complete').send({ setupToken: blocked, password: 'the fourth issuer passphrase' }).expect(409);
    await t.prisma.passwordCredentialChallenge.update({ where: { id: stuck.id }, data: { consumedAt: new Date(Date.now() - 3 * 60_000) } });
    await t.prisma.signInAttempt.deleteMany({});
    await http().post('/auth/password/complete').send({ setupToken: blocked, password: 'the fourth issuer passphrase' }).expect(201);
    expect(await t.prisma.passwordCredentialChallenge.count({ where: { userId: user.id, setupTokenExpiresAt: null, verifiedAt: { not: null }, setupTokenHash: { not: null }, id: { not: stuck.id }, consumedAt: { gt: new Date(Date.now() - 2 * 60_000) } } })).toBe(0);
  }, 30_000);

  it('a password completion whose transaction the server closed (P2028), or whose claim clock is unreadable, answers 503, switch on or off; its code stays unspent', async () => {
    const user = await invitee('complete-p2028');
    const p2028 = () => new Prisma.PrismaClientKnownRequestError('Transaction already closed: timeout', { code: 'P2028', clientVersion: 'test' });
    for (const value of ['1', '0']) {
      process.env.IDENTITY_OIDC = value;
      await t.prisma.signInAttempt.deleteMany({});
      const requested = await http().post('/auth/password/request').send({ email: user.email }).expect(201);
      const verified = await http().post('/auth/password/verify').send({ requestId: requested.body.requestId, code: codes.get(user.email!) }).expect(201);
      // the claim's transaction (the first one) is closed by the server, as a credential lock held past its time closes it
      const tx = vi.spyOn(t.prisma, '$transaction').mockRejectedValueOnce(p2028());
      const r = await http().post('/auth/password/complete').send({ setupToken: verified.body.setupToken, password: `a ${value} passphrase of length` }).expect(503);
      expect(tx).toHaveBeenCalled();
      expect(r.body.message).toBe('Sign-in is unavailable just now. Try again in a few minutes.');
      tx.mockRestore();
      // the claim's clock read answers no usable time (the claim reads the database clock under the lock): also 503
      const realTransaction = t.prisma.$transaction.bind(t.prisma) as (work: (tx: unknown) => Promise<unknown>, options?: unknown) => Promise<unknown>;
      const clock = vi.spyOn(t.prisma, '$transaction').mockImplementationOnce(((work: (tx: unknown) => Promise<unknown>, options?: unknown) =>
        realTransaction((tx) => work(new Proxy(tx as object, {
          get: (target, key) => {
            if (key === '$queryRaw') return async () => [{ at: null }];
            const v = (target as Record<string | symbol, unknown>)[key];
            return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        })), options)) as never);
      const unreadable = await http().post('/auth/password/complete').send({ setupToken: verified.body.setupToken, password: `a ${value} passphrase of length` }).expect(503);
      expect(clock).toHaveBeenCalled();
      expect(unreadable.body.message).toBe('Sign-in is unavailable just now. Try again in a few minutes.');
      clock.mockRestore();
      // nothing was claimed: the same code completes now
      await http().post('/auth/password/complete').send({ setupToken: verified.body.setupToken, password: `a ${value} passphrase of length` }).expect(201);
    }
  });

  it('A5: every code is sent only after the password is proven; a wrong password answers each state exactly as an unknown email', async () => {
    const stamp = Date.now().toString(36).replace(/[0-9]/g, 'x');
    // no-project: an issuer person with no PMC account
    const stranger = `rbid-a5-noproject-${Date.now()}@test.local`;
    fake.addPerson(stranger, 'the stranger passphrase');
    // invite-pending: an invitation never set up, whose email already has an issuer person
    const invited = await invitee('a5-invited');
    fake.addPerson(invited.email!, 'the invited passphrase');
    // email-unverified: an issuer person whose email is not verified
    const unverified = await invitee('a5-unverified');
    fake.addPerson(unverified.email!, 'the unverified passphrase', false);
    // test-account: a QA address with an issuer person
    const qa = await t.prisma.user.create({ data: { projectId: f.projectA.id, role: 'pmc', name: 'qa', email: `qa.rbida${stamp}@vitan.in`, passwordHash: 'x', emailVerifiedAt: new Date() } });
    made.push(qa.id);
    fake.addPerson(qa.email!, 'the qa passphrase');

    // with the right password, each state names itself (after proof)
    expect((await login(stranger, 'the stranger passphrase').expect(401)).body.code).toBe('no-project');
    expect((await login(invited.email!, 'the invited passphrase').expect(401)).body.code).toBe('invite-pending');
    expect((await login(unverified.email!, 'the unverified passphrase').expect(401)).body.code).toBe('email-unverified');
    expect((await login(qa.email!, 'the qa passphrase').expect(401)).body.code).toBe('test-account');

    // with a wrong one, nothing tells them apart from an address nobody holds: same status, no code, same body
    const unknown = await login(`rbid-a5-nobody-${Date.now()}@test.local`, 'a wrong passphrase').expect(401);
    expect(unknown.body.code).toBeUndefined();
    for (const email of [stranger, invited.email!, unverified.email!, qa.email!]) {
      const wrong = await login(email, 'a wrong passphrase');
      expect([wrong.status, wrong.body]).toEqual([unknown.status, unknown.body]);
    }
  });

  it('a test account address is never linked or retired', async () => {
    const qa = await t.prisma.user.create({ data: { projectId: f.projectA.id, role: 'pmc', name: 'qa', email: `qa.rbid${Date.now().toString(36).replace(/[0-9]/g, 'x')}@vitan.in`, passwordHash: 'x', emailVerifiedAt: new Date() } });
    made.push(qa.id);
    fake.addPerson(qa.email!, 'a qa passphrase');
    const r = await login(qa.email!, 'a qa passphrase').expect(401);
    expect(r.body.message).toMatch(/operator door/);
    expect(r.body.code).toBe('test-account');
    expect(await t.prisma.user.findUniqueOrThrow({ where: { id: qa.id } })).toMatchObject({ email: qa.email });
  });

  it('A4b guards: a retired row never counts as the last owner or the last holder; a decision under change is re-seated through its change request', async () => {
    const pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    const owner = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    const retire = async (label: string, role: string) => {
      const row = await invitee(label, role);
      await t.prisma.user.update({ where: { id: row.id }, data: { passwordHash: await bcrypt.hash('the old local passphrase', 4), emailVerifiedAt: new Date() } });
      return row;
    };
    const signInFresh = async (row: { email: string | null }) => {
      fake.addPerson(row.email!, `the ${row.email} passphrase`);
      await login(row.email!, `the ${row.email} passphrase`).expect(401); // joins fresh: the old row is retired
      const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: row.email! } });
      made.push(fresh.id);
      return fresh;
    };
    const OPTIONS = [
      { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
      { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
    ];
    const publish = async (body: Record<string, unknown>) => {
      const title = `rbid a4b guard ${Date.now()} ${Math.random()}`;
      const r = await http().post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmc}`).send({ title, room: 'Kitchen', publish: true, options: OPTIONS, ...body });
      expect(r.status, r.text).toBe(201);
      return (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
    };

    // 1. company: with owners {ownerUser, a retired row}, the live owner cannot step down; it can remove the retired seat
    const oldOwner = await retire('guard-owner', 'client');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: oldOwner.id, role: 'owner' } });
    await signInFresh(oldOwner);
    const demote = await http().patch(`/orgs/${f.orgA.id}/members/${f.ownerUser.id}`).set('Authorization', `Bearer ${owner}`).send({ role: 'admin' });
    expect(demote.status, demote.text).toBe(400);
    expect(demote.body.message).toBe('The org must keep at least one owner');
    expect(await t.prisma.orgMembership.findUniqueOrThrow({ where: { orgId_userId: { orgId: f.orgA.id, userId: f.ownerUser.id } } })).toMatchObject({ role: 'owner' });
    await http().delete(`/orgs/${f.orgA.id}/members/${oldOwner.id}`).set('Authorization', `Bearer ${owner}`).expect(200);

    // 2. project: a client-held open decision whose other client is retired: the live client cannot be removed. Earlier
    // cases leave live client seats on this project (the re-seat's new account); the PMC removes them first, so the only
    // client holders are the fixture's client and the retired row.
    const retiredIds = new Set((await t.prisma.identityRetirement.findMany({ select: { userId: true } })).map((r) => r.userId));
    const otherClients = await t.prisma.membership.findMany({ where: { projectId: f.projectA.id, role: 'client', status: 'active', userId: { not: f.clientUser.id } }, select: { userId: true } });
    for (const m of otherClients.filter((m) => !retiredIds.has(m.userId))) {
      await http().delete(`/projects/${f.projectA.id}/members/${m.userId}`).set('Authorization', `Bearer ${pmc}`).expect(200);
    }
    const clientHeld = await publish({ deciderKind: 'client' });
    const removeClient = await http().delete(`/projects/${f.projectA.id}/members/${f.clientUser.id}`).set('Authorization', `Bearer ${pmc}`);
    expect(removeClient.status, removeClient.text).toBe(409); // oldOwner's client seat, retired, does not count
    expect(removeClient.body.message).toMatch(/held by the client role/);
    const reroleClient = await http().patch(`/projects/${f.projectA.id}/members/${f.clientUser.id}`).set('Authorization', `Bearer ${pmc}`).send({ role: 'engineer' });
    expect(reroleClient.status, reroleClient.text).toBe(409); // the role change's guard counts live holders too
    expect(reroleClient.body.message).toMatch(/held by the client role/);
    await http().post(`/projects/${f.projectA.id}/decisions/${clientHeld}/withdraw`).set('Authorization', `Bearer ${pmc}`).send({ reason: 'A4b guard row' }).expect(201);

    // 3. a decision in `change` status named on the retired row: withdraw and forward refuse; the PMC withdraws the
    //    change request (the approved outcome stands), removes the row, and asks the changed need as a new decision
    const engineer = await retire('guard-change', 'engineer');
    const seat = await t.prisma.membership.findUniqueOrThrow({ where: { projectId_userId: { projectId: f.projectA.id, userId: engineer.id } } });
    const named = await publish({ deciderKind: 'member', deciderMembershipId: seat.id });
    await http().post(`/projects/${f.projectA.id}/decisions/${named}/approve`).set('Authorization', `Bearer ${t.issueProjectToken(engineer.id, f.projectA.id, 'engineer')}`).send({ optionIndex: 0 }).expect(201);
    const change = { reason: 'Slab cracked', costImpact: 0, timeImpactDays: 0 };
    const raised = await http().post(`/projects/${f.projectA.id}/decisions/${named}/change`).set('Authorization', `Bearer ${pmc}`).send(change);
    expect(raised.status, raised.text).toBe(201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: named } })).status).toBe('change');
    const fresh = await signInFresh(engineer);
    const added = await http().post(`/projects/${f.projectA.id}/members`).set('Authorization', `Bearer ${pmc}`).send({ name: 'guard-change', role: 'engineer', email: engineer.email });
    expect(added.body.userId).toBe(fresh.id);
    expect((await http().delete(`/projects/${f.projectA.id}/members/${engineer.id}`).set('Authorization', `Bearer ${pmc}`)).status).toBe(409);
    expect((await http().post(`/projects/${f.projectA.id}/decisions/${named}/withdraw`).set('Authorization', `Bearer ${pmc}`).send({ reason: 'x' })).status).toBe(409);
    await http().post(`/projects/${f.projectA.id}/decisions/${named}/change/withdraw`).set('Authorization', `Bearer ${pmc}`).expect(201);
    await http().delete(`/projects/${f.projectA.id}/members/${engineer.id}`).set('Authorization', `Bearer ${pmc}`).expect(200);
    // the change cannot be raised again on it (its named decider is gone): the changed need is a NEW decision, naming
    // the person's new seat
    const again = await http().post(`/projects/${f.projectA.id}/decisions/${named}/change`).set('Authorization', `Bearer ${pmc}`).send(change);
    expect(again.status, again.text).toBe(409);
    expect(again.body.message).toMatch(/a changed need is a NEW decision/);
    await publish({ deciderKind: 'member', deciderMembershipId: added.body.membershipId });
  });

  // A4b r3 (Codex 4452559441): a company whose projects are all archived still takes the person's new account by email,
  // so its retired seat can be re-seated and the `retired` list emptied; a brand-new identity still needs a home project
  it('A4b re-seat into a company with no live project: the owner adds the new account by email, then removes the retired row', async () => {
    const old = await invitee('no-live-co', 'pmc');
    await t.prisma.user.update({ where: { id: old.id }, data: { passwordHash: await bcrypt.hash('the old local passphrase', 4), emailVerifiedAt: new Date() } });
    await t.prisma.orgMembership.create({ data: { orgId: f.orgB.id, userId: old.id, role: 'admin' } });
    await t.prisma.orgMembership.create({ data: { orgId: f.orgB.id, userId: f.otherUser.id, role: 'owner' } });
    await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: new Date() } });
    try {
      fake.addPerson(old.email!, `the ${old.email} passphrase`);
      await login(old.email!, `the ${old.email} passphrase`).expect(401); // joins fresh: the old row is retired
      const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! } });
      made.push(fresh.id);
      const owner = t.issueOrgOwnerToken(f.otherUser.id, f.projectB.id, f.orgB.id);
      const added = await http().post(`/orgs/${f.orgB.id}/members`).set('Authorization', `Bearer ${owner}`)
        .send({ name: 'no-live-co', email: old.email, role: 'admin' });
      expect(added.status, added.text).toBe(201); // at b69084d: 400 "Create a project in this org first"
      expect(added.body.userId).toBe(fresh.id);
      await http().delete(`/orgs/${f.orgB.id}/members/${old.id}`).set('Authorization', `Bearer ${owner}`).expect(200);
      expect(await t.prisma.orgMembership.findMany({ where: { orgId: f.orgB.id, userId: { in: [old.id, fresh.id] } }, select: { userId: true, role: true } }))
        .toEqual([{ userId: fresh.id, role: 'admin' }]);
      // a brand-new identity still has no home project there
      const brandNew = await http().post(`/orgs/${f.orgB.id}/members`).set('Authorization', `Bearer ${owner}`)
        .send({ name: 'nobody yet', email: `rbid-no-home-${Date.now()}@test.local`, role: 'member' });
      expect(brandNew.status, brandNew.text).toBe(400);
      expect(brandNew.body.message).toBe('Create a project in this org first, so the new member has a home project');
    } finally {
      await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: null } });
      await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgB.id, userId: { in: [old.id, f.otherUser.id] } } });
    }
  });

  // A4b r1 (Codex 4451627324): two owner-roster writes on the last two owners, held behind the org key so both pass every
  // read before it and queue on the key together; the key orders them and the second is refused
  async function raceLastTwoOwners(
    act: (ownerTok: string, otherTok: string, otherId: string) => [Promise<{ status: number }>, Promise<{ status: number }>],
  ) {
    const other = await invitee('race-owner', 'client');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: other.id, role: 'owner' } });
    const ownerTok = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    const otherTok = t.issueOrgOwnerToken(other.id, f.projectA.id, f.orgA.id);
    const waiting = async () =>
      Number((await t.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)[0]?.n ?? 0);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = t.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'org:' + f.orgA.id}, 0))`;
      locked();
      await held;
    }, { timeout: 60_000 });
    await isLocked;
    const [a, b] = act(ownerTok, otherTok, other.id);
    await vi.waitFor(async () => expect(await waiting()).toBeGreaterThanOrEqual(2), { timeout: 30_000, interval: 50 });
    release();
    await holder;
    expect([(await a).status, (await b).status].sort()).toEqual([200, 400]);
    const owners = await t.prisma.orgMembership.count({ where: { orgId: f.orgA.id, role: 'owner', userId: { in: [f.ownerUser.id, other.id] } } });
    expect(owners).toBe(1);
    // leave the fixture's owner as it was
    await t.prisma.orgMembership.update({ where: { orgId_userId: { orgId: f.orgA.id, userId: f.ownerUser.id } }, data: { role: 'owner' } });
    await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgA.id, userId: other.id } });
  }

  it('A4b r1: two owners stepping each other down at once are ordered by the org key; the second is refused and the company keeps an owner (Codex 4451627324)', async () => {
    await raceLastTwoOwners((ownerTok, otherTok, otherId) => [
      http().patch(`/orgs/${f.orgA.id}/members/${otherId}`).set('Authorization', `Bearer ${ownerTok}`).send({ role: 'admin' }).then((r) => r),
      http().patch(`/orgs/${f.orgA.id}/members/${f.ownerUser.id}`).set('Authorization', `Bearer ${otherTok}`).send({ role: 'admin' }).then((r) => r),
    ]);
  });

  it('A4b r1: a removal and a step-down racing on the last two owners are ordered by the org key; one is refused and an owner remains (Codex 4451627324)', async () => {
    await raceLastTwoOwners((ownerTok, otherTok, otherId) => [
      http().delete(`/orgs/${f.orgA.id}/members/${otherId}`).set('Authorization', `Bearer ${ownerTok}`).then((r) => r),
      http().patch(`/orgs/${f.orgA.id}/members/${f.ownerUser.id}`).set('Authorization', `Bearer ${otherTok}`).send({ role: 'admin' }).then((r) => r),
    ]);
  });

  it('A4b re-seat: the ops list names a retired row still holding seats; the PMC and an owner add by email (the new account), then remove the old row; a named-decider seat refuses until the decision is withdrawn', async () => {
    const OPS = 'rbid-reseat-ops-token-0123456789abcdef';
    process.env.OPS_TOKEN = OPS;
    type Retired = { userId: string; email: string; projects: Array<{ id: string; role: string; status: string }>; companies: Array<{ id: string; role: string }> };
    const retiredList = async () => {
      const r = await http().get('/ops/people').set('Authorization', `Bearer ${OPS}`);
      expect(r.status, r.text).toBe(200);
      expect(r.text).not.toMatch(/passwordHash|"password"/);
      return r.body.retired as Retired[];
    };
    const pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    const owner = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);

    // an established engineer on project A, a member of company A, and the named decider of an open decision
    const old = await invitee('reseat', 'engineer');
    const phone = String(9_000_000_000 + Math.floor(Math.random() * 999_999_999));
    await t.prisma.user.update({ where: { id: old.id }, data: { phone, passwordHash: await bcrypt.hash('the old local passphrase', 4), emailVerifiedAt: new Date() } });
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: old.id, role: 'member' } });
    // a seat with an approval ceiling (no team command sets one): the list carries it so the re-seat stops on it
    const oldSeat = await t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectA.id, userId: old.id } }, data: { approvalLimit: 50000 } });
    const title = `rbid reseat ${Date.now()}`;
    const issued = await http().post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmc}`).send({
      title, room: 'Kitchen', publish: true, deciderKind: 'member', deciderMembershipId: oldSeat.id,
      options: [
        { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
      ],
    });
    expect(issued.status, issued.text).toBe(201);
    const decision = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } });
    expect((await retiredList()).map((r) => r.userId)).not.toContain(old.id); // not retired yet

    // the first Redbracket ID sign-in retires the old row; retirement itself writes no seat
    fake.addPerson(old.email!, 'my redbracket passphrase');
    await login(old.email!, 'my redbracket passphrase').expect(401);
    const fresh = await t.prisma.user.findUniqueOrThrow({ where: { email: old.email! } });
    made.push(fresh.id);
    expect(fresh.id).not.toBe(old.id);
    const listed = (await retiredList()).find((r) => r.userId === old.id);
    expect(listed).toMatchObject({
      email: old.email,
      projects: [{ id: f.projectA.id, role: 'engineer', status: 'active', approvalLimit: '50000.00', discipline: null }],
      companies: [{ id: f.orgA.id, role: 'member' }],
    });

    // 0. the retired row keeps its phone: an add by phone (project or company) finds the retired row and is refused,
    //    seating nobody (the set-aside address `<email>#retired-<id>` is not an address the add accepts)
    const retiredAdds = [
      http().post(`/projects/${f.projectA.id}/members`).set('Authorization', `Bearer ${pmc}`).send({ name: 'reseat', role: 'engineer', phone }),
      http().post(`/orgs/${f.orgA.id}/members`).set('Authorization', `Bearer ${owner}`).send({ name: 'reseat', role: 'admin', phone }),
    ];
    for (const add of retiredAdds) {
      const r = await add;
      expect(r.status, r.text).toBe(409);
      expect(r.body.message).toBe('This person now signs in with a new account. Add them by email.');
    }
    expect(await t.prisma.orgMembership.findUniqueOrThrow({ where: { orgId_userId: { orgId: f.orgA.id, userId: old.id } } })).toMatchObject({ role: 'member' });

    // 1. the PMC adds the person by email: the add lands on the new linked account, never the retired row
    const added = await http().post(`/projects/${f.projectA.id}/members`).set('Authorization', `Bearer ${pmc}`)
      .send({ name: 'reseat', role: 'engineer', email: old.email });
    expect(added.status, added.text).toBe(201);
    expect(added.body.userId).toBe(fresh.id);

    // 2. removing the retired row is refused while it is the named decider of an open decision
    const refused = await http().delete(`/projects/${f.projectA.id}/members/${old.id}`).set('Authorization', `Bearer ${pmc}`);
    expect(refused.status, refused.text).toBe(409);
    expect(refused.body.message).toMatch(/named decider/);
    expect((await retiredList()).map((r) => r.userId)).toContain(old.id);

    // 3. withdrawn (the refusal's own instruction; it is reissued to the new seat after), the old seat can go
    const withdrawn = await http().post(`/projects/${f.projectA.id}/decisions/${decision.id}/withdraw`).set('Authorization', `Bearer ${pmc}`)
      .send({ reason: 'Redbracket ID re-seat' });
    expect(withdrawn.status, withdrawn.text).toBe(201);
    await http().delete(`/projects/${f.projectA.id}/members/${old.id}`).set('Authorization', `Bearer ${pmc}`).expect(200);
    expect((await retiredList()).find((r) => r.userId === old.id)).toMatchObject({ projects: [], companies: [{ id: f.orgA.id, role: 'member' }] });

    // 4. the company seat: an owner adds the address (the new account), then removes the retired row
    const orgAdded = await http().post(`/orgs/${f.orgA.id}/members`).set('Authorization', `Bearer ${owner}`)
      .send({ name: 'reseat', email: old.email, role: 'member' });
    expect(orgAdded.status, orgAdded.text).toBe(201);
    expect(await t.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId: f.orgA.id, userId: fresh.id } } })).not.toBeNull();
    await http().delete(`/orgs/${f.orgA.id}/members/${old.id}`).set('Authorization', `Bearer ${owner}`).expect(200);

    // re-seated: the list no longer names the row, and the person signs in to the new account with the seat
    expect((await retiredList()).map((r) => r.userId)).not.toContain(old.id);
    // a seat on an archived project is off the list (nobody can re-seat there); restored, it is listed again
    await t.prisma.membership.create({ data: { projectId: f.projectB.id, userId: old.id, role: 'engineer', status: 'active' } });
    await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: new Date() } });
    try {
      expect((await retiredList()).map((r) => r.userId)).not.toContain(old.id);
    } finally {
      await t.prisma.project.update({ where: { id: f.projectB.id }, data: { archivedAt: null } });
    }
    expect((await retiredList()).find((r) => r.userId === old.id)?.projects).toEqual([expect.objectContaining({ id: f.projectB.id })]);
    // an invited (not yet active) seat is a seat too; a consultant seat carries its discipline, which the re-seat's add
    // names again (no roster shows an invited seat's discipline: A4b r2, Codex 4452016258)
    await t.prisma.membership.update({ where: { projectId_userId: { projectId: f.projectB.id, userId: old.id } }, data: { status: 'invited', role: 'consultant', discipline: 'mep' } });
    expect((await retiredList()).find((r) => r.userId === old.id)?.projects).toEqual([expect.objectContaining({ id: f.projectB.id, status: 'invited', role: 'consultant', discipline: 'mep' })]);
    await t.prisma.membership.delete({ where: { projectId_userId: { projectId: f.projectB.id, userId: old.id } } });
    expect((await retiredList()).map((r) => r.userId)).not.toContain(old.id);
    const ok = await login(old.email!, 'my redbracket passphrase').expect(201);
    expect(sub(ok.body.token)).toBe(fresh.id);
    expect(role(ok.body.token)).toBe('engineer');
    // the removal is the normal team command's: a recorded transition attributed to the PMC who made it
    const removal = await t.prisma.membershipTransition.findFirstOrThrow({ where: { membershipId: oldSeat.id, toStatus: 'removed' } });
    expect(removal.actorId).toBe(f.memberUser.id);
  });
});
