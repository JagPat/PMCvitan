import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { OrgsService } from '../../src/orgs/orgs.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i round 12 — the three Codex findings on `7988f26`.
 *
 *   R12-1 (P2) the evidence FK's UPDATE action was declared one way and installed another.
 *   R12-2 (P2) `addOrgMember`'s upsert was the one org-roster door that never asked the holder
 *              question — a demotion through it escaped as a 500 instead of an actionable 409.
 *   R12-3 (P2) publication never revalidated a RECORD's author, so a draft saved by someone who
 *              later lost authority could still be published into a permanent register entry.
 *
 * R12-2 and R12-3 are both the shape this PR's root analysis names: **a rule asked at some of the
 * ways in.** R12-3 is the third door of three (INSERT and CONVERSION already asked); R12-2 is the
 * second door of two, and the third time that exact pair has appeared — R9-3 (`members.add` vs
 * `updateRole`) and R11-3 (the INSERT vs CONVERSION doors) were the first two.
 */
describe('Phase 6 unit 4b-i round 12 — the three Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let orgs: OrgsService;
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 8);

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    orgs = t.app.get(OrgsService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    // This suite mints its own users (the second org owner; whoever `addOrgMember` provisions), and
    // the shared fixture's cleanup only knows its own six — a leftover `User` blocks the project
    // delete on `User_projectId_fkey`. They are removed here, children first.
    const mine = await t.prisma.user.findMany({ where: { email: { endsWith: '@t4bc12.test' } }, select: { id: true } });
    const mineIds = mine.map((u) => u.id);
    if (mineIds.length) {
      await t.prisma.membership.deleteMany({ where: { userId: { in: mineIds } } });
      await t.prisma.orgMembership.deleteMany({ where: { userId: { in: mineIds } } });
      await t.prisma.user.deleteMany({ where: { id: { in: mineIds } } });
    }
    await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgA.id, userId: { notIn: [f.ownerUser.id] } } });
    if (!(await t.prisma.orgMembership.count({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } }))) {
      await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: f.ownerUser.id, role: 'owner' } });
    }
    await t.prisma.orgMembership.updateMany({ where: { orgId: f.orgA.id, userId: f.ownerUser.id }, data: { role: 'owner' } });
    for (const [userId, role] of [[f.memberUser.id, 'pmc'], [f.clientUser.id, 'client']] as const) {
      if (!(await t.prisma.membership.count({ where: { projectId: f.projectA.id, userId } }))) {
        await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId, role, status: 'active' } });
      } else {
        await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId }, data: { role, status: 'active' } });
      }
    }
  });

  // ── R12-1 ──────────────────────────────────────────────────────────────────────────────────

  it('R12-1: the evidence FK is NO ACTION on update in the database, and the Prisma model says so too', async () => {
    // The migration writes `REFERENCES "Decision"("id") ON DELETE CASCADE`; PostgreSQL's unstated
    // update action is NO ACTION. A Prisma relation, left unsaid, defaults to `onUpdate: Cascade` —
    // so the model described a database the migration does not install, and `prisma migrate diff`
    // emitted `ON DELETE CASCADE ON UPDATE CASCADE` for this constraint. A generated migration
    // would then have made a `Decision.id` re-key cascade into the one-time evidence.
    //
    // Round 11 claimed `schema-migration-drift.test.ts` proved this model matched. It does not:
    // that suite is deliberately scoped to the party models and says so in its own header. The
    // claim was overstated, so the check lives here, against the catalogue directly.
    // (`confupdtype`/`confdeltype`: 'a' = NO ACTION, 'c' = CASCADE.)
    //
    // THIS PROBE PASSES AT `7988f26` TOO, and that is not a defect in it. The database was always
    // NO ACTION; the disagreement was on the SCHEMA side, so no runtime behaviour differed and no
    // behavioural probe could have caught it. The reproduction is `prisma migrate diff` — without
    // `onUpdate: NoAction` it emits `ON DELETE CASCADE ON UPDATE CASCADE` for this constraint, and
    // with it the constraint disappears from the diff entirely. What this probe adds is the pin:
    // the database's actual action is now asserted, so the next silent divergence fails a test.
    const fk = await t.prisma.$queryRawUnsafe<Array<{ conname: string; onupdate: string; ondelete: string }>>(
      `SELECT conname, confupdtype::text AS onupdate, confdeltype::text AS ondelete
         FROM pg_constraint
        WHERE conrelid = '"DecisionLegacyApproval"'::regclass AND contype = 'f'`,
    );
    expect(fk).toEqual([
      { conname: 'DecisionLegacyApproval_decisionId_fkey', onupdate: 'a', ondelete: 'c' },
    ]);
  });

  // ── R12-3 ──────────────────────────────────────────────────────────────────────────────────

  /** A RECORD draft (`deciderKind: 'none'`, status `recorded`, unpublished, no options). */
  const seedRecordDraft = async (authorId: string): Promise<string> => {
    const id = `DL-t4bc12-rec-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Record ${id}`, room: 'Kitchen', status: 'recorded',
        deciderKind: 'none', ageDays: 0, photoSwatch: 'sw1', authorId, publishedAt: null,
      },
    });
    return id;
  };

  it('R12-3: publishing a RECORD whose author has since lost authority is REFUSED — the third door asks what the other two ask', async () => {
    // The draft is legal when saved: `f.memberUser` holds an active pmc membership, which is what
    // the INSERT door checks. Nothing about the draft changes afterwards — the AUTHOR's standing
    // does, which is exactly the case publication existed to revalidate and did not.
    const id = await seedRecordDraft(f.memberUser.id);
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.memberUser.id }, data: { status: 'removed' },
    });

    await expect(
      t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } }),
    ).rejects.toThrow(/decision authority/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).publishedAt).toBeNull();
  });

  it('R12-3 precision: a record whose author STILL holds authority publishes, and the option floor is unchanged', async () => {
    // The arm is a revalidation, not a new rule — nothing legal became illegal while the author's
    // standing held.
    const ok = await seedRecordDraft(f.memberUser.id);
    await t.prisma.decision.update({ where: { id: ok }, data: { publishedAt: new Date() } });
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: ok } })).publishedAt).not.toBeNull();

    // …and the `none` arm still refuses a record carrying options, so adding the authority check
    // did not displace the floor it shares the branch with.
    const withOptions = await seedRecordDraft(f.memberUser.id);
    await t.prisma.decisionOption.create({
      data: { decisionId: withOptions, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
    });
    await expect(
      t.prisma.decision.update({ where: { id: withOptions }, data: { publishedAt: new Date() } }),
    ).rejects.toThrow(/recorded issue carries no options/);
  });

  it('R12-3: the ordinary decision arms are untouched — a client-held draft still publishes', async () => {
    // The new arm is an ELSE on `deciderKind`, so it must not have changed what the member/client/
    // pmc arms do. Asserted rather than assumed.
    const id = `DL-t4bc12-ord-${run}-${seq++}`;
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
    await svc.publish(f.projectA.id, id, pmc());
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).publishedAt).not.toBeNull();
  });

  // ── R12-2 ──────────────────────────────────────────────────────────────────────────────────

  it('R12-2: adding an existing owner as `member` runs the SAME holder guard `updateOrgMemberRole` runs — a 409, not a 500', async () => {
    // The R4-4 fixture, reached through the OTHER door. `f.ownerUser` is left as the sole effective
    // pmc on projectA, and a second org owner (whose own active project membership makes their org
    // row supply nothing) performs the write.
    const id = `DL-t4bc12-pmc-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: 'PMC-held', room: 'Kitchen', status: 'pending',
        deciderKind: 'pmc', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    await t.prisma.$executeRawUnsafe(
      `DELETE FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2`, f.projectA.id, f.memberUser.id,
    );

    const second = await t.prisma.user.create({
      data: { projectId: f.projectA.id, role: 'pmc', name: 'Second owner', email: `second-${run}-${seq++}@t4bc12.test` },
    });
    await t.prisma.orgMembership.create({ data: { orgId: f.orgA.id, userId: second.id, role: 'owner' } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: second.id, role: 'contractor', status: 'active' } });

    // `addOrgMember` resolves an EXISTING identity by email, so this reaches the upsert's UPDATE
    // arm against `f.ownerUser` — a demotion, by the add door.
    const owner = await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id } });
    expect(owner.email, 'the fixture owner must be addressable by email for this door').toBeTruthy();

    // At `7988f26` this went straight to a top-level `orgMembership.upsert`: the seal refused it and
    // the raw PostgreSQL exception escaped as a 500. `updateOrgMemberRole` has answered the same
    // question with an actionable conflict since round 4 — the two doors now agree, and the
    // message is the guard's, not PostgreSQL's.
    await expect(
      orgs.addOrgMember(f.orgA.id, second.id, { email: owner.email ?? undefined, name: owner.name, role: 'member' } as never),
    ).rejects.toThrow(/no PMC to decide it/);

    // …and the owner is untouched.
    expect(
      (await t.prisma.orgMembership.findFirstOrThrow({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } })).role,
    ).toBe('owner');
  });

  it('R12-2: `addOrgMember` cannot strip the org\'s last owner either — the same sentence at the same door', async () => {
    // `updateOrgMemberRole` has refused this since it was written. The add door could do it
    // silently, which is not the finding's wording but is the identical rule at the identical
    // write — splitting them would leave the pair disagreeing again by the next round.
    const owner = await t.prisma.user.findUniqueOrThrow({ where: { id: f.ownerUser.id } });
    expect(await t.prisma.orgMembership.count({ where: { orgId: f.orgA.id, role: 'owner' } })).toBe(1);

    await expect(
      orgs.addOrgMember(f.orgA.id, f.ownerUser.id, { email: owner.email ?? undefined, name: owner.name, role: 'member' } as never),
    ).rejects.toThrow(/at least one owner/);
    expect(
      (await t.prisma.orgMembership.findFirstOrThrow({ where: { orgId: f.orgA.id, userId: f.ownerUser.id } })).role,
    ).toBe('owner');
  });

  it('R12-2 precision: an ordinary add still works — the guard refuses stranding, not membership', async () => {
    const added = await orgs.addOrgMember(f.orgA.id, f.ownerUser.id, {
      email: `fresh-${run}-${seq++}@t4bc12.test`, name: 'Fresh admin', role: 'admin',
    } as never);
    expect(added.orgRole).toBe('admin');

    // …and a pure CREATE short-circuits the guard rather than scanning every project: with no row
    // to lock, the departing role is the one being written.
    expect(await t.prisma.orgMembership.count({ where: { orgId: f.orgA.id, userId: added.userId } })).toBe(1);
  });
});
