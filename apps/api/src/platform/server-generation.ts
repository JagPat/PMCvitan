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
 * THE READ IS SERIALIZED WITH THE RAISE (#663's review round 1, finding 2; round 2, finding 1). The
 * admission read takes the singleton row `FOR SHARE` inside a transaction ({@link holdAdmission})
 * the process holds until it ACTUALLY SERVES — its catalog synced, its lease registered, its relay
 * started and its HTTP listener open, which `main.ts` reports by releasing the hold after
 * `app.listen()`. A raising migration's UPDATE takes the row FOR NO KEY UPDATE, which conflicts with
 * FOR SHARE, so a raise cannot commit between a process's admission and its serving: it waits for
 * every process in that window, and a process that starts after it blocks on the row, then reads
 * the raised minimum and is refused. A plain READ COMMITTED select let an older image read the old
 * minimum, have the raise commit under it, and go on to serve — exactly the stale image the fence
 * exists to exclude; a hold released at the end of `onModuleInit` left the same gap between the
 * commit and the relay start and the listener.
 */

/**
 * How long the bootstrap may hold the admission transaction (and the row's SHARE lock) before Prisma
 * rolls it back — which aborts boot, fail closed. Generous: it spans the catalog sync, the delivery
 * expansion and the lease registration, and the relay re-runs the expansion every pass anyway.
 */
export const SERVER_GENERATION_FENCE_HOLD_MS = 600_000;

/** THIS build's server generation. Raised by the unit whose migration raises the persisted minimum:
 *  1 at A6e (the fence installed), 2 at A8b (the last 4d-ii-a server unit — from here every A6-to-A8a
 *  build, an A7 image included, is refused at startup, which is what makes the drain's minimum release
 *  durable; the staging document, "The drain"). */
export const SERVER_GENERATION = 2;

/** The migration that LAST RAISED the persisted minimum to {@link SERVER_GENERATION} — what the singleton's
 *  `raisedBy` reads after the ledger is applied; the unit test pins its raise literal to the constant. A6e's
 *  `20280101000000_phase6_t4d_ii_a6e_generation_fence` installed the fence and wrote the first minimum. */
export const SERVER_GENERATION_MIGRATION = '20280106000000_phase6_t4d_ii_a8b_finalizer_claimants_fence';

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
 * {@link holdAdmission} is that caller.
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

type AdmissionDb = {
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { maxWait?: number; timeout?: number }): Promise<T>;
};

/** An admission held open: the row's SHARE lock lives until {@link AdmissionHold.release}. */
export interface AdmissionHold {
  /** Resolves with the persisted minimum once the process is admitted AND `serve` has completed; rejects when either refuses. */
  readonly admitted: Promise<PersistedServerMinimum>;
  /** Let the admission transaction commit: the process is actually serving. Idempotent. */
  release(): void;
  /** Settles once the admission transaction has ended (committed, or rolled back on a refusal or a lapsed hold). */
  readonly ended: Promise<void>;
}

export interface HoldAdmissionOptions {
  /**
   * THE HOLD WAS LOST BEFORE THE PROCESS SERVED (#663's review round 3, finding 1): the transaction
   * reached its bound, or its connection failed, after admission but before `release`. The lock is
   * gone, so a raise may have committed under this process; it must not go on to serve. The
   * bootstrap TERMINATES the process here (the container restarts it into a fresh admission),
   * exactly as a lapsed `ReleaseLease` fences its process. Required, so no caller can forget it.
   */
  onLost: (reason: string) => void;
  log?: { log(message: string): void; error?(message: string): void };
  compiled?: number;
  /** The hold's bound; the default is {@link SERVER_GENERATION_FENCE_HOLD_MS}. The live probe shortens it to lapse on purpose. */
  holdMs?: number;
  /** How often the held connection is probed while waiting for the release; the default is {@link SERVER_GENERATION_FENCE_HEARTBEAT_MS}. */
  heartbeatMs?: number;
}

/**
 * How often a held admission probes its own connection (`SELECT 1` on the held transaction) while it
 * waits for the release: a dropped connection is a lost hold, and Prisma reports nothing about an
 * idle transaction on its own.
 */
export const SERVER_GENERATION_FENCE_HEARTBEAT_MS = 5_000;
/** How long before the hold's bound the process gives up on being released: the lock is judged lost from then. */
export const SERVER_GENERATION_FENCE_MARGIN_MS = 30_000;

