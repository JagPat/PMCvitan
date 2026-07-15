import 'reflect-metadata';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { PushService } from '../../src/push/push.service';

/**
 * Phase 2 Task 1 — CHARACTERIZATION (live PostgreSQL) of the EXACT per-mutation
 * consequence set of every pillar mutation. Each mutation produces a bundle:
 * a canonical write, an audit row (attributed OR a bare role — the split Task 3
 * closes), sometimes a Notification, the `changed` socket signal, sometimes a
 * Web Push with a specific body + target roles, and sometimes a CROSS-DOMAIN
 * write. Phase 2 Tasks 3–6 move these onto the DomainEvent envelope + per-consumer
 * outbox and MUST reproduce this exact set — no more, no fewer.
 *
 * Unlike a mock of `notifyChanged`, this drives the REAL RealtimeGateway: a fake
 * socket server captures the emitted room/event/payload, and PushService.notifyProject
 * is spied to capture the exact push body + recipient roles the gateway computes.
 */

type Emit = { room: string; event: string; payload: unknown };

describe('Phase 2 Task 1 — per-mutation consequences (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pid: string;
  let uid: string;
  let engId: string;
  let token: string;
  let sk: (label: string) => string;
  let emits: Emit[];
  let pushSpy: ReturnType<typeof vi.spyOn>;

  const post = (path: string, body?: unknown) =>
    request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body ?? {});
  const patch = (path: string, body?: unknown) =>
    request(t.app.getHttpServer()).patch(path).set('Authorization', `Bearer ${token}`).send(body ?? {});
  const del = (path: string) =>
    request(t.app.getHttpServer()).delete(path).set('Authorization', `Bearer ${token}`);

  const socketSignalled = () => emits.some((e) => e.room === `project:${pid}` && e.event === 'changed');
  const pushCalls = () => pushSpy.mock.calls as unknown as Array<[string, { title: string; body: string }, string[] | undefined]>;
  const lastAudit = (action: string) =>
    t.prisma.auditLog.findFirst({ where: { projectId: pid, action }, orderBy: { at: 'desc' } });
  const notifCount = () => t.prisma.notification.count({ where: { projectId: pid } });
  const OPTS = [
    { label: 'A', material: 'A', delta: 0, swatch: 'marble' },
    { label: 'B', material: 'B', delta: 100, swatch: 'teak' },
  ];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pid = f.projectA.id;
    sk = (label: string) => `${label}-${pid.slice(-8)}`;
    uid = f.memberUser.id;
    token = t.issueProjectToken(uid, pid, 'pmc');
    await t.prisma.project.update({ where: { id: pid }, data: { scheduleStartDate: new Date('2026-06-01'), scheduleEndDate: new Date('2026-12-31') } });
    // an active engineer member — the eligible assignee a closing-inspection reject needs
    engId = `${sk('p2c-eng-')}${pid.slice(-8)}`;
    await t.prisma.user.create({ data: { id: engId, projectId: pid, role: 'engineer', name: 'Eng', email: `${engId}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: pid, userId: engId, role: 'engineer', status: 'active' } });

    const gw = t.app.get(RealtimeGateway);
    emits = [];
    (gw as unknown as { server: unknown }).server = {
      to: (room: string) => ({ emit: (event: string, payload: unknown) => { emits.push({ room, event, payload }); return true; } }),
    };
    pushSpy = vi.spyOn(t.app.get(PushService), 'notifyProject').mockResolvedValue(undefined as never);
  });

  beforeEach(() => { emits = []; pushSpy.mockClear(); });

  afterAll(async () => {
    pushSpy.mockRestore();
    const insp = await t.prisma.inspection.findMany({ where: { projectId: pid }, select: { id: true } });
    await t.prisma.media.deleteMany({ where: { projectId: pid } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: insp.map((i) => i.id) } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: pid } });
    await t.prisma.drawingAck.deleteMany({ where: { revision: { projectId: pid } } });
    await t.prisma.drawingRecipient.deleteMany({ where: { projectId: pid } });
    await t.prisma.drawingRevision.deleteMany({ where: { projectId: pid } });
    await t.prisma.drawing.deleteMany({ where: { projectId: pid } });
    await t.prisma.siteMaterial.deleteMany({ where: { projectId: pid } });
    await t.prisma.crewRow.deleteMany({ where: { dailyLog: { projectId: pid } } });
    await t.prisma.dailyLog.deleteMany({ where: { projectId: pid } });
    await t.prisma.gateOverride.deleteMany({ where: { projectId: pid } });
    await t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: pid } } });
    await t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: pid } } });
    await t.prisma.changeRequest.deleteMany({ where: { decision: { projectId: pid } } });
    await t.prisma.activity.deleteMany({ where: { projectId: pid } });
    await t.prisma.decision.deleteMany({ where: { projectId: pid } });
    await t.prisma.phase.deleteMany({ where: { projectId: pid } });
    await t.prisma.projectNode.deleteMany({ where: { projectId: pid } });
    await t.prisma.membership.deleteMany({ where: { projectId: pid, userId: engId } });
    await t.prisma.user.deleteMany({ where: { id: engId } });
    await f.cleanup();
    await t.close();
  });

  // ─── decisions (audit ATTRIBUTED via resolveActor) ──────────────────────────
  describe('decisions', () => {

    it('create (publish): decision.create audit(actorId) + issued event + Notification + push[client] + signal', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/decisions`, { title: 'Flooring', room: 'Living', options: OPTS, publish: true });
      expect(res.status).toBeLessThan(300);
      const audit = await lastAudit('decision.create');
      expect(audit?.actorId, 'create attributes actorId').toBe(uid);
      const created = res.body.decisions.find((d: { title: string }) => d.title === 'Flooring');
      expect(await t.prisma.decisionEvent.findFirst({ where: { decisionId: created.id, type: 'issued' } })).toBeTruthy();
      expect(await notifCount()).toBe(before + 1);
      expect(pushCalls()[0][1].body).toBe('New decision awaiting your approval: Flooring');
      expect(pushCalls()[0][2]).toEqual(['client']);
      expect(socketSignalled()).toBe(true);
    });

    it('create (draft): decision.draft audit(actorId) + drafted event + NO notification/push/signal', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/decisions`, { title: 'Veneer', room: 'Study', options: OPTS, publish: false });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('decision.draft'))?.actorId).toBe(uid);
      expect(await notifCount(), 'a draft creates no notification').toBe(before);
      expect(pushCalls(), 'a draft pushes to no one').toHaveLength(0);
      expect(socketSignalled(), 'a draft create does NOT emit changed').toBe(false);
    });

    it('publish: decision.publish audit(actorId) + Notification + push[client] + signal', async () => {
      const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: pid, title: 'Veneer' } });
      const res = await post(`/projects/${pid}/decisions/${d.id}/publish`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('decision.publish'))?.actorId).toBe(uid);
      expect(pushCalls()[0][2]).toEqual(['client']);
      expect(socketSignalled()).toBe(true);
    });

    it('approve: decision.approve audit(actorId) + approved event + Notification + push[pmc,contractor,engineer]', async () => {
      await t.prisma.decision.create({ data: { id: sk('p2c-dec-pub'), projectId: pid, title: 'Sanitary', room: 'Bath', photoSwatch: 'marble', status: 'pending', publishedAt: new Date(), authorId: uid } });
      await t.prisma.decisionOption.create({ data: { decisionId: sk('p2c-dec-pub'), label: 'A', optionKey: 'a', material: 'A', delta: 0, swatch: 'marble', order: 0 } });
      const before = await notifCount();
      const res = await post(`/projects/${pid}/decisions/${sk('p2c-dec-pub')}/approve`, { optionIndex: 0 });
      expect(res.status).toBeLessThan(300);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: sk('p2c-dec-pub') } })).status).toBe('approved');
      expect((await lastAudit('decision.approve'))?.actorId).toBe(uid);
      expect(await t.prisma.decisionEvent.findFirst({ where: { decisionId: sk('p2c-dec-pub'), type: 'approved' } })).toBeTruthy();
      expect(await notifCount()).toBe(before + 1);
      expect(pushCalls()[0][2]).toEqual(['pmc', 'contractor', 'engineer']);
      expect(socketSignalled()).toBe(true);
    });

    it('requestChange: decision.change audit(actorId) + change_requested event + signal, NO push', async () => {
      const res = await post(`/projects/${pid}/decisions/${sk('p2c-dec-pub')}/change`, { reason: 'client changed mind', costImpact: 0, timeImpactDays: 0 });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('decision.change'))?.actorId).toBe(uid);
      expect(await t.prisma.decisionEvent.findFirst({ where: { decisionId: sk('p2c-dec-pub'), type: 'change_requested' } })).toBeTruthy();
      expect(socketSignalled()).toBe(true);
      expect(pushCalls(), 'requestChange signals but pushes nothing').toHaveLength(0);
    });

    it('withdrawChange: decision.change_withdraw audit(actorId) + change_withdrawn event + signal', async () => {
      const res = await post(`/projects/${pid}/decisions/${sk('p2c-dec-pub')}/change/withdraw`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('decision.change_withdraw'))?.actorId).toBe(uid);
      expect(await t.prisma.decisionEvent.findFirst({ where: { decisionId: sk('p2c-dec-pub'), type: 'change_withdrawn' } })).toBeTruthy();
      expect(socketSignalled()).toBe(true);
    });

    it('approve ROLLBACK: a second approve of the locked decision → 409, no duplicate event', async () => {
      const before = await t.prisma.decisionEvent.count({ where: { decisionId: sk('p2c-dec-pub') } });
      const res = await post(`/projects/${pid}/decisions/${sk('p2c-dec-pub')}/approve`, { optionIndex: 0 });
      expect(res.status).toBe(409);
      expect(await t.prisma.decisionEvent.count({ where: { decisionId: sk('p2c-dec-pub') } })).toBe(before);
    });
  });

  // ─── activities (audit split: create/update/remove/start BARE role; complete/override attributed) ──
  describe('activities', () => {
    it('create: activity.create audit with a BARE role (null actorId) + push[engineer,contractor] + signal', async () => {
      const res = await post(`/projects/${pid}/activities`, { name: 'Wall', zone: 'GF', plannedStart: 0, plannedEnd: 5 });
      expect(res.status).toBeLessThan(300);
      const audit = await lastAudit('activity.create');
      expect(audit?.actorId, 'activity.create records NO actorId — the gap Task 3 closes').toBeNull();
      expect(audit?.actor).toBe('pmc');
      expect(pushCalls()[0][2]).toEqual(['engineer', 'contractor']);
      expect(socketSignalled()).toBe(true);
    });

    it('update: activity.update audit(bare role) + signal, no push', async () => {
      const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId: pid, name: 'Wall' } });
      const res = await patch(`/projects/${pid}/activities/${a.id}`, { name: 'Wall B' });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('activity.update'))?.actorId).toBeNull();
      expect(socketSignalled()).toBe(true);
      expect(pushCalls()).toHaveLength(0);
    });

    it('remove: activity.delete(bare role) + CROSS-MODULE drawing.activityId → null + signal', async () => {
      const a = await t.prisma.activity.create({ data: { id: sk('p2c-act-rm'), projectId: pid, name: 'Temp', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 1 } });
      await t.prisma.drawing.create({ data: { id: sk('p2c-dwg-link'), projectId: pid, number: 'A-1', title: 'Plan', discipline: 'arch', activityId: a.id, publishedAt: new Date(), authorId: uid } });
      const res = await del(`/projects/${pid}/activities/${a.id}`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('activity.delete'))?.actorId).toBeNull();
      expect((await t.prisma.drawing.findUniqueOrThrow({ where: { id: sk('p2c-dwg-link') } })).activityId, 'the linked drawing was unlinked (cross-module)').toBeNull();
      expect(socketSignalled()).toBe(true);
    });

    it('start: activity.start audit(bare role) + signal (all gates na → startable)', async () => {
      await t.prisma.activity.create({ data: { id: sk('p2c-act-start'), projectId: pid, name: 'Ready', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 3, gateMaterial: 'na', gateTeam: 'na' } });
      const res = await post(`/projects/${pid}/activities/${sk('p2c-act-start')}/start`);
      expect(res.status).toBeLessThan(300);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-act-start') } })).status).toBe('in_progress');
      expect((await lastAudit('activity.start'))?.actorId).toBeNull();
      expect(socketSignalled()).toBe(true);
    });

    it('complete: activity.complete_requested audit(actorId) + Notification + CROSS-MODULE closing Inspection + push[pmc]', async () => {
      await t.prisma.activity.create({ data: { id: sk('p2c-act-done'), projectId: pid, name: 'Slab', zone: 'GF', status: 'in_progress', plannedStart: 0, plannedEnd: 3 } });
      const before = await notifCount();
      const res = await post(`/projects/${pid}/activities/${sk('p2c-act-done')}/complete`);
      expect(res.status).toBeLessThan(300);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-act-done') } })).status).toBe('awaiting_signoff');
      expect((await lastAudit('activity.complete_requested'))?.actorId).toBe(uid);
      const closing = await t.prisma.inspection.findFirst({ where: { projectId: pid, activityId: sk('p2c-act-done'), closing: true } });
      expect(closing, 'completing an activity creates its closing Inspection (cross-module)').toBeTruthy();
      expect(await notifCount()).toBe(before + 1);
      expect(pushCalls()[0][2]).toEqual(['pmc']);
      expect(socketSignalled()).toBe(true);
    });

    it('override + revokeOverride: activity.override / override_revoke audit(actorId) + gateOverride row', async () => {
      const a = await t.prisma.activity.create({ data: { id: sk('p2c-act-ovr'), projectId: pid, name: 'Ovr', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 1 } });
      const future = new Date(Date.now() + 7 * 864e5).toISOString();
      const r1 = await post(`/projects/${pid}/activities/${a.id}/override`, { gate: 'material', state: 'ok', reason: 'verified on site', expiresAt: future });
      expect(r1.status).toBeLessThan(300);
      expect((await lastAudit('activity.override'))?.actorId).toBe(uid);
      const ovr = await t.prisma.gateOverride.findFirstOrThrow({ where: { activityId: a.id } });
      expect(pushCalls()[0][2]).toEqual(['engineer', 'contractor']);
      const r2 = await del(`/projects/${pid}/activities/${a.id}/override/${ovr.id}`);
      expect(r2.status).toBeLessThan(300);
      expect((await lastAudit('activity.override_revoke'))?.actorId).toBe(uid);
      expect(await t.prisma.gateOverride.findUnique({ where: { id: ovr.id } })).toBeNull();
    });

    it('complete ROLLBACK: completing a not_started activity → 409, no closing inspection', async () => {
      await t.prisma.activity.create({ data: { id: sk('p2c-act-ns'), projectId: pid, name: 'NS', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 1 } });
      const res = await post(`/projects/${pid}/activities/${sk('p2c-act-ns')}/complete`);
      expect(res.status).toBe(409);
      expect(await t.prisma.inspection.count({ where: { activityId: sk('p2c-act-ns') } })).toBe(0);
    });
  });

  // ─── phases (audit BARE role; remove writes CROSS-MODULE Activity.phaseId) ───
  describe('phases', () => {
    it('create: phase.create audit(bare role) + signal', async () => {
      const res = await post(`/projects/${pid}/phases`, { name: 'Foundation', plannedStart: 0, plannedEnd: 10 });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('phase.create'))?.actorId).toBeNull();
      expect(socketSignalled()).toBe(true);
    });

    it('remove: phase.delete audit(bare role) + CROSS-MODULE activity.phaseId → null + signal', async () => {
      const ph = await t.prisma.phase.create({ data: { id: sk('p2c-phase-rm'), projectId: pid, name: 'Temp phase', order: 9 } });
      await t.prisma.activity.create({ data: { id: sk('p2c-act-ph'), projectId: pid, name: 'Phased', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 1, phaseId: ph.id } });
      const res = await del(`/projects/${pid}/phases/${ph.id}`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('phase.delete'))?.actorId).toBeNull();
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-act-ph') } })).phaseId, 'phase delete nulls Activity.phaseId (cross-module)').toBeNull();
      expect(socketSignalled()).toBe(true);
    });
  });

  // ─── inspections (audit ATTRIBUTED) ─────────────────────────────────────────
  describe('inspections', () => {

    it('create: inspection.create audit(actorId) + Notification + push[engineer] + signal', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/inspections`, { title: 'Rebar', zone: 'GF', items: ['Spacing'] });
      expect(res.status).toBeLessThan(300);
      expect(await t.prisma.inspection.findFirst({ where: { projectId: pid, title: 'Rebar' } })).toBeTruthy();
      expect((await lastAudit('inspection.create'))?.actorId).toBe(uid);
      expect(await notifCount()).toBe(before + 1);
      expect(pushCalls()[0][2]).toEqual(['engineer']);
      expect(socketSignalled()).toBe(true);
    });

    it('submit: inspection.submit audit(actorId) + signal', async () => {
      await t.prisma.inspection.create({ data: { id: sk('p2c-insp-cl'), projectId: pid, kind: 'checklist', title: 'Levels', zone: 'GF', date: '', submitted: false, decided: false, closing: false } });
      const item = await t.prisma.inspectionItem.create({ data: { inspectionId: sk('p2c-insp-cl'), name: 'Level', state: null, order: 0 } });
      const res = await post(`/projects/${pid}/inspections/${sk('p2c-insp-cl')}/submit`, { items: [{ id: item.id, name: 'Level', state: 'pass', photos: 0, note: '' }] });
      expect(res.status).toBeLessThan(300);
      expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: sk('p2c-insp-cl') } })).submitted).toBe(true);
      expect((await lastAudit('inspection.submit'))?.actorId).toBe(uid);
      expect(socketSignalled()).toBe(true);
    });

    it('decide APPROVE (closing): inspection.approve + activity.signoff audit(actorId) + CROSS-MODULE activity→done + push[contractor,client]', async () => {
      const closing = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: pid, activityId: sk('p2c-act-done'), closing: true } });
      const res = await post(`/projects/${pid}/inspections/${closing.id}/decide`, { approve: true, rejectedItemIds: [] });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('inspection.approve'))?.actorId).toBe(uid);
      expect(await lastAudit('activity.signoff'), 'a cross-module activity.signoff audit is written').toBeTruthy();
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-act-done') } })).status, 'closing approval writes the Activity done (cross-module)').toBe('done');
      expect(pushCalls()[0][2]).toEqual(['contractor', 'client']);
      expect(socketSignalled()).toBe(true);
    });

    it('decide REJECT: inspection.reject + reinspection child + CROSS-MODULE activity revert + push[engineer]', async () => {
      const a = await t.prisma.activity.create({ data: { id: sk('p2c-act-rej'), projectId: pid, name: 'RejWork', zone: 'GF', status: 'awaiting_signoff', plannedStart: 0, plannedEnd: 1 } });
      const rev = await t.prisma.inspection.create({ data: { id: sk('p2c-insp-rej'), projectId: pid, kind: 'review', title: 'Close', zone: 'GF', date: '', submitted: true, decided: false, closing: true, activityId: a.id } });
      const it0 = await t.prisma.inspectionItem.create({ data: { inspectionId: rev.id, name: 'Finish', state: 'fail', order: 0 } });
      await t.prisma.media.create({ data: { id: sk('p2c-ev'), projectId: pid, kind: 'inspection', mime: 'image/png', uploadedBy: uid, inspectionId: rev.id, inspectionItemId: it0.id } });
      const res = await post(`/projects/${pid}/inspections/${rev.id}/decide`, { approve: false, rejectedItemIds: [it0.id], assigneeId: engId });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('inspection.reject'))?.actorId).toBe(uid);
      expect(await t.prisma.inspection.findFirst({ where: { reinspectionOfId: rev.id } }), 'reject creates a linked reinspection').toBeTruthy();
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: a.id } })).status, 'reject reverts the Activity to in_progress (cross-module)').toBe('in_progress');
      expect(pushCalls()[0][2]).toEqual(['engineer']);
      expect(socketSignalled()).toBe(true);
    });

    it('submit ROLLBACK: submitting an empty checklist → 400, stays unsubmitted', async () => {
      await t.prisma.inspection.create({ data: { id: sk('p2c-insp-empty'), projectId: pid, kind: 'checklist', title: 'Empty', zone: 'GF', date: '', submitted: false, decided: false, closing: false } });
      const res = await post(`/projects/${pid}/inspections/${sk('p2c-insp-empty')}/submit`, { items: [] });
      expect(res.status).toBe(400);
      expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: sk('p2c-insp-empty') } })).submitted).toBe(false);
    });
  });

  // ─── drawings (audit ATTRIBUTED; NO Notification anywhere) ───────────────────
  describe('drawings', () => {
    it('issue (publish): drawing.issue audit(actorId) + push[engineer,contractor] + NO notification + signal', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/drawings`, { number: 'A-100', title: 'GA', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64'), publish: true });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.issue'))?.actorId).toBe(uid);
      expect(await notifCount(), 'drawings never create a Notification row').toBe(before);
      expect(pushCalls()[0][2]).toEqual(['engineer', 'contractor']);
      expect(socketSignalled()).toBe(true);
    });

    it('publish: drawing.publish audit(actorId) + push[engineer,contractor]', async () => {
      const d = await t.prisma.drawing.create({ data: { id: sk('p2c-dwg-draft'), projectId: pid, number: 'A-200', title: 'Detail', discipline: 'arch', publishedAt: null, authorId: uid } });
      await t.prisma.drawingRevision.create({ data: { id: sk('p2c-rev-draft'), projectId: pid, drawingId: d.id, rev: 'A', status: 'for_construction', mime: 'application/pdf', issuedBy: 'PMC', issuedAt: '2026-06-01' } });
      const res = await post(`/projects/${pid}/drawings/${d.id}/publish`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.publish'))?.actorId).toBe(uid);
      expect(pushCalls()[0][2]).toEqual(['engineer', 'contractor']);
    });

    it('setNode: drawing.refile audit(actorId) + signal, no push', async () => {
      const node = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-dwg'), projectId: pid, name: 'GF', kind: 'zone', order: 0, publishedAt: new Date() } });
      const res = await patch(`/projects/${pid}/drawings/${sk('p2c-dwg-draft')}/node`, { nodeId: node.id });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.refile'))?.actorId).toBe(uid);
      expect(socketSignalled()).toBe(true);
      expect(pushCalls()).toHaveLength(0);
    });

    it('acknowledge: drawing.ack audit(actorId) + push[pmc] on first ack (pmc may ack)', async () => {
      const res = await post(`/projects/${pid}/drawings/rev/${sk('p2c-rev-draft')}/ack`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.ack'))?.actorId).toBe(uid);
      expect(pushCalls()[0]?.[2]).toEqual(['pmc']);
    });

    it('remove: drawing.remove audit(actorId) + signal', async () => {
      const res = await del(`/drawings/${sk('p2c-dwg-draft')}`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.remove'))?.actorId).toBe(uid);
      expect(socketSignalled()).toBe(true);
    });
  });

  // ─── daily-log (audit BARE role) ────────────────────────────────────────────
  describe('daily-log', () => {
    it('start: dailylog.start audit(bare role) + signal', async () => {
      const res = await post(`/projects/${pid}/daily-log/start`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('dailylog.start'))?.actorId).toBeNull();
      expect(socketSignalled()).toBe(true);
    });

    it('addMaterial: material.add audit(bare role) + signal', async () => {
      const res = await post(`/projects/${pid}/daily-log/materials`, { name: 'Cement', qty: '10 bags', zone: 'GF' });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('material.add'))?.actorId).toBeNull();
      expect(socketSignalled()).toBe(true);
    });

    it('flagMismatch: material.mismatch audit(bare role) + Notification + CROSS-MODULE activity gate/block + push[pmc,contractor]', async () => {
      const dec = await t.prisma.decision.create({ data: { id: sk('p2c-dec-mm'), projectId: pid, title: 'Tile', room: 'GF', photoSwatch: 'marble', status: 'approved', publishedAt: new Date(), authorId: uid } });
      await t.prisma.activity.create({ data: { id: sk('p2c-act-mm'), projectId: pid, name: 'Tiling', zone: 'GF', status: 'in_progress', plannedStart: 0, plannedEnd: 3, decisionId: dec.id } });
      const log = await t.prisma.dailyLog.findFirstOrThrow({ where: { projectId: pid } });
      await t.prisma.siteMaterial.create({ data: { id: sk('p2c-mat-mm'), projectId: pid, dailyLogId: log.id, name: 'Tile', qty: '5', zone: 'GF', decisionId: dec.id, swatch: 'tile', matched: true } });
      const before = await notifCount();
      const res = await post(`/projects/${pid}/daily-log/flag-mismatch`, { decisionId: dec.id });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('material.mismatch'))?.actorId).toBeNull();
      expect(await notifCount()).toBe(before + 1);
      const act = await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-act-mm') } });
      expect(act.gateMaterial, 'mismatch fails the material gate (cross-module)').toBe('fail');
      expect(act.status).toBe('blocked');
      expect(pushCalls()[0][2]).toEqual(['pmc', 'contractor']);
      expect(socketSignalled()).toBe(true);
    });

    it('submit: dailylog.submit audit(bare role) + signal', async () => {
      const res = await post(`/projects/${pid}/daily-log/submit`, { checkedIn: true, checkinTime: '09:00', progress: 2, crew: [] });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('dailylog.submit'))?.actorId).toBeNull();
      expect(socketSignalled()).toBe(true);
    });
  });

  // ─── nodes (NO audit, NO notification, ONLY the signal) ─────────────────────
  describe('nodes', () => {
    it('create/publish/rename/move signal-only (no audit row)', async () => {
      const auditBefore = await t.prisma.auditLog.count({ where: { projectId: pid } });
      const zone = (await post(`/projects/${pid}/nodes`, { name: 'Zone1', kind: 'zone' })).body.nodes.find((n: { name: string }) => n.name === 'Zone1');
      expect(socketSignalled()).toBe(true);
      await post(`/projects/${pid}/nodes/${zone.id}/publish`);
      await patch(`/projects/${pid}/nodes/${zone.id}`, { name: 'Zone1b' });
      const zone2 = (await post(`/projects/${pid}/nodes`, { name: 'Zone2', kind: 'zone' })).body.nodes.find((n: { name: string }) => n.name === 'Zone2');
      const room = (await post(`/projects/${pid}/nodes`, { name: 'Room1', kind: 'room', parentId: zone.id })).body.nodes.find((n: { name: string }) => n.name === 'Room1');
      await post(`/projects/${pid}/nodes/${room.id}/move`, { parentId: zone2.id });
      expect(await t.prisma.auditLog.count({ where: { projectId: pid } }), 'node CRUD writes NO audit rows today').toBe(auditBefore);
    });

    it('remove: CROSS-MODULE nodeId → null across activity/inspection/media/drawing/siteMaterial', async () => {
      const zone = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-rm'), projectId: pid, name: 'RmZone', kind: 'zone', order: 5, publishedAt: new Date() } });
      await t.prisma.activity.create({ data: { id: sk('p2c-na'), projectId: pid, name: 'NA', zone: 'x', status: 'not_started', plannedStart: 0, plannedEnd: 1, nodeId: zone.id } });
      await t.prisma.inspection.create({ data: { id: sk('p2c-ni'), projectId: pid, kind: 'checklist', title: 'NI', zone: 'x', date: '', submitted: false, decided: false, closing: false, nodeId: zone.id } });
      await t.prisma.media.create({ data: { id: sk('p2c-nm'), projectId: pid, kind: 'progress', mime: 'image/png', uploadedBy: uid, nodeId: zone.id } });
      await t.prisma.drawing.create({ data: { id: sk('p2c-nd'), projectId: pid, number: 'N-1', title: 'x', discipline: 'arch', nodeId: zone.id, publishedAt: new Date(), authorId: uid } });
      const log = await t.prisma.dailyLog.findFirstOrThrow({ where: { projectId: pid } });
      await t.prisma.siteMaterial.create({ data: { id: sk('p2c-nsm'), projectId: pid, dailyLogId: log.id, name: 'x', qty: '1', zone: 'x', nodeId: zone.id, swatch: 'tile', matched: true } });
      const res = await del(`/projects/${pid}/nodes/${zone.id}`);
      expect(res.status).toBeLessThan(300);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-na') } })).nodeId).toBeNull();
      expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: sk('p2c-ni') } })).nodeId).toBeNull();
      expect((await t.prisma.media.findUniqueOrThrow({ where: { id: sk('p2c-nm') } })).nodeId).toBeNull();
      expect((await t.prisma.drawing.findUniqueOrThrow({ where: { id: sk('p2c-nd') } })).nodeId).toBeNull();
      expect((await t.prisma.siteMaterial.findUniqueOrThrow({ where: { id: sk('p2c-nsm') } })).nodeId).toBeNull();
      expect(socketSignalled()).toBe(true);
    });
  });

  // ─── media (NO audit, NO notification, ONLY the signal) ─────────────────────
  describe('media', () => {
    it('create/setNode/remove signal-only (no audit row)', async () => {
      const auditBefore = await t.prisma.auditLog.count({ where: { projectId: pid } });
      const created = await post(`/projects/${pid}/media`, { kind: 'progress', mime: 'image/png', data: Buffer.from('x').toString('base64') });
      expect(created.status).toBeLessThan(300);
      expect(socketSignalled()).toBe(true);
      const mediaId = created.body.id;
      const node = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-med'), projectId: pid, name: 'MZ', kind: 'zone', order: 6, publishedAt: new Date() } });
      await patch(`/projects/${pid}/media/${mediaId}/node`, { nodeId: node.id });
      await del(`/media/${mediaId}`);
      expect(await t.prisma.auditLog.count({ where: { projectId: pid } }), 'media CRUD writes NO audit rows today').toBe(auditBefore);
    });
  });
});
