import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import type { Prisma } from '@prisma/client';
import { resolveJwtSecret } from '../config';
import type {
  PasswordCredentialCompleteInput,
  PasswordCredentialRequestInput,
  PasswordCredentialVerifyInput,
} from '../contracts';
import { PrismaService } from '../prisma.service';
import { lockUserCredential } from '../common/credential-lock';
import { EmailService } from '../platform/email.service';
import { OrgsParticipant } from '../orgs/orgs.participant';
import type { IdentityOutcome, IdentitySignInService } from './identity/identity-sign-in.service';
import { isRetired } from './identity/identity-accounts';

const PURPOSE = 'password_setup_or_reset';
const LIFETIME_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const BCRYPT_COST = 12;
const GENERIC_ERROR = 'Password setup code or link is invalid or expired.';

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
  /** The answer for a request turned away by the Redbracket ID per-person limit: the same as any unsent request. */
  unsent(): { accepted: true; requestId: string } {
    return this.notSent(randomUUID());
  }

  private notSent(publicRequestId: string): { accepted: true; requestId: string } {
    this.log.log(`Password credential request ${publicRequestId}: no eligible account; nothing sent`);
    return { accepted: true, requestId: publicRequestId };
  }

  async verify(input: PasswordCredentialVerifyInput): Promise<{ setupToken: string; expiresInSeconds: 600 }> {
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

    const setupToken = randomBytes(32).toString('base64url');
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
    return { setupToken, expiresInSeconds: 600 };
  }

  /** The verified, unspent challenge a setup token names, or the generic refusal. */
  private async openChallenge(input: PasswordCredentialCompleteInput, now: Date) {
    if (input.password.length < 12 || input.password.length > 128) throw this.genericError();
    const setupTokenHash = this.tokenHash(input.setupToken);
    const challenge = await this.prisma.passwordCredentialChallenge.findUnique({
      where: { setupTokenHash },
    });
    if (!challenge || challenge.purpose !== PURPOSE || challenge.consumedAt || !challenge.verifiedAt || !challenge.setupTokenExpiresAt || challenge.setupTokenExpiresAt <= now) {
      throw this.genericError();
    }
    return { challenge, setupTokenHash };
  }

  /** Consumes the challenge once (a second use is refused) and re-reads that its account may hold a credential. */
  private async claimChallenge(tx: Prisma.TransactionClient, challengeId: string, userId: string, setupTokenHash: string, now: Date) {
    const claimed = await tx.passwordCredentialChallenge.updateMany({
      where: {
        id: challengeId,
        consumedAt: null,
        verifiedAt: { not: null },
        setupTokenHash,
        setupTokenExpiresAt: { gt: now },
      },
      data: { consumedAt: now },
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
    const { challenge, setupTokenHash } = await this.openChallenge(input, now);
    const account = await this.userById(this.prisma, challenge.userId);
    if (!account?.eligible) throw this.genericError();
    let established = false;
    return identity.setPassword(
      account,
      input.password,
      challenge.id,
      // spent before the issuer is touched: a second use of this code is refused, whatever the issuer does next
      async () => {
        const eligible = await this.prisma.$transaction(async (tx) => {
          await lockUserCredential(tx, challenge.userId);
          return this.claimChallenge(tx, challenge.id, challenge.userId, setupTokenHash, now);
        });
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
    );
  }

  async complete(input: PasswordCredentialCompleteInput): Promise<CredentialUser> {
    const now = new Date();
    const { challenge, setupTokenHash } = await this.openChallenge(input, now);

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    return this.prisma.$transaction(async (tx) => {
      await lockUserCredential(tx, challenge.userId);
      const eligible = await this.claimChallenge(tx, challenge.id, challenge.userId, setupTokenHash, now);

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
    });
  }
}
