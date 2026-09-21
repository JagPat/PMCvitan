// The participant lifecycle owner (reform-1b, layer α) — the bounded API the lock-order verdict state
// machine (layer β, apps/api/test/invariants/lock-order-probe.ts) is built on. This layer knows nothing
// about lock order; its single concern is that NO database operation the probe starts outlives the
// probe's return. apps/api/test/integration/lock-lifecycle.test.ts drives it against real PostgreSQL,
// showing each lifetime guarantee FAIL when the guarantee is removed and hold when it is kept.
//
// The guarantees this layer owns, and why each exists:
//   * ONE absolute budget, checked up front. `assertBudget` computes the probe's whole worst case from
//     the bounds a caller actually passes and refuses — through the cleanup barrier, never by returning —
//     any configuration that could not name a hang before the per-test timeout kills the test. The worst
//     case is the SEQUENTIAL success path: readiness, the initial inspection, a (successful) release, the
//     settle/competitor waits, the terminal verification AND the final cleanup abort — controls and later
//     phases are summed, never treated as alternatives.
//   * Every operation the probe runs against the database — participant OR control (release/abort) — is
//     REGISTERED and CANCELLABLE. Registration records when it began on a MONOTONIC clock (immune to wall
//     -clock jumps) and the exact bound after which the database will have released any lock it holds; it
//     hands the op the shared cancel signal and never lets it become an unhandled rejection. Nothing the
//     probe runs against the database bypasses this registration and its drain.
//   * CLOSE-BEFORE-DRAIN. Once `close()` (or `finalize()`) has run, `start` begins NO new operation.
//   * BOUNDED controls. `control` (release, abort) and the cleanup closers run their database call as a
//     registered operation and race it against a declared bound, so a control that neither resolves nor
//     rejects is named AND drained rather than left to retain a connection or lock past the barrier.
//   * ONE unconditional final barrier. `finalize()` runs once on every exit path: it closes, cancels,
//     runs every registered closer (bounded), then awaits EVERY registered operation to its own recorded
//     lock bound — never short-circuited by any verdict the consumer reached.

import { performance } from 'node:perf_hooks';
import { ProbeFailure } from './probes';

export { ProbeFailure };

export const reason = (error: unknown) => String((error as Error)?.message ?? error);
export const failureOf = (error: unknown, fallback: string) => error ?? new Error(fallback);
export const isStuck = (v: unknown): v is { stuck: true } => typeof v === 'object' && v !== null && 'stuck' in v;
/** a MONOTONIC clock: participant lifetimes are measured with this so a wall-clock jump (VM resume, NTP
 * correction) can never make a live holder look expired and let the barrier return while it still holds. */
export const monotonic = (): number => performance.now();

/** invoke a callback through a promise boundary: a synchronous throw is a rejection, never an escape */
export const invoke = <T,>(fn: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => { try { Promise.resolve(fn()).then(resolve, reject); } catch (error) { reject(error); } });

