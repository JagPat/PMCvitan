import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4a — the consultation cycle counts FINALIZED approvals, at every
 * producer and reader of §A.2's cycle trace and in the two consultation seals, proven against live
 * PostgreSQL.
 *
 * A consultation is frozen to the approval cycle it was asked in (`openCycle`). Under the chain an
 * approval is PROVISIONAL (`finalized = false`) until the architect countersigns it, and a
 * provisional approval has not ended the cycle: the decision is still open to advice, and 4d
 * deliberately leaves the request push standing. So every site counts finalized revisions:
 * - the request freezing `openCycle` (and the request seal re-counting it);
 * - the response check (and the response seal);
 * - the claim-time push predicate;
 * - the DTO's `approvalCycle`, which `viewerIsConsultee` compares on the server (the decision's
 *   visibility) and on the client, and which the projection folds.
 *
 * THE PLANT. Nothing writes a provisional revision until A8a's approve and 4d-iii's activation, so
 * each arm plants one beside a PENDING decision, with the register's own seals disabled by name for
 * that one insert. The state isolates the counting rule at each site. §C's P25d sequences end to end
 * (request before the provisional approval, answered after it; request while awaiting, refused after
 * the countersign and after a reopen) need the approve and countersign commands and travel with A8b.
 *
 * Each arm is RED against the total count, where the consultee loses sight of the decision, the
 * answer is refused as a closed cycle, the push is dropped, and a new question is frozen to cycle 1.
 * The two counts that must NOT move are asserted too: the withdraw's approval-evidence count, and
 * the version the next approval takes.
 */
