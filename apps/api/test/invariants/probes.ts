/**
 * Reusable behavioral probes for the finding families of docs/REVIEW_RUBRIC.md. Each helper drives
 * callbacks the owning suite supplies — real SQL that commits or rolls back — and fails with a
 * `ProbeFailure` naming what the fixture got wrong. Importing a helper proves nothing;
 * `test/integration/process-invariant-probes.test.ts` shows each one failing on a broken fixture
 * and passing on the corrected one.
 */
export type Probe = () => Promise<void>;
export type Bundle = {
  key: string;
  branch: string;
  valid: Record<'fact-first' | 'event-first', Probe>;
  /** each negative ASSERTS the intended refusal itself — any exception is not evidence */
  invalid: Record<string, Probe>;
  priorWriter: Probe;
};
export class ProbeFailure extends Error {}
const fail = (message: string): never => { throw new ProbeFailure(message); };
const reason = (error: unknown) => String((error as Error)?.message ?? error);
/** a bigint carries a type tag, so 1n and "1" never canonicalise alike (a bigint→text change is a change) */
const canonical = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));

/** The negatives EVERY writer branch owes (rubric families missing-counterpart and identity/recipient/actor
 * binding). A writer's own `negatives` ADD to these; nothing replaces them, and one never stands for the four. */
export const REQUIRED_NEGATIVES = ['missing-counterpart', 'wrong-identity', 'wrong-audience', 'wrong-actor'] as const;
export type ExpectedWriter = { key: string; branch: string; negatives?: readonly string[] };
/** The expected population is every (flagged key, writer branch) pair from the compiled catalog (a key alone
 * would let one writer's row stand in for another's): it is non-empty and duplicate-free, every pair has a row,
 * every row is expected and unique, every row carries each negative its writer owes, every callback runs. */
export async function pairingMatrix(expected: readonly ExpectedWriter[], rows: readonly Bundle[]) {
  const seen = new Set<string>();
  const label = (w: ExpectedWriter) => `${w.key} · ${w.branch}`;
  const owed = (w: ExpectedWriter) => [...REQUIRED_NEGATIVES, ...(w.negatives ?? [])];
  if (expected.length === 0) fail('the expected population is empty: a catalog that compiles to no (key, writer branch) pair is not a passing matrix');
  const declared = new Set<string>();
  for (const writer of expected) {
    if (declared.has(label(writer))) fail(`duplicate expected writer ${label(writer)}`);
    declared.add(label(writer));
    if (!rows.some((row) => row.key === writer.key && row.branch === writer.branch)) fail(`expected writer ${label(writer)} has no bundle row`);
  }
  for (const row of rows) {
    const id = label(row);
    const writer = expected.find((w) => w.key === row.key && w.branch === row.branch) ?? fail(`${id} is not in the expected population`);
    if (seen.has(id)) fail(`duplicate writer branch ${id}`);
    seen.add(id);
    for (const order of ['fact-first', 'event-first'] as const) if (typeof row.valid?.[order] !== 'function') fail(`${id} lacks its ${order} positive`);
    if (typeof row.priorWriter !== 'function') fail(`${id} lacks its prior-generation writer`);
    for (const name of owed(writer)) if (typeof row.invalid?.[name] !== 'function') fail(`${id} lacks its ${name} negative`);
  }
  const executed: string[] = [];
  for (const row of rows) {
    const id = `${row.key} · ${row.branch}`;
    for (const order of ['fact-first', 'event-first'] as const) { await row.valid[order](); executed.push(`${id}: ${order}`); }
    await row.priorWriter(); executed.push(`${id}: prior writer`);
    // by NAME through property lookup (a callback held on a prototype or non-enumerable still runs), then any further own negative
    const names = owed(expected.find((w) => w.key === row.key && w.branch === row.branch)!);
    for (const name of [...names, ...Object.keys(row.invalid).filter((n) => !names.includes(n))]) { await row.invalid[name]!(); executed.push(`${id}: ${name}`); }
  }
  return { rows: rows.length, executed };
}

/** invoke a fixture callback through a promise boundary: a synchronous throw is a rejection, never an escape */
const invoke = <T,>(fn: () => Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => { try { Promise.resolve(fn()).then(resolve, reject); } catch (error) { reject(error); } });

