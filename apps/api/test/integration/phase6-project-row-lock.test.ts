import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { lockProjectReadiness } from '../../src/common/readiness-lock';

/**
 * Phase 6 correction (20271225000000) — the Project row lock a seal takes to judge operability is
 * `FOR NO KEY UPDATE`, proven against live PostgreSQL.
 *
 * `phase6_project_operable` and `phase6_user_decision_authority` lock the project row to read
 * `archivedAt`, so an archive cannot commit between the read and the
 * write it authorises. `FOR UPDATE` also conflicted with the `FOR KEY SHARE` a ledgered command's
 * receipt holds on the row through `CommandExecution_tenant_fkey`, so a command holding the
 * readiness key deadlocked with any other command on the project that had reserved its receipt and
 * was waiting for that key.
 *
 * Each probe is deterministic: the concurrent transaction is HELD at a known point, and the call
 * under test runs with a `lock_timeout`, so a lock it must wait for surfaces as `55P03` instead of
 * a hang.
 */
describe('Project row lock — FOR NO KEY UPDATE (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });

  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  };
  const ROLLBACK = new Error('rolled back on purpose');

  /**
   * Hold a transaction open after `work`, until released, then ROLL IT BACK so the probe leaves no
   * row behind. Returns once the work has run (its locks are held).
   */
  const hold = async (work: (tx: Prisma.TransactionClient) => Promise<void>) => {
    const ready = deferred();
    const release = deferred();
    const done = t.prisma.$transaction(async (tx) => {
      await work(tx);
      ready.resolve();
      await release.promise;
      throw ROLLBACK;
    }, { timeout: 20_000 }).catch((e) => { if (e !== ROLLBACK) throw e; });
    await ready.promise;
    return async () => { release.resolve(); await done; };
  };

  /** A ledgered command's first write: its `reserved` receipt, referencing the project row. */
  const reserveReceipt = (tx: Prisma.TransactionClient) => tx.commandExecution.create({
    data: {
      scopeKind: 'project', organizationId: f.orgA.id, projectId: f.projectA.id, actorId: f.memberUser.id,
      commandType: 'probe.row_lock', idempotencyKey: `probe-${randomUUID()}`, requestHash: 'probe', status: 'reserved',
    },
  }).then(() => undefined);

  /** An uncommitted archive of the project: the write the lock exists to serialise with. */
  const archive = (tx: Prisma.TransactionClient) =>
    tx.project.update({ where: { id: f.projectA.id }, data: { archivedAt: new Date() } }).then(() => undefined);

  /** Run `call` under a lock timeout: its answer, or `lock-timeout` when it had to wait. */
  const underTimeout = async (call: (tx: Prisma.TransactionClient) => Promise<boolean>) => {
    try {
      return await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '750ms'`);
        return call(tx);
      });
    } catch (e) {
      if (/55P03|lock timeout/i.test(String(e))) return 'lock-timeout' as const;
      throw e;
    }
  };

  const bool = async (tx: Prisma.TransactionClient, sql: string, ...args: unknown[]) =>
    (await tx.$queryRawUnsafe<Array<{ v: boolean }>>(sql, ...args))[0]!.v;

  const primitives: Array<[string, (tx: Prisma.TransactionClient) => Promise<boolean>]> = [
    ['phase6_project_operable', (tx) => bool(tx, `SELECT phase6_project_operable($1) AS v`, f.projectA.id)],
    ['phase6_user_decision_authority', (tx) => bool(tx, `SELECT phase6_user_decision_authority($1, $2) AS v`, f.projectA.id, f.memberUser.id)],
  ];

  it.each(primitives)('%s answers beside another command\'s held receipt, without waiting on it', async (_name, call) => {
    const releaseReceipt = await hold(reserveReceipt);
    try {
      // RED under FOR UPDATE: the receipt's foreign-key KEY SHARE blocks the row lock → 55P03.
      expect(await underTimeout(call)).toBe(true);
    } finally {
      await releaseReceipt();
    }
  });

  it.each(primitives)('%s still waits for an uncommitted archive of the project', async (_name, call) => {
    const releaseArchive = await hold(archive);
    try {
      expect(await underTimeout(call), 'the lock must still serialise with the archive it guards against').toBe('lock-timeout');
    } finally {
      await releaseArchive();
    }
  });

  it('the interleaving that deadlocked: a command holding the readiness key reaches the seal while another waits for the key', async () => {
    // B: reserved its receipt (KEY SHARE on the project) and now waits for the readiness key.
    // A: holds the readiness key and calls the seal primitive. Under FOR UPDATE, A waits on B's
    // KEY SHARE while B waits on A's key, and PostgreSQL aborts one of them with 40P01.
    const aHasKey = deferred();
    const aDone = deferred();
    const bReserved = deferred();
    const outcomes: string[] = [];
    const a = t.prisma.$transaction(async (tx) => {
      await reserveReceipt(tx);
      await lockProjectReadiness(tx, f.projectA.id);
      aHasKey.resolve();
      await bReserved.promise;
      await new Promise((r) => setTimeout(r, 300)); // B is now queued on the readiness key
      const operable = await bool(tx, `SELECT phase6_project_operable($1) AS v`, f.projectA.id);
      outcomes.push(`A operable=${operable}`);
      aDone.resolve();
      throw ROLLBACK;
    }, { timeout: 20_000 }).catch((e) => { if (e !== ROLLBACK) throw e; });
    await aHasKey.promise;
    const b = t.prisma.$transaction(async (tx) => {
      await reserveReceipt(tx);
      bReserved.resolve();
      await lockProjectReadiness(tx, f.projectA.id);
      outcomes.push('B has the key');
      throw ROLLBACK;
    }, { timeout: 20_000 }).catch((e) => { if (e !== ROLLBACK) throw e; });

    const settled = await Promise.allSettled([a, b]);
    for (const s of settled) {
      expect(s.status, s.status === 'rejected' ? String(s.reason) : '').toBe('fulfilled');
    }
    await aDone.promise;
    expect(outcomes).toEqual(['A operable=true', 'B has the key']);
  });

  it('the migration re-applies over itself and leaves both functions on FOR NO KEY UPDATE', async () => {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pmcvitan_test');
    url.search = '';
    const file = join(__dirname, '../../prisma/migrations/20271225000000_phase6_project_row_lock_no_key/migration.sql');
    for (let i = 0; i < 2; i++) {
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', url.toString(), '-f', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
    const rows = await t.prisma.$queryRawUnsafe<Array<{ proname: string; prosrc: string }>>(
      `SELECT proname, prosrc FROM pg_proc WHERE proname IN ('phase6_project_operable', 'phase6_user_decision_authority') ORDER BY proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['phase6_project_operable', 'phase6_user_decision_authority']);
    for (const r of rows) {
      expect(r.prosrc, r.proname).toMatch(/FROM "Project" WHERE "id" = p_project FOR NO KEY UPDATE;/);
      expect(r.prosrc, r.proname).not.toMatch(/FOR UPDATE/);
    }
  });
});
