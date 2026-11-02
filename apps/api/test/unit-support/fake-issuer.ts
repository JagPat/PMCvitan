/**
 * Redbracket ID — a small fake of the Zitadel v4.16 calls PMC makes, on loopback, for tests only.
 *
 * It answers the same paths the live issuer does (authorize, `/v2/sessions`, `/v2/oidc/auth_requests/{id}`, the token
 * exchange with PKCE, the key set, ListUsers with v4.16's "no user" shape, create, set password, UpdateUser,
 * DeleteSession), signs RS256 id tokens with its own key, and records every request it gets (method, path, headers,
 * body), so a test can prove what PMC sent and that it sent nothing at all. Knobs let a test make it slow or hold every
 * answer until close, fail a path, send an answer too large to read, lock a person, or spoil the token (another issuer,
 * another algorithm, another state, another nonce). Nothing it schedules outlives close().
 */
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakePerson = { userId: string; email: string; password: string; verified: boolean; givenName: string; familyName: string; locked?: boolean };
export type Recorded = { method: string; path: string; headers: IncomingMessage['headers']; body: string };
export type Spoil = 'none' | 'issuer' | 'alg-none' | 'alg-hs256' | 'state' | 'nonce' | 'audience' | 'expired' | 'kid' | 'signature' | 'no-iat' | 'azp' | 'nbf-future';