/** A guard that reads a serialized row's status must lock it FIRST and hold that lock through its mutation.
 * `holderReady` locks the row on one session and holds it (it MUST reject if the holder fails before it is ready);
 * `contenderStarted` begins the guard on another session: it calls `observed()` the moment its STATUS READ returns,
 * awaits `proceed`, then mutates on what it read, all in the transaction that took the lock; `inspectBlocked` reports
 * whether some other session is waiting on the row; `competitor` is a competing writer on a third session that
 * BLOCKS on the row (no NOWAIT) and resolves once its write landed. When the guard reports its read, the probe
 * starts the competitor and opens `proceed` only after `inspectBlocked` has seen the competitor waiting behind the
 * guard; a competitor that lands before `proceed` opened proves the guard did not hold its lock (an autocommit
 * FOR UPDATE, or no lock at all), and `verify` reads back the terminal ORDER the interleaving must leave, so a guard
 * that commits and then mutates outside its lock fails there. A read returned before `release` escaped the
 * holder's lock; a contender that never reports proves nothing; a holder, contender, inspection, competitor,
 * release or abort that throws is a failure, never evidence (assert an EXPECTED domain refusal inside the callback).
 *
 * Cleanup is enforceable, not merely cooperative. The holder is rolled back by `abort` (independent of `release`).
 * The contender MUST run inside a transaction whose OWN timeout bounds how long it can hold the row: a broken guard
 * that ignores the `signal` and hangs still has its transaction rolled back by the database at that timeout, which
 * releases its lock; the settle window is sized ABOVE that timeout so the probe observes the release before it
 * returns, and it then confirms the competitor landed. The competitor is bounded the SAME way: it too runs under a
 * transaction timeout (`COMPETITOR_TX_MS`), so a competitor that acquires the row and then hangs is rolled back by
 * the database, and cleanup waits until that bound has elapsed since it started, so its lock never outlives the
 * probe either. The only worker that can outlast the probe is one that hangs in JS while holding NO lock (an
 * autocommit read that already returned, or a transaction the database has already rolled back) — it holds nothing,
 * so no lock outlives the probe. Every wait is bounded (`SETTLE_WINDOW_MS`/`contenderSettleMs`, `COMPETITOR_TX_MS`)
 * and the whole hung-guard budget stays under the integration suite's per-test timeout. */
