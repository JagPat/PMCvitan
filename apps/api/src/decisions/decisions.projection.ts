import { Prisma } from '@prisma/client';
import type { DeliveryPlan, EmittedEventMeta, OutboxConsumer } from '../platform/outbox/registry';
import { serializeDecision, type DecisionRow } from './decision-serialize';

/**
 * Phase 2 Task 9 — the DECISIONS read-model projection consumer (`decisions.inbox`).
 *
 * The first module's read path moves onto a rebuildable projection. This ordered `db` projection
 * consumer subscribes to the six `decision.*` events; on each it REFRESHES the project's WHOLE
 * generation-scoped `DecisionProjection` row set from the CANONICAL decisions (a same-module read —
 * the decisions module owns `decision`), storing the exact `DecisionDto`s `serializeDecision`
 * produces — the same full-refresh discipline as the four later module consumers, so a caught-up
 * generation is complete by construction even when it lazily bootstrapped over pre-stream rows. A
 * non-decision event is a `noop` delivery, so the projection's ordered cursor still advances through
 * every stream position contiguously.
 *
 * Because the handler derives each row from CURRENT canonical state (not from event payloads), the
 * projection is trivially equivalent to the live snapshot slice and a rebuild replay is idempotent:
 * re-applying any decision event just re-serializes the same canonical decision. The rebuild SEED
 * loads every canonical decision into the new generation and returns the stream position it reflects
 * (read BEFORE the decisions, so the seed reflects at least that far and the replay tail covers the
 * rest — never a gap).
 */

export const DECISIONS_PROJECTION = 'decisions.inbox';

/** Dispatch the six `decision.*` events; every other event is a no-op that still advances the cursor. */
function deliveryFor(meta: EmittedEventMeta): DeliveryPlan {
  return meta.eventType.startsWith('decision.') ? { action: 'dispatch' } : { action: 'noop' };
}

/** The include the serializer needs: ordered options + the single OPEN change request. */
const DECISION_INCLUDE = {
  options: { orderBy: { order: 'asc' } },
  changeRequests: { where: { status: 'open' }, take: 1 },
  // Phase 6 task 4b — the named holder's USER, resolved into the stored DTO by the ONE fold so
  // live == projection == rebuild carry the same decider designation (§A.3 round 3).
  deciderMembership: { select: { userId: true } },
  // Phase 6 unit 4c-ii (§B P25c) — the consultation thread and the approval-register COUNT the
  // audience predicate compares against. Both projection paths read ONE source: this include.
  // The incremental fold upserts from the canonical rows it already loads, and `rebuildSeed`
  // seeds from the same query — so a generation swap carries the audience with it.
  //
  // The audience is a canonical COLUMN, never an event payload. `rebuildSeed` replays no
  // historical payloads, so an audience living only in a payload is dropped by every rebuild;
  // and folding it from `Membership` here would be the cross-module read the module rules forbid
  // — which is exactly why §A made `DecisionConsultation.consulteeUserId` decisions-owned.
  consultations: { include: { response: true } },
  approvalRevisions: { select: { version: true } },
} satisfies Prisma.DecisionInclude;

/** Upsert one decision's generation-scoped projection row from its canonical record. */
async function upsertRow(tx: Prisma.TransactionClient, generationId: string, d: DecisionRow): Promise<void> {
  const dto = serializeDecision(d) as unknown as Prisma.InputJsonValue;
  const keys = { status: d.status, publishedAt: d.publishedAt, authorId: d.authorId, dto };
  await tx.decisionProjection.upsert({
    where: { generationId_decisionId: { generationId, decisionId: d.id } },
    create: { generationId, projectId: d.projectId, decisionId: d.id, ...keys },
    update: keys,
  });
}

/**
 * Phase 2 final-review P1 correction — the decisions half of the OPERATOR DIAGNOSTIC.
 *
 * `decisions.inbox` is a per-DECISION row set, not the composite single-row shape the four later
 * module projections use — so its corruption check must compare the COMPLETE normalized row set. A
 * legacy generation materialized by the pre-#183 per-event consumer can hold a NON-EMPTY SUBSET of
 * the canonical register while presenting as caught-up and servable (the read-side hollow guard
 * catches only a fully EMPTY generation), and a single-row or emptiness-only probe would call it
 * healthy. Both sides of the comparison normalize through {@link toDecisionComparable}: rows are
 * ordered by `decisionId`, `publishedAt` becomes an explicit ISO string (a `Date` object would
 * stringify as `{}` under key-order-independent JSON), and the dto is this module's ONE canonical
 * serializer output — so the comparison covers every key column AND the served payload.
 */
export interface DecisionComparableRow {
  decisionId: string;
  status: string;
  /** ISO-8601 or null — never a `Date` (normalized identically on the stored and canonical sides). */
  publishedAt: string | null;
  authorId: string | null;
  dto: unknown;
}

/** Normalize one row (stored or canonical) into the diagnostic's comparable shape. */
function toDecisionComparable(r: {
  decisionId: string;
  status: string;
  publishedAt: Date | null;
  authorId: string | null;
  dto: unknown;
}): DecisionComparableRow {
  return {
    decisionId: r.decisionId,
    status: r.status,
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
    authorId: r.authorId,
    dto: r.dto,
  };
}

