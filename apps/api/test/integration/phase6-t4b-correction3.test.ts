import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { ROLE_POLICY } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, seedProjectClient, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { MembersService } from '../../src/orgs/members.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i — the ROUND-3 CORRECTION (Codex, seven findings on head `2ef9d68`).
 *
 * Four P1 and three P2. Every probe here was RED at `2ef9d68` with `20270818000000` AND the
 * service half reverted, so each failure is behaviour and never a missing symbol.
 *
 * The round's shape, stated plainly because it is the same shape the convergence audit named: four
 * of the seven are a guard that was RIGHT about one dimension and silent about another — the act
 * tuple's timing without its party, the identity freeze's publication without its birth, the
 * reopen seal's one named pair without the state it protects, the org arm's event without the
 * standing it governs.
 */
describe('Phase 6 unit 4b-i round 3 — the seven Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let members: MembersService;
  let seq = 0;
  let raceDb: PrismaClient;

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    members = t.app.get(MembersService);
    raceDb = new PrismaClient();
    await raceDb.$connect();
  });
  afterAll(async () => {
    await raceDb?.$disconnect();
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    await t.prisma.decisionApprovalRevision.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: f.strangerUser.id } });
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.clientUser.id },
      data: { role: 'client', status: 'active' },
    });
    // R3-6 drops the fixture's pmc membership to bring effective standing to exactly one, and a
    // probe that only restores shared state ON SUCCESS makes every later probe depend on it
    // passing — which is how the RED pass first reported R3-7 failing for R3-6's reason. The
    // restoration is unconditional and lives here, where a failure cannot skip it.
    if (!(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId: f.memberUser.id } }))) {
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    }
    await t.prisma.orgMembership.updateMany({ where: { orgId: f.orgA.id, userId: f.ownerUser.id }, data: { role: 'owner' } });
    await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgA.id, userId: f.strangerUser.id } });
  });

  /** A published ordinary (client-held) decision with its two options. */
  const seedOrdinary = async (): Promise<string> => {
    const id = `DL-t4bc3-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Ordinary ${id}`, room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    return id;
  };

  // ── R3-1 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R3-1: the act tuple must record the DECIDER — the right moment is not the right party', async () => {
    const id = await seedOrdinary(); // client-held
    // at `2ef9d68` this was ACCEPTED: the transition test passed (pending → approved), the pair
    // CHECK passed (`pmc` legitimately carries no membership id), and round 2's write-once arms
    // then made the forged attribution permanent.
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision"
         SET "status"='approved', "approvedDeciderKind"='pmc', "approvedDeciderLabel"='Forged Holder'
       WHERE "id" = ${id}`,
    ).rejects.toThrow(/must record the decider/);
    const after = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('pending');
    expect(after.approvedDeciderKind).toBeNull();

    // …and a member-held decision cannot be approved in the name of a DIFFERENT membership
    const holder = await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.clientUser.id } });
    const other = await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.memberUser.id } });
    const memberHeld = `DL-t4bc3-mem-${seq++}`;
    await t.prisma.decision.create({
      data: { id: memberHeld, projectId: f.projectA.id, title: 'Member held', room: 'K', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, deciderKind: 'member', deciderMembershipId: holder.id, publishedAt: null },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: memberHeld, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', order: 0 },
      { decisionId: memberHeld, label: 'B', optionKey: 'b', material: 'Oak', delta: 1, swatch: 'sw2', order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id: memberHeld }, data: { publishedAt: new Date() } });
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision"
         SET "status"='approved', "approvedDeciderKind"='member', "approvedDeciderMembershipId"=${other.id}, "approvedDeciderLabel"='Someone else'
       WHERE "id" = ${memberHeld}`,
    ).rejects.toThrow(/decider's own membership/);

    // PRECISION — the real act still writes the tuple, so the seal is exact and not merely strict
    const fresh = await seedOrdinary();
    await svc.approve(f.projectA.id, fresh, { optionIndex: 0 }, pmc());
    const approved = await t.prisma.decision.findUniqueOrThrow({ where: { id: fresh } });
    expect(approved.approvedDeciderKind).toBe('client');
  });

  // ── R3-2 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R3-2: the approve ROUTE CEILING admits every role that can be NAMED — the service still narrows to the holder', async () => {
    // The service comment and this PR's own invariant matrix both claimed the ceiling already
    // admitted every role that can hold a decision. It did not: `['client','pmc']` meant a named
    // contractor/engineer/consultant was refused by RolesGuard BEFORE the holder check ran, so the
    // primary member-decider flow could not work through the API at all.
    for (const role of ['client', 'pmc', 'contractor', 'engineer', 'consultant']) {
      expect(ROLE_POLICY['decision.approve'], `${role} must be admitted by the route ceiling`).toContain(role);
    }

    // …and the SERVICE is still the narrowing: a member-held decision names ONE membership, and a
    // caller who is not that member (and is not the pmc) is refused there.
    const holder = await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.clientUser.id } });
    const id = `DL-t4bc3-ceil-${seq++}`;
    await t.prisma.decision.create({
      data: { id, projectId: f.projectA.id, title: 'Named holder', room: 'K', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, deciderKind: 'member', deciderMembershipId: holder.id, publishedAt: null },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 1, swatch: 'sw2', order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });

    const stranger: AuthUser = { sub: f.strangerUser.id, role: 'contractor', projectId: f.projectA.id } as AuthUser;
    await expect(svc.approve(f.projectA.id, id, { optionIndex: 0 }, stranger)).rejects.toThrow(/only the decider/i);

    // the NAMED holder approves, and the act records them
    const named: AuthUser = { sub: f.clientUser.id, role: 'client', projectId: f.projectA.id } as AuthUser;
    await svc.approve(f.projectA.id, id, { optionIndex: 0 }, named);
    const done = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(done.status).toBe('approved');
    expect(done.approvedDeciderKind).toBe('member');
    expect(done.approvedDeciderMembershipId).toBe(holder.id);
  });

  // ── R3-3 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R3-3: a decision keeps its identity FROM BIRTH — a draft cannot be re-keyed and published in one statement', async () => {
    const draftId = `DL-t4bc3-key-${seq++}`;
    await t.prisma.decision.create({
      data: { id: draftId, projectId: f.projectA.id, title: 'Re-keyable', room: 'K', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: draftId, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', order: 0 },
      { decisionId: draftId, label: 'B', optionKey: 'b', material: 'Oak', delta: 1, swatch: 'sw2', order: 1 },
    ] });
    // at `2ef9d68` the guard read `OLD."publishedAt" IS NOT NULL`, so this ONE statement re-keyed
    // AND published — options and events cascade, but DomainEvent.entityId and the command
    // receipt's resultRef keep the old id and are silently orphaned from the published decision.
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision" SET "id"='DL-t4bc3-renamed', "publishedAt"=now() WHERE "id" = ${draftId}`,
    ).rejects.toThrow(/keeps the identity it was filed under/);
    expect(await t.prisma.decision.count({ where: { id: draftId } })).toBe(1);
    // a plain draft re-key is refused too — the freeze is at BIRTH, not at publication
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision" SET "id"='DL-t4bc3-renamed2' WHERE "id" = ${draftId}`,
    ).rejects.toThrow(/keeps the identity it was filed under/);
    // PRECISION: an ordinary draft edit that does NOT touch the id still passes
    expect(await t.prisma.$executeRaw`UPDATE "Decision" SET "title"='Renamed title' WHERE "id" = ${draftId}`).toBe(1);
  });

  // ── R3-4 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R3-4: EVERY transition back into an open status revalidates the holder — not just approved → change', async () => {
    const holder = await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.clientUser.id } });
    const id = `DL-t4bc3-reopen-${seq++}`;
    await t.prisma.decision.create({
      data: { id, projectId: f.projectA.id, title: 'Member held, approved', room: 'K', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, deciderKind: 'member', deciderMembershipId: holder.id, publishedAt: null },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 1, swatch: 'sw2', order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    const named: AuthUser = { sub: f.clientUser.id, role: 'client', projectId: f.projectA.id } as AuthUser;
    await svc.approve(f.projectA.id, id, { optionIndex: 0 }, named);

    // the holder may LEGALLY leave while the decision is closed — the removal guard cannot see an
    // approved decision, and that is deliberate
    await t.prisma.membership.update({ where: { id: holder.id }, data: { status: 'removed' } });

    // at `2ef9d68` the seal covered `approved → change` only, so THIS reopened a published
    // decision whose named holder is inactive — openly holderless, through the unsealed door
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision" SET "status"='pending' WHERE "id" = ${id}`,
    ).rejects.toThrow(/has left the project/);
    // the originally-sealed door stays sealed
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision" SET "status"='change' WHERE "id" = ${id}`,
    ).rejects.toThrow(/has left the project/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('approved');

    // PRECISION — with the holder ACTIVE again, the same reopen passes
    await t.prisma.membership.update({ where: { id: holder.id }, data: { status: 'active' } });
    expect(await t.prisma.$executeRaw`UPDATE "Decision" SET "status"='pending' WHERE "id" = ${id}`).toBe(1);
  });

  // ── R3-5 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R3-5: the departing role is read from the LOCKED row — a concurrent role change cannot make the subtraction stale', async () => {
    await seedProjectClient(t.prisma, f.projectA.id, f.strangerUser.id);
    await seedOrdinary(); // published, OPEN, client-held

    // Two active clients. Removing either is legal (the other still covers the role) and the
    // guard must agree with the seal in BOTH orderings — including when the OTHER client's role
    // changes between the caller's advisory pre-read and the transaction.
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.strangerUser.id }, data: { role: 'client' },
    });
    await expect(members.remove(f.projectA.id, pmc(), f.strangerUser.id)).resolves.toEqual({ ok: true });

    // and the last remaining client is still refused, with the actionable 409 rather than a 500
    await expect(members.remove(f.projectA.id, pmc(), f.clientUser.id)).rejects.toThrow(/holds a published open decision/);

    // the LOCK is what the finding is about: the row the guard subtracts is read inside the
    // transaction, so it is the row the seal will see as OLD. Prove the read is locked by holding
    // it from a second session and confirming the command WAITS rather than reading a stale role.
    const g = (() => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; })();
    let held!: () => void;
    const heldP = new Promise<void>((r) => (held = r));
    const holdTx = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT "id" FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE`,
        f.projectA.id, f.clientUser.id,
      );
      held();
      await g.p;
    }, { timeout: 20_000, maxWait: 10_000 });
    await heldP;
    let settled = false;
    const attempt = members.remove(f.projectA.id, pmc(), f.clientUser.id)
      .then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < 60 && !settled; i++) await new Promise((r) => setTimeout(r, 50));
    expect(settled, 'the command must WAIT on the held membership row, not read around it').toBe(false);
    g.open();
    await holdTx;
    await attempt;
  });

  // ── R3-6 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R3-6: the org arm judges only the standing the WRITTEN ROW supplies — a plain member and an owner↔admin move are not its business', async () => {
    // one explicit pmc on projectA and an open pmc-held decision: `standing <= 1` is true by
    // construction, which is precisely why an unnarrowed arm rejects everything.
    const id = `DL-t4bc3-org-${seq++}`;
    await t.prisma.decision.create({
      data: { id, projectId: f.projectA.id, title: 'PMC held', room: 'K', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, deciderKind: 'pmc', publishedAt: null },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 1, swatch: 'sw2', order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });

    // Bring effective pmc standing to EXACTLY ONE, which is the state that makes the unnarrowed
    // arm reject everything: drop the explicit pmc membership so the org owner is the sole
    // effective pmc. (That removal is itself legal — the seal subtracts the departing membership
    // and one holder survives.)
    await t.prisma.$executeRawUnsafe(
      `DELETE FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2`, f.projectA.id, f.memberUser.id,
    );
    const orgOwner = await t.prisma.orgMembership.findFirstOrThrow({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } });

    // an unrelated PLAIN org member — supplies no pmc standing anywhere, at `2ef9d68` refused
    const plain = await t.prisma.orgMembership.create({
      data: { orgId: f.orgA.id, userId: f.strangerUser.id, role: 'member' },
    });
    expect(await t.prisma.$executeRaw`DELETE FROM "OrgMembership" WHERE "id" = ${plain.id}`).toBe(1);

    // owner ↔ admin — standing is unchanged in both directions, at `2ef9d68` refused
    expect(await t.prisma.$executeRaw`UPDATE "OrgMembership" SET "role"='admin' WHERE "id" = ${orgOwner.id}`).toBe(1);
    expect(await t.prisma.$executeRaw`UPDATE "OrgMembership" SET "role"='owner' WHERE "id" = ${orgOwner.id}`).toBe(1);

    // PRECISION — the arm still fires for the write it DOES govern: the sole effective pmc's own
    // org standing, whose removal strands the pmc-held decision.
    await expect(
      t.prisma.$executeRaw`DELETE FROM "OrgMembership" WHERE "id" = ${orgOwner.id}`,
    ).rejects.toThrow(/last effective pmc/);
    // (the fixture's pmc membership is restored unconditionally by afterEach)
  });

  // ── R3-7 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R3-7: the publish side-effect bundle is derived from the LOCKED row, not the advisory pre-read', async () => {
    // A record announces to nobody; an ordinary decision demands the client's approval. The branch
    // was computed from an unlocked pre-read, so a conversion committing between the read and the
    // CAS emitted the wrong bundle in either direction. This probe drives the direction that
    // fabricates a demand: publish an ordinary draft that has BECOME a record.
    const id = `DL-t4bc3-pub-${seq++}`;
    await t.prisma.decision.create({
      data: { id, projectId: f.projectA.id, title: 'Converts under publish', room: 'K', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 1, swatch: 'sw2', order: 1 },
    ] });
    // The INTERLEAVING is the finding, so it is made deterministic rather than hoped for: the
    // publish command's advisory pre-read is interposed, and the conversion (options removed, kind
    // re-pointed — the coherent unpublished door the recorded seal allows) commits from a SECOND
    // connection after that read returns and before the CAS runs. Only the test is instrumented;
    // the service is untouched, and the pre-read still returns the ordinary draft it really saw.
    const originalFindUnique = t.prisma.decision.findUnique.bind(t.prisma.decision);
    let interposed = false;
    (t.prisma.decision as unknown as { findUnique: unknown }).findUnique = async (args: { where?: { id?: string } }) => {
      const row = await originalFindUnique(args as never);
      if (!interposed && args?.where?.id === id) {
        interposed = true;
        await raceDb.$executeRawUnsafe(`DELETE FROM "DecisionOption" WHERE "decisionId" = $1`, id);
        await raceDb.$executeRawUnsafe(`UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id);
      }
      return row;
    };
    try {
      await svc.publish(f.projectA.id, id, pmc());
    } finally {
      (t.prisma.decision as unknown as { findUnique: unknown }).findUnique = originalFindUnique;
    }
    expect(interposed, 'the pre-read must have been interposed — otherwise nothing was raced').toBe(true);

    const notice = await t.prisma.notification.findFirstOrThrow({ where: { projectId: f.projectA.id, decisionId: id } });
    expect(notice.text, 'a record must not announce an approval nobody can give').not.toMatch(/approval/i);
    const ev = await t.prisma.domainEvent.findFirstOrThrow({
      where: { projectId: f.projectA.id, entityId: id, eventType: 'decision.published' },
    });
    expect((ev.dispatchIntent as { effectKey?: string } | null)?.effectKey).toBe('decision.recorded');
    expect((ev.dispatchIntent as { push?: unknown } | null)?.push ?? null).toBeNull();
  });
});
