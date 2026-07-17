import { Prisma } from '@prisma/client';

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
      data: { consumer, projectId, generation, status: 'active', appliedPosition: null },
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
    select: { id: true, generation: true, appliedPosition: true, cursorStatus: true },
  });
  if (!gen) return null; // no active generation — never rebuilt / no deliveries yet
  if (gen.cursorStatus !== 'live') return null; // blocked on a dead earlier position — stale
  if (gen.appliedPosition === null) return null; // bootstrapped only, nothing applied
  const stream = await client.projectEventStream.findUnique({ where: { projectId }, select: { nextPosition: true } });
  const head = stream ? stream.nextPosition - 1n : -1n;
  if (gen.appliedPosition < head) return null; // checkpoint lags the committed stream — not current
  return { id: gen.id, generation: gen.generation };
}
