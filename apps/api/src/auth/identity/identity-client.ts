/**
 * Redbracket ID A2 — PMC's API talking to Redbracket ID (Zitadel v4.16 at `https://id.vitan.in`).
 *
 * The person only ever sees PMC's own form on pms.vitan.in. The API runs authorization code with PKCE itself:
 * authorize (the issuer answers with a redirect to its own login page, which is NOT followed; only its `authRequest`
 * id is read), create a session with the login name and password (`/v2/sessions`, service token), finish the auth
 * request with that session (`/v2/oidc/auth_requests/{id}`), read the code from the callback URL the issuer returns
 * (never visited), exchange it with the PKCE verifier, and check the id token (`id-token.ts`). The issuer's session is
 * then deleted (best effort): PMC issues its own session and never calls the issuer again for it.
 *
 * The same calls Hub makes live (JagPat/hub `com.portal.identity.IdentityClient`, #249) and rb before it.
 *
 * - Every call gives up after {@link IDENTITY_TIMEOUT_MS} (4 s). A timeout, a connection error, a 5xx, or the issuer
 *   refusing PMC's own service token (401/403 on a service call) is `down`: the issuer can't answer, and an ordinary
 *   person is told sign-in is unavailable. Only the password check (`/v2/sessions` answering 400, 404 or 412: a wrong
 *   password, no such user, a locked user) is `rejected`: a wrong password, not an outage. Every failure before it
 *   (no auth request) or after it (finishing the request, the code, the token, the id token check) is PMC's set-up or
 *   the issuer, never the person's password, so it is `down`, and no session is opened.
 * - No redirect is ever followed; a body is read to at most 1 MB.
 * - Only the email and the password the person just typed are sent. Nothing here reads PMC's database, so no stored
 *   PMC password or hash can reach the issuer.
 */
import { createHash, randomBytes, type KeyObject } from 'node:crypto';
import type { IdentityConfig } from './identity-config';
import { checkIdToken, keyFromJwks, type IdClaims } from './id-token';

export const IDENTITY_TIMEOUT_MS = 4000;
/** How long an issuer session PMC opens may live (a protobuf Duration): a sign-in finishes well inside it. */
export const ISSUER_SESSION_LIFETIME = '60s';
const BODY_LIMIT = 1_000_000;
/** How many of a person's issuer sessions one list asks for (each round deletes them, then lists again). */
export const SESSIONS_PAGE = 100;
/**
 * How many rounds a reset makes: up to 2,000 sessions, far past any person's own use. Past it the reset logs "cap
 * reached" (whoever opened that many is told apart from a missing permission), and the rest outlive it.
 */
export const SESSIONS_ROUNDS_MAX = 20;

/** `down`: no usable answer (timeout, network, 5xx, PMC's service token refused). `rejected`: the issuer said no. */
export type IdentityFailure = 'down' | 'rejected';

export type LoginResult = { ok: true; claims: IdClaims } | { ok: false; failure: IdentityFailure };
export type Lookup =
  | { found: 'none' }
  | { found: 'one'; userId: string; verified: boolean }
  | { found: 'unclear' }
  | { found: 'down' };
export type Created = { ok: true; userId: string } | { ok: false; taken: true } | { ok: false; taken: false; failure: IdentityFailure };

type Reply = { status: number; body: string; location: string | null };

export type IdentityClientOptions = { timeoutMs?: number; now?: () => number };

export class IdentityClient {
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly config: IdentityConfig, options: IdentityClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? IDENTITY_TIMEOUT_MS;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  // ------------------------------------------------------------------------------------------------- sign-in