/**
 * Admit this process and HOLD the admission until it serves. One interactive transaction: the
 * `FOR SHARE` read, then `serve` (the bootstrap's serving steps, on the pooled client — only the lock
 * lives on this connection), then the transaction stays open until {@link AdmissionHold.release}. A
 * refusal, or a `serve` that throws, rejects `admitted` and rolls the transaction back; nothing
 * `serve` wrote on the pooled client is undone by that, because the transaction holds no write.
 *
 * THE HOLD WATCHES ITSELF (#663's review round 3, finding 1). Prisma rolls an interactive transaction
 * back when its `timeout` passes, but tells an IDLE callback nothing: the lock would be gone while the
 * process still believed it held it. So, once admitted and until released, the hold keeps a deadline
 * on the process's monotonic clock — the bound less {@link SERVER_GENERATION_FENCE_MARGIN_MS} — and
 * probes the held connection every {@link SERVER_GENERATION_FENCE_HEARTBEAT_MS}; reaching the
 * deadline or failing a probe is a LOST admission: {@link HoldAdmissionOptions.onLost} is called
 * once, and the transaction is rolled back rather than committed.
 */
export function holdAdmission(
  db: AdmissionDb,
  serve: (minimum: PersistedServerMinimum) => Promise<void>,
  opts: HoldAdmissionOptions,
): AdmissionHold {
  const log = opts.log ?? { log: () => {} };
  const compiled = opts.compiled ?? SERVER_GENERATION;
  const holdMs = opts.holdMs ?? SERVER_GENERATION_FENCE_HOLD_MS;
  const heartbeatMs = opts.heartbeatMs ?? SERVER_GENERATION_FENCE_HEARTBEAT_MS;
  const lostAfterMs = Math.max(1, holdMs - Math.min(SERVER_GENERATION_FENCE_MARGIN_MS, Math.floor(holdMs / 4)));

  let state: 'pending' | 'admitted' | 'refused' = 'pending';
  let released = false;
  let lostReason: string | null = null;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = () => { released = true; resolve(); }; });
  let signalLost!: () => void;
  const lostSignal = new Promise<void>((resolve) => { signalLost = resolve; });
  let resolveAdmitted!: (minimum: PersistedServerMinimum) => void;
  let rejectAdmitted!: (reason: unknown) => void;
  const admitted = new Promise<PersistedServerMinimum>((resolve, reject) => { resolveAdmitted = resolve; rejectAdmitted = reject; });

  /** the ONE transition to lost: after admission, before release, once */
  const lose = (why: string): void => {
    if (state !== 'admitted' || released || lostReason) return;
    lostReason = `the server-generation admission was lost before this process served: ${why}`;
    log.error?.(`FENCED — ${lostReason}`);
    signalLost();
    opts.onLost(lostReason);
  };

  const startedAt = performance.now();
  const ended = db.$transaction(async (fence) => {
    let minimum: PersistedServerMinimum;
    try {
      minimum = await assertServerGenerationAdmitted(fence, log, compiled);
      await serve(minimum);
    } catch (e) {
      state = 'refused';
      rejectAdmitted(e);
      throw e;
    }
    state = 'admitted';
    resolveAdmitted(minimum);
    // watch the hold until it is released: the deadline on the monotonic clock, the probe on the connection
    const deadline = setTimeout(
      () => lose(`the hold reached its bound (${holdMs} ms less the margin) with the process not yet serving`),
      Math.max(0, startedAt + lostAfterMs - performance.now()),
    );
    deadline.unref?.();
    let probing = false;
    const heartbeat = setInterval(() => {
      if (probing || released || lostReason) return;
      probing = true;
      fence.$queryRaw(Prisma.sql`SELECT 1`).then(() => { probing = false; }, (e: unknown) => {
        probing = false;
        lose(`the held connection failed a probe: ${e instanceof Error ? e.message : String(e)}`);
      });
    }, heartbeatMs);
    heartbeat.unref?.();
    try {
      await Promise.race([held, lostSignal]);
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
    }
    // a lost hold is rolled back, never committed: the throw is the rollback
    if (lostReason) throw new Error(lostReason);
  }, { maxWait: holdMs, timeout: holdMs }).catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (state === 'pending') {
      // the transaction ended before the admission could be judged: boot aborts on it
      state = 'refused';
      rejectAdmitted(e);
    } else if (state === 'admitted') {
      // ended under us after admission (a closed connection Prisma reported first): lost unless released
      lose(`the admission transaction ended: ${message}`);
    }
    // refused, released, or already lost: nothing further; let the callback finish if it still waits
    release();
  });
  // `admitted` is always awaited by the caller; `ended` may not be, so it never rejects
  admitted.catch(() => {});
  return { admitted, release: () => release(), ended };
}
