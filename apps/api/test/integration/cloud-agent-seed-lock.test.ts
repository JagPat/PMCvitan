import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LOCK_SQL = "SELECT pg_advisory_lock(hashtext('vitan-pmc-destructive-seed'))";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('vitan-pmc-destructive-seed'))";
const MARKER_ID = 'cloud-agent-seed-complete';
const SEED_PROJECT_ID = 'ambli';
const apiRoot = join(__dirname, '../..');

function oneConnectionUrl(): string {
  const raw = process.env.DATABASE_URL ?? '';
  if (/[?&]connection_limit=/i.test(raw)) {
    return raw.replace(/([?&]connection_limit=)[^&]*/i, '$11');
  }
  return `${raw}${raw.includes('?') ? '&' : '?'}connection_limit=1`;
}

function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 1);
    });
  });
}

/**
 * Overlapping `pnpm seed` must serialize on the same session advisory lock seed.ts
 * takes before wiping the completion marker. The barrier uses pg_stat_activity (not
 * sleep). The fault probe kills the holder and asserts the marker exists only with
 * the complete ambli fixture.
 */
describe('cloud-agent destructive seed lock', () => {
  let observer: PrismaClient;
  let holder: PrismaClient;
  let waiter: PrismaClient;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes('test')) {
      throw new Error('Refusing to run integration tests: DATABASE_URL must point at a disposable *test* database');
    }
    const url = oneConnectionUrl();
    observer = new PrismaClient();
    holder = new PrismaClient({ datasources: { db: { url } } });
    waiter = new PrismaClient({ datasources: { db: { url } } });
    await Promise.all([observer.$connect(), holder.$connect(), waiter.$connect()]);
  });

  afterAll(async () => {
    await holder?.$executeRawUnsafe(UNLOCK_SQL).catch(() => undefined);
    await waiter?.$executeRawUnsafe(UNLOCK_SQL).catch(() => undefined);
    await Promise.all([holder?.$disconnect(), waiter?.$disconnect(), observer?.$disconnect()]);
  });

  const waitUntilBlockedOnSeedLock = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const rows = await observer.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND wait_event = 'advisory'
            AND state = 'active'
            AND query ILIKE '%vitan-pmc-destructive-seed%'
            AND pid <> pg_backend_pid()`,
      );
      if (Number(rows[0]!.c) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('barrier timeout: expected a backend blocked on the destructive-seed advisory lock');
  };

  const waitUntilHoldingSeedLock = async (): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      const rows = await observer.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM pg_locks l
           JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE l.locktype = 'advisory'
            AND l.granted
            AND a.query ILIKE '%vitan-pmc-destructive-seed%'
            AND a.pid <> pg_backend_pid()`,
      );
      if (Number(rows[0]!.c) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('barrier timeout: expected a backend holding the destructive-seed advisory lock');
  };

  it('seed.ts takes the lock before deleteMany and unlocks in finally', () => {
    const text = readFileSync(join(__dirname, '../../prisma/seed.ts'), 'utf8');
    const lock = text.indexOf(LOCK_SQL);
    const drop = text.indexOf("auditLog.deleteMany({ where: { id: 'cloud-agent-seed-complete' } })");
    const unlock = text.indexOf(UNLOCK_SQL);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(drop).toBeGreaterThan(lock);
    expect(unlock).toBeGreaterThanOrEqual(0);
    expect(text).toMatch(/finally\s*\{[\s\S]*pg_advisory_unlock/u);
  });

  it('a second session blocks on the lock until the first releases', async () => {
    await holder.$executeRawUnsafe(LOCK_SQL);

    const waiterLock = waiter.$executeRawUnsafe(LOCK_SQL);
    const reflected = waiterLock.then(
      () => ({ status: 'fulfilled' as const }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );

    await waitUntilBlockedOnSeedLock();

    await holder.$executeRawUnsafe(UNLOCK_SQL);
    const outcome = await reflected;
    expect(outcome.status).toBe('fulfilled');
    await waiter.$executeRawUnsafe(UNLOCK_SQL);
  });

  it('killed overlapping seed cannot leave a completion marker without the ambli fixture', async () => {
    const spawnSeed = (): ChildProcess =>
      spawn('pnpm', ['exec', 'tsx', 'prisma/seed.ts'], {
        cwd: apiRoot,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

    const first = spawnSeed();
    await waitUntilHoldingSeedLock();
    const second = spawnSeed();
    await waitUntilBlockedOnSeedLock();
    first.kill('SIGKILL');
    const code = await exitCode(second);
    expect(code).toBe(0);

    const marker = await observer.auditLog.findUnique({ where: { id: MARKER_ID } });
    const project = await observer.project.findUnique({ where: { id: SEED_PROJECT_ID } });
    expect(marker).not.toBeNull();
    expect(project).not.toBeNull();
    expect(marker?.entityId).toBe(SEED_PROJECT_ID);
  }, 180_000);
});
