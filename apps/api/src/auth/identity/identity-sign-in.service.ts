/**
 * Redbracket ID A3 — PMC's email + password sign-in and its password setup or reset, through Redbracket ID, while the
 * switch is on (`IDENTITY_OIDC` exactly `1`; identity-config.ts). The switch off never reaches this file: the routes
 * keep today's bcrypt sign-in and password setup and no issuer is called.
 *
 * The person stays on PMC's own screens. PMC's API (never the browser) asks the issuer (identity-client.ts: the
 * authorization code flow with PKCE, the id token checked: iss exactly the issuer, RS256, state and nonce), then
 * issues PMC's own session exactly as today (`AuthService.signInUser`), so later requests never call the issuer.
 * Who the person is maps to a PMC account under the fresh-join rule (identity-accounts.ts). Roles stay in PMC's
 * Membership; nothing in the token is read as a role.
 *
 * Failures, for an ordinary person: the issuer saying no to the password is a wrong password (401). The issuer slow
 * (4 s), unreachable or failing, or the switch on with its settings incomplete, is "unavailable" (503), never a wrong
 * password. While it is unavailable, a company owner or admin may sign in with the PMC password their account holds,
 * or, once they have joined Redbracket ID, the PMC password of the account their first sign-in replaced
 * (break-glass), so an issuer outage cannot lock the office out; nobody else can.
 *
 * Each sign-in writes one log line: the route, the outcome and the try's id. Never an email, password, token or code.
 */
import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, type OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Prisma as PrismaErrors, type Prisma, type User } from '@prisma/client';
import { IDENTITY_REFUSAL_CODES as CODE, type IdentityRefusalCode } from '@vitan/shared';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../../prisma.service';
import { lockUserCredential } from '../../common/credential-lock';
import { OrgsParticipant, QA_ACCOUNT_EMAIL } from '../../orgs/orgs.participant';
import { RESET_URL_ENV, readIdentityConfig, readResetUrl, resetUrlFor, type IdentityConfig } from './identity-config';
import { IDENTITY_TIMEOUT_MS, IdentityClient, SESSIONS_AWAITED_ROUNDS } from './identity-client';
import type { IdClaims } from './id-token';
import { SignInAttempts, type AttemptKind } from './sign-in-attempts';
import { breakGlassHash, linkInvite, linkOf, lockIssuerPerson, neverSetUp, settleSignIn, type Settled } from './identity-accounts';

export const UNAVAILABLE = 'Sign-in is unavailable just now. Try again in a few minutes.';
export const WRONG_PASSWORD = 'Invalid email or password';
export const NO_PROJECT = 'You are signed in, but you are not on any PMC project yet. Ask your PMC to add you.';
export const INVITE_PENDING = 'Your invitation is waiting. Use "Set or reset password" with the code we email you to accept it.';
export const TEST_ACCOUNT = 'Test accounts sign in through the operator door.';
export const EMAIL_UNVERIFIED = 'Your email is not confirmed yet. Use "Set or reset password" to confirm it.';
export const ISSUER_ACCOUNT_EXISTS = 'This email already has a Redbracket ID. Enter that password here to join with it.';
export const NEEDS_HELP = 'This email cannot be set up here. Ask your PMC for help.';
export const PASSWORD_CHANGED = 'Your password was just changed. Sign in with the new one.';
const TOO_MANY = 'Too many attempts. Try again in a few minutes.';
export const PASSWORD_REJECTED = 'Redbracket ID did not accept this password. Choose another one.';

/**
 * Redbracket ID A5: a refusal carries a machine `code` beside its unchanged status and English message (the A4a
 * `SETUP_RUNNING_CODE` shape), so the web words it in the person's language instead of reading every 401 as a wrong
 * password. Each message has exactly one code (`CODE_OF`), so a site cannot pair a message with another's code.
 */
