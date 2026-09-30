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
import { APPROVED_DECISION_NOTICE_COLOR, CHANGE_REQUESTED_NOTICE_COLOR, FORWARDED_DECISION_NOTICE_COLOR } from '../../src/domain/notifications';

/**
 * Phase 6 task 4d unit 4d-ii-a / A8b — THE CHAIN'S THREE REMAINING WRITERS, driven live through the shipped
 * routes (plan §A.2 "Countersign, and the state that carries it", "Disagreement — the `change` state's OWN
 * machinery honoured", "The stranded decision, resolved by a NAMED command"; §A.3 obligations 6 and 7;
 * §C P25d, P29b, P31, P32, P33, P36, P41; the staging note's A8b row).
 *
 * The doors 4d-i installs and 4d-iii drops are DROPPED for this suite (captured from the catalog and
 * re-created after), exactly as A8a's suite drops them: every chain shape proven here is one they reserve.
 * Every seal that is not a door stays on: the bundles below commit THROUGH `phase6_t4d_countersign_seal` /
 * `_paired`, `_stranded_seal` / `_paired`, `_revision_flip_paired`, `_disagreement_paired`,
 * `_change_transition_paired`, `_forward_seal` / `_paired`, `_provenance_bound` (re-issued by A8b's
 * migration with the returned request's second producer), A8b's two finalizer claimants, the request's
 * claimant and the correspondence seal — or they do not commit at all.
 *
 * What is proven:
 *   - the countersign (P31): the fact naming the EXACT head revision, the head's finality flip, the
 *     `awaiting_countersign → approved` landing, the `countersigned` audit row beside the provisional act's,
 *     exactly ONE `decision.approved` in the architect's name naming the revision and the fact with the
 *     approver's frozen pair, the fact's claim, the green notice naming both parties, the demands it outdates
 *     cancelled; the reapproval sequence announcing `decision.reapproved` by the revision's RECORDED
 *     `approvedFrom`; the self-countersign as two acts under two keys (P32); refusals (a non-architect, a
 *     decision not awaiting, a second countersign); the unkeyed receipt and the keyed replay;
 *   - the disagreement (P33): REJECT BACK leaves the holder, lands `change` with the open
 *     `countersign_rejection` request citing the head, ONE `decision.change_requested`, the request's claim,
 *     the ordinary withdrawal REFUSED, the re-approval running the chain again; FORWARD ON re-homes the
 *     decision through the SAME forward door in the SAME bundle (the fact, the `decision.forwarded` with the
 *     new holder frozen, its notice) and the new holder re-approves; refusals with nothing written;
 *   - consultation beside the countersign (P41 / P25d): a question asked while awaiting is closed by the
 *     countersign (the late answer refused, the open invitation cancelled); an answer given before the
 *     countersign stands;
 *   - the stranded resolution (P29b, P36): refused 409 while an architect is active; the LAST architect
 *     leaving deactivates the chain and strands the awaiting decisions; `completed` finalizes under the
 *     no-chain rule (the fact, the flip, `decision.approved` in the PMC's name with `finalization =
 *     stranded_completed`, the fact's claim, the notice); `returned` reopens with the request (the RESOLUTION
 *     claims the `decision.change_requested`; the request verifies) and the re-approval lands `approved`
 *     directly; a designation with NO active holder (the departed architect's role; the departed named
 *     member) REQUIRES a target (400 without) and is re-homed in the bundle; a re-seated architect makes
 *     the resolution illegal again (409) and the new architect countersigns.
 */
