import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';

/**
 * Top 10 #4b (#778) — the read watermark's storage contract, as the database enforces it.
 *
 * - One row per (project, user): a second insert for the same pair is refused.
 * - The watermark only moves FORWARD: an UPDATE proposing an older `seenAt` (a late or replayed "mark seen")
 *   keeps the stored instant, so already-seen notices are never made unread again.
 * - It is derived per-viewer state: deleting its user or its project takes it too.
 */
describe('Top 10 #4b — NotificationReadMark (live PG)', () => {
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
    await t.prisma.user.deleteMany({ where: { id: { startsWith: `rm-user-${run}` } } });
    await t.prisma.project.deleteMany({ where: { id: projectId } });
    await t.prisma.org.deleteMany({ where: { slug: `rm-org-${run}` } });
    await t.close();
  });

  const at = (iso: string) => new Date(iso);

  it('holds one watermark per (project, user)', async () => {
    await t.prisma.notificationReadMark.create({ data: { projectId, userId, seenAt: at('2026-10-10T10:00:00.000Z') } });
    await expect(
      t.prisma.notificationReadMark.create({ data: { projectId, userId, seenAt: at('2026-10-10T11:00:00.000Z') } }),
    ).rejects.toThrow();
  });

  it('moves forward, and an older proposed instant keeps the stored one', async () => {
    const where = { projectId_userId: { projectId, userId } };
    await t.prisma.notificationReadMark.update({ where, data: { seenAt: at('2026-10-10T12:00:00.000Z') } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenAt.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    // a late replay of an earlier "mark seen"
    await t.prisma.notificationReadMark.update({ where, data: { seenAt: at('2026-10-10T09:00:00.000Z') } });
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenAt.toISOString()).toBe('2026-10-10T12:00:00.000Z');
    // and through raw SQL, not only the client
    await t.prisma.$executeRaw`UPDATE "NotificationReadMark" SET "seenAt" = ${at('2026-01-01T00:00:00.000Z')} WHERE "projectId" = ${projectId} AND "userId" = ${userId}`;
    expect((await t.prisma.notificationReadMark.findUniqueOrThrow({ where })).seenAt.toISOString()).toBe('2026-10-10T12:00:00.000Z');
  });

  it('goes with its user', async () => {
    const other = `rm-user-${run}-b`;
    await t.prisma.user.create({ data: { id: other, projectId, role: 'pmc', name: 'RM B', email: `${other}@t.local` } });
    await t.prisma.notificationReadMark.create({ data: { projectId, userId: other, seenAt: at('2026-10-10T10:00:00.000Z') } });
    await t.prisma.user.delete({ where: { id: other } });
    expect(await t.prisma.notificationReadMark.count({ where: { userId: other } })).toBe(0);
  });
});
