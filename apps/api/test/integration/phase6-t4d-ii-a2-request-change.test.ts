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
 * Phase 6 task 4d unit 4d-ii-a / A2 — `decisions.requestChange` records its provenance and the frozen
 * requester pair, proven against live PostgreSQL and 4d-i's `ChangeRequest` seals.
 *
 * §A.3 obligations 3, 6 and 7:
 * - the request's `requestedByRole`/`requestedByName` pair is resolved INSIDE the command's
 *   transaction, by the predicate and identity read `ChangeRequest_t4d_birth_pair` judges it with;
 * - ONE resolution feeds the request, its `change_requested` audit row and its
 *   `decision.change_requested` event envelope, so the three records of the act agree;
 * - the request cites the receipt that opened it (`sourceCommandId`), and that receipt names the
 *   request (`resultRef`), which the deferred `ChangeRequest_t4d_source_bound` requires;
 * - an unkeyed call still reserves a receipt (server key synthesis), so the column is never NULL on
 *   a request this release writes.
 */
describe('4d-ii-a / A2 — requestChange provenance and the frozen requester pair (live PG)', () => {
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
    // `decision-register-mutation-coverage.test.ts`); the audit rows and the decisions go through
    // the named fixtures, which hold each seal bypass inside one transaction.
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
  const change = { reason: 'Slab cracked', costImpact: 5000, timeImpactDays: 2 };

  /** A published decision the client has approved: the state `requestChange` opens a request on. */
  const approvedDecision = async (): Promise<string> => {
    const title = `A2 ${randomUUID().slice(0, 8)}`;
    const created = await post(pmcToken, `/projects/${f.projectA.id}/decisions`, {
      title, room: 'Kitchen', publish: true,
      options: [
        { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
        { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
      ],
    });
    expect(created.status, created.text).toBe(201);
    const d = await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } });
    const approved = await post(clientToken, `/projects/${f.projectA.id}/decisions/${d.id}/approve`, { optionIndex: 0 });
    expect(approved.status, approved.text).toBe(201);
    return d.id;
  };

  const identityName = async (userId: string) =>
    (await t.prisma.$queryRawUnsafe<Array<{ displayName: string }>>(
      `SELECT "displayName" FROM "UserIdentity" WHERE "userId" = $1`, userId,
    ))[0]!.displayName;

  /** The three records of one request: the fact, its audit row, its event, and the receipt. */
  const recordsOf = async (decisionId: string) => {
    const req = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId, status: 'open' } });
    const audit = await t.prisma.decisionEvent.findFirstOrThrow({ where: { decisionId, type: 'change_requested' } });
    const event = await t.prisma.domainEvent.findFirstOrThrow({
      where: { projectId: f.projectA.id, entityType: 'Decision', entityId: decisionId, eventType: 'decision.change_requested' },
    });
    const receipt = req.sourceCommandId
      ? await t.prisma.commandExecution.findUnique({ where: { id: req.sourceCommandId } })
      : null;
    return { req, audit, event, receipt };
  };

  it('a keyed request freezes the requester pair and cites the receipt that names it', async () => {
    const id = await approvedDecision();
    const key = randomUUID();
    const r = await post(pmcToken, `/projects/${f.projectA.id}/decisions/${id}/change`, change, key);
    expect(r.status, r.text).toBe(201);

    const { req, audit, event, receipt } = await recordsOf(id);
    const name = await identityName(f.memberUser.id);
    expect(req).toMatchObject({ requestedById: f.memberUser.id, requestedByRole: 'pmc', requestedByName: name });
    // one resolution, three records
    expect(event).toMatchObject({ actorId: f.memberUser.id, actorRole: 'pmc', actorName: name });
    expect(audit).toMatchObject({ actorId: f.memberUser.id, actorRole: 'pmc', actorName: name });
    // provenance in both directions
    expect(receipt).toMatchObject({
      commandType: 'decisions.requestChange', status: 'succeeded', idempotencyKey: key,
      actorId: f.memberUser.id, resultRef: req.id,
    });

    // a replay under the same key is the same act: no second request
    const again = await post(pmcToken, `/projects/${f.projectA.id}/decisions/${id}/change`, change, key);
    expect(again.status, again.text).toBe(201);
    expect(await t.prisma.changeRequest.count({ where: { decisionId: id } })).toBe(1);
  });

  it('an unkeyed request still cites a receipt: the server synthesizes one', async () => {
    const id = await approvedDecision();
    const r = await post(pmcToken, `/projects/${f.projectA.id}/decisions/${id}/change`, change);
    expect(r.status, r.text).toBe(201);
    const { req, receipt } = await recordsOf(id);
    expect(req.sourceCommandId, 'the request this release writes always names its receipt').not.toBeNull();
    expect(receipt?.idempotencyKey).toMatch(/^srv-/);
    expect(receipt?.resultRef).toBe(req.id);
  });

  it('a membership-less org owner requests as pmc: the race-free arm admits the pair', async () => {
    const id = await approvedDecision();
    const r = await post(ownerToken, `/projects/${f.projectA.id}/decisions/${id}/change`, change, randomUUID());
    expect(r.status, r.text).toBe(201);
    const { req, event } = await recordsOf(id);
    const name = await identityName(f.ownerUser.id);
    expect(req).toMatchObject({ requestedById: f.ownerUser.id, requestedByRole: 'pmc', requestedByName: name });
    expect(event).toMatchObject({ actorRole: 'pmc', actorName: name });
  });

  it('a token role the requester does not hold is REFUSED with a re-sign-in, and nothing is recorded (4d-iii / R0a, Decision 2)', async () => {
    // Driven at the service: the HTTP guard refuses a role the user does not hold, so this is the
    // stale-token case (a re-role that committed after the token was issued). The pair is never
    // replaced by a role the actor does hold, and since the Board's Decision 2 it is never written
    // NULL either: the act is refused and the decision stays where it was.
    const id = await approvedDecision();
    const stale = { sub: f.memberUser.id, role: 'engineer', projectId: f.projectA.id } as AuthUser;
    await expect(decisions.requestChange(f.projectA.id, id, change, stale, randomUUID()))
      .rejects.toMatchObject({ status: 403, message: STALE_ROLE_MESSAGE });
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('approved');
    expect(await t.prisma.changeRequest.count({ where: { decisionId: id } })).toBe(0);
    expect(await t.prisma.domainEvent.count({ where: { entityId: id, eventType: 'decision.change_requested' } })).toBe(0);
  });

  it('two simultaneous requests: one winner, one 409, one request (no deadlock between their receipts)', async () => {
    const id = await approvedDecision();
    const results = await Promise.all([
      post(pmcToken, `/projects/${f.projectA.id}/decisions/${id}/change`, change, randomUUID()),
      post(clientToken, `/projects/${f.projectA.id}/decisions/${id}/change`, change, randomUUID()),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await t.prisma.changeRequest.count({ where: { decisionId: id } })).toBe(1);
  });
});
