import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A3b — `members.add`, `members.updateRole` and `members.remove` as
 * ledger commands, each writing its `MembershipTransition` FIRST, proven against live PostgreSQL
 * and 4d-i's membership seals:
 *
 * - `MembershipTransition_t4d_seal` (BEFORE INSERT): the fact precedes the membership write, the
 *   actor holds owner/admin authority or active `pmc` standing, and the frozen pair is theirs;
 * - `Membership_t4d_fact_first` (immediate): under a member receipt, no membership write before
 *   its fact;
 * - `MembershipTransition_t4d_provenance_bound` (deferred): the receipt succeeded in THIS
 *   transaction, is a member command of the transition's shape, was run by the fact's actor and
 *   names the MEMBERSHIP as its result, and the membership ends where the fact says.
 *
 * Each command below COMMITS under those seals, which is the proof the service writes in the
 * order and shape they demand. The P29b no-header arms are here: every command driven exactly as
 * a deployed tab calls it, with no `Idempotency-Key`, and each again with a key replaying once.
 */
describe('4d-ii-a / A3b — the member commands write their transition fact first (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let ownerToken: string;
  const run = randomUUID().slice(0, 8);
  const email = (label: string) => `a3b-${label}-${run}@test.local`;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    ownerToken = t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id);
  });

  afterAll(async () => {
    // The facts are immutable; the sanctioned reset is TRUNCATE. Then the identities this suite
    // provisioned (their `User.projectId` would hold the fixture's project), then the fixture.
    await sanctionedReset(t.prisma, ['MembershipTransition'], { cascade: true });
    const provisioned = await t.prisma.user.findMany({ where: { email: { startsWith: 'a3b-', endsWith: `-${run}@test.local` } }, select: { id: true } });
    const ids = provisioned.map((u) => u.id);
    await t.prisma.membership.deleteMany({ where: { userId: { in: ids } } });
    await t.prisma.securityAuditEvent.deleteMany({ where: { OR: [{ targetUserId: { in: ids } }, { actorUserId: { in: ids } }] } });
    await t.prisma.commandExecution.deleteMany({ where: { actorId: { in: ids } } });
    await t.prisma.user.deleteMany({ where: { id: { in: ids } } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const base = () => `/projects/${f.projectA.id}/members`;
  const withKey = <R extends { set: (k: string, v: string) => R }>(r: R, key?: string) => (key ? r.set('Idempotency-Key', key) : r);
  const add = (token: string, body: object, key?: string) => withKey(http().post(base()).set('Authorization', `Bearer ${token}`), key).send(body);
  const patch = (token: string, userId: string, body: object, key?: string) => withKey(http().patch(`${base()}/${userId}`).set('Authorization', `Bearer ${token}`), key).send(body);
  const del = (token: string, userId: string, key?: string) => withKey(http().delete(`${base()}/${userId}`).set('Authorization', `Bearer ${token}`), key).send();

  const identityName = async (userId: string) =>
    (await t.prisma.$queryRawUnsafe<Array<{ displayName: string }>>(`SELECT "displayName" FROM "UserIdentity" WHERE "userId" = $1`, userId))[0]!.displayName;
  const factsOf = (membershipId: string) =>
    t.prisma.membershipTransition.findMany({ where: { projectId: f.projectA.id, membershipId }, orderBy: { at: 'asc' } });
  const receiptOf = (id: string) => t.prisma.commandExecution.findUniqueOrThrow({ where: { id } });

  /** Add someone new with no key (a deployed tab) and return their user and membership ids. */
  const addNew = async (label: string, role: string, token = pmcToken) => {
    const r = await add(token, { name: `A3b ${label}`, role, email: email(label) });
    expect(r.status, r.text).toBe(201);
    return { userId: r.body.userId as string, membershipId: r.body.membershipId as string };
  };

  it('NO-HEADER members.add commits its fact with a synthesized receipt that names the membership', async () => {
    const { userId, membershipId } = await addNew('nohdr-add', 'engineer');
    const [fact, ...more] = await factsOf(membershipId);
    expect(more).toHaveLength(0);
    expect(fact).toMatchObject({
      userId, fromRole: null, fromStatus: null, toRole: 'engineer', toStatus: 'active',
      actorId: f.memberUser.id, actorRole: 'pmc', actorName: await identityName(f.memberUser.id),
    });
    expect(fact!.sourceCommandId).toBeTruthy();
    const receipt = await receiptOf(fact!.sourceCommandId);
    expect(receipt).toMatchObject({ commandType: 'members.add', status: 'succeeded', resultRef: membershipId, actorId: f.memberUser.id });
    expect(receipt.idempotencyKey).toMatch(/^srv-/);
    expect(await t.prisma.membership.findUniqueOrThrow({ where: { id: membershipId } })).toMatchObject({ role: 'engineer', status: 'active' });
  });

  it('a KEYED members.add replays exactly once: one identity, one membership, one fact', async () => {
    const key = randomUUID();
    const body = { name: 'A3b keyed', role: 'contractor', email: email('keyed-add') };
    const first = await add(pmcToken, body, key);
    expect(first.status, first.text).toBe(201);
    const again = await add(pmcToken, body, key);
    expect(again.status, again.text).toBe(201);
    expect(again.body.membershipId).toBe(first.body.membershipId);
    expect(await t.prisma.user.count({ where: { email: email('keyed-add') } })).toBe(1);
    const facts = await factsOf(first.body.membershipId);
    expect(facts).toHaveLength(1);
    expect(await receiptOf(facts[0]!.sourceCommandId)).toMatchObject({ idempotencyKey: key, status: 'succeeded' });
  });

  it('NO-HEADER members.updateRole commits (old, active) → (new, active); KEYED replays once', async () => {
    const { membershipId, userId } = await addNew('nohdr-role', 'engineer');
    const r = await patch(pmcToken, userId, { role: 'contractor' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ role: 'contractor', membershipId });
    const facts = await factsOf(membershipId);
    expect(facts.at(-1)).toMatchObject({ fromRole: 'engineer', fromStatus: 'active', toRole: 'contractor', toStatus: 'active', actorRole: 'pmc' });
    expect(await receiptOf(facts.at(-1)!.sourceCommandId)).toMatchObject({ commandType: 'members.updateRole', resultRef: membershipId });

    const key = randomUUID();
    expect((await patch(pmcToken, userId, { role: 'engineer' }, key)).status).toBe(200);
    expect((await patch(pmcToken, userId, { role: 'engineer' }, key)).status).toBe(200);
    expect(await factsOf(membershipId)).toHaveLength(facts.length + 1);
  });

  it('NO-HEADER members.remove commits (role, active) → (role, removed); KEYED replays once', async () => {
    const a = await addNew('nohdr-remove', 'engineer');
    expect((await del(pmcToken, a.userId)).status).toBe(200);
    expect((await factsOf(a.membershipId)).at(-1)).toMatchObject({ fromRole: 'engineer', fromStatus: 'active', toRole: 'engineer', toStatus: 'removed' });
    expect(await t.prisma.membership.findUniqueOrThrow({ where: { id: a.membershipId } })).toMatchObject({ status: 'removed' });

    const b = await addNew('keyed-remove', 'engineer');
    const key = randomUUID();
    expect((await del(pmcToken, b.userId, key)).status).toBe(200);
    expect((await del(pmcToken, b.userId, key)).status).toBe(200);
    expect(await factsOf(b.membershipId)).toHaveLength(2); // the add, then ONE removal
  });

  it('re-adding a REMOVED member goes through members.add, from `removed`, on the same membership', async () => {
    const { userId, membershipId } = await addNew('readd', 'engineer');
    expect((await del(pmcToken, userId)).status).toBe(200);
    const back = await add(pmcToken, { name: 'A3b readd', role: 'contractor', email: email('readd') });
    expect(back.status, back.text).toBe(201);
    expect(back.body.membershipId).toBe(membershipId);
    expect((await factsOf(membershipId)).at(-1)).toMatchObject({ fromRole: 'engineer', fromStatus: 'removed', toRole: 'contractor', toStatus: 'active' });
  });

  it('a membership-less org OWNER manages the team: the fact freezes `pmc` from the race-free derivation', async () => {
    const { membershipId } = await addNew('by-owner', 'engineer', ownerToken);
    expect((await factsOf(membershipId))[0]).toMatchObject({ actorId: f.ownerUser.id, actorRole: 'pmc', actorName: await identityName(f.ownerUser.id) });
  });

  it('a PMC re-roling THEMSELVES is recorded as the PMC they were: the fact is judged against the pre-state', async () => {
    const pmc2 = await addNew('self-pmc', 'pmc');
    const self = t.issueProjectToken(pmc2.userId, f.projectA.id);
    const r = await patch(self, pmc2.userId, { role: 'engineer' });
    expect(r.status, r.text).toBe(200);
    expect((await factsOf(pmc2.membershipId)).at(-1)).toMatchObject({
      actorId: pmc2.userId, actorRole: 'pmc', fromRole: 'pmc', toRole: 'engineer', toStatus: 'active',
    });
    expect(await t.prisma.membership.findUniqueOrThrow({ where: { id: pmc2.membershipId } })).toMatchObject({ role: 'engineer' });
  });

  it('a stale `pmc` token whose standing is gone has no pair to freeze — 403, and nothing is written', async () => {
    const ex = await addNew('stale-pmc', 'pmc');
    const stale = t.issueProjectToken(ex.userId, f.projectA.id);
    expect((await patch(pmcToken, ex.userId, { role: 'engineer' })).status).toBe(200);
    const before = await t.prisma.membershipTransition.count({ where: { projectId: f.projectA.id } });
    const r = await add(stale, { name: 'A3b by stale', role: 'engineer', email: email('by-stale') });
    expect(r.status, r.text).toBe(403);
    expect(await t.prisma.membershipTransition.count({ where: { projectId: f.projectA.id } })).toBe(before);
    // the identity provisioning ran INSIDE the refused command, so it rolled back with it
    expect(await t.prisma.user.count({ where: { email: email('by-stale') } })).toBe(0);
  });

  it('a DISCIPLINE-only change writes no fact and no MEMBER receipt (it is receipted as members.updateDiscipline), and still emits its own event', async () => {
    const r = await add(pmcToken, { name: 'A3b lumen', role: 'consultant', discipline: 'lighting', email: email('lumen') });
    expect(r.status, r.text).toBe(201);
    const { userId, membershipId } = r.body as { userId: string; membershipId: string };
    const receiptsBefore = await t.prisma.commandExecution.count({ where: { projectId: f.projectA.id, commandType: 'members.updateRole' } });
    const moved = await patch(pmcToken, userId, { role: 'consultant', discipline: 'acoustics' });
    expect(moved.status, moved.text).toBe(200);
    expect(moved.body).toMatchObject({ role: 'consultant', discipline: 'acoustics' });
    expect(await factsOf(membershipId)).toHaveLength(1); // the add only
    expect(await t.prisma.commandExecution.count({ where: { projectId: f.projectA.id, commandType: 'members.updateRole' } })).toBe(receiptsBefore);
    expect(await t.prisma.commandExecution.count({ where: { projectId: f.projectA.id, commandType: 'members.updateDiscipline', resultRef: membershipId } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: f.projectA.id, entityId: userId, eventType: 'membership.discipline_changed' } })).toBe(1);
  });

  // #647's review, findings 4115635418 and 4115635421 — a no-op must still CONSUME the caller's key,
  // or a retry after someone else changed the membership executes instead of replaying the no-op.
  it('a KEYED no-op PATCH replays after another manager re-roles the member — the retry does not undo their change', async () => {
    const { userId, membershipId } = await addNew('noop-patch', 'engineer');
    const key = randomUUID();
    const noop = await patch(pmcToken, userId, { role: 'engineer' }, key);
    expect(noop.status, noop.text).toBe(200);
    expect(await receiptOf((await t.prisma.commandExecution.findFirstOrThrow({ where: { idempotencyKey: key } })).id))
      .toMatchObject({ commandType: 'members.updateDiscipline', status: 'succeeded', resultRef: membershipId });
    expect((await patch(ownerToken, userId, { role: 'contractor' })).status).toBe(200);
    const retry = await patch(pmcToken, userId, { role: 'engineer' }, key);
    expect(retry.status, retry.text).toBe(200);
    expect(await t.prisma.membership.findUniqueOrThrow({ where: { id: membershipId } })).toMatchObject({ role: 'contractor' });
    expect(await t.prisma.commandExecution.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it('a KEYED DELETE of an already-removed member replays after they are re-added — the retry does not remove them again', async () => {
    const { userId, membershipId } = await addNew('noop-delete', 'engineer');
    expect((await del(pmcToken, userId)).status).toBe(200);
    const key = randomUUID();
    expect((await del(pmcToken, userId, key)).status).toBe(200);
    expect((await add(pmcToken, { name: 'A3b noop-delete', role: 'engineer', email: email('noop-delete') })).status).toBe(201);
    expect((await del(pmcToken, userId, key)).status).toBe(200);
    expect(await t.prisma.membership.findUniqueOrThrow({ where: { id: membershipId } })).toMatchObject({ status: 'active' });
    expect(await t.prisma.commandExecution.findMany({ where: { idempotencyKey: key } }))
      .toMatchObject([{ commandType: 'members.remove', status: 'succeeded', resultRef: membershipId }]);
  });

  it('the shapes 4d-i refuses for a member receipt are refused by the service first, recording nothing', async () => {
    const a = await addNew('shapes', 'engineer');
    const facts = async () => (await factsOf(a.membershipId)).length;
    const n = await facts();
    // an add over an ACTIVE member is a re-role, not an add
    expect((await add(pmcToken, { name: 'A3b shapes', role: 'contractor', email: email('shapes') })).status).toBe(409);
    // an add asking for exactly what they already are succeeds and records nothing
    expect((await add(pmcToken, { name: 'A3b shapes', role: 'engineer', email: email('shapes') })).status).toBe(201);
    expect(await facts()).toBe(n);
    // a removed member's role cannot be changed; removing them again records nothing
    expect((await del(pmcToken, a.userId)).status).toBe(200);
    expect((await patch(pmcToken, a.userId, { role: 'contractor' })).status).toBe(409);
    expect((await del(pmcToken, a.userId)).status).toBe(200);
    expect(await facts()).toBe(n + 1);
  });
});
