// The probes against REAL PostgreSQL: each helper FAILS on a broken fixture and PASSES on the corrected one. Scratch tables only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  ASCII_WHITESPACE, ProbeFailure, lockOrderProbe, noOpUpdateProbe, pairingMatrix, rerunTwice, whitespaceCheckProbe,
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

// afterAll runs even when beforeAll threw: nothing destructive may run against a database setup refused
let setupPassed = false;
beforeAll(async () => {
  const database = (() => { try { return decodeURIComponent(new URL(process.env.DATABASE_URL ?? '').pathname.slice(1)); } catch { return ''; } })();
  if (!/test/u.test(database)) throw new Error('DATABASE_URL must name a disposable *test* database');
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
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const locked = new Promise<void>((resolve) => { ready = resolve; });
    const tx = a.$transaction(async (t) => {
      await t.$queryRawUnsafe('SELECT status FROM _probe_lock WHERE id = 1 FOR UPDATE');
      ready(); await gate;
    }, { timeout: 30_000, maxWait: 10_000 });
    return { holderReady: () => locked, release: async () => { release(); await tx; } };
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
});

describe('pairingMatrix', () => {
  const probe = (log: string[], name: string) => async () => { log.push(name); };
  const row = (log: string[], key: string, branch: string) => ({
    key, branch, valid: { 'fact-first': probe(log, `${branch}:ff`), 'event-first': probe(log, `${branch}:ef`) },
    invalid: { 'missing event': probe(log, `${branch}:neg`) }, priorWriter: probe(log, `${branch}:prior`),
  });
  const pair = (key: string, branch: string) => ({ key, branch });
  it('fails on an expected writer BRANCH with no row, a row outside the population, a missing order, and a duplicate', async () => {
    const log: string[] = [];
    // the population is key AND branch: a second writer of the same key cannot hide behind the first
    await failsWith(/decision\.approved · restore has no bundle row/u)(() => pairingMatrix([pair('decision.approved', 'approve'), pair('decision.approved', 'restore')], [row(log, 'decision.approved', 'approve')]));
    await failsWith(/not in the expected population/u)(() => pairingMatrix([pair('k', 'one')], [row(log, 'k', 'one'), row(log, 'k', 'two')]));
    const partial = { ...row(log, 'decision.approved', 'approve'), valid: { 'fact-first': probe(log, 'x') } } as unknown as Parameters<typeof pairingMatrix>[1][number];
    await failsWith(/lacks its event-first positive/u)(() => pairingMatrix([pair('decision.approved', 'approve')], [partial]));
    await failsWith(/duplicate writer branch/u)(() => pairingMatrix([pair('decision.approved', 'approve')], [row(log, 'decision.approved', 'approve'), row(log, 'decision.approved', 'approve')]));
    expect(log).toEqual([]);
  });
  it('executes every positive order, prior writer and named negative on a complete matrix', async () => {
    const log: string[] = [];
    const result = await pairingMatrix([pair('k', 'one'), pair('k', 'two')], [row(log, 'k', 'one'), row(log, 'k', 'two')]);
    expect(result.rows).toBe(2);
    expect(log).toEqual(['one:ff', 'one:ef', 'one:prior', 'one:neg', 'two:ff', 'two:ef', 'two:prior', 'two:neg']);
  });
});