const CODE_OF: ReadonlyMap<string, IdentityRefusalCode> = new Map([
  [NO_PROJECT, CODE.noProject],
  [INVITE_PENDING, CODE.invitePending],
  [TEST_ACCOUNT, CODE.testAccount],
  [EMAIL_UNVERIFIED, CODE.emailUnverified],
  [PASSWORD_CHANGED, CODE.passwordChanged],
  [NEEDS_HELP, CODE.needsHelp],
  [ISSUER_ACCOUNT_EXISTS, CODE.issuerAccountExists],
  [PASSWORD_REJECTED, CODE.passwordRejected],
]);

function coded(statusCode: number, message: string): { statusCode: number; message: string; code: IdentityRefusalCode } {
  const code = CODE_OF.get(message);
  if (!code) throw new Error(`identity refusal without a code: ${message}`);
  return { statusCode, message, code };
}
export const refusedSignIn = (message: string) => new UnauthorizedException(coded(401, message));
/**
 * `resetUrl` (unit H): sent only with the issuer-account-exists refusal, Redbracket ID's own reset page for the email, when
 * `IDENTITY_RESET_URL` is set and well formed (`resetUrlFor`). That refusal comes only after PMC's emailed code was
 * proved and spent, so the link tells nobody who has not proved the mailbox that a Redbracket ID exists.
 */
export const refusedSetup = (message: string, resetUrl: string | null = null) =>
  new BadRequestException(resetUrl ? { ...coded(400, message), resetUrl } : coded(400, message));
const refusedConflict = (message: string) => new ConflictException(coded(409, message));
/** The bcrypt cost new PMC passwords use (password-credentials.service.ts); every break-glass try does this much work. */
const EVEN_COST = 12;
/** bcrypt hashes of random values nobody holds, one per cost: compared to make every break-glass try cost the same. */
const DUMMY_HASHES: Record<number, string> = {
  4: '$2b$04$bcdJsaA5i0JvmSP2rlOoOe.gy3s/PLdMQpsoibzMfv2QrMy8MtmBy',
  5: '$2b$05$cgMaxtnOsO1xHwkRS1gBDuk0B.51q2eAeMDExfgQt0oh.xaYGFlf2',
  6: '$2b$06$yKiOrC3R3jDxf.o03IlzluM2qtMnhPZrVyidgvWnEGIyFrp0WG/.i',
  7: '$2b$07$BGx3Dz7LwRycENx9oxr5G.WmiVrard9ml.3qLfdk0zNdP5Jv6CkaC',
  8: '$2b$08$KbM7m5FqdvEwNIVdyW/B8uJlRM2Q.MyDz44pWeik49HDVA9tTzxkW',
  9: '$2b$09$mQHF5CvfH39wPHHGTFYdFO1DOg/8UEN3acDBr.Wiocv0qPC99rzqO',
  10: '$2b$10$edJKtON4dLjKtCfQo0RVquD0W8YERZenkgPCuVgaBurK56JcmvFtS',
  11: '$2b$11$oce4JZn2qgCbQ1ZUcaDWk.zxUdPVfH1I.DSTVL2dDNOKPXh0yNt6C',
  12: '$2b$12$J2vHlAmNHuv2YPnp0gUFkOV/9l1q9pK3sQIYMOO0nyq0bngT27Q.G',
};

/**
 * The costs of the dummy compares that pad a compare against a hash of `cost` up to the work of one cost-12 compare
 * (bcrypt's work is 2^cost rounds, and 2^12 - 2^c = 2^c + 2^(c+1) + ... + 2^11). A legacy cost-10 password
 * (ensure-accounts.ts) then takes as long as a cost-12 one or no account at all. Above 12 nothing is added.
 */
export function paddingCosts(cost: number): number[] {
  const pad: number[] = [];
  for (let c = Math.max(cost, 4); c < EVEN_COST; c += 1) pad.push(c);
  return pad;
}

/** A whole bcrypt hash: version, two-digit cost, 53 characters of salt and digest. */
const BCRYPT_HASH = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

