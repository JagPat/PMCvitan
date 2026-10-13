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

const PURPOSE = 'password_setup_or_reset';
const LIFETIME_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
// #806 unit B: besides the held challenge, a code may match one of this many newest live challenges for the user.
const NEWEST_CANDIDATES = 3;
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

  private eligible(user: { memberships: Array<{ status: string }>; orgMemberships: Array<{ role: string }> } | null): boolean {
    if (!user) return false;
    return user.memberships.some((membership) => membership.status === 'active')
      || user.orgMemberships.some((membership) => membership.role === 'owner' || membership.role === 'admin');
  }

  private async userByEmail(db: Db, email: string) {
    return db.user.findUnique({
      where: { email },
      include: {
        memberships: { select: { status: true } },
        orgMemberships: { select: { role: true } },
      },
    });
  }

  private async userById(db: Db, userId: string) {
    return db.user.findUnique({
      where: { id: userId },
      include: {
        memberships: { select: { status: true } },
        orgMemberships: { select: { role: true } },
      },
    });
  }

  async request(input: PasswordCredentialRequestInput): Promise<{ accepted: true; requestId: string }> {
    const email = input.email.trim().toLowerCase();
    const publicRequestId = randomUUID();
    const user = await this.userByEmail(this.prisma, email);
    if (!this.eligible(user)) return this.notSent(publicRequestId);

    const now = new Date();
    const code = String(randomInt(100000, 1000000));
    const created = await this.prisma.$transaction(async (tx) => {
      await lockUserCredential(tx, user!.id);
      const eligible = await this.userById(tx, user!.id);
      if (!this.eligible(eligible) || eligible?.email !== email) return false;
      // #806 unit B: earlier codes stay live until one verifies, so an email that arrives late, or out of order,
      // still carries a working code. `verify` retires them; an invitation-email correction revokes them. An
      // outstanding setup token from an earlier verification is still revoked here, as before.
      await tx.passwordCredentialChallenge.updateMany({
        where: { userId: user!.id, purpose: PURPOSE, consumedAt: null, verifiedAt: { not: null } },
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
    // A failed send keeps its challenge: a timeout is ambiguous and the mail may still arrive (#806 unit B).
    try {
      await this.email.sendPasswordCredentialCode(email, code);
      this.log.log(`Password credential request ${publicRequestId}: code handed to the mail provider`);
    } catch (error) {
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

    // #806 unit B: the code may come from any live challenge of the same user (the held one, or one of the newest
    // few), so a delayed or reordered email still works. Wrong codes count against the held challenge, as before.
    const newest = await this.prisma.passwordCredentialChallenge.findMany({
      where: {
        userId: challenge.userId,
        purpose: PURPOSE,
        consumedAt: null,
        verifiedAt: null,
        expiresAt: { gt: now },
        attempts: { lt: MAX_ATTEMPTS },
        id: { not: challenge.id },
      },
      orderBy: { createdAt: 'desc' },
      take: NEWEST_CANDIDATES,
      select: { id: true, otpHash: true },
    });
    const matched = [challenge, ...newest]
      .filter((candidate) => this.sameHash(candidate.otpHash, this.otpHash(candidate.id, input.code)));
    if (matched.length === 0) {
      // One shared budget: a wrong guess counts against every live code of the user, because any of them could have
      // matched it (#820 Codex 4255840353). Otherwise each fresh requestId would bring five more guesses at the same
      // codes. Increments are atomic, so concurrent guesses all count, and the lock follows the stored counts.
      const live = { userId: challenge.userId, purpose: PURPOSE, consumedAt: null, verifiedAt: null };
      await this.prisma.passwordCredentialChallenge.updateMany({
        where: live,
        data: { attempts: { increment: 1 } },
      });
      await this.prisma.passwordCredentialChallenge.updateMany({
        where: { ...live, attempts: { gte: MAX_ATTEMPTS } },
        data: { consumedAt: now },
      });
      throw this.genericError();
    }

    const setupToken = randomBytes(32).toString('base64url');
    const [match] = matched;
    // Under the credential lock, so an invitation-email correction that revokes these challenges cannot interleave.
    // Each step is a conditional write on the full live predicate, so a row that a concurrent wrong guess has just
    // pushed to the attempt limit is never accepted (4255840331); any failed step rolls the whole verification back.
    await this.prisma.$transaction(async (tx) => {
      await lockUserCredential(tx, challenge.userId);
      if (match!.id !== challenge.id) {
        const claimed = await tx.passwordCredentialChallenge.updateMany({
          where: {
            id: match!.id,
            consumedAt: null,
            verifiedAt: null,
            expiresAt: { gt: now },
            attempts: { lt: MAX_ATTEMPTS },
          },
          data: { consumedAt: now },
        });
        if (claimed.count !== 1) throw this.genericError();
      }
      const updated = await tx.passwordCredentialChallenge.updateMany({
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
      await tx.passwordCredentialChallenge.updateMany({
        where: { userId: challenge.userId, purpose: PURPOSE, consumedAt: null, id: { not: challenge.id } },
        data: { consumedAt: now },
      });
    });
    return { setupToken, expiresInSeconds: 600 };
  }

  async complete(input: PasswordCredentialCompleteInput): Promise<CredentialUser> {
    if (input.password.length < 12 || input.password.length > 128) throw this.genericError();
    const setupTokenHash = this.tokenHash(input.setupToken);
    const challenge = await this.prisma.passwordCredentialChallenge.findUnique({
      where: { setupTokenHash },
      include: { user: true },
    });
    const now = new Date();
    if (!challenge || challenge.purpose !== PURPOSE || challenge.consumedAt || !challenge.verifiedAt || !challenge.setupTokenExpiresAt || challenge.setupTokenExpiresAt <= now) {
      throw this.genericError();
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    return this.prisma.$transaction(async (tx) => {
      await lockUserCredential(tx, challenge.userId);
      const claimed = await tx.passwordCredentialChallenge.updateMany({
        where: {
          id: challenge.id,
          consumedAt: null,
          verifiedAt: { not: null },
          setupTokenHash,
          setupTokenExpiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) throw this.genericError();

      const eligible = await this.userById(tx, challenge.userId);
      if (!this.eligible(eligible)) throw this.genericError();

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
          action: challenge.user.passwordHash ? 'auth.password_reset' : 'auth.password_enrolled',
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
