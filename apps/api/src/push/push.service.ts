import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma.service';
import { OrgsParticipant } from '../orgs/orgs.participant';

export interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
}

/** Phase 6 task 4b (§A.3 rounds 9/13–15) — the user linkage recorded at an AUTHENTICATED
 *  subscribe: the user, their credential version at attribution, and the authenticating token's
 *  own expiry. Link validity at claim time is min(token expiry, version match). */
export interface SubscriptionLink {
  userId: string;
  credentialVersion: number;
  expiresAt: Date;
}

/**
 * Web Push (VAPID), dev-stub-first. With VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY
 * set, project notifications fan out to every stored browser subscription;
 * with no keys the send path is a no-op (subscriptions are still stored, so
 * enabling keys later "just works"). Expired endpoints (404/410) are pruned.
 */
@Injectable()
export class PushService {
  private readonly log = new Logger('PushService');
  private ready = false;

  constructor(
    private readonly prisma: PrismaService,
    // Phase 6 task 4b (§A.3 round 16) — the LIVE credential-version comparison for a link routes
    // through the orgs-owned participant, never a direct `User` read from platform code.
    private readonly orgs: OrgsParticipant,
  ) {
    if (this.configured) {
      webpush.setVapidDetails(
        process.env.VAPID_SUBJECT || 'mailto:admin@vitan.in',
        process.env.VAPID_PUBLIC_KEY!,
        process.env.VAPID_PRIVATE_KEY!,
      );
      this.ready = true;
    }
  }

  get configured(): boolean {
    return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  }

  /** The VAPID public key the browser needs to subscribe (empty when unconfigured). */
  get publicKey(): string {
    return process.env.VAPID_PUBLIC_KEY || '';
  }

  /**
   * Store (or refresh) a browser subscription for a project. Phase 6 task 4b (§A.3): an
   * authenticated subscribe ATTRIBUTES the device to its user (opportunistically, on every app
   * open that re-subscribes) — recording the credential version and the token's own expiry so a
   * later claim can judge the link's validity. A caller whose identity has no `User` row (a
   * worker device, a dev token) stores the subscription UNLINKED: targeted content never reaches
   * an unattributed device, while role-level pushes behave exactly as before.
   */
  async subscribe(projectId: string, sub: BrowserSubscription, role?: string, link?: SubscriptionLink): Promise<void> {
    // round-1 Codex F4 — the identity-existence answer is orgs-owned: platform code never reads
    // the `User` table directly (the same boundary this class already respects for the
    // credential-version comparison at claim time).
    const linked =
      link && (await this.orgs.resolveUserIdentity(this.prisma, link.userId))?.id === link.userId
        ? { linkedUserId: link.userId, linkedCredentialVersion: link.credentialVersion, linkedExpiresAt: link.expiresAt }
        : { linkedUserId: null, linkedCredentialVersion: null, linkedExpiresAt: null };
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: { projectId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, role, ...linked },
      update: { projectId, p256dh: sub.keys.p256dh, auth: sub.keys.auth, role, ...linked },
    });
  }

  /**
   * Phase 6 task 4b (§A.3 round 13) — sign-out UNLINKS the device: a shared site tablet must not
   * keep rendering decider A's targeted content after A walks away. The subscription itself stays
   * (role-level pushes continue); only the user attribution is severed, until the next
   * authenticated open re-attributes it. Endpoint-keyed and idempotent — an unknown endpoint is a
   * no-op, so sign-out never fails on a pruned device.
   *
   * Round-1 Codex F1 — the unlink is CONDITIONAL on the departing user: only a link that still
   * belongs to the authenticated caller is cleared. On a shared browser, user A's delayed
   * sign-out request arriving after user B re-attributed the same endpoint is then a no-op —
   * it can never strip B's link.
   */
  async unlink(endpoint: string, callerUserId: string): Promise<void> {
    if (!callerUserId) return;
    await this.prisma.pushSubscription.updateMany({
      where: { endpoint, linkedUserId: callerUserId },
      data: { linkedUserId: null, linkedCredentialVersion: null, linkedExpiresAt: null },
    });
  }

  /**
   * Fan a notification out to the project's subscriptions (no-op without VAPID).
   * With `roles`, only subscriptions whose stored role matches are targeted (e.g.
   * an approval goes to PMC/contractor, a re-inspection to the engineer); omit it
   * to broadcast to everyone on the project.
   */
  async notifyProject(projectId: string, payload: PushPayload, roles?: string[]): Promise<void> {
    if (!this.ready) return;
    const where = roles && roles.length ? { projectId, role: { in: roles } } : { projectId };
    const subs = await this.prisma.pushSubscription.findMany({ where });
    await this.send(subs, payload);
  }

  /**
   * Phase 6 task 4b (§A.3 rounds 9–10/14–15) — TARGETED delivery: only currently-VALID links of
   * the target user receive the content. Validity = the link exists, its recorded token expiry is
   * still in the future, AND its recorded credential version matches the user's current one
   * (checked through the orgs participant). An unlinked or stale-linked device receives NOTHING —
   * never a role-ceiling fallback: correctness wins over delivery, the bell still carries the
   * demand.
   */
  async notifyTargetedUser(projectId: string, payload: PushPayload, targetUserId: string): Promise<void> {
    if (!this.ready) return;
    const now = new Date();
    const candidates = await this.prisma.pushSubscription.findMany({
      where: { projectId, linkedUserId: targetUserId, linkedExpiresAt: { gt: now } },
    });
    if (candidates.length === 0) return;
    // one live comparison per recorded version (usually one) — through the owner, never the table
    const versions = [...new Set(candidates.map((c) => c.linkedCredentialVersion))];
    const valid = new Set<number>();
    for (const v of versions) {
      if (v !== null && (await this.orgs.sessionStillValid(this.prisma, targetUserId, v))) valid.add(v);
    }
    const subs = candidates.filter((c) => c.linkedCredentialVersion !== null && valid.has(c.linkedCredentialVersion));
    await this.send(subs, payload);
  }

  private async send(subs: Array<{ endpoint: string; p256dh: string; auth: string }>, payload: PushPayload): Promise<void> {
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (sc) => {
        try {
          await webpush.sendNotification({ endpoint: sc.endpoint, keys: { p256dh: sc.p256dh, auth: sc.auth } }, body);
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) {
            await this.prisma.pushSubscription.delete({ where: { endpoint: sc.endpoint } }).catch(() => {});
          } else {
            this.log.warn(`push send failed (${code ?? 'unknown'}) for ${sc.endpoint.slice(0, 40)}…`);
          }
        }
      }),
    );
  }
}