/**
 * Compares `password` with `hash` (or with nothing, when there is none) at the same total bcrypt work every time.
 * Only a whole hash of cost 4 to 12 (PMC writes 12; ensure-accounts.ts and the seed write 10) is compared; anything
 * else (malformed, cut short, cost above 12) costs one cost-12 dummy compare and never matches.
 */
async function compareEvenly(password: string, hash: string | null): Promise<boolean> {
  const cost = Number(hash?.match(BCRYPT_HASH)?.[1] ?? Number.NaN);
  if (!hash || DUMMY_HASHES[cost] === undefined) {
    await bcrypt.compare(password, DUMMY_HASHES[EVEN_COST]!);
    return false;
  }
  const matches = await bcrypt.compare(password, hash);
  for (const c of paddingCosts(cost)) await bcrypt.compare(password, DUMMY_HASHES[c]!);
  return matches;
}

/** The account a session is issued for (the fields `AuthService.signInUser` reads). */
export type SignInAccount = Pick<User, 'id' | 'projectId' | 'role' | 'name' | 'credentialVersion' | 'lastProjectId'>;
/** What a route does next: issue PMC's session for `account`; `fresh` when it was made by this sign-in. */
export type IdentityOutcome = { account: SignInAccount; fresh: boolean; breakGlass?: BreakGlass };
/** A break-glass password matched; `settle` writes the try's one log line once the session is issued or refused. */
export type BreakGlass = { settle: (decision: string) => void };

@Injectable()
export class IdentitySignInService implements OnModuleInit {
  private readonly log = new Logger(IdentitySignInService.name);
  private readonly orgs = new OrgsParticipant();
  private readonly attempts: SignInAttempts;
  private client: { config: IdentityConfig; client: IdentityClient } | null = null;
  /**
   * The monotonic clock a reset's session sweep keeps its deadline by (milliseconds). Only elapsed time is read from
   * it, so it never depends on the wall clock; a test replaces it to move time without waiting.
   */
  sweepClock: () => number = () => performance.now();

  constructor(private readonly prisma: PrismaService) {
    this.attempts = new SignInAttempts(prisma);
  }

  /** At start, a malformed `IDENTITY_RESET_URL` is named (never its value): the refusal then carries no link. */
  onModuleInit(): void {
    if (readResetUrl().state === 'malformed') this.log.warn(`${RESET_URL_ENV} is malformed: the Redbracket ID reset link is not shown`);
  }

  /** One client per settings, so the issuer's keys are fetched once (the settings are read on every call). */
  private clientFor(config: IdentityConfig): IdentityClient {
    const held = this.client;
    if (held && held.config.issuer === config.issuer && held.config.endpoint === config.endpoint && held.config.clientId === config.clientId
      && held.config.redirectUri === config.redirectUri && held.config.serviceToken === config.serviceToken) return held.client;
    const client = new IdentityClient(config);
    this.client = { config, client };
    return client;
  }

  private line(route: string, attempt: string, outcome: string): void {
    this.log.log(`identity ${route} try ${attempt}: ${outcome}`);
  }

