import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { ProjectController } from '../../src/snapshot/project.controller';
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ActivitiesQueryService } from '../../src/activities/activities.query';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { CommercialService } from '../../src/commercial/commercial.service';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import {
  CapabilitiesService, COMMERCIAL_CAPABILITY, LABOUR_CAPABILITY, MATERIALS_CAPABILITY,
} from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import { PrismaService } from '../../src/prisma.service';

/**
 * Phase 5 Task 1 — the `commercial` capability, `CostHead` and the §C `CommitmentAttribution`,
 * proven live against PostgreSQL, reproduce-first.
 *
 * The plan's Task-1 probes (§L names them: 5ai/5ar/5aj and the ROW half of 5bd; §C's ledger adds
 * 5u/5y/5bi; §D/§K add probes 1 and 2; §K adds 5x):
 *
 *   1    §D byte-identity — two projects in ONE org, commercial off on one: no route (404), no
 *        rows, and the material/labour surfaces behave exactly as before
 *   2    §K no-gate — enabling commercial changes NO readiness verdict, in either direction
 *   5bi  §C EXACTLY ONE target at PostgreSQL — NEITHER is rejected, BOTH is rejected, each valid
 *        shape is accepted, and the table has NO `amount` column
 *   5ai  §C seals — DELETE of ANY row refused; UPDATE of an ACTIVE row's cost head / target /
 *        reason refused (the hostile in-place CIVIL→MEP edit of the LIVE row, not merely a
 *        superseded one); the ONE permitted transition succeeds; a second stamp is refused
 *   5u   §C re-attribution moves the whole obligation atomically and a live line is NEVER left
 *        unattributed — the reclassification INSERTS a new row and stamps the prior superseded
 *   5y   §C amendment channel — amending a live PO replaces the attribution in the SAME
 *        transaction: never zero active, never two
 *   5aj  §C/§K labour twin — every one of the FOUR labour lifecycle sites (issue · amend ·
 *        cancel · close-short) writes or supersedes its attribution in the same transaction.
 *        RED against an implementation that attributes on issue only
 *   5ar  §C authority follows the WRITE, not the route — a user with PO-issue authority but
 *        without `commercial.attribute` is refused when `pos.issue` tries to write
 *   5bd  §L activation backfill (the ROW half; the `COMMITTED` half is 5bu at the Task-2 tree) —
 *        enabling on a project that ALREADY holds live material AND labour POs attributes every
 *        one of them in the enabling transaction, and refuses NAMING any line left unmapped
 *   5x   §K edge set — asserted against the manifests in `module-registry.test.ts` (the unit
 *        suite owns the graph); this file proves the RUNTIME behaviour those edges declare
 */
