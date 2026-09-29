import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia, wipeMembershipTransitionsVia } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { PUSH_CONSUMER } from '../../src/platform/outbox/consumers';
import { EXTERNAL_EFFECTS } from '../../src/platform/external-effects';
import { PHASE6_4D_RESERVATION_DOORS } from '../../src/platform/phase6-4d-rollout';
import { AWAITING_COUNTERSIGN_NOTICE_COLOR, FORWARDED_DECISION_NOTICE_COLOR } from '../../src/domain/notifications';

/**
 * Phase 6 task 4d unit 4d-ii-a / A8a — FORWARD AND APPROVE, driven live through the shipped routes (plan
 * §A.2 "Forwarding", "Countersign, and the state that carries it"; §A.4 (i); §C P29, P30, P31 (the
 * provisional approve's arms), P34 (the command's arms), P38 (the frozen recipients); the staging note's
 * A8a row).
 *
 * The doors 4d-i installs and 4d-iii drops are DROPPED for this suite (captured from the catalog and
 * re-created after), because every chain shape it proves is one they reserve: a `DecisionForward` row, a
 * `forwarded` audit row, an architect membership, a decision awaiting its countersign. That is 4d-iii's
 * act, rehearsed and undone. Every seal that is not a door stays on: the bundles below commit THROUGH
 * `phase6_t4d_forward_seal`, `_paired`, `_provenance_bound`, the claimants, the birth and entry seals and
 * the correspondence seal, or they do not commit at all.
 *
 * What is proven:
 *   - the door: with `DecisionForward_t4d_reserved` standing the command refuses 409 with the drain
 *     directive, before any write;
 *   - the hand-off (no chain, P29/P34): the PMC forwards a client-held pending decision to a named member
 *     — the fact first (the displaced designation, the new one, the actor's frozen pair, the reason, the
 *     receipt naming the fact), the holder moved, ONE `decision.forwarded` naming the fact with the new
 *     holder's users FROZEN, its audit row, its kinded notice, the fact's claim; the displaced holder's
 *     queued approval demand cancelled with the mark; the holder's own forward, the role target's users
 *     frozen; a non-holder refused 403; the same target, a removed target, an empty role, a draft, a
 *     withdrawn decision and a blank reason refused with an answer; the unkeyed call synthesizing its
 *     receipt and a keyed retry replaying;
 *   - the no-chain approve (P29): lands `approved` with `finalized = true`, the act recorded on the
 *     revision (`approvedFrom`, the frozen pair), the green notice — and the decider demand cancelled;
 *   - the PROVISIONAL approve (P31): under an active chain the approve lands `awaiting_countersign` with
 *     the tuple written, the revision born `finalized = false` with `approvedFrom` and the pair, exactly
 *     ONE `decision.awaiting_countersign` naming the revision to the architects frozen, NO approval event,
 *     the `approved` audit row, the provisional notice (the awaiting colour, never green), the claim; the
 *     chain reapproval from `change` likewise (`reapproved`, the request resolved); the awaiting decision
 *     refuses a second approve and a generic forward; its audience (pmc, the decider, the architect — not a
 *     bystander); a forward to the architect role freezing the architect.
 */
