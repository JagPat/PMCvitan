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
import { FENCE_RP_IDS, type IdentityConfig } from './identity-config';
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

/** One question the issuer methods fence asks: an authenticator kind, and for a WebAuthn kind the rp id it asked about. */
export type FenceRow = 'totp' | 'otp-email' | 'otp-sms' | `passkey ${string}` | `u2f ${string}`;
/**
 * The issuer methods fence's answer. `none`: none of the ways in it asks about (TOTP, email and SMS codes, passkeys and
 * security keys on the rp ids in FENCE_RP_IDS), read from the issuer's write side (no projection lag). Recovery codes
 * and linked identity providers are NOT asked (residuals (g) and (e)), nor a key on an rp id outside FENCE_RP_IDS (f).
 * `some`: the person has one, `row` the first found. `unfinished`: a refused or unreadable answer (`row` the question);
 * a question with no answer at all (timeout, network, 5xx), so what it may have made is in `leftover` as maybe left
 * (`outcome unknown`); or the marker a question made could not be removed (`cleanup failed`, `leftover` names it).
 */
export type FenceAnswer =
  | { fence: 'none' }
  | { fence: 'some'; row: FenceRow }
  | { fence: 'unfinished'; row: FenceRow; why: 'no usable answer' | 'outcome unknown' | 'cleanup failed'; leftover: FenceRow[] };

/**
 * The most issuer calls one fence makes: TOTP, OTP email and OTP SMS (each an add and its removal), and a passkey and
 * a security key registration on every rp id (each with its removal). The completion lease must count these once the
 * fence is called (it is not yet).
 */
export const FENCE_ISSUER_CALLS = 3 * 2 + FENCE_RP_IDS.length * 2 * 2;

