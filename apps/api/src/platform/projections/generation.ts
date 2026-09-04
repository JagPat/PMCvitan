import { Prisma } from '@prisma/client';
import { getConsumer } from '../outbox/registry';

/**
 * Phase 2 Task 9 — the ACTIVE-generation lock, shared by the relay's live apply and the rebuilder's
 * activation barrier.
 *
 * A projection's serving cursor is its single ACTIVE generation (the DB partial unique index
 * `ProjectionGeneration_one_active` guarantees at most one per `(consumer, projectId)`). This locks
 * that row `FOR UPDATE` inside the caller's transaction, so two relay workers — and the barrier's
 * atomic activate/retire swap — serialize on it: the checkpoint advances without a lost update, and
 * the relay can never apply into a generation the barrier is retiring (it waits and re-reads the new
 * active one, or applies to the still-active one which the barrier then retires — either is safe).
 *
 * If NO active generation exists yet, this LAZILY bootstraps generation 1 as active
 * (`appliedPosition = null`) — a projection's first live delivery initialises its serving generation,
 * mirroring how the ordered-consumer path upserts its `ProjectionCursor` on first use. A create race
 * (two workers bootstrapping at once) is resolved by the partial unique: the loser catches `P2002`
 * and re-reads the winner's row under the lock.
 */
export interface ActiveGenerationRow {
  id: string;
  generation: number;
  appliedPosition: bigint | null;
}

export async function lockActiveGeneration(
  tx: Prisma.TransactionClient,
  consumer: string,
  projectId: string,
): Promise<ActiveGenerationRow> {
  const read = async (): Promise<ActiveGenerationRow | null> => {
    const rows = await tx.$queryRaw<{ id: string; generation: number; appliedPosition: bigint | null }[]>`
      SELECT "id", "generation", "appliedPosition"
      FROM "ProjectionGeneration"
      WHERE "consumer" = ${consumer} AND "projectId" = ${projectId} AND "status" = 'active'
      FOR UPDATE`;
    return rows[0] ?? null;
  };

  const existing = await read();
  if (existing) return existing;

  // No active generation — bootstrap the next generation number as the live one.
  const agg = await tx.projectionGeneration.aggregate({ where: { consumer, projectId }, _max: { generation: true } });
  const generation = (agg._max.generation ?? 0) + 1;
  try {
    const created = await tx.projectionGeneration.create({
      // Phase 6 unit 4c-ii (§D) — every generation is STAMPED with the catalog version of the
      // code that built it, so `readServableGeneration` can refuse one whose contents predate this
      // serializer. Written EXPLICITLY even though the column defaults to 1: the default exists
      // only for writers that do not know the column (the previous release's bootstrap, the 4a
      // repair replay), and a new generation silently taking it would understate its own version.
      data: { consumer, projectId, generation, status: 'active', appliedPosition: null, catalogVersion: catalogVersionFor(consumer) },
      select: { id: true, generation: true, appliedPosition: true },
    });
    return created;
  } catch (e) {
    // a concurrent bootstrap won the partial-unique race — re-read (and lock) the winner
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const won = await read();
      if (won) return won;
    }
    throw e;
  }
}

export interface ServableGenerationRow {
  id: string;
  generation: number;
}

/**
 * Phase 2 Task 10 (correction, finding 1) — the active generation IFF it is SAFE TO SERVE a read from.
 *
 * A projection read must NEVER present a generation as authoritative unless its rows actually reflect
 * the project's current canonical state. An active generation is servable only when it is
 *  - HEALTHY: `cursorStatus = 'live'` (a `blocked` generation stalled on a dead earlier position); AND
 *  - CAUGHT UP: `appliedPosition` has reached the project's committed stream head
 *    (`appliedPosition >= nextPosition - 1`) — so every event through head (including the no-ops that
 *    merely advance the ordered cursor) has been applied.
 *
 * A generation that a no-op delivery only BOOTSTRAPPED (`appliedPosition = null`, no rows yet), one
 * whose checkpoint LAGS the stream (a write committed but the relay has not applied it), or a BLOCKED
 * one returns `null` here — the caller falls back to the canonical live read, which is always current.
 * This closes the bug where an unrelated no-op event created an active generation with no projection
 * row and the read served an empty slice as `source: 'projection'`, hiding real canonical data.
 */
