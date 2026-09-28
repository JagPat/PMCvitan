import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  registerConsumer, syncConsumerCatalog, unregisterConsumer, persistedRule, type OutboxConsumer, type DispatchRule,
} from '../../src/platform/outbox/registry';
import { makeSocketConsumer, makePushConsumer } from '../../src/platform/outbox/consumers';
import { makeDecisionsProjectionConsumer } from '../../src/decisions/decisions.projection';
import { makeDailyLogProjectionConsumer } from '../../src/daily-log/daily-log.projection';
import { makeDrawingsProjectionConsumer } from '../../src/drawings/drawings.projection';
import { makeInspectionsProjectionConsumer } from '../../src/inspections/inspections.projection';
import { makeActivitiesProjectionConsumer } from '../../src/activities/activities.projection';
import { makeMaterialReadinessProjectionConsumer } from '../../src/activities/material-readiness.projection';
import { makeLabourReadinessProjectionConsumer } from '../../src/labour/labour-readiness.projection';
import { makeCashForecastProjectionConsumer } from '../../src/commercial/cash-forecast.projection';
import { sanctionedConsumerRemoval } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A6c — the PERSISTED DISPATCH RULES and the REGISTRATION BARRIER,
 * against live PostgreSQL (the 4d plan §A.3 obligation 7: "The rules are sealed evidence, not
 * startup state", "A row's BIRTH carries its rule; the migration owns every rule that already
 * EXISTS", "The EXCLUSIVE half is installed by a named trigger"; P38's rule and barrier arms as far
 * as this sub-unit installs them — the event's SHARE half is A6d's, with the delivery seals).
 *
 * The committed catalog is touched only through `syncConsumerCatalog` on consumers this suite
 * registers, which leave through the row-scoped sanctioned seam; every hostile statement runs under
 * a SAVEPOINT on a rolled-back transaction.
 */
