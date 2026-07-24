import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import { SystemClock } from '../../src/common/clock';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Tasks 2-3 CORRECTION — the seven review findings, reproduce-first (live PG).
 *
 * Round 1: every probe asserts the CORRECTED behavior and was RED at base `7ca1fc0`
 * (except where noted): F1/F1c/F3/F4a/F4b/F6 failed verbatim; F5's schema gap is
 * reproduced by the direct-insert probe (the service-path race passed at base only
 * because unserialized recordings completed sequentially); F7's defect was the
 * `new Date().toISOString()` call, replaced by the injected project-timezone clock.
 *
 * Round 2 (F4 completion — the narrow re-review's two P1 gaps): the three F4-r2 probes
 * below were RED at `bffd7c9` — a PO referencing a DRAFT comparison inserted; a quote for
 * requisition A accepted a line of requisition B; a PO for requisition A accepted a line
 * of requisition B. They are sealed by the status-bearing provenance FK and the immutable
 * denormalized requisitionId containment chain.
 */

describe('Phase 3 T2-3 correction — the seven findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let vendors: VendorsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    vendors = t.app.get(VendorsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    for (const [model, where] of [
      ['notification', { projectId: { startsWith: 'it-red-' } }],
      ['activity', { projectId: { startsWith: 'it-red-' } }],
      ['auditLog', { projectId: { startsWith: 'it-red-' } }],
      ['membership', { projectId: { startsWith: 'it-red-' } }],
      ['labourTrade', { projectId: { startsWith: 'it-red-' } }], // Phase 4 — labour catalog FKs the project
      ['project', { id: { startsWith: 'it-red-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-red-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-RED-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const freshRequirement = async (projectId: string, qty = '100') => {
    const activityId = await freshActivity(projectId);
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty, requiredBy: '2026-08-15', criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null,
    };
    const r = await requirements.create(projectId, input, pmc(projectId));
    return { requirementId: r.requirementId, revision: r.revision };
  };
  const boundVendor = async (projectId: string, name = `V${seq++}`) => {
    const v = await vendors.create(f.orgA.id, { name }, orgAdmin());
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    return v.id;
  };

  it('F1: a matchesSpecification:false quote CANNOT be selected (no substitution support)', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, { title: 'r', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '50' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: requisition.lines[0]!.id, baseRate: '90', taxAmount: '0', freightAmount: '0', landedCost: '90', quotedMake: 'OtherBrand PPC', matchesSpecification: false }],
    }, pmc(projectId));
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    await expect(
      procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: withQuote.quotes[0]!.id, reason: 'cheap' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('F1c: a non-material (labour) requirement is REJECTED from the material-procurement pipeline', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const requirementId = `RED-LAB-${seq++}`;
    // Phase 4 — a VALID labour requirement now carries its own labour detail (spec + slices).
    // The material-procurement pipeline still rejects it (it is not a material requirement).
    await t.prisma.labourTrade.create({ data: { projectId, code: 'mason', name: 'Mason', createdById: f.memberUser.id } });
    await t.prisma.$transaction([
      t.prisma.activityRequirementRoot.create({ data: { projectId, id: requirementId, createdById: f.memberUser.id } }),
      t.prisma.activityRequirement.create({
        data: { projectId, requirementId, revision: 1, activityId, type: 'labour', requiredQty: '10', baseUom: 'person-shift', requiredBy: new Date('2026-08-15'), createdById: f.memberUser.id },
      }),
      t.prisma.labourRequirementSpec.create({ data: { projectId, requirementId, revision: 1, tradeCode: 'mason', shift: 'day', labourSpecFingerprint: 'lsf-red' } }),
      t.prisma.labourDemandSlice.create({ data: { projectId, requirementId, revision: 1, civilDate: new Date('2026-08-15'), personShiftQty: 10 } }),
    ]);
    await expect(
      procurement.createRequisition(projectId, { title: 'labour', lines: [{ requirementId, revision: 1, qty: '5' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('F3: an INCOMPLETE quote cannot win as the lowest total against a complete one', async () => {
    const projectId = await freshProject();
    const r1 = await freshRequirement(projectId);
    const r2 = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, {
      title: 'two lines',
      lines: [
        { requirementId: r1.requirementId, revision: r1.revision, qty: '10' },
        { requirementId: r2.requirementId, revision: r2.revision, qty: '10' },
      ],
    }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const [lineA, lineB] = requisition.lines;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const complete = await boundVendor(projectId, 'Complete');
    const partial = await boundVendor(projectId, 'Partial');
    await procurement.recordQuote(projectId, rfq.id, {
      vendorId: complete, validUntil: '2027-01-01',
      lines: [
        { requisitionLineId: lineA!.id, baseRate: '100', taxAmount: '0', freightAmount: '0', landedCost: '100', quotedMake: 'UltraTech', matchesSpecification: true },
        { requisitionLineId: lineB!.id, baseRate: '100', taxAmount: '0', freightAmount: '0', landedCost: '100', quotedMake: 'UltraTech', matchesSpecification: true },
      ],
    }, pmc(projectId));
    const withPartial = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: partial, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineA!.id, baseRate: '150', taxAmount: '0', freightAmount: '0', landedCost: '150', quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const partialQuote = withPartial.quotes.find((q) => q.vendorId === partial && q.status === 'recorded')!;
    // a one-line 150 "total" must NOT be selectable as if it were the lowest against 200-for-both
    await expect(
      procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: partialQuote.id, reason: 'looks cheapest' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('F4a: an APPROVED quote line is database-immutable', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, { title: 'r', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    await procurement.recordQuote(projectId, rfq.id, {
      vendorId, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: requisition.lines[0]!.id, baseRate: '10', taxAmount: '0', freightAmount: '0', landedCost: '10', quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));
    const line = await t.prisma.vendorQuoteLine.findFirstOrThrow({ where: { projectId } });
    await expect(t.prisma.vendorQuoteLine.update({ where: { id: line.id }, data: { landedCost: '0.01' } })).rejects.toThrow();
  });

  it('F4b: a PurchaseOrder referencing a nonexistent comparison is unrepresentable', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, { title: 'r', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    await expect(
      t.prisma.purchaseOrder.create({
        data: { projectId, vendorId, requisitionId: requisition.id, comparisonId: 'does-not-exist', createdById: f.memberUser.id },
      }),
    ).rejects.toThrow();
  });

  it('F5: a barrier race of two quote recordings leaves EXACTLY ONE recorded quote', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, { title: 'r', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    const record = () => procurement.recordQuote(projectId, rfq.id, {
      vendorId, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: requisition.lines[0]!.id, baseRate: '10', taxAmount: '0', freightAmount: '0', landedCost: '10', quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));
    let release!: () => void; let acquired!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (acquired = r));
    const holder = t.prisma.$transaction(
      async (tx) => { await lockProjectReadiness(tx, projectId); acquired(); await gate; },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await held;
    const a = record();
    const b = record();
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;
    await Promise.allSettled([a, b]);
    const recorded = await t.prisma.vendorQuote.count({ where: { projectId, rfqId: rfq.id, vendorId, status: 'recorded' } });
    expect(recorded).toBe(1);
  });

  it('F2: the purchase triple is explicit and dimensionally exact; base qty derives; partial orders prorate tax/freight', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId); // 100 bag
    const created = await procurement.createRequisition(projectId, { title: 'r', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '100' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: '100', taxAmount: '50', freightAmount: '25', landedCost: '10075', quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: withQuote.quotes[0]!.id, reason: 'only' }, pmc(projectId));
    // the vendor sells 5-bag packs: 4 packs = 20 bags. At base this arithmetic DOUBLE-counted
    // the conversion (rate × baseQty × conversion); corrected: rate is per BASE unit, so
    // committed = 100 × 4 × 5 + prorated tax/freight (20/100 share) = 2000 + 10 + 5.
    const po = await pos.create(projectId, {
      comparisonId: approved.comparison!.id,
      lines: [{ requisitionLineId: lineId, purchaseQty: '4', conversionToBase: '5', purchaseUom: 'pack-5' }],
    }, pmc(projectId));
    const line = po.versions[0]!.lines[0]!;
    expect(line).toMatchObject({
      purchaseUom: 'pack-5', purchaseQty: '4', conversionToBase: '5', qty: '20', uom: 'bag',
      rate: '100', taxAmount: '10', freightAmount: '5', committedAmountBase: '2015',
    });
    // ALLOCATION uses the DERIVED BASE quantity: 20 of 100 consumed → 81 more overflows
    await expect(
      pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: '81' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // the DB re-derives base qty (CHECK) and the frozen trigger guards the triple
    const lineRow = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId } });
    await expect(t.prisma.purchaseOrderLine.update({ where: { id: lineRow.id }, data: { purchaseQty: '5' } })).rejects.toThrow();
    // an inexact triple (base qty not landing on 6 dp) refuses
    await expect(
      pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: '0.000001', conversionToBase: '0.5' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('F4c: an APPROVED comparison is sealed; a selection outside its rfq/vendor is unrepresentable', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, { title: 'r', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: requisition.lines[0]!.id, baseRate: '10', taxAmount: '0', freightAmount: '0', landedCost: '10', quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: withQuote.quotes[0]!.id, reason: 'only' }, pmc(projectId));
    // sealed: NO column of an approved comparison may change (not even the reason)
    await expect(
      t.prisma.quoteComparison.update({ where: { id: approved.comparison!.id }, data: { reason: 'rewritten' } }),
    ).rejects.toThrow(/sealed/);
    await expect(t.prisma.quoteComparison.delete({ where: { id: approved.comparison!.id } })).rejects.toThrow();
    // a draft comparison naming a quote of ANOTHER rfq/vendor violates the selection FK
    const rfq2 = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await expect(
      t.prisma.quoteComparison.create({
        data: {
          projectId, rfqId: rfq2.id, requisitionId: requisition.id, createdById: f.memberUser.id,
          selectedQuoteId: withQuote.quotes[0]!.id, selectedVendorId: vendorId, // a quote of rfq #1
        },
      }),
    ).rejects.toThrow();
  });

  it('F5-DB: two RECORDED quotes for one (rfq, vendor) are unrepresentable at PostgreSQL', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, { title: 'r', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    await t.prisma.vendorQuote.create({ data: { projectId, rfqId: rfq.id, requisitionId: requisition.id, vendorId, validUntil: new Date('2027-01-01'), recordedById: f.memberUser.id } });
    await expect(
      t.prisma.vendorQuote.create({ data: { projectId, rfqId: rfq.id, requisitionId: requisition.id, vendorId, validUntil: new Date('2027-01-01'), recordedById: f.memberUser.id } }),
    ).rejects.toThrow(/one_recorded_per_rfq_vendor|Unique constraint/);
  });

  it('F7: quote expiry follows the PROJECT-timezone civil today (the injected clock), not server UTC', async () => {
    const projectId = await freshProject(); // timeZone Asia/Kolkata
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, { title: 'r', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const stillValid = await boundVendor(projectId, 'Valid today');
    const lapsed = await boundVendor(projectId, 'Lapsed locally');
    const localToday = new SystemClock().today('Asia/Kolkata');
    const localYesterday = new Date(new Date(localToday).getTime() - 86_400_000).toISOString().slice(0, 10);
    await procurement.recordQuote(projectId, rfq.id, {
      vendorId: stillValid, validUntil: localToday,
      lines: [{ requisitionLineId: lineId, baseRate: '100', taxAmount: '0', freightAmount: '0', landedCost: '100', quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));
    const both = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: lapsed, validUntil: localYesterday,
      lines: [{ requisitionLineId: lineId, baseRate: '90', taxAmount: '0', freightAmount: '0', landedCost: '90', quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const validQuote = both.quotes.find((q) => q.vendorId === stillValid)!;
    // approval settles validity against PROJECT-local today: valid-through-today survives,
    // locally-lapsed expires (and can win nothing)
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: validQuote.id, reason: 'valid through local today' }, pmc(projectId));
    expect(approved.comparison!.status).toBe('approved');
    const lapsedRow = await t.prisma.vendorQuote.findFirstOrThrow({ where: { projectId, rfqId: rfq.id, vendorId: lapsed } });
    expect(lapsedRow.status).toBe('expired');
  });

  it('F6: a SECOND delivery commitment on one PO line is refused', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, { title: 'r', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: requisition.lines[0]!.id, baseRate: '10', taxAmount: '0', freightAmount: '0', landedCost: '10', quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: withQuote.quotes[0]!.id, reason: 'only' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: requisition.lines[0]!.id, purchaseQty: '10' }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const lineRow = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId } });
    await pos.commitDelivery(projectId, { poLineId: lineRow.id, promisedDate: '2026-09-01' }, pmc(projectId));
    await expect(
      pos.commitDelivery(projectId, { poLineId: lineRow.id, promisedDate: '2026-09-05' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
  });

  // ── round 2 — F4 completion (RED at bffd7c9) ────────────────────────────────────────────

  const approvedRequisition = async (projectId: string, qty = '50') => {
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, { title: `R${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    return procurement.approve(projectId, created.id, pmc(projectId));
  };

  it('F4-r2 P1a: a PO referencing a DRAFT comparison is unrepresentable (status joins the provenance FK)', async () => {
    const projectId = await freshProject();
    const requisition = await approvedRequisition(projectId);
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    // the reviewer's exact shape: a DRAFT comparison with selectedVendorId set but NO
    // selected quote (the MATCH SIMPLE gap) — a PO referencing it must be FK-rejected
    const draft = await t.prisma.quoteComparison.create({
      data: { projectId, rfqId: rfq.id, requisitionId: requisition.id, createdById: f.memberUser.id, selectedVendorId: vendorId },
    });
    await expect(
      t.prisma.purchaseOrder.create({
        data: { projectId, vendorId, requisitionId: requisition.id, comparisonId: draft.id, createdById: f.memberUser.id },
      }),
    ).rejects.toThrow();
    // and the escape hatch is CHECK-pinned: a PO cannot simply declare comparisonStatus 'draft'
    await expect(
      t.prisma.purchaseOrder.create({
        data: { projectId, vendorId, requisitionId: requisition.id, comparisonId: draft.id, comparisonStatus: 'draft', createdById: f.memberUser.id },
      }),
    ).rejects.toThrow();
  });

  it('F4-r2 P1b: a quote line from ANOTHER requisition is unrepresentable (containment chain)', async () => {
    const projectId = await freshProject();
    const reqA = await approvedRequisition(projectId);
    const reqB = await approvedRequisition(projectId);
    const rfqA = await procurement.createRfq(projectId, { requisitionId: reqA.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    const withQuote = await procurement.recordQuote(projectId, rfqA.id, {
      vendorId, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: reqA.lines[0]!.id, baseRate: '10', taxAmount: '0', freightAmount: '0', landedCost: '10', quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes[0]!.id;
    const insertForged = (requisitionId: string) =>
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "VendorQuoteLine" ("id","projectId","quoteId","requisitionLineId","requisitionId","baseRate","taxAmount","freightAmount","landedCost","quotedMake","matchesSpecification")
         VALUES ('f4r2-forged-' || gen_random_uuid(), $1, $2, $3, $4, 10, 0, 0, 10, 'UltraTech', true)`,
        projectId, quoteId, reqB.lines[0]!.id, requisitionId,
      );
    // claiming the quote's requisition A with B's line → the line-containment FK refuses
    await expect(insertForged(reqA.id)).rejects.toThrow();
    // claiming B honestly → the quote-containment FK refuses (the quote belongs to A)
    await expect(insertForged(reqB.id)).rejects.toThrow();
  });

  it('F4-r2 P1b: a PO line from ANOTHER requisition is unrepresentable (containment chain)', async () => {
    const projectId = await freshProject();
    const reqA = await approvedRequisition(projectId);
    const reqB = await approvedRequisition(projectId);
    const rfqA = await procurement.createRfq(projectId, { requisitionId: reqA.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    const withQuote = await procurement.recordQuote(projectId, rfqA.id, {
      vendorId, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: reqA.lines[0]!.id, baseRate: '10', taxAmount: '0', freightAmount: '0', landedCost: '10', quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));
    await procurement.createComparison(projectId, rfqA.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfqA.id, { selectedQuoteId: withQuote.quotes[0]!.id, reason: 'only' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: reqA.lines[0]!.id, purchaseQty: '10' }] }, pmc(projectId));
    const version = await t.prisma.purchaseOrderVersion.findFirstOrThrow({ where: { projectId, poId: po.id } });
    const bLine = await t.prisma.requisitionLine.findFirstOrThrow({ where: { projectId, requisitionId: reqB.id } });
    const insertForged = (requisitionId: string) =>
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "PurchaseOrderLine" ("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","specFingerprint","uom","purchaseUom","purchaseQty","conversionToBase","qty","rate","taxAmount","freightAmount","landedAmount","committedAmountBase")
         VALUES ('f4r2-poline-' || gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'fp', 'bag', 'bag', 10, 1, 10, 10, 0, 0, 10, 100)`,
        projectId, version.id, bLine.id, requisitionId, bLine.requirementId, bLine.revision,
      );
    // claiming the PO's requisition A with B's line → the line-containment FK refuses
    await expect(insertForged(reqA.id)).rejects.toThrow();
    // claiming B honestly → the version-containment FK refuses (the PO belongs to A)
    await expect(insertForged(reqB.id)).rejects.toThrow();
  });
});
