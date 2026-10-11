import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';

/**
 * Top 10 #4b (#778) — the read position's storage contract, as the database enforces it.
 *
 * - Every notice records the transaction that wrote it (`writerXid`): stamped on insert whatever the insert
 *   supplies, and fixed after, so no writer can move a notice across read positions (#785 review rounds 1-2).
 * - The position is the feed's SNAPSHOT, so it is commit-ordered: a notice whose transaction began BEFORE the
 *   feed was read but committed AFTER it is not visible in that snapshot, so it stays unread, whatever its `at`
 *   (#785 review round 1).
 * - One row per (project, user); only snapshot text is accepted.
 * - The position only moves FORWARD: an UPDATE proposing an earlier snapshot (a late or replayed "mark seen") or one
 *   that is not a successor (incomparable) keeps the stored one, through the client and raw SQL alike. A stored
 *   position from another cluster is void, so a real one replaces it.
 * - It is derived per-viewer state: deleting its user takes it too.
 * - The migration really installs its guards on a `db push` baseline: it is on migrate.sh's ALWAYS_EXECUTE and
 *   re-runs cleanly over a database that has the modeled column and table but none of the raw guards.
 */
describe('Top 10 #4b — NotificationReadMark and Notification.writerXid (live PG)', () => {
  let t: TestApp;
  const run = randomUUID().slice(0, 8);
  const projectId = `rm-proj-${run}`;
  const userId = `rm-user-${run}`;

  beforeAll(async () => {
    t = await createTestApp();
    const org = await t.prisma.org.create({ data: { name: `rm-org-${run}`, slug: `rm-org-${run}` } });
    await t.prisma.project.create({
      data: { id: projectId, orgId: org.id, name: projectId, short: 'R', descriptor: '', stage: 'x', siteCode: 'R', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    await t.prisma.user.create({ data: { id: userId, projectId, role: 'pmc', name: 'RM', email: `${userId}@t.local` } });
  });

  afterAll(async () => {
    await t.prisma.notificationReadMark.deleteMany({ where: { projectId } });
    await t.prisma.notification.deleteMany({ where: { projectId } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: `rm-user-${run}` } } });
    await t.prisma.project.deleteMany({ where: { id: projectId } });
    await t.prisma.org.deleteMany({ where: { slug: `rm-org-${run}` } });
    await t.close();
  });

  const notice = (text: string) => ({ projectId, text, color: '#000', time: 'just now' });
  const visible = async (xid: bigint, snapshot: string) =>
    (await t.prisma.$queryRaw<Array<{ v: boolean }>>`SELECT pg_visible_in_snapshot(${xid.toString()}::xid8, ${snapshot}::pg_snapshot) AS v`)[0]!.v;
  /** The snapshot a feed read runs under: the first statement of a REPEATABLE READ transaction fixes it. */
  const feedSnapshot = () =>
    t.prisma.$transaction(
      async (tx) => (await tx.$queryRaw<Array<{ s: string }>>`SELECT pg_current_snapshot()::text AS s`)[0]!.s,
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

  it('records the writing transaction on every notice, without the writer naming it', async () => {
    const n = await t.prisma.notification.create({ data: notice('stamped') });
    const row = await t.prisma.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(typeof row.writerXid).toBe('bigint');
    // committed before this snapshot, so it is seen by it
    expect(await visible(row.writerXid!, await feedSnapshot())).toBe(true);
  });

  it('stamps the inserting transaction whatever an insert supplies', async () => {
    for (const supplied of ['NULL', '1']) {
      const id = `rm-n-${run}-${supplied}`;
      const [{ stamped, mine }] = await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "Notification" ("id","projectId","text","color","time","writerXid") VALUES ($1,$2,'supplied','#000','now',${supplied})`, id, projectId);
        return tx.$queryRaw<Array<{ stamped: bigint; mine: bigint }>>`
          SELECT n."writerXid" AS stamped, ((pg_current_xact_id())::text)::bigint AS mine FROM "Notification" n WHERE n."id" = ${id}`;
      });
      expect(stamped, `an insert supplying ${supplied}`).toBe(mine);
    }
  });

  it('fixes the writer at insert: an UPDATE cannot rewrite it, nor fill it on a row without one', async () => {
    const n = await t.prisma.notification.create({ data: notice('frozen') });
    await expect(t.prisma.$executeRaw`UPDATE "Notification" SET "writerXid" = 1 WHERE "id" = ${n.id}`).rejects.toThrow(/writer is fixed at insert/);
    // a row written before the column existed carries none; filling it later is refused too
    await expect(t.prisma.$executeRaw`UPDATE "Notification" SET "writerXid" = NULL WHERE "id" = ${n.id}`).rejects.toThrow(/writer is fixed at insert/);
    // other columns stay as writable as they were
    await t.prisma.notification.update({ where: { id: n.id }, data: { inspectionId: 'INSP-1' } });
  });

  it('a notice whose transaction began before the feed snapshot but committed after it is not seen by it', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let inserted!: () => void;
    const insertedSignal = new Promise<void>((r) => { inserted = r; });
    // the writer starts first and inserts (its `at` is its own start instant), then stays open
    const writer = t.prisma.$transaction(async (tx) => {
      const n = await tx.notification.create({ data: notice('late commit') });
      inserted();
      await held;
      return n.id;
    }, { timeout: 30_000 });
    await insertedSignal;
    const snapshot = await feedSnapshot(); // the viewer's feed is read while the writer is still open
    release();
    const id = await writer; // ...and commits after it
    const row = await t.prisma.notification.findUniqueOrThrow({ where: { id } });
    const mark = await t.prisma.notificationReadMark.create({ data: { projectId, userId, seenSnapshot: snapshot } });
    // the timestamp watermark would call it seen: it began before the mark was taken
    expect(row.at.getTime()).toBeLessThanOrEqual(mark.updatedAt.getTime());
    // the snapshot does not: its writer had not committed when the feed was read
    expect(await visible(row.writerXid!, snapshot)).toBe(false);
    // and a later feed sees it
    expect(await visible(row.writerXid!, await feedSnapshot())).toBe(true);
  });

  it('holds one position per (project, user), and only snapshot text', async () => {
    await expect(
      t.prisma.notificationReadMark.create({ data: { projectId, userId, seenSnapshot: await feedSnapshot() } }),
    ).rejects.toThrow();
    const other = `rm-user-${run}-x`;
    await t.prisma.user.create({ data: { id: other, projectId, role: 'pmc', name: 'RM X', email: `${other}@t.local` } });
    await expect(
      t.prisma.notificationReadMark.create({ data: { projectId, userId: other, seenSnapshot: 'yesterday' } }),
    ).rejects.toThrow();
    await t.prisma.user.delete({ where: { id: other } });
  });

  it('moves forward, and an earlier proposed snapshot keeps the stored one', async () => {
    const where = { projectId_userId: { projectId, userId } };
    const later = await feedSnapshot();
    await t.prisma.notificationReadMark.update({ where, data: { seenSnapshot: later } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenSnapshot).toBe(later);
    // a late replay of an earlier "mark seen": a lower xmax
    await t.prisma.notificationReadMark.update({ where, data: { seenSnapshot: '1:1:' } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenSnapshot).toBe(later);
    // and through raw SQL, not only the client
    await t.prisma.$executeRaw`UPDATE "NotificationReadMark" SET "seenSnapshot" = '1:2:1' WHERE "projectId" = ${projectId} AND "userId" = ${userId}`;
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenSnapshot).toBe(later);
  });

  it('orders snapshots with the same xmax by their in-progress set: fewer in progress is later', async () => {
    const other = `rm-user-${run}-o`;
    await t.prisma.user.create({ data: { id: other, projectId, role: 'pmc', name: 'RM O', email: `${other}@t.local` } });
    const where = { projectId_userId: { projectId, userId: other } };
    await t.prisma.notificationReadMark.create({ data: { projectId, userId: other, seenSnapshot: '100:200:100,150' } });
    // later: 100 has committed since, same xmax
    await t.prisma.notificationReadMark.update({ where, data: { seenSnapshot: '150:200:150' } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenSnapshot).toBe('150:200:150');
    // the earlier one, replayed late
    await t.prisma.notificationReadMark.update({ where, data: { seenSnapshot: '100:200:100,150' } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenSnapshot).toBe('150:200:150');
    // a strictly later xmax moves it
    await t.prisma.notificationReadMark.update({ where, data: { seenSnapshot: '210:210:' } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenSnapshot).toBe('210:210:');
  });

  it('refuses a proposed snapshot that does not see everything the stored one saw', async () => {
    const other = `rm-user-${run}-i`;
    await t.prisma.user.create({ data: { id: other, projectId, role: 'pmc', name: 'RM I', email: `${other}@t.local` } });
    const where = { projectId_userId: { projectId, userId: other } };
    await t.prisma.notificationReadMark.create({ data: { projectId, userId: other, seenSnapshot: '100:200:100,150' } });
    // as many in progress, but 120 was visible in the stored snapshot and is not in this one: incomparable
    await t.prisma.notificationReadMark.update({ where, data: { seenSnapshot: '120:200:120,150' } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenSnapshot).toBe('100:200:100,150');
    // a later xmax that still counts a transaction the stored one saw is refused too
    await t.prisma.notificationReadMark.update({ where, data: { seenSnapshot: '120:300:120' } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenSnapshot).toBe('100:200:100,150');
    // a true successor moves it: everything in progress below the stored xmax was in progress there too
    await t.prisma.notificationReadMark.update({ where, data: { seenSnapshot: '150:300:150,250' } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenSnapshot).toBe('150:300:150,250');
  });

  it('treats a stored position from another cluster as void: a real snapshot replaces it', async () => {
    const other = `rm-user-${run}-f`;
    await t.prisma.user.create({ data: { id: other, projectId, role: 'pmc', name: 'RM F', email: `${other}@t.local` } });
    const where = { projectId_userId: { projectId, userId: other } };
    await t.prisma.notificationReadMark.create({ data: { projectId, userId: other, seenSnapshot: '9000000000000:9000000000000:' } });
    const real = await feedSnapshot();
    await t.prisma.notificationReadMark.update({ where, data: { seenSnapshot: real } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenSnapshot).toBe(real);
  });

  it('is on migrate.sh\'s ALWAYS_EXECUTE and re-runs over a db-push baseline, installing every raw guard', async () => {
    const migration = '20280109000000_top10_4b_notification_read_mark';
    const runner = readFileSync(join(__dirname, '../../scripts/migrate.sh'), 'utf8');
    const named = /ALWAYS_EXECUTE="([^"]*)"/u.exec(runner)![1]!.split('\n').map((l) => l.trim()).filter(Boolean);
    expect(named).toContain(migration);

    const guards = async () => (await t.prisma.$queryRaw<Array<{ n: string }>>`
      SELECT tgname AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('Notification_writerXid_frozen', 'NotificationReadMark_forward_only')
      UNION ALL SELECT conname FROM pg_constraint WHERE conname = 'NotificationReadMark_seenSnapshot_check'`).map((r) => r.n).sort();
    const all = ['NotificationReadMark_forward_only', 'NotificationReadMark_seenSnapshot_check', 'Notification_writerXid_frozen'];
    expect(await guards()).toEqual(all);
    const before = await t.prisma.notificationReadMark.count();
    const url = new URL(process.env.DATABASE_URL!);
    url.search = '';
    const file = join(__dirname, '../../prisma/migrations', migration, 'migration.sql');
    try {
      // the shape a db push leaves: the modeled column and table, none of the raw guards
      await t.prisma.$executeRawUnsafe('DROP TRIGGER "Notification_writerXid_frozen" ON "Notification"');
      await t.prisma.$executeRawUnsafe('DROP TRIGGER "NotificationReadMark_forward_only" ON "NotificationReadMark"');
      await t.prisma.$executeRawUnsafe('ALTER TABLE "NotificationReadMark" DROP CONSTRAINT "NotificationReadMark_seenSnapshot_check"');
      expect(await guards()).toEqual([]);
      execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '--single-transaction', '-d', url.toString(), '-f', file], { encoding: 'utf8', stdio: 'pipe' });
      expect(await guards()).toEqual(all);
      // and a second run over the complete shape is a no-op
      execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '--single-transaction', '-d', url.toString(), '-f', file], { encoding: 'utf8', stdio: 'pipe' });
      expect(await guards()).toEqual(all);
      expect(await t.prisma.notificationReadMark.count()).toBe(before);
    } finally {
      // never leave the shared database without its guards
      execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '--single-transaction', '-d', url.toString(), '-f', file], { encoding: 'utf8', stdio: 'pipe' });
    }
  });

  it('goes with its user', async () => {
    const other = `rm-user-${run}-b`;
    await t.prisma.user.create({ data: { id: other, projectId, role: 'pmc', name: 'RM B', email: `${other}@t.local` } });
    await t.prisma.notificationReadMark.create({ data: { projectId, userId: other, seenSnapshot: await feedSnapshot() } });
    await t.prisma.user.delete({ where: { id: other } });
    expect(await t.prisma.notificationReadMark.count({ where: { userId: other } })).toBe(0);
  });
});
