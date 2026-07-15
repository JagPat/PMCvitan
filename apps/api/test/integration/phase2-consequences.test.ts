import 'reflect-metadata';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { PushService } from '../../src/push/push.service';

/**
 * Phase 2 Task 1 — CHARACTERIZATION (live PostgreSQL) of the EXACT per-mutation
 * consequence set. EVERY semantic mutation BRANCH is its own isolated test with a
 * FRESH capture window (Codex Task-1 re-review finding 2): each asserts the exact
 * canonical write, audit action+actor, DecisionEvent, notification, socket payload,
 * push body+roles, the NO-side-effect facts (no push / no signal / no audit where
 * none is expected), and — where reachable — rollback.
 *
 * `beforeEach` empties the socket + push captures, so a test only ever sees ITS
 * mutation's signals; every command runs in its own `it`, so removing the signal
 * from a later command can never be masked by an earlier one in the same window.
 *
 * It drives the REAL RealtimeGateway (a fake socket server records the emitted
 * room/event/payload) and spies PushService.notifyProject (the exact body + roles
 * the gateway computes) — never a mock of `notifyChanged`.
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

  // ── capture assertions (a fresh window per test via beforeEach) ──
  const changedEmits = () => emits.filter((e) => e.room === `project:${pid}` && e.event === 'changed');
  /** exactly one `changed` signal to the project room, payload EXACTLY { projectId }. */
  const expectSignal = () => expect(changedEmits().map((e) => e.payload), 'exactly one changed signal, payload { projectId }').toEqual([{ projectId: pid }]);
  const expectNoSignal = () => expect(changedEmits(), 'no changed signal expected').toEqual([]);
  const pushCalls = () => pushSpy.mock.calls as unknown as Array<[string, { title: string; body: string }, string[] | undefined]>;
  /** exactly one push, exact { title:'Vitan PMC', body }, exact target roles. */
  const expectPush = (body: string, roles: string[]) => {
    expect(pushCalls(), 'exactly one push expected').toHaveLength(1);
    expect(pushCalls()[0][0]).toBe(pid);
    expect(pushCalls()[0][1]).toEqual({ title: 'Vitan PMC', body });
    expect(pushCalls()[0][2]).toEqual(roles);
  };
  /** exactly one push whose body matches a pattern (for bodies embedding a name/date/seq id). */
  const expectPushMatching = (bodyRe: RegExp, roles: string[]) => {
    expect(pushCalls(), 'exactly one push expected').toHaveLength(1);
    expect(pushCalls()[0][1].title).toBe('Vitan PMC');
    expect(pushCalls()[0][1].body, `push body should match ${bodyRe}`).toMatch(bodyRe);
    expect(pushCalls()[0][2]).toEqual(roles);
  };
  const expectNoPush = () => expect(pushCalls(), 'no push expected').toHaveLength(0);

  const lastAudit = (action: string) =>
    t.prisma.auditLog.findFirst({ where: { projectId: pid, action }, orderBy: { at: 'desc' } });
  const auditCount = () => t.prisma.auditLog.count({ where: { projectId: pid } });
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
    engId = `${sk('p2c-eng')}`;
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
    it('create (publish): decision.create(actorId) + issued event + 1 notification + push[client] + signal', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/decisions`, { title: 'Flooring', room: 'Living', options: OPTS, publish: true });
      expect(res.status).toBeLessThan(300);
      const created = res.body.decisions.find((d: { title: string }) => d.title === 'Flooring');
      expect((await lastAudit('decision.create'))?.actorId).toBe(uid);
      expect(await t.prisma.decisionEvent.findFirst({ where: { decisionId: created.id, type: 'issued' } })).toBeTruthy();
      expect(await notifCount()).toBe(before + 1);
      expectPush('New decision awaiting your approval: Flooring', ['client']);
      expectSignal();
    });

    it('create (draft): decision.draft(actorId) + drafted event + NO notification + NO push + NO signal', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/decisions`, { title: 'Veneer', room: 'Study', options: OPTS, publish: false });
      expect(res.status).toBeLessThan(300);
      const created = res.body.decisions.find((d: { title: string }) => d.title === 'Veneer');
      expect((await lastAudit('decision.draft'))?.actorId).toBe(uid);
      expect(await t.prisma.decisionEvent.findFirst({ where: { decisionId: created.id, type: 'drafted' } })).toBeTruthy();
      expect(await notifCount(), 'a draft creates no notification').toBe(before);
      expectNoPush();
      expectNoSignal();
    });

    it('publish: decision.publish(actorId) + issued event + 1 notification(title) + push[client] + signal', async () => {
      const d = await t.prisma.decision.create({ data: { id: sk('p2c-dec-pub'), projectId: pid, title: 'Sanitary', room: 'Bath', photoSwatch: 'marble', status: 'pending', publishedAt: null, authorId: uid } });
      await t.prisma.decisionOption.create({ data: { decisionId: d.id, label: 'A', optionKey: 'a', material: 'A', delta: 0, swatch: 'marble', order: 0 } });
      const before = await notifCount();
      const res = await post(`/projects/${pid}/decisions/${d.id}/publish`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('decision.publish'))?.actorId).toBe(uid);
      expect(await t.prisma.decisionEvent.findFirst({ where: { decisionId: d.id, type: 'issued' } }), 'publish records an issued event').toBeTruthy();
      expect(await notifCount(), 'publish adds exactly one notification').toBe(before + 1);
      expectPush('New decision awaiting your approval: Sanitary', ['client']);
      expectSignal();
    });

    it('approve: decision.approve(actorId) + approved event + 1 notification + push[pmc,contractor,engineer]=body', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/decisions/${sk('p2c-dec-pub')}/approve`, { optionIndex: 0 });
      expect(res.status).toBeLessThan(300);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: sk('p2c-dec-pub') } })).status).toBe('approved');
      expect((await lastAudit('decision.approve'))?.actorId).toBe(uid);
      expect(await t.prisma.decisionEvent.findFirst({ where: { decisionId: sk('p2c-dec-pub'), type: 'approved' } })).toBeTruthy();
      expect(await notifCount()).toBe(before + 1);
      // the announcement names WHO approved on behalf of the client + the material (option A)
      expectPushMatching(/ approved Sanitary on behalf of the client — A$/, ['pmc', 'contractor', 'engineer']);
      expectSignal();
    });

    it('requestChange: decision.change(actorId) + change_requested event + signal, NO push', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/decisions/${sk('p2c-dec-pub')}/change`, { reason: 'client changed mind', costImpact: 0, timeImpactDays: 0 });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('decision.change'))?.actorId).toBe(uid);
      expect(await t.prisma.decisionEvent.findFirst({ where: { decisionId: sk('p2c-dec-pub'), type: 'change_requested' } })).toBeTruthy();
      expect(await notifCount(), 'requestChange creates no notification').toBe(before);
      expectNoPush();
      expectSignal();
    });

    it('withdrawChange: decision.change_withdraw(actorId) + change_withdrawn event + signal, NO push', async () => {
      const res = await post(`/projects/${pid}/decisions/${sk('p2c-dec-pub')}/change/withdraw`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('decision.change_withdraw'))?.actorId).toBe(uid);
      expect(await t.prisma.decisionEvent.findFirst({ where: { decisionId: sk('p2c-dec-pub'), type: 'change_withdrawn' } })).toBeTruthy();
      expectNoPush();
      expectSignal();
    });

    it('approve ROLLBACK: a second approve of the locked decision → 409, no new event, no signal, no push', async () => {
      const before = await t.prisma.decisionEvent.count({ where: { decisionId: sk('p2c-dec-pub') } });
      const res = await post(`/projects/${pid}/decisions/${sk('p2c-dec-pub')}/approve`, { optionIndex: 0 });
      expect(res.status).toBe(409);
      expect(await t.prisma.decisionEvent.count({ where: { decisionId: sk('p2c-dec-pub') } })).toBe(before);
      expectNoSignal();
      expectNoPush();
    });
  });

  // ─── activities (audit split: create/update/remove/start BARE; complete/override attributed) ──
  describe('activities', () => {
    it('create: activity.create(attributed — Task 3) + push[engineer,contractor] + signal, no notification', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/activities`, { name: 'Wall', zone: 'GF', plannedStart: 0, plannedEnd: 5 });
      expect(res.status).toBeLessThan(300);
      const audit = await lastAudit('activity.create');
      // Task 3 CLOSED the attribution gap: this formerly-bare site now carries a real actorId
      // (routed through recordAudit), and the role is preserved in actorRole.
      expect(audit?.actorId, 'Task 3: activity.create is attributed to the real user').toBe(uid);
      expect(audit?.actorRole).toBe('pmc');
      expect(await notifCount()).toBe(before);
      expectPush('Schedule updated: Wall planned', ['engineer', 'contractor']);
      expectSignal();
    });

    it('update: activity.update(attributed — Task 3) + signal, no push', async () => {
      const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId: pid, name: 'Wall' } });
      const res = await patch(`/projects/${pid}/activities/${a.id}`, { name: 'Wall B' });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('activity.update'))?.actorId).toBe(uid);
      expectNoPush();
      expectSignal();
    });

    it('remove: activity.delete(attributed — Task 3) + CROSS-MODULE drawing.activityId→null + signal, no push', async () => {
      const a = await t.prisma.activity.create({ data: { id: sk('p2c-act-rm'), projectId: pid, name: 'Temp', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 1 } });
      await t.prisma.drawing.create({ data: { id: sk('p2c-dwg-link'), projectId: pid, number: 'A-1', title: 'Plan', discipline: 'arch', activityId: a.id, publishedAt: new Date(), authorId: uid } });
      const res = await del(`/projects/${pid}/activities/${a.id}`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('activity.delete'))?.actorId).toBe(uid);
      expect((await t.prisma.drawing.findUniqueOrThrow({ where: { id: sk('p2c-dwg-link') } })).activityId, 'the linked drawing was unlinked (cross-module)').toBeNull();
      expectNoPush();
      expectSignal();
    });

    it('start: activity.start(attributed — Task 3) → in_progress + signal, no push (all gates na)', async () => {
      await t.prisma.activity.create({ data: { id: sk('p2c-act-start'), projectId: pid, name: 'Ready', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 3, gateMaterial: 'na', gateTeam: 'na' } });
      const res = await post(`/projects/${pid}/activities/${sk('p2c-act-start')}/start`);
      expect(res.status).toBeLessThan(300);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-act-start') } })).status).toBe('in_progress');
      expect((await lastAudit('activity.start'))?.actorId).toBe(uid);
      expectNoPush();
      expectSignal();
    });

    it('complete: activity.complete_requested(actorId) → awaiting_signoff + CROSS-MODULE closing Inspection + 1 notif + push[pmc]', async () => {
      await t.prisma.activity.create({ data: { id: sk('p2c-act-done'), projectId: pid, name: 'Slab', zone: 'GF', status: 'in_progress', plannedStart: 0, plannedEnd: 3 } });
      const before = await notifCount();
      const res = await post(`/projects/${pid}/activities/${sk('p2c-act-done')}/complete`);
      expect(res.status).toBeLessThan(300);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-act-done') } })).status).toBe('awaiting_signoff');
      expect((await lastAudit('activity.complete_requested'))?.actorId).toBe(uid);
      expect(await t.prisma.inspection.findFirst({ where: { projectId: pid, activityId: sk('p2c-act-done'), closing: true } }), 'completing creates the closing Inspection (cross-module)').toBeTruthy();
      expect(await notifCount()).toBe(before + 1);
      expectPush('Sign-off requested: Slab', ['pmc']);
      expectSignal();
    });

    it('override: activity.override(actorId) + gateOverride row + push[engineer,contractor] + signal', async () => {
      const a = await t.prisma.activity.create({ data: { id: sk('p2c-act-ovr'), projectId: pid, name: 'Ovr', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 1 } });
      const future = new Date(Date.now() + 7 * 864e5).toISOString();
      const res = await post(`/projects/${pid}/activities/${a.id}/override`, { gate: 'material', state: 'ok', reason: 'verified on site', expiresAt: future });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('activity.override'))?.actorId).toBe(uid);
      expect(await t.prisma.gateOverride.findFirst({ where: { activityId: a.id } })).toBeTruthy();
      expectPushMatching(/^Gate override on Ovr: material → ok \(expires /, ['engineer', 'contractor']);
      expectSignal();
    });

    it('revokeOverride: activity.override_revoke(actorId) + gateOverride deleted + signal, no push', async () => {
      const a = await t.prisma.activity.create({ data: { id: sk('p2c-act-rov'), projectId: pid, name: 'Rov', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 1 } });
      const ovr = await t.prisma.gateOverride.create({ data: { id: sk('p2c-ovr'), projectId: pid, activityId: a.id, gate: 'material', state: 'ok', reason: 'x', actorId: uid, actorName: 'PMC', expiresAt: new Date(Date.now() + 7 * 864e5) } });
      const res = await del(`/projects/${pid}/activities/${a.id}/override/${ovr.id}`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('activity.override_revoke'))?.actorId).toBe(uid);
      expect(await t.prisma.gateOverride.findUnique({ where: { id: ovr.id } })).toBeNull();
      expectNoPush();
      expectSignal();
    });

    it('complete ROLLBACK: completing a not_started activity → 409, no closing inspection, no signal, no push', async () => {
      await t.prisma.activity.create({ data: { id: sk('p2c-act-ns'), projectId: pid, name: 'NS', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 1 } });
      const res = await post(`/projects/${pid}/activities/${sk('p2c-act-ns')}/complete`);
      expect(res.status).toBe(409);
      expect(await t.prisma.inspection.count({ where: { activityId: sk('p2c-act-ns') } })).toBe(0);
      expectNoSignal();
      expectNoPush();
    });
  });

  // ─── phases (audit attributed via recordAudit — Task 3; remove writes CROSS-MODULE Activity.phaseId) ───
  describe('phases', () => {
    it('create: phase.create(attributed — Task 3) + signal, no push', async () => {
      const res = await post(`/projects/${pid}/phases`, { name: 'Foundation', plannedStart: 0, plannedEnd: 10 });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('phase.create'))?.actorId).toBe(uid);
      expectNoPush();
      expectSignal();
    });

    it('remove: phase.delete(attributed — Task 3) + CROSS-MODULE activity.phaseId→null + signal, no push', async () => {
      const ph = await t.prisma.phase.create({ data: { id: sk('p2c-phase-rm'), projectId: pid, name: 'Temp phase', order: 9 } });
      await t.prisma.activity.create({ data: { id: sk('p2c-act-ph'), projectId: pid, name: 'Phased', zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 1, phaseId: ph.id } });
      const res = await del(`/projects/${pid}/phases/${ph.id}`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('phase.delete'))?.actorId).toBe(uid);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-act-ph') } })).phaseId, 'phase delete nulls Activity.phaseId (cross-module)').toBeNull();
      expectNoPush();
      expectSignal();
    });
  });

  // ─── inspections (audit ATTRIBUTED) ─────────────────────────────────────────
  describe('inspections', () => {
    it('create: inspection.create(actorId) + 1 notification + push[engineer] + signal', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/inspections`, { title: 'Rebar', zone: 'GF', items: ['Spacing'] });
      expect(res.status).toBeLessThan(300);
      expect(await t.prisma.inspection.findFirst({ where: { projectId: pid, title: 'Rebar' } })).toBeTruthy();
      expect((await lastAudit('inspection.create'))?.actorId).toBe(uid);
      expect(await notifCount()).toBe(before + 1);
      expectPush('New checklist: Rebar — GF', ['engineer']);
      expectSignal();
    });

    it('submit: inspection.submit(actorId) → submitted + signal, no push', async () => {
      await t.prisma.inspection.create({ data: { id: sk('p2c-insp-cl'), projectId: pid, kind: 'checklist', title: 'Levels', zone: 'GF', date: '', submitted: false, decided: false, closing: false } });
      const item = await t.prisma.inspectionItem.create({ data: { inspectionId: sk('p2c-insp-cl'), name: 'Level', state: null, order: 0 } });
      const res = await post(`/projects/${pid}/inspections/${sk('p2c-insp-cl')}/submit`, { items: [{ id: item.id, name: 'Level', state: 'pass', photos: 0, note: '' }] });
      expect(res.status).toBeLessThan(300);
      expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: sk('p2c-insp-cl') } })).submitted).toBe(true);
      expect((await lastAudit('inspection.submit'))?.actorId).toBe(uid);
      expectNoPush();
      expectSignal();
    });

    it('decide APPROVE (closing): inspection.approve + activity.signoff(actorId) + CROSS-MODULE activity→done + push[contractor,client]', async () => {
      const closing = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: pid, activityId: sk('p2c-act-done'), closing: true } });
      const before = await notifCount();
      const res = await post(`/projects/${pid}/inspections/${closing.id}/decide`, { approve: true, rejectedItemIds: [] });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('inspection.approve'))?.actorId).toBe(uid);
      expect(await lastAudit('activity.signoff'), 'a cross-module activity.signoff audit is written').toBeTruthy();
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-act-done') } })).status, 'closing approval writes the Activity done (cross-module)').toBe('done');
      expect(await notifCount()).toBe(before + 1);
      expectPush('Signed off: Slab is complete.', ['contractor', 'client']);
      expectSignal();
    });

    it('decide REJECT: inspection.reject(actorId) + reinspection child + CROSS-MODULE activity revert + push[engineer]', async () => {
      const a = await t.prisma.activity.create({ data: { id: sk('p2c-act-rej'), projectId: pid, name: 'RejWork', zone: 'GF', status: 'awaiting_signoff', plannedStart: 0, plannedEnd: 1 } });
      const rev = await t.prisma.inspection.create({ data: { id: sk('p2c-insp-rej'), projectId: pid, kind: 'review', title: 'Close', zone: 'GF', date: '', submitted: true, decided: false, closing: true, activityId: a.id } });
      const it0 = await t.prisma.inspectionItem.create({ data: { inspectionId: rev.id, name: 'Finish', state: 'fail', order: 0 } });
      await t.prisma.media.create({ data: { id: sk('p2c-ev'), projectId: pid, kind: 'inspection', mime: 'image/png', uploadedBy: uid, inspectionId: rev.id, inspectionItemId: it0.id } });
      const res = await post(`/projects/${pid}/inspections/${rev.id}/decide`, { approve: false, rejectedItemIds: [it0.id], assigneeId: engId });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('inspection.reject'))?.actorId).toBe(uid);
      expect(await t.prisma.inspection.findFirst({ where: { reinspectionOfId: rev.id } }), 'reject creates a linked reinspection').toBeTruthy();
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: a.id } })).status, 'reject reverts the Activity to in_progress (cross-module)').toBe('in_progress');
      expectPushMatching(/^Re-inspection INSP-\d+ created for 1 item\(s\) — due /, ['engineer']);
      expectSignal();
    });

    it('submit ROLLBACK: submitting an empty checklist → 400, stays unsubmitted, no signal, no push', async () => {
      await t.prisma.inspection.create({ data: { id: sk('p2c-insp-empty'), projectId: pid, kind: 'checklist', title: 'Empty', zone: 'GF', date: '', submitted: false, decided: false, closing: false } });
      const res = await post(`/projects/${pid}/inspections/${sk('p2c-insp-empty')}/submit`, { items: [] });
      expect(res.status).toBe(400);
      expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: sk('p2c-insp-empty') } })).submitted).toBe(false);
      expectNoSignal();
      expectNoPush();
    });
  });

  // ─── drawings (audit ATTRIBUTED; NO Notification anywhere) ───────────────────
  describe('drawings', () => {
    it('issue (publish): drawing.issue(actorId) + push[engineer,contractor] + NO notification + signal', async () => {
      const before = await notifCount();
      const res = await post(`/projects/${pid}/drawings`, { number: 'A-100', title: 'GA', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64'), publish: true });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.issue'))?.actorId).toBe(uid);
      expect(await notifCount(), 'drawings never create a Notification row').toBe(before);
      expectPush('Drawing issued: A-100 Rev A — GA', ['engineer', 'contractor']);
      expectSignal();
    });

    it('issue (DRAFT): drawing.issue(actorId) recorded, but a draft reaches NO ONE — no push, no signal', async () => {
      const res = await post(`/projects/${pid}/drawings`, { number: 'A-500', title: 'Draft GA', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64'), publish: false });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.issue'))?.actorId).toBe(uid);
      expect((await t.prisma.drawing.findFirstOrThrow({ where: { projectId: pid, number: 'A-500' } })).publishedAt, 'a draft has no publishedAt').toBeNull();
      expectNoPush();
      expectNoSignal();
    });

    it('revise: a new for_construction revision on a PUBLISHED drawing → drawing.revise(actorId), supersedes the prior, push[engineer,contractor]', async () => {
      const d = await t.prisma.drawing.create({ data: { id: sk('p2c-dwg-rev'), projectId: pid, number: 'A-700', title: 'GA7', discipline: 'arch', publishedAt: new Date(), authorId: uid } });
      const revA = await t.prisma.drawingRevision.create({ data: { id: sk('p2c-rev-a'), projectId: pid, drawingId: d.id, rev: 'A', status: 'for_construction', mime: 'application/pdf', issuedBy: 'PMC', issuedAt: '2026-06-01', recipientsFrozenAt: new Date() } });
      const res = await post(`/projects/${pid}/drawings`, { number: 'A-700', title: 'GA7', discipline: 'architectural', rev: 'B', status: 'for_construction', mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.revise'))?.actorId).toBe(uid);
      expect((await t.prisma.drawingRevision.findUniqueOrThrow({ where: { id: revA.id } })).status, 'the prior for_construction revision is superseded').toBe('superseded');
      expectPush('Drawing issued: A-700 Rev B — GA7', ['engineer', 'contractor']);
      expectSignal();
    });

    it('publish (draft→published): drawing.publish(actorId) + push[engineer,contractor] + signal', async () => {
      const d = await t.prisma.drawing.create({ data: { id: sk('p2c-dwg-draft'), projectId: pid, number: 'A-200', title: 'Detail', discipline: 'arch', publishedAt: null, authorId: uid } });
      await t.prisma.drawingRevision.create({ data: { id: sk('p2c-rev-draft'), projectId: pid, drawingId: d.id, rev: 'A', status: 'for_construction', mime: 'application/pdf', issuedBy: 'PMC', issuedAt: '2026-06-01' } });
      const res = await post(`/projects/${pid}/drawings/${d.id}/publish`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.publish'))?.actorId).toBe(uid);
      expectPush('Drawing issued: A-200 — Detail', ['engineer', 'contractor']);
      expectSignal();
    });

    it('setNode: drawing.refile(actorId) + signal, no push', async () => {
      const node = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-dwg'), projectId: pid, name: 'GF', kind: 'zone', order: 0, publishedAt: new Date() } });
      const res = await patch(`/projects/${pid}/drawings/${sk('p2c-dwg-draft')}/node`, { nodeId: node.id });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.refile'))?.actorId).toBe(uid);
      expectNoPush();
      expectSignal();
    });

    it('acknowledge (first): drawing.ack(actorId) + ackCount 1 + push[pmc] + signal (pmc may ack)', async () => {
      const res = await post(`/projects/${pid}/drawings/rev/${sk('p2c-rev-draft')}/ack`);
      expect(res.status).toBeLessThan(300);
      expect(res.body.ackCount).toBe(1);
      expect((await lastAudit('drawing.ack'))?.actorId).toBe(uid);
      expectPushMatching(/ is building to A-200 Rev A$/, ['pmc']);
      expectSignal();
    });

    it('acknowledge (REPLAY): a second ack by the same user records NOTHING — no new audit, no push, no signal, ackCount stable', async () => {
      const d = await t.prisma.drawing.create({ data: { id: sk('p2c-dwg-ackr'), projectId: pid, number: 'A-800', title: 'AckR', discipline: 'arch', publishedAt: new Date(), authorId: uid } });
      const rev = await t.prisma.drawingRevision.create({ data: { id: sk('p2c-rev-ackr'), projectId: pid, drawingId: d.id, rev: 'A', status: 'for_construction', mime: 'application/pdf', issuedBy: 'PMC', issuedAt: '2026-06-01' } });
      // a prior ack already exists (no audit row) — the replay must add nothing
      await t.prisma.drawingAck.create({ data: { revisionId: rev.id, userId: uid, userName: 'PMC', role: 'pmc' } });
      const auditBefore = await t.prisma.auditLog.count({ where: { projectId: pid, action: 'drawing.ack', entityId: rev.id } });
      const res = await post(`/projects/${pid}/drawings/rev/${rev.id}/ack`);
      expect(res.status).toBeLessThan(300);
      expect(res.body.ackCount, 'the replay does not double-count').toBe(1);
      expect(await t.prisma.auditLog.count({ where: { projectId: pid, action: 'drawing.ack', entityId: rev.id } }), 'a replay writes no audit').toBe(auditBefore);
      expectNoPush();
      expectNoSignal();
    });

    it('remove: drawing.remove(actorId) + signal, no push', async () => {
      const res = await del(`/drawings/${sk('p2c-dwg-draft')}`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('drawing.remove'))?.actorId).toBe(uid);
      expectNoPush();
      expectSignal();
    });
  });

  // ─── daily-log (audit attributed via recordAudit — Task 3) ────────────────────────────────────────────
  describe('daily-log', () => {
    it('start: dailylog.start(attributed — Task 3) + signal, no push', async () => {
      const res = await post(`/projects/${pid}/daily-log/start`);
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('dailylog.start'))?.actorId).toBe(uid);
      expectNoPush();
      expectSignal();
    });

    it('addMaterial: material.add(attributed — Task 3) + signal, no push', async () => {
      const res = await post(`/projects/${pid}/daily-log/materials`, { name: 'Cement', qty: '10 bags', zone: 'GF' });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('material.add'))?.actorId).toBe(uid);
      expectNoPush();
      expectSignal();
    });

    it('flagMismatch: material.mismatch(attributed — Task 3) + 1 notif + CROSS-MODULE activity gate/block + push[pmc,contractor]', async () => {
      const dec = await t.prisma.decision.create({ data: { id: sk('p2c-dec-mm'), projectId: pid, title: 'Tile', room: 'GF', photoSwatch: 'marble', status: 'approved', publishedAt: new Date(), authorId: uid } });
      await t.prisma.activity.create({ data: { id: sk('p2c-act-mm'), projectId: pid, name: 'Tiling', zone: 'GF', status: 'in_progress', plannedStart: 0, plannedEnd: 3, decisionId: dec.id } });
      const log = await t.prisma.dailyLog.findFirstOrThrow({ where: { projectId: pid } });
      await t.prisma.siteMaterial.create({ data: { id: sk('p2c-mat-mm'), projectId: pid, dailyLogId: log.id, name: 'Tile', qty: '5', zone: 'GF', decisionId: dec.id, swatch: 'tile', matched: true } });
      const before = await notifCount();
      const res = await post(`/projects/${pid}/daily-log/flag-mismatch`, { decisionId: dec.id });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('material.mismatch'))?.actorId).toBe(uid);
      expect(await notifCount()).toBe(before + 1);
      const act = await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-act-mm') } });
      expect(act.gateMaterial, 'mismatch fails the material gate (cross-module)').toBe('fail');
      expect(act.status).toBe('blocked');
      expectPush(`Material mismatch: Tile ≠ approved ${dec.id}`, ['pmc', 'contractor']);
      expectSignal();
    });

    it('submit: dailylog.submit(attributed — Task 3) + signal, no push', async () => {
      const res = await post(`/projects/${pid}/daily-log/submit`, { checkedIn: true, checkinTime: '09:00', progress: 2, crew: [] });
      expect(res.status).toBeLessThan(300);
      expect((await lastAudit('dailylog.submit'))?.actorId).toBe(uid);
      expectNoPush();
      expectSignal();
    });
  });

  // ─── nodes (NO audit, NO notification, ONLY the signal) — each branch isolated ──
  describe('nodes', () => {
    it('create: signal only — no audit, no push', async () => {
      const auditBefore = await auditCount();
      const res = await post(`/projects/${pid}/nodes`, { name: 'Zone1', kind: 'zone' });
      expect(res.status).toBeLessThan(300);
      expect(await auditCount(), 'node create writes no audit row').toBe(auditBefore);
      expectNoPush();
      expectSignal();
    });

    it('publish: signal only — no audit, no push', async () => {
      const node = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-pub'), projectId: pid, name: 'Zp', kind: 'zone', order: 3, publishedAt: null, authorId: uid } });
      const auditBefore = await auditCount();
      const res = await post(`/projects/${pid}/nodes/${node.id}/publish`);
      expect(res.status).toBeLessThan(300);
      expect(await auditCount()).toBe(auditBefore);
      expectNoPush();
      expectSignal();
    });

    it('rename: signal only — no audit, no push', async () => {
      const node = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-rn'), projectId: pid, name: 'Zr', kind: 'zone', order: 4, publishedAt: new Date() } });
      const auditBefore = await auditCount();
      const res = await patch(`/projects/${pid}/nodes/${node.id}`, { name: 'Zr2' });
      expect(res.status).toBeLessThan(300);
      expect(await auditCount()).toBe(auditBefore);
      expectNoPush();
      expectSignal();
    });

    it('move: signal only — no audit, no push', async () => {
      const z1 = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-mz1'), projectId: pid, name: 'Mz1', kind: 'zone', order: 5, publishedAt: new Date() } });
      const z2 = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-mz2'), projectId: pid, name: 'Mz2', kind: 'zone', order: 6, publishedAt: new Date() } });
      const room = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-mr'), projectId: pid, name: 'Mr', kind: 'room', order: 0, parentId: z1.id, publishedAt: new Date() } });
      const auditBefore = await auditCount();
      const res = await post(`/projects/${pid}/nodes/${room.id}/move`, { parentId: z2.id });
      expect(res.status).toBeLessThan(300);
      expect(await auditCount()).toBe(auditBefore);
      expectNoPush();
      expectSignal();
    });

    it('remove: CROSS-MODULE nodeId→null across activity/inspection/media/drawing/siteMaterial + signal, no audit, no push', async () => {
      const zone = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-rm'), projectId: pid, name: 'RmZone', kind: 'zone', order: 7, publishedAt: new Date() } });
      await t.prisma.activity.create({ data: { id: sk('p2c-na'), projectId: pid, name: 'NA', zone: 'x', status: 'not_started', plannedStart: 0, plannedEnd: 1, nodeId: zone.id } });
      await t.prisma.inspection.create({ data: { id: sk('p2c-ni'), projectId: pid, kind: 'checklist', title: 'NI', zone: 'x', date: '', submitted: false, decided: false, closing: false, nodeId: zone.id } });
      await t.prisma.media.create({ data: { id: sk('p2c-nm'), projectId: pid, kind: 'progress', mime: 'image/png', uploadedBy: uid, nodeId: zone.id } });
      await t.prisma.drawing.create({ data: { id: sk('p2c-nd'), projectId: pid, number: 'N-1', title: 'x', discipline: 'arch', nodeId: zone.id, publishedAt: new Date(), authorId: uid } });
      const log = await t.prisma.dailyLog.findFirstOrThrow({ where: { projectId: pid } });
      await t.prisma.siteMaterial.create({ data: { id: sk('p2c-nsm'), projectId: pid, dailyLogId: log.id, name: 'x', qty: '1', zone: 'x', nodeId: zone.id, swatch: 'tile', matched: true } });
      const auditBefore = await auditCount();
      const res = await del(`/projects/${pid}/nodes/${zone.id}`);
      expect(res.status).toBeLessThan(300);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: sk('p2c-na') } })).nodeId).toBeNull();
      expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: sk('p2c-ni') } })).nodeId).toBeNull();
      expect((await t.prisma.media.findUniqueOrThrow({ where: { id: sk('p2c-nm') } })).nodeId).toBeNull();
      expect((await t.prisma.drawing.findUniqueOrThrow({ where: { id: sk('p2c-nd') } })).nodeId).toBeNull();
      expect((await t.prisma.siteMaterial.findUniqueOrThrow({ where: { id: sk('p2c-nsm') } })).nodeId).toBeNull();
      expect(await auditCount(), 'node remove writes no audit row').toBe(auditBefore);
      expectNoPush();
      expectSignal();
    });
  });

  // ─── media (NO audit, NO notification, ONLY the signal) — each branch isolated ──
  describe('media', () => {
    it('create: signal only — no audit, no push; returns the new media id', async () => {
      const auditBefore = await auditCount();
      const res = await post(`/projects/${pid}/media`, { kind: 'progress', mime: 'image/png', data: Buffer.from('x').toString('base64') });
      expect(res.status).toBeLessThan(300);
      expect(res.body.id).toBeTruthy();
      expect(await auditCount(), 'media create writes no audit row').toBe(auditBefore);
      expectNoPush();
      expectSignal();
    });

    it('setNode: signal only — no audit, no push', async () => {
      const m = await t.prisma.media.create({ data: { id: sk('p2c-med-sn'), projectId: pid, kind: 'progress', mime: 'image/png', uploadedBy: uid } });
      const node = await t.prisma.projectNode.create({ data: { id: sk('p2c-node-med'), projectId: pid, name: 'MZ', kind: 'zone', order: 8, publishedAt: new Date() } });
      const auditBefore = await auditCount();
      const res = await patch(`/projects/${pid}/media/${m.id}/node`, { nodeId: node.id });
      expect(res.status).toBeLessThan(300);
      expect(await auditCount()).toBe(auditBefore);
      expectNoPush();
      expectSignal();
    });

    it('remove: signal only — no audit, no push', async () => {
      const m = await t.prisma.media.create({ data: { id: sk('p2c-med-rm'), projectId: pid, kind: 'progress', mime: 'image/png', uploadedBy: uid } });
      const auditBefore = await auditCount();
      const res = await del(`/media/${m.id}`);
      expect(res.status).toBeLessThan(300);
      expect(await auditCount()).toBe(auditBefore);
      expectNoPush();
      expectSignal();
    });
  });
});
