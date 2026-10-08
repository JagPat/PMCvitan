import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Live bug 1b-3a — `Notification.inspectionId` is the trusted claim the bell opens, so PostgreSQL seals it
 * (Codex 4215279309, 4215279320 on #736), proven against live PostgreSQL:
 *
 * - at insert, a non-NULL stamp must name an inspection of the notice's OWN project (judged at commit, so a
 *   writer may insert the notice before its inspection in one transaction);
 * - after insert, the stamp never changes: no re-point, no fill on an unstamped row, no clear.
 */
describe('live bug 1b-3a — the inspection stamp is project-bound at insert and frozen after (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const inspA = `INSP-1b3-a-${run}`;
  const inspA2 = `INSP-1b3-a2-${run}`;
  const inspB = `INSP-1b3-b-${run}`;

  const inspection = (id: string, projectId: string) => ({ id, projectId, kind: 'checklist', title: 'Seal probe', zone: 'Terrace', date: '08 Oct 2026' });
  const notice = (projectId: string, inspectionId?: string) => ({ projectId, text: `Seal probe ${run}`, color: '#C08A2D', time: 'just now', ...(inspectionId ? { inspectionId } : {}) });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.inspection.createMany({
      data: [inspection(inspA, f.projectA.id), inspection(inspA2, f.projectA.id), inspection(inspB, f.projectB.id)],
    });
  });

  afterAll(async () => {
    await t.prisma.notification.deleteMany({ where: { text: `Seal probe ${run}` } });
    await t.prisma.inspection.deleteMany({ where: { id: { in: [inspA, inspA2, inspB] } } });
    await f?.cleanup();
    await t?.close();
  });

  it('admits a stamp naming an inspection of the notice\'s own project, and an unstamped notice', async () => {
    const stamped = await t.prisma.notification.create({ data: notice(f.projectA.id, inspA) });
    expect(stamped.inspectionId).toBe(inspA);
    const bare = await t.prisma.notification.create({ data: notice(f.projectA.id) });
    expect(bare.inspectionId).toBeNull();
  });

  it('refuses a stamp naming another project\'s inspection, or no inspection at all', async () => {
    await expect(t.prisma.notification.create({ data: notice(f.projectA.id, inspB) }))
      .rejects.toThrow(/live bug 1b-3a: notice .* names inspection .*, which is not an inspection of project/u);
    await expect(t.prisma.notification.create({ data: notice(f.projectA.id, `INSP-missing-${run}`) }))
      .rejects.toThrow(/which is not an inspection of project/u);
  });

  it('admits a stamp only on a kindless inspection notice: never beside a decision, a kind or an event (Codex 4216092340)', async () => {
    const notInspection = /live bug 1b-3a: notice .* names inspection .* but is not an inspection notice/u;
    await expect(t.prisma.notification.create({ data: { ...notice(f.projectA.id, inspA), decisionId: `dec-${run}` } })).rejects.toThrow(notInspection);
    await expect(t.prisma.notification.create({ data: { ...notice(f.projectA.id, inspA), kind: 'decision.published' } })).rejects.toThrow(notInspection);
  });

  it('judges the stamp at commit: a notice written before its inspection in one transaction is admitted', async () => {
    const late = `INSP-1b3-late-${run}`;
    await t.prisma.$transaction(async (tx) => {
      await tx.notification.create({ data: notice(f.projectA.id, late) });
      await tx.inspection.create({ data: inspection(late, f.projectA.id) });
    });
    expect(await t.prisma.notification.count({ where: { inspectionId: late } })).toBe(1);
    await t.prisma.notification.deleteMany({ where: { inspectionId: late } });
    await t.prisma.inspection.delete({ where: { id: late } });
  });

  it('freezes the stamp after insert: no re-point, no fill, no clear', async () => {
    const stamped = await t.prisma.notification.create({ data: notice(f.projectA.id, inspA) });
    const bare = await t.prisma.notification.create({ data: notice(f.projectA.id) });
    const frozen = /live bug 1b-3a: notice .* may not change the inspection it announces/u;
    await expect(t.prisma.notification.update({ where: { id: stamped.id }, data: { inspectionId: inspA2 } })).rejects.toThrow(frozen);
    await expect(t.prisma.notification.update({ where: { id: stamped.id }, data: { inspectionId: null } })).rejects.toThrow(frozen);
    await expect(t.prisma.notification.update({ where: { id: bare.id }, data: { inspectionId: inspA } })).rejects.toThrow(frozen);
    // a stamped notice keeps its project and its class (Codex 4216092325, 4216092340)
    await expect(t.prisma.notification.update({ where: { id: stamped.id }, data: { projectId: f.projectB.id } }))
      .rejects.toThrow(/live bug 1b-3a: notice .* announces inspection .* and may not change project/u);
    await expect(t.prisma.notification.update({ where: { id: stamped.id }, data: { decisionId: `dec-${run}` } }))
      .rejects.toThrow(/live bug 1b-3a: notice .* announces inspection .* and may not name a decision/u);
    // an UNSTAMPED kindless notice keeps its delivered editability, project included
    await t.prisma.notification.update({ where: { id: bare.id }, data: { decisionId: `dec-${run}` } });
    // a kindless notice's other columns stay as editable as before
    await t.prisma.notification.update({ where: { id: stamped.id }, data: { time: '1m ago' } });
  });
});
