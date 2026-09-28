import { Prisma } from '@prisma/client';

/**
 * Phase 6 task 4d unit 4d-ii-a / A6e — the SERVER-GENERATION FENCE (the staging document
 * `2026-09-26-4d-ii-a-additive-units.md`, "The drain").
 *
 * Every build compiles a monotone server generation. At startup a process reads the persisted
 * minimum — `ServerGeneration`, written ONLY by migrations and only ever RAISED — and refuses to
 * start when that minimum is greater than its own generation. A6e's migration sets the minimum to
 * A6e's generation (1), so nothing running is refused; A8b's raises it to A8b's, and from then on
 * every A6-to-A8a build, an A7 image included, is refused at startup exactly as a stale
 * `catalogVersion` is. The check has to be compiled into every build it must refuse, which is why it
 * ships here and not in A8b.
 *
 * This is NOT a consumer contract version: only A7 changes those. It is the release lineage, an
 * integer that moves when a migration must fence out every earlier build.
 *
 * Fail closed on an absent row (#640 Codex finding 4110816159's fence is only a fence if a process
 * cannot start around it): a fenced build whose database carries no minimum has not had its own
 * migration run, and `scripts/migrate.sh` runs every migration before the process starts.
 *
 * THE READ IS SERIALIZED WITH THE RAISE (#663's review round 1, finding 2). The admission read takes
 * the singleton row `FOR SHARE` inside a transaction the bootstrap holds until the process SERVES —
 * its catalog synced, its lease registered. A raising migration's UPDATE takes the row FOR NO KEY
 * UPDATE, which conflicts with FOR SHARE, so a raise cannot commit between a process's admission and
 * its serving: it waits for every process in that window, and a process that starts after it blocks
 * on the row, then reads the raised minimum and is refused. A plain READ COMMITTED select let an
 * older image read the old minimum, have the raise commit under it, and go on to serve — exactly
 * the stale image the fence exists to exclude.
 */

/**
 * How long the bootstrap may hold the admission transaction (and the row's SHARE lock) before Prisma
 * rolls it back — which aborts boot, fail closed. Generous: it spans the catalog sync, the delivery
 * expansion and the lease registration, and the relay re-runs the expansion every pass anyway.
 */
export const SERVER_GENERATION_FENCE_HOLD_MS = 600_000;

/** THIS build's server generation. Raised by the unit whose migration raises the persisted minimum. */
export const SERVER_GENERATION = 1;

/** The migration that installs the fence and writes the first minimum; the unit test pins its literal to the constant. */
export const SERVER_GENERATION_MIGRATION = '20280101000000_phase6_t4d_ii_a6e_generation_fence';

export interface PersistedServerMinimum {
  minimumGeneration: number;
  raisedBy: string;
  raisedAt: Date;
}

export type ServerGenerationVerdict =
  | { admitted: true; minimum: PersistedServerMinimum }
  | { admitted: false; reason: string; minimum: PersistedServerMinimum | null };

type GenerationDb = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * The persisted minimum, or null on a database that carries no row (the migration has not run).
 * With `forShare`, the row is locked `FOR SHARE` in the caller's transaction: the admission read,
 * which the bootstrap holds until the process serves so no raise can commit under it.
 */
export async function readServerMinimum(db: GenerationDb, opts: { forShare?: boolean } = {}): Promise<PersistedServerMinimum | null> {
  const rows = await db.$queryRaw<Array<{ minimumGeneration: number; raisedBy: string; raisedAt: Date }>>(opts.forShare
    ? Prisma.sql`SELECT "minimumGeneration", "raisedBy", "raisedAt" FROM "ServerGeneration" WHERE "key" = 'singleton' FOR SHARE`
    : Prisma.sql`SELECT "minimumGeneration", "raisedBy", "raisedAt" FROM "ServerGeneration" WHERE "key" = 'singleton'`);
  const row = rows[0];
  return row ? { minimumGeneration: Number(row.minimumGeneration), raisedBy: row.raisedBy, raisedAt: row.raisedAt } : null;
}

/** The pure judgement: refused on no row, refused when the minimum exceeds the compiled generation. */
export function judgeServerGeneration(compiled: number, minimum: PersistedServerMinimum | null): ServerGenerationVerdict {
  if (!minimum) {
    return {
      admitted: false,
      minimum,
      reason: `no persisted server-generation minimum: "ServerGeneration" carries no row, so migration ${SERVER_GENERATION_MIGRATION} has not run on this database — run the migrations (scripts/migrate.sh) before starting a fenced build`,
    };
  }
  if (minimum.minimumGeneration > compiled) {
    return {
      admitted: false,
      minimum,
      reason: `this build compiles server generation ${compiled}, below the persisted minimum ${minimum.minimumGeneration} raised by ${minimum.raisedBy} at ${minimum.raisedAt.toISOString()} — an older build is REFUSED at startup so a drained release cannot come back (the staging document, "The drain"). Deploy the release carrying that migration or a later one.`,
    };
  }
  return { admitted: true, minimum };
}

/**
 * The startup fence. Called FIRST by the outbox bootstrap, before the consumer catalog is synced,
 * so a refused process writes nothing. A refusal aborts boot like a failed catalog sync.
 *
 * `db` MUST be a transaction client the caller holds open until the process serves: the read locks
 * the row `FOR SHARE`, and that lock is what keeps a raise from committing under the admission.
 */
export async function assertServerGenerationAdmitted(
  db: GenerationDb,
  log: { log(message: string): void } = { log: () => {} },
  compiled: number = SERVER_GENERATION,
): Promise<PersistedServerMinimum> {
  const verdict = judgeServerGeneration(compiled, await readServerMinimum(db, { forShare: true }));
  if (!verdict.admitted) throw new Error(`server-generation fence: ${verdict.reason}`);
  log.log(`server generation ${compiled} admitted (persisted minimum ${verdict.minimum.minimumGeneration}, raised by ${verdict.minimum.raisedBy})`);
  return verdict.minimum;
}
