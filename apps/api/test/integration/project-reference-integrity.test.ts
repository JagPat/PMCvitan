import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

const uid = (label: string) => `it-${label}-${randomUUID().slice(0, 8)}`;

/**
 * Cross-project references must be impossible even through a DIRECT database
 * write (Phase 0 Task 5): composite (projectId, id) foreign keys make PostgreSQL
 * itself reject a forged link — the service checks are the first line, this is
 * the last.
 */
describe('project reference integrity (database constraints)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let activityA: { id: string };
  let decisionA: { id: string };
  const created: { drawings: string[]; media: string[] } = { drawings: [], media: [] };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    activityA = await t.prisma.activity.create({
      data: { id: uid('act'), projectId: f.projectA.id, name: 'Waterproofing', zone: 'Terrace', plannedStart: 1, plannedEnd: 2, order: 1 },
    });
    decisionA = await t.prisma.decision.create({
      data: { id: uid('dl'), projectId: f.projectA.id, title: 'Flooring', room: 'Living', status: 'approved', photoSwatch: 'marble', publishedAt: new Date() },
    });
  });

  afterAll(async () => {
    await t.prisma.media.deleteMany({ where: { id: { in: created.media } } });
    await t.prisma.drawing.deleteMany({ where: { id: { in: created.drawings } } });
    await t.prisma.decision.deleteMany({ where: { id: decisionA?.id } });
    await t.prisma.activity.deleteMany({ where: { id: activityA?.id } });
    await f?.cleanup();
    await t?.close();
  });

  it('PostgreSQL rejects a drawing in project B pointing at project A records (P2003)', async () => {
    await expect(
      t.prisma.drawing.create({
        data: {
          id: uid('drawing'),
          projectId: f.projectB.id,
          number: 'A-901',
          title: 'Forged link',
          discipline: 'Architecture',
          activityId: activityA.id,
          decisionId: decisionA.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('PostgreSQL rejects media in project B pointing at a project A decision (P2003)', async () => {
    await expect(
      t.prisma.media.create({
        data: { id: uid('media'), projectId: f.projectB.id, kind: 'progress', mime: 'image/jpeg', uploadedBy: 'u', decisionId: decisionA.id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });

  it('same-project links stay fully allowed (control)', async () => {
    const drawing = await t.prisma.drawing.create({
      data: { id: uid('drawing'), projectId: f.projectA.id, number: 'A-902', title: 'Real link', discipline: 'Architecture', activityId: activityA.id, decisionId: decisionA.id },
    });
    created.drawings.push(drawing.id);
    expect(drawing.activityId).toBe(activityA.id);

    const media = await t.prisma.media.create({
      data: { id: uid('media'), projectId: f.projectA.id, kind: 'progress', mime: 'image/jpeg', uploadedBy: 'u', decisionId: decisionA.id },
    });
    created.media.push(media.id);
    expect(media.decisionId).toBe(decisionA.id);
  });

  it('deleting an activity unlinks referencing drawings (Task 7 edge 5: ON DELETE SET NULL FK action)', async () => {
    const act = await t.prisma.activity.create({
      data: { id: uid('act'), projectId: f.projectA.id, name: 'Temp', zone: 'GF', plannedStart: 1, plannedEnd: 2, order: 9 },
    });
    const drawing = await t.prisma.drawing.create({
      data: { id: uid('drawing'), projectId: f.projectA.id, number: 'A-903', title: 'Linked', discipline: 'Architecture', activityId: act.id },
    });
    created.drawings.push(drawing.id);

    // Edge 5 (Task 7): the Drawing(projectId, activityId) FK is now ON DELETE SET NULL
    // (activityId), so the RAW delete succeeds and the database unlinks the governed
    // drawing (it survives, unplaced) — no service-owned nulling needed.
    await t.prisma.activity.delete({ where: { id: act.id } });
    const after = await t.prisma.drawing.findUnique({ where: { id: drawing.id }, select: { activityId: true, projectId: true } });
    expect(after?.activityId, 'the drawing is unlinked from the deleted activity').toBeNull();
    expect(after?.projectId, 'the drawing keeps its tenant projectId').toBe(f.projectA.id);

    // the service DELETE endpoint drives the same FK action and returns 200
    const act2 = await t.prisma.activity.create({
      data: { id: uid('act'), projectId: f.projectA.id, name: 'Temp2', zone: 'GF', plannedStart: 1, plannedEnd: 2, order: 10 },
    });
    const dr2 = await t.prisma.drawing.create({
      data: { id: uid('drawing'), projectId: f.projectA.id, number: 'A-904', title: 'Linked2', discipline: 'Architecture', activityId: act2.id },
    });
    created.drawings.push(dr2.id);
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    const request = (await import('supertest')).default;
    await request(t.app.getHttpServer())
      .delete(`/projects/${f.projectA.id}/activities/${act2.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const after2 = await t.prisma.drawing.findUnique({ where: { id: dr2.id }, select: { activityId: true } });
    expect(after2?.activityId).toBeNull();
  });
});