describe('4d-ii-a / A6c — the persisted rules and the registration barrier (live PG)', () => {
  let prisma: PrismaClient;
  const MIGRATION = '20271230000000_phase6_t4d_ii_a6c_catalog_rules';
  const KEY = "hashtext('OutboxConsumerCatalog:registration')";
  const C = 'test.a6c.rules';
  const RULE: DispatchRule = { kind: 'types', eventTypes: ['decision.published', 'decision.approved'] };
  const SENTINEL = new Error('rollback');
  type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
  const consumer = (name: string, dispatchRule: DispatchRule = RULE): OutboxConsumer => ({
    name, kind: 'unordered', effect: 'external', catalogVersion: 1, dispatchRule,
    deliveryFor: () => ({ action: 'noop' }), handle: async () => {},
  });
  const compiled = (): OutboxConsumer[] => [
    makeSocketConsumer({} as never), makePushConsumer({} as never),
    makeDecisionsProjectionConsumer(), makeDailyLogProjectionConsumer(), makeDrawingsProjectionConsumer(),
    makeInspectionsProjectionConsumer(), makeActivitiesProjectionConsumer(),
    makeMaterialReadinessProjectionConsumer(), makeLabourReadinessProjectionConsumer(), makeCashForecastProjectionConsumer(),
  ];

  const rolledBack = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
    let thrown: unknown = null;
    await prisma.$transaction(async (tx) => {
      try { await body(tx); } catch (e) { thrown = e; }
      throw SENTINEL;
    }, { timeout: 30_000 }).catch((e) => { if (e !== SENTINEL) throw e; });
    if (thrown) throw thrown;
  };
  let savepoints = 0;
  const attempt = async (tx: Tx, sql: string, ...params: unknown[]): Promise<string | null> => {
    const sp = `a6c_${++savepoints}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      await tx.$executeRawUnsafe(sql, ...params);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      return null;
    } catch (e) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
      return e instanceof Error ? e.message : String(e);
    }
  };
  const ruleOf = async (client: Tx | PrismaClient, name: string) =>
    client.outboxConsumerCatalog.findUniqueOrThrow({ where: { consumer: name }, select: { dispatchRule: true, subscribedEventTypes: true } });
  const waitFor = async (label: string, probe: () => Promise<boolean>, ms = 15_000): Promise<void> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  /** The lock manager's own record of the registration key: how many sessions hold it (granted)
   *  or wait for it (not granted) in the given mode. `objid` is the key's low 32 bits, as pg_locks
   *  reports a bigint advisory key. */
  const keyLocks = async (mode: 'ShareLock' | 'ExclusiveLock', granted: boolean): Promise<number> => {
    const rows = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM pg_locks
        WHERE locktype = 'advisory' AND mode = $1 AND granted = $2
          AND objid = (${KEY}::bigint & 4294967295) AND classid = ((${KEY}::bigint >> 32) & 4294967295)`, mode, granted);
    return Number(rows[0].n);
  };

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    await sanctionedConsumerRemoval(prisma, [C]);
    registerConsumer(consumer(C));
    await syncConsumerCatalog(prisma);
  });

  afterAll(async () => {
    unregisterConsumer(C);
    await sanctionedConsumerRemoval(prisma, [C]);
    await prisma.$disconnect();
  });

  // ── the rules the rows carry ──────────────────────────────────────────────────────────────
  it('every compiled consumer\'s row carries the rule the code declares (the migration\'s backfill), and a row born under A6c carries its declaration', async () => {
    for (const c of compiled()) {
      expect(await ruleOf(prisma, c.name), c.name).toEqual(persistedRule(c.dispatchRule));
    }
    // the suite's own consumer was CREATED by `syncConsumerCatalog` after the migration: rule at birth
    expect(await ruleOf(prisma, C)).toEqual({ dispatchRule: 'types', subscribedEventTypes: ['decision.approved', 'decision.published'] });
  });

  it('the migration is on ALWAYS_EXECUTE, and re-applied over the migrated database it rewrites no rule and re-issues the seals', async () => {
    const list = readFileSync(join(__dirname, '..', '..', 'scripts', 'migrate.sh'), 'utf8').match(/ALWAYS_EXECUTE="([^"]+)"/)?.[1] ?? '';
    const entries = list.split('\n').map((l) => l.trim());
    expect(entries).toContain(MIGRATION);
    const before = await prisma.outboxConsumerCatalog.findMany({ orderBy: { consumer: 'asc' }, select: { consumer: true, dispatchRule: true, subscribedEventTypes: true, active: true, activationSeq: true } });
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    // as a replay runs it: this file and every ALWAYS_EXECUTE file after it, in ledger order
    for (const m of entries.filter((m) => m >= MIGRATION).sort()) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', join(__dirname, '..', '..', 'prisma', 'migrations', m, 'migration.sql')], { stdio: 'pipe' });
    }
    const after = await prisma.outboxConsumerCatalog.findMany({ orderBy: { consumer: 'asc' }, select: { consumer: true, dispatchRule: true, subscribedEventTypes: true, active: true, activationSeq: true } });
    expect(after).toEqual(before);
    const triggers = await prisma.$queryRaw<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger WHERE tgrelid = '"OutboxConsumerCatalog"'::regclass AND NOT tgisinternal ORDER BY tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual([
      'OutboxConsumerCatalog_t4d_registration_barrier', 'OutboxConsumerCatalog_t4d_registration_head', 'OutboxConsumerCatalog_t4d_rules']);
  });

  // ── verification at startup: the process refuses drift and never writes an existing rule ────
  it('`syncConsumerCatalog` refuses a compiled rule that differs from the persisted one, naming both, and rewrites nothing', async () => {
    const before = await ruleOf(prisma, C);
    registerConsumer(consumer(C, { kind: 'all' }));
    try {
      await expect(syncConsumerCatalog(prisma)).rejects.toThrow(/contract drift for 'test\.a6c\.rules'[\s\S]*persisted dispatch rule types\[decision\.approved,decision\.published\] != compiled all[\s\S]*never writes a rule that already exists/);
      registerConsumer(consumer(C, { kind: 'types', eventTypes: ['decision.published'] }));
      await expect(syncConsumerCatalog(prisma)).rejects.toThrow(/persisted dispatch rule types\[decision\.approved,decision\.published\] != compiled types\[decision\.published\]/);
    } finally {
      registerConsumer(consumer(C));
    }
    expect(await ruleOf(prisma, C)).toEqual(before);
    await syncConsumerCatalog(prisma); // the matching declaration passes
  });

  it('a compiled consumer meeting a row with NO rule (one no migration knew) is refused at startup by name', async () => {
    const NORULE = 'test.a6c.norule';
    await sanctionedConsumerRemoval(prisma, [NORULE]);
    // a row planted past `syncConsumerCatalog` — the registration head and the barrier admit it, rule-less
    await prisma.$executeRawUnsafe(
      `INSERT INTO "OutboxConsumerCatalog" ("consumer","consumerKind","consumerEffect","catalogVersion","active","updatedAt") VALUES ($1,'unordered','external',1,true,now())`, NORULE);
    expect(await ruleOf(prisma, NORULE)).toEqual({ dispatchRule: null, subscribedEventTypes: [] });
    registerConsumer(consumer(NORULE, { kind: 'all' }));
    try {
      await expect(syncConsumerCatalog(prisma)).rejects.toThrow(/contract drift for 'test\.a6c\.norule'[\s\S]*persisted dispatch rule NONE \(no rule persisted\) != compiled all/);
      expect(await ruleOf(prisma, NORULE)).toEqual({ dispatchRule: null, subscribedEventTypes: [] }); // not repaired by startup
    } finally {
      unregisterConsumer(NORULE);
      await sanctionedConsumerRemoval(prisma, [NORULE]);
    }
  });

  // ── the freeze: rewritten only under the rule gate ───────────────────────────────────────
  it('a direct UPDATE of dispatchRule or subscribedEventTypes is refused; the same UPDATE under the rule gate is admitted; A6b\'s arms stand on the re-issued function', async () => {
    await rolledBack(async (tx) => {
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "dispatchRule" = 'all', "subscribedEventTypes" = ARRAY[]::TEXT[] WHERE "consumer" = $1`, C))
        .toMatch(/SEALED EVIDENCE[\s\S]*this UPDATE \(gate off\) is refused/);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "subscribedEventTypes" = ARRAY['decision.published'] WHERE "consumer" = $1`, C))
        .toMatch(/SEALED EVIDENCE[\s\S]*gate off/);
      // a column outside the seal still moves
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "updatedAt" = now() WHERE "consumer" = $1`, C)).toBeNull();
      // A6b's arms, on the function this unit re-issues
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "active" = false WHERE "consumer" = $1`, C))
        .toMatch(/MIRROR[\s\S]*direct UPDATE \(trigger depth 1, marker off\)/);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "registeredAt" = now() WHERE "consumer" = $1`, C))
        .toMatch(/"registeredAt"[\s\S]*FROZEN/);
      // the gate: the migration's own path
      await tx.$executeRawUnsafe(`SELECT set_config('vitan.outbox_catalog_rule_migration', 'on', true)`);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "dispatchRule" = 'all', "subscribedEventTypes" = ARRAY[]::TEXT[] WHERE "consumer" = $1`, C)).toBeNull();
      expect(await ruleOf(tx, C)).toEqual({ dispatchRule: 'all', subscribedEventTypes: [] });
      // the gate admits the RULE columns alone: the mirror stays the register's
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "active" = false WHERE "consumer" = $1`, C)).toMatch(/MIRROR/);
      await tx.$executeRawUnsafe(`SELECT set_config('vitan.outbox_catalog_rule_migration', 'off', true)`);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "dispatchRule" = 'push' WHERE "consumer" = $1`, C)).toMatch(/SEALED EVIDENCE/);
    });
    expect(await ruleOf(prisma, C)).toEqual({ dispatchRule: 'types', subscribedEventTypes: ['decision.approved', 'decision.published'] });
  });

  it('the CHECKs hold the vocabulary even under the gate: an unknown kind, a list outside `types`, a blank or whitespace type name', async () => {
    await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('vitan.outbox_catalog_rule_migration', 'on', true)`);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "dispatchRule" = 'sometimes', "subscribedEventTypes" = ARRAY[]::TEXT[] WHERE "consumer" = $1`, C)).toMatch(/OutboxConsumerCatalog_t4d_rule_kind/);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "dispatchRule" = 'all' WHERE "consumer" = $1`, C)).toMatch(/OutboxConsumerCatalog_t4d_rule_types/);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "dispatchRule" = NULL WHERE "consumer" = $1`, C)).toMatch(/OutboxConsumerCatalog_t4d_rule_types/);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "subscribedEventTypes" = ARRAY['decision.published',''] WHERE "consumer" = $1`, C)).toMatch(/OutboxConsumerCatalog_t4d_rule_type_names/);
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "subscribedEventTypes" = ARRAY['decision.published',' decision.approved'] WHERE "consumer" = $1`, C)).toMatch(/OutboxConsumerCatalog_t4d_rule_type_names/);
      // well-formed shapes are admitted: an empty subscription, and no rule with no list
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "dispatchRule" = 'types', "subscribedEventTypes" = ARRAY[]::TEXT[] WHERE "consumer" = $1`, C)).toBeNull();
      expect(await attempt(tx, `UPDATE "OutboxConsumerCatalog" SET "dispatchRule" = NULL WHERE "consumer" = $1`, C)).toBeNull();
    });
  });

  // ── the barrier: the EXCLUSIVE half, on every INSERT ─────────────────────────────────────
  it('a catalog INSERT waits behind a session holding the registration key SHARED (an event\'s obligation read), and proceeds when it releases', async () => {
    const LATE = 'test.a6c.late';
    await sanctionedConsumerRemoval(prisma, [LATE]);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // A: the event's half — SHARED — held open
    const a = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(${KEY}) /* a6c-A */`);
      await held;
      throw SENTINEL;
    }, { timeout: 60_000 }).catch((e) => { if (e !== SENTINEL) throw e; });
    await waitFor('A to hold the key SHARED', async () => (await keyLocks('ShareLock', true)) === 1);
    // B: a registration through the delivered creator — its INSERT meets the barrier trigger
    registerConsumer(consumer(LATE, { kind: 'all' }));
    const b = syncConsumerCatalog(prisma);
    try {
      // OBSERVED BLOCKED: the lock manager records B's EXCLUSIVE request, not granted, while A holds
      await waitFor('B waiting for the key EXCLUSIVE', async () => (await keyLocks('ExclusiveLock', false)) === 1);
      expect(await keyLocks('ShareLock', true)).toBe(1);
      expect(await prisma.outboxConsumerCatalog.findUnique({ where: { consumer: LATE } })).toBeNull(); // not yet registered
      release();
      await a;
      await b;
      expect(await ruleOf(prisma, LATE)).toEqual({ dispatchRule: 'all', subscribedEventTypes: [] });
    } finally {
      release();
      unregisterConsumer(LATE);
      await sanctionedConsumerRemoval(prisma, [LATE]);
    }
  });

  it('the reverse: an uncommitted catalog INSERT holds the key EXCLUSIVE, so the event\'s SHARED acquisition waits for the registration to settle', async () => {
    const HOLD = 'test.a6c.hold';
    await sanctionedConsumerRemoval(prisma, [HOLD]);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // A: a direct INSERT (through the trigger), held open and then rolled back
    const a = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "OutboxConsumerCatalog" ("consumer","consumerKind","consumerEffect","catalogVersion","active","dispatchRule","updatedAt") VALUES ($1,'unordered','external',1,true,'all',now()) /* a6c-hold */`, HOLD);
      await held;
      throw SENTINEL;
    }, { timeout: 60_000 }).catch((e) => { if (e !== SENTINEL) throw e; });
    await waitFor('A to hold the key EXCLUSIVE', async () => (await keyLocks('ExclusiveLock', true)) === 1);
    // B: the event's half (its own statement-transaction; the function returns void, so executeRaw).
    // Started EAGERLY: a bare PrismaPromise is lazy and would not be sent until awaited.
    const b = (async () => { await prisma.$executeRawUnsafe(`SELECT pg_advisory_xact_lock_shared(${KEY}) /* a6c-B */`); })();
    try {
      await waitFor('B waiting for the key SHARED', async () => (await keyLocks('ShareLock', false)) === 1);
      expect(await keyLocks('ExclusiveLock', true)).toBe(1);
      release();
      await a; // rolled back: the row never existed
      await b;
      expect(await prisma.outboxConsumerCatalog.findUnique({ where: { consumer: HOLD } })).toBeNull();
    } finally {
      release();
      await sanctionedConsumerRemoval(prisma, [HOLD]);
    }
  });
});
