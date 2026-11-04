import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { IdentityClient, readLookup, searchBody, challenge } from './identity-client';
import { keyFromJwks, checkIdToken } from './id-token';
import { readIdentityConfig, identitySwitchOn, REDBRACKET_ISSUER } from './identity-config';
import { startFakeIssuer, type FakeIssuer } from '../../../test/unit-support/fake-issuer';

/**
 * Redbracket ID A2: the issuer client against a fake Zitadel on loopback (test/unit-support/fake-issuer.ts), which
 * records every request. Proves the server-side code + PKCE flow, the id token checks (issuer, RS256, state, nonce,
 * audience, expiry, key), the 4 s limit, the down/rejected split, v4.16's ListUsers shapes, and that only the typed
 * email and password are ever sent.
 */
describe('Redbracket ID A2: the switch', () => {
  it('is on only when IDENTITY_OIDC is exactly 1', () => {
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', '01', 'on']) {
      expect([v, identitySwitchOn({ IDENTITY_OIDC: v } as NodeJS.ProcessEnv)]).toEqual([v, false]);
      expect(readIdentityConfig({ IDENTITY_OIDC: v } as NodeJS.ProcessEnv)).toEqual({ state: 'off' });
    }
    expect(identitySwitchOn({ IDENTITY_OIDC: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  const full = {
    IDENTITY_OIDC: '1',
    IDENTITY_CLIENT_ID: 'pmc-client',
    IDENTITY_REDIRECT_URI: 'https://pms-api.vitan.in/auth/oidc/callback',
    IDENTITY_SERVICE_TOKEN: 'svc-secret-value',
  } as NodeJS.ProcessEnv;

  it('defaults the issuer to https://id.vitan.in and names faults without values', () => {
    const on = readIdentityConfig(full);
    expect(on).toEqual({ state: 'on', config: { issuer: REDBRACKET_ISSUER, endpoint: REDBRACKET_ISSUER, clientId: 'pmc-client', redirectUri: full.IDENTITY_REDIRECT_URI, serviceToken: 'svc-secret-value' } });
    const broken = readIdentityConfig({ ...full, IDENTITY_SERVICE_TOKEN: 'has space', IDENTITY_CLIENT_ID: '' });
    expect(broken).toEqual({ state: 'broken', faults: [{ name: 'IDENTITY_CLIENT_ID', problem: 'unset' }, { name: 'IDENTITY_SERVICE_TOKEN', problem: 'malformed' }] });
    expect(JSON.stringify(broken)).not.toContain('has space');
    // every bad variable is named at once: a bad issuer does not hide a bad redirect
    const both = readIdentityConfig({ ...full, IDENTITY_ISSUER: 'http://id.vitan.in', IDENTITY_REDIRECT_URI: 'ftp://x.in/cb' });
    expect(both).toEqual({ state: 'broken', faults: [{ name: 'IDENTITY_ISSUER', problem: 'malformed' }, { name: 'IDENTITY_REDIRECT_URI', problem: 'malformed' }] });
  });

  it('refuses an issuer that is not a plain https host (loopback http included), and takes a loopback endpoint for a test fake', () => {
    for (const issuer of ['https://id.vitan.in/x', 'https://id.vitan.in?x=1', 'https://u:p@id.vitan.in', 'http://id.vitan.in', 'http://127.0.0.1:9', 'ftp://id.vitan.in', 'nope']) {
      expect([issuer, readIdentityConfig({ ...full, IDENTITY_ISSUER: issuer }).state]).toEqual([issuer, 'broken']);
    }
    for (const endpoint of ['http://10.0.0.1:9', 'http://localhost.evil.in', 'http://127.0.0.1:9/x', 'https://id.example.in']) {
      expect([endpoint, readIdentityConfig({ ...full, IDENTITY_ISSUER_ENDPOINT: endpoint }).state]).toEqual([endpoint, 'broken']);
    }
    const local = readIdentityConfig({ ...full, IDENTITY_ISSUER: 'https://id.fake.test', IDENTITY_ISSUER_ENDPOINT: 'http://127.0.0.1:9', IDENTITY_REDIRECT_URI: 'http://127.0.0.1:1/cb' });
    expect(local).toMatchObject({ state: 'on', config: { issuer: 'https://id.fake.test', endpoint: 'http://127.0.0.1:9' } });
    // a redirect not exactly as it will be sent (whitespace `new URL` would drop) is malformed, not quietly mangled
    for (const redirect of [' https://pms-api.vitan.in/auth/oidc/callback', 'https://pms-api.vitan.in/auth/oidc/callback ', 'https://pms-api.vitan.in/auth/oidc/\tcallback', 'https://pms-api.vitan.in/auth/oidc/call\nback']) {
      expect([redirect, readIdentityConfig({ ...full, IDENTITY_REDIRECT_URI: redirect }).state]).toEqual([redirect, 'broken']);
    }
    expect(readIdentityConfig({ ...full, IDENTITY_REDIRECT_URI: 'https://pms-api.vitan.in/auth/oidc/callback' }).state).toBe('on');
    // a loopback http redirect is only for a local fake
    expect(readIdentityConfig({ ...full, IDENTITY_REDIRECT_URI: 'http://127.0.0.1:1/cb' }).state).toBe('broken');
  });

  it('in production accepts only https://id.vitan.in as the issuer', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(readIdentityConfig({ ...full, IDENTITY_ISSUER: 'https://id.example.in' }).state).toBe('broken');
      expect(readIdentityConfig({ ...full, IDENTITY_ISSUER: 'http://127.0.0.1:9' }).state).toBe('broken');
      // a fake's endpoint is never honoured in production: requests go to the issuer itself
      expect(readIdentityConfig({ ...full, IDENTITY_ISSUER_ENDPOINT: 'http://127.0.0.1:9' })).toEqual({ state: 'broken', faults: [{ name: 'IDENTITY_ISSUER_ENDPOINT', problem: 'malformed' }] });
      expect(readIdentityConfig({ ...full, IDENTITY_ISSUER: REDBRACKET_ISSUER }).state).toBe('on');
      expect(readIdentityConfig(full).state).toBe('on');
    } finally {
      process.env.NODE_ENV = before;
    }
  });
});

describe('Redbracket ID A2: the issuer client (fake Zitadel)', () => {
  let fake: FakeIssuer;
  let client: IdentityClient;
  const redirectUri = 'https://pms-api.vitan.in/auth/oidc/callback';

  beforeEach(async () => {
    fake = await startFakeIssuer();
    client = new IdentityClient({ issuer: fake.issuer, endpoint: fake.url, clientId: fake.clientId, redirectUri, serviceToken: fake.serviceToken }, { timeoutMs: 500 });
  });
  afterEach(async () => { await fake.close(); });

  it('signs in with the right password: code + PKCE driven by the server, checked id token, issuer session ended', async () => {
    const p = fake.addPerson('new.person@example.in', 'Right-pass-123');
    const r = await client.login('new.person@example.in', 'Right-pass-123');
    expect(r).toEqual({ ok: true, claims: { sub: p.userId, email: 'new.person@example.in', emailVerified: true, givenName: 'Test', familyName: 'Person' } });
    const paths = fake.requests.map((q) => `${q.method} ${q.path.split('?')[0]}`);
    expect(paths).toEqual([
      'GET /oauth/v2/authorize', 'POST /v2/sessions', 'POST /v2/oidc/auth_requests/' + paths[2]!.split('/').pop(),
      'POST /oauth/v2/token', 'GET /oauth/v2/keys', 'POST /zitadel.session.v2.SessionService/DeleteSession',
    ].slice(0, paths.length));
    // the authorize request carries PMC's client, the S256 challenge, state and nonce; the redirect is never followed
    const auth = new URL(fake.requests[0]!.path, fake.url).searchParams;
    expect([auth.get('client_id'), auth.get('code_challenge_method'), auth.get('redirect_uri'), auth.get('scope')])
      .toEqual([fake.clientId, 'S256', redirectUri, 'openid email profile phone']);
    expect(fake.requests.some((q) => q.path.startsWith('/ui/'))).toBe(false);
    // the token exchange sends the verifier whose S256 is that challenge
    const tokenReq = new URLSearchParams(fake.requests.find((q) => q.path === '/oauth/v2/token')!.body);
    expect(challenge(tokenReq.get('code_verifier')!)).toBe(auth.get('code_challenge'));
    // the service token goes only on service calls, never on authorize, token or keys
    for (const q of fake.requests) {
      const service = !q.path.startsWith('/oauth/v2/');
      expect([q.path.split('?')[0], q.headers.authorization === `Bearer ${fake.serviceToken}`]).toEqual([q.path.split('?')[0], service]);
    }
  });

  it('a wrong password or an unknown email is rejected (not an outage), and no token is asked for', async () => {
    fake.addPerson('a@example.in', 'Right-pass-123');
    expect(await client.login('a@example.in', 'wrong')).toEqual({ ok: false, failure: 'rejected' });
    expect(await client.login('nobody@example.in', 'whatever')).toEqual({ ok: false, failure: 'rejected' });
    expect(fake.requests.some((q) => q.path === '/oauth/v2/token')).toBe(false);
  });

  it('only the typed email and password are sent: never a stored bcrypt hash', async () => {
    fake.addPerson('b@example.in', 'Typed-pass-1');
    await client.login('b@example.in', 'Typed-pass-1');
    await client.login('b@example.in', 'other-typed');
    const all = fake.requests.map((q) => `${q.path}\n${q.body}`).join('\n');
    expect(all).not.toMatch(/\$2[aby]\$\d\d\$/);
    const sent = fake.requests.filter((q) => q.path === '/v2/sessions').map((q) => JSON.parse(q.body).checks.password.password);
    // every issuer session PMC opens carries a bounded lifetime, so a failed delete never leaves one alive
    expect(fake.requests.filter((q) => q.path === '/v2/sessions').map((q) => JSON.parse(q.body).lifetime)).toEqual(['60s', '60s']);
    expect(sent).toEqual(['Typed-pass-1', 'other-typed']);
  });

  it('an issuer that never answers is down: PMC’s own abort ends the wait', async () => {
    fake.addPerson('c@example.in', 'Right-pass-123');
    fake.hold = true;
    expect(await client.login('c@example.in', 'Right-pass-123')).toEqual({ ok: false, failure: 'down' });
    expect(await client.find('c@example.in')).toEqual({ found: 'down' });
    expect(await client.create({ email: 'c2@example.in', password: 'New-pass-123', verified: true })).toEqual({ ok: false, taken: false, failure: 'down' });
  });

  it('a locked person (412) is rejected, not an outage, and no token is asked for', async () => {
    fake.addPerson('l@example.in', 'Right-pass-123').locked = true;
    expect(await client.login('l@example.in', 'Right-pass-123')).toEqual({ ok: false, failure: 'rejected' });
    expect(fake.requests.some((q) => q.path === '/oauth/v2/token')).toBe(false);
  });

  it('an answer over 1 MB is down, never read in full', async () => {
    fake.addPerson('m@example.in', 'Right-pass-123');
    fake.oversize = '/v2/users';
    expect(await client.find('m@example.in')).toEqual({ found: 'down' });
    fake.oversize = '/v2/sessions';
    expect(await client.login('m@example.in', 'Right-pass-123')).toEqual({ ok: false, failure: 'down' });
  });

  it('a create answered 2xx with no user id is down (the issuer’s fault)', async () => {
    fake.createAnswersNoId = true;
    expect(await client.create({ email: 'n@example.in', password: 'New-pass-123', verified: true })).toEqual({ ok: false, taken: false, failure: 'down' });
  });

  it('the default limit is 4 seconds', async () => {
    const { IDENTITY_TIMEOUT_MS } = await import('./identity-client');
    expect(IDENTITY_TIMEOUT_MS).toBe(4000);
  });

  it('nothing listening is down', async () => {
    const url = fake.url;
    await fake.close();
    const dead = new IdentityClient({ issuer: 'https://id.fake.test', endpoint: url, clientId: 'x', redirectUri, serviceToken: 't' }, { timeoutMs: 500 });
    expect(await dead.login('d@example.in', 'p')).toEqual({ ok: false, failure: 'down' });
    expect(await dead.find('d@example.in')).toEqual({ found: 'down' });
    fake = await startFakeIssuer();
  });

  it('a 5xx anywhere, or PMC’s service token refused, is down', async () => {
    fake.addPerson('e@example.in', 'Right-pass-123');
    for (const prefix of ['/oauth/v2/authorize', '/v2/sessions', '/v2/oidc/auth_requests', '/oauth/v2/token', '/oauth/v2/keys']) {
      fake.force = { [prefix]: 503 };
      expect([prefix, await client.login('e@example.in', 'Right-pass-123')]).toEqual([prefix, { ok: false, failure: 'down' }]);
    }
    fake.force = {};
    const badToken = new IdentityClient({ issuer: fake.issuer, endpoint: fake.url, clientId: fake.clientId, redirectUri, serviceToken: 'not-pmc' }, { timeoutMs: 500 });
    expect(await badToken.login('e@example.in', 'Right-pass-123')).toEqual({ ok: false, failure: 'down' });
    // PMC's service token refused on the write calls is down too, never "your details were refused"
    const p = fake.addPerson('e2@example.in', 'Right-pass-123', false);
    expect(await badToken.create({ email: 'e3@example.in', password: 'New-pass-123', verified: true })).toEqual({ ok: false, taken: false, failure: 'down' });
    expect(await badToken.setPassword(p.userId, 'Other-pass-456')).toBe('down');
    expect(await badToken.markVerified(p.userId, 'e2@example.in')).toBe('down');
    expect([fake.people.get(p.userId)!.password, fake.people.get(p.userId)!.verified, [...fake.people.values()].some((q) => q.email === 'e3@example.in')])
      .toEqual(['Right-pass-123', false, false]);
  });

  it('the issuer rate-limiting (429) is down on every call, never "your details were refused"', async () => {
    const p = fake.addPerson('r@example.in', 'Right-pass-123', false);
    fake.force = { '/v2/users': 429, '/zitadel.user.v2.UserService/UpdateUser': 429, '/v2/sessions': 429 };
    expect(await client.find('r@example.in')).toEqual({ found: 'down' });
    expect(await client.create({ email: 'r2@example.in', password: 'New-pass-123', verified: true })).toEqual({ ok: false, taken: false, failure: 'down' });
    expect(await client.setPassword(p.userId, 'Other-pass-456')).toBe('down');
    expect(await client.markVerified(p.userId, 'r@example.in')).toBe('down');
    expect(await client.login('r@example.in', 'Right-pass-123')).toEqual({ ok: false, failure: 'down' });
  });

  it('after a reset, ends every issuer session of the person (and only theirs), and says when it could not', async () => {
    const p = fake.addPerson('s@example.in', 'Right-pass-123');
    const q = fake.addPerson('s2@example.in', 'Right-pass-123');
    const mine = [fake.openSession(p.userId), fake.openSession(p.userId)];
    const theirs = fake.openSession(q.userId);
    expect(await client.endPersonSessions(p.userId)).toBe(true);
    expect(fake.sessionsOf(p.userId)).toEqual([]);
    expect(fake.sessionsOf(q.userId)).toEqual([theirs]);
    // the deletes carry no session token: the service account's own permission ends them
    const deletes = fake.requests.filter((r) => r.path.endsWith('/DeleteSession')).map((r) => JSON.parse(r.body));
    expect(deletes.map((d) => d.sessionId).sort()).toEqual([...mine].sort());
    expect(deletes.every((d) => d.sessionToken === undefined)).toBe(true);
    // nobody's sessions: nothing to end
    expect(await client.endPersonSessions(p.userId)).toBe(true);
    // the issuer refusing the list or a delete (a missing grant) is reported, never thrown
    fake.openSession(p.userId);
    fake.force = { '/zitadel.session.v2.SessionService/DeleteSession': 403 };
    expect(await client.endPersonSessions(p.userId)).toBe(false);
    fake.force = { '/zitadel.session.v2.SessionService/ListSessions': 403 };
    expect(await client.endPersonSessions(p.userId)).toBe(false);
  });

  it('names the ways besides a password a person can sign in, and is down on a refusal or an odd answer', async () => {
    const p = fake.addPerson('m@example.in', 'Right-pass-123', false);
    expect(await client.otherSignInMethods(p.userId)).toEqual([]);
    p.methods = ['AUTHENTICATION_METHOD_TYPE_PASSKEY', 'AUTHENTICATION_METHOD_TYPE_IDP'];
    expect(await client.otherSignInMethods(p.userId)).toEqual(['AUTHENTICATION_METHOD_TYPE_PASSKEY', 'AUTHENTICATION_METHOD_TYPE_IDP']);
    fake.force = { '/zitadel.user.v2.UserService/ListAuthenticationMethodTypes': 403 };
    expect(await client.otherSignInMethods(p.userId)).toBe('down');
    fake.force = {};
    fake.oversize = '/zitadel.user.v2.UserService/ListAuthenticationMethodTypes';
    expect(await client.otherSignInMethods(p.userId)).toBe('down');
  });

  it('a signing key the issuer withdraws is not trusted again, even by a client that used it before', async () => {
    fake.addPerson('k@example.in', 'Right-pass-123');
    expect((await client.login('k@example.in', 'Right-pass-123')).ok).toBe(true);
    fake.keysWithdrawn = true;
    expect(await client.login('k@example.in', 'Right-pass-123')).toEqual({ ok: false, failure: 'down' });
  });

  it('PMC’s client unknown at the issuer (no auth request) is down, not a wrong password', async () => {
    fake.addPerson('f@example.in', 'Right-pass-123');
    const wrongClient = new IdentityClient({ issuer: fake.issuer, endpoint: fake.url, clientId: 'hub-client', redirectUri, serviceToken: fake.serviceToken }, { timeoutMs: 500 });
    expect(await wrongClient.login('f@example.in', 'Right-pass-123')).toEqual({ ok: false, failure: 'down' });
    expect(fake.requests.some((q) => q.path === '/v2/sessions')).toBe(false);
  });

  for (const spoil of ['issuer', 'alg-none', 'alg-hs256', 'state', 'nonce', 'audience', 'expired', 'kid', 'signature', 'no-iat', 'azp', 'nbf-future'] as const) {
    it(`an id token or callback spoiled by ${spoil} opens no session`, async () => {
      fake.addPerson('g@example.in', 'Right-pass-123');
      fake.spoil = spoil;
      expect(await client.login('g@example.in', 'Right-pass-123')).toEqual({ ok: false, failure: 'down' });
    });
  }

  it('reads v4.16 ListUsers: details-only and empty results are nobody; anything else unclear; a missing isVerified is false', async () => {
    expect(readLookup(200, JSON.stringify({ details: { timestamp: 'x' } }), 'a@b.in')).toEqual({ found: 'none' });
    expect(readLookup(200, JSON.stringify({ details: { totalResult: '0' }, result: [] }), 'a@b.in')).toEqual({ found: 'none' });
    expect(readLookup(200, JSON.stringify({ details: { totalResult: 0 } }), 'a@b.in')).toEqual({ found: 'none' });
    expect(readLookup(200, JSON.stringify({ details: { totalResult: '2' }, result: [] }), 'a@b.in')).toEqual({ found: 'unclear' });
    expect(readLookup(200, JSON.stringify({ result: 'nope' }), 'a@b.in')).toEqual({ found: 'unclear' });
    expect(readLookup(200, JSON.stringify({}), 'a@b.in')).toEqual({ found: 'unclear' });
    expect(readLookup(200, 'not json', 'a@b.in')).toEqual({ found: 'unclear' });
    expect(readLookup(404, '{}', 'a@b.in')).toEqual({ found: 'unclear' });
    expect(readLookup(200, JSON.stringify({ result: [{ userId: 'u1', human: { email: { email: 'a@b.in' } } }] }), 'a@b.in')).toEqual({ found: 'one', userId: 'u1', verified: false });
    expect(readLookup(200, JSON.stringify({ result: [{ userId: 'u1', human: { email: { email: 'a@b.in', isVerified: true } } }] }), 'a@b.in')).toEqual({ found: 'one', userId: 'u1', verified: true });
    expect(readLookup(200, JSON.stringify({ result: [{ userId: 'u1', human: { email: {} } }, { userId: 'u2', human: { email: {} } }] }), 'a@b.in')).toEqual({ found: 'unclear' });
    // the issuer's own count, when given, must be exactly one: one row of several is unclear
    expect(readLookup(200, JSON.stringify({ details: { totalResult: '2' }, result: [{ userId: 'u1', human: { email: { email: 'a@b.in' } } }] }), 'a@b.in')).toEqual({ found: 'unclear' });
    expect(readLookup(200, JSON.stringify({ details: { totalResult: '1' }, result: [{ userId: 'u1', human: { email: { email: 'a@b.in' } } }] }), 'a@b.in')).toEqual({ found: 'one', userId: 'u1', verified: false });
    // a login name can keep an old address after the email changed: only the CURRENT email names the person
    expect(readLookup(200, JSON.stringify({ result: [{ userId: 'u1', human: { email: { email: 'new@b.in', isVerified: true } } }] }), 'a@b.in')).toEqual({ found: 'unclear' });
    expect(readLookup(200, JSON.stringify({ result: [{ userId: 'u1', human: { email: { email: 'A@B.in', isVerified: true } } }] }), 'a@b.in')).toEqual({ found: 'one', userId: 'u1', verified: true });
    expect(searchBody('a@b.in')).toEqual({
      query: { offset: 0, limit: 2, asc: true },
      queries: [{ orQuery: { queries: [{ loginNameQuery: { loginName: 'a@b.in', method: 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE' } }, { emailQuery: { emailAddress: 'a@b.in', method: 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE' } }] } }],
    });
  });

  it('finds, creates (409 leaves the person alone), sets a password and marks an email verified', async () => {
    expect(await client.find('h@example.in')).toEqual({ found: 'none' });
    const made = await client.create({ email: 'h@example.in', givenName: 'H', password: 'New-pass-123', verified: true });
    expect(made.ok).toBe(true);
    const id = made.ok ? made.userId : '';
    expect(await client.find('h@example.in')).toEqual({ found: 'one', userId: id, verified: true });
    expect(await client.create({ email: 'h@example.in', password: 'Takeover-1', verified: true })).toEqual({ ok: false, taken: true });
    expect(fake.people.get(id)!.password).toBe('New-pass-123');
    expect(await client.setPassword(id, 'Reset-pass-456')).toBeNull();
    // the administrative set (Zitadel v4.16 `case nil:`): no current password and no issuer code are sent
    const pwBody = JSON.parse(fake.requests.filter((q) => q.path.endsWith('/password')).at(-1)!.body);
    expect(pwBody).toEqual({ newPassword: { password: 'Reset-pass-456', changeRequired: false } });
    expect(fake.people.get(id)!.password).toBe('Reset-pass-456');
    const u = fake.addPerson('i@example.in', 'x', false);
    expect(await client.markVerified(u.userId, 'i@example.in')).toBeNull();
    expect(fake.people.get(u.userId)!.verified).toBe(true);
    expect(await client.setPassword('nobody', 'x')).toBe('rejected');
    fake.noneShape = 'odd';
    expect(await client.find('nobody@example.in')).toEqual({ found: 'unclear' });
  });
});

describe('Redbracket ID A2: the id token check alone', () => {
  it('refuses a key that is not RSA, and finds a key by kid only', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwks = JSON.stringify({ keys: [{ ...(rsa.publicKey.export({ format: 'jwk' }) as object), kid: 'a', use: 'sig', alg: 'RS256' }] });
    expect(keyFromJwks(jwks, 'a')?.asymmetricKeyType).toBe('rsa');
    expect(keyFromJwks(jwks, 'b')).toBeNull();
    // key_ops, when present, must allow verify (RFC 7517 4.3)
    const withOps = (ops: unknown) => JSON.stringify({ keys: [{ ...(rsa.publicKey.export({ format: 'jwk' }) as object), kid: 'a', use: 'sig', key_ops: ops }] });
    expect(keyFromJwks(withOps(['verify']), 'a')?.asymmetricKeyType).toBe('rsa');
    expect(keyFromJwks(withOps(['encrypt']), 'a')).toBeNull();
    expect(keyFromJwks(withOps('verify'), 'a')).toBeNull();
    expect(keyFromJwks(withOps([]), 'a')).toBeNull();
    // two usable keys under one kid: neither is trusted
    const rsa2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const twice = JSON.stringify({ keys: [rsa.publicKey, rsa2.publicKey].map((pk) => ({ ...(pk.export({ format: 'jwk' }) as object), kid: 'a', use: 'sig' })) });
    expect(keyFromJwks(twice, 'a')).toBeNull();
    expect(keyFromJwks('not json', 'a')).toBeNull();
    const token = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImEifQ.e30.AAAA';
    expect(await checkIdToken(token, { issuer: 'x', clientId: 'c', nonce: 'n', now: 0, key: async () => ec.publicKey })).toBeNull();
    expect(await checkIdToken('a.b', { issuer: 'x', clientId: 'c', nonce: 'n', now: 0, key: async () => rsa.publicKey })).toBeNull();
  });

  it('accepts a well-formed token, and refuses the same token signed with a weak (1024-bit) RSA key', async () => {
    const sign = async (bits: number) => {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
      const now = 1_800_000_000;
      const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
      const input = `${enc({ alg: 'RS256', kid: 'k' })}.${enc({ iss: 'https://id.x.in', aud: 'c', sub: 's1', nonce: 'n', iat: now, exp: now + 60 })}`;
      const token = `${input}.${cryptoSign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
      return checkIdToken(token, { issuer: 'https://id.x.in', clientId: 'c', nonce: 'n', now, key: async () => publicKey });
    };
    expect(await sign(2048)).toMatchObject({ sub: 's1' });
    expect(await sign(1024)).toBeNull();
  });
});
