import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { OutboxRelay } from './relay.service';
import { SOCKET_CONSUMER, PUSH_CONSUMER } from './consumers';
import { outboxSenderMode, type EmittedEventMeta } from './registry';
import { EXTERNAL_EFFECTS, type ExternalEffectKey } from '../external-effects';

/**
 * PR C Task 2 — the single, immediate external-effect sender.
 *
 * A command, AFTER it commits, hands its emitted events (in causal order) to `dispatchCommitted`.
 * The sender-mode + the delivery lease decide WHO sends BEFORE any consumer is invoked, so there are
 * never two active senders:
 *   - `outbox`  → the background {@link OutboxRelay} owns external dispatch; this returns immediately.
 *   - `legacy`/`shadow` → this dispatcher is the SOLE external sender. It invalidates the socket ONCE
 *     per project across the whole committed batch (a multi-event command still invalidates once), and
 *     sends one push per push-bearing event, through the relay's shared claim/dispatch/failure path.
 *     `shadow` additionally records a structured comparison of the persisted plan vs the catalog's
 *     expected plan (it never sends twice).
 *
 * A provider failure never throws out of here: the durable delivery carries the retry/dead outcome
 * while the already-committed API command result stays successful (at-least-once external delivery).
 */
@Injectable()
export class ExternalEffectDispatcher {
  private readonly log = new Logger('ExternalEffectDispatcher');
  constructor(private readonly prisma: PrismaService, private readonly relay: OutboxRelay) {}

  async dispatchCommitted(events: EmittedEventMeta[]): Promise<void> {
    if (!events.length) return;
    const mode = outboxSenderMode();
    if (mode === 'outbox') return; // the background relay owns external dispatch after cutover
    const shadow = mode === 'shadow';

    // The whole post-commit body is guarded: the API command already committed, so a transient DB
    // error here (the delivery query, the dedup update, a provider blip) must NEVER throw into the
    // request. Any pending delivery the immediate path fails to send stays durable and is re-attempted
    // by the relay's recovery claim (at-least-once) — see OutboxRelay.claimExternalRecovery.
    try {
      const eventIds = events.map((e) => e.eventId);
      // This command's pending external DISPATCH deliveries (socket + push). A `noop` row (a private
      // draft, a null-intent legacy event) is already `succeeded` and never appears here — so a draft
      // never sends.
      const deliveries = await this.prisma.outboxDelivery.findMany({
        where: { eventId: { in: eventIds }, consumerKind: 'unordered', deliveryAction: 'dispatch', status: 'pending' },
        select: { id: true, projectId: true, consumer: true },
      });
      if (shadow) this.recordShadowComparison(events);

      // SOCKET: one invalidation per project across the batch. Dispatch one row (the consumer emits
      // once) and mark the rest succeeded, so a multi-event command never emits the socket twice.
      const socketByProject = new Map<string, string[]>();
      const pushIds: string[] = [];
      for (const d of deliveries) {
        if (d.consumer === SOCKET_CONSUMER) {
          const arr = socketByProject.get(d.projectId) ?? [];
          arr.push(d.id);
          socketByProject.set(d.projectId, arr);
        } else if (d.consumer === PUSH_CONSUMER) {
          pushIds.push(d.id);
        }
      }
      for (const ids of socketByProject.values()) {
        const [head, ...rest] = ids;
        await this.safeDispatch(head);
        if (rest.length) {
          // Neutralize the dedup'd siblings only while still `pending` — never stomp a lease a
          // mixed-mode relay may already hold (it would re-send an idempotent socket signal anyway).
          await this.prisma.outboxDelivery.updateMany({
            where: { id: { in: rest }, status: 'pending' },
            data: { status: 'succeeded', leaseOwner: null, leaseExpiresAt: null, lastError: null },
          });
        }
      }
      // PUSH: one per push-bearing event (each command carries at most one push by catalog design).
      for (const id of pushIds) await this.safeDispatch(id);
    } catch (e) {
      this.log.warn(`post-commit external dispatch failed (durable deliveries carry the outcome): ${(e as Error).message}`);
    }
  }

  /** Claim the delivery's lease, then dispatch it through the relay's shared path; never throw
   *  (durable state carries the retry/dead outcome, the API result already committed). The claim runs
   *  BEFORE the send so the immediate path is lease-coordinated with the background relay — if an
   *  outbox-mode instance's relay already claimed this row (a rolling deploy across the cutover), the
   *  claim loses and we return, and that relay sends it. Exactly one sender per delivery, in any mode. */
  private async safeDispatch(deliveryId: string): Promise<void> {
    try {
      if (!(await this.relay.claimOne(deliveryId))) return; // the relay owns it — it will send
      await this.relay.dispatchOne(deliveryId);
    } catch (e) {
      this.log.warn(`immediate external dispatch of ${deliveryId} failed post-commit: ${(e as Error).message}`);
    }
  }

  /** Shadow: log a structured mismatch of each event's PERSISTED plan vs the catalog's EXPECTED plan,
   *  keyed by event id + coverage version. Diagnostics only — the immediate send still happens once. */
  private recordShadowComparison(events: EmittedEventMeta[]): void {
    for (const ev of events) {
      const intent = ev.dispatchIntent;
      const key = intent?.effectKey as ExternalEffectKey | undefined;
      const def = key ? EXTERNAL_EFFECTS[key] : undefined;
      if (!def) continue;
      const actualInvalidate = intent?.invalidate ?? false;
      if (def.invalidate !== actualInvalidate) {
        this.log.warn(`[shadow] ${ev.eventId} (${key}) invalidate ${actualInvalidate} != catalog ${def.invalidate} @ ${intent?.coverageVersion}`);
      }
      // Only a push body on a catalog key that FORBIDS push is real drift (and `buildDispatchIntent`
      // already rejects that at emit time). A push-CAPABLE key that legitimately emits WITHOUT a body
      // — e.g. a closing-inspection approval that defers its push to the paired `activity.signed_off`
      // — is not a mismatch, so the absent-body direction never warns (it was noisy false positives).
      const hasPush = !!intent?.push?.body;
      if (hasPush && !def.push) {
        this.log.warn(`[shadow] ${ev.eventId} (${key}) carries a push but the catalog forbids one @ ${intent?.coverageVersion}`);
      }
    }
  }
}
