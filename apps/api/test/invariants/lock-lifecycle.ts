// The participant lifecycle owner (reform-1b, layer α) — the bounded API the lock-order verdict state
// machine (layer β, apps/api/test/invariants/lock-order-probe.ts) is built on. This layer knows nothing
// about lock order; its single concern is that NO database operation the probe starts outlives the
// probe's return. apps/api/test/integration/lock-lifecycle.test.ts drives it against real PostgreSQL,
// showing each lifetime guarantee FAIL when the guarantee is removed and hold when it is kept.
//
// The guarantees this layer owns, and why each exists:
//   * ONE absolute budget, checked up front. `assertBudget` computes the probe's whole worst case from
//     the bounds a caller actually passes and refuses — through the cleanup barrier, never by returning —
//     any configuration that could not name a hang before the per-test timeout kills the test.
//   * Every started operation is a REGISTERED, CANCELLABLE participant. `start` records when it began and
//     the exact bound after which the database will have released any lock it holds (its acquisition cap
//     plus its transaction timeout), hands it the shared cancel signal, and never lets it become an
//     unhandled rejection. Nothing the probe runs against the database bypasses this registration.
//   * CLOSE-BEFORE-DRAIN. Once `close()` (or `finalize()`) has run, `start` begins NO new operation — a
//     late caller that ignored cancellation can never open a fresh database operation that would acquire
//     a lock after the drain loop has already passed.
//   * BOUNDED controls. `control` (release, abort) and the cleanup closers are raced against a declared
//     bound, so a control callback that neither resolves nor rejects cannot stall the barrier and hand
//     the test to the generic timeout with a lock still held.
//   * ONE unconditional final barrier. `finalize()` runs on every exit path: it closes, cancels, runs
//     every registered closer (bounded), then awaits EVERY registered participant to its own recorded
//     lock bound — never short-circuited by any verdict the consumer reached.

import { ProbeFailure } from './probes';

export { ProbeFailure };

export const reason = (error: unknown) => String((error as Error)?.message ?? error);
export const failureOf = (error: unknown, fallback: string) => error ?? new Error(fallback);
export const isStuck = (v: unknown): v is { stuck: true } => typeof v === 'object' && v !== null && 'stuck' in v;

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
// The probe's honest worst case — readiness, the initial inspection, the settle/competitor waits, THEN the
// terminal verification, plus the bounded cleanup of every participant — exceeds a bare 30s, so this unit
// runs under a wider bound; `worstCase` must stay below it or the probe cannot name a hang.
export const TEST_TIMEOUT_MS = 40_000;
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
/** a participant's worst-case lock lifetime after it starts: acquisition cap plus its transaction timeout */
export const lockBound = (startedAt: number, txMs: number, l: Lifetimes) => l.maxWaitMs + txMs + GRACE_MS - (Date.now() - startedAt);
/** the holder becomes ready promptly (a free row plus a capped acquisition); readiness is NOT coupled to
 * the settle window, which would make a healthy holder's readiness deadline the dominant budget term. */
export const holderReadyMs = (l: Lifetimes) => l.maxWaitMs + READINESS_MARGIN_MS;
export const inspectWindowMs = (l: Lifetimes) => l.maxWaitMs + 3_000;
/** the SAFETY net for an inspection: a well-behaved fixture bounds its own polling at inspectWindowMs;
 * this sits strictly above that so a fixture returning at its own budget is never cut off, yet a query
 * that hangs forever is still named and cleaned up. */
export const inspectCeilingMs = (l: Lifetimes) => inspectWindowMs(l) + GRACE_MS;
/** the bound on a control callback (release, abort): a prompt commit/rollback, bounded like a DB op. */
export const controlBound = (l: Lifetimes) => inspectCeilingMs(l);

/** the worst-case wall time; it MUST be under TEST_TIMEOUT_MS or the probe cannot name a hung guard. The
 * dominant term is the SEQUENTIAL success path: readiness and the initial inspection, then the
 * contender-settle and competitor-land waits (which run CONCURRENTLY, hence a max), and THEN the terminal
 * verification — verification is ADDED to that phase, never treated as an alternative to it. Each
 * participant's own lock lifetime (awaited out in cleanup) and a hung release+abort are accounted too. */
export const worstCase = (l: Lifetimes, settleMs: number) => {
  const afterRelease = holderReadyMs(l) + inspectCeilingMs(l);
  const participantsPhase = Math.max(settleMs, l.maxWaitMs + l.competitorTxMs);
  const afterParticipants = afterRelease + participantsPhase;
  return Math.max(
    l.maxWaitMs + l.holderTxMs,                    // the holder's own lock lifetime from its start
    afterRelease + controlBound(l) * 2,            // a hung release AND abort, named before settle/verify
    afterParticipants + inspectCeilingMs(l),       // the SEQUENTIAL success path: settle/competitor, THEN the verify wait
    afterParticipants + l.maxWaitMs + l.verifyTxMs, // the verify lock awaited out in cleanup
    afterRelease + l.maxWaitMs + l.contenderTxMs,  // the contender lock awaited out in cleanup
    afterRelease + l.maxWaitMs + l.competitorTxMs, // the competitor lock awaited out in cleanup
  ) + GRACE_MS * 2;
};

