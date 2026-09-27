import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import {
  ReleaseLeaseService, compiledCatalogVersion, newInstanceId, releaseIdentity, renewLease, writeLease,
  RELEASE_LEASE_TTL_SECONDS,
} from '../../src/platform/release-lease.service';
import { listConsumers } from '../../src/platform/outbox/registry';

/**
 * Phase 6 task 4d unit 4d-ii-a — the writers witness and the `ReleaseLease` startup writer, proven
 * against live PostgreSQL and 4d-i's lease seals.
 *
 * 4d-i's replay audits refuse to adopt 4d-shaped data unless `phase6_t4d_ii_installed()`: the
 * witness `platform_t4d_ii_writers_installed()` AND a lease. Migration 20271226 installs the witness
 * and drops the dark window's INSERT door; the startup writer is the lease.
 *
 * EVERY lease below is written inside a transaction the test rolls back. A committed lease is
 * permanent (`ReleaseLease_t4d_frozen` refuses DELETE) and would switch 4d-i's replay audits off in
 * the shared test database, which is exactly why the service itself does nothing under
 * `NODE_ENV=test`.
 */
describe('4d-ii-a — the writers witness and the ReleaseLease startup writer (live PG)', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t?.close(); });

  const ROLLBACK = new Error('rolled back on purpose');
  /** Run `body` in a transaction and roll it back, so no lease survives the probe. */
  const inRolledBack = async (body: (tx: Prisma.TransactionClient) => Promise<void>) => {
    await t.prisma.$transaction(async (tx) => { await body(tx); throw ROLLBACK; })
      .catch((e) => { if (e !== ROLLBACK) throw e; });
  };
  const one = async <T>(tx: Prisma.TransactionClient, sql: string, ...args: unknown[]) =>
    (await tx.$queryRawUnsafe<T[]>(sql, ...args))[0]!;

  it('the migration DECLARES 4d-ii and stands the dark window\'s INSERT door down', async () => {
    const r = await one<{ declared: boolean; door: bigint }>(t.prisma as unknown as Prisma.TransactionClient,
      `SELECT phase6_t4d_ii_declared() AS declared,
              (SELECT count(*) FROM pg_trigger WHERE tgname = 'ReleaseLease_t4d_insert_reserved' AND NOT tgisinternal) AS door`);
    expect(r.declared).toBe(true);
    expect(Number(r.door)).toBe(0);
  });

  it('a serving process registers its lease on the database clock, and only then is 4d-ii INSTALLED', async () => {
    await inRolledBack(async (tx) => {
      const installedBefore = await one<{ v: boolean }>(tx, `SELECT phase6_t4d_ii_installed() AS v`);
      const lease = { instanceId: newInstanceId(), catalogVersion: compiledCatalogVersion(), release: 'r-probe' };
      await writeLease(tx, lease);
      const row = await one<{ catalogVersion: number; release: string; ttl: number; installed: boolean }>(tx,
        `SELECT "catalogVersion", "release",
                EXTRACT(EPOCH FROM ("leaseUntil" - "startedAt"))::int AS ttl,
                phase6_t4d_ii_installed() AS installed
           FROM "ReleaseLease" WHERE "instanceId" = $1`, lease.instanceId);
      expect(row).toMatchObject({ catalogVersion: lease.catalogVersion, release: 'r-probe', ttl: RELEASE_LEASE_TTL_SECONDS });
      // the serving witness needs the lease; on this database no process has served yet
      expect(installedBefore.v, 'no lease has been written on the test database').toBe(false);
      expect(row.installed, 'declared AND a lease').toBe(true);
    });
  });

  it('the renewal only ever extends, which is the one move the seal admits', async () => {
    await inRolledBack(async (tx) => {
      const instanceId = newInstanceId();
      await writeLease(tx, { instanceId, catalogVersion: 2, release: 'r-probe', ttlSeconds: 60 });
      const until = async () => (await one<{ u: Date }>(tx, `SELECT "leaseUntil" AS u FROM "ReleaseLease" WHERE "instanceId" = $1`, instanceId)).u.getTime();
      const before = await until();
      expect(await renewLease(tx, instanceId, 3600)).toBe(1);
      const extended = await until();
      expect(extended).toBeGreaterThan(before);
      // a renewal asking for LESS than the lease already holds leaves it where it stands
      expect(await renewLease(tx, instanceId, 1)).toBe(1);
      expect(await until()).toBe(extended);
    });
  });

  it('a lease that has already LAPSED on the database clock is not revived by a renewal (#646 review, 4114736200)', async () => {
    await inRolledBack(async (tx) => {
      const instanceId = newInstanceId();
      // ttl 0: leaseUntil = startedAt = this transaction's CURRENT_TIMESTAMP, i.e. no longer live
      await writeLease(tx, { instanceId, catalogVersion: 2, release: 'r-probe', ttlSeconds: 0 });
      const before = await one<{ u: Date }>(tx, `SELECT "leaseUntil" AS u FROM "ReleaseLease" WHERE "instanceId" = $1`, instanceId);
      expect(await renewLease(tx, instanceId), 'the renewal matches only a live lease').toBe(0);
      const after = await one<{ u: Date }>(tx, `SELECT "leaseUntil" AS u FROM "ReleaseLease" WHERE "instanceId" = $1`, instanceId);
      expect(after.u.getTime()).toBe(before.u.getTime());
    });
  });

  it('without this unit\'s migration the writer is refused: the 4d-i door, re-installed, meets the first lease', async () => {
    // What a pre-4d-ii database carries, reconstructed inside a rolled-back transaction: the lease
    // door 4d-i installs over an undeclared database. The writer cannot pass it.
    await expect(inRolledBack(async (tx) => {
      await tx.$executeRawUnsafe(
        `CREATE TRIGGER "ReleaseLease_t4d_insert_reserved" BEFORE INSERT ON "ReleaseLease"
           FOR EACH ROW EXECUTE FUNCTION platform_t4d_release_lease_insert_reserved()`);
      await writeLease(tx, { instanceId: newInstanceId(), catalogVersion: 2, release: 'r-probe' });
    })).rejects.toThrow(/takes no INSERT yet/);
  });

  it('the compiled catalog version is the highest registered consumer contract; the release comes from the deployment', () => {
    expect(compiledCatalogVersion()).toBe(Math.max(...listConsumers().map((c) => c.catalogVersion)));
    expect(releaseIdentity({ SOURCE_COMMIT: ' abc123 ', RELEASE_ID: 'r-9' } as NodeJS.ProcessEnv)).toBe('abc123');
    expect(releaseIdentity({ RELEASE_ID: 'r-9' } as NodeJS.ProcessEnv)).toBe('r-9');
    expect(releaseIdentity({} as NodeJS.ProcessEnv)).toBe('unreleased');
    expect(newInstanceId()).not.toBe(newInstanceId());
  });

  it('the service writes nothing under NODE_ENV=test, so a test boot never plants a permanent lease', async () => {
    const before = await t.prisma.releaseLease.count();
    await t.app.get(ReleaseLeaseService).register();
    expect(await t.prisma.releaseLease.count()).toBe(before);
  });

  it('the migration re-applies over itself', () => {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pmcvitan_test');
    url.search = '';
    const file = join(__dirname, '../../prisma/migrations/20271226000000_phase6_t4d_ii_release_lease_writer/migration.sql');
    for (let i = 0; i < 2; i++) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', url.toString(), '-f', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
  });
});
