import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5d (§A.1) — the project shell's badge IS the decisions module's
 * `countPending`, the count the Portfolio tile shows, so the two agree for every viewer (#561's review
 * round 1, finding 6). Proven against live PostgreSQL with a CONSULTEE: an engineer asked for advice on
 * a client-held pending decision can SEE it, but it does not await them. At the base the shell counted
 * the visible pending rows itself and reported it; the tile never did.
 */
describe('4d-ii-a / A5d — the shell badge is countPending (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let query: DecisionsQueryService;
  let pmcToken: string;
  let engineerId: string;
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    query = t.app.get(DecisionsQueryService);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    engineerId = `a5d-eng-${run}`;
    await t.prisma.user.create({ data: { id: engineerId, projectId: f.projectA.id, role: 'engineer', name: 'A5d Engineer', email: `${engineerId}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: engineerId, role: 'engineer', status: 'active' } });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await sanctionedReset(t.prisma, ['DecisionConsultation', 'DecisionConsultationResponse'], { cascade: true });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.commandExecution.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({ where: { userId: engineerId } });
    await t.prisma.user.deleteMany({ where: { id: engineerId } });
    await f?.cleanup();
    await t?.close();
  });

  const post = (path: string, body: object) =>
    request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID()).send(body);
  const shellCount = async (token: string) => {
    const r = await request(t.app.getHttpServer()).get(`/projects/${f.projectA.id}/shell`).set('Authorization', `Bearer ${token}`);
    expect(r.status, r.text).toBe(200);
    return r.body.counts.pendingDecisions as number;
  };

  it('a consultee SEES the pending decision, and neither the badge nor the tile counts it; the pmc and the client do', async () => {
    const title = `A5d ${run}`;
    expect((await post(`/projects/${f.projectA.id}/decisions`, {
      title, room: 'Kitchen', publish: true,
      options: [
        { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
      ],
    })).status).toBe(201);
    const decision = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } });
    const membership = await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: engineerId } });
    const asked = await post(`/projects/${f.projectA.id}/decisions/${decision.id}/consultations`, { consulteeMembershipId: membership.id, question: 'Is the granite suitable?' });
    expect(asked.status, asked.text).toBe(201);

    const engineerToken = t.issueProjectToken(engineerId, f.projectA.id, 'engineer');
    const engineerSees = await request(t.app.getHttpServer()).get(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${engineerToken}`);
    expect(engineerSees.body.decisions.map((d: { id: string }) => d.id), 'the consultee can see the question').toContain(decision.id);

    // the engineer decides nothing: badge and tile both 0 (at the base the badge said 1)
    expect(await shellCount(engineerToken)).toBe(await query.countPending(f.projectA.id, { role: 'engineer', userId: engineerId }));
    expect(await shellCount(engineerToken)).toBe(0);
    // the pmc and the client agree too, and both count the decision
    const pmcTile = await query.countPending(f.projectA.id, { role: 'pmc', userId: f.memberUser.id });
    expect(await shellCount(pmcToken)).toBe(pmcTile);
    expect(pmcTile).toBeGreaterThan(0);
    const clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    expect(await shellCount(clientToken)).toBe(await query.countPending(f.projectA.id, { role: 'client', userId: f.clientUser.id }));
    expect(await shellCount(clientToken)).toBeGreaterThan(0);
  });
});
