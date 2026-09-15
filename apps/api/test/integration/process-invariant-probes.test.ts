// The probes against REAL PostgreSQL: each helper FAILS on a broken fixture and PASSES on the corrected one. Scratch tables only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  ASCII_WHITESPACE, type Bundle, ProbeFailure, REQUIRED_NEGATIVES, lockOrderProbe, noOpUpdateProbe, pairingMatrix, rerunTwice, whitespaceCheckProbe,
} from '../invariants/probes';

const a = new PrismaClient();
const b = new PrismaClient();
const sql = (client: PrismaClient, text: string) => client.$executeRawUnsafe(text);
const rows = <T,>(client: PrismaClient, text: string) => client.$queryRawUnsafe<T[]>(text);
const failsWith = (pattern: RegExp) => async (run: () => Promise<unknown>) => {
  await expect(run()).rejects.toSatisfy((e: unknown) => e instanceof ProbeFailure && pattern.test((e as Error).message));
};
const VT = String.fromCharCode(11);

const SCRATCH = ['_probe_ws_weak', '_probe_ws_strong', '_probe_noop', '_probe_noop_log', '_probe_rerun_weak', '_probe_rerun_strong', '_probe_lock'];
// one statement per call: Prisma refuses multi-statement raw SQL
const SETUP = [
  `CREATE TABLE _probe_ws_weak (v text CHECK (btrim(v) <> ''))`,
  `CREATE TABLE _probe_ws_strong (v text CHECK (btrim(v, E' \\t\\n\\x0B\\f\\r') <> ''))`,
  'CREATE TABLE _probe_noop (id int PRIMARY KEY, status text NOT NULL)',
  'CREATE TABLE _probe_noop_log (id serial PRIMARY KEY, kind text NOT NULL)',
  "INSERT INTO _probe_noop VALUES (1, 'approved')",
  `CREATE OR REPLACE FUNCTION _probe_noop_weak() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN INSERT INTO _probe_noop_log (kind) VALUES ('transition-by-write'); RETURN NEW; END $$`,
  `CREATE OR REPLACE FUNCTION _probe_noop_strong() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN IF OLD.status IS DISTINCT FROM NEW.status THEN INSERT INTO _probe_noop_log (kind) VALUES ('transition'); END IF; RETURN NEW; END $$`,
  'CREATE TABLE _probe_rerun_weak (id int)',
  'CREATE TABLE _probe_rerun_strong (id int PRIMARY KEY)',
  'CREATE TABLE _probe_lock (id int PRIMARY KEY, status text NOT NULL)',
  "INSERT INTO _probe_lock VALUES (1, 'open')",
];

/** a disposable database is NAMED `test` or `<anything>_test`; a name that merely contains the word (pmcvitan_latest, contest) is not one */
const disposable = (database: string) => /(?:^|_)test$/u.test(database);
// afterAll runs even when beforeAll threw: nothing destructive may run against a database setup refused
let setupPassed = false;
beforeAll(async () => {
  const database = (() => { try { return decodeURIComponent(new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)); } catch { return ''; } })();
  if (!disposable(database)) throw new Error(`DATABASE_URL must name a disposable test database (\`test\` or \`*_test\`), not "${database}"`);
  await sql(a, `DROP TABLE IF EXISTS ${SCRATCH.join(', ')}`);
  for (const statement of SETUP) await sql(a, statement);
  setupPassed = true;
});
afterAll(async () => {
  if (setupPassed) {
    await sql(a, `DROP TABLE IF EXISTS ${SCRATCH.join(', ')}`);
    await sql(a, 'DROP FUNCTION IF EXISTS _probe_noop_weak(), _probe_noop_strong()');
  }
  await a.$disconnect(); await b.$disconnect();
});

describe('database guard', () => {
  it('accepts only a database named test or *_test, never a name that merely contains the word', () => {
    for (const name of ['pmcvitan_test', 'test', 'api_e2e_test']) expect(disposable(name)).toBe(true);
    for (const name of ['pmcvitan_latest', 'contest', 'test_db', 'pmcvitan', 'pmcvitan_e2e', '']) expect(disposable(name)).toBe(false);
  });
});

