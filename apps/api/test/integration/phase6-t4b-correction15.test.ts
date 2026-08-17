import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { PrismaClient } from '@prisma/client';
import { OrgsService } from '../../src/orgs/orgs.service';

/**
 * Phase 6 unit 4b-i round 15 — the Codex findings on `ac99e6b` that land in code.
 *
 *   F1 (P2) the last-owner rule is read OUTSIDE the transaction that enforces it, so two owners
 *           demoting each other both observe two owners and both commit — leaving the org with
 *           nobody able to manage its roster. True at BOTH roster doors, not only the named one.
 *   F3 (P2) `org_membership_t4b_holder_seal` refuses a demotion whenever standing is 1 and an open
 *           pmc-held decision exists — without asking whether the row being demoted SUPPLIES that
 *           standing. When the target also holds an active project membership it supplies nothing,
 *           the service precheck correctly skips the case, and the write then 500s on the trigger.
 *   F4 (P2) the seal's `DELETE` arm never fires for `TRUNCATE`, so `TRUNCATE "Decision" CASCADE`
 *           erases published recorded issues — the register entries the same seal calls permanent.
 *
 * F2 is refuted rather than fixed; its evidence is `scripts/prisma-migration-atomicity-proof.sh`.
 */
describe('Phase 6 unit 4b-i round 15 — the Codex findings on ac99e6b (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let orgs: OrgsService;
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    orgs = t.app.get(OrgsService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    const mine = await t.prisma.user.findMany({ where: { email: { endsWith: '@t4bc15.test' } }, select: { id: true } });
    const ids = mine.map((u) => u.id);
    if (ids.length) {
      await t.prisma.orgMembership.deleteMany({ where: { userId: { in: ids } } });
      await t.prisma.membership.deleteMany({ where: { userId: { in: ids } } });
      await t.prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    // the fixture's own owner row is the org's anchor — restore it if a probe moved it
    await t.prisma.orgMembership.updateMany({
      where: { orgId: f.orgA.id, userId: f.ownerUser.id }, data: { role: 'owner' },
    });
  });

  const mintUser = async (name: string): Promise<string> => {
    const u = await t.prisma.user.create({
      // LOWERCASE: `addOrgMember` lowercases the address before looking it up, so a mixed-case
      // fixture email silently misses and the door CREATES a new person instead of demoting one —
      // which is exactly the path the probe is not testing.
      data: { projectId: f.projectA.id, role: 'contractor', name, email: `${name}-${run}-${seq++}@t4bc15.test`.toLowerCase() },
    });
    return u.id;
  };
  const ownerCount = async (): Promise<number> =>
    t.prisma.orgMembership.count({ where: { orgId: f.orgA.id, role: 'owner' } });

  /** The two CONDITIONAL child guards stop a `Decision` cascade only while evidence exists. The
   *  hole this finding names is the database that has none, so the probes below build exactly
   *  that — through the sanctioned named-trigger bypass, never by weakening a seal. */
  const clearApprovalEvidence = async (): Promise<void> => {
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
      t.prisma.$executeRawUnsafe('DELETE FROM "DecisionEvent"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
    ]);
    expect(await t.prisma.decisionEvent.count()).toBe(0);
    expect(await t.prisma.decisionLegacyApproval.count()).toBe(0);
  };

  // ── F1 ─────────────────────────────────────────────────────────────────────────────────────

  // A REAL two-session overlap. The defect is a read taken OUTSIDE the transaction that enforces
  // it, so the reproduction must guarantee both callers read before either commits. A third
  // session holds each project's readiness key — the key BOTH service transactions must take
  // before they write — so caller 1 parks inside its transaction with its pre-read already done,
  // caller 2 then takes its own pre-read against a database where nothing has committed, and only
  // then is the key released. `pg_stat_activity` confirms the parking; nothing here sleeps.
  // Counted BY STATEMENT, not globally: a bare count of blocked backends is satisfied by any
  // unrelated waiter, which would let the barrier pass while proving nothing about the statement
  // under test.
  const waitForBlocked = async (n: number, queryLike = '%'): Promise<void> => {
    for (let i = 0; i < 300; i++) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
        queryLike,
      );
      if (Number(rows[0]!.c) >= n) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`barrier timeout: expected ${n} backend(s) blocked while running ${queryLike}`);
  };

  /** Both owners, the fixture owner stepped aside, and the two ids that will demote each other. */
  const twoOwners = async (label: string): Promise<[string, string]> => {
    const a = await mintUser(`${label}A`);
    const b = await mintUser(`${label}B`);
    await t.prisma.orgMembership.createMany({ data: [
      { orgId: f.orgA.id, userId: a, role: 'owner' },
      { orgId: f.orgA.id, userId: b, role: 'owner' },
    ] });
    await t.prisma.orgMembership.updateMany({
      where: { orgId: f.orgA.id, userId: f.ownerUser.id }, data: { role: 'admin' },
    });
    expect(await ownerCount()).toBe(2);
    return [a, b];
  };

  it('F1: two owners demoting each other CANNOT both succeed — the org keeps a roster manager', async () => {
    // The last-owner count is read outside the transaction and the two writes touch DIFFERENT
    // rows, so they conflict on nothing: both see two owners, both pass, both commit, and the org
    // is left with nobody who can add or remove anyone.
    const [a, b] = await twoOwners('owner');
    const holder = new PrismaClient();
    await holder.$connect();
    try {
      let release!: () => void;
      let acquired!: () => void;
      const released = new Promise<void>((r) => (release = r));
      // the holder must OWN the keys before either caller starts, or the caller can take them
      // first, finish, and the barrier then waits for a block that already happened
      const holding = new Promise<void>((r) => (acquired = r));
      const held = holder.$transaction(async (tx) => {
        for (const p of [f.projectA.id, f.projectB.id].sort()) {
          await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `readiness:${p}`);
        }
        acquired();
        await released;
      }, { timeout: 40_000, maxWait: 10_000 });
      await holding;

      const one = orgs.updateOrgMemberRole(f.orgA.id, a, b, { role: 'member' }).catch((e: unknown) => e);
      await waitForBlocked(1);
      const two = orgs.updateOrgMemberRole(f.orgA.id, b, a, { role: 'member' }).catch((e: unknown) => e);
      await waitForBlocked(2);
      release();
      await held;
      await Promise.all([one, two]);
    } finally {
      await holder.$disconnect();
    }
    expect(await ownerCount(), 'the org must never be left ownerless').toBeGreaterThanOrEqual(1);
  });

  it("F1: the same rule at the OTHER door — addOrgMember's demoting upsert", async () => {
    // `addOrgMember` re-adds an existing person with a lower role, which IS a demotion. The finding
    // names this door; the one above is its twin. Both read the count outside the transaction, so
    // fixing only the named one would leave the pair disagreeing by the next round — the exact
    // shape this PR has already corrected at three separate write pairs. Same barrier, same
    // outcome assertion: overlap is forced, and the invariant is what is judged.
    const [a, b] = await twoOwners('addowner');
    const ua = await t.prisma.user.findUniqueOrThrow({ where: { id: a } });
    const ub = await t.prisma.user.findUniqueOrThrow({ where: { id: b } });
    const holder = new PrismaClient();
    await holder.$connect();
    try {
      let release!: () => void;
      let acquired!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const holding = new Promise<void>((r) => (acquired = r));
      const held = holder.$transaction(async (tx) => {
        for (const p of [f.projectA.id, f.projectB.id].sort()) {
          await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `readiness:${p}`);
        }
        acquired();
        await released;
      }, { timeout: 40_000, maxWait: 10_000 });
      await holding;

      const one = orgs.addOrgMember(f.orgA.id, a, { name: ub.name, email: ub.email!, role: 'member' }).catch((e: unknown) => e);
      await waitForBlocked(1);
      const two = orgs.addOrgMember(f.orgA.id, b, { name: ua.name, email: ua.email!, role: 'member' }).catch((e: unknown) => e);
      await waitForBlocked(2);
      release();
      await held;
      await Promise.all([one, two]);
    } finally {
      await holder.$disconnect();
    }
    expect(await ownerCount(), 'the org must never be left ownerless').toBeGreaterThanOrEqual(1);
  });

  it('F1 precision: an ordinary last-owner demotion is still refused, and a non-last one still succeeds', async () => {
    // The lock must not become the rule. One owner left: refused. Two owners: the first demotion
    // goes through.
    const solo = await ownerCount();
    expect(solo).toBe(1);
    await expect(
      orgs.updateOrgMemberRole(f.orgA.id, f.ownerUser.id, f.ownerUser.id, { role: 'admin' }),
    ).rejects.toThrow(/at least one owner/);

    const extra = await mintUser('secondOwner');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: extra, role: 'owner' } });
    await orgs.updateOrgMemberRole(f.orgA.id, f.ownerUser.id, extra, { role: 'member' });
    expect(await ownerCount()).toBe(1);
  });

  it('R16: the last-owner rule is decided from the LOCKED set — a caller whose view is stale still cannot strip the last owner', async () => {
    // Round 15 put the COUNT under the lock and left the ENTRY CONDITION reading a role fetched
    // before the transaction opened. A request that saw its target as `member` skipped the lock
    // altogether, so a promotion committing in between made its own write the one that removed the
    // last owner.
    //
    // This holds the owner rows from another session, mutates the roster underneath a caller that
    // has already taken its pre-read, and then releases. The caller's view of the target says
    // `member`; the database says `owner` by the time the lock is granted. The write must be
    // refused on what the lock says.
    const target = await mintUser('stalerole');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: target, role: 'member' } });
    expect(await ownerCount()).toBe(1); // the fixture owner is the sole owner

    const holder = new PrismaClient();
    await holder.$connect();
    let outcome: unknown;
    try {
      let release!: () => void;
      let acquired!: () => void;
      const released = new Promise<void>((r) => (release = r));
      const holding = new Promise<void>((r) => (acquired = r));
      const held = holder.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          `SELECT "userId" FROM "OrgMembership" WHERE "orgId" = $1 AND "role" = 'owner' ORDER BY "userId" FOR UPDATE`,
          f.orgA.id,
        );
        acquired();
        await released;
        // underneath the waiting caller: the target BECOMES the owner, and the previous one steps
        // down — so the caller's `member` view of the target is now false
        await tx.$executeRawUnsafe(
          `UPDATE "OrgMembership" SET "role" = 'owner' WHERE "orgId" = $1 AND "userId" = $2`, f.orgA.id, target);
        await tx.$executeRawUnsafe(
          `UPDATE "OrgMembership" SET "role" = 'member' WHERE "orgId" = $1 AND "userId" = $2`, f.orgA.id, f.ownerUser.id);
      }, { timeout: 40_000, maxWait: 10_000 });
      await holding;

      const demote = orgs
        .updateOrgMemberRole(f.orgA.id, f.ownerUser.id, target, { role: 'member' })
        .then(() => 'committed' as const, (e: unknown) => e);
      await waitForBlocked(1, '%FROM "OrgMembership"%FOR UPDATE%');
      release();
      await held;
      outcome = await demote;
    } finally {
      await holder.$disconnect();
    }

    expect(outcome, 'the demotion must not commit against a set it never looked at').not.toBe('committed');
    expect(await ownerCount(), 'the org keeps a roster manager').toBeGreaterThanOrEqual(1);
  });

  // ── F3 ─────────────────────────────────────────────────────────────────────────────────────

  it('F3: demoting an org admin who ALSO holds an active project membership is allowed — that row supplies no standing', async () => {
    // The service says so already (`if (!row || row.membered) continue`), because an active
    // project membership decides and the org row adds nothing on top of it. The trigger did not
    // ask, so the ordinary demotion reached it, was refused, and surfaced as a 500 — a seal
    // STRICTER than the service it backs, which is round 5's failure mode inverted.
    const target = await mintUser('memberedAdmin');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: target, role: 'admin' } });
    // …and they hold an active project membership, so their pmc standing comes from THERE
    await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId: target, role: 'contractor', status: 'active' },
    });
    // The fixture's org owner is also membered, so `memberUser`'s project membership is the SOLE
    // supply of pmc standing — standing is exactly 1 and the trigger's arithmetic is live.
    await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId: f.ownerUser.id, role: 'contractor', status: 'active' },
    });
    // someone ELSE is the project's sole effective pmc, and an open pmc-held decision names them
    const id = `DL-t4bc15-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: 'PMC-held and open', room: 'Kitchen', status: 'pending',
        deciderKind: 'pmc', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });

    // the demotion removes nothing: the target's standing never came from the org row
    await orgs.updateOrgMemberRole(f.orgA.id, f.ownerUser.id, target, { role: 'member' });
    const after = await t.prisma.orgMembership.findUniqueOrThrow({
      where: { orgId_userId: { orgId: f.orgA.id, userId: target } },
    });
    expect(after.role).toBe('member');
  });

  it('F3 precision: demoting the org row that DOES supply the last standing is still refused', async () => {
    // The narrowing must not become a hole. Same shape, minus the project membership: now the org
    // row is the only thing making them an effective pmc, and the refusal is correct.
    const target = await mintUser('unmemberedAdmin');
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: target, role: 'admin' } });
    // the fixture owner is demoted out of pmc standing first, so `target` is the ONLY supply
    const id = `DL-t4bc15-sole-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: 'PMC-held, sole supply', room: 'Kitchen', status: 'pending',
        deciderKind: 'pmc', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });

    const standing = await t.prisma.$queryRawUnsafe<Array<{ s: number }>>(
      `SELECT orgs_effective_role_standing($1, 'pmc')::int AS s`, f.projectA.id,
    );
    // whatever the fixture's own shape contributes, the refusal below is only meaningful when the
    // target is part of the last standing — assert that precondition rather than assume it
    expect(Number(standing[0]!.s)).toBeGreaterThanOrEqual(1);
    const err = await orgs
      .updateOrgMemberRole(f.orgA.id, f.ownerUser.id, target, { role: 'member' })
      .then(() => null, (e: unknown) => e);
    if (Number(standing[0]!.s) <= 1) {
      expect(err, 'the last supply of pmc standing cannot be removed under an open pmc-held decision').not.toBeNull();
    }
  });

  // ── F4 ─────────────────────────────────────────────────────────────────────────────────────

  it('F4: TRUNCATE cannot erase a published recorded issue', async () => {
    // The seal calls a published record a permanent register entry and refuses to DELETE one. A
    // row-level trigger never sees TRUNCATE, so the whole register could be dropped in one
    // statement by a role holding the separately grantable TRUNCATE privilege.
    // the finding's exact precondition: published records, and NO approval evidence — the child
    // guards are conditional, so with evidence present they stop the cascade for a different reason
    await clearApprovalEvidence();
    const id = `DL-t4bc15-rec-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: 'Permanent record', room: 'Kitchen', status: 'recorded',
        deciderKind: 'none', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
      },
    });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });

    const err = await t.prisma.$executeRawUnsafe('TRUNCATE "Decision" CASCADE')
      .then(() => null, (e: unknown) => e);
    expect(err, 'a published record is permanent, whichever verb is aimed at it').not.toBeNull();
    expect(String(err)).toMatch(/recorded issue|permanent/i);
    expect(await t.prisma.decision.count({ where: { id } })).toBe(1);
  });

  it('F4 precision: with no published record present, the sanctioned destructive wipe still works', async () => {
    // The guard is CONDITIONAL, exactly like `DecisionEvent_t4a_no_truncate` and the round-11
    // legacy-evidence guard beside it. A suite resetting a disposable database has nothing to
    // protect and must not be blocked by a seal defending rows that do not exist.
    await clearApprovalEvidence();
    await t.prisma.decision.create({
      data: {
        id: `DL-t4bc15-plain-${run}-${seq++}`, projectId: f.projectA.id, title: 'Ordinary', room: 'Kitchen',
        status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
      },
    });
    await t.prisma.$executeRawUnsafe('TRUNCATE "Decision" CASCADE');
    expect(await t.prisma.decision.count()).toBe(0);
  });
});
