import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 2 correction ROUND 3 — coherent labour requisition TERMINAL STATE (live PG).
 *
 * Round 2 made `closeRequisition` derive live allocation, but a default that lands AFTER a clean
 * closure still reopened the child line to 'open' while the parent requisition stayed 'closed' — an
 * incoherent terminal state (a closed parent containing an open child). Round 3's policy: a
 * post-closure default that REMOVES required coverage atomically reopens the requisition
 * closed → approved (clearing closedAt, leaving the affected line open, with attributable audit
 * evidence, under the readiness lock + a CAS transition). Reproduce-first: RED at c09b1ac, GREEN after.
 */
describe('Phase 4 Task 2 correction R3 — coherent requisition terminal state (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let commercial: LabourProcurementService;
  let vendors: VendorsService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "VendorAdvance", "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "CashForecastProjection", "LabourReadinessProjection", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectPartyVendorSource", "ProjectPartyCompanySource", "ProjectParty", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', projectId: '' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    commercial = t.app.get(LabourProcurementService);
    vendors = t.app.get(VendorsService);
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
      ['auditLog', { projectId: { startsWith: 'it-p4c3-' } }],
      ['activity', { projectId: { startsWith: 'it-p4c3-' } }],
      ['membership', { projectId: { startsWith: 'it-p4c3-' } }],
      ['project', { id: { startsWith: 'it-p4c3-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-p4c3-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4C3-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };
  const boundVendor = async (projectId: string, name = `Vendor ${seq++}`): Promise<string> => {
    const v = await vendors.create(f.orgA.id, { name }, orgAdmin());
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    return v.id;
  };

  const approvedComparison = async (dates: string[], qty = 10) => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId: act, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: dates.map((civilDate) => ({ civilDate, personShiftQty: qty })), decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    const vendorId = await boundVendor(projectId);
    const requisition = await commercial.createRequisition(projectId, { title: `req ${seq++}`, lines: dates.map((civilDate) => ({ requirementId: r.requirementId, revision: r.revision, civilDate, personShiftQty: qty })) }, pmc(projectId));
    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await commercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const reqLines = requisition.lines;
    const rfq = await commercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await commercial.recordQuote(projectId, rfq.id, { vendorId, validUntil: '2026-12-31', lines: reqLines.map((l) => ({ requisitionLineId: l.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true })) }, pmc(projectId));
    await commercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await commercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'x' }, pmc(projectId));
    const comparisonId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    return { projectId, requisitionId: requisition.id, comparisonId, reqLines, vendorId };
  };
  type Comparison = Awaited<ReturnType<typeof approvedComparison>>;
  const issuePoFor = async (c: Comparison, lines: Array<{ requisitionLineId: string; personShiftQty: number }>) => {
    const po = await commercial.createPo(c.projectId, { comparisonId: c.comparisonId, lines }, pmc(c.projectId));
    await commercial.issuePo(c.projectId, po.id, {}, pmc(c.projectId));
    const poLines = (await commercial.readPo(c.projectId, po.id, pmc(c.projectId))).currentVersion.lines;
    return { poId: po.id, poLines };
  };
  const issuedPo = async (dates: string[], qty = 10) => {
    const c = await approvedComparison(dates, qty);
    const { poId, poLines } = await issuePoFor(c, c.reqLines.map((l) => ({ requisitionLineId: l.id, personShiftQty: qty })));
    return { ...c, poId, poLines };
  };

  const reqLineStatus = async (projectId: string, id: string): Promise<string> =>
    (await t.prisma.labourRequisitionLine.findFirstOrThrow({ where: { projectId, id }, select: { status: true } })).status;
  const reqState = async (projectId: string, id: string): Promise<{ status: string; closedAt: Date | null }> =>
    t.prisma.labourRequisition.findFirstOrThrow({ where: { projectId, id }, select: { status: true, closedAt: true } });

  // ── RC3-1 — reproduce the incoherent terminal state ───────────────────────────────────────────
  it('R3 DEFECT: a post-closure default removing coverage reopens the requisition (never closed-with-open-child)', async () => {
    const { projectId, requisitionId, reqLines, poLines } = await issuedPo(['2026-08-10'], 10);
    const line = reqLines[0]!;
    const commitment = await commercial.commitCapacity(projectId, { poLineId: poLines[0]!.id, promisedDate: '2026-08-05' }, pmc(projectId));

    // the single line is fully covered → the requisition closes cleanly
    const closed = await commercial.closeRequisition(projectId, requisitionId, pmc(projectId));
    expect(closed.status).toBe('closed');
    expect((await reqState(projectId, requisitionId)).closedAt).not.toBeNull();

    // the source reneges AFTER closure — required coverage is removed
    await commercial.defaultCapacity(projectId, commitment.id, pmc(projectId));

    // COHERENT terminal state: the requisition reopens (approved), closedAt cleared, the line is open.
    expect(await reqLineStatus(projectId, line.id)).toBe('open');
    const req = await reqState(projectId, requisitionId);
    expect(req.status).toBe('approved');
    expect(req.closedAt).toBeNull();
  });

  // on a multi-line closed requisition, defaulting ONE line's commitment reopens the requisition and
  // leaves that line open, while a sibling line covered by its own live commitment stays ordered.
  it('R3: a post-closure default reopens the requisition and leaves the sibling line ordered', async () => {
    const { projectId, requisitionId, reqLines, poLines } = await issuedPo(['2026-08-10', '2026-08-11'], 10);
    const lineA = reqLines.find((l) => l.civilDate === '2026-08-10')!;
    const lineB = reqLines.find((l) => l.civilDate === '2026-08-11')!;
    const poLineA = poLines.find((l) => l.civilDate === '2026-08-10')!;
    const poLineB = poLines.find((l) => l.civilDate === '2026-08-11')!;
    const cA = await commercial.commitCapacity(projectId, { poLineId: poLineA.id, promisedDate: '2026-08-05' }, pmc(projectId));
    await commercial.commitCapacity(projectId, { poLineId: poLineB.id, promisedDate: '2026-08-05' }, pmc(projectId));
    // both lines committed → the requisition closes cleanly
    const closed = await commercial.closeRequisition(projectId, requisitionId, pmc(projectId));
    expect(closed.status).toBe('closed');

    // defaulting line A only → the requisition reopens; line A open, line B still ordered
    await commercial.defaultCapacity(projectId, cA.id, pmc(projectId));
    expect(await reqLineStatus(projectId, lineA.id)).toBe('open');
    expect(await reqLineStatus(projectId, lineB.id)).toBe('ordered');
    const req = await reqState(projectId, requisitionId);
    expect(req.status).toBe('approved');
    expect(req.closedAt).toBeNull();
  });
});
