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
 *   - a DEAD row keeps its dead history but receives the mark too (round 1, Codex F3): an
 *     operator redrive resets dead → pending, and without the mark that redrive would
 *     resurrect the stale announcement — with it, the sender's pre-send re-check turns the
 *     redrive into a recorded noop.
 *   - a row materialized SUBJECTLESS (round 4, Codex): during a migration-first rolling deploy
 *     an OLD API instance can still create a delivery AFTER the one-time backfill ran, writing
 *     the new nullable `subject` column as NULL. A subject-keyed match alone would miss it —
 *     and the tombstone below is suppressed because the `(eventId, consumer)` row EXISTS. So
 *     each pass first STAMPS the subject onto any matching-event row that lacks it (copied
 *     from the row's own event identity, never invented), and the status arms then see it.
 *   - a row that DOES NOT EXIST YET (round 3, Codex): the recovery scanner
 *     (`expandMissingDeliveries`) exists to repair the rolling-deploy/crash gap — an event with
 *     no delivery row for a registered consumer. A cancellation running INSIDE that gap would
 *     match nothing, and a later recovery pass would materialize the missing row as PENDING and
 *     send the stale announcement. So the cancellation materializes the row FIRST, already
 *     cancelled (`succeeded` + `noop`, no payload was ever built — the durable dispatch intent
 *     stays on the event row for audit), and recovery's NOT EXISTS then finds it present and
 *     creates nothing. This arm is COMPLETE by ordering: every event it must cover exists when
 *     it runs, because the publication that queued the announcement precedes the withdrawal
 *     that cancels it.
 *   - the SCANNER INTERLEAVE (round 4, Codex): a recovery row that COMMITS after the first
 *     passes scanned (they cannot see it) and before the tombstone insert resolves would
 *     survive as pending — the insert merely arrives at its handled conflict. So the passes
 *     RUN AGAIN after the insert: a row that landed in the window is committed and visible by
 *     then and is neutralized; a row that lands after the insert executed blocks on the
 *     in-flight unique conflict and resolves to the scanner's handled P2002 after this
 *     transaction commits. With the repeat pass, every interleaving of the scanner's create
 *     and this cancellation ends with the row cancelled or never created — proven by the
 *     deterministic barrier probe (R4-F3).
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
): Promise<{ neutralized: number; marked: number; entombed: number }> {
  const now = new Date();
  const scope = {
    consumer: PUSH_CONSUMER,
    projectId: args.projectId,
    subject: args.subject,
    cancelledAt: null,
    event: { is: { eventType: args.eventType } },
  } as const;
  // One pass of the three set-based mutations, over the platform's OWN tables only.
  const pass = async (): Promise<{ neutralized: number; marked: number }> => {
    // round 4 — restore the identity an old-instance writer omitted, from the row's own event
    await tx.$executeRaw`
      UPDATE "OutboxDelivery" d
         SET "subject" = e."entityId", "updatedAt" = now()
        FROM "DomainEvent" e
       WHERE e."eventId" = d."eventId"
         AND d."consumer" = ${PUSH_CONSUMER}
         AND d."projectId" = ${args.projectId}
         AND d."subject" IS NULL
         AND e."eventType" = ${args.eventType}
         AND e."entityId" = ${args.subject}`;
    const neutralized = await tx.outboxDelivery.updateMany({
      where: { ...scope, status: 'pending' },
      data: { status: 'succeeded', deliveryAction: 'noop', cancelledAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: null },
    });
    const marked = await tx.outboxDelivery.updateMany({
      where: { ...scope, status: { in: ['leased', 'dead'] } },
      data: { cancelledAt: now },
    });
    return { neutralized: neutralized.count, marked: marked.count };
  };

  const first = await pass();
  // The recovery-gap tombstone (round 3). Guarded on the catalog contract row twice over: a
  // delivery must name a declared (consumer, kind) — and an instance with no catalog row never
  // expands the gap either.
  const entombed = await tx.$executeRaw`
    INSERT INTO "OutboxDelivery"
      ("id", "eventId", "projectId", "consumer", "consumerKind", "deliveryAction",
       "streamPosition", "status", "subject", "cancelledAt", "nextAttemptAt", "createdAt", "updatedAt")
    SELECT gen_random_uuid(), e."eventId", e."projectId", ${PUSH_CONSUMER}, 'unordered', 'noop',
           e."streamPosition", 'succeeded', ${args.subject}, ${now}, now(), now(), now()
      FROM "DomainEvent" e
     WHERE e."projectId" = ${args.projectId}
       AND e."eventType" = ${args.eventType}
       AND e."entityId" = ${args.subject}
       AND EXISTS (SELECT 1 FROM "OutboxConsumerCatalog" c
                    WHERE c."consumer" = ${PUSH_CONSUMER} AND c."consumerKind" = 'unordered')
       AND NOT EXISTS (SELECT 1 FROM "OutboxDelivery" d
                        WHERE d."eventId" = e."eventId" AND d."consumer" = ${PUSH_CONSUMER})
     ON CONFLICT DO NOTHING`;
  // round 4 — the repeat pass: catch any row that committed between the first pass and the
  // insert's resolution (see the SCANNER INTERLEAVE bullet above).
  const second = await pass();

  return {
    neutralized: first.neutralized + second.neutralized,
    marked: first.marked + second.marked,
    entombed,
  };
}