/** A Connect answer as the fence reads it: the status, the error code and message (Zitadel: `Key (ID)`), the body. */
type FenceReply = { status: number; code: string; message: string; body: Record<string, unknown> };

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
  private async endSession(sessionId: string, sessionToken?: string): Promise<'ended' | 'absent' | 'denied' | 'failed'> {
    try {
      const r = await this.send('POST', '/zitadel.session.v2.SessionService/DeleteSession', {
        json: sessionToken ? { sessionId, sessionToken } : { sessionId },
        service: true,
      });
      // a delete the issuer took is ended; a 404 (Zitadel answers 2xx for a session already gone, so this is not
      // Zitadel's answer) also counts as ended for a sweep, but is `absent`: not proof the session is gone (Stage 1 N1)
      if (r.status >= 200 && r.status <= 299) return 'ended';
      if (r.status === 404) return 'absent';
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
   * is that portal's to end. Best effort: the password is already set. Never throws. `rounds` bounds it below the
   * maximum: a reset awaits one round (one list, its deletes at once) before its own sessions check, which refuses
   * whatever that round left (a round that deleted any answers `cap`: it does not list again). `ended` collects the ids whose delete the issuer took (2xx).
   */
  async endPersonSessions(userId: string, rounds = SESSIONS_ROUNDS_MAX, ended?: Set<string>): Promise<'ended' | 'denied' | 'cap' | 'failed'> {
    try {
      for (let round = 0; round < Math.min(rounds, SESSIONS_ROUNDS_MAX); round += 1) {
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
        const results = await Promise.all(ids.map((id) => this.endSession(id)));
        results.forEach((result, i) => {
          // only a delete the issuer took (2xx) is left out of a later sessions check
          if (result === 'ended') ended?.add(ids[i]);
        });
        if (results.includes('denied')) return 'denied';
        if (results.includes('failed')) return 'failed';
      }
      return 'cap';
    } catch {
      return 'failed';
    }
  }

  /**
   * Whether the person holds any live issuer session (an expired one, still listed, does not count): `none`, `some`, `denied` (the issuer
   * refused PMC's service account, 403: the session permission is missing), or `down` (no usable answer). Asked before
   * the password write for a person whose email was never verified, and after it for every unlinked person (see
   * `setPassword`).
   */
  async hasSessions(userId: string, ended: ReadonlySet<string> = new Set()): Promise<'none' | 'some' | 'hidden' | 'denied' | 'down'> {
    try {
      const r = await this.send('POST', '/zitadel.session.v2.SessionService/ListSessions', {
        json: { query: { limit: SESSIONS_PAGE }, queries: [{ userIdQuery: { id: userId } }] },
        service: true,
      });
      if (r.status === 403) return 'denied';
      if (r.status < 200 || r.status > 299) return 'down';
      const body = json(r.body);
      // Zitadel leaves out an empty list (and a zero count). An empty list is not yet "none": a service account without
      // the session read permission gets the rows it may not read dropped, while the count can still name them, so
      // the count below decides (Stage 1 G2)
      const listed = body.sessions === undefined ? [] : body.sessions;
      if (!Array.isArray(listed)) return 'down';
      // an expired session cannot sign in, though Zitadel lists it until it is deleted (Codex 4464926718); a row with
      // no readable expiry is taken as live
      const now = Date.now();
      // a session PMC has just ended may still be listed for a moment (Zitadel's session list is read from a projection
      // that can lag its deletes): one in `ended` does not count (Stage 1 G3)
      const live = listed.filter((row: unknown) => {
        if (row && typeof row === 'object' && ended.has(str((row as Record<string, unknown>).id))) return false;
        const at = row && typeof row === 'object' ? (row as Record<string, unknown>).expirationDate : undefined;
        if (typeof at !== 'string') return true;
        const t = Date.parse(at);
        return Number.isNaN(t) || t > now;
      });
      if (live.length > 0) return 'some';
      // every row read has expired: "none" only when they are every session the issuer counts. A row left unread (the
      // issuer's own page cap may be under PMC's limit) may be live, and a count PMC cannot read decides nothing: both
      // are taken as signed in (the reset refuses, never guesses)
      const raw = (body.details as Record<string, unknown> | undefined)?.totalResult;
      // no rows and no count: Zitadel's answer for zero (it leaves a zero count out)
      if (raw === undefined && listed.length === 0) return 'none';
      const counted = typeof raw === 'number' ? String(raw) : str(raw);
      const total = /^\d+$/.test(counted) ? Number(counted) : NaN;
      if (!Number.isFinite(total)) return 'some';
      if (listed.length >= total) return 'none';
      // no rows read, yet the issuer counts some: rows PMC may not read were dropped (the session read permission is
      // missing). Signed in, as far as PMC can tell, with its own reason
      return listed.length === 0 ? 'hidden' : 'some';
    } catch {
      return 'down';
    }
  }

  /**
   * The ways besides a password this person can sign in at the issuer (passkeys, one-time codes, U2F keys, linked
   * identity providers), as the issuer names them; `down` when it gave no usable answer. Asked before and again after
   * PMC resets a person not yet linked, who may have been registered by someone else (see `setPassword`).
   */
  async otherSignInMethods(userId: string): Promise<string[] | 'down'> {
    try {
      // no domainQuery: with none Zitadel filters nothing, so a passkey or U2F key with no domain (registered through the
      // v1 hosted login) is listed too; a domainQuery needs a domain, and one would hide methods registered under
      // another portal's domain (Codex 4465814782, answered on its thread)
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

  // ------------------------------------------------------------------------------------------------- methods fence

  /**
   * Whether the person has a way to sign in at the issuer besides a password, asked of the issuer's WRITE side: each
   * question below is a command Zitadel v4.16 answers from its event store (FilterToQueryReducer), so a method made a
   * moment ago is never missed the way the methods list (a projection) can miss it. Nothing calls this yet.
   *
   * The caller must hold the issuer-person lock for `userId` (PMC's reset takes it before any issuer write): RemoveTOTP,
   * RemoveOTPEmail and RemoveOTPSMS name no marker id, so two fences on one person at once could remove each other's.
   *
   * Questions, in order, stopping at the first that is not `none` (Connect, service token; v4.16 cites):
   * 1. RegisterTOTP: `already_exists` COMMAND-do9se = TOTP ready (internal/command/user_human_otp.go addHumanTOTP).
   *    A 2xx made a pending (not ready) secret: removed with RemoveTOTP. The secret is never read or kept.
   * 2. AddOTPEmail: `already_exists` COMMAND-MKL2s = email codes on, checked BEFORE `failed_precondition` COMMAND-KLJ2d
   *    (email not verified: nothing written), so a person who has them always answers `already_exists`. A 2xx turned
   *    email codes ON for this person: removed with RemoveOTPEmail by the next call (addHumanOTPEmail; no notifier
   *    handles HumanOTPEmailAddedType). "Verified" is ever verified: v4.16's write model sets it on a verified event and
   *    keeps it through an email change (user_human_otp_model.go), so the codes would go to the CURRENT address, which
   *    the reset has just proved with PMC's own code. 3. AddOTPSMS: the same, COMMAND-Ad3g2 before COMMAND-Q54j2 (no
   *    phone ever verified).
   * 4. RegisterPasskey and 5. RegisterU2F on every rp id in FENCE_RP_IDS: the creation options list the person's READY
   *    keys for that rp id in `excludeCredentials` (internal/webauthn/converter.go WebAuthNsToCredentials; a key stored
   *    with no rp id is listed only for the instance domain). Any listed = `some`. The registration made a not-ready
   *    key: removed by its id with RemovePasskey / RemoveU2F.
   *
   * A marker a question made is removed by the very next call, before the answer is read or another question asked
   * (also after a `some`), so a marker lives for one call. A removal answering 2xx, or `not_found` with that removal's
   * own id (already gone), is clean; anything else stops the fence: `unfinished` / `cleanup failed`, naming the marker,
   * so the caller never links. A removal is sent only after the question's own 2xx. RemoveTOTP, RemoveOTPEmail and
   * RemoveOTPSMS name no id, so a factor the person themself made in that one call's window (e.g. their own TOTP,
   * registered and verified between the fence's RegisterTOTP and RemoveTOTP) is removed too: the person loses a factor
   * they just made, no one gains one (the answer, none, is then true). A question that gets no answer at all (timeout,
   * network, 5xx) may still have made its marker, which the fence cannot tell from the person's own, so it is not
   * removed and the answer is `unfinished` / `outcome unknown` naming it. Never throws; at most FENCE_ISSUER_CALLS calls.
   *
   * Lasting effect: the add and removal of email or SMS codes clears the person's "MFA setup skipped" mark (v4.16
   * query/projection/user.go on HumanOTP*Added), so a person who skipped MFA set-up may be asked again at their next
   * hosted-login sign-in while the login policy's MFAInitSkipLifetime is above 0. v4.16 has no API call to restore
   * the mark (HumanSkipMFAInit is used only by its own login UI, internal/api/ui/login/mfa_prompt_handler.go).
   */
  async fenceOtherMethods(userId: string): Promise<FenceAnswer> {
    try {
      return await this.fenceAsk(userId);
    } catch {
      return { fence: 'unfinished', row: 'totp', why: 'no usable answer', leftover: [] };
    }
  }

  /** The fence's questions, in order; a marker a question made is removed by the very next call, before any answer. */
  private async fenceAsk(userId: string): Promise<FenceAnswer> {
    const unfinished = (row: FenceRow, r?: FenceReply): FenceAnswer =>
      r && unanswered(r)
        ? // no answer to a question that writes: it may have made its marker (for the email and SMS rows, codes ON)
          { fence: 'unfinished', row, why: 'outcome unknown', leftover: [row] }
        : { fence: 'unfinished', row, why: 'no usable answer', leftover: [] };
    // removes the marker `row`'s own 2xx made; false when it may still be there (the fence then stops: cleanup failed)
    const removed = async (rpc: string, body: Record<string, string>, absent: string): Promise<boolean> => {
      const r = await this.fenceCall(rpc, body);
      return ok(r) || isError(r, 404, 'not_found', absent);
    };
    const leftover = (row: FenceRow): FenceAnswer => ({ fence: 'unfinished', row, why: 'cleanup failed', leftover: [row] });

    const totp = await this.fenceCall('RegisterTOTP', { userId });
    if (ok(totp)) {
      if (!(await removed('RemoveTOTP', { userId }, 'COMMAND-Hd9sd'))) return leftover('totp');
    } else if (isError(totp, 409, 'already_exists', 'COMMAND-do9se')) return { fence: 'some', row: 'totp' };
    else return unfinished('totp', totp);

    const otps = [
      { row: 'otp-email', add: 'AddOTPEmail', remove: 'RemoveOTPEmail', on: 'COMMAND-MKL2s', unverified: 'COMMAND-KLJ2d', absent: 'COMMAND-b312D' },
      { row: 'otp-sms', add: 'AddOTPSMS', remove: 'RemoveOTPSMS', on: 'COMMAND-Ad3g2', unverified: 'COMMAND-Q54j2', absent: 'COMMAND-Sr3h3' },
    ] as const;
    for (const o of otps) {
      const r = await this.fenceCall(o.add, { userId });
      if (ok(r)) {
        if (!(await removed(o.remove, { userId }, o.absent))) return leftover(o.row);
      } else if (isError(r, 409, 'already_exists', o.on)) return { fence: 'some', row: o.row };
      else if (!isError(r, 400, 'failed_precondition', o.unverified)) return unfinished(o.row, r);
    }

    for (const rpId of FENCE_RP_IDS) {
      const keys = [
        { row: `passkey ${rpId}`, add: 'RegisterPasskey', remove: 'RemovePasskey', id: 'passkeyId' },
        { row: `u2f ${rpId}`, add: 'RegisterU2F', remove: 'RemoveU2F', id: 'u2fId' },
      ] as const;
      for (const k of keys) {
        const r = await this.fenceCall(k.add, { userId, domain: rpId });
        const id = ok(r) ? str(r.body[k.id]) : '';
        // a 2xx with no key id made a key the fence cannot name to remove: its outcome is as unknown as no answer
        if (!id) return unfinished(k.row, ok(r) ? { ...r, status: 0 } : r);
        if (!(await removed(k.remove, { userId, [k.id]: id }, 'COMMAND-DAfb2'))) return leftover(k.row);
        const listed = excluded(r.body.publicKeyCredentialCreationOptions);
        if (listed === null) return unfinished(k.row);
        if (listed > 0) return { fence: 'some', row: k.row };
      }
    }
    return { fence: 'none' };
  }

  /** One fence question to the issuer's user service, read as Connect answers it. Never throws: no answer is status 0. */
  private async fenceCall(rpc: string, body: Record<string, string>): Promise<FenceReply> {
    try {
      const r = await this.send('POST', `/zitadel.user.v2.UserService/${rpc}`, { json: body, service: true });
      const o = json(r.body);
      return { status: r.status, code: str(o.code), message: str(o.message), body: o };
    } catch {
      return { status: 0, code: '', message: '', body: {} };
    }
  }

  // ------------------------------------------------------------------------------------------------- HTTP

  private async send(
    method: 'GET' | 'POST',
    path: string,
    opts: { json?: unknown; form?: URLSearchParams; service?: boolean } = {},
  ): Promise<Reply> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    // a `/zitadel.*` path is a Connect RPC: it names the protocol version, as the Connect protocol asks of a unary call.
    // The OIDC/OAuth paths and the REST `/v2/...` paths are not Connect calls and carry no such header.
    if (path.startsWith(CONNECT_PATH)) headers['Connect-Protocol-Version'] = '1';
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

/** the path prefix of the issuer's Connect RPCs (DeleteSession, UpdateUser) */
const CONNECT_PATH = '/zitadel.';

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

const ok = (r: FenceReply): boolean => r.status >= 200 && r.status <= 299;
/** no answer at all: a timeout or network failure (status 0) or a 5xx; the write may or may not have happened */
const unanswered = (r: FenceReply): boolean => r.status === 0 || r.status >= 500;

/**
 * A Connect error exactly as Zitadel v4.16 sends it for one command error: the HTTP status and Connect code its kind
 * maps to, and the message `Key (ID)` carrying that error's own id (internal/api/grpc/gerrors ZITADELToConnectError).
 */
function isError(r: FenceReply, status: number, code: string, id: string): boolean {
  return r.status === status && r.code === code && r.message.endsWith(`(${id})`);
}

/**
 * How many keys WebAuthn creation options list in `excludeCredentials` (go-webauthn leaves it out when there are none),
 * or null when the options are not the `{ publicKey: {...} }` shape Zitadel returns.
 */
function excluded(options: unknown): number | null {
  if (!options || typeof options !== 'object' || Array.isArray(options)) return null;
  const pk = (options as Record<string, unknown>).publicKey;
  if (!pk || typeof pk !== 'object' || Array.isArray(pk)) return null;
  const list = (pk as Record<string, unknown>).excludeCredentials;
  if (list === undefined || list === null) return 0;
  return Array.isArray(list) ? list.length : null;
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