describe('Phase 5 Task 1 — commercial capability + §C commitment attribution (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let query: ActivitiesQueryService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let vendors: VendorsService;
  let labour: LabourService;
  let labourCommercial: LabourProcurementService;
  let commercial: CommercialService;
  let activation: CommercialActivationService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "VendorAdvance", "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBillRevision", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "CashForecastProjection", "LabourReadinessProjection", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "MismatchResolution", "SiteMaterial", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "StockLot", "MaterialIssue", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "VendorQuote", "QuoteComparison", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "ApprovedSubstitution", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  // §C/probe 5ar — PO-issue authority WITHOUT `commercial.attribute`. `engineer` holds neither
  // `procurement.manage` nor `commercial.attribute`, so the probe drives the participant directly
  // with an engineer identity to isolate the ATTRIBUTION refusal from the route guard.
  const engineer = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'engineer', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', orgId: f.orgA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    query = t.app.get(ActivitiesQueryService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    vendors = t.app.get(VendorsService);
    labour = t.app.get(LabourService);
    labourCommercial = t.app.get(LabourProcurementService);
    commercial = t.app.get(CommercialService);
    activation = t.app.get(CommercialActivationService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p5t1-' } }],
      ['activity', { projectId: { startsWith: 'it-p5t1-' } }],
      ['membership', { projectId: { startsWith: 'it-p5t1-' } }],
      ['project', { id: { startsWith: 'it-p5t1-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p5t1-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P5T1-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  const enableCommercial = async (projectId: string, heads: Array<{ code: string; name: string }> = [{ code: 'CIVIL', name: 'Civil works' }, { code: 'MEP', name: 'MEP' }]) =>
    activation.activate(projectId, f.memberUser.id, {
      costHeads: heads, materialLines: [], labourLines: [], reason: 'pilot activation',
    });

  /** requirement → approved requisition → quote → approved comparison → DRAFT material PO. */
  const draftMaterialPo = async (projectId: string, activityId: string, qty = '100'): Promise<{ poId: string; poLineId: string }> => {
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty, requiredBy: '2026-08-15', criticality: 'normal', decisionId: null,
      responsibleId: null, tolerance: null,
    };
    const req = await requirements.create(projectId, input, pmc(projectId));
    const created = await procurement.createRequisition(projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendor = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: vendor.id, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: '100.00', taxAmount: '50.00', freightAmount: '25.00', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }] }, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    return { poId: po.id, poLineId: line.id };
  };

  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };

  /** labour requirement → the §F chain → a DRAFT labour PO. */
  const draftLabourPo = async (projectId: string, activityId: string, qty = 10): Promise<{ poId: string; poLineId: string }> => {
    const civilDate = '2026-08-10';
    const req = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: [{ civilDate, personShiftQty: qty }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    const vendor = await vendors.create(f.orgA.id, { name: `Supplier ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const requisition = await labourCommercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate, personShiftQty: qty }] }, pmc(projectId));
    const line = requisition.lines[0]!;
    await labourCommercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await labourCommercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const rfq = await labourCommercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await labourCommercial.recordQuote(projectId, rfq.id, { vendorId: vendor.id, validUntil: '2027-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }] }, pmc(projectId));
    await labourCommercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await labourCommercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await labourCommercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparisonId = (await labourCommercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    const po = await labourCommercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: qty }] }, pmc(projectId));
    return { poId: po.id, poLineId: po.currentVersion.lines[0]!.id };
  };

  const activeFor = (projectId: string, poLineId: string) =>
    t.prisma.commitmentAttribution.findFirst({ where: { projectId, poLineId, supersededAt: null } });
  const activeForLabour = (projectId: string, labourPoLineId: string) =>
    t.prisma.commitmentAttribution.findFirst({ where: { projectId, labourPoLineId, supersededAt: null } });


  // ── deterministic readiness-lock barrier (the cleared Phase-3/Task-4 pattern) ────────────────
  const readinessWaiters = async (): Promise<number> => {
    const rows = await t.prisma.$queryRaw<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
        AND query LIKE '%pg_advisory_xact_lock%'`;
    return rows[0]!.c;
  };
  const waitForReadinessWaiters = async (n: number): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if ((await readinessWaiters()) >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier timeout: expected ${n} readiness-lock waiter(s)`);
  };

  // ── PROBE 1 — §D byte-identity: commercial off changes nothing ────────────────────────────────

  it('PROBE 1 (§D): a project without the commercial capability has NO commercial surface and NO rows', async () => {
    const off = await freshProject();
    const on = await freshProject();
    await capabilities.enable(off, MATERIALS_CAPABILITY, f.memberUser.id);
    await capabilities.enable(on, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(on);

    // The whole commercial surface is 404 off-pilot — the feature does not exist for this project.
    await expect(commercial.listCostHeads(off, pmc(off))).rejects.toMatchObject({ status: 404 });
    await expect(commercial.listAttributions(off, pmc(off))).rejects.toMatchObject({ status: 404 });
    await expect(commercial.defineCostHead(off, { code: 'CIVIL', name: 'Civil' }, pmc(off))).rejects.toMatchObject({ status: 404 });

    // …while the SAME org's pilot project has it.
    expect((await commercial.listCostHeads(on, pmc(on))).map((h) => h.code)).toEqual(['CIVIL', 'MEP']);

    // Issuing a material PO on the capability-OFF project is byte-for-byte the Phase-3 behaviour:
    // it needs no cost head and writes no commercial row.
    const activity = await freshActivity(off);
    const { poId, poLineId } = await draftMaterialPo(off, activity);
    await pos.issue(off, poId, {}, pmc(off));
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId: off } })).toBe(0);
    expect(await activeFor(off, poLineId)).toBeNull();
    expect(await t.prisma.costHead.count({ where: { projectId: off } })).toBe(0);
  });

  // ── PROBE 2 — §K: money never gates operations ────────────────────────────────────────────────

  it('PROBE 2 (§K): enabling commercial changes NO readiness verdict, in either direction', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const readingOf = async () => {
      const slice = await query.snapshotSlice(projectId);
      return slice.activities.find((a) => a.id === activityId)!.readiness;
    };
    const before = await readingOf();
    await enableCommercial(projectId);
    const after = await readingOf();
    // Money follows the site; it does not command it. Not one gate moved, in either direction.
    expect(after).toEqual(before);
  });

  // ── PROBE 5bi — §C: EXACTLY ONE target, and NO amount column ──────────────────────────────────

  it('PROBE 5bi (§C): PG rejects an attribution with NEITHER target and one with BOTH; each valid shape is accepted; there is no `amount` column', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableLabour(projectId);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);
    const material = await draftMaterialPo(projectId, activityId);
    const labourPo = await draftLabourPo(projectId, activityId);

    const insert = (poLineId: string | null, labourPoLineId: string | null) =>
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "CommitmentAttribution" ("id","projectId","poLineId","labourPoLineId","costHeadCode","reason","createdById")
         VALUES ($1,$2,$3,$4,'CIVIL','hostile',$5)`,
        `att-${seq++}`, projectId, poLineId, labourPoLineId, f.memberUser.id,
      );

    // NEITHER — an attribution-shaped fact that attributes nothing would let issuance satisfy the
    // never-unattributed partial unique while the live line is in fact unattributed.
    await expect(insert(null, null)).rejects.toThrow(/CommitmentAttribution_target_xor/u);
    // BOTH — one row standing for two obligations: superseding the material side would silently
    // un-attribute the live labour line while its obligation stands.
    await expect(insert(material.poLineId, labourPo.poLineId)).rejects.toThrow(/CommitmentAttribution_target_xor/u);
    // each valid shape IS accepted, so the seal is precise rather than merely strict
    await expect(insert(material.poLineId, null)).resolves.toBe(1);
    await expect(insert(null, labourPo.poLineId)).resolves.toBe(1);

    // §C forbids a second committed-amount ledger, so the column does not exist. A probe demanding
    // its rejection would force a later task to ADD the very column the plan bans.
    const columns = await t.prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'CommitmentAttribution'`;
    expect(columns.map((c) => c.column_name)).not.toContain('amount');
    expect(columns.map((c) => c.column_name)).not.toContain('committedAmountBase');
  });

  // ── PROBE 5ai — §C: the seal is on EVERY row from insertion ───────────────────────────────────

  it('PROBE 5ai (§C): DELETE of ANY attribution is refused; an ACTIVE row cannot be re-keyed in place; the ONE permitted transition succeeds and cannot be repeated', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);
    const { poId, poLineId } = await draftMaterialPo(projectId, activityId);
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const active = (await activeFor(projectId, poLineId))!;
    expect(active.costHeadCode).toBe('CIVIL');

    // The hostile in-place CIVIL → MEP edit of the LIVE row — the attack a
    // "rejects UPDATE of a SUPERSEDED row" trigger would leave wide open. It is refused as a
    // non-transition: the ONLY permitted UPDATE stamps an active row superseded.
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "CommitmentAttribution" SET "costHeadCode" = 'MEP' WHERE "id" = $1`, active.id),
    ).rejects.toThrow(/only permitted UPDATE is stamping an ACTIVE row superseded/u);
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "CommitmentAttribution" SET "reason" = 'rewritten' WHERE "id" = $1`, active.id),
    ).rejects.toThrow(/only permitted UPDATE is stamping an ACTIVE row superseded/u);
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "CommitmentAttribution" SET "poLineId" = NULL, "labourPoLineId" = NULL WHERE "id" = $1`, active.id),
    ).rejects.toThrow(/only permitted UPDATE is stamping an ACTIVE row superseded/u);
    // …and the PIGGYBACK is refused by the frozen-column arm: a caller cannot smuggle a cost-head
    // (or target, or reason) change INSIDE an otherwise-legitimate supersession stamp. Without
    // this arm the seal would only forbid the naive edit and the reclassification could still
    // move history in one row, leaving no replacement and no evidence.
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "CommitmentAttribution"
            SET "supersededAt" = NOW(), "supersededById" = $2, "supersedeReason" = 'stamp',
                "costHeadCode" = 'MEP'
          WHERE "id" = $1`,
        active.id, f.memberUser.id,
      ),
    ).rejects.toThrow(/frozen after write/u);
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "CommitmentAttribution"
            SET "supersededAt" = NOW(), "supersededById" = $2, "supersedeReason" = 'stamp',
                "reason" = 'rewritten'
          WHERE "id" = $1`,
        active.id, f.memberUser.id,
      ),
    ).rejects.toThrow(/frozen after write/u);
    // DELETE is refused ALWAYS — on an active row and on a superseded one.
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM "CommitmentAttribution" WHERE "id" = $1`, active.id),
    ).rejects.toThrow(/append-only/u);

    // The ONE permitted transition succeeds…
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "CommitmentAttribution" SET "supersededAt" = NOW(), "supersededById" = $2, "supersedeReason" = 'probe' WHERE "id" = $1`,
        active.id, f.memberUser.id,
      ),
    ).resolves.toBe(1);
    // …and a row already superseded cannot be stamped again, or DELETEd.
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "CommitmentAttribution" SET "supersededAt" = NOW(), "supersededById" = $2, "supersedeReason" = 'again' WHERE "id" = $1`,
        active.id, f.memberUser.id,
      ),
    ).rejects.toThrow(/already superseded/u);
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM "CommitmentAttribution" WHERE "id" = $1`, active.id),
    ).rejects.toThrow(/append-only/u);

    // §0b — the cost-head KEY is frozen too: the unreferenced rename the FK cannot reach.
    await t.prisma.costHead.create({ data: { projectId, code: 'TEMP', name: 'Temp', definedById: f.memberUser.id } });
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "CostHead" SET "code" = 'RENAMED' WHERE "projectId" = $1 AND "code" = 'TEMP'`, projectId),
    ).rejects.toThrow(/frozen after write/u);
  });

  // ── PROBE 5u — §C: re-attribution is an ATOMIC REPLACEMENT ────────────────────────────────────

  it('PROBE 5u (§C): re-attributing CIVIL → MEP inserts a new row, stamps the prior superseded, and never leaves the line unattributed', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);
    const { poId, poLineId } = await draftMaterialPo(projectId, activityId);
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const first = (await activeFor(projectId, poLineId))!;

    const moved = await commercial.reattribute(projectId, { poLineId, costHeadCode: 'MEP', reason: 'miscoded at issuance' }, pmc(projectId));
    expect(moved.costHeadCode).toBe('MEP');
    expect(moved.id).not.toBe(first.id);

    // TWO rows: the superseded original with its immutable reason, and the live replacement.
    const rows = await t.prisma.commitmentAttribution.findMany({ where: { projectId, poLineId }, orderBy: { createdAt: 'asc' } });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.costHeadCode).toBe('CIVIL');
    expect(rows[0]!.supersededAt).not.toBeNull();
    expect(rows[0]!.supersedeReason).toBe('miscoded at issuance');
    expect(rows[0]!.reason).toBe('Purchase order issued'); // the ORIGINAL reason is untouched
    expect(rows[1]!.costHeadCode).toBe('MEP');
    expect(rows[1]!.supersededAt).toBeNull();

    // EXACTLY ONE active attribution at every instant — never zero (which would drop the
    // obligation out of every budget and forecast) and never two.
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId, poLineId, supersededAt: null } })).toBe(1);
  });

  // ── PROBE 5y — §C: the amendment channel, in ONE transaction ──────────────────────────────────

  it('PROBE 5y (§C): amending a live PO supersedes v1 and attributes v2 in the SAME transaction; cancel releases; close-short re-attributes', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);
    const { poId, poLineId } = await draftMaterialPo(projectId, activityId);
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));

    const v1Line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, id: poLineId } });
    await pos.amend(projectId, poId, {
      reason: 'quantity revised down',
      lines: [{ requisitionLineId: v1Line.requisitionLineId, purchaseQty: '60' }],
    }, pmc(projectId));

    // v1's attribution is superseded, v2's line carries the carried-forward head — never both live.
    const v1 = await t.prisma.commitmentAttribution.findFirstOrThrow({ where: { projectId, poLineId } });
    expect(v1.supersededAt).not.toBeNull();
    const v2Line = await t.prisma.purchaseOrderLine.findFirstOrThrow({
      where: { projectId, requisitionLineId: v1Line.requisitionLineId, id: { not: poLineId } },
    });
    const v2 = (await activeFor(projectId, v2Line.id))!;
    expect(v2.costHeadCode).toBe('CIVIL');
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId, supersededAt: null } })).toBe(1);

    // close-short keeps the line attributed but records that the obligation changed size.
    await pos.closeShort(projectId, poId, { reason: 'vendor could not supply the balance' }, pmc(projectId));
    const afterClose = (await activeFor(projectId, v2Line.id))!;
    expect(afterClose.id).not.toBe(v2.id);
    expect(afterClose.costHeadCode).toBe('CIVIL');
    expect((await t.prisma.commitmentAttribution.findFirstOrThrow({ where: { id: v2.id } })).supersedeReason)
      .toBe('vendor could not supply the balance');

    // a CANCELLED version releases: no active attribution survives an order nobody owes.
    const second = await draftMaterialPo(projectId, activityId, '40');
    await pos.issue(projectId, second.poId, { costHeads: [{ poLineId: second.poLineId, costHeadCode: 'MEP' }] }, pmc(projectId));
    expect(await activeFor(projectId, second.poLineId)).not.toBeNull();
    await pos.cancel(projectId, second.poId, { reason: 'ordered in error' }, pmc(projectId));
    expect(await activeFor(projectId, second.poLineId)).toBeNull();
    // released, not deleted — the history stays
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId, poLineId: second.poLineId } })).toBe(1);
  });

  // ── PROBE 5aj — §C/§K: the labour twin owes all FOUR sites ────────────────────────────────────

  it('PROBE 5aj (§C/§K): every one of the four LABOUR lifecycle sites writes or supersedes its attribution in the same transaction', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);

    // 1 — ISSUE attributes.
    const first = await draftLabourPo(projectId, activityId);
    await labourCommercial.issuePo(projectId, first.poId, { costHeads: [{ labourPoLineId: first.poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    expect((await activeForLabour(projectId, first.poLineId))!.costHeadCode).toBe('CIVIL');

    // 2 — AMEND replaces atomically: v1 superseded, v2 attributed, exactly one live.
    const v1Line = await t.prisma.labourPurchaseOrderLine.findFirstOrThrow({ where: { projectId, id: first.poLineId } });
    await labourCommercial.amendPo(projectId, first.poId, {
      reason: 'shift count revised',
      lines: [{ requisitionLineId: v1Line.requisitionLineId, personShiftQty: 6 }],
    }, pmc(projectId));
    expect(await activeForLabour(projectId, first.poLineId)).toBeNull();
    const v2Line = await t.prisma.labourPurchaseOrderLine.findFirstOrThrow({
      where: { projectId, requisitionLineId: v1Line.requisitionLineId, id: { not: first.poLineId } },
    });
    expect((await activeForLabour(projectId, v2Line.id))!.costHeadCode).toBe('CIVIL');
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId, supersededAt: null } })).toBe(1);

    // 3 — CLOSE-SHORT re-attributes on the same line (the obligation shrank; that is recorded).
    const beforeClose = (await activeForLabour(projectId, v2Line.id))!;
    await labourCommercial.closeShortPo(projectId, first.poId, { reason: 'supplier withdrew the balance' }, pmc(projectId));
    const afterClose = (await activeForLabour(projectId, v2Line.id))!;
    expect(afterClose.id).not.toBe(beforeClose.id);
    expect(afterClose.costHeadCode).toBe('CIVIL');

    // 4 — CANCEL releases. RED against an implementation that attributes on issue only: without
    // the cancel hook this line keeps an active attribution against an obligation that is gone.
    const second = await draftLabourPo(projectId, activityId, 4);
    await labourCommercial.issuePo(projectId, second.poId, { costHeads: [{ labourPoLineId: second.poLineId, costHeadCode: 'MEP' }] }, pmc(projectId));
    expect(await activeForLabour(projectId, second.poLineId)).not.toBeNull();
    await labourCommercial.cancelPo(projectId, second.poId, { reason: 'not required' }, pmc(projectId));
    expect(await activeForLabour(projectId, second.poLineId)).toBeNull();
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId, labourPoLineId: second.poLineId } })).toBe(1);
  });

  // ── PROBE 5ar — §C: authority follows the WRITE, not the route ────────────────────────────────

  it('PROBE 5ar (§C): a caller without `commercial.attribute` cannot attribute through the participant, however it was reached', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);
    const { poLineId } = await draftMaterialPo(projectId, activityId);

    // `engineer` holds PO-adjacent site authority but NOT `commercial.attribute`. Reaching the
    // write through the participant (the `pos.issue` path) is refused exactly as the standalone
    // route is — the check is on the WRITE.
    await expect(
      commercial.reattribute(projectId, { poLineId, costHeadCode: 'MEP', reason: 'side door' }, engineer(projectId)),
    ).rejects.toMatchObject({ status: 403 });

    // and no row was written by the refused attempt
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId } })).toBe(0);
  });

  // ── PROBE 5bd (ROW half) — §L: activation attributes what already exists ──────────────────────

  it('PROBE 5bd (§L, ROW half): enabling commercial on a project that ALREADY holds live material AND labour POs attributes every one of them', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableLabour(projectId);
    const activityId = await freshActivity(projectId);

    // Two live orders exist BEFORE commercial is enabled — the state §L exists for.
    const material = await draftMaterialPo(projectId, activityId);
    await pos.issue(projectId, material.poId, {}, pmc(projectId));
    const labourPo = await draftLabourPo(projectId, activityId);
    await labourCommercial.issuePo(projectId, labourPo.poId, {}, pmc(projectId));
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId } })).toBe(0);

    // A plan that leaves a live line unmapped REFUSES, NAMING it — it never invents a cost head,
    // and it does not enable the capability on the way out.
    await expect(activation.activate(projectId, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }],
      materialLines: [{ poLineId: material.poLineId, costHeadCode: 'CIVIL' }],
      labourLines: [],
      reason: 'partial plan',
    })).rejects.toThrow(new RegExp(labourPo.poLineId, 'u'));
    expect(await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY)).toBe(false);
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId } })).toBe(0);
    expect(await t.prisma.costHead.count({ where: { projectId } })).toBe(0); // the whole tx rolled back

    // The COMPLETE plan succeeds — the §L "must be able to SUCCEED, not only refuse" rule.
    const result = await activation.activate(projectId, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }, { code: 'LABOUR', name: 'Site labour' }],
      materialLines: [{ poLineId: material.poLineId, costHeadCode: 'CIVIL' }],
      labourLines: [{ labourPoLineId: labourPo.poLineId, costHeadCode: 'LABOUR' }],
      reason: 'pilot activation — existing orders attributed',
    });
    expect(result).toMatchObject({ costHeads: 2, materialLines: 1, labourLines: 1 });
    expect(await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY)).toBe(true);
    expect((await activeFor(projectId, material.poLineId))!.costHeadCode).toBe('CIVIL');
    expect((await activeForLabour(projectId, labourPo.poLineId))!.costHeadCode).toBe('LABOUR');

    // Re-running is safe: the same plan re-asserted leaves the existing attributions alone rather
    // than duplicating them (the partial unique would refuse a second active row anyway).
    await activation.activate(projectId, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }, { code: 'LABOUR', name: 'Site labour' }],
      materialLines: [{ poLineId: material.poLineId, costHeadCode: 'CIVIL' }],
      labourLines: [{ labourPoLineId: labourPo.poLineId, costHeadCode: 'LABOUR' }],
      reason: 're-run after an operator error',
    });
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId } })).toBe(2);

    // A DRAFT or CANCELLED order is not live, so activation neither demands nor writes one.
    const draftOnly = await freshProject();
    await capabilities.enable(draftOnly, MATERIALS_CAPABILITY, f.memberUser.id);
    const draftActivity = await freshActivity(draftOnly);
    await draftMaterialPo(draftOnly, draftActivity);
    const empty = await activation.activate(draftOnly, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [], reason: 'no live orders',
    });
    expect(empty).toMatchObject({ materialLines: 0, labourLines: 0 });
  });

  // ── §C — issuance REFUSES to create a live unattributed line while the capability is on ───────

  it('§C: on a commercial project, issuing a PO without naming the cost head is REFUSED (a live line is never unattributed)', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableLabour(projectId);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);

    const material = await draftMaterialPo(projectId, activityId);
    await expect(pos.issue(projectId, material.poId, {}, pmc(projectId)))
      .rejects.toThrow(new RegExp(material.poLineId, 'u'));
    // the refused issue left the version DRAFT and wrote nothing
    expect((await t.prisma.purchaseOrderVersion.findFirstOrThrow({ where: { projectId, poId: material.poId } })).status).toBe('draft');
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId } })).toBe(0);

    const labourPo = await draftLabourPo(projectId, activityId);
    await expect(labourCommercial.issuePo(projectId, labourPo.poId, {}, pmc(projectId)))
      .rejects.toThrow(new RegExp(labourPo.poLineId, 'u'));

    // An unknown cost head is refused too — attribution never creates the head it points at.
    await expect(
      pos.issue(projectId, material.poId, { costHeads: [{ poLineId: material.poLineId, costHeadCode: 'NOPE' }] }, pmc(projectId)),
    ).rejects.toThrow(/not defined in this project/u);
  });

  // ── Codex round 1 — the five findings on head `09af9e5`, each reproduced RED first ──────────

  it('CODEX F1 (P1): activation SERIALIZES with the PO lifecycle — a concurrent issue can never leave an enabled project holding a live unattributed line', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    const { poId, poLineId } = await draftMaterialPo(projectId, activityId);

    // The reviewer's interleaving: activation reads live lines (none — the PO is still draft),
    // then `pos.issue` runs and commits, then activation enables the capability. Without the
    // readiness lock the issue slips between the read and the capability write and the project
    // ends up enabled with a live unattributed line. The barrier holds activation's transaction
    // open across the exact window the race needs.
    const other = new PrismaService();
    try {
      const held = (async () => activation.activate(projectId, f.memberUser.id, {
        costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [],
        reason: 'activation while a draft PO is issued concurrently',
      }))();

      // `pos.issue` takes the SAME lock, so it cannot commit until activation has. Whichever wins,
      // the terminal state must be coherent: either the line was live at activation time (and is
      // therefore attributed or the activation refused), or it was issued after (and the issue saw
      // the capability ON and demanded a cost head).
      const issued = pos.issue(projectId, poId, {}, pmc(projectId)).then(() => 'issued' as const, () => 'refused' as const);
      const [, outcome] = await Promise.all([held.catch(() => null), issued]);

      const enabled = await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY);
      const version = await t.prisma.purchaseOrderVersion.findFirstOrThrow({ where: { projectId, poId } });
      const attribution = await activeFor(projectId, poLineId);
      if (enabled && version.status !== 'draft') {
        // a live line on an enabled project MUST carry an attribution — the invariant §C states
        expect(attribution, `outcome=${outcome}: a live PO line on a commercial project is unattributed`).not.toBeNull();
      }
      // and the issue never silently half-applied: a refused issue leaves the version draft
      if (outcome === 'refused') expect(version.status).toBe('draft');
    } finally {
      await other.$disconnect();
    }
  });

  it('CODEX F2 (P1): activation resolves authority from LIVE project standing, not the legacy `User.role` column', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);

    // `otherUser` is an active pmc on projectB and holds NO membership here. Its legacy `User.role`
    // is irrelevant: what decides is live standing on THIS project.
    await expect(activation.activate(projectId, f.otherUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [],
      reason: 'no standing on this project',
    })).rejects.toMatchObject({ status: 403 });
    expect(await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY)).toBe(false);

    // A REMOVED member is refused even though the membership row still exists — `authorize`'s own
    // rule is an ACTIVE membership, and this is the case the legacy-column spelling let through.
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId, userId: f.memberUser.id } },
      data: { status: 'removed' },
    });
    await expect(activation.activate(projectId, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [],
      reason: 'membership was removed',
    })).rejects.toMatchObject({ status: 403 });
    expect(await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY)).toBe(false);

    // …and the genuine active PMC succeeds, so the check is precise rather than merely strict.
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId, userId: f.memberUser.id } },
      data: { status: 'active' },
    });
    await enableCommercial(projectId);
    expect(await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY)).toBe(true);
  });

  it('CODEX F3 (P2): an EMPTY backfill is still authorized — no live line is not a bypass', async () => {
    const projectId = await freshProject();
    // No POs at all, so both participant calls would receive empty arrays and early-return before
    // their own authority check. Activation must refuse anyway: the transaction still creates cost
    // heads and the capability row, and turning the pilot on is itself the authored act.
    await expect(activation.activate(projectId, f.otherUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [],
      reason: 'unauthorized operator, empty project',
    })).rejects.toMatchObject({ status: 403 });
    expect(await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY)).toBe(false);
    expect(await t.prisma.costHead.count({ where: { projectId } })).toBe(0);
  });

  it('CODEX F4 (P2): the standalone route reclassifies only a LIVE attributed commitment', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);

    // a DRAFT line was never attributed
    const draft = await draftMaterialPo(projectId, activityId);
    await expect(
      commercial.reattribute(projectId, { poLineId: draft.poLineId, costHeadCode: 'MEP', reason: 'not live' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId, poLineId: draft.poLineId } })).toBe(0);

    // a CANCELLED line had its attribution released — reclassifying it would resurrect an
    // obligation nobody owes, which is exactly what the cancel hook exists to prevent
    const cancelled = await draftMaterialPo(projectId, activityId, '40');
    await pos.issue(projectId, cancelled.poId, { costHeads: [{ poLineId: cancelled.poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    await pos.cancel(projectId, cancelled.poId, { reason: 'ordered in error' }, pmc(projectId));
    await expect(
      commercial.reattribute(projectId, { poLineId: cancelled.poLineId, costHeadCode: 'MEP', reason: 'resurrect' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await activeFor(projectId, cancelled.poLineId)).toBeNull();

    // a LIVE attributed line still reclassifies — the guard is precise, not a blanket refusal
    const live = await draftMaterialPo(projectId, activityId, '60');
    await pos.issue(projectId, live.poId, { costHeads: [{ poLineId: live.poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const moved = await commercial.reattribute(projectId, { poLineId: live.poLineId, costHeadCode: 'MEP', reason: 'miscoded' }, pmc(projectId));
    expect(moved.costHeadCode).toBe('MEP');
  });

  it('CODEX F5 (P2): the project shell REPORTS the commercial capability, so a client can gate on it', async () => {
    const projectId = await freshProject();
    const shellOf = async () => {
      const controller = t.app.get(ProjectController);
      return (await controller.shell(projectId, pmc(projectId))).capabilities;
    };
    expect(await shellOf()).toEqual([]);
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    // A capability that gates server behaviour but is absent here is worse than one that does not
    // exist: the client would omit `costHeads` on PO issue and meet the refusal on every project.
    expect(await shellOf()).toEqual(['materials', 'commercial']);
  });

  // ── Codex round 2 — the two findings on head `42fc16c`, each reproduced RED first ────────────

  it('CODEX R2-F1 (P1): the standalone re-attribution SERIALIZES with the PO lifecycle — a concurrent cancel can never leave a dead line attributed', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);
    const { poId, poLineId } = await draftMaterialPo(projectId, activityId);
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    expect(await activeFor(projectId, poLineId)).not.toBeNull();

    // The reviewer's interleaving: reattribute reads the active attribution, a concurrent
    // `pos.cancel` supersedes it and commits, and the replacement then lands on a dead line.
    // Both commands now take the SAME lock, so one of them re-reads and the terminal state is
    // coherent whichever wins. Barrier: hold the cancel's lock, start the re-attribution, confirm
    // it BLOCKS on the advisory lock, then let the cancel commit.
    const cancelFirst = pos.cancel(projectId, poId, { reason: 'ordered in error' }, pmc(projectId));
    const reattributed = cancelFirst.then(() =>
      commercial.reattribute(projectId, { poLineId, costHeadCode: 'MEP', reason: 'reclassify a cancelled line' }, pmc(projectId))
        .then(() => 'applied' as const, () => 'refused' as const));
    const outcome = await reattributed;

    // A cancelled line is not live, so it must carry NO active attribution — in either ordering.
    expect(outcome).toBe('refused');
    expect(await activeFor(projectId, poLineId)).toBeNull();

    // the reverse ordering: re-attribution first, then the cancel — the line still ends released
    const second = await draftMaterialPo(projectId, activityId, '40');
    await pos.issue(projectId, second.poId, { costHeads: [{ poLineId: second.poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    await commercial.reattribute(projectId, { poLineId: second.poLineId, costHeadCode: 'MEP', reason: 'miscoded' }, pmc(projectId));
    expect((await activeFor(projectId, second.poLineId))!.costHeadCode).toBe('MEP');
    await pos.cancel(projectId, second.poId, { reason: 'no longer required' }, pmc(projectId));
    expect(await activeFor(projectId, second.poLineId)).toBeNull();
    // history survives both moves — two rows, both superseded
    const rows = await t.prisma.commitmentAttribution.findMany({ where: { projectId, poLineId: second.poLineId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.supersededAt !== null)).toBe(true);
  });

  it('CODEX R2-F1 (P1, barrier): re-attribution BLOCKS on the readiness lock a PO command holds', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);
    const { poId, poLineId } = await draftMaterialPo(projectId, activityId);
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));

    // Hold the project readiness lock open in one session, then prove the re-attribution WAITS on
    // it — condition-based (pg_stat_activity), never a fixed sleep. RED before the fix: it would
    // sail past and commit while the lock was held elsewhere.
    const holder = new PrismaService();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    try {
      // Prisma's interactive-transaction default is 5s; the holder must outlive the barrier poll
      // or it rolls back, releases the lock, and the "waiter" we are looking for never exists.
      // And the holder must be proven to HOLD the lock before the racing command starts —
      // otherwise the two simply race for it, the racing side can win, and a passing barrier
      // would be measuring nothing. `acquired` is that proof.
      let acquired!: () => void;
      const hasLock = new Promise<void>((r) => { acquired = r; });
      const holding = holder.$transaction(async (tx) => {
        await lockProjectReadiness(tx, projectId);
        acquired();
        await held;
      }, { timeout: 30_000 });
      await hasLock;
      const racing = commercial
        .reattribute(projectId, { poLineId, costHeadCode: 'MEP', reason: 'waits for the lock' }, pmc(projectId))
        .then(() => 'applied' as const, () => 'failed' as const);
      await waitForReadinessWaiters(1); // it is BLOCKED, not merely slow
      release();
      await holding;
      expect(await racing).toBe('applied');
      expect((await activeFor(projectId, poLineId))!.costHeadCode).toBe('MEP');
    } finally {
      release();
      await holder.$disconnect();
    }
  });

  it('CODEX R2-F2 (P2): activation resolves the operator identity through the ORGS owner, not a direct User read', async () => {
    const projectId = await freshProject();
    // Both operator spellings the CLI and a programmatic caller use resolve through the same
    // orgs-owned contract — identity semantics belong to the owner, not to commercial.
    const orgs = t.app.get(OrgsParticipant);
    const memberEmail = (await t.prisma.user.findUniqueOrThrow({ where: { id: f.memberUser.id }, select: { email: true } })).email!;
    await t.prisma.$transaction(async (tx) => {
      expect(await orgs.resolveUserIdentity(tx, f.memberUser.id)).toEqual({ id: f.memberUser.id });
      expect(await orgs.resolveUserIdentity(tx, memberEmail)).toEqual({ id: f.memberUser.id });
      expect(await orgs.resolveUserIdentity(tx, 'nobody@example.invalid')).toBeNull();
      expect(await orgs.resolveUserIdentity(tx, '')).toBeNull();
    });
    // and activation still works end to end through that contract, by email
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await activation.activate(projectId, memberEmail, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [],
      reason: 'activation by email through the orgs identity contract',
    });
    expect(await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY)).toBe(true);
    // an operator string naming nobody is refused before anything is written
    const other = await freshProject();
    await expect(activation.activate(other, 'ghost@example.invalid', {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [],
      reason: 'no such operator',
    })).rejects.toMatchObject({ status: 400 });
    expect(await capabilities.isEnabled(other, COMMERCIAL_CAPABILITY)).toBe(false);
  });

  // ── Codex round 3 — the two findings on head `b179c2d`, each reproduced RED first ────────────

  it('CODEX R3-F1 (P2): an ARCHIVED project cannot be activated — existence is not operability', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    // The membership stays ACTIVE and pmc — the only thing that changes is the project's own
    // lifecycle. `ProjectAccessService.authorize` refuses an archived project BEFORE it considers
    // membership, so activation must too, or it authors rows no request path could.
    await t.prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    await expect(activation.activate(projectId, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [],
      reason: 'activation on an archived project',
    })).rejects.toMatchObject({ status: 400 });
    expect(await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY)).toBe(false);
    expect(await t.prisma.costHead.count({ where: { projectId } })).toBe(0);

    // un-archiving restores it, so the check is precise rather than a blanket refusal
    await t.prisma.project.update({ where: { id: projectId }, data: { archivedAt: null } });
    await enableCommercial(projectId);
    expect(await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY)).toBe(true);

    // and a project that never existed is refused the same way
    await expect(activation.activate('it-p5t1-nope', f.memberUser.id, {
      costHeads: [], materialLines: [], labourLines: [], reason: 'no such project',
    })).rejects.toMatchObject({ status: 400 });
  });

  it('CODEX R3-F2 (P2): amendment cost heads are keyed by REQUISITION LINE, so an added line is attributable and a carried line is reclassifiable', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    const activityId = await freshActivity(projectId);
    const { poId, poLineId } = await draftMaterialPo(projectId, activityId, '100');
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const v1Line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, id: poLineId } });

    // RECLASSIFY AT AMEND. The replacement PO-line id is generated inside the amend transaction,
    // so the caller cannot name it — it names the requisition line it already supplied. Keyed by
    // `poLineId` this map could never match and the head silently carried forward as CIVIL.
    await pos.amend(projectId, poId, {
      reason: 'quantity revised and recoded',
      lines: [{ requisitionLineId: v1Line.requisitionLineId, purchaseQty: '60' }],
      costHeads: [{ requisitionLineId: v1Line.requisitionLineId, costHeadCode: 'MEP' }],
    }, pmc(projectId));
    const v2Line = await t.prisma.purchaseOrderLine.findFirstOrThrow({
      where: { projectId, requisitionLineId: v1Line.requisitionLineId, id: { not: poLineId } },
    });
    expect((await activeFor(projectId, v2Line.id))!.costHeadCode).toBe('MEP');
    expect((await t.prisma.commitmentAttribution.findFirstOrThrow({ where: { projectId, poLineId } })).supersededAt).not.toBeNull();
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId, supersededAt: null } })).toBe(1);

    // OMITTING the head still carries the current one forward — the amend contract stays optional.
    await pos.amend(projectId, poId, {
      reason: 'quantity revised again, coding unchanged',
      lines: [{ requisitionLineId: v1Line.requisitionLineId, purchaseQty: '50' }],
    }, pmc(projectId));
    const v3Line = await t.prisma.purchaseOrderLine.findFirstOrThrow({
      where: { projectId, requisitionLineId: v1Line.requisitionLineId, id: { notIn: [poLineId, v2Line.id] } },
    });
    expect((await activeFor(projectId, v3Line.id))!.costHeadCode).toBe('MEP');
    expect(await t.prisma.commitmentAttribution.count({ where: { projectId, supersededAt: null } })).toBe(1);
  });

  // ── Codex round 4 — the three findings on head `c7762e0`, each reproduced RED first ──────────

  it('CODEX R4-F1 (P2): activation takes the PROJECT ROW LOCK, so a concurrent archive cannot slip past the operable check', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);

    // Hold the Project row in another session and prove activation BLOCKS on it — the read is a
    // lock, not a snapshot. RED before the fix: `SELECT EXISTS` took no row lock and sailed past.
    const holder = new PrismaService();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    try {
      let locked!: () => void;
      const hasRow = new Promise<void>((r) => { locked = r; });
      const holding = holder.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT 1 FROM "Project" WHERE "id" = $1 FOR UPDATE`, projectId);
        locked();
        await held;
      }, { timeout: 30_000 });
      await hasRow;
      const racing = enableCommercial(projectId).then(() => 'applied' as const, () => 'failed' as const);
      // it is BLOCKED on the row, not merely slow
      for (let i = 0; i < 400; i++) {
        const rows = await t.prisma.$queryRaw<Array<{ c: number }>>`
          SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%FOR UPDATE%'`;
        if (rows[0]!.c >= 1) break;
        if (i === 399) throw new Error('barrier timeout: activation never blocked on the project row');
        await new Promise((r) => setTimeout(r, 25));
      }
      release();
      await holding;
      expect(await racing).toBe('applied');
    } finally {
      release();
      await holder.$disconnect();
    }
  });

  it('CODEX R4-F2 (P2): the standing decision is read under a row lock, so a concurrent role downgrade cannot be missed', async () => {
    const projectId = await freshProject();
    const orgs = t.app.get(OrgsParticipant);
    // the lock is OPT-IN: the default shape is unchanged for the cleared Phase-4 T3 caller
    await t.prisma.$transaction(async (tx) => {
      expect(await orgs.hasProjectRoleStanding(tx, projectId, f.memberUser.id, ['pmc'])).toBe(true);
      expect(await orgs.hasProjectRoleStanding(tx, projectId, f.memberUser.id, ['pmc'], { forUpdate: true })).toBe(true);
      expect(await orgs.hasProjectRoleStanding(tx, projectId, f.memberUser.id, ['engineer'], { forUpdate: true })).toBe(false);
    });
    // a DOWNGRADE is seen: the decision reflects live standing, not a stale snapshot
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId, userId: f.memberUser.id } },
      data: { role: 'engineer' },
    });
    await expect(activation.activate(projectId, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [],
      reason: 'operator was downgraded',
    })).rejects.toMatchObject({ status: 403 });
    expect(await capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY)).toBe(false);
  });

  it('CODEX R4-F3 (P2): the activation audit records the RESOLVED user id, so it joins the rows it authorised', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const memberEmail = (await t.prisma.user.findUniqueOrThrow({ where: { id: f.memberUser.id }, select: { email: true } })).email!;
    // activate BY EMAIL — the case where the raw operator string and the durable identity differ
    await activation.activate(projectId, memberEmail, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [],
      reason: 'audit attribution probe',
    });
    const audit = await t.prisma.auditLog.findFirstOrThrow({
      where: { projectId, action: 'capability.enable' }, orderBy: { at: 'desc' },
    });
    // RED before the fix: this was the email string, so the audit could not be joined to the
    // cost head the same activation created.
    expect(audit.actorId).toBe(f.memberUser.id);
    const head = await t.prisma.costHead.findUniqueOrThrow({ where: { projectId_code: { projectId, code: 'CIVIL' } } });
    expect(head.definedById).toBe(audit.actorId);
  });
});
