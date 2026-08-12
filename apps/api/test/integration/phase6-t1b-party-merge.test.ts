import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CompaniesService } from '../../src/orgs/companies.service';
import { PartyMergeService } from '../../src/orgs/party-merge.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 6.1b — the operator merge/repoint command (plan §A).
 *
 * 6.1a created one party per existing row and merged nothing, on purpose. The cost is that a firm
 * which is both a `Vendor` and a `ProjectCompany` has TWO canonical identities, so a grant bound to
 * one cannot prove ownership of rows linked to the other. This is the command that records the
 * operator's judgement that they are one firm.
 */
describe('Phase 6 unit 6.1b — the party merge (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let vendors: VendorsService;
  let companies: CompaniesService;
  let merge: PartyMergeService;
  let capabilities: CapabilitiesService;
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
    merge = t.app.get(PartyMergeService);
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
      ['projectCompany', { projectId: { startsWith: 'it-p6m-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p6m-' } }],
      ['membership', { projectId: { startsWith: 'it-p6m-' } }],
      ['project', { id: { startsWith: 'it-p6m-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
    await t.prisma.auditLog.deleteMany({ where: { action: 'party.merge' } });
    await t.prisma.vendor.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    await t.prisma.externalParty.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
  }

  const freshProject = async (orgId = f.orgA.id): Promise<string> => {
    const id = `it-p6m-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };

  /** A directory row plus its party/association/source, written the way the service writes them. */
  const company = async (projectId: string, name: string): Promise<{ companyId: string; partyId: string }> => {
    const c = await companies.add(projectId, pmc(projectId), { name, kind: 'contractor' });
    const row = await t.prisma.projectCompany.findUniqueOrThrow({ where: { id: c.id } });
    return { companyId: c.id, partyId: row.partyId };
  };

  /** A vendor bound to a project — the OTHER origin kind, carrying its own party. */
  const boundVendor = async (projectId: string, name: string): Promise<{ vendorId: string; partyId: string }> => {
    const v = await vendors.create(f.orgA.id, { name }, orgAdmin(f.orgA.id));
    const row = await t.prisma.vendor.findUniqueOrThrow({ where: { id: v.id } });
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    return { vendorId: v.id, partyId: row.partyId };
  };

  const failure = async (fn: () => Promise<unknown>): Promise<string> => {
    try {
      await fn();
    } catch (e) {
      return `${(e as Error).message}`;
    }
    throw new Error('expected the merge to be REFUSED, and it was accepted');
  };

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

  // ── M1 ─────────────────────────────────────────────────────────────────────────────────────
  it('M1 — one firm reached two ways becomes ONE identity, with every copy repointed', async () => {
    const projectId = await freshProject();
    const { companyId, partyId: companyParty } = await company(projectId, 'ACME Construction');
    const other = await freshProject();
    const { vendorId, partyId: vendorParty } = await boundVendor(other, 'ACME Construction');

    // The state 6.1a deliberately leaves behind: the same firm, two canonical identities.
    expect(companyParty).not.toBe(vendorParty);

    const result = await merge.merge(f.orgA.id, {
      survivingPartyId: companyParty, absorbedPartyId: vendorParty,
    }, orgAdmin(f.orgA.id));

    expect(result.repointed.vendors).toBe(1);
    expect(result.absorbedName).toBe('ACME Construction');

    // EVERY copy moved — the plan's list is Vendor, ProjectVendor, ProjectCompany, ProjectParty and
    // both source tables. Anything left behind would be a stranded reference.
    const vendor = await t.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    expect(vendor.partyId).toBe(companyParty);
    const binding = await t.prisma.projectVendor.findFirstOrThrow({ where: { vendorId } });
    expect(binding.partyId).toBe(companyParty);
    const vendorSource = await t.prisma.projectPartyVendorSource.findFirstOrThrow({ where: { projectVendorId: binding.id } });
    expect(vendorSource.partyId).toBe(companyParty);
    const companyRow = await t.prisma.projectCompany.findUniqueOrThrow({ where: { id: companyId } });
    expect(companyRow.partyId).toBe(companyParty);

    // The absorbed identity is gone, and its association with it; the survivor now reaches BOTH
    // projects, which is the entire point — a firm-wide revocation can now find the whole firm.
    expect(await t.prisma.externalParty.count({ where: { id: vendorParty } })).toBe(0);
    const reach = await t.prisma.projectParty.findMany({ where: { partyId: companyParty }, select: { projectId: true } });
    expect(new Set(reach.map((r) => r.projectId))).toEqual(new Set([projectId, other]));

    // The operator's judgement is preserved where the deleted row cannot preserve it.
    const audit = await t.prisma.auditLog.findFirstOrThrow({ where: { action: 'party.merge' } });
    expect(audit.payload).toMatchObject({ absorbedPartyId: vendorParty, absorbedName: 'ACME Construction' });
  });

  // ── M2 ─────────────────────────────────────────────────────────────────────────────────────
  it('M2 — the refusals are scoped to the PARTY, not to any project the operator names', async () => {
    const projectId = await freshProject();
    const { partyId: a } = await company(projectId, 'Firm A');
    const { partyId: b } = await company(await freshProject(), 'Firm B');

    // Cross-org: a party is org-scoped, and merging across tenants would move one org's firm
    // identity into another's.
    const foreign = await t.prisma.externalParty.create({
      data: { orgId: f.orgB.id, name: 'Other Tenant Firm', createdById: null },
    });
    expect(await failure(() => merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: foreign.id }, orgAdmin(f.orgA.id))))
      .toMatch(/must belong to this organisation/i);

    // Merging a party into itself is not a no-op to be tolerated — it would delete the survivor.
    expect(await failure(() => merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: a }, orgAdmin(f.orgA.id))))
      .toMatch(/cannot be merged into itself/i);

    // Authority: reconciling firm identity is an org owner/admin act, not a project PMC's.
    expect(await failure(() => merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: b }, pmc(projectId))))
      .toMatch(/org owner\/admin/i);

    // §E — a promoted party carries the stable link to a future tenant, and the merge outlives this
    // unit. Merging it would either strand that link on an identity that no longer owns the
    // references, or move a TENANT relationship as a side effect of data cleanup.
    //
    // Promotion is applied LAST and never cleared, because 6.1a's one-way trigger refuses to clear
    // it — correctly. An earlier draft of this probe reset `promotedOrgId` to null so the party
    // could be reused, and the §E seal refused: the fixture, not the seal, was wrong.
    await t.prisma.externalParty.update({ where: { id: b }, data: { promotedOrgId: f.orgB.id } });
    expect(await failure(() => merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: b }, orgAdmin(f.orgA.id))))
      .toMatch(/promoted to a tenant organisation/i);
    // …and in the other direction: the refusal is about the PAIR, not about which side is named.
    expect(await failure(() => merge.merge(f.orgA.id, { survivingPartyId: b, absorbedPartyId: a }, orgAdmin(f.orgA.id))))
      .toMatch(/promoted to a tenant organisation/i);
  });

  // ── M3 ─────────────────────────────────────────────────────────────────────────────────────
  it('M3 — a same-project collision is refused in the operator’s vocabulary, before anything moves', async () => {
    const projectId = await freshProject();
    // TWO directory rows on ONE project, each with its own party — the operator has recorded the
    // same firm twice on the same site. `ProjectCompany` carries a unique `(projectId, partyId)`,
    // so repointing one onto the other's party would put two records of one firm on one project.
    //
    // Note what is NOT a collision: a company and a vendor binding sharing a project. The uniques
    // are per table, so one of each is the ordinary "firm reached both ways" case M1 covers — an
    // earlier draft of this probe used that shape and proved nothing.
    const { partyId: a } = await company(projectId, 'Twin One');
    const { partyId: b } = await company(projectId, 'Twin One (duplicate entry)');

    const message = await failure(() => merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: b }, orgAdmin(f.orgA.id)));
    // It names the PROJECT and the decision, not an index. PostgreSQL would have surfaced this as
    // an opaque unique violation partway through the repoint.
    expect(message).toMatch(/already present on project/i);
    expect(message).toContain(projectId);
    expect(message).not.toMatch(/_key|constraint/i);

    // Nothing moved: the refusal is decided before the first write.
    expect(await t.prisma.externalParty.count({ where: { id: b } })).toBe(1);
    expect(await t.prisma.projectCompany.count({ where: { projectId, partyId: b } })).toBe(1);
    expect(await t.prisma.projectParty.count({ where: { projectId, partyId: b } })).toBe(1);
  });

  // ── M4 — THE RACE, and the reason the lock exists ──────────────────────────────────────────
  /**
   * One transaction is not enough on its own. With party A on a `Vendor` and party B on a
   * `ProjectCompany`, an operator running A→B and another running B→A touch DISJOINT initial row
   * sets: neither blocks the other, both commit, and the duplicate firm has been reconciled into a
   * DIFFERENT duplicate — the vendor on B, the company on A, and both original identities gone.
   *
   * This probe was SEEN TO FAIL before the lock was trusted (Root D; 6.1a's C7 is the cautionary
   * case — a lock applied on reasoning alone with no red evidence). With the `FOR UPDATE` on both
   * roots in ascending `id` order, the second transaction blocks on the first, re-reads a world
   * where its absorbed party no longer exists, and is refused.
   */
  it('M4 — opposite-direction merges of the same pair cannot both commit', async () => {
    const projectId = await freshProject();
    const { partyId: a } = await company(projectId, 'Racing Firm');
    const { partyId: b } = await boundVendor(await freshProject(), 'Racing Firm');

    // A GENUINE overlap, not two calls with a sleep between them. The first draft of this probe
    // started the second merge 50ms after the first and asserted "exactly one succeeded" — it
    // passed with the lock REMOVED, because the two ran end to end and the loser merely found its
    // party already deleted. That is the same defect the audit records against the E2/E3 first
    // drafts, and C7 is the standing warning about trusting a lock with no red evidence.
    //
    // The barrier: a third session holds the LOWEST-id party locked. Because both directions sort
    // the pair and take the lower id FIRST, both merges must queue behind it — which is also why
    // the ascending order is deadlock-free rather than merely tidy. Only once both are confirmed
    // BLOCKED (read from `pg_stat_activity`, not guessed with a sleep) is the barrier released.
    // TWO DIFFERENT operators. They must be different because the authority check now locks the
    // caller's `OrgMembership` row first (the fix for the review's F2), so one operator racing
    // themselves would queue on that row and never reach the party root — the probe would still
    // pass, while measuring a different lock than the one it names. Two admins is also the
    // realistic shape: the race this guards against is two people reconciling the same pair.
    const secondAdmin = await t.prisma.orgMembership.upsert({
      where: { orgId_userId: { orgId: f.orgA.id, userId: f.memberUser.id } },
      create: { orgId: f.orgA.id, userId: f.memberUser.id, role: 'admin' },
      update: { role: 'admin' },
    });
    const otherAdmin = { sub: secondAdmin.userId, role: 'pmc', orgId: f.orgA.id } as AuthUser;

    const holder = new PrismaClient();
    const lower = [a, b].sort()[0]!;
    try {
      const held = reported();
      const release = latch();
      const barrier = holder.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "ExternalParty" WHERE "id" = $1 FOR UPDATE', lower);
        held.ready();
        await release.waited;
      }, { timeout: 30_000 });

      await held.arrived;
      const forward = merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: b }, orgAdmin(f.orgA.id))
        .then(() => 'ok' as const, (e: Error) => e);
      const reverse = merge.merge(f.orgA.id, { survivingPartyId: b, absorbedPartyId: a }, otherAdmin)
        .then(() => 'ok' as const, (e: Error) => e);

      // Condition-based: wait until BOTH merges are actually waiting on a lock. If the command did
      // not take one, this never becomes true and the probe fails here rather than passing blindly.
      const deadline = Date.now() + 15_000;
      let waiting = 0;
      while (Date.now() < deadline) {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%ExternalParty%'`);
        waiting = Number(rows[0]!.n);
        if (waiting >= 2) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting, 'both merges should be BLOCKED on the party root lock before the barrier lifts')
        .toBeGreaterThanOrEqual(2);

      release.open();
      await barrier;
      const results = await Promise.all([forward, reverse]);

      const fulfilled = results.filter((r) => r === 'ok');
      expect(fulfilled.length, `outcomes=${results.map((r) => (r === 'ok' ? 'ok' : (r as Error).message)).join(' | ')}`).toBe(1);

      // Exactly one identity survives, and it owns EVERYTHING. The failure this guards against is
      // not "an error was raised" but "both committed and the firm ended up split across two
      // parties that no longer exist as a pair".
      const survivors = await t.prisma.externalParty.findMany({
        where: { id: { in: [a, b] } }, select: { id: true },
      });
      expect(survivors).toHaveLength(1);
      const winner = survivors[0]!.id;
      const strays = await t.prisma.vendor.count({ where: { partyId: { not: winner }, orgId: f.orgA.id } });
      expect(strays, 'a vendor left on the absorbed identity').toBe(0);
      const strayCompanies = await t.prisma.projectCompany.count({ where: { partyId: { not: winner }, orgId: f.orgA.id } });
      expect(strayCompanies, 'a directory row left on the absorbed identity').toBe(0);
    } finally {
      await holder.$disconnect();
    }
  });

  // ── M5 ─────────────────────────────────────────────────────────────────────────────────────
  it('M5 — the merged firm can still be renamed, and the rename now counts real evidence', async () => {
    const projectId = await freshProject();
    const { companyId, partyId: a } = await company(projectId, 'Renamable Ltd');
    const { partyId: b } = await boundVendor(await freshProject(), 'Renamable Ltd');

    // Before the merge the directory row is the party's sole evidence, so a rename follows it.
    await companies.update(projectId, pmc(projectId), companyId, { name: 'Renamable Pvt' });
    expect((await t.prisma.externalParty.findUniqueOrThrow({ where: { id: a } })).name).toBe('Renamable Pvt');

    // After the merge the surviving party is justified by TWO sources — the directory row and the
    // vendor binding — so renaming it from one face is refused. That is the reconciliation
    // decision, not a side effect of a directory edit.
    await merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: b }, orgAdmin(f.orgA.id));
    await expect(companies.update(projectId, pmc(projectId), companyId, { name: 'Renamed After Merge' }))
      .rejects.toMatchObject({ status: 409 });
    expect((await t.prisma.externalParty.findUniqueOrThrow({ where: { id: a } })).name).toBe('Renamable Pvt');
  });

  // ── M6 ─────────────────────────────────────────────────────────────────────────────────────
  /**
   * The `collaboration` name is RESERVED until the resolver it gates exists. A flag that can be
   * switched on before the thing it governs means nothing when it is on.
   */
  it('M6 — the reserved capability name cannot be enabled, by service OR by raw insert', async () => {
    const projectId = await freshProject();

    // The friendly refusal: an operator gets a sentence naming the reason, not a constraint.
    expect(await failure(() => capabilities.enable(projectId, 'collaboration', f.memberUser.id)))
      .toMatch(/reserved/i);

    // The SEAL. A service check is scoped to the CALLER — the operator CLI, a repair script and a
    // raw insert all walk past it — and scoping a check to the caller rather than to the data it
    // protects is Root A of the 6.1a audit. So the refusal is the database's.
    expect(await failure(() => t.prisma.projectCapability.create({
      data: { projectId, capability: 'collaboration', enabledById: f.memberUser.id },
    }))).toMatch(/ProjectCapability_collaboration_reserved/);

    // BOTH ENDS. F1 was an obligation armed against one end only, so this asserts the other: an
    // existing row cannot be UPDATEd into the reserved name either. A CHECK covers both by
    // construction, which is why it was chosen over a trigger that would need arming twice.
    expect(await failure(() => t.prisma.$executeRawUnsafe(
      `UPDATE "ProjectCapability" SET "capability" = 'collaboration' WHERE "projectId" = $1`, projectId,
    ))).toMatch(/ProjectCapability_collaboration_reserved/);

    // …and the reservation is NARROW: it must not disturb the capabilities that do have behaviour.
    expect(await t.prisma.projectCapability.count({ where: { projectId, capability: MATERIALS_CAPABILITY } })).toBe(1);
    await capabilities.enable(projectId, 'labour', f.memberUser.id);
    expect(await t.prisma.projectCapability.count({ where: { projectId, capability: 'labour' } })).toBe(1);
  });

  // ── R1 (Codex F1) ──────────────────────────────────────────────────────────────────────────
  it('R1 — the merge is a REGISTERED command with an operator surface, not just a provider', async () => {
    // A service that production cannot invoke does not ship the command the unit promises. The
    // registry is where that claim is checkable: if this is absent, the module graph does not know
    // the command exists and no operator path can be traced to it.
    const { orgsManifest } = await import('../../src/orgs/orgs.manifest');
    expect(orgsManifest.commands).toContain('orgs.party.merge');

    // …and the surface itself exists and is wired as a runnable script. `capability:enable` is the
    // precedent: a rare, high-authority correction is an operator CLI, not an HTTP route.
    const { existsSync, readFileSync } = await import('node:fs');
    expect(existsSync(new URL('../../src/orgs/party-merge.cli.ts', import.meta.url))).toBe(true);
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['party:merge']).toContain('party-merge.cli.ts');
  });

  // ── R2 (Codex F2) ──────────────────────────────────────────────────────────────────────────
  /**
   * The authority check used to read `OrgMembership` on the top-level client, BEFORE
   * `executeCommand` opened its transaction — a promise about a moment that had already passed. A
   * revoke committing in between let a no-longer-admin delete and repoint firm identity.
   */
  it('R2 — org standing is checked under a row lock, so a concurrent revoke cannot be outrun', async () => {
    const projectId = await freshProject();
    const { partyId: a } = await company(projectId, 'Authority Firm');
    const { partyId: b } = await boundVendor(await freshProject(), 'Authority Firm');

    // Revoke the admin's standing BEFORE the merge runs: the refusal must come from the row as it
    // is inside the transaction, not from a value read earlier.
    await t.prisma.orgMembership.update({
      where: { orgId_userId: { orgId: f.orgA.id, userId: f.ownerUser.id } },
      data: { role: 'member' },
    });
    try {
      expect(await failure(() => merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: b }, orgAdmin(f.orgA.id))))
        .toMatch(/org owner\/admin/i);
      // Nothing moved.
      expect(await t.prisma.externalParty.count({ where: { id: b } })).toBe(1);
    } finally {
      await t.prisma.orgMembership.update({
        where: { orgId_userId: { orgId: f.orgA.id, userId: f.ownerUser.id } },
        data: { role: 'owner' },
      });
    }

    // The lock is the half a single-threaded test cannot show, so assert it directly: a session
    // holding the membership row must BLOCK the merge, which is only true if the merge reaches for
    // that row inside its own transaction.
    const holder = new PrismaClient();
    try {
      const held = reported();
      const release = latch();
      const barrier = holder.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(
          'SELECT "role" FROM "OrgMembership" WHERE "orgId" = $1 AND "userId" = $2 FOR UPDATE',
          f.orgA.id, f.ownerUser.id,
        );
        held.ready();
        await release.waited;
      }, { timeout: 30_000 });

      await held.arrived;
      const attempt = merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: b }, orgAdmin(f.orgA.id))
        .then(() => 'ok' as const, (e: Error) => e);

      const deadline = Date.now() + 15_000;
      let blocked = 0;
      while (Date.now() < deadline) {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%OrgMembership%'`);
        blocked = Number(rows[0]!.n);
        if (blocked >= 1) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(blocked, 'the merge must BLOCK on the membership row, which it only does if it reads it in-tx')
        .toBeGreaterThanOrEqual(1);
      release.open();
      await barrier;
      await attempt;
    } finally {
      await holder.$disconnect();
    }
  });

  // ── R3 (Codex F3) ──────────────────────────────────────────────────────────────────────────
  it('R3 — a keyed replay returns the SAME result, not undefined', async () => {
    const projectId = await freshProject();
    const { partyId: a } = await company(projectId, 'Replayable Ltd');
    const { partyId: b } = await boundVendor(await freshProject(), 'Replayable Ltd');
    const key = `merge-${a}-${b}`;

    const first = await merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: b }, orgAdmin(f.orgA.id), key);
    // The replay does not re-run the transaction, so there is no fresh value to hand back. The
    // absorbed party's NAME is unreadable by then — its row is gone — so the result has to come
    // from what the merge recorded, not from a re-derivation that cannot see the deleted identity.
    const replay = await merge.merge(f.orgA.id, { survivingPartyId: a, absorbedPartyId: b }, orgAdmin(f.orgA.id), key);

    expect(replay).toBeDefined();
    expect(replay.absorbedName).toBe('Replayable Ltd');
    expect(replay).toEqual(first);
    // …and it really was a replay: no second merge happened.
    expect(await t.prisma.auditLog.count({ where: { action: 'party.merge' } })).toBe(1);
  });

  // ── R4 (Codex F4) ──────────────────────────────────────────────────────────────────────────
  /**
   * The merge locks party roots and THEN repoints origin rows. `CompaniesService.update` used to
   * lock the `ProjectCompany` row first and reach for the party second, so the two paths held the
   * pair in opposite orders and PostgreSQL resolved it by aborting one as a deadlock.
   *
   * The order is now global — party root, then origin — so the second transaction QUEUES instead.
   */
  it('R4 — a merge and a concurrent rename take the party root in the SAME order, so neither deadlocks', async () => {
    const projectId = await freshProject();
    const { companyId, partyId: companyParty } = await company(projectId, 'Contended Firm');
    const { partyId: vendorParty } = await boundVendor(await freshProject(), 'Contended Firm');

    // The company must sit on the ABSORBED party, or the two paths never touch the same row: the
    // merge repoints `ProjectCompany WHERE partyId = absorbed`, so a company on the SURVIVING party
    // is untouched by it. An earlier draft merged the other way round and passed with the fix
    // removed — not because the orders agreed, but because the transactions were disjoint.
    const surviving = vendorParty;
    const absorbed = companyParty;

    const holder = new PrismaClient();
    try {
      // A third session holds the party the RENAME needs and the MERGE must repoint, so both
      // contenders queue behind it and are genuinely in flight together.
      const held = reported();
      const release = latch();
      const barrier = holder.$transaction(async (tx) => {
        await tx.$queryRawUnsafe('SELECT "id" FROM "ExternalParty" WHERE "id" = $1 FOR UPDATE', absorbed);
        held.ready();
        await release.waited;
      }, { timeout: 30_000 });
      await held.arrived;

      // ORDER MATTERS, and the first draft of this probe got it wrong. Both contenders were
      // launched together behind the barrier, so the rename usually reached the party first, won it
      // on release, and finished — no cycle, and the probe passed with the fix REMOVED.
      //
      // The cycle needs the merge to hold the party while the rename holds the COMPANY ROW. So the
      // merge is started first and confirmed waiting, which puts it at the head of the party's
      // queue; only then is the rename started. Without the ordering fix the rename takes the
      // company row and then queues for the party behind the merge, and on release the merge wins
      // the party, turns to update that company row, and the two are deadlocked by construction.
      const merging = merge.merge(f.orgA.id, { survivingPartyId: surviving, absorbedPartyId: absorbed }, orgAdmin(f.orgA.id))
        .then(() => 'ok' as const, (e: Error) => e);
      const waitersOnParty = async (): Promise<number> => {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT count(*)::bigint AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%ExternalParty%'`);
        return Number(rows[0]!.n);
      };
      const until = async (want: number): Promise<number> => {
        const deadline = Date.now() + 15_000;
        let n = 0;
        while (Date.now() < deadline) {
          n = await waitersOnParty();
          if (n >= want) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return n;
      };
      expect(await until(1), 'the merge must be queued on the party root before the rename starts')
        .toBeGreaterThanOrEqual(1);

      const renaming = companies.update(projectId, pmc(projectId), companyId, { name: 'Renamed Mid-Merge' })
        .then(() => 'ok' as const, (e: Error) => e);
      expect(await until(2), 'the rename must also be in flight, so the two genuinely contend')
        .toBeGreaterThanOrEqual(2);

      release.open();
      await barrier;
      const outcomes = await Promise.all([merging, renaming]);

      // The defect this guards against is a DEADLOCK, so the assertion is about the failure MODE:
      // whatever happens, PostgreSQL must not have had to break a cycle. A deadlock is 40P01.
      for (const o of outcomes) {
        if (o !== 'ok') {
          expect(`${(o as Error).message}`, 'a deadlock means the two paths still disagree on lock order')
            .not.toMatch(/deadlock|40P01/i);
        }
      }
      // The merge is the operation that must not be lost: identity reconciliation is the operator's
      // deliberate act, and a rename is an editing convenience.
      expect(outcomes[0], `merge outcome: ${outcomes[0] === 'ok' ? 'ok' : (outcomes[0] as Error).message}`).toBe('ok');
      expect(await t.prisma.externalParty.count({ where: { id: absorbed } })).toBe(0);
    } finally {
      await holder.$disconnect();
    }
  });
});
