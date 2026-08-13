import type { Prisma } from '@prisma/client';
import { PUSH_CONSUMER } from './consumers';

/**
 * Phase 6 task 4a — cancel queued push intents about a subject, from INSIDE the cancelling
 * domain's transaction.
 *
 * The boundary is the whole design (plan §A.4): the DOMAIN owns the knowledge of WHEN a queued
 * announcement went stale (a decision withdrawn before its `decision.published` push left), and
 * the PLATFORM owns the queue. So the domain calls this narrow platform operation on its own
 * `tx`; the platform mutates only its own table; decisions never reaches into the relay, and
 * the relay never reads a decisions table.
 *
 * Cancelled and RECORDED, never deleted:
 *   - a still-PENDING row is neutralized in place — `succeeded` + `noop` (the cutover-seal
 *     precedent: the payload is preserved for audit) with `cancelledAt` recording why. A relay
 *     claiming after this commit finds nothing claimable.
 *   - a row already LEASED keeps its status (the sender owns it right now); it receives only
 *     the `cancelledAt` mark, and the sender's final pre-send re-check of its OWN row
 *     (`relay.service.ts` dispatchExternal) drops the send and records the drop.
 * NOT a new status value — the `OutboxDelivery_status_check` set is deliberately closed.
 *
 * The guarantee's true boundary, stated rather than overclaimed: a cancellation landing in the
 * instant between the sender's final pre-send check and the external notify call is
 * unrecallable — exactly as an already-sent push is. What is guaranteed: NO stale push is sent
 * whose delivery had not yet passed its final pre-send check when this transaction committed.
 */
export async function cancelQueuedPushBySubject(
  tx: Prisma.TransactionClient,
  args: { projectId: string; subject: string; eventType: string },
): Promise<{ neutralized: number; marked: number }> {
  const now = new Date();
  const scope = {
    consumer: PUSH_CONSUMER,
    projectId: args.projectId,
    subject: args.subject,
    cancelledAt: null,
    event: { is: { eventType: args.eventType } },
  } as const;
  const neutralized = await tx.outboxDelivery.updateMany({
    where: { ...scope, status: 'pending' },
    data: { status: 'succeeded', deliveryAction: 'noop', cancelledAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: null },
  });
  const marked = await tx.outboxDelivery.updateMany({
    where: { ...scope, status: 'leased' },
    data: { cancelledAt: now },
  });
  return { neutralized: neutralized.count, marked: marked.count };
}
