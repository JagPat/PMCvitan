import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import {
  SERVER_GENERATION, SERVER_GENERATION_MIGRATION, assertServerGenerationAdmitted, holdAdmission, readServerMinimum,
} from '../../src/platform/server-generation';
import { OutboxBootstrap } from '../../src/platform/outbox/outbox.bootstrap';
import { judgeDrain, readDrainInputsFromDatabase, readLiveLeases, readPersistedCatalogMaximum } from '../../src/platform/rollout/drain-evidence';
import { newInstanceId, writeLease } from '../../src/platform/release-lease.service';

/**
 * Phase 6 task 4d unit 4d-ii-a / A6e — the SERVER-GENERATION FENCE against live PostgreSQL (the
 * staging document, "The drain"), and the drain evidence's database reads.
 *
 * What is proven, each arm RED against its own defect:
 *   - the migration persisted THIS build's generation and the booted application was admitted through
 *     the fence; a build below the minimum, or a database with no minimum, is refused;
 *   - the register is written only inside a migration's DDL transition — a direct write, and a write
 *     under a marker another transaction committed, are refused;
 *   - the minimum is only ever RAISED, inside the transition too; a raise must record its own
 *     provenance (a new `raisedBy`, a later `raisedAt`); an UPDATE that raises nothing may not
 *     rewrite the evidence of the raise; re-running the migration's own raise after a later one
 *     changes nothing (GREATEST);
 *   - the admission read is serialized with the raise: a raise in flight blocks an admission, which
 *     then reads the raised minimum and is refused; an admission held to serving blocks the raise
 *     (#663's review round 1, finding 2); the bootstrap's hold (`holdAdmission`) keeps the row's
 *     SHARE lock past the serving steps until it is released, and the booted application's hold
 *     was released by the harness (round 2, finding 1);
 *   - the row is never deleted or truncated;
 *   - the migration is on `ALWAYS_EXECUTE` and re-applied over the migrated database moves nothing;
 *   - `rollout:drain-evidence`'s reads: the LIVE leases (an expired one is not), the persisted catalog
 *     maximum, the persisted minimum and the compiled generation, judged to `not-drained` on a live
 *     lease below the minimum.
 *
 * Every write below runs inside a transaction the test rolls back (a raise is permanent), except the
 * migration re-apply, which is re-runnable by contract and moves nothing.
 */