/** race a promise against a timeout; the timer is always cleared, so a settled probe leaves nothing pending */
export const within = <T,>(promise: Promise<T>, ms: number): Promise<T | { stuck: true }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<{ stuck: true }>((resolve) => { timer = setTimeout(() => resolve({ stuck: true }), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};

// The integration suite's per-test timeout for this unit (the suite pins the file to it via vi.setConfig).
// The probe's honest worst case is the whole SEQUENTIAL success path plus the bounded cleanup of every
// operation; that exceeds a bare 30s, so this unit runs under a wider bound. `worstCase` must stay below
// it or the probe cannot name a hang before Vitest kills the test.
export const TEST_TIMEOUT_MS = 50_000;
export const GRACE_MS = 2_000;
export const READINESS_MARGIN_MS = 3_000;

/** the default transaction bounds a fixture uses; a caller may override per call, and the barrier's drain
 * and the budget are computed from whatever it is actually given (never from a hidden constant). Each
 * `*TxMs` is a transaction's own timeout, so even a fixture whose abort() fails has its lock reclaimed by
 * the database and awaited out in cleanup within the budget, never left until an undeclared backstop. */
export const DEFAULT_LIFETIMES = { maxWaitMs: 2_000, contenderTxMs: 6_000, competitorTxMs: 9_000, holderTxMs: 12_000, verifyTxMs: 6_000 } as const;
export type Lifetimes = { maxWaitMs: number; contenderTxMs: number; competitorTxMs: number; holderTxMs: number; verifyTxMs: number };

/** the settle window (verdict wait) MUST exceed the contender's transaction lifetime, so a guard the
 * database rolls back at its timeout has its lock RELEASE observed rather than mistaken for a hang. */
export const settleFloor = (l: Lifetimes) => l.maxWaitMs + l.contenderTxMs;
/** a participant's worst-case lock lifetime after it starts (on the monotonic clock): acquisition cap
 * plus its transaction timeout, less however long it has already run. */
export const lockBound = (startedAt: number, txMs: number, l: Lifetimes) => l.maxWaitMs + txMs + GRACE_MS - (monotonic() - startedAt);
/** the holder becomes ready promptly (a free row plus a capped acquisition); readiness is NOT coupled to
 * the settle window, which would make a healthy holder's readiness deadline the dominant budget term. */
export const holderReadyMs = (l: Lifetimes) => l.maxWaitMs + READINESS_MARGIN_MS;
export const inspectWindowMs = (l: Lifetimes) => l.maxWaitMs + 3_000;
/** the SAFETY net for an inspection: a well-behaved fixture bounds its own polling at inspectWindowMs;
 * this sits strictly above that so a fixture returning at its own budget is never cut off, yet a query
 * that hangs forever is still named and cleaned up. */
export const inspectCeilingMs = (l: Lifetimes) => inspectWindowMs(l) + GRACE_MS;
/** the bound on a control callback (release, abort): a prompt commit/rollback, bounded above a capped
 * acquisition so a control that neither resolves nor rejects is named without stalling the barrier. */
export const controlBound = (l: Lifetimes) => l.maxWaitMs + GRACE_MS;

/** the worst-case wall time; it MUST be under TEST_TIMEOUT_MS or the probe cannot name a hung guard. Two
 * things must fit: the SEQUENTIAL verdict path (readiness, the initial inspection, a successful release,
 * the settle/competitor waits, the terminal verification, and the final cleanup abort — summed because
 * they run one after another), AND the drain of EVERY participant to its own lock-release deadline. That
 * deadline is a participant's START OFFSET on the sequential path plus its acquisition cap and its
 * transaction timeout — so a late-starting operation (the verifier, the competitor) whose transaction
 * outlives the sequential path is counted from where it actually begins, never as though it started at
 * probe time. Enumerating every participant here is what keeps a long contender/verify tx, or a settle
 * window below the contender's own lifetime, from being accepted and then killing the test in cleanup. */
export const worstCase = (l: Lifetimes, settleMs: number) => {
  const readied = holderReadyMs(l);
  const afterInspect = readied + inspectCeilingMs(l);          // the contender starts after the initial inspection
  const afterRelease = afterInspect + controlBound(l);         // the competitor starts at observed(), ~after release
  const participantsPhase = Math.max(settleMs, l.maxWaitMs + l.contenderTxMs, l.maxWaitMs + l.competitorTxMs);
  const afterParticipants = afterRelease + participantsPhase;  // the verifier starts after the participants settle
  const verdictPath = afterParticipants + inspectCeilingMs(l) /* verify wait */ + controlBound(l) /* final abort */;
  // each participant's lock-release deadline = its start offset + acquisition cap + transaction timeout
  const holderEnd = l.maxWaitMs + l.holderTxMs + GRACE_MS;                              // starts ~probe time
  const contenderEnd = afterInspect + l.maxWaitMs + l.contenderTxMs + GRACE_MS;
  const competitorEnd = afterRelease + l.maxWaitMs + l.competitorTxMs + GRACE_MS;
  const verifyEnd = afterParticipants + l.maxWaitMs + l.verifyTxMs + GRACE_MS;
  return Math.max(verdictPath, holderEnd, contenderEnd, competitorEnd, verifyEnd) + GRACE_MS;
};

/** a started, registered operation the lifecycle owns and must not let outlive the probe */
export type Participant = {
  name: string;
  promise: Promise<unknown>;
  startedAt: number; // on the monotonic clock
  txMs: number; // its transaction timeout; the database releases its lock by startedAt + maxWait + txMs
};

/** the handle `start` returns: the operation's result promise, its identity, and whether it actually began
 * (false when the lifecycle was already closed — the factory was never invoked, so no lock was taken). */
export type Started<T> = { name: string; startedAt: number; txMs: number; result: Promise<T>; started: boolean };

export type Lifecycle = {
  readonly lifetimes: Lifetimes;
  /** the shared cooperative-cancel signal handed to every started operation and every control */
  readonly signal: AbortSignal;
  /** true once close()/finalize() has begun: no new operation may start */
  closed: () => boolean;
  /** refuse, through the cleanup barrier, a configuration whose worst case cannot fit the per-test timeout */
  assertBudget: (settleMs: number) => void;
  /** register and run a cancellable operation; when already closed the factory is NOT invoked (started:false).
   * This is the ONLY way to run a database operation — the standalone `within` helper bounds a wait on the
   * returned `.result`, never a raw query, so nothing runs against the database outside this registration. */
  start: <T>(name: string, factory: (signal: AbortSignal) => Promise<T>, txMs: number) => Started<T>;
  /** run a bounded control callback (release/abort) now; its database call is REGISTERED with its own
   * declared transaction bound (`txMs`, 0 for a control that holds no lock of its own) so the barrier drains
   * it to that bound even if it times out. REFUSED once the lifecycle is closed (finalize's own closers use
   * an internal path). Returns the failure (rejection, timeout, or refusal) or undefined. */
  control: (fn: () => Promise<void>, label: string, txMs?: number, ms?: number) => Promise<Error | undefined>;
  /** register a bounded cleanup control the final barrier always runs before draining (e.g. the holder abort) */
  onClose: (fn: () => Promise<void>, label: string) => void;
  /** the failure recorded by a closer that rejected or timed out during finalize, if any */
  closerFailure: (label: string) => Error | undefined;
  /** abort the shared cancel signal with a reason (cooperative operations reject with it) */
  cancel: (reason: unknown) => void;
  /** mark closed WITHOUT draining: no new operation may start from here on */
  close: () => void;
  /** the one unconditional barrier (idempotent): close, cancel, run every closer bounded, then await every
   * registered operation to its own recorded lock bound. No lock any operation took outlives this return. */
  finalize: () => Promise<void>;
};

export function createLifecycle(l: Lifetimes): Lifecycle {
  const participants: Participant[] = [];
  const closers: Array<{ fn: () => Promise<void>; label: string }> = [];
  const closerFailures = new Map<string, Error>();
  const controller = new AbortController();
  let closedFlag = false;
  let finalizePromise: Promise<void> | undefined;

  // raw registration (no closed check) — every database operation, participant or control, lands here so
  // the barrier's drain loop owns it. A control op holds no _probe_lock transaction of its own, so it is
  // registered with txMs 0 and drained to the acquisition+grace bound.
  const register = (name: string, promise: Promise<unknown>, txMs: number): Participant => {
    const p: Participant = { name, promise, startedAt: monotonic(), txMs };
    promise.catch(() => undefined); // registered operations are awaited in finalize; never an unhandled rejection meanwhile
    participants.push(p);
    return p;
  };

  // the internal control path: run the callback as a REGISTERED operation with its own declared transaction
  // bound (txMs), so a timed-out control is drained by the barrier to that bound — never left to retain a
  // connection or hold a lock after finalize returns. Used by both the public control() and finalize's closers.
  const runControl = async (fn: () => Promise<void>, label: string, txMs: number, ms: number): Promise<Error | undefined> => {
    const op = invoke(fn);
    register(`control:${label}`, op, txMs);
    const outcome = await within(op.then(() => undefined, (error: unknown) => failureOf(error, `${label} rejected`)), ms);
    return isStuck(outcome) ? new Error(`${label} did not settle within ${ms}ms`) : outcome as Error | undefined;
  };

  return {
    lifetimes: l,
    signal: controller.signal,
    closed: () => closedFlag,
    assertBudget: (settleMs: number) => {
      const wc = worstCase(l, settleMs);
      if (wc >= TEST_TIMEOUT_MS) {
        throw new ProbeFailure(`the probe's worst case (${wc}ms for maxWait=${l.maxWaitMs}, holderTx=${l.holderTxMs}, contenderTx=${l.contenderTxMs}, competitorTx=${l.competitorTxMs}, verifyTx=${l.verifyTxMs}, settle=${settleMs}) does not fit under the ${TEST_TIMEOUT_MS}ms per-test timeout`);
      }
    },
    start: <T,>(name: string, factory: (signal: AbortSignal) => Promise<T>, txMs: number): Started<T> => {
      if (closedFlag) {
        // close-before-drain: once cleanup has begun no new database operation may start, or it could
        // acquire a lock after the drain loop already passed and outlive the probe's return.
        return { name, startedAt: monotonic(), txMs, result: Promise.resolve(undefined as unknown as T), started: false };
      }
      const result = invoke(() => factory(controller.signal));
      const p = register(name, result, txMs);
      return { name, startedAt: p.startedAt, txMs, result, started: true };
    },
    control: (fn: () => Promise<void>, label: string, txMs = 0, ms = controlBound(l)): Promise<Error | undefined> => {
      // close-before-drain applies to controls too: a public control after close would append an operation
      // the drain loop has already passed. finalize's own closers run through the internal runControl.
      if (closedFlag) return Promise.resolve(new Error(`${label} refused: the lifecycle is closed`));
      return runControl(fn, label, txMs, ms);
    },
    onClose: (fn: () => Promise<void>, label: string) => { closers.push({ fn, label }); },
    closerFailure: (label: string) => closerFailures.get(label),
    cancel: (reasonValue: unknown) => { if (!controller.signal.aborted) controller.abort(reasonValue); },
    close: () => { closedFlag = true; },
    // the one barrier. Concurrent callers must all observe the SAME completion, not just the same "started"
    // flag: the in-flight promise is cached and returned, so a second caller awaits the real drain rather
    // than resolving while the first finalizer and its registered operations are still running.
    finalize: () => {
      if (finalizePromise) return finalizePromise;
      finalizePromise = (async () => {
        closedFlag = true;
        if (!controller.signal.aborted) controller.abort(new ProbeFailure('aborted by lockLifecycle: cleanup'));
        // run every registered cleanup control through the internal path (closed-guard does not apply to
        // finalize's own closers), recording — never throwing — its failure. Each registers its database
        // call as a participant, so the drain loop below owns it too.
        for (const c of closers) {
          const failure = await runControl(c.fn, c.label, 0, controlBound(l));
          if (failure !== undefined && !closerFailures.has(c.label)) closerFailures.set(c.label, failure);
        }
        // await every registered operation to its own recorded lock bound. A task still unsettled after that
        // bound holds no lock — its transaction, if any, was rolled back by the database at its timeout; it
        // hangs only in JS. Either way no lock it took outlives this return. The list can grow while a closer
        // runs (a closer registers its own op), so index rather than snapshot.
        for (let i = 0; i < participants.length; i += 1) {
          const p = participants[i]!;
          const left = Math.max(GRACE_MS, lockBound(p.startedAt, p.txMs, l));
          await within(p.promise.then(() => undefined, () => undefined), left);
        }
      })();
      return finalizePromise;
    },
  };
}