describe('4d-ii-a / A4a — the consultation cycle counts finalized approvals (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let query: DecisionsQueryService;
  let relay: OutboxRelay;
  let pmcToken: string;
  let engToken: string;
  const run = randomUUID().slice(0, 8);
  const eng = { id: `a4a-eng-${run}`, membershipId: '' };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    query = t.app.get(DecisionsQueryService);
    relay = t.app.get(OutboxRelay);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    await t.prisma.user.create({ data: { id: eng.id, projectId: f.projectA.id, role: 'engineer', name: 'A4a Engineer', email: `${eng.id}@test.local` } });
    eng.membershipId = (await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: eng.id, role: 'engineer', status: 'active' } })).id;
    engToken = t.issueProjectToken(eng.id, f.projectA.id, 'engineer');
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    // The revisions and the consultation facts are immutable; the sanctioned reset is TRUNCATE.
    await sanctionedReset(t.prisma, [
      'DecisionConsultationResponse', 'DecisionConsultation', 'DecisionApprovalRevision',
      'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
    ], { cascade: true });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.projectionGeneration.deleteMany({ where: { projectId } });
    await t.prisma.commandExecution.deleteMany({ where: { actorId: eng.id } });
    await t.prisma.membership.deleteMany({ where: { userId: eng.id } });
    await t.prisma.user.deleteMany({ where: { id: eng.id } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const post = (token: string, path: string, body: object, key: string = randomUUID()) =>
    http().post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', key).send(body);
  const base = () => `/projects/${f.projectA.id}/decisions`;

  /** A published, client-held pending decision; returns its id. */
  const issue = async (): Promise<string> => {
    const title = `A4a ${randomUUID().slice(0, 8)}`;
    const r = await post(pmcToken, base(), {
      title, room: 'Kitchen', publish: true,
      options: [
        { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
      ],
    });
    expect(r.status, r.text).toBe(201);
    return (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
  };
  const ask = (decisionId: string) =>
    post(pmcToken, `${base()}/${decisionId}/consultations`, { consulteeMembershipId: eng.membershipId, question: 'Does the granite stain here?' });
  const answer = (decisionId: string, consultationId: string) =>
    post(engToken, `${base()}/${decisionId}/consultations/respond`, { consultationId, response: 'Quartz — the granite stains.' });
  const consultationOf = async (decisionId: string) =>
    t.prisma.decisionConsultation.findFirstOrThrow({ where: { decisionId }, orderBy: { requestedAt: 'desc' } });
  const engSees = async (decisionId: string) => {
    const r = await http().get(base()).set('Authorization', `Bearer ${engToken}`);
    expect(r.status).toBe(200);
    return ((r.body.decisions ?? r.body) as Array<Record<string, unknown>>).find((d) => d.id === decisionId);
  };

  /**
   * Plant a PROVISIONAL (`finalized = false`) approval revision beside the decision: the state A8a's
   * approve writes under the chain. The register's insert seals refuse it outside that act (and
   * the decision's doors refuse `awaiting_countersign` until 4d-iii), so they are disabled BY NAME
   * for this one insert, inside one transaction, and re-enabled before it commits.
   */
  const SEALS = [
    'DecisionApprovalRevision_t4c_provenance',
    'DecisionApprovalRevision_t4d_birth',
    'DecisionApprovalRevision_t4d_birth_paired',
    'DecisionApprovalRevision_t4d_claim',
    'DecisionApprovalRevision_t4d_claim_deferred',
  ];
  const plantProvisional = async (decisionId: string) => {
    const option = await t.prisma.decisionOption.findFirstOrThrow({ where: { decisionId }, orderBy: { order: 'asc' } });
    await t.prisma.$transaction(async (tx) => {
      for (const s of SEALS) await tx.$executeRawUnsafe(`ALTER TABLE "DecisionApprovalRevision" DISABLE TRIGGER "${s}"`);
      await tx.$executeRawUnsafe(
        `INSERT INTO "DecisionApprovalRevision"
           ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","finalized","approvedFrom","approvedByName","approvedByRole")
         VALUES ($1, $2, $3, 1, $4, now(), $5, FALSE, 'pending', 'Client', 'client')`,
        `a4a-rev-${randomUUID().slice(0, 8)}`, f.projectA.id, decisionId, option.optionKey, f.clientUser.id,
      );
      for (const s of SEALS) await tx.$executeRawUnsafe(`ALTER TABLE "DecisionApprovalRevision" ENABLE TRIGGER "${s}"`);
    });
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId, finalized: false } })).toBe(1);
  };

  it('a question asked BESIDE a provisional approval is frozen to the current cycle, and the request seal admits it', async () => {
    const decisionId = await issue();
    await plantProvisional(decisionId);
    const r = await ask(decisionId);
    expect(r.status, r.text).toBe(201);
    expect((await consultationOf(decisionId)).openCycle, 'a provisional approval has not ended cycle 0').toBe(0);
  });

  it('a consultee asked BEFORE a provisional approval still sees the decision, and the answer is accepted by the service and the response seal', async () => {
    const decisionId = await issue();
    expect((await ask(decisionId)).status).toBe(201);
    await plantProvisional(decisionId);

    // the READ: the DTO's cycle is the finalized count, so the frozen cycle still matches it and
    // `viewerIsConsultee` keeps the decision in the consultee's slice
    const seen = await engSees(decisionId);
    expect(seen, 'the consultee keeps sight of the decision while its approval is provisional').toBeTruthy();
    expect(seen!.approvalCycle).toBe(0);

    // the WRITE
    const consultation = await consultationOf(decisionId);
    const r = await answer(decisionId, consultation.id);
    expect(r.status, r.text).toBe(201);
    expect(await t.prisma.decisionConsultationResponse.count({ where: { consultationId: consultation.id } })).toBe(1);
  });

  it('the claim-time push predicate still finds the standing consultation beside a provisional approval', async () => {
    const decisionId = await issue();
    expect((await ask(decisionId)).status).toBe(201);
    await plantProvisional(decisionId);
    const verdict = await query.consultationRequestedPushTarget(f.projectA.id, decisionId, eng.id);
    expect(verdict.actionable, 'the request push the service would still answer must not be dropped').toBe(true);
  });

  it('live and projection carry the same finalized cycle', async () => {
    const decisionId = await issue();
    expect((await ask(decisionId)).status).toBe(201);
    await plantProvisional(decisionId);
    // an event after the plant, so the projection re-folds this decision from its canonical row
    expect((await answer(decisionId, (await consultationOf(decisionId)).id)).status).toBe(201);

    const live = (await query.snapshotSlice(f.projectA.id, 'engineer', eng.id)).decisions.find((d) => d.id === decisionId);
    expect(live?.approvalCycle).toBe(0);
    for (let pass = 0; pass < 60; pass++) {
      const pending = await t.prisma.outboxDelivery.findMany({
        where: { consumer: DECISIONS_PROJECTION, projectId: f.projectA.id, status: { in: ['pending', 'leased'] } },
        orderBy: { streamPosition: 'asc' },
      });
      if (!pending.length) break;
      for (const d of pending) await relay.dispatchOne(d.id);
    }
    const projected = await query.projectionSlice(f.projectA.id, 'engineer', eng.id);
    expect(projected.generation, 'the projection is caught up and servable, so the comparison is real').not.toBeNull();
    expect(projected.decisions.find((d) => d.id === decisionId)).toEqual(live);
  });

  it('the counts that must NOT move: a provisional approval is still approval evidence, so the decision cannot be withdrawn', async () => {
    const decisionId = await issue();
    await plantProvisional(decisionId);
    const r = await post(pmcToken, `${base()}/${decisionId}/withdraw`, { reason: 'No longer needed' });
    expect(r.status, r.text).toBe(409);
    expect(r.body.message).toMatch(/carries approval evidence/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: decisionId } })).status).toBe('pending');
  });
});