export const SETTLE_WINDOW_MS = 9_000;
const GRACE_MS = 2_000;
// The competitor is bounded the SAME way the contender is: it runs inside a transaction whose own timeout caps how
// long it can hold the row, so a competitor that acquires the lock and then hangs is rolled back by the database at
// this bound and releases its lock. The fixture MUST run the competitor under it, the probe waits (in cleanup) until
// this bound has elapsed since the competitor started, so no competitor lock outlives the probe, and it sits above
// the contender transaction timeout so a competitor blocked behind a rolled-back contender still lands.
export const COMPETITOR_TX_MS = 9_000;
// The worst-case wall time for a hung guard on the default window: the lock-inspection poll ceiling, one settle
// window plus a cancellation grace, and the bounded competitor waits (its own transaction timeout plus a grace). It
// MUST stay under the integration suite's 30s per-test timeout, or the probe times the test out before it can name
// the very hung-guard case it exists to diagnose (asserted in the suite). The settle window MUST also exceed the
// contender's transaction timeout, so a database-rolled-back guard's lock release is observed rather than mistaken
// for an ignored signal.
export const SETTLE_WINDOW_MS_MUST_EXCEED_CONTENDER_TX = true;
export const LOCK_PROBE_WORST_CASE_MS = 3_000 + SETTLE_WINDOW_MS + COMPETITOR_TX_MS + GRACE_MS * 3;
export async function lockOrderProbe(o: {
  holderReady: () => Promise<void>;
  contenderStarted: (milestone: { observed: () => void; proceed: Promise<void>; signal: AbortSignal }) => Promise<unknown>;
  inspectBlocked: () => Promise<boolean>; competitor: () => Promise<void>;
  release: () => Promise<void>; abort: () => Promise<void>; verify: () => Promise<void>;
  contenderSettleMs?: number;
}) {
  type Outcome = { ok: true } | { ok: false; error: unknown } | { stuck: true };
  const windowMs = o.contenderSettleMs ?? SETTLE_WINDOW_MS;
  const graceMs = Math.min(windowMs, GRACE_MS);
  let released = false; let reads = 0; let escaped = false; let timedOut = false;
  let windowOpen = false; let competitorBlocked = false; let competitorLanded = false; let landedInWindow = false;
  let competitorFailure: unknown; let abortFailure: unknown; let windowFailure: unknown;
  let contender: Promise<unknown> | undefined; let competitor: Promise<void> | undefined;
  let competitorStartedAt: number | undefined; // when the competitor's bounded transaction began, so cleanup can wait out its timeout
  let outcome: Outcome | undefined;
  let window: Promise<void> = Promise.resolve();
  const cancel = new AbortController();
  let openWindow!: () => void;
  const proceed = new Promise<void>((resolve) => { openWindow = () => { windowOpen = true; resolve(); }; });
  const failureOf = (error: unknown, fallback: string) => error ?? new Error(fallback);
  const within = <T,>(promise: Promise<T>, ms: number): Promise<T | { stuck: true }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<{ stuck: true }>((resolve) => { timer = setTimeout(() => resolve({ stuck: true }), ms); });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  };
  const abortHolder = async () => {
    const failure = await invoke(o.abort).then(() => undefined, (error: unknown) => failureOf(error, 'abort rejected'));
    if (failure !== undefined && abortFailure === undefined) abortFailure = failure;
  };
  const settle = async () => {
    if (contender === undefined || outcome !== undefined) return;
    const race = (ms: number) => within(contender!.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })), ms);
    // the window is sized above the contender's transaction timeout: a hung guard's tx is rolled back by the
    // database within it, so its lock is released and its promise rejects before the window elapses
    let settled = await race(windowMs);
    if ('stuck' in settled) { // it did not even reject at its transaction timeout: cancel cooperatively, then a grace
      timedOut = true; openWindow(); cancel.abort(new ProbeFailure('aborted by lockOrderProbe: the contender outlived the settle window'));
      settled = await race(graceMs);
    }
    outcome = settled; // still stuck ⇒ a lockless JS-only hang; its transaction (if any) has already rolled back
  };
  const awaitCompetitor = async (ms: number): Promise<{ stuck: true } | undefined> => {
    if (competitor === undefined) return undefined;
    const landed = await within(competitor, ms); // the competitor resolves to void; only a timeout yields { stuck }
    return typeof landed === 'object' && landed !== null && 'stuck' in landed ? { stuck: true } : undefined;
  };
  const observed = () => {
    reads += 1;
    if (reads > 1) return;
    if (!released) { escaped = true; openWindow(); return; }
    // the guard has read and is holding (or not): start a competitor that BLOCKS on the row, wait until it is seen
    // waiting behind the guard, then let the guard mutate. A competitor that lands first found the row unlocked.
    window = (async () => {
      competitorStartedAt = Date.now();
      competitor = invoke(o.competitor).then(() => { competitorLanded = true; if (!windowOpen) landedInWindow = true; }, (error: unknown) => { competitorFailure = failureOf(error, 'competitor rejected'); });
      try {
        const seen = await Promise.race([invoke(o.inspectBlocked), competitor.then(() => 'settled' as const)]);
        if (seen === true) competitorBlocked = true;
      } catch (error) { windowFailure = failureOf(error, 'window inspection rejected'); } finally { openWindow(); }
    })();
    window.catch(() => undefined); // observed while the probe awaits elsewhere: never an unhandled rejection
  };
  let primary: unknown; let failed = false;
  try {
    await invoke(o.holderReady).catch((error: unknown) => fail(`the holder failed before it was ready: ${reason(error)}`));
    contender = invoke(() => o.contenderStarted({ observed, proceed, signal: cancel.signal }));
    contender.catch(() => undefined); // a contender that rejects promptly (e.g. before it can take the lock) is inspected later in settle(); never an unhandled rejection meanwhile
    const inspection = await invoke(o.inspectBlocked).then((blocked) => ({ blocked }), (error: unknown) => ({ failure: failureOf(error, 'inspection rejected') }));
    released = true;
    const releaseFailure = await invoke(o.release).then(() => undefined, (error: unknown) => failureOf(error, 'release rejected'));
    if (releaseFailure !== undefined) await abortHolder();
    await settle();
    await window;
    const landed = await awaitCompetitor(windowMs);
    const settled = outcome === undefined || 'stuck' in outcome
      ? fail('the contender ignored its abort signal and never settled; its transaction, if any, has been rolled back by its own timeout, so it holds no lock — but a guard that only hangs in JS proves no lock order') : outcome;
    if (timedOut) fail('the contender was still running after the holder was released and aborted: the guarded command never completed within its transaction, and was aborted');
    const inspected = 'failure' in inspection ? fail(`the lock inspection failed: ${reason(inspection.failure)}`) : inspection;
    if (escaped) fail('the contender completed its status read before the holder released: the guard read the status before taking the lock (lock-after-read)');
    // a contender that FAILED to complete its command is not evidence of lock order: name its failure before
    // interpreting the (correctly) absent lock wait as lock-after-read
    if (!settled.ok) fail(`the contender failed instead of completing its command: ${reason(settled.error)}`);
    if (!inspected.blocked) fail('the contender was never blocked behind the holder: the guard read the status before taking the lock (lock-after-read)');
    if (windowFailure !== undefined) fail(`the lock inspection failed during the guard's window: ${reason(windowFailure)}`);
    if (competitorFailure !== undefined) fail(`the competing writer failed instead of landing: ${reason(competitorFailure)}`);
    if (landedInWindow) fail("a competing writer landed between the guard's status read and its mutation: the guard did not hold its lock across the window (an autocommit FOR UPDATE, a commit before the mutation, or no lock at all)");
    if (competitor !== undefined && !competitorBlocked) fail('the competing writer was never seen waiting behind the guard, and did not land: the interleaving was not observed');
    if (landed !== undefined && 'stuck' in landed) fail('the competing writer never landed after the guard finished: the row is still locked');
    if (reads === 0) fail('the contender never reported its status read (call observed() when it returns); a wait alone is not the proof');
    if (releaseFailure !== undefined) fail(`the holder's release failed: ${reason(releaseFailure)}`);
    // the ORDER witness: the fixture reads back the terminal state the interleaving must leave (holder, then guard, then competitor)
    await invoke(o.verify).catch((error: unknown) => fail(`the terminal invariant does not hold after the interleaving: ${reason(error)}`));
  } catch (error) {
    primary = error; failed = true;
  }
  // whatever happened above: free the row (a no-op once the holder settled), let no contender or competitor outlive
  // the probe (each runs under a transaction timeout that rolls its lock back), and never hide a cleanup failure. A
  // competitor that acquired the row and then hangs releases its lock only when ITS transaction times out, so wait
  // until that bound has elapsed since it started (not merely a grace) before returning — otherwise the row could
  // stay locked past the probe on the paths that never reached the main competitor wait.
  released = true; openWindow();
  await abortHolder();
  await settle();
  await window.catch(() => undefined);
  const competitorLeft = competitorStartedAt === undefined ? graceMs
    : Math.max(graceMs, COMPETITOR_TX_MS + graceMs - (Date.now() - competitorStartedAt));
  await awaitCompetitor(competitorLeft);
  if (abortFailure !== undefined) {
    fail(`${failed ? `${reason(primary)}; then ` : ''}the holder's abort failed: ${reason(abortFailure)}: the row may remain locked and the contender blocked`);
  }
  if (failed) throw primary;
}

