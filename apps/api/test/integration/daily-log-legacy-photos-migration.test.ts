import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #482 site photos — `DailyLog.legacyPhotos`, the photos a log counts that are not Media rows filed on it. The day's
 * photo count (the next unit) is this plus the progress photos filed on the log, so a photo filed after the send
 * adds to it and nothing filed is counted twice.
 *
 * Proved against PostgreSQL: a new log starts at 0, a negative count is refused, the backfill rule leaves only the
 * photos not filed on the log, and the migration re-run is a no-op (it never recomputes a backfilled value).
 */
const MIGRATION = readFileSync(
  resolve(__dirname, '../../prisma/migrations/20280113000000_daily_log_legacy_photos/migration.sql'),
  'utf8',
);
/** the backfill statement exactly as the migration runs it */
const BACKFILL = /UPDATE "DailyLog" d[\s\S]*?\)\);/.exec(MIGRATION)![0];

describe('DailyLog.legacyPhotos (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });
  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id, uploadedBy: 'legacy-photos-test' } });
    await t?.prisma.dailyLog.deleteMany({ where: { projectId: f.projectA.id, date: 'legacy photos log' } });
    await f?.cleanup();
    await t?.close();
  });

  it('a new log starts at 0, and a negative count is refused', async () => {
    const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'legacy photos log', progress: 3 } });
    expect(log.legacyPhotos).toBe(0);
    await expect(t.prisma.dailyLog.update({ where: { id: log.id }, data: { legacyPhotos: -1 } })).rejects.toThrow(/DailyLog_legacyPhotos_nonnegative/);
  });

  it('the backfill keeps only the photos not filed on the log, never below 0', async () => {
    const sentry = new Error('rollback');
    let seen: Record<string, number> = {};
    await t.prisma
      .$transaction(async (tx) => {
        const make = (progress: number) => tx.dailyLog.create({ data: { projectId: f.projectA.id, date: 'legacy photos log', progress, submitted: true } });
        const file = (dailyLogId: string, kind = 'progress') =>
          tx.media.create({ data: { projectId: f.projectA.id, dailyLogId, kind, mime: 'image/png', data: px, uploadedBy: 'legacy-photos-test' } });
        const unfiled = await make(4); // sent before photos were filed: all 4 are legacy
        const mixed = await make(3); // 2 of its 3 are filed on it
        await file(mixed.id);
        await file(mixed.id);
        const over = await make(1); // more filed than the sender saw (one added after the send)
        await file(over.id);
        await file(over.id);
        const otherKind = await make(2); // a material photo on it is not one of the day's progress photos
        await file(otherKind.id, 'material');
        await tx.$executeRawUnsafe(BACKFILL);
        const rows = await tx.dailyLog.findMany({ where: { id: { in: [unfiled.id, mixed.id, over.id, otherKind.id] } } });
        const by = new Map(rows.map((r) => [r.id, r.legacyPhotos]));
        seen = { unfiled: by.get(unfiled.id)!, mixed: by.get(mixed.id)!, over: by.get(over.id)!, otherKind: by.get(otherKind.id)! };
        throw sentry; // nothing here outlives the proof
      })
      .catch((e) => {
        if (e !== sentry) throw e;
      });
    expect(seen).toEqual({ unfiled: 4, mixed: 1, over: 0, otherKind: 2 });
  });

  it('a re-run of the migration never recomputes a backfilled value', async () => {
    const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'legacy photos log', progress: 5 } });
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { legacyPhotos: 2 } });
    await t.prisma.$executeRawUnsafe(MIGRATION);
    expect((await t.prisma.dailyLog.findUniqueOrThrow({ where: { id: log.id } })).legacyPhotos).toBe(2);
  });
});