describe('whitespaceCheckProbe', () => {
  const write = (table: string) => (v: string) => sql(a, `INSERT INTO ${table} VALUES ('${v.replace(/'/gu, "''")}')`).then(() => undefined);
  const rejects = (e: unknown) => /violates check constraint "_probe_ws_/u.test(String((e as Error).message));
  it('fails on a CHECK that strips spaces only (a tab-only value is accepted)', async () => {
    await failsWith(/"\\t" was ACCEPTED/u)(() => whitespaceCheckProbe({ write: write('_probe_ws_weak'), rejects }));
  });
  it('passes on the complete ASCII whitespace set, and names a foreign refusal', async () => {
    await whitespaceCheckProbe({ write: write('_probe_ws_strong'), rejects });
    expect(ASCII_WHITESPACE).toContain(VT);
    await failsWith(/refused by something other than the named constraint/u)(() =>
      whitespaceCheckProbe({ write: async () => { throw new Error('connection reset'); }, rejects }));
  });
});

describe('noOpUpdateProbe', () => {
  const snapshot = async () => ({
    row: (await rows(a, 'SELECT id, status FROM _probe_noop WHERE id = 1'))[0],
    evidence: (await rows<{ n: bigint }>(a, 'SELECT count(*) AS n FROM _probe_noop_log'))[0]!.n,
  });
  const noOp = () => sql(a, 'UPDATE _probe_noop SET status = status WHERE id = 1').then(() => undefined);
  it('fails when a trigger counts every write as a transition', async () => {
    await sql(a, 'CREATE TRIGGER _probe_noop_t AFTER UPDATE ON _probe_noop FOR EACH ROW EXECUTE FUNCTION _probe_noop_weak()');
    await failsWith(/no-op touch was counted as a transition/u)(() => noOpUpdateProbe({ snapshot, noOp }));
    await sql(a, 'DROP TRIGGER _probe_noop_t ON _probe_noop');
  });
  it('passes when the trigger compares OLD and NEW, and refuses a "no-op" that changes the row', async () => {
    await sql(a, 'CREATE TRIGGER _probe_noop_t AFTER UPDATE ON _probe_noop FOR EACH ROW EXECUTE FUNCTION _probe_noop_strong()');
    await noOpUpdateProbe({ snapshot, noOp });
    await failsWith(/changed the row itself/u)(() => noOpUpdateProbe({ snapshot, noOp: () => sql(a, "UPDATE _probe_noop SET status = 'change' WHERE id = 1").then(() => undefined) }));
    await sql(a, 'DROP TRIGGER _probe_noop_t ON _probe_noop');
  });
});

describe('rerunTwice', () => {
  it('fails on a non-idempotent apply and passes on a guarded one', async () => {
    const count = (table: string) => async () => (await rows<{ n: bigint }>(a, `SELECT count(*) AS n FROM ${table}`))[0]!.n;
    await failsWith(/second application changed the snapshot/u)(() =>
      rerunTwice({ apply: () => sql(a, 'INSERT INTO _probe_rerun_weak VALUES (1)').then(() => undefined), snapshot: count('_probe_rerun_weak') }));
    await rerunTwice({ apply: () => sql(a, 'INSERT INTO _probe_rerun_strong VALUES (1) ON CONFLICT DO NOTHING').then(() => undefined), snapshot: count('_probe_rerun_strong') });
  });
});

