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
 * How many delete rounds a full sweep of a person's issuer sessions makes: up to 2,000 sessions, far past any person's
 * own use. Past it the sweep answers `capped`, told apart from a missing permission.
 */
export const SESSIONS_ROUNDS_MAX = 20;
/**
 * Unit L: how many delete rounds a reset awaits before it answers (each one list and its deletes at once), followed
 * by one confirming list. Nothing runs on after it, and the sweep also stops at its deadline (`mayCall`).
 */
export const SESSIONS_AWAITED_ROUNDS = 3;
/** The issuer calls, one after another, an awaited sweep can make: a list per round, its deletes (at once), the confirming list. */
export const SESSIONS_AWAITED_CALLS = SESSIONS_AWAITED_ROUNDS * 2 + 1;
/**
 * The issuer calls `login` makes, each under the timeout: authorize, session, auth request, token, the signing keys,
 * and ending its own issuer session (not awaited, so counting it over-counts). Pinned in `completion-lease.test.ts`.
 */
export const LOGIN_ISSUER_CALLS = 6;

/** What ending a person's issuer sessions came to. Only `ended` means none is left; anything else is recorded. */
export type SessionsEnd = 'ended' | 'denied' | 'failed' | 'capped';

/** `down`: no usable answer (timeout, network, 5xx, PMC's service token refused). `rejected`: the issuer said no. */
export type IdentityFailure = 'down' | 'rejected';

export type LoginResult = { ok: true; claims: IdClaims } | { ok: false; failure: IdentityFailure };
export type Lookup =
  | { found: 'none' }
  | { found: 'one'; userId: string; verified: boolean }
  | { found: 'unclear' }
  | { found: 'down' };
/**
 * `reason` (a refused create only): the issuer's own reason, as {@link issuerReason} reads it; `passwordPolicy` is true when
 * that reason is the issuer's password complexity policy, which the person answers by choosing another password.
 */
