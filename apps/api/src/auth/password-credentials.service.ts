import { BadRequestException, ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { SETUP_RUNNING_CODE } from '@vitan/shared';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { Prisma as PrismaErrors, type Prisma } from '@prisma/client';
import { resolveJwtSecret } from '../config';
import type {
  PasswordCredentialCompleteInput,
  PasswordCredentialRequestInput,
  PasswordCredentialVerifyInput,
} from '../contracts';
import { PrismaService } from '../prisma.service';
import { CredentialClockUnreadable, credentialClock, lockUserCredential, PASSWORD_SETUP_PURPOSE } from '../common/credential-lock';
import { EmailService } from '../platform/email.service';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { UNAVAILABLE, type IdentityOutcome, type IdentitySignInService } from './identity/identity-sign-in.service';
import { isRetired } from './identity/identity-accounts';
import { IDENTITY_TIMEOUT_MS } from './identity/identity-client';

const PURPOSE = PASSWORD_SETUP_PURPOSE;
const LIFETIME_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const BCRYPT_COST = 12;
const GENERIC_ERROR = 'Password setup code or link is invalid or expired.';
/**
 * Redbracket ID A4a: the issuer calls one password completion can make after its claim, none retried: the lookup,
 * marking the email verified, setting the password or making the person (one of the two), and the sign-in that proves
 * it (authorize, session, auth request, token, signing keys, and ending the issuer session, which is not awaited, so
 * counting it over-counts). `completion-lease.test.ts` counts the client's `send` calls so this cannot fall behind them.
 */
export const COMPLETION_ISSUER_CALLS = 9;
/** The transactions after the claim (sessions ended before the issuer write and again on a failure; the settle). */
export const COMPLETION_TRANSACTIONS = 3;
/** Prisma's default bounds for one transaction: 2 s to start and 5 s to run. */
export const PRISMA_TRANSACTION_BOUND_MS = 2_000 + 5_000;
/**
 * How long a claimed completion holds its account against another one. What it must outlast is the window from the
 * claim to the completion's last issuer WRITE (making the person or setting the password; nothing after it writes at
 * the issuer). That window is bounded as follows. Every issuer call before the write stops at its own timeout. A
 * transaction's lock wait is not bounded by Prisma's 5 s, but a wait that outlasts it fails the transaction (P2028,
 * answered 503) before the write is sent, so it can delay a completion only into a failure, never into a late write.
 * Root-client reads wait on the pool outside any transaction, and the 30 s margin absorbs that. At worst the window is
 * about 30 s. The lease adds every call and transaction the whole completion can make, so it is 87 s today, and it
 * is derived: a longer issuer timeout lengthens it. A completion whose process stopped frees the account when its
 * lease runs out. So does one whose issuer write got no clear answer (`unsettled`), which keeps its claim instead of
 * clearing it. A process paused for longer than the lease between claim and write is the residual (PR body).
 */
export const COMPLETION_LEASE_MS =
  COMPLETION_ISSUER_CALLS * IDENTITY_TIMEOUT_MS + COMPLETION_TRANSACTIONS * PRISMA_TRANSACTION_BOUND_MS + 30_000;
/** A setup token's scope prefix: the one Redbracket ID password, or PMC's own (base64url never holds a dot). */
const SCOPE_SHARED = 'rb.';
const SCOPE_PMC = 'pmc.';
/** The scope a setup token was issued for; one with no prefix predates scopes and was shown PMC-only wording. */
export function tokenScope(token: string): 'shared' | 'pmc' | 'other' {
  if (token.startsWith(SCOPE_SHARED)) return 'shared';
  if (token.startsWith(SCOPE_PMC) || !token.includes('.')) return 'pmc';
  return 'other';
}
export const SETUP_RUNNING = 'Another password setup for this account is still finishing. Try again in a minute.';

/** A transaction the server closed (P2028: its time ran out, e.g. waiting on the account's lock) as the 503 it is. */
function unavailableOnTimeout(err: unknown): unknown {
  // a transaction the server closed (P2028) and an unreadable claim clock are both transient: answered 503, code unspent
  if (err instanceof CredentialClockUnreadable) return new ServiceUnavailableException(UNAVAILABLE);
  return err instanceof PrismaErrors.PrismaClientKnownRequestError && err.code === 'P2028' ? new ServiceUnavailableException(UNAVAILABLE) : err;
}

type Db = PrismaService | Prisma.TransactionClient;

export interface CredentialUser {
  id: string;
  projectId: string;
  role: string;
  name: string;
  email: string | null;
  phone: string | null;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  credentialVersion: number;
}

@Injectable()
export class PasswordCredentialsService {
  private readonly log = new Logger(PasswordCredentialsService.name);
  private readonly hmacSecret = resolveJwtSecret();
  private readonly orgs = new OrgsParticipant();

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  private genericError(): BadRequestException {
    return new BadRequestException(GENERIC_ERROR);
  }

  private otpHash(challengeId: string, code: string): string {
    return createHmac('sha256', this.hmacSecret).update(`${challengeId}:${code}`).digest('hex');
  }

  private tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private sameHash(left: string, right: string): boolean {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The account a credential is for, with whether it may hold one: the orgs module's rule, read through its
   *  participant with the rows it owns (an active project membership, or owner/admin of a company), and never an
   *  account a first Redbracket ID sign-in set aside (`isRetired`, the one predicate; Redbracket ID A3): no code is
   *  sent for it, and a code sent before it was set aside is refused before anything is written, here or at the issuer. */
  private async userByEmail(db: Db, email: string) {
    return this.withRetirement(db, await this.orgs.credentialAccount(db, { email }));
  }

  private async userById(db: Db, userId: string) {
    return this.withRetirement(db, await this.orgs.credentialAccount(db, { id: userId }));
  }

  private async withRetirement<T extends { id: string; eligible: boolean }>(db: Db, account: T | null): Promise<T | null> {
    if (!account?.eligible) return account;
    return (await isRetired(db, account.id)) ? { ...account, eligible: false } : account;
  }

  async request(input: PasswordCredentialRequestInput): Promise<{ accepted: true; requestId: string }> {
    const email = input.email.trim().toLowerCase();
    const publicRequestId = randomUUID();
    const user = await this.userByEmail(this.prisma, email);
    if (!user?.eligible) return this.notSent(publicRequestId);

    const now = new Date();
    const code = String(randomInt(100000, 1000000));
    const created = await this.prisma.$transaction(async (tx) => {
      await lockUserCredential(tx, user!.id);
      const eligible = await this.userById(tx, user!.id);
      if (!eligible?.eligible || eligible.email !== email) return false;
      await tx.passwordCredentialChallenge.updateMany({
        where: { userId: user!.id, purpose: PURPOSE, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.passwordCredentialChallenge.create({
        data: {
          id: publicRequestId,
          userId: user!.id,
          purpose: PURPOSE,
          otpHash: this.otpHash(publicRequestId, code),
          attempts: 0,
          expiresAt: new Date(now.getTime() + LIFETIME_MS),
          verifiedAt: null,
          setupTokenHash: null,
          setupTokenExpiresAt: null,
          consumedAt: null,
          createdAt: now,
        },
      });
      await tx.securityAuditEvent.create({
        data: {
          action: 'auth.password_requested',
          targetUserId: user!.id,
          actorUserId: user!.id,
          actorKind: 'self',
          correlationId: publicRequestId,
        },
      });
      return true;
    });
    if (!created) return this.notSent(publicRequestId);

    // #806 — the send is bounded by the mail transport's own timeouts (EmailService), not nodemailer's
    // minute-long defaults that held the owner's "Send verification code" on "Sending…" (#482, 12 Oct 2026).
    try {
      await this.email.sendPasswordCredentialCode(email, code);
      this.log.log(`Password credential request ${publicRequestId}: code handed to the mail provider`);
    } catch (error) {
      // #806 unit B1: a failed send keeps its challenge. A timeout is ambiguous, and the provider may already have
      // taken the mail, so the code that arrives must still work. It expires as usual, and a new request retires it.
      this.log.error(`Password credential delivery failed for challenge ${publicRequestId}: ${(error as Error).constructor.name}`);
    }
    return { accepted: true, requestId: publicRequestId };
  }

  /**
   * The public answer for a request that sends nothing (no account, or no active project membership and no org
   * owner/admin role). It is identical to a sent one, so the endpoint cannot enumerate accounts — which also made
   * it impossible to tell from outside why a code "did not arrive" (#482, 12 Oct 2026). The server log says so,
   * keyed by the public requestId the caller holds and never by the email address.
   */
  /**
   * The answer for a request turned away by the Redbracket ID per-person limit: the same as any unsent request. Its one
   * log line is the limit's own ('identity password request try N: limited'), so nothing is logged here.
   */
  unsent(): { accepted: true; requestId: string } {
    return { accepted: true, requestId: randomUUID() };
  }

  private notSent(publicRequestId: string): { accepted: true; requestId: string } {
    this.log.log(`Password credential request ${publicRequestId}: no eligible account; nothing sent`);
    return { accepted: true, requestId: publicRequestId };
  }

  /**
   * `sharedPassword` is the switch as read once for this request (the caller's): it is both what the screen is told and
   * what the setup token is bound to (its scope prefix, covered by the token's hash), so the completion refuses a token
   * whose scope is not the switch it runs under (`openChallenge`). The screen can then never promise one password and
   * the completion write another, even when the switch changes, or a pod with the other value answers, inside the
   * token's ten minutes (Codex 4464315045 on #1336).
   */
  async verify(
    input: PasswordCredentialVerifyInput,
    sharedPassword: boolean,
  ): Promise<{ setupToken: string; expiresInSeconds: 600; sharedPassword: boolean }> {
    const challenge = await this.prisma.passwordCredentialChallenge.findUnique({ where: { id: input.requestId } });
    const now = new Date();
    if (!challenge || challenge.purpose !== PURPOSE || challenge.consumedAt || challenge.verifiedAt || challenge.expiresAt <= now || challenge.attempts >= MAX_ATTEMPTS) {
      throw this.genericError();
    }

    const suppliedHash = this.otpHash(challenge.id, input.code);
    if (!this.sameHash(challenge.otpHash, suppliedHash)) {
      const locked = challenge.attempts + 1 >= MAX_ATTEMPTS;
      await this.prisma.passwordCredentialChallenge.updateMany({
        where: { id: challenge.id, attempts: challenge.attempts, consumedAt: null, verifiedAt: null },
        data: { attempts: { increment: 1 }, ...(locked ? { consumedAt: now } : {}) },
      });
      throw this.genericError();
    }

    const setupToken = `${sharedPassword ? SCOPE_SHARED : SCOPE_PMC}${randomBytes(32).toString('base64url')}`;
    const updated = await this.prisma.passwordCredentialChallenge.updateMany({
      where: {
        id: challenge.id,
        attempts: challenge.attempts,
        consumedAt: null,
        verifiedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        verifiedAt: now,
        setupTokenHash: this.tokenHash(setupToken),
        setupTokenExpiresAt: new Date(now.getTime() + LIFETIME_MS),
      },
    });
    if (updated.count !== 1) throw this.genericError();
    return { setupToken, expiresInSeconds: 600, sharedPassword };
  }

  /**
   * The verified, unspent challenge a setup token names, or the generic refusal. `shared`: whether this completion sets
   * the one Redbracket ID password (switch on) or PMC's own; a token bound to the other scope is refused before anything
   * is read or spent, so the person asks for a new code and is told the truth on the next screen. A token without a
   * scope (issued before this release) was shown today's PMC-only wording: it is taken only for a PMC-only completion.
   */
  private async openChallenge(input: PasswordCredentialCompleteInput, now: Date, shared: boolean) {
    if (input.password.length < 12 || input.password.length > 128) throw this.genericError();
    if (tokenScope(input.setupToken) !== (shared ? 'shared' : 'pmc')) throw this.genericError();
    const setupTokenHash = this.tokenHash(input.setupToken);
    const challenge = await this.prisma.passwordCredentialChallenge.findUnique({
      where: { setupTokenHash },
    });
    if (!challenge || challenge.purpose !== PURPOSE || challenge.consumedAt || !challenge.verifiedAt || !challenge.setupTokenExpiresAt || challenge.setupTokenExpiresAt <= now) {
      throw this.genericError();
    }
    return { challenge, setupTokenHash };
  }

  /**
   * Consumes the challenge once (a second use is refused) and re-reads that its account may hold a credential. A
   * completion's claim clears the token's expiry, which a revocation never does: the row then stays as the durable mark
   * that the address was proven by a setup, so an invitation-email correction (OrgsService.correctInvitationEmail) is
   * refused from that moment, even while the issuer steps that follow are still running or after they failed.
   *
   * A claimed row whose setup token hash is still set is a completion still running (A4a): it holds the account, and
   * another code for the same account is refused here, under the account's credential lock, until that completion
   * clears its hash on ending (`settleCompletion`) or its lease runs out. So two completions never write passwords at
   * the issuer at once, and an older one cannot overwrite the password a newer one reported set.
   *
   * The lease starts when the claim is taken: the time is read from the database clock here, after the credential lock
   * (`clock_timestamp()`, not the transaction's start, which can predate a long lock wait), and that one value is both
   * the cutoff for a running claim and the new claim's `consumedAt`. A completion that waited or paused before its claim
   * therefore never commits a lease that is already over (Codex 4450806612).
   */
  private async claimChallenge(tx: Prisma.TransactionClient, challengeId: string, userId: string, setupTokenHash: string) {
    const now = await credentialClock(tx);
    const running = await tx.passwordCredentialChallenge.findFirst({
      where: {
        userId,
        purpose: PURPOSE,
        verifiedAt: { not: null },
        consumedAt: { gt: new Date(now.getTime() - COMPLETION_LEASE_MS) },
        setupTokenExpiresAt: null,
        setupTokenHash: { not: null },
      },
      select: { id: true },
    });
    if (running) throw new ConflictException({ statusCode: 409, message: SETUP_RUNNING, code: SETUP_RUNNING_CODE });
    const claimed = await tx.passwordCredentialChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        verifiedAt: { not: null },
        setupTokenHash,
        setupTokenExpiresAt: { gt: now },
      },
      data: { consumedAt: now, setupTokenExpiresAt: null },
    });
    if (claimed.count !== 1) throw this.genericError();
    const eligible = await this.userById(tx, userId);
    if (!eligible?.eligible) throw this.genericError();
    return eligible;
  }

  /**
   * Redbracket ID A3, switch on: the password is set at the issuer, never in `User.passwordHash`
   * (IdentitySignInService.setPassword); PMC's own emailed code is still what proves the mailbox.
   */
  async completeThroughIssuer(input: PasswordCredentialCompleteInput, identity: IdentitySignInService): Promise<IdentityOutcome> {
    const now = new Date();
    const { challenge, setupTokenHash } = await this.openChallenge(input, now, true);
    const account = await this.userById(this.prisma, challenge.userId);
    if (!account?.eligible) throw this.genericError();
    let established = false;
    let claimed = false;
    let unsettled = false;
    try {
      return await identity.setPassword(
        account,
        input.password,
        challenge.id,
        // spent before the issuer is touched: a second use of this code is refused, whatever the issuer does next
        async () => {
          const eligible = await this.prisma.$transaction(async (tx) => {
            await lockUserCredential(tx, challenge.userId);
            return this.claimChallenge(tx, challenge.id, challenge.userId, setupTokenHash);
          });
          claimed = true;
          established = Boolean(eligible.passwordHash || eligible.emailVerifiedAt);
        },
        // written once the account is known, about that account: when an established account joined fresh, the new
        // account (its retirement is recorded on the old one, identity-accounts.ts); and a step that left an existing
        // issuer password as it was is a join, not a reset or enrolment
        async (tx, outcome, issuerPasswordSet) => {
          const action = !issuerPasswordSet
            ? 'auth.identity_joined'
            : outcome.fresh || !established ? 'auth.password_enrolled' : 'auth.password_reset';
          await tx.securityAuditEvent.create({
            data: {
              action,
              targetUserId: outcome.account.id,
              actorUserId: outcome.account.id,
              actorKind: 'self',
              correlationId: challenge.id,
              ...(outcome.account.id !== challenge.userId ? { payload: { codeSentTo: challenge.userId } } : {}),
            },
          });
        },
        // the issuer write got no clear answer and may still land: this claim keeps the account until its lease runs out
        () => {
          unsettled = true;
        },
      );
    } catch (err) {
      // a transaction the server closed (its time ran out waiting on the account's lock) is "unavailable", never a
      // server error, as the switched-on sign-in answers it (IdentitySignInService.login)
      throw unavailableOnTimeout(err);
    } finally {
      // ended: the account is free for the next completion, unless the issuer write may still land (its lease frees it)
      if (claimed && !unsettled) await this.settleCompletion(challenge.id);
      if (claimed && unsettled) this.log.warn(`Password credential completion ${challenge.id}: issuer write unclear; its lease frees the account`);
    }
  }

  /**
   * Marks a claimed completion as ended (A4a): its setup token hash is cleared, which nothing reads after the claim. A
   * write that fails leaves the row to its lease, which frees the account soon after.
   */
  private async settleCompletion(challengeId: string): Promise<void> {
    await this.prisma.passwordCredentialChallenge
      .updateMany({ where: { id: challengeId }, data: { setupTokenHash: null } })
      .catch(() => this.log.warn(`Password credential completion ${challengeId}: end not recorded; its lease frees the account`));
  }

  async complete(input: PasswordCredentialCompleteInput): Promise<CredentialUser> {
    const now = new Date();
    const { challenge, setupTokenHash } = await this.openChallenge(input, now, false);

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    return this.prisma.$transaction(async (tx) => {
      await lockUserCredential(tx, challenge.userId);
      const eligible = await this.claimChallenge(tx, challenge.id, challenge.userId, setupTokenHash);
      // this completion ends in this same transaction: it never holds the account (A4a)
      await tx.passwordCredentialChallenge.update({ where: { id: challenge.id }, data: { setupTokenHash: null } });

      const user = await tx.user.update({
        where: { id: challenge.userId },
        data: {
          passwordHash,
          emailVerifiedAt: now,
          credentialVersion: { increment: 1 },
        },
      });
      await tx.securityAuditEvent.create({
        data: {
          action: eligible.passwordHash ? 'auth.password_reset' : 'auth.password_enrolled',
          targetUserId: user.id,
          actorUserId: user.id,
          actorKind: 'self',
          correlationId: challenge.id,
        },
      });
      return user;
    }).catch((err: unknown) => {
      throw unavailableOnTimeout(err);
    });
  }
}
