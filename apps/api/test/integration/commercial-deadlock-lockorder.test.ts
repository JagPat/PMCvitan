import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * The commercial CI deadlock — `phase5_t4_billed_bound_check` and its lock ORDER, proven live.
 *
 * This suite exists because an intermittent `api-e2e` failure blocked two unrelated pull requests
 * (#342, a CSS focus-ring change, and #344) with a byte-identical PostgreSQL deadlock report:
 *
 *   Process A: COMMIT — while locking tuple (0,2) in relation "PurchaseOrderLine"
 *              phase5_t4_billed_bound_check line 11 ← phase5_t4_bill_status_sealed line 37
 *   Process B: SELECT 1 FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE
 *
 * Every caller of the bound check is a DEFERRABLE INITIALLY DEFERRED constraint trigger, so its
 * `PurchaseOrderLine` lock is taken at COMMIT — LAST, after whatever authority lock the command
 * already holds. The other side never takes an explicit PO-line lock: inserting a row whose FOREIGN
 * KEY references the line makes PostgreSQL take `FOR KEY SHARE` on it INLINE, and that transaction
 * then reaches its own authority check and waits for the membership row the first one holds.
 * `FOR UPDATE` conflicts with `FOR KEY SHARE`, and the cycle closes.
 *
 * PROBE 1 is the fix: a `FOR KEY SHARE` holder must NOT block the bound check.
 * PROBES 2 and 3 are the invariant the lock is actually there for — the Phase-4 T3 F3 lesson, in
 * the function's own words, that "two sessions that each counted a fold nobody was holding would
 * both pass and both commit". A fix that removed the false conflict AND the real ones would pass
 * probe 1 and be wrong, so the preserved conflicts are asserted, not assumed.
 *
 * Blocking is established by OBSERVING the waiting session in `pg_stat_activity` — never by a bare
 * timeout, and never by a sleep. A probe that cannot prove its own experiment ran is not evidence
 * (the Phase-4 T1 correction-4 lesson, relearned on PR #344 round 8).
 */
describe('commercial deadlock — the §G bound check takes one lock order (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let vendors: VendorsService;
  let activation: CommercialActivationService;
  let capabilities: CapabilitiesService;
  let raceDb: PrismaClient;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "VendorAdvance", "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBillRevision", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "CashForecastProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectPartyVendorSource", "ProjectPartyCompanySource", "ProjectParty", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', orgId: f.orgA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    vendors = t.app.get(VendorsService);
    activation = t.app.get(CommercialActivationService);
    capabilities = t.app.get(CapabilitiesService);
    // A SEPARATE client: two sessions is the whole point, and Prisma's interactive transactions
    // are per-connection. Sharing `t.prisma` would silently serialize the probe into one session.
    raceDb = new PrismaClient();
    await raceDb.$connect();
  });

  afterAll(async () => {
    await raceDb.$disconnect();
    await t.close();
  });

  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.activity.deleteMany({ where: { projectId: { startsWith: 'it-cdl-' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-cdl-' } } });
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-cdl-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: {
        id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P',
        projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
        timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z'),
      },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    await activation.activate(id, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [], reason: 'pilot activation',
    });
    return id;
  };

  /** One ISSUED material PO line — the row the bound check locks. */
  const issuedMaterialLine = async (projectId: string): Promise<string> => {
    const qty = '100';
    const activityId = `IT-CDL-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id: activityId, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: `grey-${seq++}`,
      baseUom: 'bag', qty, requiredBy: '2026-08-15', criticality: 'normal', decisionId: null,
      responsibleId: null, tolerance: null,
    };
    const req = await requirements.create(projectId, input, pmc(projectId));
    const created = await procurement.createRequisition(projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const v = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: v.id, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: '1', taxAmount: '0', freightAmount: '0', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }] }, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    await pos.issue(projectId, po.id, { costHeads: [{ poLineId: line.id, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    return line.id;
  };

  /**
   * Wait until `raceDb`'s session is actually WAITING on a lock — condition-based, so the probe
   * proves the block happened rather than inferring it from elapsed time. Returns false if the
   * session never blocks within the budget, which is the GREEN outcome for probe 1.
   */
  const blocksWithin = async (marker: string, ms = 4000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity
          WHERE query LIKE $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
        `%${marker}%`,
      );
      if (Number(rows[0]?.n ?? 0) > 0) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  /**
   * Run the bound check on `raceDb` inside its own transaction, tagged with a marker this suite can
   * find in `pg_stat_activity`. The promise is DISPATCHED here — a Prisma raw promise is lazy, and
   * an undispatched one starts nothing at all.
   */
  const boundCheckOnRace = (projectId: string, poLineId: string, marker: string) => {
    let settled: 'pending' | 'ok' | 'error' = 'pending';
    const p = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT phase5_t4_billed_bound_check($1, $2, NULL) /* ${marker} */`,
        projectId, poLineId,
      );
    }).then(() => { settled = 'ok'; }, () => { settled = 'error'; });
    return { promise: p, state: () => settled };
  };

  it('PROBE 1 (the fix): a FOR KEY SHARE holder — what an FK-referencing INSERT takes — does NOT block the bound check', async () => {
    const projectId = await freshProject();
    const poLineId = await issuedMaterialLine(projectId);
    const marker = `cdl-probe1-${seq++}`;

    // Session A holds exactly the lock PostgreSQL takes when a row whose FK references this PO line
    // is inserted (a `VendorBillLine`, a `DeliveryCommitment`, a `StockLot`). Held open across the
    // whole of session B's attempt.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT 1 FROM "PurchaseOrderLine" WHERE "projectId" = $1 AND "id" = $2 FOR KEY SHARE`,
        projectId, poLineId,
      );
      await held;
    }, { timeout: 20_000 });

    // give the holder time to actually take its lock before the other session asks
    await new Promise((r) => setTimeout(r, 250));

    const race = boundCheckOnRace(projectId, poLineId, marker);
    const blocked = await blocksWithin(marker, 3000);

    release();
    await holder;
    await race.promise;

    // RED at `8175c3e` (FOR UPDATE): session B waits on the KEY SHARE holder — `blocked` is true.
    // GREEN with FOR NO KEY UPDATE: it never waits, and completes while the holder still holds.
    expect(blocked).toBe(false);
    expect(race.state()).toBe('ok');
  });

  it('PROBE 2 (invariant kept): two concurrent bound checks STILL serialize', async () => {
    const projectId = await freshProject();
    const poLineId = await issuedMaterialLine(projectId);
    const marker = `cdl-probe2-${seq++}`;

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const holder = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT phase5_t4_billed_bound_check($1, $2, NULL)`, projectId, poLineId);
      await held;
    }, { timeout: 20_000 });

    await new Promise((r) => setTimeout(r, 250));

    const race = boundCheckOnRace(projectId, poLineId, marker);
    const blocked = await blocksWithin(marker, 4000);

    // The Phase-4 T3 F3 lesson: the check must not count a fold nobody is holding.
    expect(blocked).toBe(true);

    release();
    await holder;
    await race.promise;
    expect(race.state()).toBe('ok');
  });

  it('PROBE 3 (invariant kept): a concurrent UPDATE of the constraining quantity STILL serializes', async () => {
    const projectId = await freshProject();
    const poLineId = await issuedMaterialLine(projectId);
    const marker = `cdl-probe3-${seq++}`;

    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // An ordinary UPDATE of a NON-KEY column takes FOR NO KEY UPDATE — which is exactly the lock
    // the bound check now takes, so the two still conflict and the number cannot move underneath it.
    const holder = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "PurchaseOrderLine" SET "approvedOverage" = "approvedOverage" WHERE "projectId" = $1 AND "id" = $2`,
        projectId, poLineId,
      );
      await held;
    }, { timeout: 20_000 });

    await new Promise((r) => setTimeout(r, 250));

    const race = boundCheckOnRace(projectId, poLineId, marker);
    const blocked = await blocksWithin(marker, 4000);

    expect(blocked).toBe(true);

    release();
    await holder;
    await race.promise;
    expect(race.state()).toBe('ok');
  });
});