describe('4d-ii-a / A8b — countersign, disagree, stranded: the chain\'s three remaining writers (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let query: DecisionsQueryService;
  let pmcToken: string;
  let clientToken: string;
  let engToken: string;
  let architectToken: string;
  const run = randomUUID().slice(0, 8);
  let doorDefs: Array<{ tgname: string; def: string }> = [];
  const eng = { id: '', membershipId: '', name: '' };
  const architect = { id: '', membershipId: '', name: '' };
  const architect2 = { id: '', membershipId: '', name: '' };
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    query = t.app.get(DecisionsQueryService);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    doorDefs = await t.prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
      [...PHASE6_4D_RESERVATION_DOORS],
    );
    expect(doorDefs.map((d) => d.tgname)).toEqual([...PHASE6_4D_RESERVATION_DOORS].sort());
    for (const d of doorDefs) await dropDoor(d);
    const r = await addMember({ name: `A8b Engineer ${run}`, role: 'engineer', email: `a8b-eng-${run}@test.local` });
    expect(r.status, r.text).toBe(201);
    eng.id = r.body.userId; eng.membershipId = r.body.membershipId; eng.name = `A8b Engineer ${run}`;
    createdUserIds.push(eng.id);
    engToken = t.issueProjectToken(eng.id, f.projectA.id, 'engineer');
    // the FIRST architect is seated (4d-iii's act, rehearsed): the chain is active for the suite's first half
    const a = await addMember({ name: `A8b Architect ${run}`, role: 'architect', email: `a8b-arch-${run}@test.local` });
    expect(a.status, a.text).toBe(201);
    architect.id = a.body.userId; architect.membershipId = a.body.membershipId; architect.name = `A8b Architect ${run}`;
    createdUserIds.push(architect.id);
    architectToken = t.issueProjectToken(architect.id, f.projectA.id, 'architect');
  });

  afterAll(async () => {
    const projectId = f?.projectA.id;
    try {
      if (t?.prisma && projectId) {
        await wipeDecisionEvents(t.prisma, { decision: { projectId } });
        await sanctionedReset(t.prisma, [
          'Notification', 'DecisionCountersign', 'DecisionStrandedResolution', 'DecisionApprovalRevision', 'ChangeRequest',
          'DecisionConsultationResponse', 'DecisionConsultation',
          'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'CommandExecution',
          'DecisionProjection', 'ProjectionGeneration', 'DomainEventPairingClaim',
        ], { cascade: true });
        await wipeDecisionsVia(t.prisma, async (tx) => {
          await tx.decisionForward.deleteMany({ where: { projectId } });
          await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
          await tx.decision.deleteMany({ where: { projectId } });
        });
        // an ACTIVE architect membership is a standing the seals let only an attributable act end
        for (const who of [architect, architect2]) {
          if (who.id && (await t.prisma.membership.count({ where: { userId: who.id, status: 'active' } })) > 0) {
            await removeMember(who.id);
          }
        }
        await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'CommandExecution', 'DomainEventPairingClaim'], { cascade: true });
        const provisioned = await t.prisma.user.findMany({ where: { email: { startsWith: 'a8b-', endsWith: `-${run}@test.local` } }, select: { id: true } });
        const ids = [...new Set([...createdUserIds, ...provisioned.map((u) => u.id)])];
        await wipeMembershipTransitionsVia(t.prisma, [...ids, f.memberUser.id]);
        await t.prisma.membership.deleteMany({ where: { userId: { in: ids } } });
        await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorUserId: { in: ids } }] } });
        await t.prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    } catch (e) {
      console.error('A8b teardown failed before the fixture cleanup:', e);
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
  const decisions = () => `/projects/${f.projectA.id}/decisions`;
  const post = (token: string, path: string, body: object, key: string | null = randomUUID()) => {
    const req = http().post(`${decisions()}${path}`).set('Authorization', `Bearer ${token}`).set('x-vitan-decisions-contract', CONTRACT);
    return (key === null ? req : req.set('Idempotency-Key', key)).send(body);
  };
  const issue = async (over: object = {}): Promise<{ id: string; title: string }> => {
    const title = `A8b ${randomUUID().slice(0, 8)}`;
    const r = await post(pmcToken, '', { title, room: 'Kitchen', publish: true, options: OPTIONS, ...over });
    expect(r.status, r.text).toBe(201);
    return { id: (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id, title };
  };
  const approve = (token: string, id: string, optionIndex = 0) => post(token, `/${id}/approve`, { optionIndex });
  const forward = (token: string, id: string, body: object) => post(token, `/${id}/forward`, body);
  const countersign = (token: string, id: string, key: string | null = randomUUID()) => post(token, `/${id}/countersign`, {}, key);
  const disagree = (token: string, id: string, body: object) => post(token, `/${id}/disagree`, body);
  const stranded = (token: string, id: string, body: object) => post(token, `/${id}/stranded`, body);
  const change = (token: string, id: string) => post(token, `/${id}/change`, { reason: 'second thoughts', costImpact: 0, timeImpactDays: 0 });
  const withdrawChange = (token: string, id: string) => post(token, `/${id}/change/withdraw`, {});
  const consult = (token: string, id: string, consulteeMembershipId: string) => post(token, `/${id}/consultations`, { consulteeMembershipId, question: 'Which finish?' });
  const respond = (token: string, id: string, consultationId: string) => post(token, `/${id}/consultations/respond`, { consultationId, response: 'Granite, for the wear' });
  /** a decision parked `awaiting_countersign` by the holder's approval under the active chain */
  const park = async (token = clientToken, over: object = {}, optionIndex = 0) => {
    const d = await issue(over);
    const r = await approve(token, d.id, optionIndex);
    expect(r.status, r.text).toBe(201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('awaiting_countersign');
    return d;
  };
  const decisionsFor = async (token: string) => {
    const r = await http().get(decisions()).set('Authorization', `Bearer ${token}`).set('x-vitan-decisions-contract', CONTRACT);
    expect(r.status, r.text).toBe(200);
    return r.body.decisions as Array<{ id: string; status: string; deciderKind: string; deciderUserId?: string; countersignRequired?: true }>;
  };
  const row = (id: string) => t.prisma.decision.findUniqueOrThrow({ where: { id } });
  const head = (id: string) => t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId: id }, orderBy: { version: 'desc' } });
  const eventsOf = (id: string, type: string) => t.prisma.domainEvent.findMany({ where: { projectId: f.projectA.id, entityType: 'Decision', entityId: id, eventType: type }, orderBy: { streamPosition: 'asc' } });
  const audits = async (id: string) => (await t.prisma.decisionEvent.findMany({ where: { decisionId: id }, orderBy: { id: 'asc' } })).map((a) => a.type).filter((k) => k !== 'issued');
  const pushRows = (id: string, type: string) => t.prisma.outboxDelivery.findMany({
    where: { consumer: PUSH_CONSUMER, projectId: f.projectA.id, subject: id, event: { is: { eventType: type } } }, orderBy: { id: 'asc' },
  });
  const claimOf = (eventId: string) => t.prisma.domainEventPairingClaim.findFirst({ where: { eventId } });
  const intent = (e: { dispatchIntent: unknown }) => e.dispatchIntent as { push?: { body?: string; targetUserId?: string; targetUserIds?: string[]; roles?: string[] } };
  const receiptOf = (commandId: string) => t.prisma.commandExecution.findUniqueOrThrow({ where: { projectId_id: { projectId: f.projectA.id, id: commandId } } });
  const noPendingDemand = async (id: string, type: string) => {
    for (const r of await pushRows(id, type)) expect(r.status === 'pending' && r.cancelledAt === null, `${type} delivery ${r.id} still pending`).toBe(false);
  };
  const nothingFinalized = async (id: string) => {
    expect(await t.prisma.decisionCountersign.count({ where: { decisionId: id } })).toBe(0);
    expect(await t.prisma.decisionStrandedResolution.count({ where: { decisionId: id } })).toBe(0);
    expect(await t.prisma.changeRequest.count({ where: { decisionId: id, origin: 'countersign_rejection' } })).toBe(0);
  };

  // ═══ THE COUNTERSIGN (P31) ═════════════════════════════════════════════════════════════════════
  it('the architect countersigns a client-approved decision: the fact naming the EXACT head, the flip, `approved`, the `countersigned` audit row beside the provisional act\'s, ONE `decision.approved` in the architect\'s name naming the revision and the fact, the claim, the green notice naming both parties, the demand cancelled', async () => {
    const d = await park();
    const provisional = await head(d.id);
    expect(provisional).toMatchObject({ finalized: false, approvedFrom: 'pending', approvedByRole: 'client', version: 1 });
    const r = await countersign(architectToken, d.id);
    expect(r.status, r.text).toBe(201);

    expect((await row(d.id)).status).toBe('approved');
    const rev = await head(d.id);
    expect(rev).toMatchObject({ id: provisional.id, finalized: true, approvedFrom: 'pending', approvedById: f.clientUser.id, version: 1 });
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: d.id } }), 'the countersign writes no revision').toBe(1);
    const fact = await t.prisma.decisionCountersign.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(fact).toMatchObject({ projectId: f.projectA.id, revisionId: provisional.id, countersignedById: architect.id, countersignedByRole: 'architect', countersignedByName: architect.name });
    const receipt = await receiptOf(fact.sourceCommandId);
    expect(receipt).toMatchObject({ commandType: 'decisions.countersign', status: 'succeeded', resultRef: fact.id, actorId: architect.id });
    // exactly ONE finalizing event, in the ARCHITECT's name, naming the revision and the fact, with the approver's frozen pair
    const evs = await eventsOf(d.id, 'decision.approved');
    expect(evs).toHaveLength(1);
    const ev = evs[0]!;
    expect(ev).toMatchObject({ actorKind: 'human', actorId: architect.id, actorRole: 'architect', actorName: architect.name });
    expect(ev.payload).toMatchObject({
      revisionId: provisional.id, countersignId: fact.id, finalization: 'countersign', approvedFrom: 'pending',
      approverName: f.clientUser.name, approverRole: 'client', option: 'Option A', material: 'Granite', title: d.title, deciderKind: 'client',
    });
    expect(await eventsOf(d.id, 'decision.reapproved')).toHaveLength(0);
    expect(await claimOf(ev.eventId)).toMatchObject({ claimedBy: 'DecisionCountersign', claimedById: fact.id });
    expect(await audits(d.id)).toEqual(['approved', 'countersigned']);
    const audit = await t.prisma.decisionEvent.findFirstOrThrow({ where: { decisionId: d.id, type: 'countersigned' } });
    expect(audit).toMatchObject({ actorId: architect.id, actorRole: 'architect' });
    expect(audit.payload).toMatchObject({ countersignId: fact.id, revisionId: provisional.id });
    // the green notice names the approver from the revision's FROZEN pair and the countersigner distinctly
    const text = `Client approved ${d.title} — Granite — countersigned by ${architect.name}`;
    const notice = await t.prisma.notification.findFirstOrThrow({ where: { decisionId: d.id, kind: 'decision.approved' } });
    expect(notice).toMatchObject({ eventId: ev.eventId, text, color: APPROVED_DECISION_NOTICE_COLOR });
    expect(intent(ev).push?.body).toBe(text);
    expect(await t.prisma.notification.count({ where: { decisionId: d.id, kind: 'decision.awaiting_countersign' } })).toBe(1);
    // the countersign demand is answered: no pending demand survives, and the push target is no longer actionable
    await noPendingDemand(d.id, 'decision.awaiting_countersign');
    expect(await query.countersignPushTarget(f.projectA.id, d.id)).toEqual({ actionable: false });
    expect((await decisionsFor(architectToken)).find((x) => x.id === d.id)?.status).toBe('approved');
    expect((await decisionsFor(clientToken)).find((x) => x.id === d.id)?.status).toBe('approved');
  });

  it('refused with nothing written: the PMC and the client (403), a pending decision, a finalized decision, a second countersign (409)', async () => {
    const d = await park();
    for (const [who, token] of [['pmc', pmcToken], ['client', clientToken], ['engineer', engToken]] as const) {
      const r = await countersign(token, d.id);
      expect(r.status, `${who}: ${r.text}`).toBe(403);
    }
    await nothingFinalized(d.id);
    expect((await row(d.id)).status).toBe('awaiting_countersign');
    const pending = await issue();
    const rp = await countersign(architectToken, pending.id);
    expect(rp.status, rp.text).toBe(409);
    expect(rp.body.message).toMatch(/not awaiting its countersign/);
    const ok = await countersign(architectToken, d.id);
    expect(ok.status, ok.text).toBe(201);
    const again = await countersign(architectToken, d.id);
    expect(again.status, again.text).toBe(409);
    expect(again.body.message).toMatch(/is approved, not awaiting/);
    expect(await t.prisma.decisionCountersign.count({ where: { decisionId: d.id } })).toBe(1);
    expect(await eventsOf(d.id, 'decision.approved')).toHaveLength(1);
  });

  it('an UNKEYED countersign synthesizes its receipt (the fact\'s provenance is required); a keyed retry replays the same act', async () => {
    const d = await park();
    const r = await countersign(architectToken, d.id, null);
    expect(r.status, r.text).toBe(201);
    const fact = await t.prisma.decisionCountersign.findFirstOrThrow({ where: { decisionId: d.id } });
    expect((await receiptOf(fact.sourceCommandId)).idempotencyKey).toMatch(/^srv-/);
    const d2 = await park();
    const key = randomUUID();
    const first = await countersign(architectToken, d2.id, key);
    const second = await countersign(architectToken, d2.id, key);
    expect(first.status, first.text).toBe(201);
    expect(second.status, second.text).toBe(201);
    expect(await t.prisma.decisionCountersign.count({ where: { decisionId: d2.id } })).toBe(1);
    expect(await eventsOf(d2.id, 'decision.approved')).toHaveLength(1);
  });

  it('the SELF-countersign (P32): the architect, holding the decision, approves under one key and countersigns under another — two receipts, two acts, the approver AND the countersigner the same frozen person', async () => {
    const d = await issue();
    const rf = await forward(pmcToken, d.id, { toDesignationKind: 'architect', reason: 'the architect decides' });
    expect(rf.status, rf.text).toBe(201);
    const ra = await approve(architectToken, d.id);
    expect(ra.status, ra.text).toBe(201);
    const provisional = await head(d.id);
    expect(provisional).toMatchObject({ finalized: false, approvedByRole: 'architect', approvedById: architect.id });
    expect((await row(d.id)).status).toBe('awaiting_countersign');
    const rc = await countersign(architectToken, d.id);
    expect(rc.status, rc.text).toBe(201);
    expect((await row(d.id)).status).toBe('approved');
    const fact = await t.prisma.decisionCountersign.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(fact.revisionId).toBe(provisional.id);
    expect(fact.sourceCommandId).not.toBe(provisional.sourceCommandId);
    expect((await receiptOf(provisional.sourceCommandId!)).commandType).toBe('decisions.approve');
    expect((await receiptOf(fact.sourceCommandId)).commandType).toBe('decisions.countersign');
    const ev = (await eventsOf(d.id, 'decision.approved'))[0]!;
    expect(ev.payload).toMatchObject({ approverRole: 'architect', approverName: architect.name, finalization: 'countersign', deciderKind: 'architect' });
    const notice = await t.prisma.notification.findFirstOrThrow({ where: { decisionId: d.id, kind: 'decision.approved' } });
    expect(notice.text).toBe(`${architect.name} approved ${d.title} — Granite — countersigned by ${architect.name}`);
  });

  it('the REAPPROVAL sequence: a countersigned decision reopened by the ordinary request, re-approved into awaiting with `approvedFrom = change`, is countersigned as `decision.reapproved` — the family the revision RECORDED, never the first act\'s', async () => {
    const d = await park();
    expect((await countersign(architectToken, d.id)).status).toBe(201);
    const rc = await change(clientToken, d.id);
    expect(rc.status, rc.text).toBe(201);
    expect((await row(d.id)).status).toBe('change');
    const ra = await approve(clientToken, d.id, 1);
    expect(ra.status, ra.text).toBe(201);
    const second = await head(d.id);
    expect(second).toMatchObject({ version: 2, finalized: false, approvedFrom: 'change', optionKey: 'b' });
    expect(await t.prisma.changeRequest.count({ where: { decisionId: d.id, status: 'open' } })).toBe(0);
    const r = await countersign(architectToken, d.id);
    expect(r.status, r.text).toBe(201);
    expect((await row(d.id)).status).toBe('approved');
    expect((await head(d.id))).toMatchObject({ id: second.id, finalized: true });
    const facts = await t.prisma.decisionCountersign.findMany({ where: { decisionId: d.id }, orderBy: { at: 'asc' } });
    expect(facts.map((x) => x.revisionId)).toEqual([(await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId: d.id, version: 1 } })).id, second.id]);
    const re = await eventsOf(d.id, 'decision.reapproved');
    expect(re).toHaveLength(1);
    expect(re[0]!).toMatchObject({ actorId: architect.id, actorRole: 'architect' });
    expect(re[0]!.payload).toMatchObject({ revisionId: second.id, countersignId: facts[1]!.id, approvedFrom: 'change', finalization: 'countersign', option: 'Option B', material: 'Quartz' });
    expect(await eventsOf(d.id, 'decision.approved'), 'the first act\'s family is announced once').toHaveLength(1);
    expect(await claimOf(re[0]!.eventId)).toMatchObject({ claimedBy: 'DecisionCountersign', claimedById: facts[1]!.id });
    expect(await audits(d.id)).toEqual(['approved', 'countersigned', 'change_requested', 'reapproved', 'countersigned']);
    const notice = await t.prisma.notification.findFirstOrThrow({ where: { decisionId: d.id, kind: 'decision.reapproved' } });
    expect(notice.text).toBe(`Client approved ${d.title} — Quartz — countersigned by ${architect.name}`);
  });

  // ═══ THE DISAGREEMENT (P33) ════════════════════════════════════════════════════════════════════
  it('REJECT BACK: the holder stays, the decision lands `change` with the open `countersign_rejection` request citing the head, ONE `decision.change_requested` in the architect\'s name, the request\'s claim, the audit row, the demand cancelled; the ordinary withdrawal is REFUSED; the re-approval runs the chain again', async () => {
    const d = await park();
    const provisional = await head(d.id);
    const r = await disagree(architectToken, d.id, { path: 'reject_back', reason: 'the wear rating is wrong for a kitchen', costImpact: 0, timeImpactDays: 0 });
    expect(r.status, r.text).toBe(201);

    expect(await row(d.id)).toMatchObject({ status: 'change', deciderKind: 'client', deciderMembershipId: null });
    expect((await head(d.id))).toMatchObject({ id: provisional.id, finalized: false });
    const req = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(req).toMatchObject({
      status: 'open', origin: 'countersign_rejection', revisionId: provisional.id, reason: 'the wear rating is wrong for a kitchen',
      requestedById: architect.id, requestedByRole: 'architect', requestedByName: architect.name,
    });
    const receipt = await receiptOf(req.sourceCommandId!);
    expect(receipt).toMatchObject({ commandType: 'decisions.disagree', status: 'succeeded', resultRef: req.id, actorId: architect.id });
    const evs = await eventsOf(d.id, 'decision.change_requested');
    expect(evs).toHaveLength(1);
    expect(evs[0]!).toMatchObject({ actorId: architect.id, actorRole: 'architect', actorName: architect.name });
    expect(evs[0]!.payload).toMatchObject({ path: 'reject_back', origin: 'countersign_rejection', revisionId: provisional.id, requestId: req.id, title: d.title });
    expect(await claimOf(evs[0]!.eventId)).toMatchObject({ claimedBy: 'ChangeRequest', claimedById: req.id });
    // the change-request notice (#673 round 1), bound to the event, the reason frozen on it
    const notice = await t.prisma.notification.findFirstOrThrow({ where: { decisionId: d.id, kind: 'decision.change_requested' } });
    expect(notice).toMatchObject({ eventId: evs[0]!.eventId, text: `Change requested: ${d.title} — the wear rating is wrong for a kitchen`, color: CHANGE_REQUESTED_NOTICE_COLOR });
    expect(await eventsOf(d.id, 'decision.forwarded')).toHaveLength(0);
    expect(await t.prisma.decisionForward.count({ where: { decisionId: d.id } })).toBe(0);
    expect(await audits(d.id)).toEqual(['approved', 'change_requested']);
    await noPendingDemand(d.id, 'decision.awaiting_countersign');
    expect(await query.countersignPushTarget(f.projectA.id, d.id)).toEqual({ actionable: false });
    // the request's ONLY closure is the re-approval: the ordinary withdrawal is refused
    // (the withdrawal is the requester's or the PMC's act — the PMC tries and is refused on the origin)
    const rw = await withdrawChange(pmcToken, d.id);
    expect(rw.status, rw.text).toBe(409);
    expect(rw.body.message).toMatch(/countersign rejection — it cannot be withdrawn/);
    expect((await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('open');
    // the decider answers by re-approving: the chain runs again from `change`
    const ra = await approve(clientToken, d.id, 1);
    expect(ra.status, ra.text).toBe(201);
    expect((await row(d.id)).status).toBe('awaiting_countersign');
    expect(await head(d.id)).toMatchObject({ version: 2, finalized: false, approvedFrom: 'change' });
    expect((await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: req.id } })).status).not.toBe('open');
    const rc = await countersign(architectToken, d.id);
    expect(rc.status, rc.text).toBe(201);
    expect((await row(d.id)).status).toBe('approved');
    expect(await eventsOf(d.id, 'decision.reapproved')).toHaveLength(1);
  });

  it('FORWARD ON: the decision is re-homed through the SAME forward door in the SAME bundle — the fact from the displaced holder, the `decision.forwarded` with the new holder frozen and its notice, the request opened, both claims — and the new holder re-approves', async () => {
    const d = await park();
    const provisional = await head(d.id);
    const r = await disagree(architectToken, d.id, { path: 'forward_on', toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId, reason: 'the engineer should decide this one' });
    expect(r.status, r.text).toBe(201);

    expect(await row(d.id)).toMatchObject({ status: 'change', deciderKind: 'member', deciderMembershipId: eng.membershipId });
    const req = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(req).toMatchObject({ status: 'open', origin: 'countersign_rejection', revisionId: provisional.id, requestedById: architect.id, requestedByRole: 'architect' });
    const fwd = await t.prisma.decisionForward.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(fwd).toMatchObject({
      fromDesignationKind: 'client', fromDesignationMembershipId: null, toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId,
      forwardedById: architect.id, forwardedByRole: 'architect', forwardedByName: architect.name, reason: 'the engineer should decide this one',
      sourceCommandId: req.sourceCommandId,
    });
    expect((await receiptOf(req.sourceCommandId!)).resultRef).toBe(req.id);
    const cr = await eventsOf(d.id, 'decision.change_requested');
    expect(cr).toHaveLength(1);
    expect(cr[0]!.payload).toMatchObject({ path: 'forward_on', requestId: req.id, revisionId: provisional.id });
    expect(await claimOf(cr[0]!.eventId)).toMatchObject({ claimedBy: 'ChangeRequest', claimedById: req.id });
    expect(await t.prisma.notification.findFirstOrThrow({ where: { decisionId: d.id, kind: 'decision.change_requested' } }))
      .toMatchObject({ eventId: cr[0]!.eventId, text: `Change requested: ${d.title} — the engineer should decide this one` });
    const fw = await eventsOf(d.id, 'decision.forwarded');
    expect(fw).toHaveLength(1);
    expect(fw[0]!).toMatchObject({ actorId: architect.id, actorRole: 'architect' });
    expect(fw[0]!.payload).toMatchObject({ forwardId: fwd.id, title: d.title, toLabel: eng.name, from: { kind: 'client', membershipId: null }, to: { kind: 'member', membershipId: eng.membershipId } });
    expect(intent(fw[0]!).push).toMatchObject({ body: EXTERNAL_EFFECTS['decision.forwarded'].pushBody, targetUserIds: [eng.id] });
    expect(await claimOf(fw[0]!.eventId)).toMatchObject({ claimedBy: 'DecisionForward', claimedById: fwd.id });
    expect(await audits(d.id)).toEqual(['approved', 'change_requested', 'forwarded']);
    const notice = await t.prisma.notification.findFirstOrThrow({ where: { decisionId: d.id, kind: 'decision.forwarded' } });
    expect(notice).toMatchObject({ eventId: fw[0]!.eventId, text: `Decision forwarded: ${d.title} → ${eng.name}`, color: FORWARDED_DECISION_NOTICE_COLOR });
    await noPendingDemand(d.id, 'decision.awaiting_countersign');
    // the new holder sees it as theirs and answers by re-approving; the chain runs again
    expect((await decisionsFor(engToken)).find((x) => x.id === d.id)).toMatchObject({ status: 'change', deciderKind: 'member', deciderUserId: eng.id });
    const ra = await approve(engToken, d.id, 1);
    expect(ra.status, ra.text).toBe(201);
    expect((await row(d.id)).status).toBe('awaiting_countersign');
    expect(await head(d.id)).toMatchObject({ version: 2, approvedFrom: 'change', approvedById: eng.id });
    expect((await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: req.id } })).status).not.toBe('open');
  });

  it('refused with an answer, nothing written: a forward-on naming the current holder, a member target without its membership, a target on reject-back, a blank reason, a decision not awaiting, a non-architect', async () => {
    const d = await park();
    const cases: Array<[object, number, RegExp]> = [
      [{ path: 'forward_on', toDesignationKind: 'client', reason: 'same' }, 409, /already the holder/],
      [{ path: 'forward_on', toDesignationKind: 'member', reason: 'no membership' }, 400, /toDesignationMembershipId/],
      [{ path: 'reject_back', toDesignationKind: 'pmc', reason: 'a target on reject-back' }, 400, /toDesignationKind/],
      [{ path: 'reject_back', reason: '   ' }, 400, /reason/i],
      [{ path: 'forward_on', toDesignationKind: 'member', toDesignationMembershipId: `nope-${run}`, reason: 'gone' }, 409, /no active membership/],
    ];
    for (const [body, status, message] of cases) {
      const r = await disagree(architectToken, d.id, body);
      expect(r.status, `${JSON.stringify(body)}: ${r.text}`).toBe(status);
      expect(JSON.stringify(r.body), JSON.stringify(body)).toMatch(message);
    }
    const rp = await disagree(pmcToken, d.id, { path: 'reject_back', reason: 'not mine' });
    expect(rp.status, rp.text).toBe(403);
    const pending = await issue();
    const rn = await disagree(architectToken, pending.id, { path: 'reject_back', reason: 'nothing to disagree with' });
    expect(rn.status, rn.text).toBe(409);
    expect(rn.body.message).toMatch(/not awaiting its countersign/);
    await nothingFinalized(d.id);
    await nothingFinalized(pending.id);
    expect(await t.prisma.decisionForward.count({ where: { decisionId: { in: [d.id, pending.id] } } })).toBe(0);
    expect((await row(d.id)).status).toBe('awaiting_countersign');
  });

  // ═══ CONSULTATION BESIDE THE COUNTERSIGN (P41 / P25d) ══════════════════════════════════════════
  it('a question asked while the decision awaits its countersign is CLOSED by the countersign: the late answer is refused, the open invitation cancelled; an answer given before the countersign stands', async () => {
    // ordering 1: ask → countersign → answer (refused)
    const d = await park();
    const rq = await consult(pmcToken, d.id, eng.membershipId);
    expect(rq.status, rq.text).toBe(201);
    const q = await t.prisma.decisionConsultation.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(q.openCycle, 'the provisional approval has not closed the cycle').toBe(0);
    const rc = await countersign(architectToken, d.id);
    expect(rc.status, rc.text).toBe(201);
    await noPendingDemand(d.id, 'decision.consultation_requested');
    const late = await respond(engToken, d.id, q.id);
    expect(late.status, late.text).toBe(409);
    expect(late.body.message).toMatch(/is approved — advice can only be asked for, or given, while the question is still open/);
    expect(await t.prisma.decisionConsultationResponse.count({ where: { consultationId: q.id } })).toBe(0);
    const closed = await consult(pmcToken, d.id, eng.membershipId);
    expect(closed.status, closed.text).toBe(409);
    // ordering 2: ask → answer → countersign (the advice stands)
    const d2 = await park();
    expect((await consult(pmcToken, d2.id, eng.membershipId)).status).toBe(201);
    const q2 = await t.prisma.decisionConsultation.findFirstOrThrow({ where: { decisionId: d2.id } });
    const early = await respond(engToken, d2.id, q2.id);
    expect(early.status, early.text).toBe(201);
    expect((await countersign(architectToken, d2.id)).status).toBe(201);
    expect(await t.prisma.decisionConsultationResponse.count({ where: { consultationId: q2.id } })).toBe(1);
    expect((await row(d2.id)).status).toBe('approved');
  });

  // ═══ THE STRANDED RESOLUTION (P29b / P36) ═════════════════════════════════════════════════════
  const strandedSet: Record<'completed' | 'returned' | 'roleGone' | 'memberGone' | 'reseated', { id: string; title: string }> = {} as never;
  it('while an architect is ACTIVE the resolution is refused 409 (the countersign is the legal path), with nothing written', async () => {
    strandedSet.completed = await park();
    strandedSet.returned = await park();
    strandedSet.reseated = await park();
    // a decision the ARCHITECT ROLE holds, approved by the architect
    const c = await issue();
    expect((await forward(pmcToken, c.id, { toDesignationKind: 'architect', reason: 'the architect decides' })).status).toBe(201);
    expect((await approve(architectToken, c.id)).status).toBe(201);
    strandedSet.roleGone = c;
    // a decision the architect holds as a NAMED member
    const m = await issue({ deciderKind: 'member', deciderMembershipId: architect.membershipId });
    expect((await approve(architectToken, m.id)).status).toBe(201);
    strandedSet.memberGone = m;
    for (const d of Object.values(strandedSet)) expect((await row(d.id)).status).toBe('awaiting_countersign');
    const r = await stranded(pmcToken, strandedSet.completed.id, { outcome: 'completed', reason: 'nobody left to countersign' });
    expect(r.status, r.text).toBe(409);
    expect(r.body.message).toMatch(/still holds an active architect/);
    await nothingFinalized(strandedSet.completed.id);
  });

  it('the LAST architect leaves: the chain deactivates, the awaiting decisions are stranded (the departure is the one named exemption from the awaiting-holder guard)', async () => {
    const r = await removeMember(architect.id);
    expect(r.status, r.text).toBe(200);
    expect(await t.prisma.membership.count({ where: { projectId: f.projectA.id, role: 'architect', status: 'active' } })).toBe(0);
    for (const d of Object.values(strandedSet)) expect((await row(d.id)).status).toBe('awaiting_countersign');
    expect((await decisionsFor(pmcToken)).find((x) => x.id === strandedSet.completed.id)?.countersignRequired).toBeUndefined();
  });

  it('COMPLETED: the fact naming the head, the flip, `approved`, ONE `decision.approved` in the PMC\'s name with `finalization = stranded_completed` naming the revision and the fact, the fact\'s claim, the `stranded_resolved` audit row, the notice', async () => {
    const d = strandedSet.completed;
    const provisional = await head(d.id);
    const r = await stranded(pmcToken, d.id, { outcome: 'completed', reason: 'nobody left to countersign; the client\'s choice stands' });
    expect(r.status, r.text).toBe(201);
    expect((await row(d.id)).status).toBe('approved');
    expect(await head(d.id)).toMatchObject({ id: provisional.id, finalized: true });
    const fact = await t.prisma.decisionStrandedResolution.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(fact).toMatchObject({ revisionId: provisional.id, outcome: 'completed', resolvedById: f.memberUser.id, resolvedByRole: 'pmc', resolvedByName: f.memberUser.name, reason: 'nobody left to countersign; the client\'s choice stands' });
    expect(await receiptOf(fact.sourceCommandId)).toMatchObject({ commandType: 'decisions.resolveStrandedCountersign', status: 'succeeded', resultRef: fact.id, actorId: f.memberUser.id });
    const evs = await eventsOf(d.id, 'decision.approved');
    expect(evs).toHaveLength(1);
    expect(evs[0]!).toMatchObject({ actorId: f.memberUser.id, actorRole: 'pmc' });
    expect(evs[0]!.payload).toMatchObject({ revisionId: provisional.id, resolutionId: fact.id, finalization: 'stranded_completed', approverRole: 'client', approverName: f.clientUser.name, approvedFrom: 'pending' });
    expect(await claimOf(evs[0]!.eventId)).toMatchObject({ claimedBy: 'DecisionStrandedResolution', claimedById: fact.id });
    expect(await audits(d.id)).toEqual(['approved', 'stranded_resolved']);
    const notice = await t.prisma.notification.findFirstOrThrow({ where: { decisionId: d.id, kind: 'decision.approved' } });
    expect(notice.text).toBe(`Client approved ${d.title} — Granite — finalized by ${f.memberUser.name} with no active architect`);
    await noPendingDemand(d.id, 'decision.awaiting_countersign');
    expect(await t.prisma.decisionCountersign.count({ where: { decisionId: d.id } })).toBe(0);
  });

  it('RETURNED to a designation that still has a holder: the resolution (the claimant) and the request (verifying) in one bundle, `change`, ONE `decision.change_requested` in the PMC\'s name naming the fact; the re-approval lands `approved` DIRECTLY under the inactive chain', async () => {
    const d = strandedSet.returned;
    const provisional = await head(d.id);
    const r = await stranded(pmcToken, d.id, { outcome: 'returned', reason: 'choose again with the new samples', costImpact: 0, timeImpactDays: 0 });
    expect(r.status, r.text).toBe(201);
    expect(await row(d.id)).toMatchObject({ status: 'change', deciderKind: 'client' });
    expect(await head(d.id)).toMatchObject({ id: provisional.id, finalized: false });
    const fact = await t.prisma.decisionStrandedResolution.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(fact).toMatchObject({ revisionId: provisional.id, outcome: 'returned', resolvedById: f.memberUser.id, resolvedByRole: 'pmc' });
    const req = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(req).toMatchObject({ status: 'open', origin: 'countersign_rejection', revisionId: provisional.id, requestedById: f.memberUser.id, requestedByRole: 'pmc', reason: 'choose again with the new samples', sourceCommandId: fact.sourceCommandId });
    expect(await receiptOf(fact.sourceCommandId)).toMatchObject({ commandType: 'decisions.resolveStrandedCountersign', resultRef: fact.id });
    const evs = await eventsOf(d.id, 'decision.change_requested');
    expect(evs).toHaveLength(1);
    expect(evs[0]!).toMatchObject({ actorId: f.memberUser.id, actorRole: 'pmc' });
    expect(evs[0]!.payload).toMatchObject({ resolutionId: fact.id, outcome: 'returned', origin: 'countersign_rejection', revisionId: provisional.id, requestId: req.id });
    // the RESOLUTION claims the reopening; the request verifies and never claims
    expect(await claimOf(evs[0]!.eventId)).toMatchObject({ claimedBy: 'DecisionStrandedResolution', claimedById: fact.id });
    expect(await t.prisma.notification.findFirstOrThrow({ where: { decisionId: d.id, kind: 'decision.change_requested' } }))
      .toMatchObject({ eventId: evs[0]!.eventId, text: `Change requested: ${d.title} — choose again with the new samples`, color: CHANGE_REQUESTED_NOTICE_COLOR });
    expect(await audits(d.id)).toEqual(['approved', 'stranded_resolved', 'change_requested']);
    expect(await t.prisma.decisionForward.count({ where: { decisionId: d.id } })).toBe(0);
    const rw = await withdrawChange(pmcToken, d.id);
    expect(rw.status, rw.text).toBe(409);
    expect(rw.body.message).toMatch(/countersign rejection — it cannot be withdrawn/);
    // the decider answers: under the inactive chain the approval is final at once
    const ra = await approve(clientToken, d.id, 1);
    expect(ra.status, ra.text).toBe(201);
    expect((await row(d.id)).status).toBe('approved');
    expect(await head(d.id)).toMatchObject({ version: 2, finalized: true, approvedFrom: 'change' });
    expect((await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: req.id } })).status).not.toBe('open');
    expect(await eventsOf(d.id, 'decision.reapproved')).toHaveLength(1);
  });

  it('RETURNED to a designation with NO active holder (the departed architect\'s role; the departed named member) REQUIRES a target — 400 without, and with one the bundle re-homes the decision through the forward door', async () => {
    const roleGone = strandedSet.roleGone;
    const bare = await stranded(pmcToken, roleGone.id, { outcome: 'returned', reason: 'take it back' });
    expect(bare.status, bare.text).toBe(400);
    expect(bare.body.message).toMatch(/no active holder — a returned resolution must name a target/);
    await nothingFinalized(roleGone.id);
    expect((await row(roleGone.id)).status).toBe('awaiting_countersign');
    const r = await stranded(pmcToken, roleGone.id, { outcome: 'returned', reason: 'the client chooses now', toDesignationKind: 'client' });
    expect(r.status, r.text).toBe(201);
    expect(await row(roleGone.id)).toMatchObject({ status: 'change', deciderKind: 'client', deciderMembershipId: null });
    const fact = await t.prisma.decisionStrandedResolution.findFirstOrThrow({ where: { decisionId: roleGone.id } });
    // the bundle's forward (the PMC's earlier hand-off to the architect role is the first fact of this decision)
    expect(await t.prisma.decisionForward.count({ where: { decisionId: roleGone.id } })).toBe(2);
    const fwd = await t.prisma.decisionForward.findFirstOrThrow({ where: { decisionId: roleGone.id, sourceCommandId: fact.sourceCommandId } });
    expect(fwd).toMatchObject({ fromDesignationKind: 'architect', fromDesignationMembershipId: null, toDesignationKind: 'client', forwardedById: f.memberUser.id, forwardedByRole: 'pmc', sourceCommandId: fact.sourceCommandId });
    const allFw = await eventsOf(roleGone.id, 'decision.forwarded');
    expect(allFw, 'the earlier hand-off\'s and the bundle\'s').toHaveLength(2);
    const fw = allFw.filter((e) => (e.payload as { forwardId?: string }).forwardId === fwd.id);
    expect(fw).toHaveLength(1);
    expect(intent(fw[0]!).push?.targetUserIds).toContain(f.clientUser.id);
    expect(await claimOf(fw[0]!.eventId)).toMatchObject({ claimedBy: 'DecisionForward', claimedById: fwd.id });
    const cr = await eventsOf(roleGone.id, 'decision.change_requested');
    expect(cr).toHaveLength(1);
    expect(await claimOf(cr[0]!.eventId)).toMatchObject({ claimedBy: 'DecisionStrandedResolution', claimedById: fact.id });
    expect(await audits(roleGone.id)).toEqual(['forwarded', 'approved', 'stranded_resolved', 'change_requested', 'forwarded']);
    expect((await decisionsFor(clientToken)).find((x) => x.id === roleGone.id)?.status).toBe('change');
    // the departed NAMED member's decision, re-homed to the engineer
    const memberGone = strandedSet.memberGone;
    const bare2 = await stranded(pmcToken, memberGone.id, { outcome: 'returned', reason: 'take it back' });
    expect(bare2.status, bare2.text).toBe(400);
    const r2 = await stranded(pmcToken, memberGone.id, { outcome: 'returned', reason: 'the engineer chooses now', toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId });
    expect(r2.status, r2.text).toBe(201);
    expect(await row(memberGone.id)).toMatchObject({ status: 'change', deciderKind: 'member', deciderMembershipId: eng.membershipId });
    expect(await t.prisma.decisionForward.findFirstOrThrow({ where: { decisionId: memberGone.id } })).toMatchObject({ fromDesignationKind: 'member', fromDesignationMembershipId: architect.membershipId, toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId });
    expect((await decisionsFor(engToken)).find((x) => x.id === memberGone.id)).toMatchObject({ status: 'change', deciderUserId: eng.id });
    const ra = await approve(engToken, memberGone.id);
    expect(ra.status, ra.text).toBe(201);
    expect((await row(memberGone.id)).status).toBe('approved');
  });

  it('refused with an answer, nothing written: the client and the engineer (403), a decision not awaiting, a blank reason, a target on `completed`, a member target without its membership', async () => {
    const d = strandedSet.reseated;
    for (const token of [clientToken, engToken]) {
      const r = await stranded(token, d.id, { outcome: 'completed', reason: 'not mine' });
      expect(r.status, r.text).toBe(403);
    }
    const cases: Array<[object, number, RegExp]> = [
      [{ outcome: 'completed', reason: '   ' }, 400, /reason/i],
      [{ outcome: 'completed', reason: 'with a target', toDesignationKind: 'client' }, 400, /target is admitted only on a returned resolution/],
      [{ outcome: 'returned', reason: 'no membership', toDesignationKind: 'member' }, 400, /toDesignationMembershipId/],
    ];
    for (const [body, status, message] of cases) {
      const r = await stranded(pmcToken, d.id, body);
      expect(r.status, `${JSON.stringify(body)}: ${r.text}`).toBe(status);
      expect(JSON.stringify(r.body), JSON.stringify(body)).toMatch(message);
    }
    const settled = strandedSet.completed;
    const rs = await stranded(pmcToken, settled.id, { outcome: 'completed', reason: 'again' });
    expect(rs.status, rs.text).toBe(409);
    expect(rs.body.message).toMatch(/not stranded/);
    expect(await t.prisma.decisionStrandedResolution.count({ where: { decisionId: settled.id } })).toBe(1);
    await nothingFinalized(d.id);
    expect((await row(d.id)).status).toBe('awaiting_countersign');
  });

  it('a RE-SEATED architect makes the resolution illegal again (409), and the new architect — not the one the approval awaited — countersigns the stranded decision', async () => {
    const a = await addMember({ name: `A8b Architect II ${run}`, role: 'architect', email: `a8b-arch2-${run}@test.local` });
    expect(a.status, a.text).toBe(201);
    architect2.id = a.body.userId; architect2.membershipId = a.body.membershipId; architect2.name = `A8b Architect II ${run}`;
    createdUserIds.push(architect2.id);
    const token2 = t.issueProjectToken(architect2.id, f.projectA.id, 'architect');
    const d = strandedSet.reseated;
    const r = await stranded(pmcToken, d.id, { outcome: 'completed', reason: 'too late' });
    expect(r.status, r.text).toBe(409);
    expect(r.body.message).toMatch(/still holds an active architect/);
    // the departed architect's token no longer holds the standing the seal judges by
    const gone = await countersign(architectToken, d.id);
    expect(gone.status, gone.text).toBe(403);
    await nothingFinalized(d.id);
    const rc = await countersign(token2, d.id);
    expect(rc.status, rc.text).toBe(201);
    expect((await row(d.id)).status).toBe('approved');
    const fact = await t.prisma.decisionCountersign.findFirstOrThrow({ where: { decisionId: d.id } });
    expect(fact).toMatchObject({ countersignedById: architect2.id, countersignedByName: architect2.name });
    expect((await eventsOf(d.id, 'decision.approved'))[0]!.payload).toMatchObject({ countersignId: fact.id, finalization: 'countersign' });
  });
});