  /** Checks this email and password at the issuer. Never throws. */
  async login(email: string, password: string): Promise<LoginResult> {
    const verifier = random(32);
    const state = random(16);
    const nonce = random(16);
    try {
      const q = new URLSearchParams({
        client_id: this.config.clientId,
        redirect_uri: this.config.redirectUri,
        response_type: 'code',
        scope: 'openid email profile phone',
        code_challenge: challenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      const started = await this.send('GET', `/oauth/v2/authorize?${q}`);
      if (started.status >= 500) return { ok: false, failure: 'down' };
      const authRequest = param(started.location, 'authRequest', this.config.endpoint);
      // no auth request is PMC's client set up wrong at the issuer, not the person's password
      if (!authRequest) return { ok: false, failure: 'down' };

      const session = await this.send('POST', '/v2/sessions', {
        // a bounded lifetime: Zitadel keeps a session with none until it is deleted, and the delete below is best effort
        json: { checks: { user: { loginName: email }, password: { password } }, lifetime: ISSUER_SESSION_LIFETIME },
        service: true,
      });
      if (session.status === 400 || session.status === 404 || session.status === 412) return { ok: false, failure: 'rejected' };
      if (session.status < 200 || session.status > 299) return { ok: false, failure: 'down' };
      const s = json(session.body);
      const sessionId = str(s.sessionId);
      const sessionToken = str(s.sessionToken);
      if (!sessionId || !sessionToken) return { ok: false, failure: 'down' };
      try {
        const done = await this.send('POST', `/v2/oidc/auth_requests/${encodeURIComponent(authRequest)}`, {
          json: { session: { sessionId, sessionToken } },
          service: true,
        });
        // the password was right from here on: any failure is the issuer or PMC's set-up, never a wrong password
        if (done.status < 200 || done.status > 299) return { ok: false, failure: 'down' };
        const callback = str(json(done.body).callbackUrl);
        if (param(callback, 'state', this.config.endpoint) !== state) return { ok: false, failure: 'down' };
        const code = param(callback, 'code', this.config.endpoint);
        if (!code) return { ok: false, failure: 'down' };

        const token = await this.send('POST', '/oauth/v2/token', {
          form: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: this.config.clientId,
            code,
            redirect_uri: this.config.redirectUri,
            code_verifier: verifier,
          }),
        });
        if (token.status !== 200) return { ok: false, failure: 'down' };
        const claims = await checkIdToken(str(json(token.body).id_token), {
          issuer: this.config.issuer,
          clientId: this.config.clientId,
          nonce,
          now: this.now(),
          key: (kid) => this.key(kid),
        });
        return claims ? { ok: true, claims } : { ok: false, failure: 'down' };
      } finally {
        void this.endSession(sessionId, sessionToken);
      }
    } catch {
      return { ok: false, failure: 'down' };
    }
  }

  /**
   * Deletes one issuer session. With its token (a session PMC opened itself), or without one (another session of a
   * person whose password PMC just reset), which takes the service account's session.delete permission. `denied` when
   * the issuer refused PMC's service account (403). Never throws.
   */
  private async endSession(sessionId: string, sessionToken?: string): Promise<'ended' | 'denied' | 'failed'> {
    try {
      const r = await this.send('POST', '/zitadel.session.v2.SessionService/DeleteSession', {
        json: sessionToken ? { sessionId, sessionToken } : { sessionId },
        service: true,
      });
      // a session already gone (it expired, or PMC's own sign-in deleted it first) is ended
      if ((r.status >= 200 && r.status <= 299) || r.status === 404) return 'ended';
      return r.status === 403 ? 'denied' : 'failed';
    } catch {
      // best effort: the issuer's session also expires on its own (ISSUER_SESSION_LIFETIME, set at creation)
      return 'failed';
    }
  }

  /**
   * After a reset, ends every issuer session the person holds (the rb login and any other portal's sign-in in progress
   * there), so whoever knew the old password is signed out of Redbracket ID itself. Each round lists up to
   * {@link SESSIONS_PAGE} of the person's sessions and deletes them; it lists again until none is left. `ended`: none
   * left; `denied`: the issuer refused PMC's service account (403: the session permission is missing); `cap`: still
   * sessions after {@link SESSIONS_ROUNDS_MAX} rounds; `failed`: anything else. A portal's own session (Hub's, PMC's)
   * is that portal's to end. Best effort: the password is already set. Never throws.
   */
  async endPersonSessions(userId: string): Promise<'ended' | 'denied' | 'cap' | 'failed'> {
    try {
      for (let round = 0; round < SESSIONS_ROUNDS_MAX; round += 1) {
        const r = await this.send('POST', '/zitadel.session.v2.SessionService/ListSessions', {
          json: { query: { limit: SESSIONS_PAGE }, queries: [{ userIdQuery: { id: userId } }] },
          service: true,
        });
        if (r.status === 403) return 'denied';
        if (r.status < 200 || r.status > 299) return 'failed';
        const listed = json(r.body).sessions;
        if (listed !== undefined && !Array.isArray(listed)) return 'failed';
        const ids = (listed ?? []).map((row: unknown) => (row && typeof row === 'object' ? str((row as Record<string, unknown>).id) : ''));
        if (ids.length === 0) return 'ended';
        if (ids.some((id) => !id)) return 'failed';
        const ended = await Promise.all(ids.map((id) => this.endSession(id)));
        if (ended.includes('denied')) return 'denied';
        if (ended.includes('failed')) return 'failed';
      }
      return 'cap';
    } catch {
      return 'failed';
    }
  }

