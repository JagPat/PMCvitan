import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_TEMPLATE } from '../../src/domain/seed-data';

const LOCK_KEY = 'vitan-pmc-destructive-seed';
const LOCK_SQL = `SELECT pg_advisory_lock(hashtext('${LOCK_KEY}'))`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtext('${LOCK_KEY}'))`;
const SEED_PROJECT_ID = 'ambli';
const apiRoot = join(__dirname, '../..');
const repoRoot = join(apiRoot, '../..');
const tsxCli = join(
  dirname(createRequire(join(apiRoot, 'package.json')).resolve('tsx/package.json')),
  'dist/cli.mjs',
);

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
 * Completeness lives inside seed.ts under the session lock.
 * Do not spawn two `pnpm exec` children: they serialize on pnpm's store mutex
 * and never both reach Postgres (the original package-manager lock failure).
 */
describe('cloud-agent destructive seed lock', () => {
  let observer: PrismaClient;
  let holder: PrismaClient;
  let waiter: PrismaClient;
  let seedEnv: NodeJS.ProcessEnv;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? '';
    if (!url.includes('test')) {
      throw new Error('Refusing to run integration tests: DATABASE_URL must point at a disposable *test* database');
    }
    seedEnv = { ...process.env, DATABASE_URL: oneConnectionUrl() };
    observer = new PrismaClient({ datasources: { db: { url } } });
    holder = new PrismaClient({ datasources: { db: { url: seedEnv.DATABASE_URL } } });
    waiter = new PrismaClient({ datasources: { db: { url: seedEnv.DATABASE_URL } } });
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
    spawn(process.execPath, [tsxCli, 'prisma/seed.ts'], {
      cwd: apiRoot,
      env: seedEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  it('pins one backend, locks before wipe, skips using product facts (not AuditLog)', () => {
    const text = readFileSync(join(__dirname, '../../prisma/seed.ts'), 'utf8');
    const start = readFileSync(join(repoRoot, 'scripts/cloud-agent-start.sh'), 'utf8');
    const env = readFileSync(join(repoRoot, 'scripts/cloud-agent-env.sh'), 'utf8');
    expect(text).toMatch(/connection_limit=1/);
    expect(text.indexOf('pg_advisory_lock')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('fixtureComplete')).toBeGreaterThan(text.indexOf('pg_advisory_lock'));
    expect(text.indexOf('seedBody')).toBeGreaterThan(text.indexOf('fixtureComplete'));
    expect(text).toMatch(/finally\s*\{[\s\S]*UNLOCK_SQL/u);
    expect(text).toContain('STARTER_TEMPLATE.name');
    expect(text).not.toMatch(/cloud-agent-seed-complete/);
    expect(start).not.toMatch(/AuditLog/);
    expect(start).toMatch(/pnpm --filter api seed/);
    expect(env).not.toMatch(/SEED_COMPLETION_MARK/);
    expect(env).toMatch(/VITE_ALLOW_DEV_AUTH/);
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

  it('overlapping tsx seeds serialize on the advisory lock; the waiter skips using product facts', async () => {
    const db = await observer.$queryRawUnsafe<Array<{ d: string }>>('SELECT current_database() AS d');
    expect(db[0]!.d).toMatch(/test/);
    await observer.$executeRawUnsafe('DELETE FROM "ProjectTemplate"');
    await observer.$executeRawUnsafe('DELETE FROM "TemplateModule"');
    expect(
      await observer.projectTemplate.count({ where: { name: STARTER_TEMPLATE.name } }),
    ).toBe(0);

    const first = spawnSeed();
    const firstOut = collectOutput(first);
    await waitUntilSeedLock(true);

    const waiterSeed = spawnSeed();
    const waiterOut = collectOutput(waiterSeed);
    let waiterExit: number | undefined;
    void exitCode(waiterSeed).then((code) => {
      waiterExit = code;
    });
    await waitUntilSeedLock(false, () => {
      if (waiterExit !== undefined) {
        throw new Error(`second seed exited ${waiterExit} before blocking on the lock:\n${waiterOut()}`);
      }
    });

    expect(await exitCode(first), firstOut()).toBe(0);
    expect(firstOut()).toMatch(/Seeded org/);
    expect(await exitCode(waiterSeed), waiterOut()).toBe(0);
    expect(waiterOut()).toMatch(/already complete/);

    const project = await observer.project.findUnique({ where: { id: SEED_PROJECT_ID } });
    const template = await observer.projectTemplate.findFirst({
      where: { name: STARTER_TEMPLATE.name },
    });
    const forged = await observer.auditLog.findUnique({ where: { id: 'cloud-agent-seed-complete' } });
    expect(project).not.toBeNull();
    expect(template).not.toBeNull();
    expect(forged).toBeNull();

    const skip = spawnSeed();
    const skipOut = collectOutput(skip);
    expect(await exitCode(skip), skipOut()).toBe(0);
    expect(skipOut()).toMatch(/already complete/);
    const still = await observer.projectTemplate.findFirst({
      where: { name: STARTER_TEMPLATE.name },
    });
    expect(still?.id).toBe(template!.id);
  }, 180_000);
});