/** The CANONICAL comparable row set: every decision of the project through `serializeDecision`,
 *  ordered by `decisionId` — what a correct, caught-up generation must store, in full. */
export async function computeDecisionRows(tx: Prisma.TransactionClient, projectId: string): Promise<DecisionComparableRow[]> {
  const rows = await tx.decision.findMany({ where: { projectId }, include: DECISION_INCLUDE, orderBy: { id: 'asc' } });
  return rows.map((d) =>
    toDecisionComparable({ decisionId: d.id, status: d.status, publishedAt: d.publishedAt, authorId: d.authorId, dto: serializeDecision(d) }),
  );
}

/** The STORED comparable row set: the generation's `DecisionProjection` rows, normalized and ordered
 *  identically to {@link computeDecisionRows} so the two sides compare field-for-field. */
export async function storedDecisionRows(tx: Prisma.TransactionClient, generationId: string): Promise<DecisionComparableRow[]> {
  const rows = await tx.decisionProjection.findMany({ where: { generationId }, orderBy: { decisionId: 'asc' } });
  return rows.map((r) =>
    toDecisionComparable({ decisionId: r.decisionId, status: r.status, publishedAt: r.publishedAt, authorId: r.authorId, dto: r.dto }),
  );
}

/**
 * Phase 6 unit 4c-iii-r — DECLARE this release's serializer to the writer fence.
 *
 * `20271126000000` puts a row trigger on `DecisionProjection` that stamps `ProjectionGeneration
 * .fencedAt` whenever the writing session has NOT set this GUC. Only this release's writer sets it,
 * so a previous-release relay that was already running when the migration landed marks the
 * generation unservable the moment it writes v1 rows into it — the read path falls back to canonical
 * and the next deploy's repair rebuilds. `set_config(..., true)` is transaction-LOCAL, so the
 * declaration cannot leak into another session's write.
 *
 * Declared at each write path's entry rather than inside `upsertRow`, which runs once per decision.
 * A future write path that forgets it fails SAFE: the generation is fenced (reads fall back to
 * canonical, which is always current), never corrupt.
 */
async function declareSerializer(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT set_config('vitan.decisions_inbox_catalog_version', '2', true)`;
}

/** Build the `decisions.inbox` projection consumer (reads canonical decisions to refresh its rows). */
export function makeDecisionsProjectionConsumer(): OutboxConsumer {
  return {
    name: DECISIONS_PROJECTION,
    kind: 'ordered',
    effect: 'db',
    // Phase 6 unit 4c-ii (§D) — BUMPED for the consultation fold. `syncConsumerCatalog` asserts
    // the compiled contract against the persisted row at every startup and THROWS on any
    // difference, so from the moment this unit's catalog-data migration lands, a PREVIOUS-release
    // process cannot take up service at all: it never reaches the claim path. That is what makes
    // the drain durable — a rolled-back or newly-scheduled old worker is fenced out on EVERY
    // start, not merely at the one moment an operator looked.
    catalogVersion: 2,
    deliveryFor,
    projection: {
      // Seed the replacement generation from the CONSISTENT canonical snapshot. Read the max committed
      // position FIRST, then the decisions (which therefore reflect AT LEAST that far), and return the
      // max — so the barrier's replay covers (max .. H] with no gap and the overlap re-applies
      // idempotently.
      rebuildSeed: async (tx, target) => {
        await declareSerializer(tx);
        const max = await tx.domainEvent.aggregate({ where: { projectId: target.projectId }, _max: { streamPosition: true } });
        const seededThrough = max._max.streamPosition ?? null;
        const rows = await tx.decision.findMany({ where: { projectId: target.projectId }, include: DECISION_INCLUDE });
        for (const d of rows) await upsertRow(tx, target.generationId, d);
        return seededThrough;
      },
      dropGeneration: async (tx, target) => {
        // Declared like every other write path: the fence covers DELETE too (Codex on `6b3ff9e6`),
        // so the rebuilder discarding a generation's rows would otherwise stamp the very generation
        // it is discarding.
        await declareSerializer(tx);
        await tx.decisionProjection.deleteMany({ where: { generationId: target.generationId } });
      },
    },
    handle: async (ctx) => {
      if (!ctx.tx) throw new Error('decisions projection needs a transaction');
      if (!ctx.projection) throw new Error('decisions projection needs a target generation');
      await declareSerializer(ctx.tx);
      // Task 10 finalization — refresh the WHOLE project's decision set, not just the event's
      // decision (the discipline every later module consumer adopted). A generation that lazily
      // bootstraps MID-LIFE (its first applied event arriving over rows that predate the event
      // stream — a direct import, the seed) would otherwise contain ONLY the decisions with
      // post-bootstrap events while presenting as the complete, servable register: the Decision Log
      // then silently hides every earlier decision. Deriving the full set from canonical on every
      // applied event makes any caught-up generation complete by construction; rows for decisions
      // that no longer exist are dropped.
      const rows = await ctx.tx.decision.findMany({ where: { projectId: ctx.meta.projectId }, include: DECISION_INCLUDE });
      for (const d of rows) await upsertRow(ctx.tx, ctx.projection.generationId, d);
      await ctx.tx.decisionProjection.deleteMany({
        where: { generationId: ctx.projection.generationId, decisionId: { notIn: rows.map((r) => r.id) } },
      });
    },
  };
}
