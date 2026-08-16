import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { OrgsService } from '../../src/orgs/orgs.service';
import { MembersService } from '../../src/orgs/members.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i — the ROUND-6 CORRECTION (Codex, eight comments / seven findings on `ccaf2dd`).
 *
 * Four P1 and three P2. Every probe here was RED at `ccaf2dd` with `20270821000000` AND the service
 * half of its finding reverted, on a scratch database migrated only to `20270820000000`.
 *
 * Two of the four P1s (R6-2, R6-4) are the SEAM again — the surface half of a unit whose facts
 * shipped without it. R6-4 is the gate finishing what round 5 started: a contract gate that guards
 * `create` and not `publish` is not a gate. R6-2 is different in kind and cannot be gated away:
 * `deciderKind: 'none'` was deliberately KEPT, so records are creatable, served to the whole team,
 * and the register must therefore render them truthfully. Finishing what was kept is not scope
 * creep — it is the other half of keeping it.
 */
describe('Phase 6 unit 4b-i round 6 — the seven Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let orgs: OrgsService;
  let members: MembersService;
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 8);

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    orgs = t.app.get(OrgsService);
    members = t.app.get(MembersService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    await t.prisma.decisionApprovalRevision.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.commandExecution.deleteMany({ where: { projectId: f.projectA.id } });
    for (const [userId, role] of [[f.memberUser.id, 'pmc'], [f.clientUser.id, 'client']] as const) {
      if (!(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId } }))) {
        await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId, role, status: 'active' } });
      } else {
        await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId }, data: { role, status: 'active' } });
      }
    }
    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: { startsWith: `r6-${run}` } } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: `r6-${run}` } } });
    await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgA.id, userId: { notIn: [f.ownerUser.id] } } });
    if (!(await t.prisma.orgMembership.count({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } }))) {
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: f.ownerUser.id, role: 'owner' } });
    } else {
      await t.prisma.orgMembership.updateMany({ where: { orgId: f.orgA.id, userId: f.ownerUser.id }, data: { role: 'owner' } });
    }
  });

  const seedDraft = async (over: Record<string, unknown> = {}): Promise<string> => {
    const id = `DL-t4bc6-${run}-${seq++}`;
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

  const twoOptions = [
    { material: 'Teak', delta: 0, swatch: 'sw1', recommended: true },
    { material: 'Oak', delta: 100, swatch: 'sw2', recommended: false },
  ];

  // ── R6-1 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R6-1: EVERY approval transition carries its attribution — the act is the rule, not the columns written', async () => {
    // At `ccaf2dd` the completeness check ran only when a tuple column BECAME non-null, so a
    // direct writer could approve while writing nothing. R2-1 then forbids ever filling it: the
    // decision is permanently approved by nobody.
    const bare = await seedDraft();
    await expect(
      t.prisma.decision.update({ where: { id: bare }, data: { status: 'approved' } }),
    ).rejects.toThrow(/records WHO approved it/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: bare } })).status).toBe('pending');

    // …and the hole it left is exactly what R2-1 cannot repair — proven by trying
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b_recorded_seal"`,
    );
    await t.prisma.decision.update({ where: { id: bare }, data: { status: 'approved' } });
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b_recorded_seal"`,
    );
    await expect(
      t.prisma.decision.update({ where: { id: bare }, data: { approvedDeciderKind: 'client', approvedDeciderLabel: 'Client' } }),
    ).rejects.toThrow(/may only be written by an approval/);

    // PRECISION — an approval that DOES carry its attribution commits, and a RE-approval carries
    // the frozen tuple forward without being re-bound to the holder's current name
    const live = await seedDraft();
    await t.prisma.decision.update({ where: { id: live }, data: { publishedAt: new Date() } });
    await svc.approve(f.projectA.id, live, { optionIndex: 0 } as never, { sub: f.clientUser.id, role: 'client', projectId: f.projectA.id } as AuthUser);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: live } })).approvedDeciderLabel).toBe('Client');
    await svc.requestChange(f.projectA.id, live, { reason: 'Rework', costImpact: 0, timeImpactDays: 0 } as never, pmc());
    await svc.approve(f.projectA.id, live, { optionIndex: 1 } as never, { sub: f.clientUser.id, role: 'client', projectId: f.projectA.id } as AuthUser);
    const reapproved = await t.prisma.decision.findUniqueOrThrow({ where: { id: live } });
    expect(reapproved.status).toBe('approved');
    expect(reapproved.approvedDeciderLabel).toBe('Client');
  });

  // ── R6-3 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R6-3: a label of TABS is as blank as a label of spaces — the whole ASCII whitespace set', async () => {
    // `btrim(x)` strips SPACES only. `addMemberSchema` admits a tab-or-newline-only name, and that
    // name becomes a member-held decision's expected label — so it passed the non-blank check AND
    // the equality check, and froze an attribution that renders as nothing.
    const userId = `r6-${run}-ws-${seq++}`;
    await t.prisma.user.create({
      data: { id: userId, projectId: f.projectA.id, role: 'contractor', name: '\t\n', email: `${userId}@t4bc6.test` },
    });
    const holder = await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId, role: 'contractor', status: 'active' },
    });
    const id = await seedDraft({ deciderKind: 'member', deciderMembershipId: holder.id });
    // the label the holder-label function itself derives — the one value the equality check admits
    await expect(
      t.prisma.decision.update({
        where: { id },
        data: {
          status: 'approved', approvedDeciderKind: 'member',
          approvedDeciderMembershipId: holder.id, approvedDeciderLabel: '\t\n',
        },
      }),
    ).rejects.toThrow(/records WHO approved it/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
  });

  // ── R6-4 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R6-4: the pmc/member surface gate covers PUBLICATION, not just the create contract', async () => {
    // `publish()` takes no body, so round 5's contract gate could not see this door at all. A
    // draft saved before the gate — or written directly — published straight through it, after
    // which the unchanged client audience demands an approval from the wrong party.
    const holderUser = `r6-${run}-h-${seq++}`;
    await t.prisma.user.create({
      data: { id: holderUser, projectId: f.projectA.id, role: 'contractor', name: 'Named holder', email: `${holderUser}@t4bc6.test` },
    });
    const holder = await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId: holderUser, role: 'contractor', status: 'active' },
    });
    const memberHeld = await seedDraft({ deciderKind: 'member', deciderMembershipId: holder.id });
    await expect(svc.publish(f.projectA.id, memberHeld, pmc())).rejects.toThrow(/decider audience \(unit 4b-ii\)/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: memberHeld } })).publishedAt).toBeNull();

    const pmcHeld = await seedDraft({ deciderKind: 'pmc' });
    await expect(svc.publish(f.projectA.id, pmcHeld, pmc())).rejects.toThrow(/decider audience \(unit 4b-ii\)/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: pmcHeld } })).publishedAt).toBeNull();

    // PRECISION — the two kinds 4b-i DOES serve publish exactly as before
    const clientHeld = await seedDraft();
    await svc.publish(f.projectA.id, clientHeld, pmc());
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: clientHeld } })).publishedAt).not.toBeNull();
  });

  // ── R6-5 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R6-5: publishing into a project whose ROLE holder has emptied is an actionable 409, not a 500', async () => {
    // The last client may legally leave: a DRAFT never blocked their removal. Publishing then
    // reaches `decision_t4b_publication_seal` with zero client standing, and at `ccaf2dd` the raw
    // PostgreSQL exception escaped — for both the saved-draft door and the one-step issue.
    const draft = await seedDraft();
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.clientUser.id }, data: { status: 'removed' },
    });

    const err = await svc.publish(f.projectA.id, draft, pmc()).catch((e) => e);
    expect(err, 'an emptied holder role is a conflict, not an internal error').toBeInstanceOf(ConflictException);
    expect(String(err.message)).toMatch(/no active client to decide it/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: draft } })).publishedAt).toBeNull();

    // …and the ONE-STEP issue takes the same door
    const err2 = await svc.create(f.projectA.id, {
      title: 'One-step, no client', room: 'Kitchen', publish: true, options: twoOptions,
    } as never, pmc()).catch((e) => e);
    expect(err2).toBeInstanceOf(ConflictException);
    expect(String(err2.message)).toMatch(/no active client to decide it/);

    // PRECISION — with the client back, both doors work
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.clientUser.id }, data: { status: 'active' },
    });
    await svc.publish(f.projectA.id, draft, pmc());
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: draft } })).publishedAt).not.toBeNull();
  });

  // ── R6-6 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R6-6: the org guard reads the DEPARTING role from the locked row, not from a pre-transaction read', async () => {
    // A stale `currentRole` of 'member' makes the guard return immediately — skipping every
    // readiness lock and holder check — and the delete then reaches the seal as the removal of the
    // sole pmc. The probe drives the same shape deterministically: the caller's pre-read says
    // 'member', the ROW says 'owner'.
    const secondId = `r6-${run}-own-${seq++}`;
    await t.prisma.user.create({
      data: { id: secondId, projectId: f.projectA.id, role: 'pmc', name: 'Second owner', email: `${secondId}@t4bc6.test` },
    });
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: secondId, role: 'owner' } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: secondId, role: 'contractor', status: 'active' } });

    // `ownerUser` is the sole EFFECTIVE pmc once the explicit pmc membership is gone
    const held = await seedDraft({ deciderKind: 'pmc' });
    await t.prisma.decision.update({ where: { id: held }, data: { publishedAt: new Date() } });
    await t.prisma.$executeRawUnsafe(
      `DELETE FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2`, f.projectA.id, f.memberUser.id,
    );

    // INTERPOSE the race deterministically (the R3-7 pattern): the guard's PRE-READ is made to
    // answer `member` — exactly what transaction A sees when B promotes the target and commits
    // between A's read and A's write — while the ROW says `owner`. At `ccaf2dd` the guard trusted
    // the pre-read, returned immediately, took no readiness lock, asked no holder question, and
    // its delete reached the seal as the removal of the sole pmc.
    const owner = await t.prisma.orgMembership.findUniqueOrThrow({
      where: { orgId_userId: { orgId: f.orgA.id, userId: f.ownerUser.id } },
      include: { user: true },
    });
    const real = t.prisma.orgMembership.findUnique.bind(t.prisma.orgMembership);
    let staled = false;
    (t.prisma.orgMembership as unknown as { findUnique: unknown }).findUnique = (async (args: never) => {
      const row = await (real as (a: never) => Promise<unknown>)(args);
      if (!staled && row && (row as { userId?: string }).userId === f.ownerUser.id) {
        staled = true;
        return { ...owner, role: 'member' };
      }
      return row;
    }) as never;

    // the removal is refused with the ACTIONABLE conflict — and would be a 500 if the guard had
    // trusted a stale role
    const err = await orgs.removeOrgMember(f.orgA.id, secondId, f.ownerUser.id)
      .catch((e) => e)
      .finally(() => {
        (t.prisma.orgMembership as unknown as { findUnique: unknown }).findUnique = real as never;
      });
    expect(staled, 'the probe must actually have served a stale role, or it proves nothing').toBe(true);
    expect(err).toBeInstanceOf(ConflictException);
    expect(String(err.message)).toMatch(/no PMC to decide it/);
    expect(await t.prisma.orgMembership.count({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } })).toBe(1);

    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: secondId } });
  });

  // ── R6-7 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R6-7: activating a membership that DISPLACES the last pmc is an actionable 409, not a 500', async () => {
    // `ownerUser` is a membership-less org owner and therefore an effective pmc. Adding them to
    // the team in ANY non-pmc role removes that standing (an active membership DECIDES), and the
    // seal correctly refuses while a pmc-held decision is open. At `ccaf2dd` that reached the
    // caller as a raw PostgreSQL error.
    const held = await seedDraft({ deciderKind: 'pmc' });
    await t.prisma.decision.update({ where: { id: held }, data: { publishedAt: new Date() } });
    await t.prisma.$executeRawUnsafe(
      `DELETE FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2`, f.projectA.id, f.memberUser.id,
    );

    const owner = await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id } });
    const err = await members.add(f.projectA.id, pmc(), {
      name: owner.name, email: owner.email ?? undefined, role: 'contractor',
    } as never).catch((e) => e);
    expect(err, 'a displaced pmc is a conflict, not an internal error').toBeInstanceOf(ConflictException);
    expect(String(err.message)).toMatch(/would remove the last PMC/);

    // PRECISION — adding them AS pmc is exactly what the message suggests, and it is allowed
    await expect(members.add(f.projectA.id, pmc(), {
      name: owner.name, email: owner.email ?? undefined, role: 'pmc',
    } as never)).resolves.toMatchObject({ role: 'pmc' });
    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: f.ownerUser.id } });
  });
});
