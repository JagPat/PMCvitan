import 'reflect-metadata';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';

/**
 * Phase 2 Task 1 — CHARACTERIZATION (live PostgreSQL) of the per-mutation
 * consequence set today. Each pillar mutation produces a bundle of side effects
 * (a canonical write, an audit row, sometimes a Notification, a `changed` signal
 * with target roles, and sometimes a CROSS-DOMAIN write). Phase 2 Tasks 3–6 move
 * these onto the DomainEvent envelope + per-consumer outbox, and MUST reproduce
 * this exact set — no more, no fewer.
 *
 * It also pins the audit ATTRIBUTION SPLIT that Phase 2 Task 3 closes: newer
 * mutations write `actorId` via resolveActor(); older ones still write a bare
 * `actor: user.role` with a null `actorId`.
 */

describe('Phase 2 Task 1 — per-mutation consequences (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let token: string;
  let realtimeSpy: ReturnType<typeof vi.spyOn>;
  const DEC_ID = 'it-p2c-dl';
  const ACT_ID = 'ACT-it-p2c-1';

  const post = (path: string, body?: unknown) =>
    request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body ?? {});

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    token = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    const pid = f.projectA.id;
    // give the project a schedule anchor so createActivity's civil-date derivation works
    await t.prisma.project.update({ where: { id: pid }, data: { scheduleStartDate: new Date('2026-06-01'), scheduleEndDate: new Date('2026-12-31') } });
    // a published PENDING decision + one option, ready to approve
    await t.prisma.decision.create({ data: { id: DEC_ID, projectId: pid, title: 'Flooring', room: 'Living', photoSwatch: 'marble', status: 'pending', publishedAt: new Date(), authorId: f.memberUser.id } });
    await t.prisma.decisionOption.create({ data: { decisionId: DEC_ID, label: 'Marble', optionKey: 'a', material: 'Marble', delta: 0, swatch: 'marble', order: 0 } });
    // an in-progress activity, ready to complete → produces a closing inspection
    await t.prisma.activity.create({ data: { id: ACT_ID, projectId: pid, name: 'Slab', zone: 'GF', status: 'in_progress', plannedStart: 0, plannedEnd: 10 } });
    // record the `changed` signal without emitting a socket/push
    realtimeSpy = vi.spyOn(t.app.get(RealtimeGateway), 'notifyChanged').mockImplementation(() => {});
  });

  beforeEach(() => realtimeSpy.mockClear());

  afterAll(async () => {
    realtimeSpy.mockRestore();
    const pid = f.projectA.id;
    const insp = await t.prisma.inspection.findMany({ where: { projectId: pid }, select: { id: true } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: insp.map((i) => i.id) } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: pid } });
    await t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: pid } } });
    await t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: pid } } });
    await t.prisma.changeRequest.deleteMany({ where: { decision: { projectId: pid } } });
    await t.prisma.decision.deleteMany({ where: { projectId: pid } });
    await t.prisma.gateOverride.deleteMany({ where: { projectId: pid } });
    await t.prisma.activity.deleteMany({ where: { projectId: pid } });
    await f.cleanup(); // removes auditLog / notification / membership / project
    await t.close();
  });

  it('decision.approve: canonical write + DecisionEvent + Notification + attributed audit + signal', async () => {
    const before = await t.prisma.notification.count({ where: { projectId: f.projectA.id } });
    const res = await post(`/projects/${f.projectA.id}/decisions/${DEC_ID}/approve`, { optionIndex: 0 });
    expect(res.status).toBeLessThan(300);

    const dec = await t.prisma.decision.findUniqueOrThrow({ where: { id: DEC_ID } });
    expect(dec.status).toBe('approved');

    const audit = await t.prisma.auditLog.findFirst({ where: { projectId: f.projectA.id, action: 'decision.approve' } });
    expect(audit, 'a decision.approve audit row is written').toBeTruthy();
    expect(audit!.actorId, 'approve attributes a real actorId (resolveActor)').toBe(f.memberUser.id);

    const event = await t.prisma.decisionEvent.findFirst({ where: { decisionId: DEC_ID, type: 'approved' } });
    expect(event, 'an approved DecisionEvent is appended').toBeTruthy();
    expect(event!.actorId).toBe(f.memberUser.id);

    const after = await t.prisma.notification.count({ where: { projectId: f.projectA.id } });
    expect(after, 'approve fans a Notification').toBe(before + 1);

    expect(realtimeSpy.mock.calls.some((c) => c[0] === f.projectA.id), 'approve emits a changed signal').toBe(true);
  });

  it('activity.complete: CROSS-MODULE closing Inspection + awaiting_signoff + attributed audit', async () => {
    const res = await post(`/projects/${f.projectA.id}/activities/${ACT_ID}/complete`);
    expect(res.status).toBeLessThan(300);

    const act = await t.prisma.activity.findUniqueOrThrow({ where: { id: ACT_ID } });
    expect(act.status).toBe('awaiting_signoff');

    // the cross-module edge: activities.service writes an Inspection row directly
    const closing = await t.prisma.inspection.findFirst({ where: { projectId: f.projectA.id, activityId: ACT_ID, closing: true } });
    expect(closing, 'completing an activity creates its closing Inspection (cross-module edge)').toBeTruthy();
    expect(closing!.kind).toBe('review');

    const audit = await t.prisma.auditLog.findFirst({ where: { projectId: f.projectA.id, action: 'activity.complete_requested' } });
    expect(audit, 'a complete_requested audit row is written').toBeTruthy();
    expect(audit!.actorId, 'complete attributes a real actorId (resolveActor)').toBe(f.memberUser.id);

    expect(realtimeSpy.mock.calls.some((c) => c[0] === f.projectA.id)).toBe(true);
  });

  it('activity.create: audit is written with a BARE role (null actorId) — the split Task 3 closes', async () => {
    const res = await post(`/projects/${f.projectA.id}/activities`, { name: 'New wall', zone: 'GF', plannedStart: 0, plannedEnd: 5 });
    expect(res.status).toBeLessThan(300);

    const audit = await t.prisma.auditLog.findFirst({ where: { projectId: f.projectA.id, action: 'activity.create' }, orderBy: { at: 'desc' } });
    expect(audit, 'an activity.create audit row is written').toBeTruthy();
    // CHARACTERIZATION of the gap: this older site records only the role string.
    expect(audit!.actorId, 'activity.create records NO actorId today (bare role)').toBeNull();
    expect(audit!.actor).toBe('pmc');
  });
});
