import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b — the per-decision DECIDER and the record-only issue (plan
 * `docs/superpowers/plans/2026-08-14-decision-workflow-4b.md`, cleared at PR #340),
 * proven live against PostgreSQL through the REAL application.
 *
 * The owner's live defects this unit answers: a decision could only ever await the
 * CLIENT (so a contractor's own choice had nowhere to live), and every decision
 * demanded an approval (so an issue you only need to RECORD had no honest form).
 *
 * STAGED RED (§C): this file is committed BEFORE the behavior, against a schema that
 * already carries `deciderKind`/`deciderMembershipId`, the `recorded` status, the
 * `DeciderKind` enum and the widened contract — so every failure below is a BEHAVIOR
 * failure, never a missing symbol. Each probe grows its full arm set with the piece
 * that implements it; the arms here are the core of each §C row:
 *
 *   P15 default-decider byte-identity (no caller opts in → every surface unchanged)
 *   P16 member-decider authority: the named holder approves; a same-role non-decider
 *       is refused at the SERVICE; the on-behalf act freezes the EXACT holder tuple
 *   P17 the decider seals: kind⟺membershipId, cross-project FK, write-once FROM
 *       publication (draft re-point legal, post-publish UPDATE refused), publish
 *       re-validates ACTIVE standing
 *   P18 `recorded` born terminal: no pending surface, evidence frozen, hostile flip
 *       and hostile DELETE refused, the kind⟺status pair sealed both directions
 *   P19 the zero-option record files through the FULL product path
 *   P20 a DRAFT record gates `wait`; a published record gates `na`
 *   P21 the targeted push reaches the decider USER and only them
 *   P22 the WHOLE audience follows the decider (bell, counts, projection, route)
 *   P39 removing the current holder is refused for BOTH designations, at BOTH layers
 *
 * RED at the shape commit: 12 of 15 arms fail on BEHAVIOR. The 3 green-at-shape arms are
 * recorded honestly rather than hidden:
 *   - P15's byte-identity IS the column default the shape migration carries — the property
 *     it asserts (no caller opts in => 'client', behavior unchanged) is genuinely true here
 *     and must STAY true through every later piece; that is the point of the probe.
 *   - P17's cross-project refusal IS the composite FK the shape migration carries (an FK is
 *     a column-level fact, legitimately part of the shape).
 *   - P39's draft arm is VACUOUSLY green today (no guard exists to refuse anything). It
 *     proves nothing until the §B.2 membership seal lands, at which point it becomes the
 *     real carve-out assertion — a private draft must NOT block a removal.
 */
describe('Phase 6 unit 4b — the decider and the record-only issue (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let query: DecisionsQueryService;
  let raceDb: PrismaClient;
  let seq = 0;

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    query = t.app.get(DecisionsQueryService);
    raceDb = new PrismaClient();
  });
  afterAll(async () => {
    await cleanup();
    await raceDb?.$disconnect();
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DecisionApprovalRevision", "CommandExecution" CASCADE',
    );
    await t.prisma.notification.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.changeRequest.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } });
    // The 4a evidence seals make decisions permanent in a LIVE register; this destructive
    // test reset disables exactly those named triggers for the wipe, in ONE transaction so
    // a failure rolls the DISABLE back (the 4a contract, inherited verbatim).
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } }),
      t.prisma.decision.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"'),
    ]);
    await t.prisma.membership.deleteMany({ where: { userId: { startsWith: 'it-t4b-u-' } } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-t4b-u-' } } });
  }

  /** An ACTIVE project membership in the given role — the decider candidate pool. */
  const seedMember = async (role: string): Promise<{ userId: string; membershipId: string }> => {
    const userId = `it-t4b-u-${seq++}`;
    await t.prisma.user.create({
      data: { id: userId, projectId: f.projectA.id, role, name: `T4B ${role} ${seq}`, email: `${userId}@test.local` },
    });
    const m = await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId, role, status: 'active' },
    });
    return { userId, membershipId: m.id };
  };

  const twoOptions = [
    { label: 'Granite', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Quartz', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];

  // ── P15 — the default decider changes nothing ──────────────────────────────────

  describe('P15 — default-decider byte-identity', () => {
    it('a create with NO decider opts in lands deciderKind=client and the pre-4b behavior', async () => {
      await svc.create(
        f.projectA.id,
        { title: 'Counter finish', room: 'Kitchen', options: twoOptions, publish: true },
        pmc(),
        `t4b-p15-${seq++}`,
      );
      const row = await t.prisma.decision.findFirst({
        where: { projectId: f.projectA.id, title: 'Counter finish' },
      });
      expect(row?.deciderKind).toBe('client');
      expect(row?.deciderMembershipId).toBeNull();
      expect(row?.status).toBe('pending');
    });
  });

  // ── P16 — member-decider authority ─────────────────────────────────────────────

  describe('P16 — member-decider authority', () => {
    it('the NAMED member is recorded as the holder when create names them', async () => {
      const holder = await seedMember('contractor');
      await svc.create(
        f.projectA.id,
        {
          title: 'Tile layout',
          room: 'Bath',
          options: twoOptions,
          publish: true,
          deciderKind: 'member',
          deciderMembershipId: holder.membershipId,
        },
        pmc(),
        `t4b-p16-${seq++}`,
      );
      const row = await t.prisma.decision.findFirst({ where: { projectId: f.projectA.id, title: 'Tile layout' } });
      expect(row?.deciderKind).toBe('member');
      expect(row?.deciderMembershipId).toBe(holder.membershipId);
    });

    it('the PMC on-behalf approval FREEZES the exact holder tuple on the act', async () => {
      const holder = await seedMember('contractor');
      const snap = await svc.create(
        f.projectA.id,
        {
          title: 'Skirting profile',
          room: 'Hall',
          options: twoOptions,
          publish: true,
          deciderKind: 'member',
          deciderMembershipId: holder.membershipId,
        },
        pmc(),
        `t4b-p16b-${seq++}`,
      );
      const id = snap.decisions.find((d) => d.title === 'Skirting profile')!.id;
      await svc.approve(f.projectA.id, id, { optionIndex: 0 }, pmc(), `t4b-p16b-ap-${seq++}`);
      const row = await t.prisma.decision.findUnique({ where: { id } });
      // the act keeps its OWN history: kind + membership + the rendered display identity
      expect(row?.approvedDeciderKind).toBe('member');
      expect(row?.approvedDeciderMembershipId).toBe(holder.membershipId);
      expect(row?.approvedDeciderLabel).toBeTruthy();
      expect(row?.onBehalfOf).toBe('member');
    });
  });

  // ── P17 — the decider seals ────────────────────────────────────────────────────

  describe('P17 — the decider seals', () => {
    it("kind='member' without a membershipId is refused at the DATABASE", async () => {
      await expect(
        t.prisma.$executeRawUnsafe(
          `INSERT INTO "Decision" (id, "projectId", title, room, status, "photoSwatch", "deciderKind", "publishedAt")
           VALUES ('DL-t4b-h1', $1, 'Hostile', 'Kitchen', 'pending', 'sw1', 'member', now())`,
          f.projectA.id,
        ),
      ).rejects.toThrow();
    });

    it('a CROSS-PROJECT membership named as decider is unrepresentable', async () => {
      const other = await t.prisma.membership.findFirst({ where: { projectId: f.projectB.id } });
      await expect(
        t.prisma.$executeRawUnsafe(
          `INSERT INTO "Decision" (id, "projectId", title, room, status, "photoSwatch", "deciderKind", "deciderMembershipId", "publishedAt")
           VALUES ('DL-t4b-h2', $1, 'Hostile', 'Kitchen', 'pending', 'sw1', 'member', $2, now())`,
          f.projectA.id,
          other!.id,
        ),
      ).rejects.toThrow();
    });

    it('the holder columns are WRITE-ONCE from publication — a post-publish UPDATE is refused', async () => {
      const holder = await seedMember('contractor');
      const other = await seedMember('contractor');
      const snap = await svc.create(
        f.projectA.id,
        {
          title: 'Handle type',
          room: 'Kitchen',
          options: twoOptions,
          publish: true,
          deciderKind: 'member',
          deciderMembershipId: holder.membershipId,
        },
        pmc(),
        `t4b-p17-${seq++}`,
      );
      const id = snap.decisions.find((d) => d.title === 'Handle type')!.id;
      await expect(
        t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "deciderMembershipId" = $1 WHERE id = $2`, other.membershipId, id),
      ).rejects.toThrow();
    });

    it('an UNPUBLISHED draft may re-point its holder through the shipped updateDraft path', async () => {
      const first = await seedMember('contractor');
      const second = await seedMember('contractor');
      const snap = await svc.create(
        f.projectA.id,
        {
          title: 'Draft holder',
          room: 'Kitchen',
          options: twoOptions,
          publish: false,
          deciderKind: 'member',
          deciderMembershipId: first.membershipId,
        },
        pmc(),
        `t4b-p17b-${seq++}`,
      );
      const id = snap.decisions.find((d) => d.title === 'Draft holder')!.id;
      await svc.updateDraft(
        f.projectA.id,
        id,
        { deciderKind: 'member', deciderMembershipId: second.membershipId },
        pmc(),
        `t4b-p17b-ed-${seq++}`,
      );
      const row = await t.prisma.decision.findUnique({ where: { id } });
      expect(row?.deciderMembershipId).toBe(second.membershipId);
    });
  });

  // ── P18 — `recorded` born terminal ─────────────────────────────────────────────

  describe('P18 — the record-only issue is terminal', () => {
    it("deciderKind='none' is born `recorded` and carries zero options", async () => {
      const snap = await svc.create(
        f.projectA.id,
        { title: 'Seepage at plinth', room: 'Exterior', options: [], publish: true, deciderKind: 'none' },
        pmc(),
        `t4b-p18-${seq++}`,
      );
      const id = snap.decisions.find((d) => d.title === 'Seepage at plinth')!.id;
      const row = await t.prisma.decision.findUnique({ where: { id }, include: { options: true } });
      expect(row?.status).toBe('recorded');
      expect(row?.options).toHaveLength(0);
    });

    it('a hostile `recorded → approved` flip is refused at the DATABASE', async () => {
      const snap = await svc.create(
        f.projectA.id,
        { title: 'Crack in slab', room: 'Roof', options: [], publish: true, deciderKind: 'none' },
        pmc(),
        `t4b-p18b-${seq++}`,
      );
      const id = snap.decisions.find((d) => d.title === 'Crack in slab')!.id;
      await expect(
        t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET status = 'approved' WHERE id = $1`, id),
      ).rejects.toThrow();
    });

    it('the kind⟺status pair is sealed BOTH directions', async () => {
      // 'none' with a non-recorded status, and 'recorded' for an ordinary kind
      await expect(
        t.prisma.$executeRawUnsafe(
          `INSERT INTO "Decision" (id, "projectId", title, room, status, "photoSwatch", "deciderKind", "publishedAt")
           VALUES ('DL-t4b-h3', $1, 'Hostile', 'Kitchen', 'pending', 'sw1', 'none', now())`,
          f.projectA.id,
        ),
      ).rejects.toThrow();
      await expect(
        t.prisma.$executeRawUnsafe(
          `INSERT INTO "Decision" (id, "projectId", title, room, status, "photoSwatch", "deciderKind", "publishedAt")
           VALUES ('DL-t4b-h4', $1, 'Hostile', 'Kitchen', 'recorded', 'sw1', 'client', now())`,
          f.projectA.id,
        ),
      ).rejects.toThrow();
    });
  });

  // ── P19 — the record files through the FULL product path ───────────────────────

  describe('P19 — the zero-option record through the whole path', () => {
    it('create → persist → serialize: the record renders in the register with no options', async () => {
      await svc.create(
        f.projectA.id,
        { title: 'Neighbour complaint logged', room: 'Site', options: [], publish: true, deciderKind: 'none' },
        pmc(),
        `t4b-p19-${seq++}`,
      );
      const slice = await query.snapshotSlice({ projectId: f.projectA.id, role: 'pmc', userId: f.memberUser.id });
      const view = slice.decisions.find((d) => d.title === 'Neighbour complaint logged');
      expect(view).toBeDefined();
      expect(view?.status).toBe('recorded');
      expect(view?.options ?? []).toHaveLength(0);
    });
  });

  // ── P20 — the gate reading ─────────────────────────────────────────────────────

  describe('P20 — the readiness gate for a record', () => {
    it('a DRAFT record gates `wait`; a PUBLISHED record gates `na`', async () => {
      const draft = await svc.create(
        f.projectA.id,
        { title: 'Draft record', room: 'Site', options: [], publish: false, deciderKind: 'none' },
        pmc(),
        `t4b-p20-${seq++}`,
      );
      const draftId = draft.decisions.find((d) => d.title === 'Draft record')!.id;
      const published = await svc.create(
        f.projectA.id,
        { title: 'Published record', room: 'Site', options: [], publish: true, deciderKind: 'none' },
        pmc(),
        `t4b-p20b-${seq++}`,
      );
      const pubId = published.decisions.find((d) => d.title === 'Published record')!.id;
      const slice = await query.snapshotSlice({ projectId: f.projectA.id, role: 'pmc', userId: f.memberUser.id });
      expect(slice.statuses.get(draftId)).toBe('recorded');
      expect(slice.statuses.get(pubId)).toBe('recorded');
      // the gate arm itself is asserted with the reader in the implementing piece
      expect(slice.decisions.find((d) => d.id === draftId)?.draft).toBe(true);
      expect(slice.decisions.find((d) => d.id === pubId)?.draft).toBe(false);
    });
  });

  // ── P21/P22 — the audience follows the decider ─────────────────────────────────

  describe('P22 — the audience follows the decider', () => {
    it('countPending is viewer-scoped: the named holder sees their decision pending, a same-role non-holder does not', async () => {
      const holder = await seedMember('engineer');
      const bystander = await seedMember('engineer');
      await svc.create(
        f.projectA.id,
        {
          title: 'Rebar spacing',
          room: 'Slab',
          options: twoOptions,
          publish: true,
          deciderKind: 'member',
          deciderMembershipId: holder.membershipId,
        },
        pmc(),
        `t4b-p22-${seq++}`,
      );
      const held = await query.countPending({ projectId: f.projectA.id, role: 'engineer', userId: holder.userId } as never);
      const notHeld = await query.countPending({ projectId: f.projectA.id, role: 'engineer', userId: bystander.userId } as never);
      expect(held).toBeGreaterThan(0);
      expect(notHeld).toBe(0);
    });
  });

  // ── P39 — the holder cannot be silently orphaned ───────────────────────────────

  describe('P39 — removing the current holder is refused', () => {
    it("a membership named by a PUBLISHED open decision cannot be soft-removed at the DATABASE", async () => {
      const holder = await seedMember('contractor');
      await svc.create(
        f.projectA.id,
        {
          title: 'Door finish',
          room: 'Hall',
          options: twoOptions,
          publish: true,
          deciderKind: 'member',
          deciderMembershipId: holder.membershipId,
        },
        pmc(),
        `t4b-p39-${seq++}`,
      );
      await expect(
        t.prisma.$executeRawUnsafe(`UPDATE "Membership" SET status = 'removed' WHERE id = $1`, holder.membershipId),
      ).rejects.toThrow();
    });

    it('a private DRAFT naming the member does NOT block the removal', async () => {
      const holder = await seedMember('contractor');
      await svc.create(
        f.projectA.id,
        {
          title: 'Draft door finish',
          room: 'Hall',
          options: twoOptions,
          publish: false,
          deciderKind: 'member',
          deciderMembershipId: holder.membershipId,
        },
        pmc(),
        `t4b-p39b-${seq++}`,
      );
      await expect(
        t.prisma.$executeRawUnsafe(`UPDATE "Membership" SET status = 'removed' WHERE id = $1`, holder.membershipId),
      ).resolves.toBeDefined();
    });
  });
});