/**
 * Phase 6 unit 4c-iii-r — RE-ASK after the rows have been read (Codex on `de9fa3b7`).
 *
 * `readServableGeneration` and the caller's row fetch are two separate statements, and under READ
 * COMMITTED each sees its own snapshot. So a legacy relay can commit its rewrite AND the trigger's
 * fence stamp in the gap between them: the gate reads `fencedAt = NULL` and a current checkpoint,
 * and the row fetch that follows returns exactly the rows the fence exists to keep off the wire.
 * Checking the stamp before the read does not protect the read.
 *
 * The stamp is append-only and monotone (`20271126000000` seals it), which is what makes a
 * re-ask sufficient: if it is NULL before the fetch and still NULL after, nothing undeclared touched
 * the generation across the window, and the rows in hand are from a generation no legacy writer has
 * entered. If it appeared, the rows are discarded and the caller falls back to the canonical live
 * read, which is always current. That is cheaper than holding the generation lock across the whole
 * read path, and it does not put a lock on the hot path of every decisions query.
 */
export async function stillServableAfterRead(
  client: Prisma.TransactionClient,
  generationId: string,
): Promise<boolean> {
  const row = await client.projectionGeneration.findUnique({
    where: { id: generationId },
    select: { fencedAt: true },
  });
  return row !== null && row.fencedAt === null;
}

export async function readServableGeneration(
  client: Prisma.TransactionClient,
  consumer: string,
  projectId: string,
): Promise<ServableGenerationRow | null> {
  const gen = await client.projectionGeneration.findFirst({
    where: { consumer, projectId, status: 'active' },
    select: { id: true, generation: true, appliedPosition: true, cursorStatus: true, catalogVersion: true, fencedAt: true },
  });
  if (!gen) return null; // no active generation — never rebuilt / no deliveries yet
  // Phase 6 unit 4c-iii-r — TOUCHED BY AN UNDECLARED WRITER. `20271126000000`'s row trigger stamps
  // this when a session that has not declared this release's serializer writes into the generation,
  // which is what an already-running previous-release relay does. Its rows may now be v1-shaped and
  // nothing can tell from the rows themselves (a threadless decision is byte-identical under both
  // serializers), so the generation stops being servable and every read falls back to the canonical
  // live read, which is always current. Cleared only by building a new generation — the repair, or
  // the ordinary `projection:rebuild`.
  if (gen.fencedAt !== null) return null;
  if (gen.cursorStatus !== 'live') return null; // blocked on a dead earlier position — stale
  if (gen.appliedPosition === null) return null; // bootstrapped only, nothing applied
  // Phase 6 unit 4c-ii (§D, review round 30) — CONTENTS OLDER THAN THIS SERIALIZER.
  //
  // A generation stamped below the running code's compiled `catalogVersion` was materialized by an
  // older serializer, so its stored DTOs are not what this release would produce. The concrete
  // hazard is the previous release's standalone `projection-rebuild` CLI: it registers consumers
  // directly, never calls `syncConsumerCatalog`, and would rebuild `decisions.inbox` with the v1
  // serializer and ACTIVATE it — a register with no consultation thread and no widened audience,
  // swapped in by a SUPPORTED command, at exactly the moment something already looks wrong.
  //
  // A write-side fence cannot close this without collateral: the same INSERT shape is used by an
  // already-running previous-release relay's lazy bootstrap during the documented
  // migrate-before-restart window, and by the rerunnable 4a repair. Refusing here instead costs
  // nothing — it is the SAME answer this function already gives a lagging or blocked generation,
  // and every caller falls back to the canonical live read, which is always current. The repair is
  // the ordinary `projection:rebuild` the cutover already runs, which stamps the fresh generation
  // at the current version.
  if (gen.catalogVersion < catalogVersionFor(consumer)) return null;
  const stream = await client.projectEventStream.findUnique({ where: { projectId }, select: { nextPosition: true } });
  const head = stream ? stream.nextPosition - 1n : -1n;
  if (gen.appliedPosition < head) return null; // checkpoint lags the committed stream — not current
  return { id: gen.id, generation: gen.generation };
}

/** The COMPILED catalog version of a registered consumer — the version the generation this
 *  process is about to build will actually have been built at. An unregistered name cannot be
 *  reached through either creator (both are called with a registered consumer), so falling back
 *  to 1 records the only version such a generation could hold rather than inventing one. */
export function catalogVersionFor(consumer: string): number {
  return getConsumer(consumer)?.catalogVersion ?? 1;
}
