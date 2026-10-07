import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Live bug 1 (deep-link target fidelity) — the feed NAMES the decision a notice is about, so the bell
 * opens that decision instead of the register. Proven against live PostgreSQL:
 *
 * - a decision notice (the writer's own kinded notice, and a kind-less row carrying `decisionId`)
 *   is served with `decisionId` to a viewer whose decision slice holds that decision;
 * - a viewer whose slice does NOT hold it is never handed the id;
 * - a notice about no decision keeps the delivered three-key shape.
 */
describe('live bug 1 — a notice names the decision it is about, to viewers who can open it (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let snapshot: SnapshotService;
  let pmcToken: string;
  let contractorId: string;
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    snapshot = t.app.get(SnapshotService);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    contractorId = `lb1-con-${run}`;
    await t.prisma.user.create({ data: { id: contractorId, projectId: f.projectA.id, role: 'contractor', name: 'LB1 Contractor', email: `${contractorId}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: contractorId, role: 'contractor', status: 'active' } });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await sanctionedReset(t.prisma, ['Notification', 'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.commandExecution.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({ where: { userId: contractorId } });
    await t.prisma.user.deleteMany({ where: { id: contractorId } });
    await f?.cleanup();
    await t?.close();
  });

  /** A published, client-held pending decision (its writer files the kinded notice beside it). */
  const publish = async (): Promise<{ id: string; title: string }> => {
    const title = `LB1 ${randomUUID().slice(0, 8)}`;
    const r = await request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/decisions`)
      .set('Authorization', `Bearer ${pmcToken}`).set('Idempotency-Key', randomUUID())
      .send({
        title, room: 'Kitchen', publish: true,
        options: [
          { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
          { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
        ],
      });
    expect(r.status, r.text).toBe(201);
    return { id: (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id, title };
  };

  const feed = async (role: 'pmc' | 'contractor', userId: string) => (await snapshot.build(f.projectA.id, role, userId)).notifications;

  it('the publish notice is served with its decisionId to the pmc, who can open that decision', async () => {
    const d = await publish();
    const mine = (await feed('pmc', f.memberUser.id)).filter((n) => n.text.includes(d.title));
    expect(mine.length).toBeGreaterThan(0);
    for (const n of mine) expect(n.decisionId).toBe(d.id);
  });

  it('a kind-less notice carrying a decisionId names it only to a viewer whose slice holds the decision', async () => {
    const d = await publish();
    const text = `LB1 note about ${d.id} ${run}`;
    await t.prisma.notification.create({ data: { projectId: f.projectA.id, text, color: '#000', time: 'just now', decisionId: d.id } });

    const pmc = (await feed('pmc', f.memberUser.id)).find((n) => n.text === text);
    expect(pmc).toEqual({ text, time: 'just now', color: '#000', decisionId: d.id });

    // a pending client-held decision is outside the contractor's slice: the note still reaches
    // them, but the id of a decision they cannot open is never handed out
    const contractorSlice = (await snapshot.build(f.projectA.id, 'contractor', contractorId)).decisions.map((x) => x.id);
    expect(contractorSlice).not.toContain(d.id);
    const contractor = (await feed('contractor', contractorId)).find((n) => n.text === text);
    expect(contractor).toEqual({ text, time: 'just now', color: '#000' });
  });

  it('a notice about no decision keeps the delivered three-key shape', async () => {
    const text = `LB1 plain ${run}`;
    await t.prisma.notification.create({ data: { projectId: f.projectA.id, text, color: '#111', time: '1h ago' } });
    const n = (await feed('pmc', f.memberUser.id)).find((x) => x.text === text);
    expect(n).toEqual({ text, time: '1h ago', color: '#111' });
    expect(Object.keys(n!).sort()).toEqual(['color', 'text', 'time']);
  });
});
