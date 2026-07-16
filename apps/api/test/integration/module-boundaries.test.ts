import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 2 Task 7 — the cross-module edges are now DATABASE FK ACTIONS (edges 5/6/7) and
 * transaction-bound WORKFLOW PARTICIPANTS (edges 1–4/8), proven against live PostgreSQL.
 *
 * The FK edges are the genuinely NEW mechanism: `ON DELETE SET NULL (<col>)` unfiles the
 * referencing column WITHOUT nulling the NOT-NULL tenant `projectId` (a bare composite
 * SET NULL could not), so the placed records SURVIVE and just become unplaced — exactly
 * what the former service-owned nulling did, now enforced by the database. Decisions are
 * excluded on purpose (their FK stays NO ACTION, a guard).
 */
describe('Phase 2 Task 7 — module boundary FK actions + participant atomicity (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.drawing.deleteMany({ where: { projectId } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId } } });
    await t.prisma.inspection.deleteMany({ where: { projectId } });
    await t.prisma.activity.deleteMany({ where: { projectId } });
    await t.prisma.phase.deleteMany({ where: { projectId } });
    await t.prisma.projectNode.deleteMany({ where: { projectId } });
    await f?.cleanup();
    await t?.close();
  });

  it('edge 7: deleting a location node UNFILES its placed records (nodeId → null) but keeps them and their tenant projectId', async () => {
    const p = f.projectA.id;
    const zone = await t.prisma.projectNode.create({ data: { projectId: p, name: 'B7-Zone', kind: 'zone', order: 0, authorId: f.memberUser.id } });
    const act = await t.prisma.activity.create({ data: { id: `it-b7-act-${Date.now()}`, projectId: p, name: 'Placed', zone: 'GF', plannedStart: 0, plannedEnd: 1, gateMaterial: 'na', gateTeam: 'na', nodeId: zone.id } });
    const insp = await t.prisma.inspection.create({ data: { id: `it-b7-insp-${Date.now()}`, projectId: p, kind: 'checklist', title: 'Placed', zone: 'GF', date: 'today', submitted: false, decided: false, nodeId: zone.id } });
    const dr = await t.prisma.drawing.create({ data: { id: `it-b7-dr-${Date.now()}`, projectId: p, number: 'D-B7', title: 'Placed', discipline: 'architectural', publishedAt: new Date(), nodeId: zone.id } });

    await t.prisma.projectNode.delete({ where: { id: zone.id } });

    for (const [model, id] of [['activity', act.id], ['inspection', insp.id], ['drawing', dr.id]] as const) {
      const row = await (t.prisma[model] as { findUnique: (a: unknown) => Promise<{ projectId: string; nodeId: string | null } | null> }).findUnique({ where: { id } });
      expect(row, `${model} survives the node delete`).toBeTruthy();
      expect(row!.nodeId, `${model}.nodeId is unfiled to null`).toBeNull();
      expect(row!.projectId, `${model} keeps its tenant projectId`).toBe(p);
    }
  });

  it('edge 6: deleting a phase DETACHES its activities (phaseId → null) and keeps them', async () => {
    const p = f.projectA.id;
    const phase = await t.prisma.phase.create({ data: { projectId: p, name: 'B6-Phase', order: 0, plannedStart: 0, plannedEnd: 5 } });
    const act = await t.prisma.activity.create({ data: { id: `it-b6-act-${Date.now()}`, projectId: p, name: 'Phased', zone: 'GF', plannedStart: 0, plannedEnd: 1, gateMaterial: 'na', gateTeam: 'na', phaseId: phase.id } });
    await t.prisma.phase.delete({ where: { id: phase.id } });
    const row = await t.prisma.activity.findUnique({ where: { id: act.id } });
    expect(row, 'activity survives the phase delete').toBeTruthy();
    expect(row!.phaseId, 'activity is detached from the deleted phase').toBeNull();
  });

  it('edge 5: deleting an activity UNLINKS the drawings it governed (activityId → null) and keeps them', async () => {
    const p = f.projectA.id;
    const act = await t.prisma.activity.create({ data: { id: `it-b5-act-${Date.now()}`, projectId: p, name: 'Governing', zone: 'GF', plannedStart: 0, plannedEnd: 1, gateMaterial: 'na', gateTeam: 'na' } });
    const dr = await t.prisma.drawing.create({ data: { id: `it-b5-dr-${Date.now()}`, projectId: p, number: 'D-B5', title: 'Governed', discipline: 'architectural', publishedAt: new Date(), activityId: act.id } });
    await t.prisma.activity.delete({ where: { id: act.id } });
    const row = await t.prisma.drawing.findUnique({ where: { id: dr.id } });
    expect(row, 'drawing survives the activity delete').toBeTruthy();
    expect(row!.activityId, 'drawing is unlinked from the deleted activity').toBeNull();
  });

  it('edge 5 counter-case: an activity with a linked INSPECTION still BLOCKS deletion (NO ACTION FK preserved)', async () => {
    const p = f.projectA.id;
    const act = await t.prisma.activity.create({ data: { id: `it-b5b-act-${Date.now()}`, projectId: p, name: 'Referenced', zone: 'GF', plannedStart: 0, plannedEnd: 1, gateMaterial: 'na', gateTeam: 'na' } });
    await t.prisma.inspection.create({ data: { id: `it-b5b-insp-${Date.now()}`, projectId: p, kind: 'checklist', title: 'Refs', zone: 'GF', date: 'today', submitted: false, decided: false, activityId: act.id } });
    // the Inspection(projectId, activityId) FK stays NO ACTION, so the DB refuses the delete —
    // the record is never silently orphaned (activities.remove surfaces this as a Conflict).
    await expect(t.prisma.activity.delete({ where: { id: act.id } })).rejects.toThrow();
  });
});
