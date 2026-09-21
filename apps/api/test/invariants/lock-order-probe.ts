// The lock-order probe (reform-1b), kept as its own unit — docs/REVIEW_RUBRIC.md points here and
// apps/api/test/integration/lock-order-probe.test.ts drives it against real PostgreSQL, showing it
// FAIL on each broken guard and PASS on the corrected one. Importing it proves nothing.
//
// A guard that reads a serialized row's status must LOCK it first and hold that lock through its
// mutation. The probe interleaves three real database sessions to witness that order, and — the
// concern of this unit — it OWNS the lifetime of every session it starts: whatever verdict it
// reaches, no holder, contender, or competitor lock outlives the probe's return.
//
// The lifetime discipline, and why each piece exists:
//   * Every started task is a registered PARTICIPANT (holder, contender, competitor). Registration
//     records when it started and the exact bound after which the database will have released any
//     lock it holds (its acquisition cap plus its transaction timeout). The probe never tracks a
//     task by an ad-hoc timestamp it might forget to wait out.
//   * ONE cleanup barrier (`finalize`) runs on every exit path. It aborts the holder, cancels the
//     contender, and then awaits EVERY registered participant to its own recorded bound — always,
//     regardless of any verdict already reached. A recorded outcome never lets a still-locked task
//     escape the probe (the defect where a short settle set `stuck`, cleanup then returned early,
//     and a leaked contender kept the row).
//   * The transaction bounds are EXPLICIT inputs (`maxWaitMs`, `contenderTxMs`, `competitorTxMs`),
//     the same numbers the fixture's own `$transaction` calls use, so the barrier's deadline can
//     never diverge from what the database actually enforces (the defect where the fixture allowed
//     a larger `maxWait` than the cleanup wait assumed, so a late-acquiring competitor outlived it).
//   * `contenderSettleMs` tunes only how long the probe waits for the VERDICT before declaring the
//     contender stuck; it never shortens cleanup. A caller may pass a small settle for a fast
//     verdict and the barrier still waits out the contender's full transaction bound.
//   * EVERY callback the probe awaits is bounded (readiness, both inspections, release, abort and the
//     terminal verify). A control or query callback that neither resolves nor rejects must never
//     block settle()/finalize() and hand the test to Vitest's generic timeout with a lock undrained.
//   * INFRASTRUCTURE failure is classified before any lock-order diagnosis. A holder whose
//     transaction dies (monitored continuously, not only until readiness), a release that rejects or
//     hangs, a contender that crashes before it can take the lock, or an inspection that throws is
//     named as what it is — never mistaken for a lock-after-read or an escaped read.
//
// Fixture contract (each callback is real SQL that commits or rolls back; an unexpected throw is a
// failure, never evidence — assert an EXPECTED domain refusal inside the callback):
//   holderReady   locks the row on session A, mutates it, holds the transaction open; its promise
//                 MUST reject if the holder fails or ends before it is ready (couple it to the tx).
//   contenderStarted  runs the guard on session B: it calls observed() the instant its STATUS READ
//                 returns, awaits `proceed`, then mutates on what it read, inside the transaction
//                 that took the lock. `signal` aborts a cooperative guard.
//   inspectBlocked  reports whether another session currently waits on the row.
//   competitor    a competing writer on session C that BLOCKS on the row (no NOWAIT) and resolves
//                 once its write landed; it runs under `competitorTxMs`, so a competitor that
//                 acquires and hangs is rolled back by the database.
//   release / abort  free the holder (abort rolls it back independent of release). Each must settle
//                 promptly; the probe bounds them so a hung control callback cannot stall cleanup.
//   verify(signal)  reads back the terminal ORDER the interleaving must leave. It MUST run its read
//                 inside a BOUNDED transaction (a $transaction with a timeout) — so a read that hangs
//                 after a connection fault is rolled back by the database and its lock reclaimed,
//                 rather than left holding the row past the probe's return and the suite's teardown.
//                 `signal` aborts a cooperative verify when the probe's own bound fires first.

import { ProbeFailure } from './probes';