describe('4d-ii-a / A6e — the server-generation fence and the drain evidence (live PG)', () => {
  let t: TestApp;
  type Tx = Prisma.TransactionClient;
  const SENTINEL = new Error('rollback');
  const MIGRATION = join(__dirname, '..', '..', 'prisma', 'migrations', SERVER_GENERATION_MIGRATION, 'migration.sql');
  const OPEN = "EXECUTE 'CREATE FUNCTION platform_t4d_server_generation_migration_open() RETURNS void LANGUAGE sql AS ''SELECT'''";
  const CLOSE = "EXECUTE 'DROP FUNCTION platform_t4d_server_generation_migration_open()'";
  /** one statement inside the migration transition: the marker created, the statement, the marker dropped */
  const inTransition = (sql: string) => `DO $$ BEGIN ${OPEN}; ${sql}; ${CLOSE}; END $$`;
  /** the migration's OWN raise statement, as the file carries it */
  const raiseStatement = (): string => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const m = sql.match(/DO \$\$\nBEGIN\n  EXECUTE 'CREATE FUNCTION platform_t4d_server_generation_migration_open\(\)[\s\S]*?\nEND \$\$;/);
    if (!m) throw new Error('the migration no longer carries its raise as one DO block');
    return m[0];
  };

  const rolledBack = async (body: (tx: Tx) => Promise<void>): Promise<void> => {
    let thrown: unknown = null;
    await t.prisma.$transaction(async (tx) => {
      try { await body(tx); } catch (e) { thrown = e; }
      throw SENTINEL;
    }, { timeout: 60_000 }).catch((e) => { if (e !== SENTINEL) throw e; });
    if (thrown) throw thrown;
  };
  let savepoints = 0;
  /** run one statement under a savepoint; the refusal's message, or null when admitted */
  const attempt = async (tx: Tx, sql: string): Promise<string | null> => {
    const sp = `a6e_${++savepoints}`;
    await tx.$executeRawUnsafe(`SAVEPOINT ${sp}`);
    try {
      await tx.$executeRawUnsafe(sql);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      return null;
    } catch (e) {
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${sp}`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${sp}`);
      return e instanceof Error ? e.message : String(e);
    }
  };
  const row = async (client: Tx | TestApp['prisma']) =>
    (await client.$queryRawUnsafe<Array<{ minimumGeneration: number; raisedBy: string; raisedAt: Date }>>(
      `SELECT "minimumGeneration", "raisedBy", "raisedAt" FROM "ServerGeneration" WHERE "key" = 'singleton'`))[0]!;
  const seals = async () => Number((await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
      AND tgname IN ('ServerGeneration_t4d_raised', 'ServerGeneration_t4d_retained', 'ServerGeneration_t4d_no_truncate')`))[0]!.n);

  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t?.close(); });

  it('the migration persisted THIS build\'s generation and the booted application was admitted through the fence; a build below the minimum, or no minimum, is refused', async () => {
    const persisted = await readServerMinimum(t.prisma);
    expect(persisted).toMatchObject({ minimumGeneration: SERVER_GENERATION, raisedBy: SERVER_GENERATION_MIGRATION });
    // the application under test booted through `OutboxBootstrap`, whose first act is this assertion
    const log: string[] = [];
    await expect(assertServerGenerationAdmitted(t.prisma, { log: (m) => log.push(m) })).resolves.toMatchObject({ minimumGeneration: SERVER_GENERATION });
    expect(log[0]).toMatch(new RegExp(`server generation ${SERVER_GENERATION} admitted \\(persisted minimum ${SERVER_GENERATION}, raised by ${SERVER_GENERATION_MIGRATION}\\)`));
    // an OLDER build against a raised minimum: refused before it registers anything
    await rolledBack(async (tx) => {
      await tx.$executeRawUnsafe(inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = ${SERVER_GENERATION + 1}, "raisedBy" = 'probe: a later fence-raising migration', "raisedAt" = CURRENT_TIMESTAMP WHERE "key" = 'singleton'`));
      await expect(assertServerGenerationAdmitted(tx)).rejects.toThrow(new RegExp(`compiles server generation ${SERVER_GENERATION}, below the persisted minimum ${SERVER_GENERATION + 1} raised by probe: a later fence-raising migration`));
      // and the NEXT build, compiled at the raised generation, is admitted
      await expect(assertServerGenerationAdmitted(tx, undefined, SERVER_GENERATION + 1)).resolves.toMatchObject({ minimumGeneration: SERVER_GENERATION + 1 });
    });
    expect(await row(t.prisma)).toMatchObject({ minimumGeneration: SERVER_GENERATION });
  });

  it('the register is written only inside a migration\'s DDL transition: a direct write, and one under a marker another transaction committed, are refused', async () => {
    await rolledBack(async (tx) => {
      expect(await attempt(tx, `UPDATE "ServerGeneration" SET "minimumGeneration" = 9 WHERE "key" = 'singleton'`)).toMatch(/written only inside a versioned migration's own transaction .* this UPDATE \(migration transition closed\) is refused/);
      expect(await attempt(tx, `INSERT INTO "ServerGeneration" ("key", "minimumGeneration", "raisedBy") VALUES ('other', 1, 'probe')`)).toMatch(/this INSERT \(migration transition closed\) is refused/);
      // inside the transition the singleton CHECK still refuses a second row
      expect(await attempt(tx, inTransition(`INSERT INTO "ServerGeneration" ("key", "minimumGeneration", "raisedBy") VALUES ('other', 1, 'probe')`))).toMatch(/ServerGeneration_singleton_check/);
      // a transaction-local setting is NOT the transition
      expect(await attempt(tx, `DO $$ BEGIN PERFORM set_config('vitan.server_generation_migration', 'on', true); UPDATE "ServerGeneration" SET "minimumGeneration" = 9 WHERE "key" = 'singleton'; END $$`)).toMatch(/migration transition closed/);
    });
    // a marker COMMITTED by another transaction opens nothing: it is not in progress
    await t.prisma.$executeRawUnsafe(`CREATE FUNCTION platform_t4d_server_generation_migration_open() RETURNS void LANGUAGE sql AS 'SELECT'`);
    try {
      await rolledBack(async (tx) => {
        expect(await attempt(tx, `UPDATE "ServerGeneration" SET "minimumGeneration" = 9 WHERE "key" = 'singleton'`)).toMatch(/migration transition closed/);
      });
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP FUNCTION platform_t4d_server_generation_migration_open()`);
    }
    expect(await row(t.prisma)).toMatchObject({ minimumGeneration: SERVER_GENERATION, raisedBy: SERVER_GENERATION_MIGRATION });
  });

  it('the minimum is only ever RAISED, inside the transition too; an UPDATE that raises nothing may not rewrite the evidence; the migration\'s own raise after a later one changes nothing (GREATEST)', async () => {
    await rolledBack(async (tx) => {
      const before = await row(tx);
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = 5, "raisedBy" = 'probe: a8b', "raisedAt" = CURRENT_TIMESTAMP WHERE "key" = 'singleton'`))).toBeNull();
      const raised = await row(tx);
      expect(raised).toMatchObject({ minimumGeneration: 5, raisedBy: 'probe: a8b' });
      await tx.$executeRawUnsafe(`SAVEPOINT a6e_raise5`);
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = 4 WHERE "key" = 'singleton'`))).toMatch(/only ever RAISED — 5 -> 4 is refused, whoever writes it/);
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = ${before.minimumGeneration} WHERE "key" = 'singleton'`))).toMatch(/only ever RAISED/);
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "raisedBy" = 'rewritten' WHERE "key" = 'singleton'`))).toMatch(/was not raised by this UPDATE \(still 5\), so "raisedBy" \/ "raisedAt" — the evidence of the last raise \(probe: a8b at .*\) — may not move/);
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "raisedAt" = CURRENT_TIMESTAMP + interval '1 hour' WHERE "key" = 'singleton'`))).toMatch(/may not move/);
      // a RAISE must record its own provenance (#663 round 1, finding 1): the same raiser, the same or an
      // earlier timestamp, or no timestamp at all is refused, and the refusal names the stale provenance
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = 6 WHERE "key" = 'singleton'`))).toMatch(/a raise .* \(5 -> 6\) must record its own provenance — a new "raisedBy" \(the raising migration's name, not the last raise's probe: a8b\)/);
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = 6, "raisedBy" = 'probe: a9' WHERE "key" = 'singleton'`))).toMatch(/must record its own provenance/);
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = 6, "raisedBy" = 'probe: a9', "raisedAt" = "raisedAt" - interval '1 second' WHERE "key" = 'singleton'`))).toMatch(/must record its own provenance/);
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = 6, "raisedAt" = clock_timestamp() WHERE "key" = 'singleton'`))).toMatch(/must record its own provenance/);
      // with both, the raise is admitted (clock_timestamp: a later instant inside this same transaction)
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = 6, "raisedBy" = 'probe: a9', "raisedAt" = clock_timestamp() WHERE "key" = 'singleton'`))).toBeNull();
      expect(await row(tx)).toMatchObject({ minimumGeneration: 6, raisedBy: 'probe: a9' });
      await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT a6e_raise5`);
      await tx.$executeRawUnsafe(`RELEASE SAVEPOINT a6e_raise5`);
      // a no-op re-apply is admitted, which is what the migration's ON CONFLICT does when nothing is raised
      expect(await attempt(tx, inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = 5 WHERE "key" = 'singleton'`))).toBeNull();
      // the migration's OWN raise, re-run after the later raise: GREATEST keeps 5 and its evidence
      await tx.$executeRawUnsafe(raiseStatement());
      const after = await row(tx);
      expect(after).toEqual(raised);
    });
    expect(await row(t.prisma)).toMatchObject({ minimumGeneration: SERVER_GENERATION, raisedBy: SERVER_GENERATION_MIGRATION });
  });

  it('the row is never deleted or truncated — outside and inside the transition', async () => {
    await rolledBack(async (tx) => {
      expect(await attempt(tx, `DELETE FROM "ServerGeneration"`)).toMatch(/never deleted — a process that reads no minimum is refused at startup/);
      expect(await attempt(tx, inTransition(`DELETE FROM "ServerGeneration" WHERE "key" = 'singleton'`))).toMatch(/never deleted/);
      // the hostile TRUNCATE: a statement seal fires whatever the row triggers say
      expect(await attempt(tx, `TRUNCATE "ServerGeneration"`)).toMatch(/never truncated — the persisted server-generation minimum is the fence/);
      expect(await attempt(tx, inTransition(`TRUNCATE "ServerGeneration"`))).toMatch(/never truncated/);
      expect(await row(tx)).toMatchObject({ minimumGeneration: SERVER_GENERATION });
    });
  });

  it('the admission read is serialized with the raise: a raise in flight blocks the admission, which reads only once the raise ends; an admission held to serving blocks the raise', async () => {
    const blockedOn = async (queryLike: string): Promise<number> => {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`, queryLike);
      return Number(rows[0]!.c);
    };
    /** granted table-level locks of one mode on the register: FOR SHARE takes ROW SHARE, an UPDATE ROW EXCLUSIVE */
    const tableLocks = async (mode: 'RowShareLock' | 'RowExclusiveLock'): Promise<number> => {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE c.relname = 'ServerGeneration' AND l.locktype = 'relation' AND l.mode = $1 AND l.granted`, mode);
      return Number(rows[0]!.n);
    };
    const waitFor = async (label: string, probe: () => Promise<boolean>, ms = 15_000): Promise<void> => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (await probe()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    const RAISE = inTransition(`UPDATE "ServerGeneration" SET "minimumGeneration" = ${SERVER_GENERATION + 1}, "raisedBy" = 'probe: a8b in flight', "raisedAt" = CURRENT_TIMESTAMP WHERE "key" = 'singleton'`);
    const ADMISSION_READ = `%FROM "ServerGeneration" WHERE "key" = 'singleton' FOR SHARE%`;
    const RAISE_STATEMENT = '%platform_t4d_server_generation_migration_open%';

    // (a) the raise is IN FLIGHT (uncommitted); a process booting now BLOCKS on its admission read
    //     until the raise's transaction ends. The raise is rolled back rather than committed (a
    //     committed raise is permanent on the shared database), so the released admission reads the
    //     old minimum; what is proven is the ordering — the read did not return while the raise held
    //     the row — and the refusal on a raised minimum is the first arm's.
    {
      let releaseRaise!: () => void;
      const raiseDone = new Promise<void>((r) => { releaseRaise = r; });
      const raising = t.prisma.$transaction(async (a) => {
        await a.$executeRawUnsafe(RAISE);
        await raiseDone;
        throw SENTINEL;
      }, { timeout: 60_000 }).catch((e) => { if (e !== SENTINEL) throw e; });
      try {
        await waitFor('the raise to hold the row', async () => (await tableLocks('RowExclusiveLock')) >= 1);
        let admittedAt = 0;
        const admission = t.prisma.$transaction(async (b) => { const m = await assertServerGenerationAdmitted(b); admittedAt = Date.now(); return m; }, { timeout: 60_000 });
        await waitFor('the admission read to block on the row', async () => (await blockedOn(ADMISSION_READ)) === 1);
        await new Promise((r) => setTimeout(r, 200));
        expect(admittedAt, 'the admission has not returned while the raise holds the row').toBe(0);
        const releasedAt = Date.now();
        releaseRaise();
        await raising;
        await expect(admission).resolves.toMatchObject({ minimumGeneration: SERVER_GENERATION });
        expect(admittedAt).toBeGreaterThanOrEqual(releasedAt);
      } finally {
        releaseRaise();
        await raising;
      }
    }

    // (b) an admission HELD to serving — the bootstrap's own primitive over the real client — blocks
    //     the raise; the serving steps have completed and `admitted` has resolved while the lock is
    //     still held; the raise proceeds only once the hold is released
    {
      let served = false;
      const hold = holdAdmission(t.prisma, async () => { served = true; });
      await expect(hold.admitted).resolves.toMatchObject({ minimumGeneration: SERVER_GENERATION });
      expect(served).toBe(true);
      let raising: Promise<void> | null = null;
      try {
        await waitFor('the admission to hold the row', async () => (await tableLocks('RowShareLock')) >= 1);
        raising = t.prisma.$transaction(async (a) => {
          await a.$executeRawUnsafe(RAISE);
          throw SENTINEL;
        }, { timeout: 60_000 }).catch((e) => { if (e !== SENTINEL) throw e; });
        await waitFor('the raise to block behind the admission', async () => (await blockedOn(RAISE_STATEMENT)) === 1);
        await new Promise((r) => setTimeout(r, 200));
        expect(await blockedOn(RAISE_STATEMENT), 'the raise is still waiting after the serving steps completed').toBe(1);
      } finally {
        hold.release();
      }
      await hold.ended;
      await raising; // proceeded once the hold ended, then rolled back
      expect(await blockedOn(RAISE_STATEMENT)).toBe(0);
    }
    // the booted application released its own hold after init (the harness stands in for main.ts's
    // release after listen), so the register is free; a second release is a no-op
    t.app.get(OutboxBootstrap).releaseAdmission();
    expect(await tableLocks('RowShareLock')).toBe(0);
    expect(await row(t.prisma)).toMatchObject({ minimumGeneration: SERVER_GENERATION, raisedBy: SERVER_GENERATION_MIGRATION });
  });

  it('the migration is on ALWAYS_EXECUTE and re-applied over the migrated database it moves nothing and its seals stand', async () => {
    const list = readFileSync(join(__dirname, '..', '..', 'scripts', 'migrate.sh'), 'utf8').match(/ALWAYS_EXECUTE="([^"]+)"/)?.[1] ?? '';
    expect(list.split('\n')).toContain(SERVER_GENERATION_MIGRATION);
    const before = await row(t.prisma);
    const url = new URL(process.env.DATABASE_URL!);
    url.search = '';
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url.toString(), '-f', MIGRATION], { stdio: 'pipe' });
    expect(await row(t.prisma)).toEqual(before);
    expect(await seals()).toBe(3);
    // and the marker did not survive the apply
    const marker = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*)::bigint AS n FROM pg_proc WHERE proname = 'platform_t4d_server_generation_migration_open'`);
    expect(Number(marker[0]!.n)).toBe(0);
  });

  it('rollout:drain-evidence reads the LIVE leases, the persisted catalog maximum, the persisted minimum and the compiled generation — and judges a live lease below the minimum as not drained', async () => {
    await rolledBack(async (tx) => {
      const max = await readPersistedCatalogMaximum(tx);
      expect(max).not.toBeNull();
      expect(max!).toBeGreaterThanOrEqual(1);
      const old = { instanceId: newInstanceId(), catalogVersion: 1, release: 'r-old' };
      const current = { instanceId: newInstanceId(), catalogVersion: max!, release: 'r-current' };
      // a lease that lapsed an hour ago on the database clock (written by hand: the writer's own
      // clock is CURRENT_TIMESTAMP, which is this transaction's start, and a 0-second lease rounds
      // up to it at millisecond precision)
      const expired = { instanceId: newInstanceId(), catalogVersion: 1, release: 'r-expired' };
      await writeLease(tx, old);
      await writeLease(tx, current);
      await tx.$executeRawUnsafe(
        `INSERT INTO "ReleaseLease" ("instanceId", "catalogVersion", "release", "startedAt", "leaseUntil")
         VALUES ($1, 1, 'r-expired', CURRENT_TIMESTAMP - interval '2 hours', CURRENT_TIMESTAMP - interval '1 hour')`, expired.instanceId);
      const live = await readLiveLeases(tx);
      const ids = live.map((l) => l.instanceId);
      expect(ids).toContain(old.instanceId);
      expect(ids).toContain(current.instanceId);
      expect(ids, 'a lease that has lapsed on the database clock is not live').not.toContain(expired.instanceId);
      expect(live.find((l) => l.instanceId === old.instanceId)).toMatchObject({ catalogVersion: 1, release: 'r-old' });

      const inputs = await readDrainInputsFromDatabase(tx);
      expect(inputs).toMatchObject({ compiledGeneration: SERVER_GENERATION, catalogMaximum: max, persistedMinimum: { minimumGeneration: SERVER_GENERATION, raisedBy: SERVER_GENERATION_MIGRATION } });
      const evidence = judgeDrain({
        minimumRelease: 'r-current',
        minimumCatalogVersion: { value: max!, source: 'the persisted catalog maximum' },
        compiledGeneration: inputs.compiledGeneration,
        persistedMinimum: inputs.persistedMinimum,
        platform: { inventory: { source: 'probe', application: { id: 1, uuid: 'app', name: 'api', fqdn: null, status: 'running:healthy', gitCommitSha: 'r-current' }, runningDeployments: [] } },
        leases: inputs.leases.filter((l) => [old.instanceId, current.instanceId].includes(l.instanceId)),
        classifier: { classify: (_m, r) => (r === 'r-current' ? 'at-or-after' : r === 'r-old' ? 'before' : 'unclassifiable') },
        recordedAt: new Date(),
      });
      expect(evidence.verdict).toBe(max! > 1 ? 'not-drained' : 'not-drained');
      expect(evidence.findings.join('\n')).toContain(`live lease ${old.instanceId}`);
      expect(evidence.leases.find((l) => l.instanceId === current.instanceId)).toMatchObject({ classification: 'at-or-after' });
    });
  });
});
