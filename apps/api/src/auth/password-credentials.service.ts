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
import { EmailService } from './email.service';

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
    if (!this.eligible(user)) return { accepted: true, requestId: publicRequestId };

    const now = new Date();
    const code = String(randomInt(100000, 1000000));
    const created = await this.prisma.$transaction(async (tx) => {
      await lockUserCredential(tx, user!.id);
      const eligible = await this.userById(tx, user!.id);
      if (!this.eligible(eligible) || eligible?.email !== email) return false;
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
    if (!created) return { accepted: true, requestId: publicRequestId };

    try {
      await this.email.sendPasswordCredentialCode(email, code);
    } catch (error) {
      await this.prisma.passwordCredentialChallenge.updateMany({
        where: { id: publicRequestId, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      this.log.error(`Password credential delivery failed for challenge ${publicRequestId}: ${(error as Error).constructor.name}`);
    }
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