describe('4d-ii-a / A8a — forward and approve: the hand-off and the provisional approval (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let query: DecisionsQueryService;
  let pmcToken: string;
  let clientToken: string;
  let engToken: string;
  let architectToken: string;
  const run = randomUUID().slice(0, 8);
  let doorDefs: Array<{ tgname: string; def: string }> = [];
  const eng = { id: '', membershipId: '', name: `A8a Engineer ${''}` };
  const architect = { id: '', membershipId: '' };
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    query = t.app.get(DecisionsQueryService);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    // 4d-iii's act, rehearsed: capture and drop the six reservation doors for the suite
    doorDefs = await t.prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
      [...PHASE6_4D_RESERVATION_DOORS],
    );
    expect(doorDefs.map((d) => d.tgname)).toEqual([...PHASE6_4D_RESERVATION_DOORS].sort());
    for (const d of doorDefs) await dropDoor(d);
    // a named member to hand decisions to
    const r = await addMember({ name: `A8a Engineer ${run}`, role: 'engineer', email: `a8a-eng-${run}@test.local` });
    expect(r.status, r.text).toBe(201);
    eng.id = r.body.userId; eng.membershipId = r.body.membershipId; eng.name = `A8a Engineer ${run}`;
    createdUserIds.push(eng.id);
    engToken = t.issueProjectToken(eng.id, f.projectA.id, 'engineer');
  });

  afterAll(async () => {
    const projectId = f?.projectA.id;
    try {
      if (t?.prisma && projectId) {
        await wipeDecisionEvents(t.prisma, { decision: { projectId } });
        // the approval register, the feed and the stream first: the revisions hold NO ACTION keys onto
        // the decisions, and the sanctioned reset is the one path past their seals
        await sanctionedReset(t.prisma, [
          'Notification', 'DecisionApprovalRevision', 'ChangeRequest',
          'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'CommandExecution',
          'DecisionProjection', 'ProjectionGeneration', 'DomainEventPairingClaim',
        ], { cascade: true });
        await wipeDecisionsVia(t.prisma, async (tx) => {
          await tx.decisionForward.deleteMany({ where: { projectId } });
          await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
          await tx.decision.deleteMany({ where: { projectId } });
        });
        // an ACTIVE architect membership is a standing the seals let only an attributable act end
        if (architect.id && (await t.prisma.membership.count({ where: { userId: architect.id, status: 'active' } })) > 0) {
          await removeMember(architect.id);
        }
        await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'CommandExecution', 'DomainEventPairingClaim'], { cascade: true });
        const provisioned = await t.prisma.user.findMany({ where: { email: { startsWith: 'a8a-', endsWith: `-${run}@test.local` } }, select: { id: true } });
        const ids = [...new Set([...createdUserIds, ...provisioned.map((u) => u.id)])];
        await wipeMembershipTransitionsVia(t.prisma, [...ids, f.memberUser.id]);
        await t.prisma.membership.deleteMany({ where: { userId: { in: ids } } });
        await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorUserId: { in: ids } }] } });
        await t.prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    } catch (e) {
      console.error('A8a teardown failed before the fixture cleanup:', e);
      throw e;
    } finally {
      for (const d of doorDefs) await t.prisma.$executeRawUnsafe(d.def);
      await f?.cleanup();
      await t?.close();
    }
  });

  const dropDoor = async (d: { tgname: string; def: string }) => {
    const table = /ON public\."?(\w+)"?/.exec(d.def)![1];
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${d.tgname}" ON "${table}"`);
  };
  const http = () => request(t.app.getHttpServer());
  const members = () => `/projects/${f.projectA.id}/members`;
  const addMember = (body: object) => http().post(members()).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send(body);
  const removeMember = (userId: string) => http().delete(`${members()}/${userId}`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send();
  const OPTIONS = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];
  const CONTRACT = 'countersign-v1';
  const issue = async (over: object = {}): Promise<{ id: string; title: string }> => {
    const title = `A8a ${randomUUID().slice(0, 8)}`;
    const r = await http().post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .set('x-vitan-decisions-contract', CONTRACT)
      .send({ title, room: 'Kitchen', publish: true, options: OPTIONS, ...over });
    expect(r.status, r.text).toBe(201);
    return { id: (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id, title };
  };
  const forward = (token: string, decisionId: string, body: object, key: string | null = randomUUID()) => {
    const req = http().post(`/projects/${f.projectA.id}/decisions/${decisionId}/forward`).set('Authorization', `Bearer ${token}`).set('x-vitan-decisions-contract', CONTRACT);
    return (key === null ? req : req.set('Idempotency-Key', key)).send(body);
  };
  const approve = (token: string, decisionId: string, optionIndex = 0) =>
    http().post(`/projects/${f.projectA.id}/decisions/${decisionId}/approve`).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID())
      .set('x-vitan-decisions-contract', CONTRACT).send({ optionIndex });
  const decisionsFor = async (token: string) => {
    const r = await http().get(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${token}`).set('x-vitan-decisions-contract', CONTRACT);
    expect(r.status, r.text).toBe(200);
    return r.body.decisions as Array<{ id: string; status: string; deciderKind: string; deciderUserId?: string; countersignRequired?: true }>;
  };
  const eventsOf = (decisionId: string, type: string) => t.prisma.domainEvent.findMany({ where: { projectId: f.projectA.id, entityType: 'Decision', entityId: decisionId, eventType: type }, orderBy: { streamPosition: 'asc' } });
  const pushRows = (decisionId: string, type: string) => t.prisma.outboxDelivery.findMany({
    where: { consumer: PUSH_CONSUMER, projectId: f.projectA.id, subject: decisionId, event: { is: { eventType: type } } }, orderBy: { id: 'asc' },
  });
  const claimOf = (eventId: string) => t.prisma.domainEventPairingClaim.findFirst({ where: { eventId } });
  const intent = (e: { dispatchIntent: unknown }) => e.dispatchIntent as { push?: { body?: string; targetUserId?: string; targetUserIds?: string[]; roles?: string[] } };
  /** no queued demand of the family survives: the test app's legacy sender delivers a push in the
   *  request (its row is `succeeded` before the next command runs), so a row still PENDING after the
   *  cancelling command must carry the cancellation mark */
  const noPendingDemand = async (decisionId: string, type: string) => {
    for (const row of await pushRows(decisionId, type)) expect(row.status === 'pending' && row.cancelledAt === null, `${type} delivery ${row.id} still pending`).toBe(false);
  };

  // ═══ THE DOOR ═══════════════════════════════════════════════════════════════════════════════
  it('with the forward door standing the command refuses 409 with the drain directive, before any write', async () => {
    const d = await issue();
    const door = doorDefs.find((x) => x.tgname === 'DecisionForward_t4d_reserved')!;
    await t.prisma.$executeRawUnsafe(door.def);
    try {
      const r = await forward(pmcToken, d.id, { toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId, reason: 'the engineer decides finishes' });
      expect(r.status, r.text).toBe(409);
      expect(r.body.message).toMatch(/phase-6-4d-previous-release-drained/);
      expect(await t.prisma.decisionForward.count({ where: { decisionId: d.id } })).toBe(0);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).deciderKind).toBe('client');
    } finally {
      await dropDoor(door);
    }
  });

  // ═══ THE HAND-OFF, NO CHAIN (P29 / P34) ═══════════════════════════════════════════════════════
  it('the PMC forwards a client-held pending decision to a named member: the fact first, the holder moved, ONE frozen-audience event naming the fact, the audit row, the kinded notice, the claim, and the displaced holder\'s demand cancelled', async () => {
    const d = await issue();
    const demand = await pushRows(d.id, 'decision.published');
    expect(demand.length, 'the client\'s approval demand is queued').toBeGreaterThan(0);
    const r = await forward(pmcToken, d.id, { toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId, reason: 'the engineer decides finishes' });
    expect(r.status, r.text).toBe(201);

    const fact = await t.prisma.decisionForward.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(fact).toMatchObject({
      projectId: f.projectA.id, fromDesignationKind: 'client', fromDesignationMembershipId: null,
      toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId,
      forwardedById: f.memberUser.id, forwardedByRole: 'pmc', reason: 'the engineer decides finishes',
    });
    expect(fact.forwardedByName).toBe(f.memberUser.name);
    // the receipt names the FACT
    const receipt = await t.prisma.commandExecution.findUniqueOrThrow({ where: { projectId_id: { projectId: f.projectA.id, id: fact.sourceCommandId } } });
    expect(receipt).toMatchObject({ commandType: 'decisions.forward', status: 'succeeded', resultRef: fact.id, actorId: f.memberUser.id });
    // the holder moved with it
    expect(await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'pending', deciderKind: 'member', deciderMembershipId: eng.membershipId });
    // ONE event, naming the fact, attributed to the actor with the frozen pair, the new holder FROZEN
    const evs = await eventsOf(d.id, 'decision.forwarded');
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev).toMatchObject({ actorKind: 'human', actorId: f.memberUser.id, actorRole: 'pmc', actorName: f.memberUser.name });
    expect(ev.payload).toMatchObject({ forwardId: fact.id, title: d.title, toLabel: eng.name, from: { kind: 'client', membershipId: null }, to: { kind: 'member', membershipId: eng.membershipId } });
    expect(intent(ev).push).toMatchObject({ body: EXTERNAL_EFFECTS['decision.forwarded'].pushBody, targetUserIds: [eng.id] });
    expect(intent(ev).push?.targetUserId, 'never a scalar target beside the frozen set').toBeUndefined();
    expect(await claimOf(ev.eventId)).toMatchObject({ claimedBy: 'DecisionForward', claimedById: fact.id });
    // the audit row and the kinded notice
    expect(await t.prisma.decisionEvent.findMany({ where: { decisionId: d.id, type: 'forwarded' } })).toHaveLength(1);
    const notice = await t.prisma.notification.findFirstOrThrow({ where: { decisionId: d.id, kind: 'decision.forwarded' } });
    expect(notice).toMatchObject({ eventId: ev.eventId, text: `Decision forwarded: ${d.title} → ${eng.name}`, color: FORWARDED_DECISION_NOTICE_COLOR });
    // the forward's own push row carries the frozen set and is NOT cancelled (the test app's legacy sender
    // delivers it in the request); the displaced holder's demand is cancelled
    const fwdRow = (await pushRows(d.id, 'decision.forwarded'))[0]!;
    expect(fwdRow).toMatchObject({ deliveryAction: 'dispatch', cancelledAt: null, payload: { targetUserIds: [eng.id] } });
    expect(['pending', 'succeeded']).toContain(fwdRow.status);
    await noPendingDemand(d.id, 'decision.published');
    // the new holder sees it as theirs; the forwarded notice is served to them and to the pmc
    const mine = (await decisionsFor(engToken)).find((x) => x.id === d.id);
    expect(mine).toMatchObject({ deciderKind: 'member', deciderUserId: eng.id });
  });

  it('the HOLDER forwards on to a role: the role\'s current holders frozen as the recipients; a non-holder is refused 403 with nothing written', async () => {
    const d = await issue({ deciderKind: 'member', deciderMembershipId: eng.membershipId });
    // a bystander client is neither holder, pmc nor architect
    const refused = await forward(clientToken, d.id, { toDesignationKind: 'pmc', reason: 'not mine to hand on' });
    expect(refused.status, refused.text).toBe(403);
    expect(await t.prisma.decisionForward.count({ where: { decisionId: d.id } })).toBe(0);
    const r = await forward(engToken, d.id, { toDesignationKind: 'client', reason: 'the client should choose' });
    expect(r.status, r.text).toBe(201);
    const fact = await t.prisma.decisionForward.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(fact).toMatchObject({ fromDesignationKind: 'member', fromDesignationMembershipId: eng.membershipId, toDesignationKind: 'client', toDesignationMembershipId: null, forwardedById: eng.id, forwardedByRole: 'engineer' });
    const ev = (await eventsOf(d.id, 'decision.forwarded'))[0]!;
    expect(intent(ev).push?.targetUserIds).toContain(f.clientUser.id);
    expect(ev.payload).toMatchObject({ toLabel: 'the client' });
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).deciderKind).toBe('client');
  });

  it('refused with an answer, nothing written: the same target, a target with no active membership, a role nobody holds, a draft, a withdrawn decision, a blank reason', async () => {
    const d = await issue();
    const cases: Array<[object, number, RegExp]> = [
      [{ toDesignationKind: 'client', reason: 'same' }, 409, /already the holder/],
      [{ toDesignationKind: 'member', toDesignationMembershipId: `nope-${run}`, reason: 'gone' }, 409, /no active membership/],
      [{ toDesignationKind: 'architect', reason: 'no architect yet' }, 409, /Nobody holds the architect role/],
      [{ toDesignationKind: 'pmc', reason: '   ' }, 400, /reason/i],
      [{ toDesignationKind: 'member', reason: 'no membership named' }, 400, /toDesignationMembershipId/],
    ];
    for (const [body, status, message] of cases) {
      const r = await forward(pmcToken, d.id, body);
      expect(r.status, `${JSON.stringify(body)}: ${r.text}`).toBe(status);
      expect(JSON.stringify(r.body), JSON.stringify(body)).toMatch(message);
    }
    const draft = await issue({ publish: false });
    const rd = await forward(pmcToken, draft.id, { toDesignationKind: 'pmc', reason: 'a draft' });
    expect(rd.status, rd.text).toBe(409);
    expect(rd.body.message).toMatch(/draft/);
    const gone = await issue();
    const rw = await http().post(`/projects/${f.projectA.id}/decisions/${gone.id}/withdraw`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send({ reason: 'asked in error' });
    expect(rw.status, rw.text).toBe(201);
    const rg = await forward(pmcToken, gone.id, { toDesignationKind: 'pmc', reason: 'too late' });
    expect(rg.status, rg.text).toBe(409);
    expect(rg.body.message).toMatch(/withdrawn/);
    expect(await t.prisma.decisionForward.count({ where: { decisionId: { in: [d.id, draft.id, gone.id] } } })).toBe(0);
  });

  it('an UNKEYED forward synthesizes its receipt (the fact\'s provenance is required); a keyed retry replays the same hand-off', async () => {
    const d = await issue();
    const r = await forward(pmcToken, d.id, { toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId, reason: 'unkeyed' }, null);
    expect(r.status, r.text).toBe(201);
    const fact = await t.prisma.decisionForward.findFirstOrThrow({ where: { decisionId: d.id } });
    const receipt = await t.prisma.commandExecution.findUniqueOrThrow({ where: { projectId_id: { projectId: f.projectA.id, id: fact.sourceCommandId } } });
    expect(receipt.idempotencyKey).toMatch(/^srv-/);
    const d2 = await issue();
    const key = randomUUID();
    const first = await forward(pmcToken, d2.id, { toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId, reason: 'keyed' }, key);
    const again = await forward(pmcToken, d2.id, { toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId, reason: 'keyed' }, key);
    expect(first.status, first.text).toBe(201);
    expect(again.status, again.text).toBe(201);
    expect(await t.prisma.decisionForward.count({ where: { decisionId: d2.id } })).toBe(1);
    expect(await eventsOf(d2.id, 'decision.forwarded')).toHaveLength(1);
  });

  // ═══ THE NO-CHAIN APPROVE (P29) ═══════════════════════════════════════════════════════════════
  let approvedNoChain: { id: string; title: string };
  it('with NO chain the approve lands `approved`, `finalized = true`, the act recorded on the revision, the green notice — and the decider demand cancelled', async () => {
    const d = await issue();
    const r = await approve(clientToken, d.id);
    expect(r.status, r.text).toBe(201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('approved');
    const rev = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(rev).toMatchObject({ finalized: true, approvedFrom: 'pending', approvedByRole: 'client', approvedById: f.clientUser.id });
    expect(rev.approvedByName).toBe(f.clientUser.name);
    expect(await eventsOf(d.id, 'decision.approved')).toHaveLength(1);
    expect(await eventsOf(d.id, 'decision.awaiting_countersign')).toHaveLength(0);
    expect(await t.prisma.notification.count({ where: { decisionId: d.id, kind: 'decision.approved' } })).toBe(1);
    await noPendingDemand(d.id, 'decision.published');
    approvedNoChain = d;
  });

  /** #672 round 1 (Codex) — the approve reads the decision (its holder, the authority it judges) BEFORE
   *  `executeCommand` takes the readiness key. This device (the same as `change-control`'s) runs a PMC
   *  forward to the engineer to COMMIT while the approver's pre-read is returning: the approve then
   *  continues into its transaction judged for a holder the decision no longer carries. */
  const approveWithForwardAtPreRead = async (decisionId: string, approverToken: string, optionIndex: number) => {
    const delegate = t.prisma.decision as unknown as { findUnique: (args: { where: { id?: string } }) => Promise<unknown> };
    const original = delegate.findUnique.bind(t.prisma.decision);
    let armed = true;
    let forwarded: request.Response | null = null;
    delegate.findUnique = async (args: { where: { id?: string } }) => {
      const row = await original(args);
      if (armed && args?.where?.id === decisionId) {
        armed = false; // the forward's own pre-read passes straight through
        forwarded = await forward(pmcToken, decisionId, { toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId, reason: 'Displaced under the approve' });
      }
      return row;
    };
    try {
      const r = await approve(approverToken, decisionId, optionIndex);
      expect(forwarded, 'the forward ran at the barrier').not.toBeNull();
      expect(forwarded!.status, forwarded!.text).toBe(201);
      return r;
    } finally {
      delegate.findUnique = original;
    }
  };

  it('#672 round 1: a forward committing between the approve\'s pre-read and its readiness key DISPLACES the holder the approve was judged for — the FIRST approval refuses 409 with nothing written, and the new holder\'s approve lands', async () => {
    // a status-only CAS would land the displaced holder's approval (`pending` stays `pending` across a
    // forward) and freeze a tuple naming a holder the decision no longer carries; the CAS names the
    // holder beside the status, so the refusal is the deterministic 409, not a seal's raw error
    const d = await issue();
    const r = await approveWithForwardAtPreRead(d.id, clientToken, 0);
    expect(r.status, r.text).toBe(409);
    expect(r.body.message).toMatch(/changed while approving/);
    const row = await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: 'pending', deciderKind: 'member', deciderMembershipId: eng.membershipId, approvedDeciderKind: null });
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: d.id } })).toBe(0);
    expect(await eventsOf(d.id, 'decision.approved')).toHaveLength(0);
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: d.id, type: { in: ['approved', 'reapproved'] } } })).toBe(0);
    expect(await t.prisma.notification.count({ where: { decisionId: d.id, kind: 'decision.approved' } })).toBe(0);
    // the holder the decision NOW carries approves, and the tuple freezes them
    const ok = await approve(engToken, d.id);
    expect(ok.status, ok.text).toBe(201);
    expect(await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'approved', approvedDeciderKind: 'member', approvedDeciderMembershipId: eng.membershipId });
  });

  it('#672 round 1, the reviewer\'s exact case: a REAPPROVAL from `change` on a decision whose tuple an earlier approval FROZE — the forward committing under the displaced holder\'s reapproval makes it refuse 409 with nothing written (no seal compares a frozen tuple again)', async () => {
    const d = await issue();
    expect((await approve(clientToken, d.id, 0)).status).toBe(201); // the tuple freezes the client
    const rc = await http().post(`/projects/${f.projectA.id}/decisions/${d.id}/change`).set('Authorization', `Bearer ${clientToken}`).set('Idempotency-Key', randomUUID())
      .set('x-vitan-decisions-contract', CONTRACT).send({ reason: 'second thoughts', costImpact: 0, timeImpactDays: 0 });
    expect(rc.status, rc.text).toBe(201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('change');
    const r = await approveWithForwardAtPreRead(d.id, clientToken, 1);
    expect(r.status, r.text).toBe(409);
    expect(r.body.message).toMatch(/changed while approving/);
    const row = await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ status: 'change', deciderKind: 'member', deciderMembershipId: eng.membershipId, approvedDeciderKind: 'client' });
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: d.id } })).toBe(1);
    expect(await t.prisma.changeRequest.count({ where: { decisionId: d.id, status: 'open' } })).toBe(1);
    expect(await eventsOf(d.id, 'decision.reapproved')).toHaveLength(0);
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: d.id, type: 'reapproved' } })).toBe(0);
    // the new holder's reapproval resolves the request; the first act's tuple stays frozen
    const ok = await approve(engToken, d.id, 1);
    expect(ok.status, ok.text).toBe(201);
    expect(await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ status: 'approved', approvedDeciderKind: 'client' });
    expect(await t.prisma.changeRequest.count({ where: { decisionId: d.id, status: 'open' } })).toBe(0);
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: d.id } })).toBe(2);
  });

  // ═══ THE CHAIN: THE PROVISIONAL APPROVE (P31) ═══════════════════════════════════════════════════
  it('the FIRST architect is seated (4d-iii\'s act, rehearsed): the chain is active', async () => {
    const r = await addMember({ name: `A8a Architect ${run}`, role: 'architect', email: `a8a-arch-${run}@test.local` });
    expect(r.status, r.text).toBe(201);
    architect.id = r.body.userId; architect.membershipId = r.body.membershipId;
    createdUserIds.push(architect.id);
    architectToken = t.issueProjectToken(architect.id, f.projectA.id, 'architect');
    expect((await decisionsFor(pmcToken)).every((x) => x.countersignRequired === true)).toBe(true);
  });

  let awaiting: { id: string; title: string };
  it('under an ACTIVE chain the approve lands `awaiting_countersign`: the tuple written, the revision born PROVISIONAL with the act, exactly ONE countersign demand naming it to the architects frozen, NO approval event, the audit row, the provisional notice, the claim', async () => {
    const d = await issue();
    const r = await approve(clientToken, d.id);
    expect(r.status, r.text).toBe(201);
    const row = await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } });
    // the approval columns carry the provisional outcome and the frozen holder TUPLE is written as the
    // finalizing act would write it (4d-i's widened seal arm; the CHECK widened by A8a's migration)
    expect(row).toMatchObject({ status: 'awaiting_countersign', approvedOption: 'Option A', material: 'Granite', approvedDeciderKind: 'client', approvedDeciderLabel: 'Client', approvedById: f.clientUser.id });
    const rev = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(rev).toMatchObject({ finalized: false, approvedFrom: 'pending', approvedByRole: 'client', approvedById: f.clientUser.id, version: 1 });
    expect(rev.approvedByName).toBe(f.clientUser.name);
    const evs = await eventsOf(d.id, 'decision.awaiting_countersign');
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev).toMatchObject({ actorKind: 'human', actorId: f.clientUser.id, actorRole: 'client' });
    expect(ev.payload).toMatchObject({ revisionId: rev.id, approvedFrom: 'pending', approverRole: 'client', title: d.title, deciderKind: 'client', option: 'Option A' });
    expect(intent(ev).push).toEqual({ body: EXTERNAL_EFFECTS['decision.awaiting_countersign'].pushBody, roles: ['architect'], targetUserIds: [architect.id] });
    expect(await claimOf(ev.eventId)).toMatchObject({ claimedBy: 'DecisionApprovalRevision', claimedById: rev.id });
    expect(await eventsOf(d.id, 'decision.approved'), 'never an approval event before the countersign').toHaveLength(0);
    expect((await t.prisma.decisionEvent.findMany({ where: { decisionId: d.id, type: { in: ['approved', 'reapproved'] } } })).map((a) => a.type)).toEqual(['approved']);
    const notice = await t.prisma.notification.findFirstOrThrow({ where: { decisionId: d.id, kind: 'decision.awaiting_countersign' } });
    expect(notice).toMatchObject({ eventId: ev.eventId, color: AWAITING_COUNTERSIGN_NOTICE_COLOR });
    expect(notice.text).toBe(`Client approved ${d.title} — Granite — awaiting the architect's countersign`);
    expect(await t.prisma.notification.count({ where: { decisionId: d.id, kind: { in: ['decision.approved', 'decision.reapproved'] } } })).toBe(0);
    // the demand's push row stands with the frozen set; the decider demand is cancelled
    const demandRow = (await pushRows(d.id, 'decision.awaiting_countersign'))[0]!;
    expect(demandRow).toMatchObject({ deliveryAction: 'dispatch', cancelledAt: null, payload: { targetUserIds: [architect.id] } });
    expect(['pending', 'succeeded']).toContain(demandRow.status);
    await noPendingDemand(d.id, 'decision.published');
    expect(await query.countersignPushTarget(f.projectA.id, d.id)).toEqual({ actionable: true, targetUserIds: [architect.id] });
    awaiting = d;
  });

  it('the awaiting decision is served to the pmc, the decider and the architect, not to a bystander; it refuses a second approve and a generic forward', async () => {
    expect((await decisionsFor(architectToken)).find((x) => x.id === awaiting.id)).toMatchObject({ status: 'awaiting_countersign', countersignRequired: true });
    expect((await decisionsFor(clientToken)).find((x) => x.id === awaiting.id)?.status).toBe('awaiting_countersign');
    expect((await decisionsFor(pmcToken)).find((x) => x.id === awaiting.id)?.status).toBe('awaiting_countersign');
    expect((await decisionsFor(engToken)).find((x) => x.id === awaiting.id), 'a bystander engineer').toBeUndefined();
    const ra = await approve(clientToken, awaiting.id);
    expect(ra.status, ra.text).toBe(409);
    expect(ra.body.message).toMatch(/awaiting the architect's countersign/);
    const rf = await forward(pmcToken, awaiting.id, { toDesignationKind: 'pmc', reason: 'take it back' });
    expect(rf.status, rf.text).toBe(409);
    expect(rf.body.message).toMatch(/architect's action item/);
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: awaiting.id } })).toBe(1);
    expect(await t.prisma.decisionForward.count({ where: { decisionId: awaiting.id } })).toBe(0);
  });

  it('the chain REAPPROVAL: a decision approved before the chain, reopened, is approved again into `awaiting_countersign` with `approvedFrom = change`, the request resolved, the `reapproved` audit row and ONE demand', async () => {
    const d = approvedNoChain;
    const rc = await http().post(`/projects/${f.projectA.id}/decisions/${d.id}/change`).set('Authorization', `Bearer ${clientToken}`).set('Idempotency-Key', randomUUID())
      .set('x-vitan-decisions-contract', CONTRACT).send({ reason: 'second thoughts', costImpact: 0, timeImpactDays: 0 });
    expect(rc.status, rc.text).toBe(201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('change');
    const r = await approve(clientToken, d.id, 1);
    expect(r.status, r.text).toBe(201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('awaiting_countersign');
    const head = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId: d.id }, orderBy: { version: 'desc' } });
    expect(head).toMatchObject({ version: 2, finalized: false, approvedFrom: 'change', optionKey: 'b' });
    expect(await t.prisma.changeRequest.findMany({ where: { decisionId: d.id, status: 'open' } })).toHaveLength(0);
    expect((await t.prisma.decisionEvent.findMany({ where: { decisionId: d.id, type: { in: ['approved', 'reapproved'] } }, orderBy: { id: 'asc' } })).map((a) => a.type)).toEqual(['approved', 'reapproved']);
    const evs = await eventsOf(d.id, 'decision.awaiting_countersign');
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toMatchObject({ revisionId: head.id, approvedFrom: 'change' });
    expect(await eventsOf(d.id, 'decision.reapproved')).toHaveLength(0);
    expect(await t.prisma.notification.count({ where: { decisionId: d.id, kind: 'decision.awaiting_countersign' } })).toBe(1);
  });

  it('a forward to the ARCHITECT role under the chain freezes the architect as the recipient and re-homes the decision to the role', async () => {
    const d = await issue();
    const r = await forward(pmcToken, d.id, { toDesignationKind: 'architect', reason: 'the architect decides' });
    expect(r.status, r.text).toBe(201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).deciderKind).toBe('architect');
    const ev = (await eventsOf(d.id, 'decision.forwarded'))[0]!;
    expect(intent(ev).push?.targetUserIds).toEqual([architect.id]);
    expect(ev.payload).toMatchObject({ toLabel: 'the architect' });
    // the architect, now the holder, sees it and may hand it on
    expect((await decisionsFor(architectToken)).find((x) => x.id === d.id)).toMatchObject({ deciderKind: 'architect' });
    const back = await forward(architectToken, d.id, { toDesignationKind: 'client', reason: 'the client should choose after all' });
    expect(back.status, back.text).toBe(201);
    expect(await t.prisma.decisionForward.count({ where: { decisionId: d.id } })).toBe(2);
  });
});
