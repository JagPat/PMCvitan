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
 * Phase 4 Task 2 correction ROUND 2 — labour requisition-lifecycle CONSISTENCY (live PG).
 *
 * The round-1 correction moved committedQty + the PO version status together, but two lifecycle
 * paths still trusted a potentially STALE requisition-line status column:
 *   - `defaultCapacity` cleared committedQty + recomputed the version but did NOT refresh the
 *     requisition line, so a defaulted commitment on a terminal (closed_short) version left the
 *     line stuck 'ordered' with ZERO live allocation;
 *   - `closeRequisition` counted `status='open'` rows instead of deriving live allocation, so it
 *     accepted a requisition whose 'ordered' line was in truth uncovered.
 * Reproduce-first: RED at 81e43ed, GREEN after.
 */
describe('Phase 4 Task 2 correction R2 — requisition lifecycle consistency (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let commercial: LabourProcurementService;
  let vendors: VendorsService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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
      ['auditLog', { projectId: { startsWith: 'it-p4c2-' } }],
      ['activity', { projectId: { startsWith: 'it-p4c2-' } }],
      ['membership', { projectId: { startsWith: 'it-p4c2-' } }],
      ['project', { id: { startsWith: 'it-p4c2-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-p4c2-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4C2-ACT-${Date.now() % 1e6}-${seq++}`;
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

  /** An APPROVED comparison over a requisition of `dates.length` slices (`qty` person-shifts each). */
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

  /** Create + issue ONE PO for a comparison over the given `(requisitionLineId, personShiftQty)` lines. */
  const issuePoFor = async (c: Comparison, lines: Array<{ requisitionLineId: string; personShiftQty: number }>) => {
    const po = await commercial.createPo(c.projectId, { comparisonId: c.comparisonId, lines }, pmc(c.projectId));
    await commercial.issuePo(c.projectId, po.id, {}, pmc(c.projectId));
    const poLines = (await commercial.readPo(c.projectId, po.id, pmc(c.projectId))).currentVersion.lines;
    return { poId: po.id, poLines };
  };

  /** an ISSUED PO with `dates.length` lines (one civil-date slice of `qty` each), all ordered. */
  const issuedPo = async (dates: string[], qty = 10) => {
    const c = await approvedComparison(dates, qty);
    const { poId, poLines } = await issuePoFor(c, c.reqLines.map((l) => ({ requisitionLineId: l.id, personShiftQty: qty })));
    return { ...c, poId, poLines };
  };

  const reqLineStatus = async (projectId: string, id: string): Promise<string> =>
    (await t.prisma.labourRequisitionLine.findFirstOrThrow({ where: { projectId, id }, select: { status: true } })).status;

  // ── RC2-1 — the reproduce-first lifecycle defect ──────────────────────────────────────────────
  it('R2 DEFECT: default of a committed line on a closed-short PO must not let the requisition close with an uncovered line', async () => {
    const { projectId, requisitionId, poId, reqLines, poLines } = await issuedPo(['2026-08-10', '2026-08-11'], 10);
    const lineA = reqLines.find((l) => l.civilDate === '2026-08-10')!;
    const lineB = reqLines.find((l) => l.civilDate === '2026-08-11')!;
    const poLineA = poLines.find((l) => l.civilDate === '2026-08-10')!;

    const commitment = await commercial.commitCapacity(projectId, { poLineId: poLineA.id, promisedDate: '2026-08-05' }, pmc(projectId));
    await commercial.closeShortPo(projectId, poId, { reason: 'source short' }, pmc(projectId));
    await commercial.defaultCapacity(projectId, commitment.id, pmc(projectId));
    await commercial.cancelRequisitionLine(projectId, requisitionId, lineB.id, pmc(projectId));

    // line A's PO was closed short AND its commitment defaulted — nothing live covers it now, so it
    // is NOT truly ordered and the requisition must NOT be closeable.
    expect(await reqLineStatus(projectId, lineA.id)).toBe('open');
    await expect(commercial.closeRequisition(projectId, requisitionId, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  // ── RC2-2 — the four required lifecycle-consistency cases ─────────────────────────────────────

  // (1) completed one-line PO → default → the requisition line reopens (freed for re-sourcing).
  it('completed one-line PO → default → requisition line reopens and blocks closure', async () => {
    const { projectId, requisitionId, reqLines, poLines } = await issuedPo(['2026-08-10'], 10);
    const line = reqLines[0]!;
    const commitment = await commercial.commitCapacity(projectId, { poLineId: poLines[0]!.id, promisedDate: '2026-08-05' }, pmc(projectId));
    // committing the whole single line completes the PO and holds the requisition line ordered
    expect(await reqLineStatus(projectId, line.id)).toBe('ordered');

    await commercial.defaultCapacity(projectId, commitment.id, pmc(projectId));
    // the source reneged; the PO line can never be re-committed, so its slice is freed and the line
    // reopens even though the version fell back to 'issued' (a live-but-uncovered order).
    expect(await reqLineStatus(projectId, line.id)).toBe('open');
    await expect(commercial.closeRequisition(projectId, requisitionId, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  // (2) partially committed → close-short → default of the committed line → that line reopens.
  it('partially committed → close-short → default of the committed line reopens its requisition line', async () => {
    const { projectId, poId, reqLines, poLines } = await issuedPo(['2026-08-10', '2026-08-11'], 10);
    const lineA = reqLines.find((l) => l.civilDate === '2026-08-10')!;
    const poLineA = poLines.find((l) => l.civilDate === '2026-08-10')!;

    const commitment = await commercial.commitCapacity(projectId, { poLineId: poLineA.id, promisedDate: '2026-08-05' }, pmc(projectId));
    // only line A committed → the version is partially committed
    expect((await commercial.readPo(projectId, poId, pmc(projectId))).currentVersion.status).toBe('partially_committed');
    await commercial.closeShortPo(projectId, poId, { reason: 'the other slice fell through' }, pmc(projectId));
    // close-short keeps line A's committed portion — it stays ordered
    expect(await reqLineStatus(projectId, lineA.id)).toBe('ordered');

    await commercial.defaultCapacity(projectId, commitment.id, pmc(projectId));
    // defaulting the only thing covering line A reopens it
    expect(await reqLineStatus(projectId, lineA.id)).toBe('open');
  });

  // (3) requisition closure refused while any non-cancelled line lacks live allocation; permitted
  //     once every line is ordered or cancelled.
  it('requisition closure is refused while a line lacks live allocation, and permitted once it is cancelled', async () => {
    const c = await approvedComparison(['2026-08-10', '2026-08-11'], 10);
    const lineA = c.reqLines.find((l) => l.civilDate === '2026-08-10')!;
    const lineB = c.reqLines.find((l) => l.civilDate === '2026-08-11')!;
    // order ONLY line A; line B is never ordered
    await issuePoFor(c, [{ requisitionLineId: lineA.id, personShiftQty: 10 }]);
    expect(await reqLineStatus(c.projectId, lineA.id)).toBe('ordered');
    expect(await reqLineStatus(c.projectId, lineB.id)).toBe('open');

    await expect(commercial.closeRequisition(c.projectId, c.requisitionId, pmc(c.projectId))).rejects.toMatchObject({ status: 409 });

    await commercial.cancelRequisitionLine(c.projectId, c.requisitionId, lineB.id, pmc(c.projectId));
    const closed = await commercial.closeRequisition(c.projectId, c.requisitionId, pmc(c.projectId));
    expect(closed.status).toBe('closed');
  });

  // (4) another valid live allocation keeps the line ordered — a re-sourced PO re-covers the freed
  //     slice, and a per-line default never disturbs a sibling line's own live allocation.
  it('a re-sourced live PO keeps the line ordered after the first PO’s commitment defaults', async () => {
    const c = await approvedComparison(['2026-08-10'], 10);
    const line = c.reqLines[0]!;
    const po1 = await issuePoFor(c, [{ requisitionLineId: line.id, personShiftQty: 10 }]);
    const commitment = await commercial.commitCapacity(c.projectId, { poLineId: po1.poLines[0]!.id, promisedDate: '2026-08-05' }, pmc(c.projectId));
    await commercial.defaultCapacity(c.projectId, commitment.id, pmc(c.projectId));
    // PO1 defaulted → the slice is freed and the line reopened
    expect(await reqLineStatus(c.projectId, line.id)).toBe('open');

    // re-source the freed slice with PO2 (§F bound 2 permits it — PO1 now covers nothing)
    await issuePoFor(c, [{ requisitionLineId: line.id, personShiftQty: 10 }]);
    // PO2 is a valid live allocation → the line is ordered again and the requisition closes cleanly
    expect(await reqLineStatus(c.projectId, line.id)).toBe('ordered');
    const closed = await commercial.closeRequisition(c.projectId, c.requisitionId, pmc(c.projectId));
    expect(closed.status).toBe('closed');
  });

  it('a per-line default leaves a sibling line covered by its own live commitment ordered', async () => {
    const { projectId, requisitionId, reqLines, poLines } = await issuedPo(['2026-08-10', '2026-08-11'], 10);
    const lineA = reqLines.find((l) => l.civilDate === '2026-08-10')!;
    const lineB = reqLines.find((l) => l.civilDate === '2026-08-11')!;
    const poLineA = poLines.find((l) => l.civilDate === '2026-08-10')!;
    const poLineB = poLines.find((l) => l.civilDate === '2026-08-11')!;

    const cA = await commercial.commitCapacity(projectId, { poLineId: poLineA.id, promisedDate: '2026-08-05' }, pmc(projectId));
    await commercial.commitCapacity(projectId, { poLineId: poLineB.id, promisedDate: '2026-08-05' }, pmc(projectId));
    // defaulting line A must reopen A ONLY — line B's own live commitment keeps B ordered
    await commercial.defaultCapacity(projectId, cA.id, pmc(projectId));
    expect(await reqLineStatus(projectId, lineA.id)).toBe('open');
    expect(await reqLineStatus(projectId, lineB.id)).toBe('ordered');
    // A is uncovered → the requisition still cannot close
    await expect(commercial.closeRequisition(projectId, requisitionId, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  // A line split across two live POs is fully allocated by their SUM; losing one PO reopens it —
  // closeRequisition derives allocation across every covering PO, not from a single status column.
  it('a line split across two live POs stays fully allocated by their sum; losing one reopens it', async () => {
    const c = await approvedComparison(['2026-08-10'], 20);
    const line = c.reqLines[0]!;
    const po1 = await issuePoFor(c, [{ requisitionLineId: line.id, personShiftQty: 10 }]);
    await issuePoFor(c, [{ requisitionLineId: line.id, personShiftQty: 10 }]);
    // 10 + 10 across two live POs fully order the 20-person-shift line
    expect(await reqLineStatus(c.projectId, line.id)).toBe('ordered');

    // close ONE PO short (its 10 uncommitted person-shifts are released) → only 10 of 20 remain live
    await commercial.closeShortPo(c.projectId, po1.poId, { reason: 'one source fell through' }, pmc(c.projectId));
    expect(await reqLineStatus(c.projectId, line.id)).toBe('open');
    await expect(commercial.closeRequisition(c.projectId, c.requisitionId, pmc(c.projectId))).rejects.toMatchObject({ status: 409 });
  });
});
