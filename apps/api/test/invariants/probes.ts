/**
 * Reusable behavioral probes for the finding families of docs/REVIEW_RUBRIC.md. Each helper drives
 * callbacks the owning suite supplies — real SQL that commits or rolls back — and fails with a
 * `ProbeFailure` naming what the fixture got wrong. Importing a helper proves nothing;
 * `test/integration/process-invariant-probes.test.ts` shows each one failing on a broken fixture
 * and passing on the corrected one. The lock-order probe is its own unit (reform-1b) and is not here.
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
