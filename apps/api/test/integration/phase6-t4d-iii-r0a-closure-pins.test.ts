import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { STALE_ROLE_MESSAGE } from '../../src/platform/actor-envelope';

/**
 * Phase 6 task 4d-iii / R0a (the additive staging record, "R0 — the writers state every pin") — the
 * decision writers state every pin R1 and R2 will require, proven against live PostgreSQL and the
 * delivered 4d-i seals (which already judge every value written here):
 *
 * - both `ChangeRequest` CLOSURES write the complete set — `resolvedById`, `resolvedAt`, `resolution`,
 *   `resolvedByCommandId` (this command's own receipt, completed in this transaction) and the frozen
 *   `resolvedByRole`/`resolvedByName` pair — for the re-approval (`decisions.approve` from `change`)
 *   and for `decisions.withdrawChange`, keyed or not;
 * - the Board's Decision 2 (2026-10-05): a human act whose token role no longer stands is REFUSED with
 *   "your role on this project changed — sign in again", and the decision's state is unchanged; it is
 *   never recorded with an empty attribution;
 * - Decision 1's org owner/admin arm: a membership-less org owner closes a request as `pmc`.
 */
describe('4d-iii / R0a — the closures write every pin; a stale role is refused (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let decisions: DecisionsService;
  let pmcToken: string;
  let clientToken: string;
  let ownerToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    decisions = t.app.get(DecisionsService);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    // The approvals wrote immutable revision rows; the sanctioned reset is TRUNCATE.
    await sanctionedReset(t.prisma, ['DecisionApprovalRevision'], { cascade: true });
    // Scoped teardown of the requests this suite opened (classified in
    // `decision-register-mutation-coverage.test.ts`); swept by R1 into its sanctioned fixture reset.
    await t.prisma.changeRequest.deleteMany({ where: { projectId } });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const post = (token: string, path: string, body: object, key?: string) => {
    const r = http().post(path).set('Authorization', `Bearer ${token}`);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  const base = () => `/projects/${f.projectA.id}/decisions`;
  const change = { reason: 'Slab cracked', costImpact: 5000, timeImpactDays: 2 };

  const identityName = async (userId: string) =>
    (await t.prisma.$queryRawUnsafe<Array<{ displayName: string }>>(
      `SELECT "displayName" FROM "UserIdentity" WHERE "userId" = $1`, userId,
    ))[0]!.displayName;

  /** A published decision the client has approved. */
  const approvedDecision = async (): Promise<string> => {
    const title = `R0a ${randomUUID().slice(0, 8)}`;
    const created = await post(pmcToken, base(), {
      title, room: 'Kitchen', publish: true,
      options: [
        { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
      ],
    });
    expect(created.status, created.text).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } });
    const approved = await post(clientToken, `${base()}/${d.id}/approve`, { optionIndex: 0 });
    expect(approved.status, approved.text).toBe(201);
    return d.id;
  };

  /** An approved decision with an open change request the PMC raised. */
  const decisionInChange = async (): Promise<{ id: string; requestId: string }> => {
    const id = await approvedDecision();
    const r = await post(pmcToken, `${base()}/${id}/change`, change, randomUUID());
    expect(r.status, r.text).toBe(201);
    const req = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: id, status: 'open' } });
    return { id, requestId: req.id };
  };

  const closureOf = async (requestId: string) => {
    const req = await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: requestId } });
    const receipt = req.resolvedByCommandId
      ? await t.prisma.commandExecution.findUnique({ where: { id: req.resolvedByCommandId } })
      : null;
    return { req, receipt };
  };

  it('an UNKEYED withdrawal writes all six closure fields and cites its own synthesized receipt', async () => {
    const { id, requestId } = await decisionInChange();
    const r = await post(pmcToken, `${base()}/${id}/change/withdraw`, {});
    expect(r.status, r.text).toBe(201);

    const { req, receipt } = await closureOf(requestId);
    const name = await identityName(f.memberUser.id);
    expect(req).toMatchObject({
      status: 'withdrawn', resolution: 'withdrawn', resolvedById: f.memberUser.id,
      resolvedByRole: 'pmc', resolvedByName: name,
    });
    expect(req.resolvedAt).not.toBeNull();
    expect(receipt).toMatchObject({
      commandType: 'decisions.withdrawChange', status: 'succeeded', actorId: f.memberUser.id, resultRef: id,
    });
    expect(receipt?.idempotencyKey).toMatch(/^srv-/);
    // the event names the same act in the same words
    const event = await t.prisma.domainEvent.findFirstOrThrow({ where: { entityId: id, eventType: 'decision.change_withdrawn' } });
    expect(event).toMatchObject({ actorRole: 'pmc', actorName: name });
  });

  it('the RE-APPROVAL closure writes all six, citing the approval receipt', async () => {
    const { id, requestId } = await decisionInChange();
    const key = randomUUID();
    const r = await post(clientToken, `${base()}/${id}/approve`, { optionIndex: 1 }, key);
    expect(r.status, r.text).toBe(201);

    const { req, receipt } = await closureOf(requestId);
    expect(req).toMatchObject({
      status: 'resolved', resolution: 'reapproved', resolvedById: f.clientUser.id,
      resolvedByRole: 'client', resolvedByName: await identityName(f.clientUser.id),
    });
    expect(req.resolvedAt).not.toBeNull();
    expect(receipt).toMatchObject({
      commandType: 'decisions.approve', status: 'succeeded', idempotencyKey: key, actorId: f.clientUser.id, resultRef: id,
    });
  });

  it('a membership-less org owner withdraws ANOTHER user\'s request as pmc', async () => {
    const { id, requestId } = await decisionInChange();
    const r = await post(ownerToken, `${base()}/${id}/change/withdraw`, {}, randomUUID());
    expect(r.status, r.text).toBe(201);
    const { req } = await closureOf(requestId);
    expect(req).toMatchObject({
      status: 'withdrawn', resolvedById: f.ownerUser.id, resolvedByRole: 'pmc', resolvedByName: await identityName(f.ownerUser.id),
    });
  });

  it('a STALE role is refused for withdrawChange, and the request stays open', async () => {
    const { id, requestId } = await decisionInChange();
    const stale = { sub: f.memberUser.id, role: 'engineer', projectId: f.projectA.id } as AuthUser;
    // the pre-check admits the requester; the envelope inside the transaction finds no standing
    await expect(decisions.withdrawChange(f.projectA.id, id, stale, randomUUID()))
      .rejects.toMatchObject({ status: 403, message: STALE_ROLE_MESSAGE });
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('change');
    expect((await closureOf(requestId)).req).toMatchObject({ status: 'open', resolvedById: null, resolvedByCommandId: null });
  });

  it('a STALE role is refused for a no-chain approval, and the decision is not approved', async () => {
    const title = `R0a stale ${randomUUID().slice(0, 8)}`;
    const created = await post(pmcToken, base(), {
      title, room: 'Kitchen', publish: true,
      options: [
        { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
      ],
    });
    expect(created.status, created.text).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } });
    const before = d.status;
    // the client decider whose standing is gone (a client token for the PMC member, who holds `pmc`):
    // the role-standing re-check refuses first when it can; the envelope refusal is the backstop, and
    // either way the decision does not move and no revision is recorded
    const stale = { sub: f.memberUser.id, role: 'client', projectId: f.projectA.id } as AuthUser;
    await expect(decisions.approve(f.projectA.id, d.id, { optionIndex: 0 }, stale, randomUUID())).rejects.toMatchObject({ status: 403 });
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: d.id } })).status).toBe(before);
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: d.id } })).toBe(0);
  });
});
