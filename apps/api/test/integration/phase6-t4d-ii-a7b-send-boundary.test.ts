import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia, wipeMembershipTransitionsVia } from './fixtures';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { PushService } from '../../src/push/push.service';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
import { ExternalEffectDispatcher } from '../../src/platform/outbox/external-effect-dispatcher';
import { PUSH_CONSUMER } from '../../src/platform/outbox/consumers';
import { cancelQueuedPushBySubject } from '../../src/platform/outbox/cancellation';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A7b — THE SEND BOUNDARY, proven against live PostgreSQL (plan §A.4
 * (i) and (ii); P38's responded arms; P40's per-family arms for the delivered families; P41's
 * `withdrawChange` arm; P33's `withdrawChange` refusal).
 *
 * The push consumer now performs a FINAL re-judge immediately before EACH recipient's provider call
 * (`preSendVerdict`): the delivery row's cancellation mark, the family's own claim predicate re-run
 * (project operability, the decision under its row lock, the person's standing) and, for a role
 * fan-out, the recipient's current standing in the role they were resolved by. A subject that left
 * the actionable set before any send drops the whole delivery with the recorded mark; a stale
 * recipient is skipped without the mark; every recipient stale marks it. The decider claim reads
 * the holder under the decision row lock. The responded family admits an architect requester and
 * drops a non-PMC requester once the decision is withdrawn. The `withdraw` command cancels every
 * queued consultation request and the responses whose target lacks PMC standing (the narrowing
 * `targetUserIds` arm); `withdrawChange` refuses a countersign rejection and cancels the queued
 * consultation requests of the decision it closes. The consultation writers state the frozen
 * attribution pair, and the response intent records the requester's ACTUAL role.
 *
 * The provider call is observed through a spy on `PushService.notifyTargetedUser` (the service is
 * not `ready` under test, so the real method sends nothing either way); the pre-send barrier is
 * held by gating the SECOND call of the family predicate on the query service — the real predicate,
 * the real seals, no test seam in production code.
 */
describe('4d-ii-a / A7b — the send boundary: the pre-send hook, the row-locked decider claim, the withdrawn audience and the cancellations (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let query: DecisionsQueryService;
  let relay: OutboxRelay;
  let push: PushService;
  let pmcToken: string;
  let clientToken: string;
  let ownerToken: string;
  const run = randomUUID().slice(0, 8);
  const eng = { id: `a7b-eng-${run}`, membershipId: '' };
  const clientB = { id: `a7b-clientb-${run}`, membershipId: '' };
  let engToken: string;
  let sends: Array<{ projectId: string; userId: string; body: string }> = [];
  let sendSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    t = await createTestApp();
    // the BACKGROUND RELAY owns external dispatch in these arms: the immediate post-commit
    // dispatcher (the legacy sender mode the test app boots in) would otherwise send every push at
    // the command's commit and leave nothing pending to claim and hold at the pre-send barrier, so
    // it is stubbed to send nothing — the deliveries stay `pending` for `relay.dispatchOne`
    vi.spyOn(t.app.get(ExternalEffectDispatcher), 'dispatchCommitted').mockResolvedValue(undefined);
    f = await createTwoProjectFixture(t.prisma);
    query = t.app.get(DecisionsQueryService);
    relay = t.app.get(OutboxRelay);
    push = t.app.get(PushService);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
    await t.prisma.user.create({ data: { id: eng.id, projectId: f.projectA.id, role: 'engineer', name: 'A7b Engineer', email: `${eng.id}@test.local` } });
    eng.membershipId = (await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: eng.id, role: 'engineer', status: 'active' } })).id;
    engToken = t.issueProjectToken(eng.id, f.projectA.id, 'engineer');
    await t.prisma.user.create({ data: { id: clientB.id, projectId: f.projectA.id, role: 'client', name: 'A7b Client B', email: `${clientB.id}@test.local` } });
    clientB.membershipId = (await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: clientB.id, role: 'client', status: 'active' } })).id;
    sendSpy = vi.spyOn(push, 'notifyTargetedUser').mockImplementation(async (projectId: string, payload: { body: string }, userId: string) => {
      sends.push({ projectId, userId, body: payload.body });
    });
  });

  afterEach(() => {
    sends = [];
    sendSpy.mockImplementation(async (projectId: string, payload: { body: string }, userId: string) => { sends.push({ projectId, userId, body: payload.body }); });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    const projectId = f.projectA.id;
    await sanctionedReset(t.prisma, [
      'Notification', 'DecisionConsultationResponse', 'DecisionConsultation', 'DecisionApprovalRevision', 'ChangeRequest',
      'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'CommandExecution',
    ], { cascade: true });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.projectionGeneration.deleteMany({ where: { projectId } });
    const tmpIds = [eng.id, clientB.id, `a7b-tmp-${run}`];
    await wipeMembershipTransitionsVia(t.prisma, tmpIds);
    await t.prisma.membership.deleteMany({ where: { userId: { in: tmpIds } } });
    await t.prisma.user.deleteMany({ where: { id: { in: tmpIds } } });
    await f?.cleanup();
    await t?.close();
  });

  const post = (token: string) => (path: string, body: object) =>
    request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body);
  const base = () => `/projects/${f.projectA.id}/decisions`;
  const OPTIONS = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];
  /** A published decision, client-held unless a member decider is named. */
  const issue = async (over: object = {}): Promise<string> => {
    const title = `A7b ${randomUUID().slice(0, 8)}`;
    const r = await post(pmcToken)(base(), { title, room: 'Kitchen', publish: true, options: OPTIONS, ...over });
    expect(r.status, r.text).toBe(201);
    return (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
  };
  const ask = (decisionId: string, token = pmcToken) =>
    post(token)(`${base()}/${decisionId}/consultations`, { consulteeMembershipId: eng.membershipId, question: 'Does the granite stain here?' });
  const answer = (decisionId: string, consultationId: string) =>
    post(engToken)(`${base()}/${decisionId}/consultations/respond`, { consultationId, response: 'Quartz — the granite stains.' });
  /** The `webpush.notify` delivery of the decision's latest event of `eventType`. */
  const pushDelivery = async (decisionId: string, eventType: string) => {
    const event = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId: f.projectA.id, entityId: decisionId, eventType }, orderBy: { streamPosition: 'desc' } });
    return t.prisma.outboxDelivery.findFirstOrThrow({ where: { eventId: event.eventId, consumer: PUSH_CONSUMER } });
  };
  const deliveryRow = (id: string) => t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id }, select: { status: true, deliveryAction: true, cancelledAt: true } });

  // ── the decider family: the claim, the fan-out and the pre-send re-judge ──────────────────────

  it('a client-held demand reaches EVERY current client (the fan-out), each behind the hook; the delivery completes unmarked', async () => {
    const did = await issue();
    const d = await pushDelivery(did, 'decision.published');
    expect(await relay.dispatchOne(d.id)).toBe('succeeded');
    expect(sends.map((s) => s.userId).sort()).toEqual([f.clientUser.id, clientB.id].sort());
    expect(await deliveryRow(d.id)).toMatchObject({ status: 'succeeded', deliveryAction: 'dispatch', cancelledAt: null });
  });

  it('CLAIM under the decision row lock: an approval committed before the claim drops the demand with the recorded mark, nothing sent', async () => {
    const did = await issue();
    const d = await pushDelivery(did, 'decision.published');
    expect((await post(clientToken)(`${base()}/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect(await relay.dispatchOne(d.id)).toBe('succeeded');
    expect(sends).toEqual([]);
    const row = await deliveryRow(d.id);
    expect(row.deliveryAction).toBe('noop');
    expect(row.cancelledAt).not.toBeNull();
  });

  it('PRE-SEND, the fan-out arm: a client who LOSES standing while the others are being sent is SKIPPED — the rest sent, no mark', async () => {
    // two temporary clients beside the fixture's two: FOUR holders resolved at claim
    const temps = [`a7b-c1-${run}`, `a7b-c2-${run}`];
    for (const id of temps) {
      await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role: 'client', name: `A7b ${id}`, email: `${id}@test.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role: 'client', status: 'active' } });
    }
    const orgs = t.app.get(OrgsParticipant);
    const originalStanding = orgs.hasProjectRoleStanding.bind(orgs);
    let removedUser: string | null = null;
    try {
      const did = await issue();
      const d = await pushDelivery(did, 'decision.published');
      // the FIRST recipient's own pre-send re-judge removes a temporary client who is NOT that
      // recipient (a members command through the shipped service); every later recipient is
      // re-judged after that commit, and the removed one finds no standing
      vi.spyOn(orgs, 'hasProjectRoleStanding').mockImplementation(async (tx, projectId: string, userId: string, roles: readonly string[], opts?: { forUpdate?: boolean }) => {
        if (removedUser === null && roles.length === 1 && roles[0] === 'client') {
          removedUser = userId === temps[0] ? temps[1]! : temps[0]!;
          const r = await request(t.app.getHttpServer()).delete(`/projects/${f.projectA.id}/members/${removedUser}`)
            .set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID());
          expect(r.status, r.text).toBe(200);
        }
        return originalStanding(tx, projectId, userId, roles, opts);
      });
      expect(await relay.dispatchOne(d.id)).toBe('succeeded');
      expect(removedUser).not.toBeNull();
      const removedMembership = await t.prisma.membership.findFirst({ where: { projectId: f.projectA.id, userId: removedUser! }, select: { status: true } });
      expect(removedMembership?.status).toBe('removed');
      const sentTo = sends.map((s) => s.userId).sort();
      expect(sentTo, `removed=${removedUser} sends=${JSON.stringify(sends)}`).toHaveLength(3);
      expect(sentTo).not.toContain(removedUser);
      expect(sentTo).toContain(f.clientUser.id);
      expect(sentTo).toContain(clientB.id);
      expect(await deliveryRow(d.id)).toMatchObject({ status: 'succeeded', deliveryAction: 'dispatch', cancelledAt: null });
    } finally {
      vi.mocked(orgs.hasProjectRoleStanding).mockRestore();
      await wipeMembershipTransitionsVia(t.prisma, temps);
      await t.prisma.membership.deleteMany({ where: { userId: { in: temps } } });
      await t.prisma.user.deleteMany({ where: { id: { in: temps } } });
    }
  });

  it('PRE-SEND, the single-recipient arm: a member-held demand claimed, the decision APPROVED at the pre-send barrier → nothing sent, the delivery marked', async () => {
    const did = await issue({ deciderKind: 'member', deciderMembershipId: eng.membershipId });
    const d = await pushDelivery(did, 'decision.published');
    // the barrier: the family predicate's SECOND call (the pre-send re-judge) waits until the
    // approval has committed; the claim (the first call) ran unhindered and resolved the engineer
    const original = query.deciderPushTarget.bind(query);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const barrier = new Promise<void>((r) => { reached = r; });
    vi.spyOn(query, 'deciderPushTarget').mockImplementation(async (projectId: string, decisionId: string) => {
      calls += 1;
      if (calls === 2) { reached(); await gate; }
      return original(projectId, decisionId);
    });
    const dispatching = relay.dispatchOne(d.id);
    await barrier;
    // the PMC approves on the member's behalf while the consumer stands at the barrier
    expect((await post(pmcToken)(`${base()}/${did}/approve`, { optionIndex: 1 })).status).toBe(201);
    release();
    const outcome = await dispatching;
    vi.mocked(query.deciderPushTarget).mockRestore();
    expect(outcome).toBe('succeeded');
    expect(sends).toEqual([]);
    const row = await deliveryRow(d.id);
    expect(row.deliveryAction).toBe('noop');
    expect(row.cancelledAt).not.toBeNull();
    expect(calls).toBe(2);
  });

  it('PRE-SEND, a named holder at the barrier: the holder guard REFUSES removing the decider of an open decision, so the demand stands and is sent to them', async () => {
    const tmp = { id: `a7b-tmp-${run}` };
    await t.prisma.user.create({ data: { id: tmp.id, projectId: f.projectA.id, role: 'engineer', name: 'A7b Temp', email: `${tmp.id}@test.local` } });
    const m = await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: tmp.id, role: 'engineer', status: 'active' } });
    let did = '';
    try {
      did = await issue({ deciderKind: 'member', deciderMembershipId: m.id });
      const d = await pushDelivery(did, 'decision.published');
      const original = query.deciderPushTarget.bind(query);
      let calls = 0;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let reached!: () => void;
      const barrier = new Promise<void>((r) => { reached = r; });
      vi.spyOn(query, 'deciderPushTarget').mockImplementation(async (projectId: string, decisionId: string) => {
        calls += 1;
        if (calls === 2) { reached(); await gate; }
        return original(projectId, decisionId);
      });
      const dispatching = relay.dispatchOne(d.id);
      await barrier;
      // the removal attempted at the barrier is refused by 4b's holder guard (the member is the
      // named decider of a published open decision): the standing the hook re-judges cannot end
      // while the demand stands, which is the guard's whole point
      const r = await request(t.app.getHttpServer()).delete(`/projects/${f.projectA.id}/members/${tmp.id}`)
        .set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID());
      expect(r.status, r.text).toBe(409);
      release();
      const outcome = await dispatching;
      vi.mocked(query.deciderPushTarget).mockRestore();
      expect(outcome).toBe('succeeded');
      expect(sends.map((s) => s.userId)).toEqual([tmp.id]);
      expect(await deliveryRow(d.id)).toMatchObject({ status: 'succeeded', deliveryAction: 'dispatch', cancelledAt: null });
      expect(calls).toBe(2);
    } finally {
      // the guard also refuses touching the membership while the decision stands open: withdraw it;
      // the decision row keeps its FK onto the membership, so the row and the user go with the
      // suite's teardown (after the decisions are wiped)
      if (did) expect((await post(pmcToken)(`${base()}/${did}/withdraw`, { reason: 'A7b teardown' })).status).toBe(201);
    }
  });

  // ── the consultation families: the frozen pairs, the intent's audience, the withdrawn audience ──

  it('the consultation writers state the FROZEN attribution pair, and the response intent records the requester\'s actual role', async () => {
    const did = await issue();
    expect((await ask(did)).status).toBe(201);
    const c = await t.prisma.decisionConsultation.findFirstOrThrow({ where: { decisionId: did } });
    const pmcIdentity = await t.prisma.userIdentity.findUniqueOrThrow({ where: { userId: f.memberUser.id } });
    expect(c).toMatchObject({ requestedByRole: 'pmc', requestedByName: pmcIdentity.displayName });
    const requested = await t.prisma.domainEvent.findFirstOrThrow({ where: { entityId: did, eventType: 'decision.consultation_requested' } });
    expect(requested).toMatchObject({ actorRole: 'pmc', actorName: pmcIdentity.displayName });
    expect((await answer(did, c.id)).status).toBe(201);
    const resp = await t.prisma.decisionConsultationResponse.findFirstOrThrow({ where: { consultationId: c.id } });
    const engIdentity = await t.prisma.userIdentity.findUniqueOrThrow({ where: { userId: eng.id } });
    expect(resp).toMatchObject({ respondedByRole: 'engineer', respondedByName: engIdentity.displayName });
    const responded = await t.prisma.domainEvent.findFirstOrThrow({ where: { entityId: did, eventType: 'decision.consultation_responded' } });
    expect((responded.dispatchIntent as { push: { roles: string[]; targetUserId: string } }).push).toMatchObject({ roles: ['pmc'], targetUserId: f.memberUser.id });
    expect(responded).toMatchObject({ actorRole: 'engineer', actorName: engIdentity.displayName });
  });

  it('an org-admin requester with NO membership row RECEIVES the response push (user-targeted, behind the hook)', async () => {
    const did = await issue();
    expect((await ask(did, ownerToken)).status).toBe(201);
    const c = await t.prisma.decisionConsultation.findFirstOrThrow({ where: { decisionId: did, requestedById: f.ownerUser.id } });
    expect(c.requestedByRole).toBe('pmc');
    expect((await answer(did, c.id)).status).toBe(201);
    const d = await pushDelivery(did, 'decision.consultation_responded');
    expect(await relay.dispatchOne(d.id)).toBe('succeeded');
    expect(sends.map((s) => s.userId)).toEqual([f.ownerUser.id]);
    expect(await deliveryRow(d.id)).toMatchObject({ deliveryAction: 'dispatch', cancelledAt: null });
  });

  it('WITHDRAW cancels every queued consultation REQUEST, keeps the PMC requester\'s RESPONSE (the withdrawn-audience arm), and the predicate says why', async () => {
    const did = await issue();
    expect((await ask(did)).status).toBe(201);
    const c = await t.prisma.decisionConsultation.findFirstOrThrow({ where: { decisionId: did } });
    expect((await answer(did, c.id)).status).toBe(201);
    const requestDelivery = await pushDelivery(did, 'decision.consultation_requested');
    const responseDelivery = await pushDelivery(did, 'decision.consultation_responded');
    const w = await post(pmcToken)(`${base()}/${did}/withdraw`, { reason: 'Client changed scope' });
    expect(w.status, w.text).toBe(201);
    // the request (an invitation `consultation.respond` now refuses) is cancelled in place
    expect(await deliveryRow(requestDelivery.id)).toMatchObject({ status: 'succeeded', deliveryAction: 'noop' });
    expect((await deliveryRow(requestDelivery.id)).cancelledAt).not.toBeNull();
    // the PMC requester's response stands — and is still SENT after the withdrawal
    expect(await deliveryRow(responseDelivery.id)).toMatchObject({ status: 'pending', cancelledAt: null });
    expect(await relay.dispatchOne(responseDelivery.id)).toBe('succeeded');
    expect(sends.map((s) => s.userId)).toEqual([f.memberUser.id]);
    // the predicate's own answer: the PMC requester keeps it; a requester without PMC standing is dropped
    expect(await query.consultationRespondedPushTarget(f.projectA.id, did, f.memberUser.id)).toEqual({ actionable: true, targetUserId: f.memberUser.id });
    expect(await query.consultationRespondedPushTarget(f.projectA.id, did, eng.id)).toEqual({ actionable: false });
    // the register event counts the request cancellation (the published push was already dispatched? no — it was pending too)
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { entityId: did, eventType: 'decision.withdrawn' } });
    expect((ev.payload as { pushIntentsCancelled: number }).pushIntentsCancelled).toBeGreaterThanOrEqual(2);
  });

  it('the NARROWING arm: `targetUserIds` cancels only the responses whose durable intent names one of the targets; an empty list cancels nothing', async () => {
    const did = await issue();
    expect((await ask(did)).status).toBe(201);
    expect((await ask(did, ownerToken)).status).toBe(201);
    const cs = await t.prisma.decisionConsultation.findMany({ where: { decisionId: did }, orderBy: { requestedAt: 'asc' } });
    for (const c of cs) expect((await answer(did, c.id)).status).toBe(201);
    const deliveries = await t.prisma.outboxDelivery.findMany({
      where: { consumer: PUSH_CONSUMER, event: { is: { entityId: did, eventType: 'decision.consultation_responded' } } },
      include: { event: { select: { dispatchIntent: true } } },
    });
    expect(deliveries).toHaveLength(2);
    const targetOf = (d: (typeof deliveries)[number]) => (d.event.dispatchIntent as { push: { targetUserId: string } }).push.targetUserId;
    const ownerDelivery = deliveries.find((d) => targetOf(d) === f.ownerUser.id)!;
    const pmcDelivery = deliveries.find((d) => targetOf(d) === f.memberUser.id)!;
    expect(await t.prisma.$transaction((tx) => cancelQueuedPushBySubject(tx, { projectId: f.projectA.id, subject: did, eventType: 'decision.consultation_responded', targetUserIds: [] })))
      .toEqual({ neutralized: 0, marked: 0, entombed: 0 });
    const narrowed = await t.prisma.$transaction((tx) => cancelQueuedPushBySubject(tx, { projectId: f.projectA.id, subject: did, eventType: 'decision.consultation_responded', targetUserIds: [f.ownerUser.id] }));
    expect(narrowed).toMatchObject({ neutralized: 1, marked: 0, entombed: 0 });
    expect(await deliveryRow(ownerDelivery.id)).toMatchObject({ status: 'succeeded', deliveryAction: 'noop' });
    expect(await deliveryRow(pmcDelivery.id)).toMatchObject({ status: 'pending', cancelledAt: null });
  });

  // ── withdrawChange: the refusal and the open set ─────────────────────────────────────────────

  it('withdrawChange LEAVES the consultation-open set: the queued consultation requests are cancelled, and a late answer is refused', async () => {
    const did = await issue();
    expect((await post(clientToken)(`${base()}/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await post(engToken)(`${base()}/${did}/change`, { reason: 'Wrong finish', costImpact: 0, timeImpactDays: 0 })).status).toBe(201);
    expect((await ask(did)).status).toBe(201);
    const c = await t.prisma.decisionConsultation.findFirstOrThrow({ where: { decisionId: did } });
    const requestDelivery = await pushDelivery(did, 'decision.consultation_requested');
    const w = await post(engToken)(`${base()}/${did}/change/withdraw`, {});
    expect(w.status, w.text).toBe(201);
    expect(await deliveryRow(requestDelivery.id)).toMatchObject({ status: 'succeeded', deliveryAction: 'noop' });
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { entityId: did, eventType: 'decision.change_withdrawn' } });
    expect((ev.payload as { pushIntentsCancelled: number }).pushIntentsCancelled).toBe(1);
    // P41's shape: finalize-first → the consultee's answer is refused with no response row
    const late = await answer(did, c.id);
    expect(late.status).toBe(409);
    expect(await t.prisma.decisionConsultationResponse.count({ where: { consultationId: c.id } })).toBe(0);
    // and the cancelled invitation, dispatched now, sends nothing (the relay's own mark re-read)
    expect(await relay.dispatchOne(requestDelivery.id)).toBe('skip');
    expect(sends).toEqual([]);
  });

  it('withdrawChange REFUSES a countersign rejection (409 naming re-approval) and leaves the decision in change', async () => {
    const did = await issue();
    expect((await post(clientToken)(`${base()}/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await post(engToken)(`${base()}/${did}/change`, { reason: 'Disagree', costImpact: 0, timeImpactDays: 0 })).status).toBe(201);
    const open = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: did, status: 'open' } });
    const head = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId: did }, orderBy: { version: 'desc' } });
    // the origin and the revision it answers are FROZEN by 4d-i's evidence seal; the disagreement
    // command that writes them is A8b's, so the state is planted under the seal disabled BY NAME
    // inside one transaction (the sanctioned bypass shape) — the only way a `countersign_rejection`
    // request can exist before A8b. The row keeps every CHECK 4d-i put on the shape (a rejection
    // names the revision it rejects).
    // `DISABLE TRIGGER USER`, the whole-table form the coverage tripwire sanctions: naming the freeze
    // alone leaves the table's deferred seals queuing events on the UPDATE, and PostgreSQL refuses to
    // re-enable a trigger while trigger events are pending in the same transaction.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "ChangeRequest" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe(`UPDATE "ChangeRequest" SET "origin" = 'countersign_rejection', "revisionId" = '${head.id}' WHERE "id" = '${open.id}'`),
      t.prisma.$executeRawUnsafe('ALTER TABLE "ChangeRequest" ENABLE TRIGGER USER'),
    ]);
    const w = await post(pmcToken)(`${base()}/${did}/change/withdraw`, {});
    expect(w.status).toBe(409);
    expect(w.body.message).toMatch(/countersign rejection.*re-approval/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: did } })).status).toBe('change');
    expect((await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: open.id } })).status).toBe('open');
  });
});
