import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CompaniesService } from '../../src/orgs/companies.service';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 6.1a — the eight Codex findings on head `9a03d95`, each reproduced RED here
 * before the fix. Numbered as the review numbered them.
 *
 *   C1  the migration is rerunnable after a mid-apply abort   (P1)
 *   C2  releasing an association serializes against a new source
 *   C3  a whitespace-only party name is refused
 *   C4  repointing a source rechecks the association it LEFT
 *   C5  `promotedOrgId` names a real Org
 *   C6  an identity-changing company update cannot desynchronise the party
 *   C7  two transactions removing the two last sources cannot both commit
 *   C8  a BOUND vendor can still be repointed onto another party (6.1b's merge)
 *
 * C1 is proven by `scripts/phase6-t1a-rerun-proof.sh`, which aborts a real apply partway and
 * re-runs it — a migration's rerunnability cannot be observed from inside a suite that runs
 * against an already-migrated database.
 */
describe('Phase 6 unit 6.1a — the review corrections (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let vendors: VendorsService;
  let companies: CompaniesService;
  let capabilities: CapabilitiesService;
  const participant = new OrgsParticipant();
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "ProjectPartyVendorSource", "ProjectPartyCompanySource", "ProjectParty", "ProjectVendor", "CommandExecution", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (orgId: string): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', orgId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    vendors = t.app.get(VendorsService);
    companies = t.app.get(CompaniesService);
    capabilities = t.app.get(CapabilitiesService);
  });

  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await cleanup();
    await f?.cleanup();
    await t?.close();
  });

  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await cleanup();
  });

  async function cleanup(): Promise<void> {
    for (const [model, where] of [
      ['projectCompany', { projectId: { startsWith: 'it-p6c-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p6c-' } }],
      ['membership', { projectId: { startsWith: 'it-p6c-' } }],
      ['project', { id: { startsWith: 'it-p6c-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
    await t.prisma.vendor.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    await t.prisma.externalParty.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
  }

  const freshProject = async (orgId = f.orgA.id): Promise<string> => {
    const id = `it-p6c-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };

  /**
   * A latch a held transaction waits on. `Promise.allSettled` over two transactions proves
   * nothing on its own — the driver is free to run them end to end, which is exactly what
   * happened on the first draft of C2 and C7: both passed while the defect was live. The
   * interleaving the review describes needs BOTH transactions to have done their work and
   * NEITHER to have committed, so each latch is opened only once both have reported ready.
   */
  const latch = (): { open: () => void; waited: Promise<void> } => {
    let open!: () => void;
    const waited = new Promise<void>((resolve) => { open = resolve; });
    return { open, waited };
  };
  const reported = (): { ready: () => void; arrived: Promise<void> } => {
    let ready!: () => void;
    const arrived = new Promise<void>((resolve) => { ready = resolve; });
    return { ready, arrived };
  };

  const failure = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (e) {
      return `${(e as Error).message}`;
    }
    throw new Error('expected the write to be REFUSED, and it was accepted');
  };

  /** A company plus its party/association/source, written the way the service writes them. */
  const company = async (projectId: string, name: string): Promise<{ companyId: string; partyId: string }> => {
    const c = await companies.add(projectId, pmc(projectId), { name, kind: 'contractor' });
    const row = await t.prisma.projectCompany.findUniqueOrThrow({ where: { id: c.id } });
    return { companyId: c.id, partyId: row.partyId };
  };

  // ── C3 ─────────────────────────────────────────────────────────────────────────────────────
  it('C3 — a party whose name is only whitespace is unrepresentable', async () => {
    // The company path copies the caller's name straight into the canonical party, so a name of
    // spaces and tabs would become the identity a resolver treats as the firm.
    const message = await failure(() =>
      t.prisma.externalParty.create({ data: { orgId: f.orgA.id, name: ' \t\n ', createdById: f.memberUser.id } }));
    expect(message).toMatch(/name_not_blank|violates check constraint/i);

    // …and the service path refuses it too, rather than relying on the column to catch it.
    const projectId = await freshProject();
    await expect(companies.add(projectId, pmc(projectId), { name: '   ', kind: 'contractor' })).rejects.toBeTruthy();

    // The negative control: a name with INTERNAL whitespace is a real firm name, not a blank one.
    const ok = await t.prisma.externalParty.create({ data: { orgId: f.orgA.id, name: 'A C M E  Ltd', createdById: null } });
    expect(ok.name).toBe('A C M E  Ltd');
  });

  // ── C5 ─────────────────────────────────────────────────────────────────────────────────────
  it('C5 — a promotion names a real Org, so the one-way freeze can never trap a typo', async () => {
    const party = await t.prisma.externalParty.create({ data: { orgId: f.orgA.id, name: 'Guest Firm', createdById: null } });

    // Without the reference the one-way trigger would freeze a nonexistent tenant FOREVER: the
    // value can never be corrected, because correcting it IS the transition the trigger refuses.
    const message = await failure(() =>
      t.prisma.externalParty.update({ where: { id: party.id }, data: { promotedOrgId: 'org-that-does-not-exist' } }));
    expect(message).toMatch(/promotedOrgId_fkey|violates foreign key/i);

    await t.prisma.externalParty.update({ where: { id: party.id }, data: { promotedOrgId: f.orgB.id } });
    expect((await t.prisma.externalParty.findUniqueOrThrow({ where: { id: party.id } })).promotedOrgId).toBe(f.orgB.id);

    await t.prisma.$executeRawUnsafe('ALTER TABLE "ExternalParty" DISABLE TRIGGER "ExternalParty_promotion_one_way"');
    await t.prisma.externalParty.update({ where: { id: party.id }, data: { promotedOrgId: null } });
    await t.prisma.$executeRawUnsafe('ALTER TABLE "ExternalParty" ENABLE TRIGGER "ExternalParty_promotion_one_way"');
  });

  // ── C4 ─────────────────────────────────────────────────────────────────────────────────────
  it('C4 — repointing a source rechecks the association it LEFT, not only the one it joined', async () => {
    const projectId = await freshProject();
    const a = await company(projectId, 'Firm A');
    // The surviving party a merge repoints ONTO, reached through a vendor binding — so it already
    // holds its own association, justified by a source of the other kind. (It cannot be a second
    // company: `(projectId, partyId)` is unique per origin kind, and that seal fires first.)
    const v = await vendors.create(f.orgA.id, { name: 'Firm A, as a vendor' }, orgAdmin(f.orgA.id));
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    const survivor = (await t.prisma.vendor.findUniqueOrThrow({ where: { id: v.id } })).partyId;

    // One statement, which is how a merge moves a source: the origin FK cascades A's company
    // source onto the survivor, and the association A leaves behind is justified by nothing. The
    // seal only fired on DELETE, so the abandoned association survived for the resolver to read.
    const message = await failure(() => t.prisma.$executeRawUnsafe(
      'UPDATE "ProjectCompany" SET "partyId" = $1 WHERE "id" = $2', survivor, a.companyId));
    expect(message).toMatch(/has no source justifying it/i);

    // A's association must not have been left behind with nothing supporting it.
    const orphans = await t.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM "ProjectParty" pp
        WHERE NOT EXISTS (SELECT 1 FROM "ProjectPartyCompanySource" s WHERE s."projectId" = pp."projectId" AND s."partyId" = pp."partyId")
          AND NOT EXISTS (SELECT 1 FROM "ProjectPartyVendorSource" s WHERE s."projectId" = pp."projectId" AND s."partyId" = pp."partyId")`);
    expect(Number(orphans[0]!.count)).toBe(0);
  });

  // ── C8 ─────────────────────────────────────────────────────────────────────────────────────
  it('C8 — a vendor that is already BOUND can still be repointed onto another party', async () => {
    const projectId = await freshProject();
    const v = await vendors.create(f.orgA.id, { name: 'Bound Vendor' }, orgAdmin(f.orgA.id));
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    const survivor = await t.prisma.externalParty.create({ data: { orgId: f.orgA.id, name: 'Surviving Firm', createdById: null } });

    const original = (await t.prisma.vendor.findUniqueOrThrow({ where: { id: v.id } })).partyId;

    // This is 6.1b's merge, in the shape it will actually take: give the surviving party its
    // association on this project, repoint the vendor, drop the association left behind. With the
    // binding's key frozen against updates the middle step is impossible in EITHER order —
    // moving the vendor first orphans the binding, moving the binding first names a parent key
    // that does not exist yet — so the merge could never reconcile a firm already trading on a
    // project, which is the case most worth reconciling.
    await t.prisma.$transaction(async (tx) => {
      await tx.projectParty.create({ data: { orgId: f.orgA.id, projectId, partyId: survivor.id } });
      await tx.$executeRawUnsafe('UPDATE "Vendor" SET "partyId" = $1 WHERE "id" = $2', survivor.id, v.id);
      await tx.projectParty.deleteMany({ where: { projectId, partyId: original } });
    });

    const binding = await t.prisma.projectVendor.findFirstOrThrow({ where: { projectId, vendorId: v.id } });
    expect(binding.partyId, 'the binding follows its vendor').toBe(survivor.id);
    const source = await t.prisma.projectPartyVendorSource.findFirstOrThrow({ where: { projectVendorId: binding.id } });
    expect(source.partyId, 'and so does the source that justifies the association').toBe(survivor.id);
    expect(await t.prisma.projectParty.count({ where: { projectId, partyId: original } })).toBe(0);
  });

  // ── C6 ─────────────────────────────────────────────────────────────────────────────────────
  it('C6 — an identity-changing company update cannot leave the party naming a different firm', async () => {
    const projectId = await freshProject();
    const { companyId, partyId } = await company(projectId, 'ACME');

    await companies.update(projectId, pmc(projectId), companyId, { name: 'Beta Constructions' });
    const party = await t.prisma.externalParty.findUniqueOrThrow({ where: { id: partyId } });
    expect(party.name, 'the canonical identity follows its only source').toBe('Beta Constructions');

    // A contact-detail edit is not an identity change and must stay freely editable.
    await companies.update(projectId, pmc(projectId), companyId, { contactName: 'A Person' });
    expect((await t.prisma.externalParty.findUniqueOrThrow({ where: { id: partyId } })).name).toBe('Beta Constructions');

    // Once the party has a SECOND justification the rename is no longer this row's to make:
    // renaming would silently rename the other origin's firm too.
    const v = await vendors.create(f.orgA.id, { name: 'Beta Constructions' }, orgAdmin(f.orgA.id));
    await t.prisma.$executeRawUnsafe('UPDATE "Vendor" SET "partyId" = $1 WHERE "id" = $2', partyId, v.id);
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));

    await expect(companies.update(projectId, pmc(projectId), companyId, { name: 'Gamma' }))
      .rejects.toMatchObject({ status: 409 });
    expect((await t.prisma.externalParty.findUniqueOrThrow({ where: { id: partyId } })).name).toBe('Beta Constructions');
  });

  // ── C2 ─────────────────────────────────────────────────────────────────────────────────────
  it('C2 — releasing an association serializes against a source being added for the same party', async () => {
    const projectId = await freshProject();
    const { companyId, partyId } = await company(projectId, 'Racing Firm');
    const v = await vendors.create(f.orgA.id, { name: 'Racing Firm (vendor)' }, orgAdmin(f.orgA.id));
    await t.prisma.$executeRawUnsafe('UPDATE "Vendor" SET "partyId" = $1 WHERE "id" = $2', partyId, v.id);

    // T1 removes the only source and asks whether the association still has a reason to exist.
    // T2 binds a vendor onto the SAME party. T1 reads its counts while T2 is still open, so it
    // sees zero, and then deletes an association T2 has just justified — leaving a bound vendor
    // the resolver cannot see. The latch holds T1 open across T2's whole write.
    const other = new PrismaClient();
    const t1Deleted = reported();
    const t2Wrote = reported();
    const t2Commit = latch();
    try {
      // T1 removes the only source, then — with T2's competing source already written and NOT yet
      // committed — asks the participant whether the association still has a reason to exist.
      // This calls the REAL method: an earlier draft inlined the count here to control the
      // barrier, which quietly bypassed the very code under test and passed.
      const t1 = t.prisma.$transaction(async (tx) => {
        await tx.projectCompany.delete({ where: { id: companyId } });
        t1Deleted.ready();
        await t2Wrote.arrived;
        await participant.releasePartyAssociationIfUnsourced(tx, { projectId, partyId });
      }, { timeout: 30_000 });

      await t1Deleted.arrived;
      const t2 = other.$transaction(async (tx) => {
        const created = await tx.projectVendor.create({
          data: { projectId, orgId: f.orgA.id, vendorId: v.id, boundById: f.memberUser.id, partyId },
        });
        await tx.projectPartyVendorSource.create({
          data: { orgId: f.orgA.id, projectId, partyId, projectVendorId: created.id },
        });
        t2Wrote.ready();
        await t2Commit.waited;
      }, { timeout: 30_000 }).catch((e: Error) => e);

      // Both have written and neither has committed — the exact window in which an unlocked
      // count returns zero. Give T1 a moment to reach (or block on) the association, then let
      // T2 commit.
      await t2Wrote.arrived;
      await new Promise((r) => setTimeout(r, 300));
      t2Commit.open();
      const settled = await Promise.allSettled([t1, t2]);

      const bindings = await t.prisma.projectVendor.count({ where: { projectId, partyId } });
      const assoc = await t.prisma.projectParty.count({ where: { projectId, partyId } });
      expect(
        bindings === 0 || assoc === 1,
        `a bound vendor (${bindings}) survives with no association (${assoc}); settled=${settled.map((s) => s.status).join(',')}`,
      ).toBe(true);
    } finally {
      await other.$disconnect();
    }
  });

  // ── C7 ─────────────────────────────────────────────────────────────────────────────────────
  it('C7 — two transactions removing the last two justifications cannot both commit', async () => {
    const projectId = await freshProject();
    const { companyId, partyId } = await company(projectId, 'Two Sources Ltd');
    const v = await vendors.create(f.orgA.id, { name: 'Two Sources Ltd (vendor)' }, orgAdmin(f.orgA.id));
    await t.prisma.$executeRawUnsafe('UPDATE "Vendor" SET "partyId" = $1 WHERE "id" = $2', partyId, v.id);
    const binding = await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));

    expect(await t.prisma.projectPartyCompanySource.count({ where: { projectId, partyId } })).toBe(1);
    expect(await t.prisma.projectPartyVendorSource.count({ where: { projectId, partyId } })).toBe(1);

    // Each transaction removes ONE justification and each sees the other's row still present, so
    // each concludes the association is still supported. Both commit and the association is left
    // with nothing — a resolver target for a firm no row justifies.
    const other = new PrismaClient();
    const aDone = reported();
    const bDone = reported();
    const commit = latch();
    try {
      const results = await Promise.allSettled([
        t.prisma.$transaction(async (tx) => {
          await tx.projectCompany.delete({ where: { id: companyId } });
          aDone.ready();
          await commit.waited;
        }, { timeout: 20_000 }),
        other.$transaction(async (tx) => {
          await tx.projectVendor.delete({ where: { id: binding.id } });
          bDone.ready();
          await commit.waited;
        }, { timeout: 20_000 }),
        // Both deletes are done and NEITHER has committed — the exact state in which each
        // deferred check is about to count the other's still-visible row. Only then do they run.
        (async () => { await Promise.all([aDone.arrived, bDone.arrived]); commit.open(); })(),
      ]);

      const orphans = await t.prisma.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS count FROM "ProjectParty" pp
          WHERE NOT EXISTS (SELECT 1 FROM "ProjectPartyCompanySource" s WHERE s."projectId" = pp."projectId" AND s."partyId" = pp."partyId")
            AND NOT EXISTS (SELECT 1 FROM "ProjectPartyVendorSource" s WHERE s."projectId" = pp."projectId" AND s."partyId" = pp."partyId")`);
      expect(
        Number(orphans[0]!.count),
        `settled=${results.map((r) => r.status).join(',')}`,
      ).toBe(0);
    } finally {
      await other.$disconnect();
    }
  });
});