  private async counted(kind: AttemptKind, route: string, email: string, address: string): Promise<string> {
    const attempt = await this.attempts.count(kind, email, address);
    if (!attempt.allowed) {
      this.line(route, attempt.id, 'limited');
      throw new HttpException({ statusCode: 429, message: TOO_MANY, retryAfter: attempt.retryAfterSeconds }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return attempt.id;
  }

  /** Email + password sign-in with the switch on. `address` is the caller's address (rate limit only, never stored plain). */
  async login(input: { email: string; password: string }, address: string): Promise<IdentityOutcome> {
    const email = input.email.trim().toLowerCase();
    const attempt = await this.counted('sign-in', 'login', email, address);
    const read = readIdentityConfig();
    if (read.state !== 'on') return this.breakGlass(email, input.password, attempt, 'settings incomplete');
    // the account's credential epoch before the issuer checks the password: a reset that commits while that check is in
    // flight moves it on, and a proof of the password from before the reset must not open a session after it
    const before = await this.orgs.accountByAddress(this.prisma, { email });
    const result = await this.clientFor(read.config).login(email, input.password);
    if (!result.ok && result.failure === 'down') return this.breakGlass(email, input.password, attempt, 'issuer unavailable');
    if (!result.ok) {
      this.line('login', attempt, 'wrong password');
      throw new UnauthorizedException(WRONG_PASSWORD);
    }
    const settled = await this.prisma.$transaction(async (tx): Promise<Settled | { kind: 'stale' } | { kind: 'other-account' } | { kind: 'timed-out' }> => {
      const found = await settleSignIn(tx, read.config.issuer, result.claims);
      // an account this sign-in just made has no earlier credential; any other is judged against the epoch read before
      // the proof, under its credential lock (the lock a reset's `endSessions` takes to move it on), so a reset either
      // committed first (refused here) or ends this session when it commits
      if (found.kind !== 'account' || found.fresh) return found;
      await lockUserCredential(tx, found.user.id);
      const current = await this.orgs.accountById(tx, found.user.id);
      if (!before || !current || before.id !== current.id) return { kind: 'other-account' };
      if (current.credentialVersion !== before.credentialVersion) return { kind: 'stale' };
      return { kind: 'account', user: current, fresh: false };
    }).catch((err: unknown) => {
      // a transaction the server closed (its time ran out waiting on the account's lock, held by a reset) is
      // "unavailable", as the issuer being down is, never a server error (as break-glass, AuthService.breakGlassSession)
      if (err instanceof PrismaErrors.PrismaClientKnownRequestError && err.code === 'P2028') return { kind: 'timed-out' as const };
      throw err;
    });
    if (settled.kind === 'timed-out') {
      this.line('login', attempt, 'transaction timed out');
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
    if (settled.kind === 'stale') {
      this.line('login', attempt, 'password changed during sign-in');
      throw refusedSignIn(PASSWORD_CHANGED);
    }
    if (settled.kind === 'other-account') {
      this.line('login', attempt, 'email names another account');
      throw refusedSignIn(NEEDS_HELP);
    }
    return this.landed('login', attempt, settled);
  }

  private landed(route: string, attempt: string, settled: Settled): IdentityOutcome {
    switch (settled.kind) {
      case 'account':
        this.line(route, attempt, settled.fresh ? 'signed in, new account' : 'signed in');
        return { account: settled.user, fresh: settled.fresh };
      case 'no-account':
        this.line(route, attempt, 'no PMC account');
        throw refusedSignIn(NO_PROJECT);
      case 'invite-pending':
        this.line(route, attempt, 'invitation not accepted');
        throw refusedSignIn(INVITE_PENDING);
      case 'test-account':
        this.line(route, attempt, 'test account refused');
        throw refusedSignIn(TEST_ACCOUNT);
      case 'email-unverified':
        this.line(route, attempt, 'email unverified');
        throw refusedSignIn(EMAIL_UNVERIFIED);
    }
  }

  /**
   * While Redbracket ID is unavailable: a company owner or admin may sign in with the PMC password their account still
   * holds, or, for an account a first Redbracket ID sign-in made, the one the replaced account held (`breakGlassHash`).
   * Anyone else is told sign-in is unavailable (never "wrong password"), whatever they typed. Every try does the same
   * bcrypt work (`compareEvenly`), so the time taken does not tell who is an admin or how old their password is. The
   * standing is read again, authoritatively, under the companies' standing keys when the session is issued
   * (`AuthService.signInIdentity`). Its one log line names why the issuer was not used and what break-glass decided;
   * for a matched password that line is written by `settle`, once the session is issued or refused.
   */
  private async breakGlass(email: string, password: string, attempt: string, why: string): Promise<IdentityOutcome> {
    // a test account never signs in here (the operator door is its way in), as with the issuer up
    const user = QA_ACCOUNT_EMAIL.test(email) ? null : await this.orgs.accountByAddress(this.prisma, { email });
    const hash = user ? await breakGlassHash(this.prisma, user) : null;
    const admin = hash && user ? await this.orgs.administersCompany(this.prisma, user.id) : false;
    const matches = await compareEvenly(password, admin && hash ? hash : null);
    if (user && admin && matches) {
      // the try's one line is written when the session is issued or refused (`AuthService.signInIdentity`)
      return { account: user, fresh: false, breakGlass: { settle: (decision) => this.line('login', attempt, `${why}; ${decision}`) } };
    }
    this.line('login', attempt, why);
    throw new ServiceUnavailableException(UNAVAILABLE);
  }

  /** Whether a password setup or reset request may send a code (the same per-person limit as sign-in). */
  async mayRequestReset(email: string, address: string): Promise<boolean> {
    const attempt = await this.attempts.count('reset', email, address);
    if (!attempt.allowed) this.line('password request', attempt.id, 'limited');
    return attempt.allowed;
  }

  /**
   * The issuer half of a password setup or reset, with the switch on, for an account whose mailbox PMC's own emailed
   * code has just proved. `claim` consumes PMC's code first, in its own transaction, before anything is written at
   * the issuer: a code is spent once, and a refused or failed step after it means asking for a new code. (The code is
   * single-use, so this step is not counted against the per-person limit; its request was.) The password is then set
   * on the issuer person this account is (linked), or a new issuer person is made with it; an issuer person who already
   * holds the email and is not this account's is never changed: the person joins with it only by typing its
   * password. Nothing is written to `User.passwordHash`. Last, in one transaction, the PMC account is settled and
   * `record` writes the security trail for the account it settled on (a new one when an established account joins
   * fresh), saying whether this step set the issuer password. `attempt` names the try in the one log line (the
   * challenge id). `unsettled` is called when the issuer write itself (making the person, or setting the password)
   * got no clear answer, so it may still land: the caller then leaves its claim to the lease rather than freeing the
   * account at once (A4a), or a newer setup could report success and be overwritten by this one landing late.
   * `sweepWindowMs`: how long after the claim the linked person's session sweep may still start a call (unit L); the
   * caller derives it from the completion lease so that nothing the sweep does, nor anything after it, outlives the
   * claim that every release honours (Codex 4472985591 on #1342).
   */
  async setPassword(
    account: { id: string; email: string | null },
    password: string,
    attempt: string,
    claim: () => Promise<void>,
    record: (tx: Prisma.TransactionClient, outcome: IdentityOutcome, issuerPasswordSet: boolean) => Promise<void>,
    unsettled: () => void,
    sweepWindowMs: number,
  ): Promise<IdentityOutcome> {
    const email = (account.email ?? '').trim().toLowerCase();
    if (!email) throw refusedSetup(NEEDS_HELP);
    if (QA_ACCOUNT_EMAIL.test(email)) {
      this.line('password', attempt, 'test account refused');
      throw refusedSetup(TEST_ACCOUNT);
    }
    const read = readIdentityConfig();
    if (read.state !== 'on') {
      this.line('password', attempt, 'settings incomplete');
      throw new ServiceUnavailableException(UNAVAILABLE);
    }
    const { config } = read;
    // read before the claim is taken, so the sweep's deadline is never later than the claim's own lease
    const sweepBy = this.sweepClock() + sweepWindowMs;
    await claim();
    const client = this.clientFor(config);
    const link = await linkOf(this.prisma, account.id);
    let issuerPasswordSet = false;
    const found = await client.find(email);
    if (found.found === 'down') return this.unavailable(attempt);
    if (found.found === 'unclear') return this.needsHelp(attempt, 'issuer lookup unclear');

    // once the sessions were ended, a step that fails after it ends them again: a session the new password opened in
    // between (the issuer may already hold it) does not outlive a setup PMC reports as failed
    let ended = false;
    let outcome: IdentityOutcome;
    try {
      outcome = await (async () => {
        if (found.found === 'none') {
          if (link) return this.needsHelp(attempt, 'linked person missing at issuer');
          await this.endSessions(account.id);
          ended = true;
          const made = await client.create({ email, password, verified: true });
          if (!made.ok && made.taken) return this.needsHelp(attempt, 'issuer person made meanwhile');
          if (!made.ok && made.failure === 'down') {
            // the write may still land at the issuer (a timeout, a 5xx, a malformed answer): see `unsettled`
            unsettled();
            return this.unavailable(attempt);
          }
          if (!made.ok) return this.needsHelp(attempt, 'issuer refused new person');
          issuerPasswordSet = true;
        } else if (link) {
          if (link.issuer !== config.issuer || link.subject !== found.userId) return this.needsHelp(attempt, 'link names another person');
          if (!found.verified) {
            // the issuer must hold the email as verified before PMC reports the setup done (PMC's code proved the mailbox);
            // asked before the password is written, so a refusal leaves the person's issuer password as it was
            const marked = await client.markVerified(found.userId, email);
            if (marked === 'down') return this.unavailable(attempt);
            if (marked !== null) return this.needsHelp(attempt, 'issuer refused to mark the email verified');
          }
          await this.endSessions(account.id);
          ended = true;
          const set = await client.setPassword(found.userId, password);
          if (set === 'down') {
            // the write may still land at the issuer (a timeout, a 5xx): see `unsettled`
            unsettled();
            // and if it landed, the old password's issuer sessions must not outlive it (unit L, R3-1)
            await this.endIssuerSessions(client, account.id, found.userId, attempt, sweepBy);
            return this.unavailable(attempt);
          }
          if (set === 'rejected') {
            this.line('password', attempt, 'issuer refused password');
            throw refusedSetup(PASSWORD_REJECTED);
          }
          issuerPasswordSet = true;
          // unit L: whoever is signed in to Redbracket ID with the old password (rb, Hub, the console) is signed out
          // before the setup answers
          await this.endIssuerSessions(client, account.id, found.userId, attempt, sweepBy);
        }
        // an existing issuer person who is not linked is left exactly as they are: the typed password must already be theirs

        const signedIn = await client.login(email, password);
        if (!signedIn.ok && signedIn.failure === 'down') return this.unavailable(attempt);
        if (!signedIn.ok) {
          this.line('password', attempt, found.found === 'one' && !link ? 'issuer person exists' : 'issuer refused new password');
          // an email that already has a Redbracket ID whose password this is not: PMC writes nothing to that person, and
          // the person is pointed at Redbracket ID's own reset (unit H), then signs in here with that password
          const exists = found.found === 'one' && !link;
          throw refusedSetup(exists ? ISSUER_ACCOUNT_EXISTS : NEEDS_HELP, exists ? resetUrlFor(email) : null);
        }
        const claims = signedIn.claims;
        return await this.prisma.$transaction(async (tx) => {
          // the person's lock, then the account's credential lock: the order every Redbracket ID writer takes them in
          await lockIssuerPerson(tx, config.issuer, claims.sub);
          await lockUserCredential(tx, account.id);
          const settled = await this.settlePassword(tx, config.issuer, account.id, email, claims, attempt);
          await record(tx, settled, issuerPasswordSet);
          return settled;
        });
      })();
    } catch (err) {
      if (ended) await this.endSessions(account.id).catch(() => this.line('password', attempt, 'sessions not ended again after a failed step'));
      throw err;
    }
    this.line('password', attempt, outcome.fresh ? 'set, new account' : 'set');
    return outcome;
  }

  /**
   * Ends every PMC session the account holds, committed on its own before the issuer password is written or a person is
   * made with it. A reset is how a person shuts out whoever knew the old password, so its revocation must not depend on
   * what follows: an issuer that goes down after taking the password, or a later transaction that fails, still leaves
   * the old sessions ended (and the person signs in again with the new password).
   */
  private async endSessions(accountId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockUserCredential(tx, accountId);
      await tx.user.update({ where: { id: accountId }, data: { credentialVersion: { increment: 1 } } });
    });
  }

  /** The PMC account a password setup lands on, under both locks (see `setPassword`). */
  private async settlePassword(
    tx: Prisma.TransactionClient,
    issuer: string,
    accountId: string,
    email: string,
    claims: IdClaims,
    attempt: string,
  ): Promise<IdentityOutcome> {
    const current = await this.orgs.accountById(tx, accountId);
    if (!current || (current.email ?? '').toLowerCase() !== email) throw refusedSetup(NEEDS_HELP);
    const linked = await linkOf(tx, current.id);
    if (linked) {
      if (linked.issuer !== issuer || linked.subject !== claims.sub) throw refusedSetup(NEEDS_HELP);
      const user = await tx.user.update({ where: { id: current.id }, data: { emailVerifiedAt: new Date(), credentialVersion: { increment: 1 } } });
      return { account: user, fresh: false };
    }
    if (neverSetUp(current)) {
      // the invitation's own acceptance: PMC's code proved the mailbox and the issuer took (or already had) the password
      if (!(await linkInvite(tx, issuer, claims.sub, current.id))) throw refusedSetup(NEEDS_HELP);
      const user = await tx.user.update({ where: { id: current.id }, data: { emailVerifiedAt: new Date(), credentialVersion: { increment: 1 } } });
      return { account: user, fresh: false };
    }
    // an account set up before Redbracket ID joins fresh, exactly as a sign-in would (identity-accounts.ts)
    const settled = await settleSignIn(tx, issuer, { ...claims, email, emailVerified: true }, attempt);
    // a fresh join is reported once, by `setPassword` ('set, new account'); only a refusal is logged here (and throws)
    if (settled.kind === 'account') return { account: settled.user, fresh: settled.fresh };
    return this.landed('password', attempt, settled);
  }

  /**
   * Unit L: ends the person's issuer sessions after PMC set (or may have set) their password, awaited and bounded:
   * {@link SESSIONS_AWAITED_ROUNDS} delete rounds and a confirming list, each call under the issuer timeout, and no
   * call started unless it ends, at its full timeout, by `sweepBy` (the deadline `setPassword` took from the claim).
   * A sweep whose deadline has already passed sends nothing and is recorded as `capped`. Anything but `ended` writes `auth.password_reset_unfinished` on the account (the
   * issuer person and the reason, never a secret), for the operator's action in RUNBOOK §RBL; the setup still answers
   * as it would have, since the password did change and refusing would not help the person. Nothing goes on after the
   * setup answers: a sweep left running past the account's completion claim could delete the issuer session a later
   * completion of the same account opened for its own sign-in (Codex 4470702899 on #1342), so what this bounded sweep
   * could not end is the row's to report, and the operator's to finish. A row that cannot be written is logged, never
   * swallowed silently. Never throws.
   */
  private async endIssuerSessions(client: IdentityClient, accountId: string, personId: string, attempt: string, sweepBy: number): Promise<void> {
    const answer = await client.endPersonSessions(personId, SESSIONS_AWAITED_ROUNDS, () => this.sweepClock() + IDENTITY_TIMEOUT_MS <= sweepBy);
    if (answer === 'ended') return;
    const why = `issuer sessions not ended after the reset (${answer})`;
    this.line('password', attempt, why);
    await this.prisma.securityAuditEvent
      .create({
        data: {
          action: 'auth.password_reset_unfinished',
          targetUserId: accountId,
          actorUserId: accountId,
          actorKind: 'self',
          correlationId: attempt,
          payload: { issuerPerson: personId, reason: why },
        },
      })
      .catch(() => this.line('password', attempt, `reset not recorded (${why}; issuer person ${personId})`));
  }

  private unavailable(attempt: string): never {
    this.line('password', attempt, 'issuer unavailable');
    throw new ServiceUnavailableException(UNAVAILABLE);
  }

  private needsHelp(attempt: string, why: string): never {
    this.line('password', attempt, why);
    throw refusedConflict(NEEDS_HELP);
  }
}
