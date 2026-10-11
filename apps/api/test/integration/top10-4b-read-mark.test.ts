import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';

/**
 * Top 10 #4b (#778) — the read position's storage contract, as the database enforces it.
 *
 * - Every notice records the transaction that wrote it (`writerXid`), defaulted, so no writer can forget it.
 * - The position is the feed's SNAPSHOT, so it is commit-ordered: a notice whose transaction began BEFORE the
 *   feed was read but committed AFTER it is not visible in that snapshot, so it stays unread, whatever its `at`
 *   (#785 review round 1).
 * - One row per (project, user); only snapshot text is accepted.
 * - The position only moves FORWARD: an UPDATE proposing an earlier snapshot (a late or replayed "mark seen")
 *   keeps the stored one, through the client and raw SQL alike.
 * - It is derived per-viewer state: deleting its user takes it too.
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

  it('goes with its user', async () => {
    const other = `rm-user-${run}-b`;
    await t.prisma.user.create({ data: { id: other, projectId, role: 'pmc', name: 'RM B', email: `${other}@t.local` } });
    await t.prisma.notificationReadMark.create({ data: { projectId, userId: other, seenSnapshot: await feedSnapshot() } });
    await t.prisma.user.delete({ where: { id: other } });
    expect(await t.prisma.notificationReadMark.count({ where: { userId: other } })).toBe(0);
  });
});