  /**
   * The ways besides a password this person can sign in at the issuer (passkeys, one-time codes, U2F keys, linked
   * identity providers), as the issuer names them; `down` when it gave no usable answer. Asked before PMC resets a
   * person whose email was never verified, who may have been registered by someone else (see `setPassword`).
   */
  async otherSignInMethods(userId: string): Promise<string[] | 'down'> {
    try {
      const r = await this.send('POST', '/zitadel.user.v2.UserService/ListAuthenticationMethodTypes', { json: { userId }, service: true });
      if (r.status < 200 || r.status > 299) return 'down';
      const types = json(r.body).authMethodTypes;
      // Zitadel leaves out an empty list
      if (types === undefined) return [];
      if (!Array.isArray(types) || types.some((t) => typeof t !== 'string')) return 'down';
      return (types as string[]).filter((t) => t !== 'AUTHENTICATION_METHOD_TYPE_PASSWORD');
    } catch {
      return 'down';
    }
  }

  /**
   * The issuer's signing key for `kid`, read from its key set on every sign-in. Nothing is cached, so a key the issuer
   * has withdrawn (or replaced under the same kid) is never trusted again, not even by a long-running API.
   */
  private async key(kid: string): Promise<KeyObject | null> {
    const set = await this.send('GET', '/oauth/v2/keys');
    if (set.status !== 200) return null;
    return keyFromJwks(set.body, kid);
  }

  // ------------------------------------------------------------------------------------------------- people

  /**
   * What the issuer holds for this email. Zitadel v4.16 answers "nobody" with a 200 whose body has only `details`
   * (no `result`; `totalResult` absent, 0 or "0"). Anything that is not exactly that or exactly one user is
   * `unclear`, and an unclear answer never makes or changes a user. Never throws.
   */
  async find(email: string): Promise<Lookup> {
    try {
      const r = await this.send('POST', '/v2/users', { json: searchBody(email), service: true });
      if (isOutage(r.status)) return { found: 'down' };
      return readLookup(r.status, r.body, email);
    } catch {
      return { found: 'down' };
    }
  }

  /**
   * Makes a person at the issuer with the password they just chose on PMC's form. `verified` is true only when PMC
   * itself has just proved the mailbox (its own emailed code). A 409 means the email is already registered: that
   * person is left exactly as they are. Never throws.
   */
  async create(input: { email: string; givenName?: string; familyName?: string; password: string; verified: boolean }): Promise<Created> {
    try {
      const given = input.givenName?.trim() || input.email;
      const family = input.familyName?.trim() || '-';
      const r = await this.send('POST', '/v2/users/human', {
        json: {
          username: input.email,
          profile: { givenName: given, familyName: family, displayName: family === '-' ? given : `${given} ${family}` },
          email: { email: input.email, isVerified: input.verified },
          password: { password: input.password, changeRequired: false },
        },
        service: true,
      });
      if (r.status === 409) return { ok: false, taken: true };
      if (r.status < 200 || r.status > 299) return { ok: false, taken: false, failure: serviceFailure(r.status) };
      const userId = str(json(r.body).userId);
      // a 2xx with no user id is a malformed answer: the issuer's fault, not the person's
      return userId ? { ok: true, userId } : { ok: false, taken: false, failure: 'down' };
    } catch {
      return { ok: false, taken: false, failure: 'down' };
    }
  }

  /**
   * Sets a new password for a person whose mailbox PMC has just proved. Null when it worked. Never throws.
   * Zitadel v4.16 SetPassword with no `currentPassword` and no `verificationCode` is the administrative set, allowed by
   * the caller's user.write permission (PMC's service account): internal/api/grpc/user/v2/password.go, `case nil:`
   * calls `command.SetPassword`. PMC's own emailed code is the proof of the mailbox, so neither is sent.
   */
  async setPassword(userId: string, password: string): Promise<IdentityFailure | null> {
    try {
      const r = await this.send('POST', `/v2/users/${encodeURIComponent(userId)}/password`, {
        json: { newPassword: { password, changeRequired: false } },
        service: true,
      });
      return r.status >= 200 && r.status <= 299 ? null : serviceFailure(r.status);
    } catch {
      return 'down';
    }
  }

