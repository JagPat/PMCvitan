import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LOCK_KEY = 'vitan-pmc-destructive-seed';
const LOCK_SQL = `SELECT pg_advisory_lock(hashtext('${LOCK_KEY}'))`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtext('${LOCK_KEY}'))`;
const MARKER_ID = 'cloud-agent-seed-complete';
const SEED_PROJECT_ID = 'ambli';
const apiRoot = join(__dirname, '../..');
const tsxBin = join(apiRoot, 'node_modules/.bin/tsx');

/** Session `pg_advisory_lock(int4)` is stored as a signed-int64 tag (objsubid = 1). */
const SEED_LOCK_COUNT_SQL = `
  SELECT COUNT(*)::int AS c
    FROM pg_locks l
   WHERE l.locktype = 'advisory'
     AND l.granted = $1
     AND l.objsubid = 1
     AND l.pid <> pg_backend_pid()
     AND l.classid::bigint = ((hashtext('${LOCK_KEY}')::bigint >> 32) & 4294967295)
     AND l.objid::bigint   =  (hashtext('${LOCK_KEY}')::bigint       & 4294967295)`;

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

function collectOutput(child: ChildProcess): () => string {
  let buf = '';
  child.stdout?.on('data', (chunk: Buffer | string) => {
    buf += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    buf += chunk.toString();
  });
  return () => buf;
}

/**
 * Overlapping `pnpm seed` must serialize on the same session advisory lock seed.ts
 * takes before wiping the completion marker.
 *
 * Do not spawn two `pnpm exec` processes: they contend on pnpm's store mutex, so the
 * second never reaches Postgres while the first still holds the advisory lock.
 * Hold the lock on a Prisma session (in-flight seed A) and spawn `tsx prisma/seed.ts`
 * directly (seed B).
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

  const countSeedLocks = async (granted: boolean): Promise<number> => {
    const rows = await observer.$queryRawUnsafe<Array<{ c: number }>>(SEED_LOCK_COUNT_SQL, granted);
    return Number(rows[0]!.c);
  };

  const waitUntilSeedLock = async (granted: boolean, abort?: () => void): Promise<void> => {
    const label = granted ? 'holding' : 'blocked on';
    for (let i = 0; i < 800; i++) {
      abort?.();
      if ((await countSeedLocks(granted)) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`barrier timeout: expected a backend ${label} the destructive-seed advisory lock`);
  };

  const spawnSeed = (): ChildProcess =>
    spawn(tsxBin, ['prisma/seed.ts'], {
      cwd: apiRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

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
    await waitUntilSeedLock(true);

    const waiterLock = waiter.$executeRawUnsafe(LOCK_SQL);
    const reflected = waiterLock.then(
      () => ({ status: 'fulfilled' as const }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    );

    await waitUntilSeedLock(false);

    await holder.$executeRawUnsafe(UNLOCK_SQL);
    const outcome = await reflected;
    expect(outcome.status).toBe('fulfilled');
    await waiter.$executeRawUnsafe(UNLOCK_SQL);
  });

  it('killed overlapping seed cannot leave a completion marker without the ambli fixture', async () => {
    await holder.$executeRawUnsafe(LOCK_SQL);
    await waitUntilSeedLock(true);

    const blocked = spawnSeed();
    const blockedOut = collectOutput(blocked);
    let blockedExit: number | undefined;
    void exitCode(blocked).then((code) => {
      blockedExit = code;
    });

    await waitUntilSeedLock(false, () => {
      if (blockedExit !== undefined) {
        throw new Error(`seed exited ${blockedExit} before blocking on the lock:\n${blockedOut()}`);
      }
    });

    blocked.kill('SIGKILL');
    await exitCode(blocked);
    await holder.$executeRawUnsafe(UNLOCK_SQL);

    const recovery = spawnSeed();
    const recoveryOut = collectOutput(recovery);
    const code = await exitCode(recovery);
    expect(code, recoveryOut()).toBe(0);

    const marker = await observer.auditLog.findUnique({ where: { id: MARKER_ID } });
    const project = await observer.project.findUnique({ where: { id: SEED_PROJECT_ID } });
    expect(marker).not.toBeNull();
    expect(project).not.toBeNull();
    expect(marker?.entityId).toBe(SEED_PROJECT_ID);
  }, 180_000);
});
