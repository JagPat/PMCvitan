import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { resolveJwtSecret } from '../config';
import { PrismaService } from '../prisma.service';
import { lockUserCredential } from '../common/credential-lock';
import { EmailService } from '../platform/email.service';

/**
 * #827 one-screen sign-in, server unit (replaces #856's in-memory codes). Until SMS is live, a phone sign-in's
 * code is emailed to the account that owns the number, and it is a durable `PasswordCredentialChallenge` row of
 * its own purpose, issued and redeemed under the same per-user credential lock as password setup and invitation
 * email correction.
 *
 * Only an account whose email is ESTABLISHED (a password set, or the address verified) is mailed a code. An
 * administrator can correct an invited address only before it is established (`OrgsService.correctInvitationEmail`
 * refuses after), so a code can never be redeemed for an address that has since been corrected; the lock orders
 * the rest. An account without an established email gets the same public answer and is mailed nothing: its way
 * in is "Sign in with email", which sets up the password and so establishes the email.
 *
 * The code is 4 digits, like an SMS code, so the sign-in screen from before this change (a 4-box pad that submits
 * on the fourth digit) can type it. Five wrong tries burn every live code for the account.
 */
export const PHONE_SIGN_IN_PURPOSE = 'phone_sign_in';
const LIFETIME_MS = 10 * 60_000;
const RESEND_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const RESEND_MESSAGE = 'Please wait a moment before requesting another code.';

type Db = PrismaService | Prisma.TransactionClient;

/** The per-number resend wait, for known and unknown numbers alike (the answer must not tell them apart). An entry
 *  lives only for the wait, and every call drops the lapsed ones, so callers cycling through numbers cannot grow it
 *  past what the route's per-IP limit admits in one wait. */
export class ResendWait {
  private readonly sentAt = new Map<string, number>();

  constructor(private readonly waitMs = RESEND_WAIT_MS) {}

  /** True and recorded when `key` may send now; false inside its wait. */
  claim(key: string, now = Date.now()): boolean {
    for (const [k, at] of this.sentAt) if (now - at >= this.waitMs) this.sentAt.delete(k);
    if (this.sentAt.has(key)) return false;
    this.sentAt.set(key, now);
    return true;
  }

  get size(): number {
    return this.sentAt.size;
  }
}

@Injectable()
export class PhoneSignInService {
  private readonly log = new Logger(PhoneSignInService.name);
  private readonly hmacSecret = resolveJwtSecret();
  readonly resendWait = new ResendWait();

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /** Bound to the challenge AND the address the code was mailed to: if that address is ever not the account's
   *  email at redemption, the code no longer matches. */
  private otpHash(challengeId: string, email: string, code: string): string {
    return createHmac('sha256', this.hmacSecret).update(JSON.stringify([challengeId, email.trim().toLowerCase(), code])).digest('hex');
  }

  private sameHash(left: string, right: string): boolean {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The account a code may be mailed for: stored number exactly `phone`, an email that is established, and
   *  access to something (an active membership, or an org owner/admin role). */
  private async owner(db: Db, phone: string) {
    const user = await db.user.findUnique({
      where: { phone },
      include: {
        memberships: { select: { status: true } },
        orgMemberships: { select: { role: true } },
      },
    });
    if (!user?.email) return null;
    if (!user.passwordHash && !user.emailVerifiedAt) return null;
    const hasAccess = user.memberships.some((m) => m.status === 'active')
      || user.orgMemberships.some((m) => m.role === 'owner' || m.role === 'admin');
    return hasAccess ? { id: user.id, email: user.email } : null;
  }

  /** Mail a code for `phone`. The same (void) answer whether or not anything was sent; 429 inside the wait; 503
   *  when the mail could not be handed over. A code is kept only once its mail has gone, and the codes already
   *  delivered stay valid until it has, so a failed resend never strands the person holding a good code. */
  async request(phone: string): Promise<void> {
    if (!this.resendWait.claim(phone.replace(/\D/g, ''))) {
      throw new HttpException(RESEND_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }
    const owner = await this.owner(this.prisma, phone);
    if (!owner) {
      this.log.log('Phone sign-in request: no account with an established email for this number; nothing sent');
      return;
    }
    const code = String(randomInt(1000, 10000));
    await this.email.sendPhoneSignInCode(owner.email, code);

    const now = new Date();
    const id = randomUUID();
    await this.prisma.$transaction(async (tx) => {
      await lockUserCredential(tx, owner.id);
      // the account may have changed while the mail was out; a code is recorded only for the same account and
      // address it went to
      const current = await this.owner(tx, phone);
      if (current?.id !== owner.id || current.email !== owner.email) return;
      await tx.passwordCredentialChallenge.updateMany({
        where: { userId: owner.id, purpose: PHONE_SIGN_IN_PURPOSE, consumedAt: null },
        data: { consumedAt: now },
      });
      await tx.passwordCredentialChallenge.create({
        data: {
          id,
          userId: owner.id,
          purpose: PHONE_SIGN_IN_PURPOSE,
          otpHash: this.otpHash(id, owner.email, code),
          attempts: 0,
          expiresAt: new Date(now.getTime() + LIFETIME_MS),
          createdAt: now,
        },
      });
    });
  }

  /** Redeem a code: the id of the account it signs in, or null. Runs under the credential lock, re-reading the
   *  account, so it never redeems for an account whose email is no longer the established one it was mailed to. */
  async verify(phone: string, code: string): Promise<string | null> {
    const now = new Date();
    const userId = await this.prisma.$transaction(async (tx) => {
      const before = await this.owner(tx, phone);
      if (!before) return null;
      await lockUserCredential(tx, before.id);
      const owner = await this.owner(tx, phone);
      if (owner?.id !== before.id) return null;
      const live = await tx.passwordCredentialChallenge.findFirst({
        where: { userId: owner.id, purpose: PHONE_SIGN_IN_PURPOSE, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { createdAt: 'desc' },
      });
      if (!live) return null;
      if (!this.sameHash(live.otpHash, this.otpHash(live.id, owner.email, code))) {
        const burnt = live.attempts + 1 >= MAX_ATTEMPTS;
        await tx.passwordCredentialChallenge.update({
          where: { id: live.id },
          data: { attempts: { increment: 1 }, ...(burnt ? { consumedAt: now } : {}) },
        });
        return null;
      }
      await tx.passwordCredentialChallenge.update({ where: { id: live.id }, data: { consumedAt: now, verifiedAt: now } });
      await tx.securityAuditEvent.create({
        data: {
          action: 'auth.phone_sign_in',
          targetUserId: owner.id,
          actorUserId: owner.id,
          actorKind: 'self',
          correlationId: live.id,
        },
      });
      return owner.id;
    });
    return userId;
  }
}
