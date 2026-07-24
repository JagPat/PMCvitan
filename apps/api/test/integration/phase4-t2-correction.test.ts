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
 * Phase 4 Task 2 CORRECTION — reproduce-first, RED at aae0711 → GREEN after the correction.
 *
 * The five findings the independent review raised, each proven against live PostgreSQL:
 *   F1  requisition 10 → PO 10 → issue → commit → close-short → second PO 10 must NOT create
 *       duplicate live capacity (the committed slice stays allocated across the PO lifecycle).
 *   F2  a raw mutation of a LabourRequisitionLine's frozen identity (shift / fingerprint) is rejected.
 *   F3  a raw CapacityCommitment whose slice identity differs from its PO line is rejected.
 *   F4  a raw PurchaseOrderLine whose financial terms are not provenance-bound to a quote line is rejected.
 *   F5  committedQty > personShiftQty is rejected.
 */
describe('Phase 4 Task 2 correction — labour commercial integrity (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let commercial: LabourProcurementService;
  let vendors: VendorsService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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
      ['auditLog', { projectId: { startsWith: 'it-p4c-' } }],
      ['activity', { projectId: { startsWith: 'it-p4c-' } }],
      ['membership', { projectId: { startsWith: 'it-p4c-' } }],
      ['project', { id: { startsWith: 'it-p4c-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures (mirror phase4-t2-labour-procurement.test.ts) ────────────────────────────────────
  const freshProject = async (): Promise<string> => {
    const id = `it-p4c-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4C-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };
  const labourRequirement = async (projectId: string, activityId: string, civilDate: string, qty: number): Promise<{ requirementId: string; revision: number }> => {
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: [{ civilDate, personShiftQty: qty }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    return { requirementId: r.requirementId, revision: r.revision };
  };
  const boundVendor = async (projectId: string, name = `Vendor ${seq++}`): Promise<string> => {
    const v = await vendors.create(f.orgA.id, { name }, orgAdmin());
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    return v.id;
  };
  const approvedComparison = async (projectId: string, requisitionId: string, lineId: string, vendorId: string, rate = '1000', premium = '0', landed = '1000') => {
    const rfq = await commercial.createRfq(projectId, { requisitionId }, pmc(projectId));
    await commercial.recordQuote(projectId, rfq.id, { vendorId, validUntil: '2026-12-31', lines: [{ requisitionLineId: lineId, ratePerPersonShift: rate, shiftPremium: premium, landedPerPersonShift: landed, matchesSpecification: true }] }, pmc(projectId));
    await commercial.createComparison(projectId, rfq.id, pmc(projectId));
    const full = await commercial.readRfq(projectId, rfq.id, pmc(projectId));
    const quoteId = full.quotes[0]!.id;
    await commercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparison = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!;
    return { rfqId: rfq.id, comparisonId: comparison.id, quoteId };
  };

  /** Build the full chain up to a single ISSUED PO of `poQty` for a `demandQty` slice. */
  const issuedPo = async (poQty = 10, demandQty = 10, rate = '1000', premium = '0') => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', demandQty);
    const vendorId = await boundVendor(projectId);
    const requisition = await commercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-10', personShiftQty: demandQty }] }, pmc(projectId));
    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await commercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const line = requisition.lines[0]!;
    const { comparisonId, quoteId } = await approvedComparison(projectId, requisition.id, line.id, vendorId, rate, premium, rate);
    const po = await commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: poQty }] }, pmc(projectId));
    await commercial.issuePo(projectId, po.id, pmc(projectId));
    const poLine = po.currentVersion.lines[0]!;
    return { projectId, requisitionId: requisition.id, lineId: line.id, comparisonId, quoteId, poId: po.id, poLine, vendorId };
  };

  /** The intended INBOUND capacity for the requirement slice: live commitments + uncommitted live orders. */
  const intendedInboundForSlice = async (projectId: string, civilDate: string): Promise<number> => {
    const commitments = await t.prisma.capacityCommitment.findMany({ where: { projectId, civilDate: new Date(`${civilDate}T00:00:00.000Z`), status: { in: ['committed', 'revised'] } }, select: { personShiftQty: true, poLineId: true } });
    const committedLine = new Set(commitments.map((c) => c.poLineId));
    const liveCommitmentQty = commitments.reduce((s, c) => s + c.personShiftQty, 0);
    const orderLines = await t.prisma.labourPurchaseOrderLine.findMany({
      where: { projectId, civilDate: new Date(`${civilDate}T00:00:00.000Z`), poVersion: { status: { in: ['issued', 'partially_committed', 'completed'] } } },
      select: { id: true, personShiftQty: true },
    });
    const uncommittedOrderQty = orderLines.filter((l) => !committedLine.has(l.id)).reduce((s, l) => s + l.personShiftQty, 0);
    return liveCommitmentQty + uncommittedOrderQty;
  };

  // ── F1 — no duplicate live capacity across commit + close-short ───────────────────────────────
  it('F1: requisition 10 → PO 10 → issue → commit → close-short → second PO 10 never doubles live capacity', async () => {
    const { projectId, comparisonId, lineId, poId, poLine } = await issuedPo(10, 10);
    await commercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: '2026-08-05' }, pmc(projectId));
    // close-short and a second (issued) PO are BOTH attempts to re-use the already-committed slice;
    // either or both may be refused after the fix — what must hold is the INVARIANT below.
    try { await commercial.closeShortPo(projectId, poId, { reason: 'source fell short' }, pmc(projectId)); } catch { /* refused after fix */ }
    try {
      const po2 = await commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: lineId, personShiftQty: 10 }] }, pmc(projectId));
      await commercial.issuePo(projectId, po2.id, pmc(projectId));
    } catch { /* refused after fix */ }
    // the requirement asks for 10 person-shifts on the slice; live inbound must never exceed it.
    expect(await intendedInboundForSlice(projectId, '2026-08-10')).toBeLessThanOrEqual(10);
  });

  // ── F2 — the requisition line's frozen identity cannot be raw-mutated ─────────────────────────
  it('F2: a raw UPDATE of a requisition line shift/fingerprint is rejected', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', 10);
    const requisition = await commercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-10', personShiftQty: 10 }] }, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    await expect(t.prisma.$executeRaw`UPDATE "LabourRequisitionLine" SET "shift" = 'night' WHERE "id" = ${lineId}`).rejects.toThrow();
    await expect(t.prisma.$executeRaw`UPDATE "LabourRequisitionLine" SET "labourSpecFingerprint" = ${'0'.repeat(64)} WHERE "id" = ${lineId}`).rejects.toThrow();
  });

  // ── F3 — a commitment's slice identity must match its PO line ─────────────────────────────────
  it('F3: a raw CapacityCommitment whose slice identity differs from its PO line is rejected', async () => {
    const { projectId, poLine } = await issuedPo(10, 10);
    // same poLineId, but a DIFFERENT civilDate/shift/qty than the PO line — must be unrepresentable.
    await expect(
      t.prisma.$executeRaw`
        INSERT INTO "CapacityCommitment" ("id","projectId","poLineId","labourSpecFingerprint","civilDate","shift","personShiftQty","status","createdById")
        VALUES (${'p4c-f3-' + seq++}, ${projectId}, ${poLine.id}, ${poLine.labourSpecFingerprint}, ${new Date('2026-09-09T00:00:00.000Z')}, 'night', ${poLine.personShiftQty + 5}, 'committed', ${f.memberUser.id})`,
    ).rejects.toThrow();
  });

  // ── F4 — a PO line's financial terms must be provenance-bound to a quote line ─────────────────
  it('F4: a raw PurchaseOrderLine with no quote-line provenance is rejected', async () => {
    const { projectId, poLine } = await issuedPo(10, 10, '1000', '0');
    const version = await t.prisma.labourPurchaseOrderLine.findFirstOrThrow({ where: { id: poLine.id }, select: { poVersionId: true } });
    // a fabricated PO line carrying a rate that came from NO quote (old-schema columns only) — after
    // the correction the line cannot exist without its selected-quote-line provenance columns.
    await expect(
      t.prisma.$executeRaw`
        INSERT INTO "LabourPurchaseOrderLine"
          ("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","committedQty")
        SELECT ${'p4c-f4-' + seq++}, "projectId", "poVersionId", "requisitionLineId", "requisitionId", "requirementId", "revision", "civilDate", "shift", "labourSpecFingerprint", "personShiftQty", 99999, 0, round(99999 * "personShiftQty", 2), 0
        FROM "LabourPurchaseOrderLine" WHERE "id" = ${poLine.id}`,
    ).rejects.toThrow();
  });

  // ── F5 — committedQty may never exceed the ordered personShiftQty ─────────────────────────────
  it('F5: committedQty > personShiftQty is rejected', async () => {
    const { poLine } = await issuedPo(10, 10);
    await expect(
      t.prisma.$executeRaw`UPDATE "LabourPurchaseOrderLine" SET "committedQty" = ${poLine.personShiftQty + 1} WHERE "id" = ${poLine.id}`,
    ).rejects.toThrow();
  });

  const liveCommitmentCount = (projectId: string): Promise<number> =>
    t.prisma.capacityCommitment.count({ where: { projectId, status: { in: ['committed', 'revised'] } } });

  /** An ISSUED 2-line PO (two civil-date slices of `qty`), each fully ordered. */
  const twoLineIssuedPo = async (qty = 10) => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId: act, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: [{ civilDate: '2026-08-10', personShiftQty: qty }, { civilDate: '2026-08-11', personShiftQty: qty }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    const vendorId = await boundVendor(projectId);
    const requisition = await commercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [{ requirementId: r.requirementId, revision: r.revision, civilDate: '2026-08-10', personShiftQty: qty }, { requirementId: r.requirementId, revision: r.revision, civilDate: '2026-08-11', personShiftQty: qty }] }, pmc(projectId));
    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await commercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const [l1, l2] = requisition.lines;
    const rfq = await commercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await commercial.recordQuote(projectId, rfq.id, { vendorId, validUntil: '2026-12-31', lines: [{ requisitionLineId: l1!.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }, { requisitionLineId: l2!.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }] }, pmc(projectId));
    await commercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await commercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'both lines in-spec' }, pmc(projectId));
    const comparisonId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    const po = await commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: l1!.id, personShiftQty: qty }, { requisitionLineId: l2!.id, personShiftQty: qty }] }, pmc(projectId));
    await commercial.issuePo(projectId, po.id, pmc(projectId));
    const lines = (await commercial.readPo(projectId, po.id, pmc(projectId))).currentVersion.lines;
    return { projectId, poId: po.id, lines };
  };

  // ── F1 — partial / multi-line commit + close-short truth ──────────────────────────────────────
  it('F1 multi-line: one commit → partially_committed; close-short KEEPS the committed line, RELEASES the rest', async () => {
    const { projectId, poId, lines } = await twoLineIssuedPo(10);
    const committed = lines.find((l) => l.civilDate === '2026-08-10')!;
    const released = lines.find((l) => l.civilDate === '2026-08-11')!;
    await commercial.commitCapacity(projectId, { poLineId: committed.id, promisedDate: '2026-08-05' }, pmc(projectId));
    expect((await commercial.readPo(projectId, poId, pmc(projectId))).currentVersion.status).toBe('partially_committed');
    await commercial.closeShortPo(projectId, poId, { reason: 'the other slice fell through' }, pmc(projectId));
    const closed = await commercial.readPo(projectId, poId, pmc(projectId));
    expect(closed.currentVersion.status).toBe('closed_short');
    expect(closed.currentVersion.lines.find((l) => l.id === committed.id)!.committedQty).toBe(10); // kept
    expect(closed.currentVersion.lines.find((l) => l.id === released.id)!.committedQty).toBe(0); // released
    expect(await intendedInboundForSlice(projectId, '2026-08-10')).toBe(10); // committed slice stays allocated
    expect(await intendedInboundForSlice(projectId, '2026-08-11')).toBe(0); // released slice frees for re-procurement
  });

  // ── F1 — concurrency: commit vs close-short (both orderings, 10×) ─────────────────────────────
  it('F1 race: commit vs close-short (10×) — exactly one wins; never doubles or orphans capacity', async () => {
    for (let i = 0; i < 10; i++) {
      const { projectId, poId, poLine } = await issuedPo(10, 10);
      const results = await Promise.allSettled([
        commercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: '2026-08-05' }, pmc(projectId)),
        commercial.closeShortPo(projectId, poId, { reason: 'race' }, pmc(projectId)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await intendedInboundForSlice(projectId, '2026-08-10')).toBeLessThanOrEqual(10);
      expect(await liveCommitmentCount(projectId)).toBeLessThanOrEqual(1);
    }
  });

  // ── F1 — concurrency: commit vs amend (both orderings, 10×) ───────────────────────────────────
  it('F1 race: commit vs amend (10×) — a live commitment is never orphaned by an amend', async () => {
    for (let i = 0; i < 10; i++) {
      const { projectId, poId, lineId, poLine } = await issuedPo(10, 10);
      const results = await Promise.allSettled([
        commercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: '2026-08-05' }, pmc(projectId)),
        commercial.amendPo(projectId, poId, { reason: 'race', lines: [{ requisitionLineId: lineId, personShiftQty: 10 }] }, pmc(projectId)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await intendedInboundForSlice(projectId, '2026-08-10')).toBeLessThanOrEqual(10);
      expect(await liveCommitmentCount(projectId)).toBeLessThanOrEqual(1);
    }
  });
});
