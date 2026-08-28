import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { computeDecisionRows, storedDecisionRows, DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { pendingDecisionNotice } from '../../src/domain/notifications';
import type { AuthUser } from '../../src/common/auth';
import type { CreateDecisionInput } from '../../src/contracts';

/**
 * Phase 6 unit 4b — THE DECIDER TAKES AUTHORITY (plan §A.1, and the §A.3 audience arm the
 * authority requires), proven live against PostgreSQL through the real service.
 *
 * Until now every decision was the CLIENT's to make: `approve` hard-coded `onBehalfOf: 'client'`,
 * the route allowlist WAS the authority, and AUTH-02 hid every pending decision from anyone who
 * was not pmc or client. That is wrong for the questions this practice actually asks — a
 * sequencing call is the contractor's, a services clash is the consultant's — and the owner asked
 * for the decision to name who decides it.
 *
 * Probes (the plan's §C table; the arms this unit ships):
 *   P15 default-decider BYTE-IDENTITY — no caller opting in behaves exactly as before
 *   P16 member-decider AUTHORITY — the named contractor approves; a same-role non-decider is
 *       refused at the SERVICE (not the route); the PMC on-behalf act freezes the EXACT holder
 *       tuple, and a re-approval after a change request still names the FIRST holder
 *   P17 the holder LIFECYCLE — the pair CHECK, the cross-project FK, write-once FROM PUBLICATION
 *       (the draft re-point legal, the hostile post-publish UPDATE refused), publish re-validating
 *       standing and refusing a stranded draft, and the `Membership.userId` identity freeze
 *   P22 the AUDIENCE follows the decider — on the LIVE slice and on the PROJECTED slice alike,
 *       with a rebuild preserving it (no leak to a same-role peer, no hidden action item)
 */
describe('Phase 6 unit 4b — the decider takes authority (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let query: DecisionsQueryService;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let hostile: PrismaClient;
  let seq = 0;

  /** Extra people this suite needs beyond the fixture's four. */
  const made: string[] = [];
  async function member(role: string, name: string, projectId?: string): Promise<{ userId: string; membershipId: string }> {
    const userId = `it-t4b-u-${seq++}`;
    await t.prisma.user.create({ data: { id: userId, projectId: projectId ?? f.projectA.id, role, name, email: `${userId}@t.local` } });
    const m = await t.prisma.membership.create({
      data: { projectId: projectId ?? f.projectA.id, userId, role, status: 'active' },
    });
    made.push(userId);
    return { userId, membershipId: m.id };
  }

  /** Drain every pending `decisions.inbox` delivery for a project (the projection-suite pattern). */
  const applyProjection = async (projectId: string): Promise<void> => {
    for (let pass = 0; pass < 50; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({
        where: { consumer: DECISIONS_PROJECTION, projectId, status: { in: ['pending', 'leased'] } },
        orderBy: { streamPosition: 'asc' },
      });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const o = await relay.dispatchOne(d.id);
        if (o === 'succeeded' || o === 'duplicate' || o === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };

  const as = (sub: string, role: string): AuthUser => ({ sub, role, projectId: f.projectA.id }) as AuthUser;
  const pmc = () => as(f.memberUser.id, 'pmc');

  const input = (over: Partial<CreateDecisionInput> = {}): CreateDecisionInput => ({
    title: `Counter ${seq++}`,
    room: 'Kitchen',
    publish: true,
    deciderKind: 'client',
    options: [
      { label: 'A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
      { label: 'B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
    ],
    ...over,
  } as CreateDecisionInput);

  /** The decision this create just made (ids are minted server-side, newest last). */
  const latest = async (): Promise<string> => {
    const rows = await t.prisma.decision.findMany({ where: { projectId: f.projectA.id }, orderBy: { createdAt: 'desc' }, take: 1 });
    return rows[0]!.id;
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    query = t.app.get(DecisionsQueryService);
    relay = t.app.get(OutboxRelay);
    rebuilder = t.app.get(ProjectionRebuilder);
    hostile = new PrismaClient();
    // the fixture's project-A member is its PMC; a CLIENT must exist for a client-held decision
    // to be publishable at all (the zero-holder refusal is real, and this suite relies on it).
    await member('client', 'Asha Shah');
  });
  afterAll(async () => {
    await cleanup();
    await hostile?.$disconnect();
    await t.prisma.membership.deleteMany({ where: { userId: { startsWith: 'it-t4b-u-' } } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-t4b-u-' } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => { await cleanup(); });

  async function cleanup(): Promise<void> {
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DecisionApprovalRevision", "CommandExecution" CASCADE',
    );
    // The event stream's counter is NOT part of the truncate above, and the ordered projection
    // consumer needs CONTIGUITY from its (also truncated) cursor: leaving `nextPosition` where the
    // previous probe left it makes the next event arrive at a position the fresh cursor sees as a
    // gap, so the delivery never applies and the generation is never servable. Resetting the
    // counter with the stream it counts keeps each probe a genuinely fresh project.
    await t.prisma.projectEventStream.updateMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } }, data: { nextPosition: 0 } });
    await t.prisma.notification.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.changeRequest.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } });
    // The register's evidence seals make an approved/withdrawn decision permanent in a LIVE
    // database. A destructive test reset is a SANCTIONED bypass: the named triggers go off for
    // exactly this wipe, inside ONE transaction, so a failed wipe rolls the DISABLE back and no
    // failure path can leave the shared database's seals down for a later probe.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b_evidence_no_delete"'),
      t.prisma.decisionEvent.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } }),
      t.prisma.decisionOption.deleteMany({ where: { decision: { projectId: { in: [f.projectA.id, f.projectB.id] } } } }),
      t.prisma.decision.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } }),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b_evidence_no_delete"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"'),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"'),
    ]);
  }

  // ── P15 — the default holder, and byte-identity ────────────────────────────────────────────
  describe('P15 — no caller opting in behaves exactly as before', () => {
    it('a create that names no decider is CLIENT-held, and serializes the pre-4b shape', async () => {
      // deliberately the pre-4b payload: no decider keys at all
      const payload = input();
      delete (payload as { deciderKind?: unknown }).deciderKind;
      await svc.create(f.projectA.id, payload, pmc());
      const id = await latest();

      const row = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
      expect(row.deciderKind).toBe('client');
      expect(row.deciderMembershipId).toBeNull();

      // the serialized decision carries NO decider keys — a client-held decision is byte-identical
      const slice = await query.snapshotSlice(f.projectA.id, 'pmc', f.memberUser.id);
      const dto = slice.decisions.find((d) => d.id === id)!;
      expect('deciderKind' in dto).toBe(false);
      expect('deciderMembershipId' in dto).toBe(false);

      // and the client's bell notice is the exact pre-4b text
      const notes = await t.prisma.notification.findMany({ where: { decisionId: id } });
      expect(notes.map((n) => n.text)).toEqual([pendingDecisionNotice(payload.title)]);
    });

    it('the client approving a client-held decision keeps the pre-4b announcement and no on-behalf marker', async () => {
      await svc.create(f.projectA.id, input(), pmc());
      const id = await latest();
      const clientUser = (await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, role: 'client', status: 'active' } })).userId;

      await svc.approve(f.projectA.id, id, { optionIndex: 0 }, as(clientUser, 'client'));

      const row = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('approved');
      expect(row.onBehalfOf).toBeNull();
      const announce = (await t.prisma.notification.findMany({ where: { decisionId: id } })).map((n) => n.text);
      expect(announce.some((x) => /^Client approved /.test(x))).toBe(true);
    });

    it('a PMC approving a client-held decision still records on-behalf-of the client, verbatim', async () => {
      await svc.create(f.projectA.id, input(), pmc());
      const id = await latest();
      await svc.approve(f.projectA.id, id, { optionIndex: 0 }, pmc());
      const row = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
      expect(row.onBehalfOf).toBe('client');
      const announce = (await t.prisma.notification.findMany({ where: { decisionId: id } })).map((n) => n.text);
      expect(announce.some((x) => /approved .* on behalf of the client/.test(x))).toBe(true);
    });
  });

  // ── P16 — the named member decides ─────────────────────────────────────────────────────────
  describe('P16 — member-decider authority', () => {
    it('the NAMED contractor approves; a same-role NON-decider is refused at the SERVICE', async () => {
      const named = await member('contractor', 'Bhavesh Patel');
      const peer = await member('contractor', 'Dinesh Rao');
      await svc.create(f.projectA.id, input({ deciderKind: 'member', deciderMembershipId: named.membershipId }), pmc());
      const id = await latest();

      // the peer holds the SAME role and passes the route ceiling — the service is what refuses
      await expect(svc.approve(f.projectA.id, id, { optionIndex: 0 }, as(peer.userId, 'contractor')))
        .rejects.toThrow(/not yours to decide/i);
      // and refusing leaves nothing behind
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');

      await svc.approve(f.projectA.id, id, { optionIndex: 0 }, as(named.userId, 'contractor'));
      const row = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('approved');
      expect(row.onBehalfOf).toBeNull(); // they ARE the decider — nothing is "on behalf"
      expect(row.approvedById).toBe(named.userId);
    });

    it('the PMC on-behalf act freezes the EXACT holder — and a re-approval still names the FIRST holder', async () => {
      const named = await member('contractor', 'Bhavesh Patel');
      await svc.create(f.projectA.id, input({ deciderKind: 'member', deciderMembershipId: named.membershipId }), pmc());
      const id = await latest();

      await svc.approve(f.projectA.id, id, { optionIndex: 0 }, pmc());
      const first = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
      expect(first.onBehalfOf).toBe('member');
      expect(first.approvedDeciderKind).toBe('member');
      expect(first.approvedDeciderMembershipId).toBe(named.membershipId);
      expect(first.approvedDeciderLabel).toContain('Bhavesh Patel');

      await svc.requestChange(f.projectA.id, id, { reason: 'Site clash', costImpact: 0, timeImpactDays: 1 }, pmc());
      await svc.approve(f.projectA.id, id, { optionIndex: 1 }, pmc());
      const second = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
      // the act keeps its own history: the frozen tuple is the FIRST consent, not the latest state
      expect(second.approvedDeciderMembershipId).toBe(named.membershipId);
      expect(second.approvedDeciderLabel).toBe(first.approvedDeciderLabel);
    });

    it('a PMC-held decision is approved by the PMC directly, with no on-behalf marker', async () => {
      await svc.create(f.projectA.id, input({ deciderKind: 'pmc' }), pmc());
      const id = await latest();
      await svc.approve(f.projectA.id, id, { optionIndex: 0 }, pmc());
      const row = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
      expect(row.onBehalfOf).toBeNull();
      expect(row.approvedDeciderKind).toBe('pmc');
      expect(row.approvedDeciderMembershipId).toBeNull();
    });
  });

  // ── P17 — the holder lifecycle ─────────────────────────────────────────────────────────────
  describe('P17 — the holder is real, and frozen from publication', () => {
    it('publishing a draft whose named member has LEFT is refused, and the refusal names the fix', async () => {
      const leaving = await member('contractor', 'Temporary Hand');
      await svc.create(f.projectA.id, input({ publish: false, deciderKind: 'member', deciderMembershipId: leaving.membershipId }), pmc());
      const id = await latest();

      await t.prisma.membership.update({ where: { id: leaving.membershipId }, data: { status: 'removed' } });
      await expect(svc.publish(f.projectA.id, id, pmc())).rejects.toThrow(/no longer active on the project/i);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).publishedAt).toBeNull();

      // the named fix: re-point the DRAFT, then publish. A product path, never a DB operation.
      const replacement = await member('contractor', 'Standing Hand');
      await svc.updateDraft(f.projectA.id, id, { deciderKind: 'member', deciderMembershipId: replacement.membershipId }, pmc());
      await svc.publish(f.projectA.id, id, pmc());
      const row = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
      expect(row.publishedAt).not.toBeNull();
      expect(row.deciderMembershipId).toBe(replacement.membershipId);
    });

    it('the draft edit is refused once the decision is PUBLISHED, and hostile SQL cannot re-home it either', async () => {
      const named = await member('contractor', 'Bhavesh Patel');
      const other = await member('contractor', 'Dinesh Rao');
      await svc.create(f.projectA.id, input({ deciderKind: 'member', deciderMembershipId: named.membershipId }), pmc());
      const id = await latest();

      await expect(svc.updateDraft(f.projectA.id, id, { deciderKind: 'pmc' }, pmc())).rejects.toThrow(/only for drafts/i);
      await expect(
        hostile.$executeRawUnsafe('UPDATE "Decision" SET "deciderMembershipId" = $1 WHERE "id" = $2', other.membershipId, id),
      ).rejects.toThrow(/holder|frozen/i);
      expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).deciderMembershipId).toBe(named.membershipId);
    });

    it('the member⟺membershipId pair is coherent at the DATABASE, in both directions', async () => {
      await svc.create(f.projectA.id, input({ publish: false }), pmc());
      const id = await latest();
      await expect(
        hostile.$executeRawUnsafe(`UPDATE "Decision" SET "deciderKind" = 'member' WHERE "id" = $1`, id),
      ).rejects.toThrow(/decider_pair/i);
      const named = await member('contractor', 'Bhavesh Patel');
      await expect(
        hostile.$executeRawUnsafe(`UPDATE "Decision" SET "deciderMembershipId" = $1 WHERE "id" = $2`, named.membershipId, id),
      ).rejects.toThrow(/decider_pair/i);
    });

    it('a membership from ANOTHER project can never be named — the composite FK forbids it', async () => {
      const foreign = await member('contractor', 'Other Site Hand', f.projectB.id);
      await expect(
        svc.create(f.projectA.id, input({ deciderKind: 'member', deciderMembershipId: foreign.membershipId }), pmc()),
      ).rejects.toThrow();
      // ...and the direct write is refused by the FK itself, not merely by the service
      await svc.create(f.projectA.id, input({ publish: false }), pmc());
      const id = await latest();
      await expect(
        hostile.$executeRawUnsafe(
          `UPDATE "Decision" SET "deciderKind" = 'member', "deciderMembershipId" = $1 WHERE "id" = $2`,
          foreign.membershipId, id,
        ),
      ).rejects.toThrow();
    });

    it('a named holder can never silently move to another user — Membership.userId is frozen', async () => {
      const named = await member('contractor', 'Bhavesh Patel');
      const stranger = await member('contractor', 'Someone Else');
      await svc.create(f.projectA.id, input({ deciderKind: 'member', deciderMembershipId: named.membershipId }), pmc());
      await expect(
        hostile.$executeRawUnsafe('UPDATE "Membership" SET "userId" = $1 WHERE "id" = $2', stranger.userId, named.membershipId),
      ).rejects.toThrow();
    });

    it('publishing a ROLE-held decision into a project with nobody in that role is refused', async () => {
      // project B has a pmc but no client at all — a client-held decision has no holder there
      const bPmc = (await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectB.id, role: 'pmc', status: 'active' } })).userId;
      await expect(
        svc.create(f.projectB.id, { ...input(), title: 'Holderless' } as CreateDecisionInput, { sub: bPmc, role: 'pmc', projectId: f.projectB.id } as AuthUser),
      ).rejects.toThrow(/currently holds the Client role|holds the client role/i);
    });
  });

  // ── P22 — the audience follows the decider ─────────────────────────────────────────────────
  describe('P22 — the audience follows the decider, live AND projected', () => {
    it('the named contractor SEES their pending decision; a same-role peer does not', async () => {
      const named = await member('contractor', 'Bhavesh Patel');
      const peer = await member('contractor', 'Dinesh Rao');
      await svc.create(f.projectA.id, input({ deciderKind: 'member', deciderMembershipId: named.membershipId }), pmc());
      const id = await latest();

      const mine = await query.snapshotSlice(f.projectA.id, 'contractor', named.userId);
      const theirs = await query.snapshotSlice(f.projectA.id, 'contractor', peer.userId);
      expect(mine.decisions.map((d) => d.id)).toContain(id);
      expect(theirs.decisions.map((d) => d.id)).not.toContain(id);
    });

    it('the PROJECTED slice draws the same line — and a rebuild preserves it', async () => {
      const named = await member('contractor', 'Bhavesh Patel');
      const peer = await member('contractor', 'Dinesh Rao');
      await svc.create(f.projectA.id, input({ deciderKind: 'member', deciderMembershipId: named.membershipId }), pmc());
      const id = await latest();
      await applyProjection(f.projectA.id);

      // eslint-disable-next-line no-console
      // eslint-disable-next-line no-console
      const projMine = await query.projectionSlice(f.projectA.id, 'contractor', named.userId);
      const projTheirs = await query.projectionSlice(f.projectA.id, 'contractor', peer.userId);
      expect(projMine.generation).not.toBeNull();
      expect(projMine.decisions.map((d) => d.id)).toContain(id);
      expect(projTheirs.decisions.map((d) => d.id)).not.toContain(id);

      // live == projection: the stored holder columns match canonical, field for field
      const gen = await t.prisma.projectionGeneration.findFirstOrThrow({
        where: { consumer: DECISIONS_PROJECTION, projectId: f.projectA.id, status: 'active' },
      });
      const canonical = await computeDecisionRows(t.prisma, f.projectA.id);
      expect(await storedDecisionRows(t.prisma, gen.id)).toEqual(canonical);
      expect(canonical.find((r) => r.decisionId === id)).toMatchObject({ deciderKind: 'member', deciderUserId: named.userId });

      await rebuilder.rebuild(DECISIONS_PROJECTION, f.projectA.id);
      const after = await query.projectionSlice(f.projectA.id, 'contractor', named.userId);
      expect(after.decisions.map((d) => d.id)).toContain(id);
    });
  });
});
