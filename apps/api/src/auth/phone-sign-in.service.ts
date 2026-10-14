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
 * email correction. `AuthService` uses this route only for a sign-in screen that says it can show an emailed code.
 *
 * Only an account whose email is ESTABLISHED (a password set, or the address verified) is mailed a code. An
 * administrator can correct an invited address only before it is established (`OrgsService.correctInvitationEmail`
 * refuses after), so a code can never be redeemed for an address that has since been corrected; the lock orders
 * the rest. An account without an established email gets the same public answer and is mailed nothing: its way
 * in is "Sign in with email", which sets up the password and so establishes the email. Whether the account may
 * sign in at all is never decided here: the caller passes `AuthService`'s own sign-in access rule.
 *
 * The code is 4 digits, like an SMS code. Five wrong tries burn every live code for the account.
 *
 * A code's row is written BEFORE its mail is handed over, so every code that reaches an inbox can be redeemed, and
 * a delivered code is never retired by a later request or another code's redemption: each live code signs in once,
 * until it expires. At most MAX_LIVE codes are live per account, which bounds the guessing odds.
 */
export const PHONE_SIGN_IN_PURPOSE = 'phone_sign_in';
const LIFETIME_MS = 10 * 60_000;
const RESEND_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const MAX_LIVE = 3;
const RESEND_MESSAGE = 'Please wait a moment before requesting another code.';

/** May this account sign in now? `AuthService`'s sign-in access rule, the same one a token is issued under. */
export type SignInEligible = (userId: string) => Promise<boolean>;

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

  /** Give back a claim whose send did not happen, so an immediate retry is not refused. */
  release(key: string): void {
    this.sentAt.delete(key);
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

  /** The account that owns `phone` when its email is established: stored number exactly `phone`, and a password
   *  set or the address verified. Whether it may sign in is the caller's `eligible` rule. */
  private async owner(db: Db, phone: string) {
    const user = await db.user.findUnique({
      where: { phone },
      select: { id: true, email: true, passwordHash: true, emailVerifiedAt: true },
    });
    if (!user?.email) return null;
    if (!user.passwordHash && !user.emailVerifiedAt) return null;
    return { id: user.id, email: user.email };
  }

  /** Mail a code for `phone`. The same (void) answer whether or not anything was sent; 429 inside the wait; 503
   *  when the mail could not be handed over. */
  async request(phone: string, eligible: SignInEligible): Promise<void> {
    const waitKey = phone.replace(/\D/g, '');
    if (!this.resendWait.claim(waitKey)) {
      throw new HttpException(RESEND_MESSAGE, HttpStatus.TOO_MANY_REQUESTS);
    }
    try {
      const owner = await this.owner(this.prisma, phone);
      if (!owner || !(await eligible(owner.id))) {
        this.log.log('Phone sign-in request: no account that can sign in with an established email for this number; nothing sent');
        return;
      }
      const code = String(randomInt(1000, 10000));
      const id = randomUUID();
      // the row first, so the mail never carries a code that cannot be redeemed
      const recorded = await this.prisma.$transaction(async (tx) => {
        await lockUserCredential(tx, owner.id);
        const current = await this.owner(tx, phone);
        if (current?.id !== owner.id || current.email !== owner.email) return false;
        const now = new Date();
        const live = await tx.passwordCredentialChallenge.count({
          where: { userId: owner.id, purpose: PHONE_SIGN_IN_PURPOSE, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_ATTEMPTS } },
        });
        if (live >= MAX_LIVE) return false;
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
        return true;
      });
      if (!recorded) {
        this.log.log('Phone sign-in request: the account changed, or already has its live codes; nothing sent');
        return;
      }
      try {
        await this.email.sendPhoneSignInCode(owner.email, code);
      } catch (err) {
        // never handed over: retire only this row, the codes already delivered keep working
        await this.prisma.passwordCredentialChallenge
          .updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date() } })
          .catch(() => undefined);
        throw err;
      }
    } catch (err) {
      this.resendWait.release(waitKey);
      throw err;
    }
  }

  /** Redeem a code: `none` when the number has no live emailed code (or its account may not sign in now), `wrong`
   *  on a mismatch, else the id of the account it signs in. Runs under the credential lock, re-reading the account
   *  and the clock after taking it, so it never redeems for an account whose email is no longer the established one
   *  it was mailed to, nor a code that expired while it waited. Every live row is checked; a wrong try counts
   *  against every live row; a match spends that one code only. */
  async verify(phone: string, code: string, eligible: SignInEligible): Promise<{ kind: 'none' } | { kind: 'wrong' } | { kind: 'ok'; userId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.owner(tx, phone);
      if (!before) return { kind: 'none' as const };
      await lockUserCredential(tx, before.id);
      const owner = await this.owner(tx, phone);
      if (owner?.id !== before.id) return { kind: 'none' as const };
      const now = new Date();
      const live = await tx.passwordCredentialChallenge.findMany({
        where: { userId: owner.id, purpose: PHONE_SIGN_IN_PURPOSE, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { createdAt: 'desc' },
      });
      if (!live.length || !(await eligible(owner.id))) return { kind: 'none' as const };
      const hit = live.find((row) => this.sameHash(row.otpHash, this.otpHash(row.id, owner.email, code)));
      if (!hit) {
        for (const row of live) {
          const burnt = row.attempts + 1 >= MAX_ATTEMPTS;
          await tx.passwordCredentialChallenge.update({
            where: { id: row.id },
            data: { attempts: { increment: 1 }, ...(burnt ? { consumedAt: now } : {}) },
          });
        }
        return { kind: 'wrong' as const };
      }
      // a code signs in once; the other delivered codes stay good until they expire
      await tx.passwordCredentialChallenge.update({ where: { id: hit.id }, data: { consumedAt: now, verifiedAt: now } });
      await tx.securityAuditEvent.create({
        data: {
          action: 'auth.phone_sign_in',
          targetUserId: owner.id,
          actorUserId: owner.id,
          actorKind: 'self',
          correlationId: hit.id,
        },
      });
      return { kind: 'ok' as const, userId: owner.id };
    });
  }
}
