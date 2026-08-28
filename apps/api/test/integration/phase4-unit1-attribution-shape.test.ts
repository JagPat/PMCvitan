import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Contractor-capture UNIT 1 (docs/ux/CONTRACTOR_CAPTURE_PROPOSAL.md §4 item 1) — the ATTRIBUTION
 * SHAPE, proven live against PostgreSQL: the party bindings, the DB-derived evidence snapshots,
 * and the six seals of the `20271010000000_ccu1_party_attribution` migration. Every probe here
 * exercises the DATABASE (raw SQL beside the real services), because the shape's whole claim is
 * that it holds for EVERY writer — the old release and direct SQL included — before any binding
 * command exists. §4.1 criteria proven here: 2 (an active allocation is binding reliance),
 * 5 (equality scopes to ACTIVE roster edges), 7 (the one-way lifecycle rule), 8 + 14 (the
 * commitment supplier party joins the frozen enumeration with exactly one NULL→value opening),
 * 11 (`phase6_project_party_sourced` counts the labour source), and 13 (binding ⇄ labour source
 * at commit, both directions). Criteria 1 and 9 (writer-side lock order and old-roster-writer
 * rollout) are unit 2's, proven with its commands' own barrier probes.
 */
describe('Contractor capture unit 1 — the attribution shape and its DB seals (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let commercial: LabourProcurementService;
  let capacity: LabourCapacityService;
  let vendors: VendorsService;
  let capabilities: CapabilitiesService;
  let raceDb: PrismaClient;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "LabourReadinessProjection", "ActivitiesProjection", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "WorkerPartyReliance", "MembershipPartyReliance", "ProjectPartyLabourSource", "ProjectPartyVendorSource", "ProjectPartyCompanySource", "ProjectParty", "ProjectVendor", "Vendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', projectId: '' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    commercial = t.app.get(LabourProcurementService);
    capacity = t.app.get(LabourCapacityService);
    vendors = t.app.get(VendorsService);
    capabilities = t.app.get(CapabilitiesService);
    raceDb = new PrismaClient(); // its own connection pool, isolated from the app's PrismaService
    await raceDb.$connect();
  });
  afterAll(async () => {
    await raceDb?.$disconnect();
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-ccu1-' } }],
      ['activity', { projectId: { startsWith: 'it-ccu1-' } }],
      ['membership', { projectId: { startsWith: 'it-ccu1-' } }],
      ['user', { id: { startsWith: 'u-ccu1-' } }],
      // deleting the project cascades its ProjectCompany directory rows, freeing the parties
      ['project', { id: { startsWith: 'it-ccu1-' } }],
      ['externalParty', { name: { startsWith: 'ccu1-party' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-ccu1-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const memberToken = async (projectId: string, role: 'contractor' | 'engineer'): Promise<{ auth: AuthUser; membershipId: string }> => {
    const u = await t.prisma.user.create({
      data: { id: `u-ccu1-${Date.now() % 1e6}-${seq++}`, projectId, role, name: `${role} probe`, email: `ccu1-${Date.now() % 1e6}-${seq++}@probe.test` },
    });
    const m = await t.prisma.membership.create({ data: { projectId, userId: u.id, role, status: 'active' } });
    return { auth: { sub: u.id, role, projectId } as AuthUser, membershipId: m.id };
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-CCU1-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };
  const onboardWorker = async (projectId: string): Promise<string> => {
    const w = await labour.onboardWorker(projectId, { name: `W${seq++}`, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    return w.id;
  };
  const freshCrew = async (projectId: string, inchargeWorkerId: string | null = null): Promise<string> => {
    const c = await t.prisma.crew.create({
      data: { projectId, name: `Crew ${seq++}`, inchargeWorkerId, activeFrom: new Date('2026-01-01'), createdById: f.memberUser.id },
    });
    return c.id;
  };
  /** an association justified by a LABOUR source only (criterion 11 makes this commit possible at all). */
  const labourParty = async (projectId: string): Promise<string> => {
    const party = await t.prisma.externalParty.create({ data: { orgId: f.orgA.id, name: `ccu1-party-${Date.now() % 1e6}-${seq++}`, createdById: f.ownerUser.id } });
    await t.prisma.$transaction([
      t.prisma.projectParty.create({ data: { orgId: f.orgA.id, projectId, partyId: party.id } }),
      t.prisma.projectPartyLabourSource.create({ data: { orgId: f.orgA.id, projectId, partyId: party.id } }),
    ]);
    return party.id;
  };
  /** an association justified by a COMPANY source (the pre-existing pattern), NO labour source. */
  const companyParty = async (projectId: string): Promise<{ partyId: string; projectCompanyId: string }> => {
    const party = await t.prisma.externalParty.create({ data: { orgId: f.orgA.id, name: `ccu1-party-${Date.now() % 1e6}-${seq++}`, createdById: f.ownerUser.id } });
    const pc = { partyId: '', projectCompanyId: '' };
    await t.prisma.$transaction(async (tx) => {
      await tx.projectParty.create({ data: { orgId: f.orgA.id, projectId, partyId: party.id } });
      const company = await tx.projectCompany.create({ data: { orgId: f.orgA.id, projectId, partyId: party.id, name: 'ccu1 Co', kind: 'contractor' } });
      await tx.projectPartyCompanySource.create({ data: { orgId: f.orgA.id, projectId, partyId: party.id, projectCompanyId: company.id } });
      pc.partyId = party.id; pc.projectCompanyId = company.id;
    });
    return pc;
  };
  const bindWorker = (projectId: string, workerId: string, partyId: string | null) =>
    t.prisma.worker.update({ where: { id: workerId }, data: { partyId } });
  const muster = (projectId: string, workerId: string, civilDate: string, shift: 'day' | 'night' = 'day') =>
    capacity.recordAttendance(projectId, { workerId, civilDate, shift, manualReason: 'roll call — ccu1 probe' }, pmc(projectId));
  const activeAllocation = async (projectId: string, activityId: string, workerId: string): Promise<string> => {
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 2 }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    const a = await capacity.allocate(projectId, { activityId, requirementId: r.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId));
    return a.allocations[0]!.id;
  };
  /** a committed CommandExecution receipt so a RAW evidence insert satisfies the provenance FK.
   *  Reserved-then-completed: the receipt protocol is DB-sealed, and a directly minted
   *  `succeeded` row is exactly the forgery it refuses. */
  const cmd = async (projectId: string): Promise<string> => {
    const c = await t.prisma.$transaction(async (tx) => {
      const created = await tx.commandExecution.create({
        data: { scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId: f.memberUser.id, commandType: 'ccu1.probe', idempotencyKey: `ccu1-${Date.now()}-${seq++}`, requestHash: 'h', status: 'reserved' },
      });
      await tx.commandExecution.update({
        where: { id: created.id }, data: { status: 'succeeded', resultRef: `fixture-${created.id}`, completedAt: new Date() },
      });
      return created;
    });
    return c.id;
  };
  /** the HOSTILE writer: a raw INSERT that SUPPLIES a party snapshot of its own choosing */
  const rawAttendance = async (projectId: string, workerId: string, forgedParty: string | null, civilDate = '2026-08-11'): Promise<string> => {
    const id = `ccu1-att-${Date.now() % 1e6}-${seq++}`;
    const commandId = await cmd(projectId);
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "LabourAttendance" ("id","projectId","workerId","civilDate","shift","manualReason","recordedById","sourceCommandId","workerPartyId")
       VALUES ($1,$2,$3,$4::date,'day','direct writer — ccu1 probe',$5,$6,$7)`,
      id, projectId, workerId, civilDate, f.memberUser.id, commandId, forgedParty,
    );
    return id;
  };
  const attendanceParty = async (id: string): Promise<string | null> =>
    (await t.prisma.labourAttendance.findUniqueOrThrow({ where: { id }, select: { workerPartyId: true } })).workerPartyId;

  // ── S2 + S1: the DB-derived, frozen evidence snapshot ────────────────────────────────────────

  it('S2/S1 · attendance snapshots the live binding at insert, and the extended enumeration freezes it', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const partyId = await labourParty(projectId);
    await bindWorker(projectId, workerId, partyId);

    const row = await muster(projectId, workerId, '2026-08-10');
    expect(await attendanceParty(row.id)).toBe(partyId);

    // S1 — the party snapshot joined the ENUMERATED append-only comparison; without the
    // extension this UPDATE would silently succeed (the enumeration is this column's only freeze)
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "LabourAttendance" SET "workerPartyId" = NULL WHERE "id" = $1`, row.id),
    ).rejects.toThrow(/APPEND-ONLY observation/);
    // …while the one legitimate update (the revocation stamp) still works and keeps the snapshot
    await t.prisma.$executeRawUnsafe(
      `UPDATE "LabourAttendance" SET "revokedAt" = now(), "revokedById" = $2, "revokeReason" = 'ccu1 probe' WHERE "id" = $1`,
      row.id, f.memberUser.id,
    );
    expect(await attendanceParty(row.id)).toBe(partyId);
  });

  it('S2 · the DB is the ONLY snapshot writer — a writer-supplied value is overwritten for every writer', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const unbound = await onboardWorker(projectId);
    const bound = await onboardWorker(projectId);
    const partyId = await labourParty(projectId);
    await bindWorker(projectId, bound, partyId);

    // a direct-SQL writer forges a snapshot on an UNBOUND worker → stored as NULL (the truth)
    const a = await rawAttendance(projectId, unbound, 'forged-party-id');
    expect(await attendanceParty(a)).toBeNull();
    // …and forges a WRONG snapshot on a bound worker → stored as the ACTUAL binding
    const b = await rawAttendance(projectId, bound, 'forged-party-id');
    expect(await attendanceParty(b)).toBe(partyId);
  });

  it('pre-attribution history stays NULL forever, and does not freeze the FIRST bind (NULL→party)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const partyId = await labourParty(projectId);

    const before = await muster(projectId, workerId, '2026-08-09'); // recorded while unbound
    expect(await attendanceParty(before.id)).toBeNull();
    // evidence with a NULL snapshot is pre-attribution history — it relies on no party, so the
    // first bind is permitted (§4: unit 2's backfill binds rosters before unit 4 trusts anything)
    await bindWorker(projectId, workerId, partyId);
    const after = await muster(projectId, workerId, '2026-08-10');
    expect(await attendanceParty(after.id)).toBe(partyId);
    expect(await attendanceParty(before.id)).toBeNull(); // never retroactively rewritten
  });

  it('S2 · the work fact carries the same derived snapshot; the generic full-row trigger freezes it unchanged', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const workerId = await onboardWorker(projectId);
    const partyId = await labourParty(projectId);
    await bindWorker(projectId, workerId, partyId);
    const allocationId = await activeAllocation(projectId, act, workerId);

    const work = await capacity.recordWork(projectId, { allocationId, civilDate: '2026-08-10', shift: 'day', workedMinutes: 60 }, pmc(projectId));
    const stored = await t.prisma.labourWorkFact.findUniqueOrThrow({ where: { id: work.id }, select: { workerPartyId: true } });
    expect(stored.workerPartyId).toBe(partyId);
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "LabourWorkFact" SET "workerPartyId" = NULL WHERE "id" = $1`, work.id),
    ).rejects.toThrow(/append-only/);
  });

  // ── S4: crew-party equality — deferred, null-strict, active edges only ───────────────────────

  it('S4 · an ACTIVE membership joining differently-bound worker and crew is refused AT COMMIT (null-strict)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const partyA = await labourParty(projectId);
    const partyB = await labourParty(projectId);
    const workerId = await onboardWorker(projectId);
    const crewId = await freshCrew(projectId);
    await bindWorker(projectId, workerId, partyA);
    await t.prisma.crew.update({ where: { id: crewId }, data: { partyId: partyB } });

    await expect(
      t.prisma.crewMembership.create({ data: { projectId, crewId, workerId, addedById: f.memberUser.id } }),
    ).rejects.toThrow(/different parties/);
    // null-strict: an UNBOUND worker cannot join a bound crew either
    const unbound = await onboardWorker(projectId);
    await expect(
      t.prisma.crewMembership.create({ data: { projectId, crewId, workerId: unbound, addedById: f.memberUser.id } }),
    ).rejects.toThrow(/different parties/);
  });

  it('S4/criterion 5 · a REMOVED membership edge blocks nothing — bindings that respect active edges commit', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const partyA = await labourParty(projectId);
    const partyB = await labourParty(projectId);
    const workerId = await onboardWorker(projectId);
    const crewId = await freshCrew(projectId);
    const m = await t.prisma.crewMembership.create({ data: { projectId, crewId, workerId, addedById: f.memberUser.id } });
    await t.prisma.crewMembership.update({ where: { id: m.id }, data: { removedAt: new Date(), removedById: f.memberUser.id } });

    // the historical mismatched edge is IGNORED: worker→A and crew→B both commit
    await bindWorker(projectId, workerId, partyA);
    await t.prisma.crew.update({ where: { id: crewId }, data: { partyId: partyB } });
    const crew = await t.prisma.crew.findUniqueOrThrow({ where: { id: crewId }, select: { partyId: true } });
    expect(crew.partyId).toBe(partyB);
  });

  it('S4 · the in-charge edge is equality-checked from the crew side and the worker side', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const partyA = await labourParty(projectId);
    const workerId = await onboardWorker(projectId);
    const crewId = await freshCrew(projectId, workerId);

    // binding only the crew strands its (null-bound) in-charge → refused at commit
    await expect(
      t.prisma.crew.update({ where: { id: crewId }, data: { partyId: partyA } }),
    ).rejects.toThrow(/in-charge|different parties/);
    // binding only the worker strands the (null-bound) crew it leads → refused from the other end
    await expect(bindWorker(projectId, workerId, partyA)).rejects.toThrow(/crew it actively belongs to \(or leads\)|different parties/);
  });

  it('S4 · an all-null roster moves to ONE party atomically in one transaction — a partial bind is refused', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const partyA = await labourParty(projectId);
    const w1 = await onboardWorker(projectId);
    const w2 = await onboardWorker(projectId);
    const crewId = await freshCrew(projectId, w1);
    await t.prisma.crewMembership.create({ data: { projectId, crewId, workerId: w1, addedById: f.memberUser.id } });
    await t.prisma.crewMembership.create({ data: { projectId, crewId, workerId: w2, addedById: f.memberUser.id } });

    // partial: crew alone → the deferred backstop refuses the commit
    await expect(
      t.prisma.crew.update({ where: { id: crewId }, data: { partyId: partyA } }),
    ).rejects.toThrow(/different parties|in-charge/);
    // atomic: crew + every member + the in-charge in ONE transaction → commits (the reason the
    // equality triggers are DEFERRABLE INITIALLY DEFERRED at all)
    await t.prisma.$transaction([
      t.prisma.worker.update({ where: { id: w1 }, data: { partyId: partyA } }),
      t.prisma.worker.update({ where: { id: w2 }, data: { partyId: partyA } }),
      t.prisma.crew.update({ where: { id: crewId }, data: { partyId: partyA } }),
    ]);
    const crew = await t.prisma.crew.findUniqueOrThrow({ where: { id: crewId }, select: { partyId: true } });
    expect(crew.partyId).toBe(partyA);
  });

  // ── S5 + S6: the one-way lifecycle and the evidence-dependent freeze ─────────────────────────

  it('S6/criterion 7 · the binding lifecycle is one-way at the DB for worker, crew AND membership', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const partyA = await labourParty(projectId);
    const partyB = await labourParty(projectId);
    const workerId = await onboardWorker(projectId);
    await bindWorker(projectId, workerId, partyA);

    // a direct party→party rewrite is unrepresentable in one statement, evidence or not
    await expect(bindWorker(projectId, workerId, partyB)).rejects.toThrow(/one-way/);
    // …the CAS shape (release, then bind) is the only path, and it works
    await bindWorker(projectId, workerId, null);
    await bindWorker(projectId, workerId, partyB);

    const crewId = await freshCrew(projectId);
    await t.prisma.crew.update({ where: { id: crewId }, data: { partyId: partyA } });
    await expect(t.prisma.crew.update({ where: { id: crewId }, data: { partyId: partyB } })).rejects.toThrow(/one-way/);

    const { membershipId } = await memberToken(projectId, 'contractor');
    await t.prisma.membership.update({ where: { id: membershipId }, data: { partyId: partyA } });
    await expect(
      t.prisma.membership.update({ where: { id: membershipId }, data: { partyId: partyB } }),
    ).rejects.toThrow(/one-way/);
  });

  it('S5 · party-stamped evidence freezes the worker binding; criterion 2 — so does an ACTIVE allocation', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const partyA = await labourParty(projectId);

    // (a) evidence: a muster recorded under the binding freezes it permanently
    const evidenced = await onboardWorker(projectId);
    await bindWorker(projectId, evidenced, partyA);
    await muster(projectId, evidenced, '2026-08-10');
    await expect(bindWorker(projectId, evidenced, null)).rejects.toThrow(/FROZEN/);

    // (b) an ACTIVE allocation is itself binding reliance — no evidence needed (criterion 2:
    // otherwise the release strands the allocation against a future rebind)
    const allocated = await onboardWorker(projectId);
    await bindWorker(projectId, allocated, partyA);
    const allocationId = await activeAllocation(projectId, act, allocated);
    await expect(bindWorker(projectId, allocated, null)).rejects.toThrow(/FROZEN/);
    // released in the same lifecycle → the binding is free again
    const released = await t.prisma.$executeRawUnsafe(
      `UPDATE "WorkerAllocation" SET "status" = 'released', "releasedAt" = now(), "releasedById" = $2, "releaseReason" = 'ccu1 probe' WHERE "id" = $1`,
      allocationId, f.memberUser.id,
    );
    expect(released).toBe(1);
    await bindWorker(projectId, allocated, null);

    // (c) a registered reliance row freezes it exactly like module-local evidence
    const registered = await onboardWorker(projectId);
    await bindWorker(projectId, registered, partyA);
    const r = await t.prisma.workerPartyReliance.create({ data: { projectId, workerId: registered, partyId: partyA, source: 'activity_output', refId: 'probe' } });
    await expect(bindWorker(projectId, registered, null)).rejects.toThrow(/FROZEN/);
    await t.prisma.workerPartyReliance.delete({ where: { id: r.id } });
    await bindWorker(projectId, registered, null);
  });

  it('S5 · the orgs Membership freeze reads ONLY the orgs-owned register', async () => {
    const projectId = await freshProject();
    const partyA = await labourParty(projectId);
    const { membershipId } = await memberToken(projectId, 'contractor');
    await t.prisma.membership.update({ where: { id: membershipId }, data: { partyId: partyA } });

    const r = await t.prisma.membershipPartyReliance.create({ data: { projectId, membershipId, partyId: partyA, source: 'labour_evidence', refId: 'probe' } });
    await expect(
      t.prisma.membership.update({ where: { id: membershipId }, data: { partyId: null } }),
    ).rejects.toThrow(/FROZEN/);
    await t.prisma.membershipPartyReliance.delete({ where: { id: r.id } });
    await t.prisma.membership.update({ where: { id: membershipId }, data: { partyId: null } });
  });

  // ── criteria 13 + 11: the labour source, both directions ─────────────────────────────────────

  it('criterion 13 · a binding with no labour-source row is refused at commit — and the source cannot leave while a binding remains', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    // an association justified by a COMPANY source only: the party is valid, but labour has no
    // justification row — an alternate writer binding a worker to it must be refused at commit.
    const { partyId } = await companyParty(projectId);
    const workerId = await onboardWorker(projectId);
    await expect(bindWorker(projectId, workerId, partyId)).rejects.toThrow(/owes its labour-source row/);

    // with the labour source in place the same bind commits …
    await t.prisma.projectPartyLabourSource.create({ data: { orgId: f.orgA.id, projectId, partyId } });
    await bindWorker(projectId, workerId, partyId);
    // … and now the source cannot be removed while the binding remains (the inverse seal)
    await expect(
      t.prisma.projectPartyLabourSource.delete({ where: { projectId_partyId: { projectId, partyId } } }),
    ).rejects.toThrow(/owes its labour-source row|removing that source is refused/);
    // release the binding → the source may go (the association stays company-justified)
    await bindWorker(projectId, workerId, null);
    await t.prisma.projectPartyLabourSource.delete({ where: { projectId_partyId: { projectId, partyId } } });
  });

  it('criterion 11 · phase6_project_party_sourced counts the labour source (a labour-only association commits; removing its last source is refused)', async () => {
    const projectId = await freshProject();
    // Before this migration the deployed function counted only company+vendor sources, so an
    // association justified ONLY by a labour source could never commit at all.
    const partyId = await labourParty(projectId);
    expect(await t.prisma.projectParty.count({ where: { projectId, partyId } })).toBe(1);

    // deleting the labour source while the association remains (and nothing else justifies it)
    // aborts at the structural seal
    await expect(
      t.prisma.projectPartyLabourSource.delete({ where: { projectId_partyId: { projectId, partyId } } }),
    ).rejects.toThrow(/has no source justifying it/);
    // the legitimate order — source and association leave together — commits
    await t.prisma.$transaction([
      t.prisma.projectPartyLabourSource.delete({ where: { projectId_partyId: { projectId, partyId } } }),
      t.prisma.projectParty.delete({ where: { projectId_partyId: { projectId, partyId } } }),
    ]);

    // and the criterion's exact scenario: company + labour sources, the company (with its origin)
    // leaves, the labour source alone keeps the association justified
    const both = await companyParty(projectId);
    await t.prisma.projectPartyLabourSource.create({ data: { orgId: f.orgA.id, projectId, partyId: both.partyId } });
    await t.prisma.projectCompany.delete({ where: { id: both.projectCompanyId } }); // cascades its source row
    expect(await t.prisma.projectParty.count({ where: { projectId, partyId: both.partyId } })).toBe(1);
  });

  // ── criteria 8 + 14: the commitment supplier party ───────────────────────────────────────────

  it('criteria 8/14 · supplierPartyId admits exactly ONE NULL→value transition and is frozen after', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId: act, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 2 }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    // the full Task-2 commercial chain down to a live commitment
    const vendor = await vendors.create(f.orgA.id, { name: `ccu1-party Supplier ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const requisition = await commercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [{ requirementId: r.requirementId, revision: r.revision, civilDate: '2026-08-10', personShiftQty: 2 }] }, pmc(projectId));
    const line = requisition.lines[0]!;
    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await commercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const rfq = await commercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await commercial.recordQuote(projectId, rfq.id, { vendorId: vendor.id, validUntil: '2027-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }] }, pmc(projectId));
    await commercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await commercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparisonId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    const po = await commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: 2 }] }, pmc(projectId));
    await commercial.issuePo(projectId, po.id, {}, pmc(projectId));
    const commitment = await commercial.commitCapacity(projectId, { poLineId: po.currentVersion.lines[0]!.id, promisedDate: '2026-08-10' }, pmc(projectId));

    // the ONE opening: NULL → value (the staged unit-2 dual-write/backfill shape)
    await t.prisma.$executeRawUnsafe(`UPDATE "CapacityCommitment" SET "supplierPartyId" = 'party-x' WHERE "id" = $1`, commitment.id);
    // …and the freeze after it: a set value never changes and never returns to NULL
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "CapacityCommitment" SET "supplierPartyId" = 'party-y' WHERE "id" = $1`, commitment.id),
    ).rejects.toThrow(/supplier party is one-way/);
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "CapacityCommitment" SET "supplierPartyId" = NULL WHERE "id" = $1`, commitment.id),
    ).rejects.toThrow(/supplier party is one-way/);
  });

  // ── S3: the FOR SHARE derivation serializes against the binding update, BOTH orderings ───────

  const reflect = <T>(p: Promise<T>): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }> =>
    p.then((value) => ({ status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason }));
  const blockedWaiters = async (queryLike: string): Promise<number> => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
      `SELECT COUNT(*)::int AS c FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
      queryLike,
    );
    return Number(rows[0]!.c);
  };
  const waitUntilBlocked = async (queryLike: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if ((await blockedWaiters(queryLike)) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`barrier timeout: expected a backend blocked on a lock while running ${queryLike}`);
  };

  it('S3 · insert-first: the held FOR SHARE blocks the binding update; the fact keeps the at-insert truth (NULL)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const partyId = await labourParty(projectId);
    const commandId = await cmd(projectId);
    const attId = `ccu1-race-${Date.now() % 1e6}-${seq++}`;

    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
    // session A (raceDb): inserts the muster — the trigger takes FOR SHARE on the worker row —
    // and HOLDS the transaction open
    const sessionA = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "LabourAttendance" ("id","projectId","workerId","civilDate","shift","manualReason","recordedById","sourceCommandId")
         VALUES ($1,$2,$3,'2026-08-10'::date,'day','ccu1 race probe',$4,$5)`,
        attId, projectId, workerId, f.memberUser.id, commandId,
      );
      await held;
    }, { timeout: 30_000 });

    // session B (the app pool): the binding update must BLOCK on that FOR SHARE — confirmed via
    // pg_stat_activity (condition-based, not a sleep) — then complete once A commits
    const sessionB = reflect(bindWorker(projectId, workerId, partyId));
    await waitUntilBlocked('%UPDATE%"Worker"%');
    releaseHeld();
    await sessionA;
    const b = await sessionB;
    expect(b.status).toBe('fulfilled');
    // the fact recorded the binding AS OF its insert — NULL, never the later party
    expect(await attendanceParty(attId)).toBeNull();
  });

  it('S3 · update-first: the uncommitted rebind blocks the insert; the fact derives the COMMITTED party', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const partyId = await labourParty(projectId);
    const commandId = await cmd(projectId);
    const attId = `ccu1-race-${Date.now() % 1e6}-${seq++}`;

    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
    // session A (raceDb): the binding update, held open uncommitted
    const sessionA = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "Worker" SET "partyId" = $1 WHERE "id" = $2`, partyId, workerId);
      await held;
    }, { timeout: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 100)); // let A reach the UPDATE

    // session B (the app pool): the evidence insert's FOR SHARE must block on A's row lock
    const sessionB = reflect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "LabourAttendance" ("id","projectId","workerId","civilDate","shift","manualReason","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,'2026-08-10'::date,'day','ccu1 race probe',$4,$5)`,
      attId, projectId, workerId, f.memberUser.id, commandId,
    ));
    await waitUntilBlocked('%INSERT INTO "LabourAttendance"%');
    releaseHeld();
    await sessionA;
    const b = await sessionB;
    expect(b.status).toBe('fulfilled');
    // the insert completed AFTER the rebind committed, so it derived the NEW party
    expect(await attendanceParty(attId)).toBe(partyId);
  });
});
