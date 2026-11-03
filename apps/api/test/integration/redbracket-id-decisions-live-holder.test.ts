import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Redbracket ID A4b-s — the decisions commands judge LIVE holders. An account a first Redbracket ID sign-in retired
 * keeps its seats until the team re-seats the person, and nobody can sign in as it. Since A4b-m the database refuses a
 * publication, a published birth, a reopen or a forward that hands a decision to such holders alone
 * (`Decision_x_live_holder_standing`), but the commands counted EFFECTIVE holders and met that seal as a server error.
 * Here each command refuses the same state first, with a 409 that names the fix, and writes nothing.
 *
 * World: the fixture's live client's seat is ended, and the only client seat left is a RETIRED client's (effective 1,
 * live 0). The pmc role stays live, so a pmc-held decision is the passing control.
 */
describe('Redbracket ID A4b-s — the decisions commands count live holders (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken = '';
  const run = randomUUID().slice(0, 8);
  const retiredClient = `rbid-a4bs-client-${run}`;
  let retiredMembershipId = '';
  let approvedId = '';
  let clientDraftId = '';
  let memberDraftId = '';
  const twoOptions = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];
  const post = (token: string, path: string, body: Record<string, unknown>) =>
    request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body);
  const create = async (body: Record<string, unknown>) =>
    post(pmcToken, `/projects/${f.projectA.id}/decisions`, { title: `A4b-s ${randomUUID().slice(0, 6)}`, room: 'Kitchen', options: twoOptions, ...body });
  const idOf = async (res: request.Response) => {
    expect(res.status, res.text).toBe(201);
    return (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id }, orderBy: { createdAt: 'desc' } })).id;
  };
  const RETIRED_ROLE = /This project's only client holders are accounts retired by Redbracket ID, which nobody can sign in as — re-seat the person first/;
  const RETIRED_NAMED = /The named decider's account was retired by Redbracket ID/;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    await t.prisma.user.create({ data: { id: retiredClient, projectId: f.projectA.id, role: 'client', name: 'A4b-s retired client', email: `${retiredClient}@test.local` } });
    retiredMembershipId = (await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: retiredClient, role: 'client', status: 'active' } })).id;
    await t.prisma.$executeRawUnsafe(`INSERT INTO "IdentityRetirement" ("userId", "email") SELECT "id", "email" FROM "User" WHERE "id" = $1`, retiredClient);
    // while the live client still holds the role: an approved decision (for the reopen) and two drafts
    approvedId = await idOf(await create({ publish: true, deciderKind: 'client' }));
    const clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    const approved = await post(clientToken, `/projects/${f.projectA.id}/decisions/${approvedId}/approve`, { optionIndex: 0 });
    expect(approved.status, approved.text).toBe(201);
    clientDraftId = await idOf(await create({ publish: false, deciderKind: 'client' }));
    memberDraftId = await idOf(await create({ publish: false, deciderKind: 'member', deciderMembershipId: retiredMembershipId }));
    // the live client's seat ends (no open client-held decision, so no seal refuses it): live client 0, effective 1
    await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId: f.clientUser.id }, data: { status: 'removed' } });
  });

  afterAll(async () => {
    const ids = [f.projectA.id, f.projectB.id];
    await t?.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "ChangeRequest" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionApprovalRevision" DISABLE TRIGGER USER'),
      t.prisma.decisionApprovalRevision.deleteMany({ where: { decision: { projectId: { in: ids } } } }),
      t.prisma.changeRequest.deleteMany({ where: { decision: { projectId: { in: ids } } } }),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: { in: ids } } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: { in: ids } } } }),
      t.prisma.activity.deleteMany({ where: { projectId: { in: ids } } }),
      t.prisma.decision.deleteMany({ where: { projectId: { in: ids } } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionApprovalRevision" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "ChangeRequest" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER USER'),
    ]);
    // seats before the retired user (the User-row guard refuses a retired user who still holds one)
    await t.prisma.membership.deleteMany({ where: { userId: retiredClient } });
    await t.prisma.user.deleteMany({ where: { id: retiredClient } });
    await f?.cleanup();
    await t?.close();
  });

  it('a published birth held by a role whose only holders are retired is refused 409, and nothing is written', async () => {
    const before = await t.prisma.decision.count({ where: { projectId: f.projectA.id } });
    const res = await create({ publish: true, deciderKind: 'client' });
    expect(res.status, res.text).toBe(409);
    expect(res.text).toMatch(RETIRED_ROLE);
    expect(await t.prisma.decision.count({ where: { projectId: f.projectA.id } })).toBe(before);
  });

  it('a published birth naming a retired account\'s membership is refused 409', async () => {
    const res = await create({ publish: true, deciderKind: 'member', deciderMembershipId: retiredMembershipId });
    expect(res.status, res.text).toBe(409);
    expect(res.text).toMatch(RETIRED_NAMED);
  });

  it('publishing a draft to retired holders alone is refused 409 (role and named member); the draft stays a draft', async () => {
    const role = await post(pmcToken, `/projects/${f.projectA.id}/decisions/${clientDraftId}/publish`, {});
    expect(role.status, role.text).toBe(409);
    expect(role.text).toMatch(RETIRED_ROLE);
    const named = await post(pmcToken, `/projects/${f.projectA.id}/decisions/${memberDraftId}/publish`, {});
    expect(named.status, named.text).toBe(409);
    expect(named.text).toMatch(RETIRED_NAMED);
    const rows = await t.prisma.decision.findMany({ where: { id: { in: [clientDraftId, memberDraftId] } }, select: { publishedAt: true } });
    expect(rows.map((r) => r.publishedAt)).toEqual([null, null]);
  });

  it('reopening an approved decision for retired holders alone is refused 409; it stays approved, with no change request', async () => {
    const res = await post(pmcToken, `/projects/${f.projectA.id}/decisions/${approvedId}/change`, { reason: 'Slab cracked', costImpact: 0, timeImpactDays: 0 });
    expect(res.status, res.text).toBe(409);
    expect(res.text).toMatch(/This project's only client holders are accounts retired by Redbracket ID[\s\S]*then request the change/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: approvedId } })).status).toBe('approved');
    expect(await t.prisma.changeRequest.count({ where: { decisionId: approvedId } })).toBe(0);
  });

  it('a role with a live holder still publishes (the pmc control)', async () => {
    expect((await create({ publish: true, deciderKind: 'pmc' })).status).toBe(201);
  });
});
