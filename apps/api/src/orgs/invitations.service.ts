import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma.service';
import { EmailService } from '../auth/email.service';
import { resolveWebAppUrl } from '../config';

/** The orgs-owned identity fields that decide whether an invite is owed. `User` is orgs-owned
 *  (see `orgsManifest.ownsModels`), so reading them here crosses no module boundary. */
export interface InvitableUser {
  id: string;
  name: string;
  email: string | null;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
}

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
 *     happen. Failures are logged and swallowed; the absence of an `auth.invitation_sent`
 *     audit row is the durable signal that no notice went out.
 */
@Injectable()
export class InvitationsService {
  private readonly log = new Logger('InvitationsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  /**
   * True when this identity still has no way in of its own. Deliberately the SAME predicate
   * `OrgsService.correctInvitationEmail` refuses on ("this account has already established its
   * sign-in credential"), so "an invitation is still outstanding" means one thing in this
   * module. An identity that has claimed its account is never re-notified by a later roster
   * write — a role change is not an invitation.
   */
  private outstanding(user: InvitableUser): boolean {
    return !user.passwordHash && !user.emailVerifiedAt;
  }

  /**
   * Send the invite notice for a roster write that has already committed. Safe to call
   * unconditionally: an identity with no email address, or one that has already established a
   * credential, is skipped silently.
   */
  async notify(user: InvitableUser, context: InviteContext): Promise<void> {
    if (!user.email || !this.outstanding(user)) return;
    const correlationId = randomUUID();
    try {
      const { live } = await this.email.sendMemberInvite(user.email, {
        name: user.name,
        context: context.context,
        role: context.role,
        signInUrl: resolveWebAppUrl(),
      });
      if (!live) return;
      await this.prisma.securityAuditEvent.create({
        data: {
          action: 'auth.invitation_sent',
          targetUserId: user.id,
          actorUserId: context.actorUserId,
          actorKind: 'administrator',
          correlationId,
          payload: { context: context.context, role: context.role },
        },
      });
    } catch (error) {
      // Constructor name only — an SMTP error message can quote the recipient and the
      // provider's response, and this log line is not the place for either.
      this.log.error(`Member invite failed for ${user.id}: ${(error as Error).constructor.name}`);
    }
  }
}
