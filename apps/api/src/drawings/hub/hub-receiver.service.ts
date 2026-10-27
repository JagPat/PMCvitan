import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { systemActor } from '../../common/actor';
import { recordAudit } from '../../platform/audit';
import { readHubConfig } from './hub-config';
import { verifyHubSignature } from './hub-signature';
import { HUB_UNREADABLE_TYPE, readHubEvent } from './hub-event';

/** Who an audit row of a Hub delivery names: Hub, a system process, never a person. */
export const HUB_DELIVERY_ACTOR = 'system:hub-webhook';

/** What the receiver made of one delivery; the controller turns it into the HTTP answer. */
export type HubDeliveryAnswer =
  /** the integration is closed, or the route's org isn't the Hub org: answered as an unrouted path (404) */
  | 'closed'
  /** the body wasn't read as raw JSON bytes (400) */
  | 'unreadable_body'
  /** the signature check failed (401); nothing is written */
  | 'unsigned'
  /** this delivery was already applied (2xx); nothing is written */
  | 'duplicate'
  /** recorded as ignored (2xx) */
  | 'ignored'
  /** recorded as refused and audited (2xx) */
  | 'refused'
  /** a delivery PMC will apply, not yet written (503 until U5, so Hub retries and nothing is lost) */
  | 'accepted';

/** Why a delivery was refused, on its audit row. */
export type HubRefusal = 'unreadable' | 'malformed' | 'not_linked' | 'hub_project_mismatch';

export type HubDelivery = {
  orgId: string;
  headers: { id: string | string[] | undefined; timestamp: string | string[] | undefined; signature: string | string[] | undefined };
  body: unknown;
  now: Date;
};

/**
 * #1118 U3 — judges one Hub webhook delivery (`notes/hub/1118-plan.md` U3), in this order:
 *
 *  1. Closed: the integration unless all four `HUB_*` are good, or a route org other than `HUB_ORG_ID`. Nothing is read.
 *  2. The body must be the raw bytes (`hubRawBody`), and the Standard Webhooks signature must hold. Neither writes.
 *  3. Then, in one transaction: a delivery already `applied` for this org is answered 2xx and skipped. Any other is
 *     judged again, so a refused or ignored delivery can still be applied by a later release (C2).
 *  4. The event is read: unreadable or malformed is refused; an unsubscribed type or work in progress is ignored.
 *  5. The project resolves only through its active link: the link of the PMC project Hub names (`links[app=pmc]`), in
 *     the Hub org, whose latest event is `linked` to the Hub project the event is about. The link row is read FOR SHARE,
 *     so a link or unlink in flight (its writer holds the row FOR UPDATE) finishes first and the judgement sees it.
 *  6. Resolved: `accepted`, written by U5. Until then it answers 503 and writes nothing.
 *
 * A refused delivery is recorded with no project and audited; an ignored one is recorded only. Neither the audit row nor
 * anything else here carries a header, the signature, the token or a secret, and nothing is logged.
 */
@Injectable()
export class HubReceiverService {
  constructor(private readonly prisma: PrismaService) {}

  async receive(delivery: HubDelivery): Promise<HubDeliveryAnswer> {
    const hub = readHubConfig();
    if (!hub.open || delivery.orgId !== hub.config.orgId) return 'closed';
    const orgId = hub.config.orgId;
    if (!Buffer.isBuffer(delivery.body)) return 'unreadable_body';
    const body = delivery.body;
    const verdict = verifyHubSignature({ ...delivery.headers, body, secrets: hub.config.webhookSecrets, now: delivery.now });
    if (!verdict.ok) return 'unsigned';
    // the verifier passed, so the id is one header of visible ASCII
    const webhookId = delivery.headers.id as string | [string];
    const id = Array.isArray(webhookId) ? webhookId[0] : webhookId;

    return this.prisma.$transaction(async (tx) => {
      const applied = await tx.hubWebhookReceipt.findFirst({ where: { orgId, webhookId: id, outcome: 'applied' }, select: { id: true } });
      if (applied) return 'duplicate';

      const record = async (outcome: 'refused' | 'ignored', eventType: string, hubVersionId: string | null, reason?: HubRefusal) => {
        const receipt = await tx.hubWebhookReceipt.create({
          data: { orgId, webhookId: id, eventType, outcome, hubVersionId },
          select: { id: true },
        });
        if (reason) {
          await recordAudit(tx, {
            projectId: null,
            actor: systemActor(HUB_DELIVERY_ACTOR, 'Redbracket Hub'),
            action: 'hub.delivery_refused',
            entity: 'HubWebhookReceipt',
            entityId: String(receipt.id),
            payload: { eventType, reason },
          });
        }
        return outcome;
      };

      const event = readHubEvent(body);
      if (event.kind === 'unreadable') return record('refused', HUB_UNREADABLE_TYPE, null, 'unreadable');
      if (event.kind === 'ignored') return record('ignored', event.type, null);
      if (event.kind === 'malformed') return record('refused', event.type, event.versionId, 'malformed');
      // Hub names one PMC project per link; none, or more than one, resolves nothing
      if (event.pmcProjectIds.length !== 1) return record('refused', event.type, event.versionId, 'not_linked');

      const projectId = event.pmcProjectIds[0]!;
      const link = await tx.$queryRaw<Array<{ projectId: string }>>`
        SELECT "projectId" FROM "DrawingHubLink" WHERE "projectId" = ${projectId} AND "orgId" = ${orgId} FOR SHARE`;
      if (link.length === 0) return record('refused', event.type, event.versionId, 'not_linked');
      const latest = await tx.drawingHubLinkEvent.findFirst({
        where: { projectId },
        orderBy: { seq: 'desc' },
        select: { kind: true, hubProjectId: true },
      });
      if (latest?.kind !== 'linked') return record('refused', event.type, event.versionId, 'not_linked');
      if (latest.hubProjectId !== event.hubProjectId) return record('refused', event.type, event.versionId, 'hub_project_mismatch');
      return 'accepted';
    });
  }
}
