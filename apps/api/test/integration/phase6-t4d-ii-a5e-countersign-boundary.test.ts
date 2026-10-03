import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5e (§A.2) — the `countersign-v1` boundary on the real app, against
 * live PostgreSQL, with 4d-i's doors standing: no 4d shape can exist, so every client, whatever it
 * declares, is served exactly today's bytes and today's commands. This is P29c's mixed-version
 * byte-identity arm for the boundary; its strip / refuse arms are exercised shape by shape by the
 * interceptor's unit suite (`countersign-compat.test.ts`), and its stale-client arms under an ACTIVE
 * chain (the activation-between-check-and-approve barrier in both orderings, an architect signing in
 * through each token-minting route) need an architect, which 4d-iii's doors admit.
 */
describe('4d-ii-a / A5e — the countersign-v1 boundary with the doors standing (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let clientToken: string;
  const run = randomUUID().slice(0, 8);
  const CONTRACTS = [undefined, 'recorded-v1', 'countersign-v1'] as const;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    // the approvals wrote immutable register rows: the sanctioned reset is TRUNCATE (change-control's)
    await sanctionedReset(t.prisma, ['LabourDemandSlice', 'LabourRequirementSpec', 'MaterialRequirementSpec', 'DecisionApprovalRevision'], { cascade: true });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.changeRequest.deleteMany({ where: { decision: { projectId } } });
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.commandExecution.deleteMany({ where: { projectId } });
    await f?.cleanup();
    await t?.close();
  });

  const call = (method: 'get' | 'post', path: string, token: string, contract?: string) => {
    let r = request(t.app.getHttpServer())[method](path).set('Authorization', `Bearer ${token}`);
    if (method === 'post') r = r.set('Idempotency-Key', randomUUID());
    return contract ? r.set('X-Vitan-Decisions-Contract', contract) : r;
  };

  it('every contract approves, requests a change and re-approves exactly as today (the in-command read, no chain)', async () => {
    for (const contract of CONTRACTS) {
      const title = `A5e ${run} ${contract ?? 'none'}`;
      const created = await call('post', `/projects/${f.projectA.id}/decisions`, pmcToken, contract).send({
        title, room: 'Kitchen', publish: true,
        options: [
          { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
          { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
        ],
      });
      expect(created.status, created.text).toBe(201);
      const id = (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
      const approved = await call('post', `/projects/${f.projectA.id}/decisions/${id}/approve`, clientToken, contract).send({ optionIndex: 0 });
      expect(approved.status, `${contract}: ${approved.text}`).toBe(201);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('approved');
      const changed = await call('post', `/projects/${f.projectA.id}/decisions/${id}/change`, pmcToken, contract)
        .send({ reason: 'Stone out of stock', costImpact: 0, timeImpactDays: 2 });
      expect(changed.status, `${contract}: ${changed.text}`).toBe(201);
    }
  });

  it('every contract reads the same decisions, and a standard change request names no origin', async () => {
    const reads = [];
    for (const contract of CONTRACTS) {
      const r = await call('get', `/projects/${f.projectA.id}/decisions`, pmcToken, contract);
      expect(r.status, r.text).toBe(200);
      reads.push(r.body.decisions);
    }
    const mine = (reads[2] as Array<{ title: string; status: string; changeRequest?: object }>).filter((d) => d.title.startsWith(`A5e ${run}`));
    expect(mine).toHaveLength(3);
    for (const d of mine) {
      expect(d.status).toBe('change');
      expect(d.changeRequest).toBeDefined();
      expect(d.changeRequest).not.toHaveProperty('origin');
    }
    // the 4b interceptor strips records from an undeclared client; nothing here is a record, so every
    // contract reads the same rows
    expect(reads[0]).toEqual(reads[2]);
    expect(reads[1]).toEqual(reads[2]);
  });

  it('the shell, the roster, memberships, portfolio and the PMC brief are served to every contract identically', async () => {
    for (const path of [`/projects/${f.projectA.id}/shell`, `/projects/${f.projectA.id}/members`, '/me/memberships', '/me/portfolio', '/me/brief']) {
      const bodies = [];
      for (const contract of CONTRACTS) {
        const r = await call('get', path, pmcToken, contract);
        expect(r.status, `${path} ${contract}: ${r.text}`).toBe(200);
        bodies.push(r.body);
      }
      expect(bodies[0], path).toEqual(bodies[2]);
      expect(bodies[1], path).toEqual(bodies[2]);
    }
  });
});