const fail = (message: string): never => { throw new ProbeFailure(message); };
const reason = (error: unknown) => String((error as Error)?.message ?? error);
const failureOf = (error: unknown, fallback: string) => error ?? new Error(fallback);
const isStuck = (v: unknown): v is { stuck: true } => typeof v === 'object' && v !== null && 'stuck' in v;

/** invoke a fixture callback through a promise boundary: a synchronous throw is a rejection, never an escape */
const invoke = <T,>(fn: () => Promise<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => { try { Promise.resolve(fn()).then(resolve, reject); } catch (error) { reject(error); } });

/** race a promise against a timeout; the timer is always cleared, so a settled probe leaves nothing pending */
const within = <T,>(promise: Promise<T>, ms: number): Promise<T | { stuck: true }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<{ stuck: true }>((resolve) => { timer = setTimeout(() => resolve({ stuck: true }), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};

// The integration suite's per-test timeout for THIS unit (pinned by the suite via vi.setConfig). The
// probe's whole worst case MUST stay below it, or the probe times the test out before it can NAME the
// very hung case it exists to diagnose. The worst case is the SEQUENTIAL success path — readiness, the
// initial inspection, the settle/competitor waits, and THEN the terminal verify() — plus the bounded
// cleanup of every participant; that sum exceeds a bare 30s, so this unit runs under a wider bound than
// the rest of the integration suite. Asserted per call in `worstCase` and pinned by the suite.
export const TEST_TIMEOUT_MS = 40_000;
const GRACE_MS = 2_000;

const READINESS_MARGIN_MS = 3_000;
/** the default transaction bounds a fixture uses; a caller may override per call, and the probe's
 * cleanup and budget are computed from whatever it is actually given (never from a hidden constant).
 * `holderTxMs` is the holder transaction's own timeout: it must exceed the holder's active hold
 * (readiness + the inspection window, before the probe releases it) yet be a DECLARED bound, so that
 * even a fixture whose abort() fails has its holder lock reclaimed by the database and awaited out in
 * cleanup within the budget — never left until an undeclared 20-second backstop. */
export const DEFAULT_LIFETIMES = { maxWaitMs: 2_000, contenderTxMs: 6_000, competitorTxMs: 9_000, holderTxMs: 12_000, verifyTxMs: 6_000 } as const;
export type Lifetimes = { maxWaitMs: number; contenderTxMs: number; competitorTxMs: number; holderTxMs: number; verifyTxMs: number };

/** the settle window (verdict wait) MUST exceed the contender's transaction lifetime, so a guard the
 * database rolls back at its timeout has its lock RELEASE observed rather than mistaken for a hang. */
const settleFloor = (l: Lifetimes) => l.maxWaitMs + l.contenderTxMs;
/** a participant's worst-case lock lifetime after it starts: acquisition cap plus its transaction timeout */
const lockBound = (startedAt: number, txMs: number, l: Lifetimes) => l.maxWaitMs + txMs + GRACE_MS - (Date.now() - startedAt);

/** the holder becomes ready promptly (a free row plus a capped acquisition), so the probe waits at
 * most acquisition + a margin — NOT the settle window — before aborting it and failing. Coupling
 * readiness to settle would make a healthy holder's readiness deadline the dominant budget term. */
const holderReadyMs = (l: Lifetimes) => l.maxWaitMs + READINESS_MARGIN_MS;
const inspectWindowMs = (l: Lifetimes) => l.maxWaitMs + 3_000;
/** the probe's SAFETY net for the initial inspection: a well-behaved fixture bounds its own polling
 * at inspectWindowMs and returns true/false; this net sits strictly above that so a fixture returning
 * at its own budget is never cut off, yet a query that hangs forever is still named and cleaned up. */
const inspectCeilingMs = (l: Lifetimes) => inspectWindowMs(l) + GRACE_MS;
/** the bound on a control callback (release, abort): a prompt commit/rollback, bounded like a DB op so
 * a connection that neither resolves nor rejects cannot block the whole cleanup barrier. */
const controlBound = (l: Lifetimes) => inspectCeilingMs(l);
/** the worst-case wall time; it MUST be under TEST_TIMEOUT_MS or the probe cannot name a hung guard.
 * It is the LATEST any participant's lock is guaranteed released, or the verdict reached, measured
 * from the probe's start, plus grace. The dominant term is the SEQUENTIAL success path: readiness and
 * the initial inspection, then the contender-settle and competitor waits (which run CONCURRENTLY with
 * each other, hence a max), and THEN the terminal verify() — verify is ADDED to that phase, never
 * treated as an alternative to it, because it only runs once both participants have completed. Every
 * one of readiness, inspection, a hung release/abort, settle, each transaction bound and verification
 * is accounted, so an accepted configuration cannot time the test out before cleanup. */
export const worstCase = (l: Lifetimes, settleMs: number) => {
  const afterRelease = holderReadyMs(l) + inspectCeilingMs(l);
  // the contender-settle wait and the competitor-land wait run concurrently (both participants start
  // together at observed()); the phase is the longer of the two, not their sum.
  const participantsPhase = Math.max(settleMs, l.maxWaitMs + l.competitorTxMs);
  const afterParticipants = afterRelease + participantsPhase;
  return Math.max(
    l.maxWaitMs + l.holderTxMs,                              // the holder's own lock lifetime from its start
    afterRelease + controlBound(l) * 2,                      // a hung release AND abort, named before settle/verify
    afterParticipants + inspectCeilingMs(l),                 // the SEQUENTIAL success path: settle/competitor, THEN the verify() wait
    afterParticipants + l.maxWaitMs + l.verifyTxMs,          // the verify lock awaited out in cleanup
    afterRelease + l.maxWaitMs + l.contenderTxMs,            // the contender lock awaited out in cleanup
    afterRelease + l.maxWaitMs + l.competitorTxMs,           // the competitor lock awaited out in cleanup
  ) + GRACE_MS * 2;
};

type Outcome = { ok: true } | { ok: false; error: unknown } | { stuck: true };

/** a task the probe started and must not let outlive its return */
type Participant = {
  name: string;
  promise: Promise<unknown>;
  startedAt: number;
  txMs: number; // its transaction timeout; the database releases its lock by startedAt + maxWait + txMs
};

export async function lockOrderProbe(o: {
  holderReady: () => Promise<void>;
  /** the holder transaction itself. REQUIRED: the probe registers it as a participant so cleanup can
   * await the holder's lock to a declared bound even when release() and abort() both fail, and monitors
   * it after readiness (its promise rejects if the holder dies while it is meant to hold the lock). */
  holderMonitor: () => Promise<unknown>;
  contenderStarted: (milestone: { observed: () => void; proceed: Promise<void>; signal: AbortSignal }) => Promise<unknown>;
  inspectBlocked: () => Promise<boolean>;
  competitor: () => Promise<void>;
  release: () => Promise<void>;
  abort: () => Promise<void>;
  verify: (signal: AbortSignal) => Promise<void>;
  contenderSettleMs?: number;
  lifetimes?: Partial<Lifetimes>;
}) {
  const l: Lifetimes = { ...DEFAULT_LIFETIMES, ...o.lifetimes };
  const settleMs = o.contenderSettleMs ?? settleFloor(l) + GRACE_MS;
  const graceMs = Math.min(settleMs, GRACE_MS);

  // structured ownership: every task the probe starts is registered here and awaited in finalize()
  const participants: Participant[] = [];
  const register = (name: string, promise: Promise<unknown>, txMs: number): Participant => {
    const p: Participant = { name, promise, startedAt: Date.now(), txMs };
    promise.catch(() => undefined); // registered tasks are awaited in finalize; never an unhandled rejection meanwhile
    participants.push(p);
    return p;
  };

  // `released` marks release INITIATION; `releaseCompleted` marks that o.release() actually resolved —
  // the holder committed and gave up its lock. `blockedSeen` records that the contender was observed
  // waiting on the lock. Together they classify a status read: a read that returns while the holder
  // still holds — before release is even initiated, OR during the release window for a contender that
  // was NEVER seen waiting — is a lock-free read (escaped). A correct lock-first contender is seen
  // blocked and unblocks exactly at the holder's COMMIT, which the database grants a hair before
  // o.release() resolves in JS; `blockedSeen` keeps that race from being misread as escaped.
  let released = false; let releaseCompleted = false; let blockedSeen = false;
  let reads = 0; let escaped = false; let timedOut = false; let closed = false;
  let windowOpen = false; let competitorBlocked = false; let landedInWindow = false;
  let abortFailure: unknown; let windowFailure: unknown; let holderTxFailure: unknown; let competitorFailure: unknown;
  let contender: Participant | undefined; let competitor: Participant | undefined;
  let outcome: Outcome | undefined;
  let window: Promise<void> = Promise.resolve();
  const cancel = new AbortController();
  let openWindow!: () => void;
  const proceed = new Promise<void>((resolve) => { openWindow = () => { windowOpen = true; resolve(); }; });

  const abortHolder = async () => {
    // bounded: an abort() that never settles must not block finalize's participant loop; the holder is
    // a registered participant, so even a hung abort leaves the row reclaimed by the holder's tx timeout.
    const outcome = await within(invoke(o.abort).then(() => undefined, (error: unknown) => failureOf(error, 'abort rejected')), controlBound(l));
    const failure = isStuck(outcome) ? new Error(`abort did not settle within ${controlBound(l)}ms`) : outcome;
    if (failure !== undefined && abortFailure === undefined) abortFailure = failure;
  };

  // the settle window is the VERDICT wait only: how long to wait for the contender to finish (or be
  // rolled back at its own transaction timeout) before declaring it stuck. It never governs cleanup.
  const settle = async () => {
    if (contender === undefined || outcome !== undefined) return;
    const race = (ms: number) => within(contender!.promise.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })), ms);
    let settled = await race(settleMs);
    if ('stuck' in settled) { // it did not even reject at its transaction timeout: cancel cooperatively, then a grace
      timedOut = true; openWindow(); cancel.abort(new ProbeFailure('aborted by lockOrderProbe: the contender outlived the settle window'));
      settled = await race(graceMs);
    }
    outcome = settled;
  };

  const observed = () => {
    // once cleanup has begun, a late report from a contender that ignored cancellation must never
    // start a competitor: that competitor would register after finalize's await loop and could take a
    // fresh lock after the probe returns. Record the read for the "never reported" check, then stop.
    if (closed) return;
    reads += 1;
    if (reads > 1) return;
    // escaped = the status read returned while the holder still held its lock. Two cases: (a) the read
    // returned before release was even initiated (the holder unquestionably still holds); (b) it
    // returned during the release window (initiated, not yet committed) for a contender that was never
    // seen waiting on the lock — a lock-free read that slipped in before the holder actually unlocked.
    // A correct lock-first contender (blockedSeen) that unblocks at the COMMIT racing releaseCompleted
    // is NOT escaped: it waited for the lock and took it only as the holder released.
    if (!released || (!releaseCompleted && !blockedSeen)) { escaped = true; openWindow(); return; }
    // the guard read and is holding (or not): start a competitor that BLOCKS on the row, wait until
    // it is seen waiting behind the guard, then let the guard mutate. A competitor that lands first
    // found the row unlocked.
    window = (async () => {
      // The window-phase inspection runs WHILE the guard holds its lock, so it can never usefully
      // outlast the guard's own transaction: past that point the database rolls the guard back, the
      // competitor lands, and a hung inspection could never be named (its own timeout would race a
      // competitor that only landed BECAUSE the guard's tx expired). Bound it STRICTLY below the guard's
      // REMAINING transaction budget (never a floor that could exceed it). If too little tx life is
      // left to inspect at all, name that as a window failure rather than starting a competitor whose
      // landing on the imminent rollback would be misread.
      const remainingTx = contender ? l.contenderTxMs - (Date.now() - contender.startedAt) : inspectCeilingMs(l);
      const windowCeiling = Math.min(inspectCeilingMs(l), remainingTx - GRACE_MS);
      if (windowCeiling <= 0) {
        if (windowFailure === undefined) windowFailure = new Error(`insufficient remaining contender transaction lifetime (${Math.max(0, Math.round(remainingTx))}ms) to inspect the guard's window without outlasting its own lock`);
        openWindow();
        return;
      }
      // the competitor always settles the promise (a failure is recorded, never thrown) so the main
      // flow can read it at verdict time — not only the cleanup barrier
      const c = invoke(o.competitor).then(
        () => { if (!windowOpen) landedInWindow = true; },
        (error: unknown) => { if (competitorFailure === undefined) competitorFailure = failureOf(error, 'competitor rejected'); },
      );
      competitor = register('competitor', c, l.competitorTxMs);
      try {
        const seen = await Promise.race([
          within(invoke(o.inspectBlocked), windowCeiling),
          c.then(() => 'settled' as const, () => 'settled' as const),
        ]);
        if (seen === true) competitorBlocked = true;
        else if (isStuck(seen) && windowFailure === undefined) {
          windowFailure = new Error(`the lock inspection did not settle within ${windowCeiling}ms during the guard's window`);
        }
      } catch (error) { windowFailure = failureOf(error, 'window inspection rejected'); } finally { openWindow(); }
    })();
    window.catch(() => undefined);
  };

  // the cleanup barrier: it runs on every exit path and, whatever the verdict, lets no started task
  // outlive the probe. It aborts the holder and cancels the contender, then awaits EVERY registered
  // participant to its own recorded lock bound — never short-circuited by an outcome already set.
  const finalize = async () => {
    closed = true; released = true; openWindow();
    if (!cancel.signal.aborted) cancel.abort(new ProbeFailure('aborted by lockOrderProbe: cleanup'));
    await abortHolder();
    await window.catch(() => undefined);
    // await every started task to its own recorded lock bound. A task still unsettled after that bound
    // holds no lock — its transaction, if any, was rolled back by the database at its timeout; it hangs
    // only in JS. Either way no lock it took outlives this return.
    for (const p of participants) {
      const left = Math.max(graceMs, lockBound(p.startedAt, p.txMs, l));
      await within(p.promise.then(() => undefined, () => undefined), left);
    }
  };

  let primary: unknown; let failed = false;
  try {
    // Register the holder transaction as a participant FIRST, so cleanup OWNS it even on an early
    // failure: an abort() that rejects must not let the holder lock outlive the probe — finalize awaits
    // the holder to maxWait + holderTxMs, by which the database has reclaimed it. The same promise is
    // monitored for a death at ANY time while it is meant to hold the lock (during readiness OR after
    // ready() but before release), so a holder that dies is named as a holder failure, never mistaken
    // for the contender escaping the lock.
    if (typeof o.holderMonitor !== 'function') {
      fail('lockOrderProbe requires a holderMonitor: the holder transaction must be owned so cleanup can await its lock even when release() and abort() both fail');
    }
    const holder = register('holder', invoke(o.holderMonitor), l.holderTxMs);
    void holder.promise.then(
      () => undefined,
      (error: unknown) => { if (!released && holderTxFailure === undefined) holderTxFailure = failureOf(error, 'holder transaction failed'); },
    );
    // Budget, checked only after the holder is owned: a rejected budget still runs through finalize,
    // which aborts and awaits the holder the fixture already started, rather than returning and leaving
    // its lock held until the transaction's own timeout. The worst case is computed from the bounds
    // this call actually uses, so a fixture whose bounds cannot fit under the per-test timeout is
    // rejected here instead of timing the test out.
    if (worstCase(l, settleMs) >= TEST_TIMEOUT_MS) {
      fail(`the probe's worst case (${worstCase(l, settleMs)}ms for maxWait=${l.maxWaitMs}, holderTx=${l.holderTxMs}, contenderTx=${l.contenderTxMs}, competitorTx=${l.competitorTxMs}, settle=${settleMs}) does not fit under the ${TEST_TIMEOUT_MS}ms per-test timeout`);
    }
    // readiness is bounded: a holder that never signals is aborted and named, rather than hanging the
    // probe until Vitest kills the test.
    const readiness = await within(invoke(o.holderReady).then(() => 'ready' as const, (error: unknown) => ({ error })), holderReadyMs(l));
    if (readiness !== 'ready') {
      if ('stuck' in readiness) { await abortHolder(); fail(`the holder never became ready within ${holderReadyMs(l)}ms; it was aborted rather than hang the test`); }
      fail(`the holder failed before it was ready: ${reason(readiness.error)}`);
    }

    const contenderPromise = invoke(() => o.contenderStarted({ observed, proceed, signal: cancel.signal }));
    contender = register('contender', contenderPromise, l.contenderTxMs);

    // the initial lock inspection is bounded by the same ceiling the budget assumes: a query that
    // never settles (a connection fault that neither resolves nor rejects) must not hang the probe
    // past release/cleanup — it is named as an inspection failure and routed through finalize.
    const inspectionResult = await within(
      invoke(o.inspectBlocked).then((blocked) => ({ blocked }), (error: unknown) => ({ failure: failureOf(error, 'inspection rejected') })),
      inspectCeilingMs(l),
    );
    const inspection = isStuck(inspectionResult)
      ? { failure: new Error(`the lock inspection did not settle within ${inspectCeilingMs(l)}ms`) }
      : inspectionResult;
    // record that the contender was seen waiting BEFORE release: this is what tells a correct lock-first
    // contender (which unblocks at the holder's COMMIT, racing releaseCompleted) from a lock-free read.
    if ('blocked' in inspection && inspection.blocked) blockedSeen = true;

    released = true;
    // release() (and abort() below) are bounded: a control callback that neither resolves nor rejects
    // must not block settle()/finalize() and hand the test to Vitest's generic timeout with the row
    // still held. On a bounded-out or rejected release the holder is aborted; finalize then awaits the
    // holder participant to its declared lock bound, by which the database has reclaimed the row.
    const releaseOutcome = await within(invoke(o.release).then(() => undefined, (error: unknown) => failureOf(error, 'release rejected')), controlBound(l));
    const releaseFailure = isStuck(releaseOutcome) ? new Error(`release did not settle within ${controlBound(l)}ms`) : releaseOutcome;
    if (releaseFailure === undefined) releaseCompleted = true;
    else await abortHolder();

    // ---- INFRASTRUCTURE first: a dead holder is classified BEFORE settle/verify. No lock-order
    // verdict comes from a dead holder, and running the settle and competitor waits on a holder that
    // never released only burns the budget. The contender's early unblock is a CONSEQUENCE of the
    // holder dying, not evidence the guard read before locking.
    if (releaseFailure !== undefined && holderTxFailure === undefined) holderTxFailure = releaseFailure;
    if (holderTxFailure !== undefined) fail(`the holder failed after it was ready: ${reason(holderTxFailure)}: the row was freed by aborting it, and no lock-order verdict is drawn from a dead holder`);

    await settle();
    await window;
    // wait for the competitor to LAND (or record its failure) within the observation window. A
    // competitor that acquires the row and then hangs never lands and never rejects in this window —
    // it holds the row until its own transaction timeout, which the cleanup barrier waits out; here it
    // is a stuck competitor, named as "never landed" rather than mistaken for a clean interleaving.
    let competitorStuck = false;
    if (competitor !== undefined) {
      const landed = await within(competitor.promise, settleMs);
      if (isStuck(landed)) competitorStuck = true;
    }

    // a holder that died DURING the settle window (monitored continuously after readiness) is named
    // here, still before any lock-order verdict.
    if (holderTxFailure !== undefined) fail(`the holder failed after it was ready: ${reason(holderTxFailure)}: the row was freed by aborting it, and no lock-order verdict is drawn from a dead holder`);

    const settled = outcome;
    // The probe's OWN inspection machinery breaking is named before the contender-failed verdict: a
    // window inspection that hangs parks the contender on `proceed` past its own transaction timeout,
    // so the contender's tx-expiry is a CONSEQUENCE of the inspection fault, not a contender crash.
    // Classify the root cause (the inspection) first so the cascade is not misreported as the guard.
    if ('failure' in inspection) fail(`the lock inspection failed: ${reason(inspection.failure)}`);
    if (windowFailure !== undefined) fail(`the lock inspection failed during the guard's window: ${reason(windowFailure)}`);
    // A contender that CRASHED (rejected) before completing its command is an infrastructure failure,
    // named before the absent lock wait is read as lock-after-read — UNLESS the probe itself cancelled
    // it for outliving the settle window (`timedOut`), in which case its rejection carries the probe's
    // own abort reason and is the hung-guard verdict below, not a broken fixture.
    if (!timedOut && settled !== undefined && !('stuck' in settled) && !settled.ok) {
      fail(`the contender failed instead of completing its command: ${reason(settled.error)}`);
    }
    if (competitorFailure !== undefined) fail(`the competing writer failed instead of landing: ${reason(competitorFailure)}`);

    // ---- lock-order verdicts (only once the fixture is proven sound) ----
    if (escaped) fail('the contender completed its status read before the holder released: the guard read the status before taking the lock (lock-after-read)');
    if (settled === undefined || 'stuck' in settled) {
      fail('the contender ignored its abort signal and never settled; its transaction, if any, has been rolled back by its own timeout, so it holds no lock — but a guard that only hangs in JS proves no lock order');
    }
    if (timedOut) fail('the contender was still running after the holder was released and aborted: the guarded command never completed within its transaction, and was aborted');
    // A competitor that LANDED inside the guard's window is CONCRETE proof the guard did not hold its
    // lock across the read-then-mutate, so it is named before the inconclusive "never seen waiting"
    // verdict: a lock-free guard whose initial wait went unobserved (a scheduling delay) but whose
    // window a competitor still slipped through has a real defect, not an inconclusive interleaving.
    if (landedInWindow) fail("a competing writer landed between the guard's status read and its mutation: the guard did not hold its lock across the window (an autocommit FOR UPDATE, a commit before the mutation, or no lock at all)");
    // an unseen initial wait is NOT proof of lock-after-read: a correct lock-first contender can be
    // delayed acquiring its pool connection until after inspectBlocked returned false, then take the
    // row only once the holder released. Only `escaped` (checked above) proves the read completed
    // before release; an unobserved wait with no competitor landing is an inconclusive interleaving.
    if (!inspection.blocked) fail('the contender was never observed waiting behind the holder and did not escape: the interleaving could not be established (a scheduling delay is not proof of lock order)');
    if (competitor !== undefined && !competitorBlocked && competitorFailure === undefined && !competitorStuck) fail('the competing writer was never seen waiting behind the guard, and did not land: the interleaving was not observed');
    if (competitorStuck && competitorFailure === undefined) fail('the competing writer never landed after the guard finished: the row is still locked');
    if (reads === 0) fail('the contender never reported its status read (call observed() when it returns); a wait alone is not the proof');
    // the ORDER witness: the fixture reads back the terminal state the interleaving must leave. It is
    // bounded by a declared ceiling AND handed a cancel signal, and the contract requires it to run in
    // a bounded transaction: a terminal read that hangs after a connection fault is named here, its
    // signal aborted, and its transaction rolled back by the database — never left holding the row past
    // the probe's return and the suite's DROP-TABLE teardown.
    const verifyCancel = new AbortController();
    const verifyPromise = invoke(() => o.verify(verifyCancel.signal));
    // register verify so cleanup DRAINS it too: a terminal read that hangs runs in a bounded transaction
    // (the contract), and finalize awaits it to maxWait + verifyTxMs, by which the database has rolled it
    // back — no verify lock outlives the probe's return, the same discipline every other participant gets.
    register('verify', verifyPromise, l.verifyTxMs);
    const verified = await within(verifyPromise.then(() => undefined, (error: unknown) => ({ error })), inspectCeilingMs(l));
    if (isStuck(verified)) { verifyCancel.abort(new ProbeFailure('aborted by lockOrderProbe: verify outlived its bound')); fail(`the terminal invariant check did not settle within ${inspectCeilingMs(l)}ms`); }
    if (verified !== undefined && 'error' in verified) fail(`the terminal invariant does not hold after the interleaving: ${reason(verified.error)}`);
  } catch (error) {
    primary = error; failed = true;
  }

  await finalize();
  if (abortFailure !== undefined) {
    fail(`${failed ? `${reason(primary)}; then ` : ''}the holder's abort failed: ${reason(abortFailure)}: the row may remain locked and the contender blocked`);
  }
  if (failed) throw primary;
}
