/**
 * Reusable behavioral probes for the eight finding families (docs/REVIEW_RUBRIC.md). Each helper
 * drives callbacks the owning suite supplies — real SQL that commits or rolls back — and fails
 * with a `ProbeFailure` naming what the fixture got wrong. Importing a helper proves nothing;
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
const canonical = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

/** The negatives EVERY writer branch owes (rubric families missing-counterpart and identity/recipient/actor
 * binding) unless the expected population names a writer's own non-empty set; one negative never stands for the four. */
export const REQUIRED_NEGATIVES = ['missing-counterpart', 'wrong-identity', 'wrong-audience', 'wrong-actor'] as const;
export type ExpectedWriter = { key: string; branch: string; negatives?: readonly string[] };
/** The expected population is every (flagged key, writer branch) pair from the compiled catalog (a key alone
 * would let one writer's row stand in for another's): every pair has a row, every row is expected and unique,
 * every row carries each negative its writer owes, every callback runs. */
export async function pairingMatrix(expected: readonly ExpectedWriter[], rows: readonly Bundle[]) {
  const seen = new Set<string>();
  const label = (w: ExpectedWriter) => `${w.key} · ${w.branch}`;
  const owed = (w: ExpectedWriter) => w.negatives ?? REQUIRED_NEGATIVES;
  for (const writer of expected) {
    if (owed(writer).length === 0) fail(`expected writer ${label(writer)} declares no negative dimension`);
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
    for (const [name, probe] of Object.entries(row.invalid)) { await probe(); executed.push(`${id}: ${name}`); }
  }
  return { rows: rows.length, executed };
}

/** A guard that reads a serialized row's status must lock it FIRST. `holderReady` locks on one session;
 * `contenderStarted` begins the guarded write on another and calls `observed()` the moment its STATUS READ
 * returns; `inspectBlocked` observes a real lock wait from a third session. A read returned before `release`
 * escaped the lock whatever waits afterwards; a contender that never reports its read proves nothing; a contender
 * or release that throws is a failure, never evidence (assert an EXPECTED domain refusal inside the callback). */
export async function lockOrderProbe(o: {
  holderReady: () => Promise<void>; contenderStarted: (milestone: { observed: () => void }) => Promise<unknown>;
  inspectBlocked: () => Promise<boolean>; release: () => Promise<void>; verify: () => Promise<void>;
}) {
  await o.holderReady();
  let released = false; let reads = 0; let escaped = false;
  const contender = o.contenderStarted({ observed: () => { reads += 1; if (!released) escaped = true; } });
  const blocked = await o.inspectBlocked();
  released = true;
  // both settle before any verdict (the contender only completes once the holder releases); neither outcome is dropped
  const [releaseOutcome, contenderOutcome] = await Promise.allSettled([o.release(), contender]);
  if (escaped) fail('the contender completed its status read before the holder released: the guard read the status before taking the lock (lock-after-read)');
  if (!blocked) fail('the contender was never blocked behind the holder: the guard read the status before taking the lock (lock-after-read)');
  if (contenderOutcome.status === 'rejected') fail(`the contender failed instead of completing its command: ${reason(contenderOutcome.reason)}`);
  if (reads === 0) fail('the contender never reported its status read (call observed() when it returns); a wait alone is not the proof');
  if (releaseOutcome.status === 'rejected') fail(`the holder's release failed: ${reason(releaseOutcome.reason)}`);
  await o.verify();
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