describe('lockOrderProbe', () => {
  /** the holder: session A locks the row inside a transaction it holds open until released */
  const holder = () => {
    let release!: () => void; let abort!: (error: Error) => void;
    const gate = new Promise<void>((resolve, reject) => { release = resolve; abort = reject; });
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const tx = a.$transaction(async (t) => {
      await t.$queryRawUnsafe('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE');
      ready(); await gate;
    }, { timeout: 30_000, maxWait: 10_000 });
    return {
      holderReady: () => locked, release: async () => { release(); await tx; },
      /** rolls the holder back whatever release did: the callback throws on the rejected gate */
      abort: async () => { abort(new Error('holder aborted')); await tx.catch(() => undefined); },
    };
  };
  /** does another session currently wait on a lock over the probe table? polled from session A's pool */
  const inspectBlocked = async () => {
    for (let i = 0; i < 100; i += 1) {
      const waiting = await rows<{ n: bigint }>(a,
        `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%_probe_lock%' AND pid <> pg_backend_pid()`);
      if (waiting[0]!.n > 0n) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  const verify = async () => { expect((await rows<{ status: string }>(a, 'SELECT status FROM _probe_lock WHERE id = 1'))[0]!.status).toBe('open'); };
  const read = (sql: string) => rows(b, `SELECT status FROM _probe_lock WHERE id = 1${sql}`);
  it('fails on a guard that reads the status before locking: never blocked, or read first then locked', async () => {
    // an async IIFE, because a Prisma promise is lazy and would not run until awaited
    await failsWith(/lock-after-read/u)(() => lockOrderProbe({ ...holder(), inspectBlocked, verify,
      contenderStarted: ({ observed }) => (async () => { const r = await read(''); observed(); return r; })() }));
    // the read escapes BEFORE the lock wait: the wait alone proves nothing
    await failsWith(/status read before the holder released/u)(() => lockOrderProbe({ ...holder(), inspectBlocked, verify,
      contenderStarted: ({ observed }) => (async () => { await read(''); observed(); return read(' FOR UPDATE'); })() }));
    await failsWith(/never reported its status read/u)(() => lockOrderProbe({ ...holder(), inspectBlocked, verify,
      contenderStarted: () => (async () => read(' FOR UPDATE'))() }));
  });
  it('passes on a guard that locks first: the contender waits, reads only after release, then proceeds', async () => {
    await lockOrderProbe({ ...holder(), inspectBlocked, verify,
      contenderStarted: ({ observed }) => (async () => { const r = await read(' FOR UPDATE'); observed(); return r; })() });
  });
  it('fails, and still frees the row, when the release rejects BEFORE unlocking (no lock outlives the probe)', async () => {
    await failsWith(/holder's release failed.*connection lost/u)(() => lockOrderProbe({ ...holder(), inspectBlocked, verify,
      release: async () => { throw new Error('connection lost'); },
      contenderStarted: ({ observed }) => (async () => { const r = await read(' FOR UPDATE'); observed(); return r; })() }));
    // NOWAIT: the row must be free the moment the probe returns
    await read(' FOR UPDATE NOWAIT');
  });
  it('fails, and still frees the row, when the holder fails AFTER taking the lock (readiness is inside the guard)', async () => {
    const h = holder();
    await failsWith(/holder failed before it was ready.*readiness monitor failed/u)(() => lockOrderProbe({ ...h, inspectBlocked, verify,
      holderReady: async () => { await h.holderReady(); throw new Error('readiness monitor failed'); },
      contenderStarted: ({ observed }) => (async () => { const r = await read(' FOR UPDATE'); observed(); return r; })() }));
    await read(' FOR UPDATE NOWAIT');
  });
  it('aborts a contender that hangs after reporting, and awaits its settlement; a contender that ignores the signal is named', async () => {
    let settled = false;
    await failsWith(/still running after the holder was released and aborted/u)(() => lockOrderProbe({ ...holder(), inspectBlocked, verify, contenderSettleMs: 500,
      contenderStarted: ({ observed, signal }) => {
        const work = (async () => {
          await read(' FOR UPDATE'); observed();
          await new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        })();
        void work.catch(() => undefined).finally(() => { settled = true; });
        return work;
      } }));
    expect(settled).toBe(true);
    await failsWith(/ignored its abort signal/u)(() => lockOrderProbe({ ...holder(), inspectBlocked, verify, contenderSettleMs: 300,
      contenderStarted: ({ observed }) => (async () => { await read(' FOR UPDATE'); observed(); await new Promise(() => undefined); })() }));
    await read(' FOR UPDATE NOWAIT');
  });
  it('fails, and still frees the row, when the lock inspection itself throws (every exit path aborts the holder)', async () => {
    await failsWith(/lock inspection failed.*connection reset/u)(() => lockOrderProbe({ ...holder(), verify,
      inspectBlocked: async () => { throw new Error('connection reset'); },
      contenderStarted: ({ observed }) => (async () => { const r = await read(' FOR UPDATE'); observed(); return r; })() }));
    await read(' FOR UPDATE NOWAIT');
  });
  it('fails when the contender or the release throws after a correct wait: a crashed command is not evidence', async () => {
    await failsWith(/contender failed instead of completing.*connection reset/u)(() => lockOrderProbe({ ...holder(), inspectBlocked, verify,
      contenderStarted: ({ observed }) => (async () => { await read(' FOR UPDATE'); observed(); throw new Error('connection reset'); })() }));
    const h = holder();
    await failsWith(/holder's release failed.*pool exhausted/u)(() => lockOrderProbe({ ...h, inspectBlocked, verify,
      release: async () => { await h.release(); throw new Error('pool exhausted'); },
      contenderStarted: ({ observed }) => (async () => { const r = await read(' FOR UPDATE'); observed(); return r; })() }));
  });
});

