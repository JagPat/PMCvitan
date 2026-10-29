import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';

/**
 * Idempotency-Key Unit 2a-m: `20280201000000_command_key_sighting` adds "CommandKeySighting", the count of requests
 * with no key or a Unit 1 `legacy-` key on five routes, per route, class and UTC day (notes/idempotency-key/u2/plan.md
 * §2). This proves the shape PostgreSQL holds on every writer, the upsert 2a will run, and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280201000000_command_key_sighting/migration.sql');
const ROUTES = ['activities.start', 'activities.complete', 'inspections.decide', 'daily-log.flag-mismatch', 'daily-log.submit'];

describe('Idempotency-Key 2a-m: the key-sighting count (live PG)', () => {
  let t: TestApp;

  beforeAll(async () => { t = await createTestApp(); });
  afterEach(async () => { await t.prisma.$executeRawUnsafe(`DELETE FROM "CommandKeySighting"`); });
  afterAll(async () => { await t?.close(); });

  const insert = (route: string, cls: string, day: string, count: number, lastAt = '2026-11-01 10:00:00') =>
    t.prisma.$executeRawUnsafe(
      `INSERT INTO "CommandKeySighting" ("route", "class", "day", "count", "lastAt") VALUES ($1, $2, $3::date, $4, $5::timestamp)`,
      route, cls, day, count, lastAt);
  /** the upsert Unit 2a runs: one statement, a row per route, class and day */
  const sight = (route: string, cls: string) =>
    t.prisma.$executeRawUnsafe(
      `INSERT INTO "CommandKeySighting" AS s ("route", "class", "day", "count", "lastAt")
         VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 1, now() AT TIME ZONE 'UTC')
       ON CONFLICT ("route", "class", "day") DO UPDATE SET "count" = s."count" + 1, "lastAt" = EXCLUDED."lastAt"`,
      route, cls);

  it('takes each of the five routes in both classes', async () => {
    for (const route of ROUTES) for (const cls of ['absent', 'legacy']) expect(await insert(route, cls, '2026-11-01', 1)).toBe(1);
  });

  it('refuses another route, another class (a keyed request is never counted), a count below one, and an infinite time', async () => {
    await expect(insert('activities.restart', 'absent', '2026-11-01', 1)).rejects.toThrow(/CommandKeySighting_shape_check/);
    await expect(insert('activities.start', 'keyed', '2026-11-01', 1)).rejects.toThrow(/CommandKeySighting_shape_check/);
    await expect(insert('activities.start', 'absent', '2026-11-01', 0)).rejects.toThrow(/CommandKeySighting_shape_check/);
    await expect(insert('activities.start', 'absent', 'infinity', 1)).rejects.toThrow(/CommandKeySighting_shape_check/);
    await expect(insert('activities.start', 'absent', '2026-11-01', 1, 'infinity')).rejects.toThrow(/CommandKeySighting_shape_check/);
  });

  it('holds one row per route, class and day', async () => {
    await insert('daily-log.submit', 'legacy', '2026-11-01', 1);
    await expect(insert('daily-log.submit', 'legacy', '2026-11-01', 2)).rejects.toThrow(/23505|unique constraint/i);
    expect(await insert('daily-log.submit', 'legacy', '2026-11-02', 1)).toBe(1);
  });

  it('the upsert adds one to the day’s row and moves its time, and holds nothing about who or what', async () => {
    await sight('inspections.decide', 'absent');
    await sight('inspections.decide', 'absent');
    await sight('inspections.decide', 'legacy');
    const rows = await t.prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT "route", "class", "count" FROM "CommandKeySighting" ORDER BY "class"`);
    expect(rows).toEqual([
      { route: 'inspections.decide', class: 'absent', count: 2 },
      { route: 'inspections.decide', class: 'legacy', count: 1 },
    ]);
    const columns = await t.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'CommandKeySighting' ORDER BY column_name`);
    expect(columns.map((c) => c.column_name)).toEqual(['class', 'count', 'day', 'lastAt', 'route']);
  });

  it('the file re-runs on a database that has it, changing nothing', async () => {
    await insert('activities.complete', 'absent', '2026-11-01', 3);
    const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
    const checks = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = '"CommandKeySighting"'::regclass AND conname = 'CommandKeySighting_shape_check'`);
    expect(checks[0]!.n).toBe(1);
    const kept = await t.prisma.$queryRawUnsafe<Array<{ count: number }>>(`SELECT "count" FROM "CommandKeySighting"`);
    expect(kept).toEqual([{ count: 3 }]);
  });
});