export type FakeIssuer = {
  /** where it listens (loopback http); PMC reaches it through IDENTITY_ISSUER_ENDPOINT */
  url: string;
  /** the issuer name it signs into `iss` (an https name, as PMC's settings require) */
  issuer: string;
  clientId: string;
  serviceToken: string;
  people: Map<string, FakePerson>;
  requests: Recorded[];
  /** milliseconds every answer waits (to reach PMC's 4 s limit) */
  delayMs: number;
  /** answer nothing until close() (proves PMC's own abort ends the wait, by its signal and not a stopwatch) */
  hold: boolean;
  /** a path prefix whose answer is a 200 over 1 MB, e.g. '/v2/users' */
  oversize: string | null;
  /** the key set answers with no keys (the issuer withdrew its signing key) */
  keysWithdrawn: boolean;
  /** create answers 201 with no userId (a malformed answer) */
  createAnswersNoId: boolean;
  /** a status forced on a path prefix, e.g. { '/v2/sessions': 503 } */
  force: Record<string, number>;
  spoil: Spoil;
  /** how ListUsers answers "nobody": v4.16's details-only body by default */
  noneShape: 'details-only' | 'empty-result' | 'odd';
  addPerson(email: string, password: string, verified?: boolean): FakePerson;
  close(): Promise<void>;
};

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export async function startFakeIssuer(opts: { clientId?: string; serviceToken?: string; redirectUri?: string; issuer?: string } = {}): Promise<FakeIssuer> {
  const clientId = opts.clientId ?? 'pmc-client-test';
  const serviceToken = opts.serviceToken ?? 'svc-token-test';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'k1';
  const authRequests = new Map<string, { redirectUri: string; state: string; nonce: string; challenge: string; clientId: string; sessionUser?: string }>();
  const sessions = new Map<string, { token: string; userId: string }>();
  const codes = new Map<string, { authRequest: string; used: boolean }>();

  const fake = {
    url: '',
    issuer: opts.issuer ?? 'https://id.fake.test',
    clientId,
    serviceToken,
    people: new Map<string, FakePerson>(),
    requests: [] as Recorded[],
    delayMs: 0,
    hold: false,
    oversize: null as string | null,
    createAnswersNoId: false,
    keysWithdrawn: false,
    force: {} as Record<string, number>,
    spoil: 'none' as Spoil,
    noneShape: 'details-only' as FakeIssuer['noneShape'],
    addPerson(email: string, password: string, verified = true): FakePerson {
      const p = { userId: `3${Math.floor(Math.random() * 1e17)}`, email: email.toLowerCase(), password, verified, givenName: 'Test', familyName: 'Person' };
      fake.people.set(p.userId, p);
      return p;
    },
    close: async () => {},
  };

  const byEmail = (email: string) => [...fake.people.values()].find((p) => p.email === email.toLowerCase());
  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const serviceOk = (req: IncomingMessage) => req.headers.authorization === `Bearer ${serviceToken}`;

  const idToken = (person: FakePerson, ar: { nonce: string; clientId: string }) => {
    const now = Math.floor(Date.now() / 1000);
    const header: Record<string, unknown> = { alg: 'RS256', kid, typ: 'JWT' };
    const payload: Record<string, unknown> = {
      iss: fake.issuer, aud: [ar.clientId], azp: ar.clientId, sub: person.userId, nonce: ar.nonce, iat: now, exp: now + 3600,
      email: person.email, email_verified: person.verified, given_name: person.givenName, family_name: person.familyName,
      // a role-looking claim, which PMC must never read as a role
      'urn:zitadel:iam:org:project:roles': { SUPERADMIN: {} }, roles: ['SUPERADMIN', 'ROLE_SUPER_ADMIN'],
    };
    if (fake.spoil === 'issuer') payload.iss = 'https://id.example.in';
    if (fake.spoil === 'nonce') payload.nonce = 'another';
    if (fake.spoil === 'audience') { payload.aud = ['someone-else']; payload.azp = 'someone-else'; }
    if (fake.spoil === 'expired') payload.exp = now - 3600;
    if (fake.spoil === 'kid') header.kid = 'unknown';
    if (fake.spoil === 'no-iat') delete payload.iat;
    if (fake.spoil === 'azp') payload.azp = 'someone-else';
    if (fake.spoil === 'nbf-future') payload.nbf = now + 3600;
    if (fake.spoil === 'alg-none') header.alg = 'none';
    if (fake.spoil === 'alg-hs256') header.alg = 'HS256';
    const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    const key: KeyObject = fake.spoil === 'signature' ? other.privateKey : privateKey;
    const signature = fake.spoil === 'alg-none' ? '' : b64u(sign('RSA-SHA256', Buffer.from(signingInput), key));
    return `${signingInput}.${signature}`;
  };

  const handle = (req: IncomingMessage, res: ServerResponse, body: string) => {
    const url = new URL(req.url ?? '/', fake.url);
    const path = url.pathname;
    for (const [prefix, status] of Object.entries(fake.force)) if (path.startsWith(prefix)) return send(res, status, { message: 'forced' });
    if (fake.oversize && path.startsWith(fake.oversize)) return send(res, 200, { padding: 'x'.repeat(1024 * 1024 + 1) });
    const json = (): Record<string, any> => { try { return JSON.parse(body || '{}'); } catch { return {}; } };

    if (req.method === 'GET' && path === '/oauth/v2/authorize') {
      const q = url.searchParams;
      if (q.get('client_id') !== clientId || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return send(res, 302, undefined, { Location: `${q.get('redirect_uri')}?error=invalid_request` });
      }
      const id = `V2_${randomUUID()}`;
      authRequests.set(id, { redirectUri: q.get('redirect_uri')!, state: q.get('state')!, nonce: q.get('nonce')!, challenge: q.get('code_challenge')!, clientId: q.get('client_id')! });
      return send(res, 302, undefined, { Location: `/ui/v2/login/login?authRequest=${id}` });
    }
    if (req.method === 'GET' && path === '/oauth/v2/keys') {
      if (fake.keysWithdrawn) return send(res, 200, { keys: [] });
      return send(res, 200, { keys: [{ ...(publicKey.export({ format: 'jwk' }) as object), kid, use: 'sig', alg: 'RS256' }] });
    }
    if (req.method === 'POST' && path === '/oauth/v2/token') {
      const f = new URLSearchParams(body);
      const c = codes.get(f.get('code') ?? '');
      const ar = c && authRequests.get(c.authRequest);
      if (!c || !ar || c.used || f.get('client_id') !== ar.clientId || f.get('redirect_uri') !== ar.redirectUri) return send(res, 400, { error: 'invalid_grant' });
      const challenge = createHash('sha256').update(f.get('code_verifier') ?? '', 'ascii').digest('base64url');
      if (challenge !== ar.challenge) return send(res, 400, { error: 'invalid_grant' });
      c.used = true;
      const person = fake.people.get(ar.sessionUser ?? '');
      if (!person) return send(res, 400, { error: 'invalid_grant' });
      return send(res, 200, { access_token: 'at', token_type: 'Bearer', expires_in: 3600, id_token: idToken(person, ar) });
    }
    if (!serviceOk(req)) return send(res, 401, { message: 'Errors.Token.Invalid' });
    if (req.method === 'POST' && path === '/v2/sessions') {
      const b = json();
      const person = byEmail(String(b?.checks?.user?.loginName ?? ''));
      if (!person) return send(res, 404, { message: 'Errors.User.NotFound' });
      if (person.locked) return send(res, 412, { message: 'Errors.User.Locked' });
      if (b?.checks?.password?.password !== person.password) return send(res, 400, { message: 'Errors.User.Password.Invalid' });
      const sessionId = randomUUID();
      const token = randomUUID();
      sessions.set(sessionId, { token, userId: person.userId });
      return send(res, 201, { sessionId, sessionToken: token, details: {} });
    }
    const finish = /^\/v2\/oidc\/auth_requests\/([^/]+)$/.exec(path);
    if (req.method === 'POST' && finish) {
      const ar = authRequests.get(decodeURIComponent(finish[1]!));
      const b = json();
      const s = sessions.get(String(b?.session?.sessionId ?? ''));
      if (!ar || !s || s.token !== b?.session?.sessionToken) return send(res, 400, { message: 'bad' });
      ar.sessionUser = s.userId;
      const code = randomUUID();
      codes.set(code, { authRequest: decodeURIComponent(finish[1]!), used: false });
      const state = fake.spoil === 'state' ? 'another' : ar.state;
      return send(res, 200, { callbackUrl: `${ar.redirectUri}?code=${code}&state=${state}` });
    }
    if (req.method === 'POST' && path === '/zitadel.session.v2.SessionService/DeleteSession') {
      sessions.delete(String(json().sessionId ?? ''));
      return send(res, 200, {});
    }
    if (req.method === 'POST' && path === '/v2/users') {
      const b = json();
      const qs = b?.queries?.[0]?.orQuery?.queries ?? [];
      const email = String(qs[1]?.emailQuery?.emailAddress ?? qs[0]?.loginNameQuery?.loginName ?? '');
      const person = byEmail(email);
      if (!person) {
        if (fake.noneShape === 'odd') return send(res, 200, { result: 'nope' });
        if (fake.noneShape === 'empty-result') return send(res, 200, { details: { totalResult: '0' }, result: [] });
        return send(res, 200, { details: { timestamp: new Date().toISOString() } });
      }
      const email_ = person.verified ? { email: person.email, isVerified: true } : { email: person.email };
      return send(res, 200, { details: { totalResult: '1' }, result: [{ userId: person.userId, human: { email: email_ } }] });
    }
    if (req.method === 'POST' && path === '/v2/users/human') {
      const b = json();
      if (byEmail(String(b?.email?.email ?? ''))) return send(res, 409, { message: 'Errors.User.AlreadyExists' });
      const p = fake.addPerson(String(b.email.email), String(b.password.password), b.email.isVerified === true);
      p.givenName = String(b?.profile?.givenName ?? '');
      p.familyName = String(b?.profile?.familyName ?? '');
      return send(res, 201, fake.createAnswersNoId ? { details: {} } : { userId: p.userId, details: {} });
    }
    const pw = /^\/v2\/users\/([^/]+)\/password$/.exec(path);
    if (req.method === 'POST' && pw) {
      const p = fake.people.get(decodeURIComponent(pw[1]!));
      if (!p) return send(res, 404, { message: 'Errors.User.NotFound' });
      p.password = String(json()?.newPassword?.password ?? '');
      return send(res, 200, { details: {} });
    }
    if (req.method === 'POST' && path === '/zitadel.user.v2.UserService/UpdateUser') {
      const b = json();
      const p = fake.people.get(String(b.userId ?? ''));
      if (!p) return send(res, 404, { message: 'Errors.User.NotFound' });
      if (b?.human?.email?.isVerified === true) p.verified = true;
      return send(res, 200, { details: {} });
    }
    return send(res, 404, { code: 5, message: 'Not Found' });
  };

  const timers = new Set<NodeJS.Timeout>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      fake.requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      const go = () => { try { handle(req, res, body); } catch { send(res, 500, { message: 'fake failed' }); } };
      if (fake.hold) return; // answered by no one: close() drops the connection
      if (fake.delayMs > 0) {
        const t = setTimeout(() => { timers.delete(t); go(); }, fake.delayMs);
        timers.add(t);
      } else go();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((resolve) => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
    server.closeAllConnections();
    server.close(() => resolve());
  });
  return fake;
}
