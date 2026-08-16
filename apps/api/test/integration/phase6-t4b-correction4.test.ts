import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { OrgsService } from '../../src/orgs/orgs.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i — the ROUND-4 CORRECTION (Codex, five findings on head `87461e6`).
 *
 * Two P1 and three P2. Every probe here was RED at `87461e6` with `20270819000000` AND the service
 * half reverted.
 *
 * Three of the five (R4-3/R4-4/R4-5) are the SPOKESMAN class the review has now raised four times:
 * a seal is correct, the service in front of it never asks, and an ordinary conflict reaches the
 * caller as a 500. F9 and F12 were the first two; this round names the remaining doors.
 */
describe('Phase 6 unit 4b-i round 4 — the five Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let orgs: OrgsService;
  let seq = 0;
  let raceDb: PrismaClient;

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    orgs = t.app.get(OrgsService);
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
    await t.prisma.commandExecution.deleteMany({ where: { projectId: f.projectA.id } });
    // restore the fixture roster unconditionally — a failing probe must not strand the next one
    // (the lesson round 3's RED pass taught, one round earlier)
    if (!(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId: f.memberUser.id } }))) {
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    }
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.clientUser.id },
      data: { role: 'client', status: 'active' },
    });
    if (!(await t.prisma.orgMembership.count({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } }))) {
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: f.ownerUser.id, role: 'owner' } });
    } else {
      await t.prisma.orgMembership.updateMany({ where: { orgId: f.orgA.id, userId: f.ownerUser.id }, data: { role: 'owner' } });
    }
  });

  /** An UNPUBLISHED ordinary draft with two options, ready to publish. */
  const seedDraft = async (over: Record<string, unknown> = {}): Promise<string> => {
    const id = `DL-t4bc4-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Draft ${id}`, room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null, ...over,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    return id;
  };

  // ── R4-1 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R4-1: a RECORD carries no approval evidence in the REGISTER either — the forward count gains its reverse', async () => {
    // the conversion counts `DecisionApprovalRevision` on the way in; nothing sealed it after.
    // At `87461e6` a draft converted while the count was zero could be given a revision, and the
    // append-only trigger then made the contradiction permanent.
    const id = await seedDraft();
    const optionRow = await t.prisma.decisionOption.findFirstOrThrow({ where: { decisionId: id } });
    // the options stay: the zero-option floor is a PUBLICATION rule, and this row is a draft —
    // which is also what lets the revision's `(decisionId, optionKey)` FK resolve at all
    await t.prisma.$executeRaw`UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = ${id}`;

    await expect(
      t.prisma.decisionApprovalRevision.create({
        data: {
          id: `rev-t4bc4-${seq++}`,
          projectId: f.projectA.id, decisionId: id, optionKey: optionRow.optionKey, version: 1,
          approvedAt: new Date(), approvedById: f.clientUser.id,
        },
      }),
    ).rejects.toThrow(/no approver/);
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: id } })).toBe(0);

    // PRECISION — the same insert against an ordinary decision is untouched
    const live = await seedDraft();
    const liveOption = await t.prisma.decisionOption.findFirstOrThrow({ where: { decisionId: live } });
    await t.prisma.decisionApprovalRevision.create({
      data: {
        id: `rev-t4bc4-${seq++}`,
        projectId: f.projectA.id, decisionId: live, optionKey: liveOption.optionKey, version: 1,
        approvedAt: new Date(), approvedById: f.clientUser.id,
      },
    });
    expect(await t.prisma.decisionApprovalRevision.count({ where: { decisionId: live } })).toBe(1);
  });

  // ── R4-2 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R4-2: a decision BORN approved carries a complete tuple bound to its holder — the binding applies at birth, not only at the transition', async () => {
    const holder = await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.clientUser.id } });

    // (a) a mismatched tuple at birth — at `87461e6` the INSERT branch returned before the check
    await expect(
      t.prisma.decision.create({
        data: {
          id: `DL-t4bc4-born-${seq++}`, projectId: f.projectA.id, title: 'Born forged', room: 'K',
          status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
          approvedDeciderKind: 'pmc', approvedDeciderLabel: 'Forged Holder',
        },
      }),
    ).rejects.toThrow(/must record the decider/);

    // (b) a PARTIAL tuple at birth — half an attribution is an attribution
    await expect(
      t.prisma.decision.create({
        data: {
          id: `DL-t4bc4-half-${seq++}`, projectId: f.projectA.id, title: 'Born half-named', room: 'K',
          status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
          approvedDeciderKind: 'client',
        },
      }),
    ).rejects.toThrow(/WHOLE approval holder tuple or none of it/);

    // (b′) NO tuple at all — REFUSED as of round 11 (R11-3), and this arm is the record of why the
    // answer changed rather than a quiet rewrite.
    //
    // Round 4 permitted it, and the argument was sound AT THE TIME: an absent tuple was the shape
    // every pre-`20270815000000` approval is in, those rows persist in production, and the UPDATE
    // door admitted the same transition — so requiring the tuple here would have made being BORN
    // approved stricter than BECOMING approved. Measured rather than assumed, it failed 18 tests
    // across 10 suites, every one a legacy-shaped fixture.
    //
    // Round 10 removed BOTH halves of that argument. "Legacy" is no longer a shape any row can
    // wear; it is the finite set `20270827000000` stamped, and every member of it already exists.
    // And the UPDATE door is no longer laxer: `change → approved` without a tuple now requires
    // membership of that set too. So the doors agree again — at the stricter setting — and a row
    // inserted from here on with no tuple is not history, it is an approval nobody can be held to,
    // which R2-1 then makes permanent.
    await expect(
      t.prisma.decision.create({
        data: {
          id: `DL-t4bc4-bare-${seq++}`, projectId: f.projectA.id, title: 'Born nameless', room: 'K',
          status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
        },
      }),
    ).rejects.toThrow(/records WHO approved it/);

    // (c) a member-held row born approved in a DIFFERENT membership's name
    await expect(
      t.prisma.decision.create({
        data: {
          id: `DL-t4bc4-mem-${seq++}`, projectId: f.projectA.id, title: 'Born misattributed', room: 'K',
          status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
          deciderKind: 'member', deciderMembershipId: holder.id,
          approvedDeciderKind: 'member', approvedDeciderMembershipId: null, approvedDeciderLabel: 'Nobody',
        },
      }),
    ).rejects.toThrow(/decider's own membership/);

    // PRECISION — a COHERENT approved row is still born without complaint (the legacy import shape
    // a migration would carry forward, stated honestly rather than banned)
    const okId = `DL-t4bc4-ok-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id: okId, projectId: f.projectA.id, title: 'Born coherent', room: 'K',
        status: 'approved', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
        approvedDeciderKind: 'client', approvedDeciderLabel: 'Client',
      },
    });
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: okId } })).approvedDeciderKind).toBe('client');
  });

  // ── R4-3 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R4-3: publish HOLDS the readiness key the seal try-acquires — a contended key no longer 500s a valid publication', async () => {
    const id = await seedDraft();
    // A second session holds the project readiness key, exactly as a membership command does.
    // At `87461e6` neither publish path took the key, so the seal's try-acquire fired and Prisma
    // surfaced a raw PostgreSQL error; with the key held by the command the two SERIALIZE.
    const g = (() => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; })();
    let held!: () => void;
    const heldP = new Promise<void>((r) => (held = r));
    const holdTx = raceDb.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(
        'SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended($1, 0))) AS l',
        `readiness:${f.projectA.id}`,
      );
      held();
      await g.p;
    }, { timeout: 20_000, maxWait: 10_000 });
    await heldP;

    let settled = false;
    const publishing = svc.publish(f.projectA.id, id, pmc()).then(() => { settled = true; }, (e) => { settled = true; throw e; });
    for (let i = 0; i < 40 && !settled; i++) await new Promise((r) => setTimeout(r, 50));
    expect(settled, 'publish must WAIT for the readiness key, not be refused by the seal').toBe(false);
    g.open();
    await holdTx;
    await publishing;
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).publishedAt).not.toBeNull();
  });

  // ── R4-4 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R4-4: an org write that would strand a pmc-held decision is an actionable 409, not a raw database error', async () => {
    // one explicit pmc membership + the org owner: bring effective pmc standing to the org arm
    // alone, then publish a pmc-held decision.
    const id = await seedDraft({ deciderKind: 'pmc' });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    await t.prisma.$executeRawUnsafe(
      `DELETE FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2`, f.projectA.id, f.memberUser.id,
    );

    // an org OWNER performing the write; `f.ownerUser` is the sole effective pmc, so demoting or
    // removing them strands the decision. At `87461e6` both surfaced as a raw PG error → 500.
    // The CALLER must be an org owner who supplies NO pmc standing of their own, or the write
    // would be legal and the probe would be asserting the wrong thing: an active project
    // membership DECIDES, so this second owner operates on projectA as a contractor and the org
    // arm skips them. `f.ownerUser` is then the sole effective pmc.
    const second = await t.prisma.user.create({ data: { projectId: f.projectA.id, role: 'pmc', name: 'Second owner', email: `second-${seq++}@t4bc4.test` } });
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: second.id, role: 'owner' } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: second.id, role: 'contractor', status: 'active' } });

    await expect(
      orgs.updateOrgMemberRole(f.orgA.id, second.id, f.ownerUser.id, { role: 'member' } as never),
    ).rejects.toThrow(/no PMC to decide it/);
    await expect(
      orgs.removeOrgMember(f.orgA.id, second.id, f.ownerUser.id),
    ).rejects.toThrow(/no PMC to decide it/);
    expect(
      (await t.prisma.orgMembership.findFirstOrThrow({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } })).role,
    ).toBe('owner');

    // PRECISION — the second owner's ORG row supplies nothing (their active project membership
    // decides), so removing it is allowed and the guard does not fire
    await expect(orgs.removeOrgMember(f.orgA.id, f.ownerUser.id, second.id)).resolves.toEqual({ ok: true });
    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: second.id } });
    await t.prisma.user.delete({ where: { id: second.id } });
  });

  // ── R4-5 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R4-5: publishing a draft whose named member has left is a domain conflict — a draft never blocked their removal', async () => {
    const holder = await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.clientUser.id } });
    const id = await seedDraft({ deciderKind: 'member', deciderMembershipId: holder.id });
    // removing the member is EXPLICITLY allowed while the decision is only a draft — it is
    // weightless and its holder is editable, which is what makes this the end of an ordinary
    // sequence rather than an exotic one
    await t.prisma.membership.update({ where: { id: holder.id }, data: { status: 'removed' } });

    await expect(svc.publish(f.projectA.id, id, pmc())).rejects.toThrow(/re-point the draft/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).publishedAt).toBeNull();

    // the ONE-STEP issue names an inactive membership and gets the same actionable refusal
    await expect(
      svc.create(f.projectA.id, {
        title: 'One-step, dead holder', room: 'Kitchen', publish: true,
        deciderKind: 'member', deciderMembershipId: holder.id,
        options: [
          { material: 'Teak', delta: 0, swatch: 'sw1', recommended: true },
          { material: 'Oak', delta: 100, swatch: 'sw2', recommended: false },
        ],
      } as never, pmc()),
    ).rejects.toThrow(/not an active member/);

    // PRECISION — with the holder active again the departed-member refusal STOPS. Round 6 then
    // refuses the same publish for a different, stated reason (the `pmc`/`member` surface arrives
    // with 4b-ii), and the two messages are deliberately distinct: this probe is about the holder
    // spokesman, and it still proves the spokesman answered rather than the seal.
    await t.prisma.membership.update({ where: { id: holder.id }, data: { status: 'active' } });
    await expect(svc.publish(f.projectA.id, id, pmc())).rejects.toThrow(/decider audience \(unit 4b-ii\)/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).publishedAt).toBeNull();
  });
});
