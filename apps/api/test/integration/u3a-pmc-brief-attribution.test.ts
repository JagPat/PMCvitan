import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { PmcBriefResult } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia, wipeMembershipTransitionsVia } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { PHASE6_4D_RESERVATION_DOORS } from '../../src/platform/phase6-4d-rollout';

/**
 * U3a (#696 review round 1, finding 1) — the PMC brief's "client approvals" are judged from each
 * approval revision's OWN frozen attribution (`approvedByRole`, `onBehalfOf`), never the decision's
 * CURRENT decider: `deciderKind` moves when a decision is forwarded, so it cannot say who approved an
 * older revision. Live through the shipped routes, both directions:
 *   - a named engineer's approval stays uncounted after the decision is reopened and forwarded to the
 *     client;
 *   - a client's approval stays counted after the decision is reopened and forwarded to an engineer.
 * And only a FINALIZED approval counts (#696 shadow review): under an active architect chain the
 * client's approval is provisional until countersigned, and one the architect rejects keeps its row
 * but never became an approval.
 *
 * Forwarding is a 4d shape its reservation doors hold, so — exactly as the A8a suite does — the doors are
 * captured from the catalog, dropped for this suite, and re-created after. Every other seal stays on.
 */
describe('U3a — the brief counts approvals by their frozen attribution (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let clientToken: string;
  let engToken: string;
  const run = randomUUID().slice(0, 8);
  let doorDefs: Array<{ tgname: string; def: string }> = [];
  const eng = { id: '', membershipId: '' };
  const architect = { id: '' };
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    doorDefs = await t.prisma.$queryRawUnsafe<Array<{ tgname: string; def: string }>>(
      `SELECT t.tgname, pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgname = ANY($1::text[]) ORDER BY t.tgname`,
      [...PHASE6_4D_RESERVATION_DOORS],
    );
    expect(doorDefs.map((d) => d.tgname)).toEqual([...PHASE6_4D_RESERVATION_DOORS].sort());
    for (const d of doorDefs) {
      const table = /ON public\."?(\w+)"?/.exec(d.def)![1];
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${d.tgname}" ON "${table}"`);
    }
    const r = await http().post(`/projects/${f.projectA.id}/members`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .send({ name: `U3a Engineer ${run}`, role: 'engineer', email: `u3a-eng-${run}@test.local` });
    expect(r.status, r.text).toBe(201);
    eng.id = r.body.userId; eng.membershipId = r.body.membershipId;
    createdUserIds.push(eng.id);
    engToken = t.issueProjectToken(eng.id, f.projectA.id, 'engineer');
  });

  afterAll(async () => {
    const projectId = f?.projectA.id;
    try {
      if (t?.prisma && projectId) {
        await wipeDecisionEvents(t.prisma, { decision: { projectId } });
        await sanctionedReset(t.prisma, [
          'Notification', 'DecisionCountersign', 'DecisionStrandedResolution', 'DecisionApprovalRevision', 'ChangeRequest',
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
          const rm = await http().delete(`/projects/${projectId}/members/${architect.id}`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send();
          expect(rm.status, rm.text).toBe(200);
        }
        await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'CommandExecution', 'DomainEventPairingClaim'], { cascade: true });
        await t.prisma.auditLog.deleteMany({ where: { projectId } });
        const provisioned = await t.prisma.user.findMany({ where: { email: { startsWith: 'u3a-', endsWith: `-${run}@test.local` } }, select: { id: true } });
        const ids = [...new Set([...createdUserIds, ...provisioned.map((u) => u.id)])];
        await wipeMembershipTransitionsVia(t.prisma, [...ids, f.memberUser.id]);
        await t.prisma.membership.deleteMany({ where: { userId: { in: ids } } });
        await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorUserId: { in: ids } }] } });
        await t.prisma.user.deleteMany({ where: { id: { in: ids } } });
      }
    } finally {
      for (const d of doorDefs) await t.prisma.$executeRawUnsafe(d.def);
      await f?.cleanup();
      await t?.close();
    }
  });

  const http = () => request(t.app.getHttpServer());
  const CONTRACT = 'countersign-v1';
  const decisions = () => `/projects/${f.projectA.id}/decisions`;
  const post = (token: string, path: string, body: object) =>
    http().post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).set('x-vitan-decisions-contract', CONTRACT).send(body);
  const issue = async (): Promise<string> => {
    const title = `U3a ${randomUUID().slice(0, 8)}`;
    const r = await post(pmcToken, decisions(), {
      title, room: 'Kitchen', publish: true,
      options: [
        { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
      ],
    });
    expect(r.status, r.text).toBe(201);
    return (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
  };
  const approve = (token: string, id: string) => post(token, `${decisions()}/${id}/approve`, { optionIndex: 0 });
  const reopen = (id: string) => post(pmcToken, `${decisions()}/${id}/change`, { reason: 'the need changed', costImpact: 0, timeImpactDays: 0 });
  const forward = (id: string, body: object) => post(pmcToken, `${decisions()}/${id}/forward`, { reason: 'the right person decides this', ...body });
  const approvals = async (): Promise<number> => {
    const r = await http().get('/me/brief').set('Authorization', `Bearer ${pmcToken}`);
    expect(r.status, r.text).toBe(200);
    return (r.body as PmcBriefResult).projects.find((p) => p.projectId === f.projectA.id)!.sinceYesterday.approvals;
  };
  const expectStatus = async (res: request.Response, status: number) => expect(res.status, res.text).toBe(status);

  it("an engineer's approval stays uncounted after the decision is reopened and forwarded to the client", async () => {
    const id = await issue();
    await expectStatus(await forward(id, { toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId }), 201);
    await expectStatus(await approve(engToken, id), 201);
    expect(await approvals()).toBe(0);
    await expectStatus(await reopen(id), 201);
    await expectStatus(await forward(id, { toDesignationKind: 'client' }), 201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).deciderKind).toBe('client');
    // the client holds it now, but the recorded approval was the engineer's
    expect(await approvals()).toBe(0);
  });

  it("a client's approval stays counted after the decision is reopened and forwarded to an engineer", async () => {
    const id = await issue();
    await expectStatus(await approve(clientToken, id), 201);
    expect(await approvals()).toBe(1);
    await expectStatus(await reopen(id), 201);
    await expectStatus(await forward(id, { toDesignationKind: 'member', toDesignationMembershipId: eng.membershipId }), 201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).deciderKind).toBe('member');
    // the engineer holds it now, but the recorded approval was the client's
    expect(await approvals()).toBe(1);
  });

  it('under an architect chain only a countersigned approval counts; a rejected one never does', async () => {
    const r = await http().post(`/projects/${f.projectA.id}/members`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .send({ name: `U3a Architect ${run}`, role: 'architect', email: `u3a-arch-${run}@test.local` });
    expect(r.status, r.text).toBe(201);
    architect.id = r.body.userId;
    createdUserIds.push(architect.id);
    const architectToken = t.issueProjectToken(architect.id, f.projectA.id, 'architect');
    const before = await approvals();

    const id = await issue();
    await expectStatus(await approve(clientToken, id), 201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('awaiting_countersign');
    expect(await approvals(), 'a provisional approval is not yet an approval').toBe(before);
    await expectStatus(await post(architectToken, `${decisions()}/${id}/disagree`, { path: 'reject_back', reason: 'the wear rating is wrong for a kitchen', costImpact: 0, timeImpactDays: 0 }), 201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('change');
    expect(await approvals(), 'a rejected approval keeps its row but is never counted').toBe(before);

    await expectStatus(await approve(clientToken, id), 201);
    await expectStatus(await post(architectToken, `${decisions()}/${id}/countersign`, {}), 201);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('approved');
    expect(await approvals(), 'the countersigned approval counts once').toBe(before + 1);
  });
});
