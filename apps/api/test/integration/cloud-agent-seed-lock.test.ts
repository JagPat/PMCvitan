import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LOCK_SQL = "SELECT pg_advisory_lock(hashtext('vitan-pmc-destructive-seed'))";
const UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('vitan-pmc-destructive-seed'))";

function oneConnectionUrl(): string {
  const raw = process.env.DATABASE_URL ?? '';
  if (/[?&]connection_limit=/i.test(raw)) {
    return raw.replace(/([?&]connection_limit=)[^&]*/i, '$11');
  }
  return `${raw}${raw.includes('?') ? '&' : '?'}connection_limit=1`;
}

/**
 * Overlapping `pnpm seed` must serialize on the same session advisory lock seed.ts
 * takes before wiping the completion marker. This probe holds that lock on one
 * backend, confirms the second is blocked (pg_stat_activity, not sleep), then
 * releases and lets the waiter acquire.
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

    let blocked = false;
    for (let i = 0; i < 200; i++) {
      const rows = await observer.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND wait_event = 'advisory'
            AND state = 'active'
            AND query ILIKE '%vitan-pmc-destructive-seed%'
            AND pid <> pg_backend_pid()`,
      );
      if (Number(rows[0]!.c) >= 1) {
        blocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(blocked).toBe(true);

    await holder.$executeRawUnsafe(UNLOCK_SQL);
    const outcome = await reflected;
    expect(outcome.status).toBe('fulfilled');
    await waiter.$executeRawUnsafe(UNLOCK_SQL);
  });
});
