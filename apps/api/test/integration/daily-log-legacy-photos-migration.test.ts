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
 * Proved against PostgreSQL: a new log starts at 0 and a negative count is refused; on a `db push` baseline (the
 * column without its CHECK or trigger) the migration backfills only the photos not filed on each log; a replay never
 * recomputes a backfilled value; the send sets it for a previous-release app's unfiled photos; any other write is
 * refused.
 */
const MIGRATION = readFileSync(
  resolve(__dirname, '../../prisma/migrations/20280113000000_daily_log_legacy_photos/migration.sql'),
  'utf8',
);
/** the migration's statements, split at top-level semicolons (outside dollar quotes), to run inside one transaction */
const STATEMENTS = ((sql: string) => {
  const out: string[] = [];
  let quote: string | null = null;
  let from = 0;
  for (let i = 0; i < sql.length; i++) {
    if (quote === null && sql.startsWith('--', i)) {
      i = sql.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
    if (tag && (quote === null || quote === tag)) {
      quote = quote === null ? tag : null;
      i += tag.length - 1;
    } else if (quote === null && sql[i] === ';') {
      out.push(sql.slice(from, i + 1));
      from = i + 1;
    }
  }
  return out;
})(MIGRATION);

describe('DailyLog.legacyPhotos (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const LOG = 'legacy photos log';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });
  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id, uploadedBy: 'legacy-photos-test' } });
    await t?.prisma.dailyLog.deleteMany({ where: { projectId: f.projectA.id, date: LOG } });
    await f?.cleanup();
    await t?.close();
  });

  const file = (db: Pick<TestApp['prisma'], 'media'>, dailyLogId: string, kind = 'progress') =>
    db.media.create({ data: { projectId: f.projectA.id, dailyLogId, kind, mime: 'image/png', data: px, uploadedBy: 'legacy-photos-test' } });
  const legacy = async (id: string) => (await t.prisma.dailyLog.findUniqueOrThrow({ where: { id } })).legacyPhotos;

  it('a new log starts at 0, and a negative count is refused', async () => {
    const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: LOG, progress: 3 } });
    expect(log.legacyPhotos).toBe(0);
    await expect(
      t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: LOG, legacyPhotos: -1 } }),
    ).rejects.toThrow(/DailyLog_legacyPhotos_nonnegative/);
  });

  it('on a db-push baseline the migration backfills only the photos not filed on each log, never below 0', async () => {
    const sentry = new Error('rollback');
    let seen: Record<string, number> = {};
    await t.prisma
      .$transaction(async (tx) => {
        // what `prisma db push` leaves: the column, without the CHECK or the trigger (nothing outlives the rollback)
        await tx.$executeRawUnsafe('DROP TRIGGER "DailyLog_legacyPhotos_frozen" ON "DailyLog"');
        await tx.$executeRawUnsafe('ALTER TABLE "DailyLog" DROP CONSTRAINT "DailyLog_legacyPhotos_nonnegative"');
        const make = (progress: number) => tx.dailyLog.create({ data: { projectId: f.projectA.id, date: LOG, progress, submitted: true } });
        const unfiled = await make(4); // sent before photos were filed: all 4 are legacy
        const mixed = await make(3); // 2 of its 3 are filed on it
        await file(tx, mixed.id);
        await file(tx, mixed.id);
        const over = await make(1); // more filed than the sender saw (one added after the send)
        await file(tx, over.id);
        await file(tx, over.id);
        const otherKind = await make(2); // a material photo on it is not one of the day's progress photos
        await file(tx, otherKind.id, 'material');
        for (const st of STATEMENTS) await tx.$executeRawUnsafe(st);
        const rows = await tx.dailyLog.findMany({ where: { id: { in: [unfiled.id, mixed.id, over.id, otherKind.id] } } });
        const by = new Map(rows.map((r) => [r.id, r.legacyPhotos]));
        seen = { unfiled: by.get(unfiled.id)!, mixed: by.get(mixed.id)!, over: by.get(over.id)!, otherKind: by.get(otherKind.id)! };
        const restored = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT ((SELECT count(*) FROM pg_constraint WHERE conname = 'DailyLog_legacyPhotos_nonnegative')
                 + (SELECT count(*) FROM pg_trigger WHERE tgname = 'DailyLog_legacyPhotos_frozen' AND tgenabled = 'O'))::int AS n`,
        );
        seen.guards = restored[0].n;
        throw sentry;
      })
      .catch((e) => {
        if (e !== sentry) throw e;
      });
    expect(seen).toEqual({ unfiled: 4, mixed: 1, over: 0, otherKind: 2, guards: 2 });
  });

  it('a replay of the migration never recomputes a backfilled value', async () => {
    const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: LOG, progress: 3 } });
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { submitted: true } }); // the send: 3 unfiled
    expect(await legacy(log.id)).toBe(3);
    await file(t.prisma, log.id); // filed after the send: the backfill rule would now say 2
    for (let run = 0; run < 2; run++) for (const st of STATEMENTS) await t.prisma.$executeRawUnsafe(st);
    expect(await legacy(log.id)).toBe(3);
  });

  it('the send sets it from the photos the sender counted that are not filed on the log', async () => {
    // a previous-release app: its photos were uploaded without a log, then it sent a count of 4
    const old = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: LOG } });
    await t.prisma.dailyLog.update({ where: { id: old.id }, data: { checkedIn: true, progress: 4, submitted: true } });
    expect(await legacy(old.id)).toBe(4);
    // a current app: both of its photos are filed on the log before its send
    const cur = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: LOG } });
    await file(t.prisma, cur.id);
    await file(t.prisma, cur.id);
    await t.prisma.dailyLog.update({ where: { id: cur.id }, data: { checkedIn: true, progress: 2, submitted: true } });
    expect(await legacy(cur.id)).toBe(0);
    // a later photo filed on the sent log changes nothing stored: the count reads it live
    await file(t.prisma, cur.id);
    expect(await legacy(cur.id)).toBe(0);
  });

  it('any other write is refused: before the send, after it, and a second send', async () => {
    const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: LOG } });
    await expect(t.prisma.dailyLog.update({ where: { id: log.id }, data: { legacyPhotos: 2 } })).rejects.toThrow(/legacyPhotos is frozen/);
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { progress: 3, submitted: true } });
    expect(await legacy(log.id)).toBe(3);
    await expect(t.prisma.dailyLog.update({ where: { id: log.id }, data: { legacyPhotos: 2 } })).rejects.toThrow(/legacyPhotos is frozen/);
    // un-sending and sending again cannot recompute a count it already holds
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { submitted: false } });
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { progress: 9, submitted: true } });
    expect(await legacy(log.id)).toBe(3);
    // every other column still updates freely
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { checkinTime: '09:00' } });
    expect(await legacy(log.id)).toBe(3);
  });
});
