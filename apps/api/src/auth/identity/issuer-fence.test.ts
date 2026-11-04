import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IdentityClient, FENCE_ISSUER_CALLS } from './identity-client';
import { FENCE_RP_IDS } from './identity-config';
import { startFakeIssuer, type FakeIssuer, type FakePerson } from '../../../test/unit-support/fake-issuer';

/**
 * Redbracket ID reset, unit F: the issuer methods fence (`IdentityClient.fenceOtherMethods`) against the fake issuer,
 * whose answers follow Zitadel v4.16's write side (test/unit-support/fake-issuer.ts cites each). Nothing calls the
 * fence yet. Proves each question's some / none / unfinished answer, that every marker it made is removed by the very
 * next call (after a `some` too) and nothing it did not make is, that a failed removal stops it as `unfinished` naming
 * what is left, that a key on an rp id outside FENCE_RP_IDS is not seen (residual RP-COVERAGE), and its most calls.
 */
const SVC = '/zitadel.user.v2.UserService/';

describe('Redbracket ID reset F: the issuer methods fence', () => {
  let fake: FakeIssuer;
  let client: IdentityClient;
  let person: FakePerson;
  const redirectUri = 'http://127.0.0.1:1/cb';
  const calls = () => fake.requests.filter((r) => r.path.startsWith(SVC)).map((r) => `${r.path.slice(SVC.length)} ${r.body}`);
  const rpcs = () => fake.requests.filter((r) => r.path.startsWith(SVC)).map((r) => r.path.slice(SVC.length));
  const clean = () => expect(fake.methods(person.userId)).toMatchObject({ totp: 'none', otpEmail: false, otpSms: false, keys: [] });

  beforeEach(async () => {
    fake = await startFakeIssuer();
    client = new IdentityClient({ issuer: fake.issuer, endpoint: fake.url, clientId: fake.clientId, redirectUri, serviceToken: fake.serviceToken }, { timeoutMs: 500 });
    person = fake.addPerson('reset@vitan.in', 'old-password', true);
  });
  afterEach(async () => { await fake.close(); });

  it('no other way in: every question asked, each exactly as sent, and every marker removed', async () => {
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'none' });
    const id = person.userId;
    const sent = calls();
    expect(sent.slice(0, 5)).toEqual([
      `RegisterTOTP {"userId":"${id}"}`,
      `RemoveTOTP {"userId":"${id}"}`, // each marker removed by the very next call
      `AddOTPEmail {"userId":"${id}"}`,
      `RemoveOTPEmail {"userId":"${id}"}`,
      `AddOTPSMS {"userId":"${id}"}`, // no phone ever verified: failed_precondition, nothing written, nothing to remove
    ]);
    // then each rp id: a passkey registration and its removal by the id it answered, a security key and its removal
    const keyCalls = sent.slice(5);
    expect(keyCalls).toHaveLength(FENCE_RP_IDS.length * 4);
    FENCE_RP_IDS.forEach((rp, n) => {
      const [pk, pkOut, u2f, u2fOut] = keyCalls.slice(n * 4, n * 4 + 4);
      expect(pk).toBe(`RegisterPasskey {"userId":"${id}","domain":"${rp}"}`);
      expect(pkOut).toMatch(new RegExp(`^RemovePasskey \\{"userId":"${id}","passkeyId":"[0-9a-f-]{36}"\\}$`));
      expect(u2f).toBe(`RegisterU2F {"userId":"${id}","domain":"${rp}"}`);
      expect(u2fOut).toMatch(new RegExp(`^RemoveU2F \\{"userId":"${id}","u2fId":"[0-9a-f-]{36}"\\}$`));
    });
    clean();
    // every call carried the service token and the Connect header
    for (const r of fake.requests) expect([r.headers.authorization, r.headers['connect-protocol-version']]).toEqual([`Bearer ${fake.serviceToken}`, '1']);
  });

  it('makes at most FENCE_ISSUER_CALLS calls: the most is a person with a verified email and phone and nothing else', async () => {
    expect(FENCE_ISSUER_CALLS).toBe(3 * 2 + FENCE_RP_IDS.length * 2 * 2);
    fake.methods(person.userId).phoneVerified = true;
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'none' });
    expect(fake.requests).toHaveLength(FENCE_ISSUER_CALLS);
    clean();
  });

  it('TOTP ready is some, and nothing else is asked or removed', async () => {
    fake.methods(person.userId).totp = 'ready';
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'some', row: 'totp' });
    expect(rpcs()).toEqual(['RegisterTOTP']);
    expect(fake.methods(person.userId).totp).toBe('ready');
  });

  it('a pending TOTP (set-up never finished) is not a way in: replaced, then removed', async () => {
    fake.methods(person.userId).totp = 'pending';
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'none' });
    clean();
  });

  it('email codes on is some, even with the email unverified (already-added is checked first); the TOTP marker is removed and the codes kept', async () => {
    for (const verified of [true, false]) {
      fake.requests.length = 0;
      person.verified = verified;
      fake.methods(person.userId).otpEmail = true;
      expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'some', row: 'otp-email' });
      expect(rpcs()).toEqual(['RegisterTOTP', 'RemoveTOTP', 'AddOTPEmail']);
      expect(fake.methods(person.userId)).toMatchObject({ totp: 'none', otpEmail: true });
    }
  });

  it('SMS codes on is some, with no verified phone; the email codes the fence turned on are turned off again', async () => {
    fake.methods(person.userId).otpSms = true;
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'some', row: 'otp-sms' });
    expect(rpcs()).toEqual(['RegisterTOTP', 'RemoveTOTP', 'AddOTPEmail', 'RemoveOTPEmail', 'AddOTPSMS']);
    expect(fake.methods(person.userId)).toMatchObject({ totp: 'none', otpEmail: false, otpSms: true });
  });

  it('a ready passkey or security key on any listed rp id is some; the person\'s own key is kept and every marker removed', async () => {
    for (const rp of FENCE_RP_IDS) {
      for (const kind of ['passkey', 'u2f'] as const) {
        const m = fake.methods(person.userId);
        m.keys = [{ id: 'own-key', kind, rpId: rp, ready: true }];
        expect([rp, kind, await client.fenceOtherMethods(person.userId)]).toEqual([rp, kind, { fence: 'some', row: `${kind} ${rp}` }]);
        expect(m).toMatchObject({ totp: 'none', otpEmail: false, otpSms: false, keys: [{ id: 'own-key', kind, rpId: rp, ready: true }] });
      }
    }
  });

  it('a legacy key with no rp id is listed for the instance domain, so it is some', async () => {
    fake.methods(person.userId).keys = [{ id: 'legacy', kind: 'passkey', rpId: '', ready: true }];
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'some', row: 'passkey id.vitan.in' });
  });

  it('residual RP-COVERAGE: a ready key on an rp id outside FENCE_RP_IDS is not seen; a key never finished is not a way in', async () => {
    fake.methods(person.userId).keys = [
      { id: 'elsewhere', kind: 'passkey', rpId: 'new-portal.vitan.in', ready: true },
      { id: 'unfinished', kind: 'u2f', rpId: 'rb.vitan.in', ready: false },
    ];
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'none' });
    expect(fake.methods(person.userId).keys.map((k) => k.id)).toEqual(['elsewhere', 'unfinished']);
  });

  it('a refused question (permission missing) is unfinished, and nothing it did not make is removed', async () => {
    fake.force[`${SVC}RegisterTOTP`] = 403;
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'unfinished', row: 'totp', why: 'no usable answer', leftover: [] });
    expect(rpcs()).toEqual(['RegisterTOTP']);
  });

  it('an answer that is not exactly the expected error (another code, another id) is unfinished, never none', async () => {
    fake.force[`${SVC}AddOTPSMS`] = 400; // a 400 without failed_precondition and Q54j2
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'unfinished', row: 'otp-sms', why: 'no usable answer', leftover: [] });
    expect(rpcs()).toEqual(['RegisterTOTP', 'RemoveTOTP', 'AddOTPEmail', 'RemoveOTPEmail', 'AddOTPSMS']);
    clean();
    // the right status and Connect code with another error's id is not the "no verified phone" answer either
    fake.requests.length = 0;
    fake.answer = { path: `${SVC}AddOTPSMS`, status: 400, body: { code: 'failed_precondition', message: 'Errors.User.MFA.OTP.NotReady (COMMAND-other)' } };
    delete fake.force[`${SVC}AddOTPSMS`];
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'unfinished', row: 'otp-sms', why: 'no usable answer', leftover: [] });
    fake.answer = { path: `${SVC}RegisterTOTP`, status: 409, body: { code: 'already_exists', message: 'Errors.User.MFA.OTP.AlreadyReady (COMMAND-other)' } };
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'unfinished', row: 'totp', why: 'no usable answer', leftover: [] });
    clean();
  });

  it('a question with no answer may have written: unfinished, outcome unknown, naming it, and not removed blind', async () => {
    fake.force[`${SVC}AddOTPEmail`] = 503;
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'unfinished', row: 'otp-email', why: 'outcome unknown', leftover: ['otp-email'] });
    expect(rpcs()).toEqual(['RegisterTOTP', 'RemoveTOTP', 'AddOTPEmail']);
  });

  it('a key registration answering 2xx with no key id is outcome unknown; with unreadable options its key is still removed', async () => {
    const shapes: Array<[Record<string, unknown>, unknown]> = [
      [{ details: {} }, { fence: 'unfinished', row: 'passkey id.vitan.in', why: 'outcome unknown', leftover: ['passkey id.vitan.in'] }],
      [{ passkeyId: 'pk-1', publicKeyCredentialCreationOptions: { publicKey: { excludeCredentials: 'x' } } }, { fence: 'unfinished', row: 'passkey id.vitan.in', why: 'no usable answer', leftover: [] }],
      [{ passkeyId: 'pk-1' }, { fence: 'unfinished', row: 'passkey id.vitan.in', why: 'no usable answer', leftover: [] }],
    ];
    for (const [body, want] of shapes) {
      const fixed = await startFakeIssuer();
      const p = fixed.addPerson('reset@vitan.in', 'pw', true);
      fixed.methods(p.userId).keys.push({ id: 'pk-1', kind: 'passkey', rpId: 'id.vitan.in', ready: false });
      const c = new IdentityClient({ issuer: fixed.issuer, endpoint: fixed.url, clientId: fixed.clientId, redirectUri, serviceToken: fixed.serviceToken }, { timeoutMs: 500 });
      fixed.answer = { path: `${SVC}RegisterPasskey`, body };
      expect(await c.fenceOtherMethods(p.userId)).toEqual(want);
      const removed = fixed.requests.filter((r) => r.path === `${SVC}RemovePasskey`).map((r) => JSON.parse(r.body).passkeyId);
      expect(removed).toEqual('passkeyId' in body ? ['pk-1'] : []);
      await fixed.close();
    }
  });

  it('a removal that fails is unfinished, cleanup failed, naming the leftover; the other markers are still removed', async () => {
    fake.force[`${SVC}RemoveOTPEmail`] = 500;
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'unfinished', row: 'otp-email', why: 'cleanup failed', leftover: ['otp-email'] });
    expect(fake.methods(person.userId)).toMatchObject({ totp: 'none', otpEmail: true, keys: [] });
    // the leftover is a live way in: the person's next reset asks again and is contested (some), never linked
    delete fake.force[`${SVC}RemoveOTPEmail`];
    fake.requests.length = 0;
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'some', row: 'otp-email' });
  });

  it('a failed removal stops the fence, even after a some: cleanup failed wins, and nothing more is asked', async () => {
    fake.methods(person.userId).keys = [{ id: 'own', kind: 'u2f', rpId: 'id.vitan.in', ready: true }];
    fake.force[`${SVC}RemoveU2F`] = 503;
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'unfinished', row: 'u2f id.vitan.in', why: 'cleanup failed', leftover: ['u2f id.vitan.in'] });
    expect(rpcs().slice(-2)).toEqual(['RegisterU2F', 'RemoveU2F']);
    delete fake.force[`${SVC}RemoveU2F`];
    fake.requests.length = 0;
    fake.force[`${SVC}RemoveTOTP`] = 503;
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'unfinished', row: 'totp', why: 'cleanup failed', leftover: ['totp'] });
    expect(rpcs()).toEqual(['RegisterTOTP', 'RemoveTOTP']);
  });

  it('an email verified once and changed since still lets codes be added (v4.16 keeps "verified"): they are removed again', async () => {
    fake.methods(person.userId).emailEverVerified = true;
    person.verified = false; // the current address is unverified
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'none' });
    expect(rpcs().slice(0, 4)).toEqual(['RegisterTOTP', 'RemoveTOTP', 'AddOTPEmail', 'RemoveOTPEmail']);
    clean();
    // never verified: failed_precondition, nothing written
    const fresh = fake.addPerson('never@vitan.in', 'pw', false);
    fake.requests.length = 0;
    expect(await client.fenceOtherMethods(fresh.userId)).toEqual({ fence: 'none' });
    expect(rpcs().slice(0, 4)).toEqual(['RegisterTOTP', 'RemoveTOTP', 'AddOTPEmail', 'AddOTPSMS']);
  });

  it('an unknown person is unfinished, with nothing removed', async () => {
    expect(await client.fenceOtherMethods('399999999999999999')).toEqual({ fence: 'unfinished', row: 'totp', why: 'no usable answer', leftover: [] });
    expect(rpcs()).toEqual(['RegisterTOTP']);
  });

  it('a removal answering not_found with its own id is clean (already gone); not_found without it is a leftover', async () => {
    // someone else removed the email codes between the fence's add and its removal (as the add is answered)
    const gone = fake.received(`${SVC}AddOTPEmail`).then(() => { fake.methods(person.userId).otpEmail = false; });
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'none' });
    await gone;
    // RemoveOTPEmail answered not_found with its own id (b312D): clean
    expect(fake.requests.filter((r) => r.path === `${SVC}RemoveOTPEmail`)).toHaveLength(1);
    fake.requests.length = 0;
    fake.force[`${SVC}RemoveTOTP`] = 404; // a 404 that is not RemoveTOTP's own NotExisting (Hd9sd)
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'unfinished', row: 'totp', why: 'cleanup failed', leftover: ['totp'] });
  });

  it('never throws: an issuer that is not there is unfinished, outcome unknown', async () => {
    await fake.close();
    expect(await client.fenceOtherMethods(person.userId)).toEqual({ fence: 'unfinished', row: 'totp', why: 'outcome unknown', leftover: ['totp'] });
    fake = await startFakeIssuer();
  });
});
