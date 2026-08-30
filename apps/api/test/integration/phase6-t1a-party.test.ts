import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CompaniesService } from '../../src/orgs/companies.service';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 unit 6.1a — the canonical external party (§A), its promotion seam (§E) and its tenancy
 * seals (§F), proven live against PostgreSQL.
 *
 * Every probe here asks one of the three questions §A's checklist says a derived structure owes:
 * what is its ORG seal, what does a MERGE do to it, where does it SERIALIZE. The last one is the
 * association's deferred constraint trigger, and it is the reason this file exists rather than a
 * service-level unit test: a check that fires at COMMIT cannot be observed by a mock.
 *
 *   6a  every path that creates a firm mints its canonical identity, and a vendor binding carries
 *       the VENDOR's party rather than a fresh one
 *   6b  one party, two origins, ONE association — and the association survives losing one source
 *       and dies with the last (the merge answer, exercised through the owner's participant)
 *   6c  an association with no source is refused at COMMIT, by name
 *   6d  the seal fires in BOTH directions — bypassing the service to delete the last source is
 *       refused, and the service path that releases first succeeds
 *   6e  `promotedOrgId` is one-way AND one-to-one per owner org — with the cross-org negative
 *       control that proves the uniqueness is scoped, not global
 *   6f  §F: a cross-tenant pairing is unrepresentable on every reference, each by a NAMED seal
 *   6g  one party holds at most one directory row and one binding per project — the seal 6.1b's
 *       merge needs in order to refuse a same-project collision rather than repoint into it
 */
describe('Phase 6 unit 6.1a — the canonical party, its seals and its promotion seam (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let vendors: VendorsService;
  let companies: CompaniesService;
  let capabilities: CapabilitiesService;
  const party = new OrgsParticipant();
  let seq = 0;

  const RESET_TABLES = ['ProjectPartyVendorSource', 'ProjectPartyCompanySource', 'ProjectParty',
    'ProjectVendor', 'CommandExecution', 'ProjectCapability'
  ] as const;

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
    await sanctionedReset(t?.prisma, RESET_TABLES, { cascade: true });
    await cleanupProjects();
    await t?.prisma.vendor.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    await t?.prisma.externalParty.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    await f?.cleanup();
    await t?.close();
  });

  afterEach(async () => {
    await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
    await cleanupProjects();
    await t.prisma.vendor.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    await t.prisma.externalParty.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
  });

  async function cleanupProjects(): Promise<void> {
    for (const [model, where] of [
      ['projectCompany', { projectId: { startsWith: 'it-p6-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p6-' } }],
      ['membership', { projectId: { startsWith: 'it-p6-' } }],
      ['project', { id: { startsWith: 'it-p6-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  }

  const freshProject = async (orgId = f.orgA.id): Promise<string> => {
    const id = `it-p6-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };

  /** The message PostgreSQL raised, whatever layer wrapped it. */
  const failure = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (e) {
      return `${(e as Error).message}`;
    }
    throw new Error('expected the write to be REFUSED, and it was accepted');
  };

  // ── 6a ─────────────────────────────────────────────────────────────────────────────────────
  it('6a — every path that creates a firm mints its canonical identity, and a binding carries the VENDOR’s party', async () => {
    const projectId = await freshProject();

    const vendor = await vendors.create(f.orgA.id, { name: 'ACME Supplies' }, orgAdmin(f.orgA.id));
    const vendorRow = await t.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    const vendorParty = await t.prisma.externalParty.findUniqueOrThrow({ where: { id: vendorRow.partyId } });
    expect(vendorParty.orgId, 'the party is scoped to the vendor’s own org').toBe(f.orgA.id);
    expect(vendorParty.name).toBe('ACME Supplies');
    expect(vendorParty.promotedOrgId, '§E: nothing in Phase 6 promotes a party').toBeNull();
    // Creating a vendor associates it with NO project — the org registry is not a project fact.
    expect(await t.prisma.projectParty.count({ where: { partyId: vendorRow.partyId } })).toBe(0);

    const binding = await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const bindingRow = await t.prisma.projectVendor.findUniqueOrThrow({ where: { id: binding.id } });
    expect(bindingRow.partyId, 'the binding mirrors the vendor’s party, it does not mint a second').toBe(vendorRow.partyId);
    expect(await t.prisma.externalParty.count({ where: { orgId: f.orgA.id } })).toBe(1);

    const assoc = await t.prisma.projectParty.findMany({ where: { projectId } });
    expect(assoc).toHaveLength(1);
    expect(assoc[0]!.partyId).toBe(vendorRow.partyId);
    expect(assoc[0]!.orgId).toBe(f.orgA.id);
    expect(await t.prisma.projectPartyVendorSource.count({ where: { projectVendorId: binding.id } })).toBe(1);

    const company = await companies.add(projectId, pmc(projectId), { name: 'Vitan Structural', kind: 'structural' });
    const companyRow = await t.prisma.projectCompany.findUniqueOrThrow({ where: { id: company.id } });
    expect(companyRow.orgId, 'the org copy is the project’s, bound to it at the database').toBe(f.orgA.id);
    const companyParty = await t.prisma.externalParty.findUniqueOrThrow({ where: { id: companyRow.partyId } });
    expect(companyParty.name).toBe('Vitan Structural');
    expect(companyParty.createdById, 'the act is attributable').toBe(f.memberUser.id);
    // 6.1 merges NOTHING: a directory entry and a vendor are two firms until an operator says so.
    expect(companyRow.partyId).not.toBe(vendorRow.partyId);

    expect(await t.prisma.projectParty.count({ where: { projectId } })).toBe(2);
    expect(await t.prisma.projectPartyCompanySource.count({ where: { projectCompanyId: company.id } })).toBe(1);
  });

  // ── 6b ─────────────────────────────────────────────────────────────────────────────────────
  it('6b — one party reached through two origins holds ONE association, which outlives losing a single source', async () => {
    const projectId = await freshProject();
    const vendor = await vendors.create(f.orgA.id, { name: 'Dual Role Pvt Ltd' }, orgAdmin(f.orgA.id));
    const vendorRow = await t.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    const binding = await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));

    // The shape 6.1b's merge produces: a directory row on the SAME party as the binding. Written
    // through the OWNER's participant, which is the only channel that may touch these tables.
    const companyId = await t.prisma.$transaction(async (tx) => {
      const row = await tx.projectCompany.create({
        data: { projectId, orgId: f.orgA.id, partyId: vendorRow.partyId, name: 'Dual Role Pvt Ltd', kind: 'contractor' },
      });
      await party.attachPartySource(tx, {
        orgId: f.orgA.id, projectId, partyId: vendorRow.partyId,
        origin: { kind: 'company', projectCompanyId: row.id },
      });
      return row.id;
    });

    expect(await t.prisma.projectParty.count({ where: { projectId } }), 'the association is REUSED, not duplicated').toBe(1);
    expect(await t.prisma.projectPartyCompanySource.count({ where: { projectId } })).toBe(1);
    expect(await t.prisma.projectPartyVendorSource.count({ where: { projectId } })).toBe(1);

    // Losing one justification is not losing the association — the binding still supports it.
    await companies.remove(projectId, pmc(projectId), companyId);
    expect(await t.prisma.projectParty.count({ where: { projectId } })).toBe(1);
    expect(await t.prisma.projectPartyCompanySource.count({ where: { projectId } })).toBe(0);

    // Losing the LAST one ends it.
    await t.prisma.$transaction(async (tx) => {
      await tx.projectVendor.delete({ where: { id: binding.id } });
      await party.releasePartyAssociationIfUnsourced(tx, { projectId, partyId: vendorRow.partyId });
    });
    expect(await t.prisma.projectParty.count({ where: { projectId } })).toBe(0);
    // The party itself survives: it is the org's record of a firm, not of a project relationship.
    expect(await t.prisma.externalParty.count({ where: { id: vendorRow.partyId } })).toBe(1);
  });

  // ── 6c ─────────────────────────────────────────────────────────────────────────────────────
  it('6c — an association with no source is refused at COMMIT, by name', async () => {
    const projectId = await freshProject();
    const created = await t.prisma.$transaction(async (tx) =>
      party.createParty(tx, { orgId: f.orgA.id, name: 'Unsourced Ltd', createdById: f.memberUser.id }));

    const message = await failure(() =>
      t.prisma.projectParty.create({ data: { orgId: f.orgA.id, projectId, partyId: created.id } }));
    expect(message).toContain('has no source justifying it');
    expect(await t.prisma.projectParty.count({ where: { projectId } })).toBe(0);

    // The negative control: the seal is DEFERRED, so the legitimate order — association first,
    // then the source that justifies it — commits. A NOT DEFERRABLE trigger would refuse this
    // too, and a probe that only proves refusal cannot tell the two apart.
    const companyId = await t.prisma.$transaction(async (tx) => {
      const row = await tx.projectCompany.create({
        data: { projectId, orgId: f.orgA.id, partyId: created.id, name: 'Unsourced Ltd', kind: 'other' },
      });
      await party.attachPartySource(tx, {
        orgId: f.orgA.id, projectId, partyId: created.id,
        origin: { kind: 'company', projectCompanyId: row.id },
      });
      return row.id;
    });
    expect(await t.prisma.projectParty.count({ where: { projectId } })).toBe(1);
    expect(companyId).toBeTruthy();
  });

  // ── 6d ─────────────────────────────────────────────────────────────────────────────────────
  it('6d — the seal fires in BOTH directions: removing the last source without releasing is refused', async () => {
    const projectId = await freshProject();
    const company = await companies.add(projectId, pmc(projectId), { name: 'Sole Source Co', kind: 'contractor' });

    // Bypass the service entirely. The CASCADE takes the source row with the company; what it
    // cannot do is decide the association has lost its reason to exist, so the deferred trigger
    // refuses the whole transaction. The service's release call is a convenience for the user,
    // not the thing standing between us and an orphaned association.
    const message = await failure(() => t.prisma.projectCompany.delete({ where: { id: company.id } }));
    expect(message).toContain('has no source justifying it');
    expect(await t.prisma.projectCompany.count({ where: { id: company.id } }), 'the refusal rolled the delete back').toBe(1);
    expect(await t.prisma.projectParty.count({ where: { projectId } })).toBe(1);

    // The service path releases first, so the delete the user asked for actually happens.
    await companies.remove(projectId, pmc(projectId), company.id);
    expect(await t.prisma.projectCompany.count({ where: { id: company.id } })).toBe(0);
    expect(await t.prisma.projectParty.count({ where: { projectId } })).toBe(0);
    expect(await t.prisma.projectPartyCompanySource.count({ where: { projectId } })).toBe(0);
  });

  // ── 6e ─────────────────────────────────────────────────────────────────────────────────────
  it('6e — promotion is one-way AND one-to-one per owner org, and the uniqueness is SCOPED', async () => {
    const mint = async (orgId: string, name: string): Promise<string> =>
      (await t.prisma.$transaction(async (tx) => party.createParty(tx, { orgId, name, createdById: null }))).id;

    const guest = await mint(f.orgA.id, 'Guest Firm');
    const sibling = await mint(f.orgA.id, 'Another Guest');
    const otherOwner = await mint(f.orgB.id, 'Guest Firm, seen by org B');

    // null → an org is the one permitted transition.
    await t.prisma.externalParty.update({ where: { id: guest }, data: { promotedOrgId: f.orgB.id } });

    const moved = await failure(() =>
      t.prisma.externalParty.update({ where: { id: guest }, data: { promotedOrgId: f.orgA.id } }));
    expect(moved).toContain('promotion cannot be moved or cleared');

    const cleared = await failure(() =>
      t.prisma.externalParty.update({ where: { id: guest }, data: { promotedOrgId: null } }));
    expect(cleared).toContain('promotion cannot be moved or cleared');

    // One owner org may not hold two parties resolving to the same tenant — the retry/repair
    // shape that one-way alone does not stop.
    const doubled = await failure(() =>
      t.prisma.externalParty.update({ where: { id: sibling }, data: { promotedOrgId: f.orgB.id } }));
    expect(doubled).toContain('Unique constraint failed on the fields: (`orgId`,`promotedOrgId`)');

    // …but a DIFFERENT owner org linking its own local party to the same tenant is the case §A
    // exists to support, and a global unique would have refused it.
    await t.prisma.externalParty.update({ where: { id: otherOwner }, data: { promotedOrgId: f.orgB.id } });
    expect((await t.prisma.externalParty.findUniqueOrThrow({ where: { id: otherOwner } })).promotedOrgId).toBe(f.orgB.id);

    // Clear the one-way column so `afterEach` can delete the rows.
    await t.prisma.$executeRawUnsafe('ALTER TABLE "ExternalParty" DISABLE TRIGGER "ExternalParty_promotion_one_way"');
    await t.prisma.externalParty.updateMany({ where: { id: { in: [guest, otherOwner] } }, data: { promotedOrgId: null } });
    await t.prisma.$executeRawUnsafe('ALTER TABLE "ExternalParty" ENABLE TRIGGER "ExternalParty_promotion_one_way"');
  });

  // ── 6f ─────────────────────────────────────────────────────────────────────────────────────
  it('6f — §F: a cross-tenant pairing is unrepresentable on every reference, each by a NAMED seal', async () => {
    const projectA = await freshProject(f.orgA.id);
    const foreign = await t.prisma.$transaction(async (tx) =>
      party.createParty(tx, { orgId: f.orgB.id, name: 'Org B’s party', createdById: null }));

    // i. the association itself — the ONLY table the resolver reads
    expect(await failure(() =>
      t.prisma.projectParty.create({ data: { orgId: f.orgB.id, projectId: projectA, partyId: foreign.id } })),
    ).toContain('ProjectParty_orgId_projectId_fkey');

    // ii. a directory row keeping its project on org A while claiming org B's party
    expect(await failure(() =>
      t.prisma.projectCompany.create({
        data: { projectId: projectA, orgId: f.orgB.id, partyId: foreign.id, name: 'Smuggled', kind: 'other' },
      })),
    ).toContain('ProjectCompany_orgId_projectId_fkey');

    // iii. a same-org directory row pointing at a party that is not in its org at all
    expect(await failure(() =>
      t.prisma.projectCompany.create({
        data: { projectId: projectA, orgId: f.orgA.id, partyId: foreign.id, name: 'Smuggled', kind: 'other' },
      })),
    ).toContain('ProjectCompany_orgId_partyId_fkey');

    // iv. a vendor claiming another org's party
    expect(await failure(() =>
      t.prisma.vendor.create({
        data: { orgId: f.orgA.id, name: 'Smuggled Vendor', partyId: foreign.id, createdById: f.memberUser.id },
      })),
    ).toContain('Vendor_orgId_partyId_fkey');

    // v. a binding whose party copy is not its OWN vendor's — same org, still refused, because
    //    the copy is bound THROUGH the vendor rather than to `ExternalParty` directly.
    const v1 = await vendors.create(f.orgA.id, { name: 'Real Vendor' }, orgAdmin(f.orgA.id));
    const v2 = await vendors.create(f.orgA.id, { name: 'Other Vendor' }, orgAdmin(f.orgA.id));
    const other = await t.prisma.vendor.findUniqueOrThrow({ where: { id: v2.id } });
    expect(await failure(() =>
      t.prisma.projectVendor.create({
        data: { projectId: projectA, orgId: f.orgA.id, vendorId: v1.id, partyId: other.partyId, boundById: f.memberUser.id },
      })),
    ).toContain('ProjectVendor_orgId_vendorId_partyId_fkey');

    expect(await t.prisma.projectParty.count({ where: { projectId: projectA } })).toBe(0);
  });

  // ── 6g ─────────────────────────────────────────────────────────────────────────────────────
  it('6g — one party holds at most one directory row and one binding per project', async () => {
    const projectId = await freshProject();
    const company = await companies.add(projectId, pmc(projectId), { name: 'Twice Ltd', kind: 'contractor' });
    const companyRow = await t.prisma.projectCompany.findUniqueOrThrow({ where: { id: company.id } });

    expect(await failure(() =>
      t.prisma.projectCompany.create({
        data: { projectId, orgId: f.orgA.id, partyId: companyRow.partyId, name: 'Twice Ltd (again)', kind: 'contractor' },
      })),
    ).toContain('Unique constraint failed on the fields: (`projectId`,`partyId`)');

    // Two vendors sharing one party is exactly what 6.1b's merge produces, and it is legitimate
    // at the org level. Binding BOTH to one project is the collision the merge must refuse, and
    // `(projectId, vendorId)` does not catch it because the vendors differ.
    const v1 = await vendors.create(f.orgA.id, { name: 'Merged A' }, orgAdmin(f.orgA.id));
    const v2 = await vendors.create(f.orgA.id, { name: 'Merged B' }, orgAdmin(f.orgA.id));
    const shared = (await t.prisma.vendor.findUniqueOrThrow({ where: { id: v1.id } })).partyId;
    await t.prisma.vendor.update({ where: { id: v2.id }, data: { partyId: shared } });

    await vendors.bind(projectId, { vendorId: v1.id }, pmc(projectId));
    expect(await failure(() => vendors.bind(projectId, { vendorId: v2.id }, pmc(projectId))))
      .toContain('Unique constraint failed on the fields: (`projectId`,`partyId`)');
    expect(await t.prisma.projectVendor.count({ where: { projectId } })).toBe(1);
  });
});
