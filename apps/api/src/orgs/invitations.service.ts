import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { EmailService } from '../platform/email.service';
import { lockUserCredential } from '../common/credential-lock';
import { resolveWebAppUrl } from '../config';

export interface InviteContext {
  /** What they were added to, phrased for a sentence: "the Ambli project", "Vitan Architects". */
  context: string;
  /** The role they now hold there, as the operator chose it. */
  role: string;
  /** The administrator whose write caused this, for the security-audit trail. */
  actorUserId: string | null;
}

/**
 * Phase 7c-auth — the invite notice on an admin's roster write.
 *
 * Adding someone to a project team or to an org's admin roster provisions their identity but
 * establishes NO credential: they set one on first sign-in. With auth invite-only
 * (`AUTH_ALLOW_SIGNUP=false`) that left a silent hole — the account existed, nothing told the
 * person, and the two code senders are both self-service, so an invitee who was never told
 * out-of-band could not discover that they had access at all.
 *
 * Two properties keep this safe to hang off a committed write:
 *
 *   - IT RUNS AFTER COMMIT, NEVER INSIDE THE TRANSACTION. The membership write is serialized
 *     under the project readiness key and guarded by the holder seals; an SMTP round-trip
 *     inside that transaction would hold those locks across external I/O. Callers invoke this
 *     only on the success path, once `$transaction` has returned.
 *   - IT NEVER THROWS. The membership is already durable, so a mail failure must not surface
 *     as a failed add — the caller would be told a write it can see in the database did not
 *     happen. Every failure here — the eligibility read included — is logged and swallowed.
 *
 * A caller passes only the user ID: round-1 Codex F5 — a `User` snapshot read BEFORE the
 * roster transaction can be stale by the time the write commits, so a concurrent password
 * completion could land in between and this would invite an account that has just been
 * claimed. The credential state is therefore re-read HERE, after the roster commit, under the
 * same `lockUserCredential` primitive `PasswordCredentialsService` establishes credentials
 * with, so the two orderings are decided rather than raced.
 */
@Injectable()
export class InvitationsService {
  private readonly log = new Logger('InvitationsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /**
   * Re-read the identity and decide, under the credential lock, whether an invitation is still
   * owed. The lock is released with this short transaction — well before the SMTP round-trip,
   * which must never run while a credential lock is held.
   *
   * "Still owed" means no `passwordHash` and no `emailVerifiedAt`: deliberately the SAME
   * predicate `OrgsService.correctInvitationEmail` refuses on ("this account has already
   * established its sign-in credential"), so an outstanding invitation means one thing in this
   * module and a later role change on an established account is never mistaken for one.
   */
  private async outstandingInvitee(userId: string): Promise<{ name: string; email: string } | null> {
    return this.prisma.$transaction(async (tx) => {
      await lockUserCredential(tx, userId);
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, passwordHash: true, emailVerifiedAt: true },
      });
      if (!user?.email || user.passwordHash || user.emailVerifiedAt) return null;
      return { name: user.name, email: user.email };
    });
  }

  /**
   * Send the invite notice for a roster write that has already committed. Safe to call
   * unconditionally: an identity with no email address, or one that has already established a
   * credential, is skipped silently.
   *
   * Callers must invite only an identity that can actually sign in once it has a credential
   * (round-1 Codex F3) — `AuthService.signInAccess` admits an active project membership or an
   * org owner/admin grant, and nothing else.
   */
  async notify(userId: string, context: InviteContext): Promise<void> {
    try {
      const invitee = await this.outstandingInvitee(userId);
      if (!invitee) return;
      const { live } = await this.email.sendMemberInvite(invitee.email, {
        name: invitee.name,
        context: context.context,
        role: context.role,
        signInUrl: resolveWebAppUrl(),
      });
      if (!live) return;
      // The ordinary security-audit trail this module already writes for
      // `auth.invitation_email_changed` and `auth.password_requested`. `SecurityAuditEvent`
      // carries no append-only seal (round-1 Codex F6), so this row is an operational record
      // of the attempt, NOT tamper-evident proof that a message was delivered.
      await this.prisma.securityAuditEvent.create({
        data: {
          action: 'auth.invitation_sent',
          targetUserId: userId,
          actorUserId: context.actorUserId,
          actorKind: 'administrator',
          correlationId: randomUUID(),
          payload: { context: context.context, role: context.role },
        },
      });
    } catch (error) {
      // Constructor name only — an SMTP error message can quote the recipient and the
      // provider's response, and this log line is not the place for either.
      this.log.error(`Member invite failed for ${userId}: ${(error as Error).constructor.name}`);
    }
  }
}
