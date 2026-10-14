import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';

/**
 * #482 QA check (14 Oct 2026, item 4) — engineers, contractors and consultants plan around what waits on the
 * client, but the server keeps an open decision to its decider: they receive none of the pending rows. The
 * "Awaiting client" read gives every project member a SUMMARY of the open, published, client-held decisions
 * (title, place, status, waiting since) and nothing else: no options, prices, drafts, or decisions held by
 * someone other than the client. Proven against live PostgreSQL.
 */
describe('#482 QA — the "Awaiting client" summary read (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  const run = randomUUID().slice(0, 8);
  const extra = (['engineer', 'contractor', 'consultant'] as const).map((role) => ({ role, id: `awc-${role}-${run}` }));
  const options = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    for (const u of extra) {
      await t.prisma.user.create({ data: { id: u.id, projectId: f.projectA.id, role: u.role, name: `AWC ${u.role}`, email: `${u.id}@test.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: u.id, role: u.role, status: 'active' } });
    }
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.commandExecution.deleteMany({ where: { projectId } });
    for (const u of extra) {
      await t.prisma.membership.deleteMany({ where: { userId: u.id } });
      await t.prisma.user.deleteMany({ where: { id: u.id } });
    }
    await f?.cleanup();
    await t?.close();
  });

  const issue = async (title: string, body: object) => {
    const r = await request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .send({ title, room: 'Kitchen', options, ...body });
    expect(r.status, r.text).toBe(201);
    return t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } });
  };
  const summary = (token: string, projectId = f.projectA.id) =>
    request(t.app.getHttpServer()).get(`/projects/${projectId}/decisions/awaiting-client`).set('Authorization', `Bearer ${token}`);

  it('every non-deciding role reads the client-held open decisions as a summary only, and still receives no pending row', async () => {
    const waiting = await issue(`AWC waiting ${run}`, { publish: true });
    const draft = await issue(`AWC draft ${run}`, { publish: false });
    const pmcHeld = await issue(`AWC pmc-held ${run}`, { publish: true, deciderKind: 'pmc' });

    for (const u of extra) {
      const token = t.issueProjectToken(u.id, f.projectA.id, u.role);
      const r = await summary(token);
      expect(r.status, `${u.role}: ${r.text}`).toBe(200);
      const ids = (r.body as { id: string }[]).map((row) => row.id);
      expect(ids, u.role).toContain(waiting.id);
      expect(ids, `${u.role}: a draft is the author's`).not.toContain(draft.id);
      expect(ids, `${u.role}: a PMC-held decision does not wait on the client`).not.toContain(pmcHeld.id);
      const row = (r.body as Record<string, unknown>[]).find((x) => x.id === waiting.id)!;
      // a summary: nothing to choose between, no price, no approval control
      expect(Object.keys(row).sort()).toEqual(['id', 'nodeId', 'room', 'status', 'title', 'waitingSince']);
      expect(row).toMatchObject({ title: `AWC waiting ${run}`, room: 'Kitchen', status: 'pending' });
      expect(Number.isNaN(Date.parse(row.waitingSince as string))).toBe(false);

      // the decision rows themselves stay with the decider, as before
      const own = await request(t.app.getHttpServer()).get(`/projects/${f.projectA.id}/decisions`).set('Authorization', `Bearer ${token}`);
      expect(own.status).toBe(200);
      expect(own.body.decisions.map((d: { id: string }) => d.id), u.role).not.toContain(waiting.id);
    }
  });

  it('a worker-link token is refused: the read is for signed-in project members (`project.read`)', async () => {
    const worker = t.issueProjectToken(extra[0].id, f.projectA.id, 'worker');
    expect((await summary(worker)).status).toBe(403);
  });

  it('another project\'s member cannot read this project\'s summary', async () => {
    const outsider = t.issueProjectToken(f.otherUser.id, f.projectB.id);
    const r = await summary(outsider);
    expect([401, 403, 404]).toContain(r.status);
  });
});
