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
      // STAMPED with the catalog version of the code that built it, so `readServableGeneration`
      // can refuse one whose rows predate this serializer. Written EXPLICITLY even though the
      // `ProjectionGeneration_stamp_version` trigger would supply a value: that trigger exists for
      // writers which do not know the column (the previous release's bootstrap, the rerunnable 4a
      // repair), and a generation this code builds silently taking its fallback would understate
      // its own version.
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
export async function readServableGeneration(
  client: Prisma.TransactionClient,
  consumer: string,
  projectId: string,
): Promise<ServableGenerationRow | null> {
  const gen = await client.projectionGeneration.findFirst({
    where: { consumer, projectId, status: 'active' },
    select: { id: true, generation: true, appliedPosition: true, cursorStatus: true, catalogVersion: true },
  });
  if (!gen) return null; // no active generation — never rebuilt / no deliveries yet
  if (gen.cursorStatus !== 'live') return null; // blocked on a dead earlier position — stale
  if (gen.appliedPosition === null) return null; // bootstrapped only, nothing applied
  // …and CONTENTS OLDER THAN THIS SERIALIZER. A generation stamped below the running code's
  // compiled `catalogVersion` was materialized by an older release, so its stored DTOs are not
  // what this one would produce. The concrete hazard is the previous release's standalone
  // `projection-rebuild` CLI: it registers consumers directly, never calls `syncConsumerCatalog`,
  // and so can rebuild a projection with ITS serializer and ACTIVATE the result — a read-model
  // missing whatever the newer serializer adds, swapped in by a supported command.
  //
  // The refusal lives HERE rather than on the write, because the same un-versioned INSERT shape is
  // used by an already-running previous release's lazy bootstrap during the documented
  // migrate-before-restart window and by the rerunnable 4a repair; rejecting it would stall a
  // projection the old release is still serving, and break a documented operator repair. Refusing
  // here costs nothing — it is the SAME answer this function already gives a lagging or blocked
  // generation, and every caller falls back to the canonical live read, which is always current.
  // The repair is the ordinary `projection:rebuild`, which stamps its fresh generation correctly.
  if (gen.catalogVersion < catalogVersionFor(consumer)) return null;
  const stream = await client.projectEventStream.findUnique({ where: { projectId }, select: { nextPosition: true } });
  const head = stream ? stream.nextPosition - 1n : -1n;
  if (gen.appliedPosition < head) return null; // checkpoint lags the committed stream — not current
  return { id: gen.id, generation: gen.generation };
}

/**
 * The COMPILED catalog version of a registered consumer — the version a generation this process
 * builds will actually have been materialized at.
 *
 * Both creators are called with a registered consumer, so the fallback is unreachable in practice;
 * it returns 1 because that is the only version an unregistered generation could hold, and because
 * the SAFE direction for this value is DOWNWARD: understating a version makes a generation
 * refusable and rebuildable, while overstating one would serve old rows as current.
 */
export function catalogVersionFor(consumer: string): number {
  return getConsumer(consumer)?.catalogVersion ?? 1;
}