describe('pairingMatrix', () => {
  const probe = (log: string[], name: string) => async () => { log.push(name); };
  const negatives = (log: string[], branch: string, names: readonly string[]) => Object.fromEntries(names.map((n) => [n, probe(log, `${branch}:${n}`)]));
  const row = (log: string[], key: string, branch: string, names: readonly string[] = REQUIRED_NEGATIVES) => ({
    key, branch, valid: { 'fact-first': probe(log, `${branch}:ff`), 'event-first': probe(log, `${branch}:ef`) },
    invalid: negatives(log, branch, names), priorWriter: probe(log, `${branch}:prior`),
  });
  const pair = (key: string, branch: string, negatives?: readonly string[]) => ({ key, branch, negatives });
  it('fails on an expected writer BRANCH with no row, a row outside the population, a missing order, and a duplicate', async () => {
    const log: string[] = [];
    // the population is key AND branch: a second writer of the same key cannot hide behind the first
    await failsWith(/decision\.approved · restore has no bundle row/u)(() => pairingMatrix([pair('decision.approved', 'approve'), pair('decision.approved', 'restore')], [row(log, 'decision.approved', 'approve')]));
    await failsWith(/not in the expected population/u)(() => pairingMatrix([pair('k', 'one')], [row(log, 'k', 'one'), row(log, 'k', 'two')]));
    const partial = { ...row(log, 'decision.approved', 'approve'), valid: { 'fact-first': probe(log, 'x') } } as unknown as Parameters<typeof pairingMatrix>[1][number];
    await failsWith(/lacks its event-first positive/u)(() => pairingMatrix([pair('decision.approved', 'approve')], [partial]));
    await failsWith(/duplicate writer branch/u)(() => pairingMatrix([pair('decision.approved', 'approve')], [row(log, 'decision.approved', 'approve'), row(log, 'decision.approved', 'approve')]));
    // the previous-generation family: a row without its prior-generation writer fails by name before any callback runs
    const noPrior = { ...row(log, 'decision.approved', 'approve'), priorWriter: undefined } as unknown as Bundle;
    await failsWith(/decision\.approved · approve lacks its prior-generation writer/u)(() => pairingMatrix([pair('decision.approved', 'approve')], [noPrior]));
    expect(log).toEqual([]);
  });
  it('requires every binding negative per writer: one negative is not the four, and a writer\'s own negatives add to them', async () => {
    const log: string[] = [];
    await failsWith(/k · one lacks its wrong-identity negative/u)(() => pairingMatrix([pair('k', 'one')], [row(log, 'k', 'one', ['missing-counterpart'])]));
    await failsWith(/k · one lacks its custom negative/u)(() => pairingMatrix([pair('k', 'one', ['custom'])], [row(log, 'k', 'one')]));
    // a declared set never REPLACES the four: a row carrying only the writer's own negative still owes the rubric's
    await failsWith(/k · one lacks its missing-counterpart negative/u)(() => pairingMatrix([pair('k', 'one', ['custom'])], [row(log, 'k', 'one', ['custom'])]));
    expect(log).toEqual([]);
  });
  it('refuses an empty expected population and a duplicated expected writer: a silent catalog is not a passing matrix', async () => {
    const log: string[] = [];
    await failsWith(/expected population is empty/u)(() => pairingMatrix([], []));
    await failsWith(/duplicate expected writer k · one/u)(() => pairingMatrix([pair('k', 'one'), pair('k', 'one')], [row(log, 'k', 'one')]));
    expect(log).toEqual([]);
  });
  it('executes the owed negatives by NAME: callbacks held on a prototype or as non-enumerable properties still run', async () => {
    const log: string[] = [];
    const inherited = { ...row(log, 'k', 'one'), invalid: Object.create(negatives(log, 'one', REQUIRED_NEGATIVES)) as Record<string, () => Promise<void>> };
    const hidden = { ...row(log, 'k', 'two'), invalid: {} as Record<string, () => Promise<void>> };
    for (const name of REQUIRED_NEGATIVES) Object.defineProperty(hidden.invalid, name, { value: probe(log, `two:${name}`), enumerable: false });
    const result = await pairingMatrix([pair('k', 'one'), pair('k', 'two')], [inherited, hidden]);
    expect(result.executed.filter((e) => /wrong-|missing-/u.test(e))).toHaveLength(8);
    for (const branch of ['one', 'two']) for (const name of REQUIRED_NEGATIVES) expect(log).toContain(`${branch}:${name}`);
  });
  it('executes every positive order, prior writer and named negative on a complete matrix', async () => {
    const log: string[] = [];
    const extra = [...REQUIRED_NEGATIVES, 'extra'];
    const result = await pairingMatrix([pair('k', 'one'), pair('k', 'two', ['extra'])], [row(log, 'k', 'one'), row(log, 'k', 'two', extra)]);
    expect(result.rows).toBe(2);
    const neg = (branch: string, names: readonly string[]) => names.map((n) => `${branch}:${n}`);
    expect(log).toEqual(['one:ff', 'one:ef', 'one:prior', ...neg('one', REQUIRED_NEGATIVES), 'two:ff', 'two:ef', 'two:prior', ...neg('two', extra)]);
  });
});
