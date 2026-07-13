import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 1 Task 1 — INTEGRATION CHARACTERIZATION against live PostgreSQL.
 * One flow per pillar, exactly as the server behaves at the Phase 1 baseline
 * (main @ 5b101d6). Several of these pin behavior Phase 1 deliberately changes
 * (Tasks 2, 4, 5 must update the matching test in the same PR that changes it):
 *   - approve → lock (409) but the change flow REOPENS the lock;
 *   - the ChangeRequest row is written once and never resolved;
 *   - two CONCURRENT change requests both succeed (no DB-level invariant yet);
 *   - reject decides the same row and creates NO reinspection;
 *   - complete writes done immediately; the closing inspection has zero items.
 */
describe('phase 1 baseline characterization (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let token: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    token = t.issueProjectToken(f.memberUser.id, f.projectA.id); // pmc on project A
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.$transaction([
      t.prisma.changeRequest.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId } } }),
      t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId } } }),
      t.prisma.inspection.deleteMany({ where: { projectId } }),
      t.prisma.activity.deleteMany({ where: { projectId } }),
      t.prisma.decision.deleteMany({ where: { projectId } }),
    ]);
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const post = (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);

  const decisionInput = (title: string) => ({
    title,
    room: 'Kitchen',
    options: [
      { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
      { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
    ],
    publish: true,
  });

  it('decision pillar: approve locks (409) — but a change request reopens the lock and is never resolved', async () => {
    expect((await post(`/projects/${f.projectA.id}/decisions`, decisionInput('Counter top'))).status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Counter top' } });

    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 0 })).status).toBe(201);
    // locked: a second approval conflicts
    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 1 })).status).toBe(409);
    // the recorded approver is the hardcoded role label, not the caller (replaced by Task 2)
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).approver).toBe('PMC');

    // the change flow reopens the lock…
    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/change`, { reason: 'Out of stock', costImpact: 0, timeImpactDays: 2 })).status).toBe(201);
    const reopened = await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } });
    expect(reopened.status).toBe('change');
    // …and the ChangeRequest row is born 'pending' with no resolution model at all
    const cr = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(cr.status).toBe('pending');

    // re-approval succeeds and leaves the ChangeRequest untouched (never resolved)
    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 1 })).status).toBe(201);
    expect((await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status).toBe('pending');
  });

  it('CONCURRENCY characterization: two simultaneous change requests BOTH succeed — no one-open invariant exists (closed by Task 2)', async () => {
    expect((await post(`/projects/${f.projectA.id}/decisions`, decisionInput('Bath tiles'))).status).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Bath tiles' } });
    expect((await post(`/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 0 })).status).toBe(201);

    const [r1, r2] = await Promise.all([
      post(`/projects/${f.projectA.id}/decisions/${d.id}/change`, { reason: 'racer one', costImpact: 0, timeImpactDays: 0 }),
      post(`/projects/${f.projectA.id}/decisions/${d.id}/change`, { reason: 'racer two', costImpact: 0, timeImpactDays: 0 }),
    ]);

    // both requests pass the pre-read status guard: the service has no CAS and the
    // database has no partial-unique index, so DUPLICATE open requests persist
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(await t.prisma.changeRequest.count({ where: { decisionId: d.id } })).toBe(2);
  });

  it('inspection pillar: reject decides the SAME row — no reinspection row, no due date, no assignee', async () => {
    expect((await post(`/projects/${f.projectA.id}/inspections`, { title: 'Ponding test', zone: 'Terrace', items: ['Drain slope'] })).status).toBe(201);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title: 'Ponding test' } });
    const countBefore = await t.prisma.inspection.count({ where: { projectId: f.projectA.id } });

    expect((await post(`/projects/${f.projectA.id}/inspections/${insp.id}/submit`, { items: [{ name: 'Drain slope', state: 'fail', photos: 1, note: 'pooling NE corner' }] })).status).toBe(201);
    expect((await post(`/projects/${f.projectA.id}/inspections/${insp.id}/decide`, { approve: false, rejectedItemNames: ['Drain slope'] })).status).toBe(201);

    // the "re-inspection task(s) created with due dates" notice has no backing row:
    expect(await t.prisma.inspection.count({ where: { projectId: f.projectA.id } })).toBe(countBefore);
    const after = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id }, include: { items: true } });
    expect(after.decided).toBe(true); // terminal — the rejection lives and dies on this row
    expect(after.items[0].rejected).toBe(true);
    expect(after.by).toBeNull(); // submit recorded no submitter identity
  });

  it('activity pillar: complete writes done IMMEDIATELY and the zero-item closing inspection is merely queued', async () => {
    expect((await post(`/projects/${f.projectA.id}/activities`, { name: 'Skirting', plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'Skirting' } });

    expect((await post(`/projects/${f.projectA.id}/activities/${a.id}/start`, {})).status).toBe(201);
    expect((await post(`/projects/${f.projectA.id}/activities/${a.id}/complete`, {})).status).toBe(201);

    // done is unconditional — no sign-off state exists between claim and acceptance
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('done');
    const closing = await t.prisma.inspection.findUniqueOrThrow({ where: { id: `INSP-${a.id}-close` }, include: { items: true } });
    expect(closing.kind).toBe('review');
    expect(closing.submitted).toBe(true);
    expect(closing.decided).toBe(false); // the activity is already done while this waits
    expect(closing.items).toHaveLength(0); // zero items → it can only ever be approved
    // rejecting the zero-item closing is impossible (the Task 5 trap this pins)
    expect((await post(`/projects/${f.projectA.id}/inspections/${closing.id}/decide`, { approve: false, rejectedItemNames: [] })).status).toBe(400);
  });
});