export type Created =
  | { ok: true; userId: string }
  | { ok: false; taken: true }
  | { ok: false; taken: false; failure: IdentityFailure; reason?: string; passwordPolicy?: boolean };

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
   * Deletes one issuer session: with its token (a session PMC opened itself), or without one (another session of a
   * person whose password PMC just reset), which takes the service account's session delete permission. Only a 2xx
   * is `ended` (Zitadel answers 2xx for a session already gone; a 404 is not its answer and proves nothing). `denied`:
   * the issuer refused PMC's service account (403). Never throws.
   */
  private async endSession(sessionId: string, sessionToken?: string): Promise<'ended' | 'denied' | 'failed'> {
    try {
      const r = await this.send('POST', '/zitadel.session.v2.SessionService/DeleteSession', {
        json: sessionToken ? { sessionId, sessionToken } : { sessionId },
        service: true,
      });
      if (r.status >= 200 && r.status <= 299) return 'ended';
      return r.status === 403 ? 'denied' : 'failed';
    } catch {
      // best effort: the issuer's session also expires on its own (ISSUER_SESSION_LIFETIME, set at creation)
      return 'failed';
    }
  }

  /**
   * Unit L: after a reset, ends every issuer session the person holds (rb, Hub, the console), so whoever signed in
   * with the old password is signed out of Redbracket ID itself. Each round lists up to {@link SESSIONS_PAGE} of the
   * person's sessions (`userIdQuery`) and deletes them at once by id; then it lists again. After `rounds` delete
   * rounds (at most {@link SESSIONS_ROUNDS_MAX}) one more list confirms: `ended` when it shows none, or only sessions
   * whose delete this sweep saw taken (the list can lag its deletes) with nothing past them (a page that is not full,
   * and no larger count); `capped` when sessions are still listed. `denied`: the issuer refused PMC's service account
   * (403), or listed no rows while counting some (the session read permission is missing). `failed`: anything else (no usable answer, an unreadable list, a delete not taken). A portal's own
   * app session (Hub's, rb's) is that portal's to end. `mayCall` is asked before each list and each delete round
   * (its deletes go at once, so they end within one timeout): whether a call started now and running to its full
   * timeout still ends before the caller's deadline. When it is not, the sweep sends nothing more and answers `capped`
   * (a reset's sweep must never outlive the completion's hold on the account: Codex 4472985591 on #1342). Never throws.
   */
  async endPersonSessions(userId: string, rounds = SESSIONS_ROUNDS_MAX, mayCall: () => boolean = () => true): Promise<SessionsEnd> {
    const ended = new Set<string>();
    try {
      const last = Math.min(rounds, SESSIONS_ROUNDS_MAX);
      for (let round = 0; ; round += 1) {
        if (!mayCall()) return 'capped';
        const r = await this.send('POST', '/zitadel.session.v2.SessionService/ListSessions', {
          json: { query: { limit: SESSIONS_PAGE }, queries: [{ userIdQuery: { id: userId } }] },
          service: true,
        });
        if (r.status === 403) return 'denied';
        if (r.status < 200 || r.status > 299) return 'failed';
        // a 2xx whose body is not a JSON object (empty, cut off, not JSON) is no answer: never read as "none listed"
        // (Codex 4472729877)
        const body = strictJson(r.body);
        if (!body) return 'failed';
        // Zitadel leaves out an empty list (and a zero count)
        const listed = body.sessions ?? [];
        if (!Array.isArray(listed)) return 'failed';
        const ids = listed.map((row: unknown) => (row && typeof row === 'object' ? str((row as Record<string, unknown>).id) : ''));
        if (ids.some((id) => !id)) return 'failed';
        const raw = (body.details as Record<string, unknown> | undefined)?.totalResult;
        const counted = typeof raw === 'number' ? String(raw) : str(raw);
        const total = /^\d+$/.test(counted) ? Number(counted) : null;
        // no rows, yet the issuer counts some: a service account without the session read permission gets the rows it
        // may not read dropped while the count is kept (v4.16 with PermissionCheckV2 off, the default)
        if (ids.length === 0 && total !== null && total > 0) return 'denied';
        // proof that this page is the whole list: no rows with no count (Zitadel's answer for none) or a zero count; or
        // rows with a readable count that names exactly them, on a page that is not full. Rows without a readable count
        // prove nothing about what lies past them, since the issuer may cap a page below the limit asked (Codex
        // 4472839361); a count present but unreadable decides nothing (an unreadable count is taken as more)
        const whole = ids.length === 0 ? raw === undefined || total === 0 : total === ids.length && ids.length < SESSIONS_PAGE;
        if (whole && ids.every((id) => ended.has(id))) return 'ended';
        if (round >= last) return 'capped';
        if (!mayCall()) return 'capped';
        const results = await Promise.all(ids.map((id) => this.endSession(id)));
        results.forEach((result, i) => {
          if (result === 'ended') ended.add(ids[i]!);
        });
        if (results.includes('denied')) return 'denied';
        if (results.includes('failed')) return 'failed';
      }
    } catch {
      return 'failed';
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
      if (r.status < 200 || r.status > 299) {
        const failure = serviceFailure(r.status);
        if (failure === 'down') return { ok: false, taken: false, failure };
        return { ok: false, taken: false, failure, reason: issuerReason(r.status, r.body), passwordPolicy: PASSWORD_POLICY_KEY.test(r.body) };
      }
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

/**
 * Zitadel v4.16 names a password complexity refusal by its message key, `Errors.User.PasswordComplexityPolicy.<Rule>`:
 * in the error detail of a REST answer and inside the message of a Connect one (`Key (ID)`). Any of them means the
 * password broke the issuer's policy (internal/domain/policy_password_complexity.go).
 */
const PASSWORD_POLICY_KEY = /Errors\.User\.PasswordComplexityPolicy\.[A-Za-z]+/;

/**
 * The issuer's reason for a refusal, for PMC's own log line: its message key when the answer names one (REST
 * `details[].message`, or a key in `message`), else its `message`, else the status alone. Only the characters a key or a
 * plain sentence uses are kept, at most 160 of them; a refusal never echoes the password it was sent.
 */
export function issuerReason(status: number, body: string): string {
  let o: Record<string, unknown> = {};
  try {
    const v: unknown = JSON.parse(body);
    if (v && typeof v === 'object' && !Array.isArray(v)) o = v as Record<string, unknown>;
  } catch {
    // an unreadable body: the status is the reason
  }
  const details = Array.isArray(o.details) ? o.details : [];
  const keyed = details
    .map((d) => (d && typeof d === 'object' ? str((d as Record<string, unknown>).message) : ''))
    .find((m) => /^Errors\.[A-Za-z.]+$/.test(m));
  const message = str(o.message);
  const key = keyed || /Errors\.[A-Za-z.]+/.exec(message)?.[0] || '';
  const text = (key || message).replace(/[^A-Za-z0-9 .,:()_-]/g, '').slice(0, 160).trim();
  return text ? `${status} ${text}` : String(status);
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

/** The body as a JSON object, or null when it is empty, not JSON, or not an object (no lenient `{}` fallback). */
function strictJson(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
