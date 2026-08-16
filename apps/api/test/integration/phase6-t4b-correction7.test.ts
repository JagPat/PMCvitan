import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { MembersService } from '../../src/orgs/members.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i — the ROUND-7 CORRECTION (Codex, three findings on `39bfb39`).
 *
 * One P1 and two P2. Every probe here was RED at `39bfb39` with `20270822000000` AND the service
 * half of its finding reverted, on a scratch database migrated only to `20270821000000`.
 *
 * **All three are round 6's own defects, and all three are one class:** a guard STRICTER than the
 * rule it fronts. R7-1 met a RESTORATION with the demand it wrote for an ACT. R7-2 re-derived a
 * value the same migration says is frozen. R7-3 asked about a ROLE where the seal asks about an
 * ACTIVATION. This review has named that class twice before (R2-4, R3-6) — and round 6 produced
 * three fresh instances of it while closing four instances of the others. That is worth recording
 * plainly: a correction is a change, and changes have the same failure modes as the code they fix.
 */
describe('Phase 6 unit 4b-i round 7 — the three Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let members: MembersService;
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 8);

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;
  const client = (): AuthUser => ({ sub: f.clientUser.id, role: 'client', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
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
    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: { startsWith: `r7-${run}` } } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: `r7-${run}` } } });
    await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgA.id, userId: { notIn: [f.ownerUser.id] } } });
    if (!(await t.prisma.orgMembership.count({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } }))) {
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: f.ownerUser.id, role: 'owner' } });
    }
  });

  /** A PUBLISHED decision, optionally in the LEGACY shape: approved with no holder tuple. */
  const seedPublished = async (over: Record<string, unknown> = {}): Promise<string> => {
    const id = `DL-t4bc7-${run}-${seq++}`;
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
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    return id;
  };

  // ── R7-1 (P1) ──────────────────────────────────────────────────────────────────────────────
  it('R7-1: withdrawing a change request RESTORES an approval — it does not perform one', async () => {
    // ROUND 10 re-homed this probe's fixture, and the reason is the finding.
    //
    // R7-1 is about a rule that must not treat a RESTORATION as an ACT. Rounds 7-9 tried to
    // recognise a restoration from evidence a direct writer can manufacture, and lost every time;
    // `20270827000000` replaced that clause with membership of a set stamped ONCE, at upgrade time.
    // So a "legacy" row FABRICATED here — born approved with no tuple, minutes after the migration
    // ran — is no longer a legacy row in any sense the seal can honour, and simulating one would
    // mean proving the exemption works by defeating the property that makes it safe.
    //
    // The legacy arm therefore moved to `scripts/upgrade-proof.sh`, which plants `UP4B2-D1` BEFORE
    // `20270827000000` and then migrates — the only place a genuine pre-migration approval exists.
    // What is still constructible here, and is the arm the PRODUCT actually walks, is the same
    // claim on an ordinary approval: a withdrawal returns the approval that already happened,
    // carrying its frozen tuple forward VERBATIM rather than performing a new act.
    const legacy = await seedPublished();
    await svc.approve(f.projectA.id, legacy, { optionIndex: 0 } as never, { sub: f.clientUser.id, role: 'client', projectId: f.projectA.id } as AuthUser);
    const approved = await t.prisma.decision.findUniqueOrThrow({ where: { id: legacy } });
    expect(approved.approvedDeciderKind).toBe('client');

    // reopen it, then withdraw the request — the ordinary product sequence
    await svc.requestChange(f.projectA.id, legacy, { reason: 'Second thoughts', costImpact: 0, timeImpactDays: 0 } as never, pmc());
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: legacy } })).status).toBe('change');
    await svc.withdrawChange(f.projectA.id, legacy, pmc());
    const restored = await t.prisma.decision.findUniqueOrThrow({ where: { id: legacy } });
    expect(restored.status).toBe('approved');
    // a restoration invents nothing AND rewrites nothing: the act's own tuple, unchanged
    expect(restored.approvedDeciderKind).toBe(approved.approvedDeciderKind);
    expect(restored.approvedDeciderMembershipId).toBe(approved.approvedDeciderMembershipId);
    expect(restored.approvedDeciderLabel).toBe(approved.approvedDeciderLabel);
    expect(
      await t.prisma.changeRequest.count({ where: { decisionId: legacy, status: 'open' } }),
      'the request must actually close',
    ).toBe(0);

    // PRECISION — the exemption is for a RESTORATION, not for `change → approved`. A direct writer
    // that ALTERS the approval while arriving there is performing an act and answers for it.
    //
    // That arm moved with the fixture, and for the same reason: the demand it trips is the
    // ATTRIBUTION demand, which only has anything to say about a row with no holder tuple. The row
    // above has one — it was approved through the service — so the arm needs a tupleless approval,
    // and after round 10 the only honest one is a pre-migration row. It is asserted verbatim in
    // `scripts/upgrade-proof.sh` against `UP4B2-D1`, where `v_restores` is false because the
    // evidence changed and the tupleless demand then refuses. The complementary half — that a
    // tupleless ARRIVAL is refused on any row the migration did not stamp — is
    // `phase6-t4b-correction10.test.ts` R10-1a/R10-1b.
  });

  // ── R7-2 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R7-2: a RE-approval carries the frozen tuple forward — even after the holder is renamed', async () => {
    // Round 6's migration says the binding applies only to the act that WRITES the tuple, so
    // history renders as it stood. The SERVICE re-derived the label every time, so a re-approval
    // after a rename offered the write-once arm a different value and it correctly refused —
    // rolling back a valid re-approval. Round 6's own probe used a CLIENT-held decision, whose
    // label is the constant 'Client', so it could not see this.
    const userId = `r7-${run}-holder-${seq++}`;
    await t.prisma.user.create({
      data: { id: userId, projectId: f.projectA.id, role: 'contractor', name: 'Original Name', email: `${userId}@t4bc7.test` },
    });
    const holder = await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId, role: 'contractor', status: 'active' },
    });
    const id = await seedPublished({ deciderKind: 'member', deciderMembershipId: holder.id });

    await svc.approve(f.projectA.id, id, { optionIndex: 0 } as never, { sub: userId, role: 'contractor', projectId: f.projectA.id } as AuthUser);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).approvedDeciderLabel).toBe('Original Name');

    // the person changes their name — an ordinary thing that happens to people
    await t.prisma.user.update({ where: { id: userId }, data: { name: 'Renamed Person' } });

    await svc.requestChange(f.projectA.id, id, { reason: 'Rework', costImpact: 0, timeImpactDays: 0 } as never, pmc());
    await svc.approve(f.projectA.id, id, { optionIndex: 1 } as never, { sub: userId, role: 'contractor', projectId: f.projectA.id } as AuthUser);

    const after = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('approved');
    expect(after.approvedOption, 'the re-approval DID land its new outcome').toBe('B');
    expect(after.approvedDeciderLabel, 'the attribution is the identity as it stood at the FIRST act').toBe('Original Name');

    // …and the announcement reads the same value the register renders, so the two cannot disagree
    const notices = await t.prisma.notification.findMany({ where: { projectId: f.projectA.id, decisionId: id } });
    expect(notices.some((n) => n.text.includes('Original Name'))).toBe(true);
    expect(notices.some((n) => n.text.includes('Renamed Person'))).toBe(false);
  });

  // ── R7-3 (P2) ──────────────────────────────────────────────────────────────────────────────
  it('R7-3: re-roling an ALREADY ACTIVE member displaces nobody — the guard asks what the seal asks', async () => {
    // The seal's activation arm fires on absent-or-inactive → active. Round 6's guard asked only
    // about the ROLE, so an org owner/admin who ALREADY holds an active membership — and is
    // therefore already suppressing their own org-derived pmc standing — was refused a role change
    // the database would have allowed.
    const owner = await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id } });
    // The org owner joins the team as a client FIRST — that activation is itself governed by the
    // seal, and it is legal here because `memberUser` still holds the explicit pmc membership. Once
    // they are on the team their org row supplies nothing, which is the state this probe is about.
    await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId: f.ownerUser.id, role: 'client', status: 'active' },
    });
    const held = await seedPublished({ deciderKind: 'pmc' });
    void held;

    // NOTE the mechanism, because it is why the SEAL had to move too: `members.add` upserts, Prisma
    // compiles that to `INSERT ... ON CONFLICT DO UPDATE`, and PostgreSQL fires the BEFORE INSERT
    // trigger with TG_OP = 'INSERT' even when the conflict path is taken. Restricting only the
    // service guard would have turned this false 409 into a raw 500.
    await expect(
      members.add(f.projectA.id, pmc(), { name: owner.name, email: owner.email ?? undefined, role: 'contractor' } as never),
    ).resolves.toMatchObject({ role: 'contractor' });

    // PRECISION — the guard is not disarmed. Make this an ACTUAL activation (the membership goes
    // away, `memberUser`'s pmc membership goes too, so the owner is the sole effective pmc) and
    // the same add is refused, because now it really does displace the last one.
    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: f.ownerUser.id } });
    await t.prisma.$executeRawUnsafe(
      `DELETE FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2`, f.projectA.id, f.memberUser.id,
    );
    await expect(
      members.add(f.projectA.id, pmc(), { name: owner.name, email: owner.email ?? undefined, role: 'contractor' } as never),
    ).rejects.toThrow(/would remove the last PMC/);
    void client;
  });
});