  /** Marks the email verified after PMC proved the mailbox itself (UpdateUser; v4.16 refuses SetEmail). Null when it worked. */
  async markVerified(userId: string, email: string): Promise<IdentityFailure | null> {
    try {
      const r = await this.send('POST', '/zitadel.user.v2.UserService/UpdateUser', {
        json: { userId, human: { email: { email, isVerified: true } } },
        service: true,
      });
      return r.status >= 200 && r.status <= 299 ? null : serviceFailure(r.status);
    } catch {
      return 'down';
    }
  }

  // ------------------------------------------------------------------------------------------------- HTTP

  private async send(
    method: 'GET' | 'POST',
    path: string,
    opts: { json?: unknown; form?: URLSearchParams; service?: boolean } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.service) headers.Authorization = `Bearer ${this.config.serviceToken}`;
    let body: string | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = opts.form.toString();
    }
    const signal = AbortSignal.timeout(this.timeoutMs);
    const res = await fetch(`${this.config.endpoint}${path}`, { method, headers, body, redirect: 'manual', signal });
    const text = await readCapped(res);
    return { status: res.status, body: text, location: res.headers.get('location') };
  }
}

/**
 * The issuer can't be used just now, not the person's fault: a 5xx, a 429 (rate limited; try again later), or a 401/403
 * on a service call, which is PMC's own service token refused.
 */
function isOutage(status: number): boolean {
  return status >= 500 || status === 429 || status === 401 || status === 403;
}

function serviceFailure(status: number): IdentityFailure {
  return isOutage(status) ? 'down' : 'rejected';
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_LIMIT) {
      await reader.cancel();
      throw new Error('issuer answer too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** ListUsers body: login name or email, exact match ignoring case (an issuer may keep `Name@x.in`), at most two. */
export function searchBody(email: string): unknown {
  const method = 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE';
  return {
    query: { offset: 0, limit: 2, asc: true },
    queries: [
      {
        orQuery: {
          queries: [{ loginNameQuery: { loginName: email, method } }, { emailQuery: { emailAddress: email, method } }],
        },
      },
    ],
  };
}

/**
 * Reads a ListUsers answer as Zitadel v4.16 gives it, for `email`. A person is `one` only when their CURRENT email is
 * that address: a login name can keep an old address after the email changed, and a match on it alone is `unclear`
 * (never a person PMC may set a password on). Exported for its own tests.
 */
export function readLookup(status: number, body: string, email: string): Lookup {
  if (status !== 200) return { found: 'unclear' };
  let o: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(body);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { found: 'unclear' };
    o = v as Record<string, unknown>;
  } catch {
    return { found: 'unclear' };
  }
  const result = o.result;
  if (result !== undefined && !Array.isArray(result)) return { found: 'unclear' };
  if (result === undefined || result.length === 0) {
    const details = o.details;
    if (result === undefined && (!details || typeof details !== 'object')) return { found: 'unclear' };
    const total = details && typeof details === 'object' ? (details as Record<string, unknown>).totalResult : undefined;
    const none = total === undefined || total === 0 || total === '0';
    return none ? { found: 'none' } : { found: 'unclear' };
  }
  if (result.length !== 1) return { found: 'unclear' };
  // the issuer's own count, when it gives one, must also be exactly one: a page showing one row of several is unclear
  const details = o.details && typeof o.details === 'object' ? (o.details as Record<string, unknown>) : undefined;
  const total = details?.totalResult;
  if (total !== undefined && total !== 1 && total !== '1') return { found: 'unclear' };
  const row = result[0] as Record<string, unknown> | null;
  const userId = row && typeof row === 'object' ? str(row.userId) : '';
  const human = row && typeof row === 'object' ? (row.human as Record<string, unknown> | undefined) : undefined;
  const mail = human && typeof human === 'object' ? (human.email as Record<string, unknown> | undefined) : undefined;
  if (!userId || !mail || typeof mail !== 'object') return { found: 'unclear' };
  const current = str(mail.email).trim().toLowerCase();
  if (!current || current !== email.trim().toLowerCase()) return { found: 'unclear' };
  // Zitadel leaves out a false boolean: a missing isVerified is not verified
  return { found: 'one', userId, verified: mail.isVerified === true };
}

function random(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** The PKCE S256 challenge for a verifier. */
export function challenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A query parameter of a URL the issuer gave (absolute, or relative to the issuer), or null. */
function param(url: string | null, name: string, issuer: string): string | null {
  if (!url) return null;
  try {
    return new URL(url, issuer).searchParams.get(name);
  } catch {
    return null;
  }
}

function json(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