/** a started, registered operation the lifecycle owns and must not let outlive the probe */
export type Participant = {
  name: string;
  promise: Promise<unknown>;
  startedAt: number;
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
  /** register and run a cancellable operation; when already closed the factory is NOT invoked (started:false) */
  start: <T>(name: string, factory: (signal: AbortSignal) => Promise<T>, txMs: number) => Started<T>;
  /** bound any promise against a declared deadline (a stuck query is named, never awaited forever) */
  bounded: <T>(promise: Promise<T>, ms: number) => Promise<T | { stuck: true }>;
  /** run a bounded control callback (release/abort) now; returns the failure (rejection or timeout) or undefined */
  control: (fn: () => Promise<void>, label: string, ms?: number) => Promise<Error | undefined>;
  /** register a bounded cleanup control the final barrier always runs before draining (e.g. the holder abort) */
  onClose: (fn: () => Promise<void>, label: string) => void;
  /** the failure recorded by a closer that rejected or timed out during finalize, if any */
  closerFailure: (label: string) => Error | undefined;
  /** abort the shared cancel signal with a reason (cooperative operations reject with it) */
  cancel: (reason: unknown) => void;
  /** mark closed WITHOUT draining: no new operation may start from here on */
  close: () => void;
  /** the one unconditional barrier: close, cancel, run every closer bounded, then await every started
   * operation to its own recorded lock bound. No lock any operation took outlives this return. */
  finalize: () => Promise<void>;
};

export function createLifecycle(l: Lifetimes): Lifecycle {
  const participants: Participant[] = [];
  const closers: Array<{ fn: () => Promise<void>; label: string }> = [];
  const closerFailures = new Map<string, Error>();
  const controller = new AbortController();
  let closedFlag = false;
  let budgetChecked = false;

  const bounded = <T,>(promise: Promise<T>, ms: number) => within(promise, ms);

  const control = async (fn: () => Promise<void>, label: string, ms = controlBound(l)): Promise<Error | undefined> => {
    const outcome = await within(invoke(fn).then(() => undefined, (error: unknown) => failureOf(error, `${label} rejected`)), ms);
    return isStuck(outcome) ? new Error(`${label} did not settle within ${ms}ms`) : outcome as Error | undefined;
  };

  return {
    lifetimes: l,
    signal: controller.signal,
    closed: () => closedFlag,
    assertBudget: (settleMs: number) => {
      budgetChecked = true;
      const wc = worstCase(l, settleMs);
      if (wc >= TEST_TIMEOUT_MS) {
        throw new ProbeFailure(`the probe's worst case (${wc}ms for maxWait=${l.maxWaitMs}, holderTx=${l.holderTxMs}, contenderTx=${l.contenderTxMs}, competitorTx=${l.competitorTxMs}, verifyTx=${l.verifyTxMs}, settle=${settleMs}) does not fit under the ${TEST_TIMEOUT_MS}ms per-test timeout`);
      }
    },
    start: <T,>(name: string, factory: (signal: AbortSignal) => Promise<T>, txMs: number): Started<T> => {
      if (closedFlag) {
        // close-before-drain: once cleanup has begun no new database operation may start, or it could
        // acquire a lock after the drain loop already passed and outlive the probe's return.
        return { name, startedAt: Date.now(), txMs, result: Promise.resolve(undefined as unknown as T), started: false };
      }
      const startedAt = Date.now();
      const result = invoke(() => factory(controller.signal));
      result.catch(() => undefined); // registered operations are awaited in finalize; never an unhandled rejection meanwhile
      participants.push({ name, promise: result, startedAt, txMs });
      return { name, startedAt, txMs, result, started: true };
    },
    bounded,
    control,
    onClose: (fn: () => Promise<void>, label: string) => { closers.push({ fn, label }); },
    closerFailure: (label: string) => closerFailures.get(label),
    cancel: (reasonValue: unknown) => { if (!controller.signal.aborted) controller.abort(reasonValue); },
    close: () => { closedFlag = true; },
    finalize: async () => {
      closedFlag = true;
      if (!controller.signal.aborted) controller.abort(new ProbeFailure('aborted by lockLifecycle: cleanup'));
      // run every registered cleanup control, bounded, recording (never throwing) its failure
      for (const c of closers) {
        const failure = await control(c.fn, c.label);
        if (failure !== undefined && !closerFailures.has(c.label)) closerFailures.set(c.label, failure);
      }
      // await every started operation to its own recorded lock bound. A task still unsettled after that
      // bound holds no lock — its transaction, if any, was rolled back by the database at its timeout; it
      // hangs only in JS. Either way no lock it took outlives this return.
      for (const p of participants) {
        const left = Math.max(GRACE_MS, lockBound(p.startedAt, p.txMs, l));
        await within(p.promise.then(() => undefined, () => undefined), left);
      }
      void budgetChecked;
    },
  };
}