/** Applying twice must leave the canonical snapshot exactly as applying once did. */
export async function rerunTwice(o: { apply: Probe; snapshot: () => Promise<unknown> }) {
  await o.apply(); const once = canonical(await o.snapshot());
  await o.apply(); const twice = canonical(await o.snapshot());
  if (once !== twice) fail(`a second application changed the snapshot:\n  once:  ${once}\n  twice: ${twice}`);
}

/** A no-op UPDATE must leave the row AND the transition evidence untouched. */
export async function noOpUpdateProbe<T extends { row: unknown; evidence: unknown }>(o: {
  snapshot: () => Promise<T>; noOp: Probe;
  assertUnchanged?: (before: T['evidence'], after: T['evidence']) => void | Promise<void>;
}) {
  const before = await o.snapshot(); await o.noOp(); const after = await o.snapshot();
  if (canonical(before.row) !== canonical(after.row)) fail('the "no-op" changed the row itself; it is not a no-op');
  if (o.assertUnchanged) await o.assertUnchanged(before.evidence, after.evidence);
  else if (canonical(before.evidence) !== canonical(after.evidence)) fail(`a no-op touch was counted as a transition:\n  before: ${canonical(before.evidence)}\n  after:  ${canonical(after.evidence)}`);
}

/** Space, tab, newline, vertical tab, form feed, carriage return, mixtures, and the empty string. */
export const ASCII_WHITESPACE = [' ', '\t', '\n', '\u000B', '\f', '\r', ' \t', '\n\r', '\u000B\f', ''];
/** Every whitespace-only value is refused by the NAMED constraint; a real value is accepted. */
export async function whitespaceCheckProbe(o: { write: (value: string) => Promise<void>; accepts?: string; rejects: (error: unknown) => boolean }) {
  for (const value of ASCII_WHITESPACE) {
    try { await o.write(value); } catch (error) {
      if (error instanceof ProbeFailure) throw error;
      if (!o.rejects(error)) fail(`${JSON.stringify(value)} was refused by something other than the named constraint: ${reason(error)}`);
      continue;
    }
    fail(`whitespace-only value ${JSON.stringify(value)} was ACCEPTED; the constraint must reject the whole ASCII whitespace set`);
  }
  await o.write(o.accepts ?? 'a real value');
}
