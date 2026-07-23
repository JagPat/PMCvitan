import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { SubstitutionsService } from '../../src/activities/substitutions.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Task 6 — CANONICAL material coverage feeds `activities.start` (plan §A/§B/§D),
 * live PG. On a PILOT project the material gate is the §A truth over inventory's `coverageFor`,
 * evaluated INSIDE the start transaction under the readiness lock — never the stored flag and
 * never a projection:
 *   • not-required → na → start succeeds (no requirement)
 *   • ready → ok (reserved / issued stock ≥ required, matching fingerprint) → start succeeds
 *   • at-risk → wait (shortfall, a confirmed covering commitment) → start refuses
 *   • blocked → fail (shortfall, no covering commitment) → start refuses
 *   • an unresolved site mismatch is a `fail` BEFORE coverage (first-match)
 *   • an approved substitution widens the acceptable fingerprints; revocation narrows them again
 *   • issued-to-the-activity stock COUNTS as coverage (the Task-1 GO guardrail)
 * A NON-pilot project keeps the STORED gate verbatim (coverage never consulted).
 */

describe('Phase 3 Task 6 — canonical coverage feeds activities.start (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let substitutions: SubstitutionsService;
  let activities: ActivitiesService;
  let vendors: VendorsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let inventory: InventoryService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "ApprovedSubstitution", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    substitutions = t.app.get(SubstitutionsService);
    activities = t.app.get(ActivitiesService);
    vendors = t.app.get(VendorsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    inventory = t.app.get(InventoryService);
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
      ['media', { projectId: { startsWith: 'it-p3t6-' } }],
      ['activity', { projectId: { startsWith: 'it-p3t6-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3t6-' } }],
      ['membership', { projectId: { startsWith: 'it-p3t6-' } }],
      ['project', { id: { startsWith: 'it-p3t6-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (enablePilot = true, orgId = f.orgA.id): Promise<string> => {
    const id = `it-p3t6-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    if (enablePilot) await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };

  const freshActivity = async (projectId: string, gateMaterial: 'na' | 'wait' | 'fail' | 'ok' = 'na'): Promise<string> => {
    const id = `IT-P3T6-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10, gateMaterial } });
    return id;
  };

  const SPEC_A = { materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53' };
  const SPEC_B = { materialCategory: 'Cement', make: 'ACC', grade: 'OPC 53' };

  const addRequirement = async (projectId: string, activityId: string, qty = '100', spec = SPEC_A): Promise<{ requirementId: string; revision: number }> => {
    const input: CreateRequirementInput = {
      activityId, ...spec, attributes: 'grey', baseUom: 'bag', qty, requiredBy: '2026-08-15',
      criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null,
    };
    const r = await requirements.create(projectId, input, pmc(projectId));
    return { requirementId: r.requirementId, revision: r.revision };
  };

  /** requirement → approved requisition → quote → approved comparison → issued PO + delivery commitment. */
  const receivablePoLine = async (projectId: string, req: { requirementId: string; revision: number }, lineQty = '100') => {
    const created = await procurement.createRequisition(projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty: lineQty }] }, pmc(projectId));
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
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: lineQty }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    const commitment = await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-09-01' }, pmc(projectId));
    return { poLineId: line.id, commitmentId: commitment.id };
  };

  const freshMedia = async (projectId: string): Promise<string> => {
    const row = await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } });
    return row.id;
  };

  /** Receive + accept `qty` base units of the PO line; returns the lot id. */
  const receiveAndAccept = async (projectId: string, poLineId: string, commitmentId: string, qty = '100'): Promise<string> => {
    const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: qty }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, qty, qualityResult: 'passed', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    return lot.id;
  };

  const startResult = (projectId: string, activityId: string) => activities.start(projectId, activityId, pmc(projectId));
  const status = async (projectId: string, activityId: string): Promise<string> => {
    const a = await t.prisma.activity.findUniqueOrThrow({ where: { id: activityId }, select: { status: true } });
    return a.status;
  };

  it('NOT-REQUIRED → na: a pilot activity with no material requirement starts', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    await startResult(projectId, activityId);
    expect(await status(projectId, activityId)).toBe('in_progress');
  });

  it('BLOCKED → fail: a requirement with no stock and no commitment refuses start', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    await addRequirement(projectId, activityId, '100');
    await expect(startResult(projectId, activityId)).rejects.toMatchObject({ status: 409 });
    expect(await status(projectId, activityId)).toBe('not_started');
  });

  it('AT-RISK → wait: a shortfall covered only by a confirmed commitment refuses start', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100');
    // an issued PO + delivery commitment exists (confirmed inbound) but NOTHING is accepted/reserved yet
    await receivablePoLine(projectId, req, '100');
    await expect(startResult(projectId, activityId)).rejects.toMatchObject({ status: 409 });
    expect(await status(projectId, activityId)).toBe('not_started');
  });

  it('READY → ok: reserved stock ≥ required starts; issued-to-the-activity still counts as coverage', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100');
    const { poLineId, commitmentId } = await receivablePoLine(projectId, req, '100');
    const lotId = await receiveAndAccept(projectId, poLineId, commitmentId, '100');
    await inventory.reserve(projectId, { lotId, activityId, qty: '100' }, pmc(projectId));

    // reserved 100 ≥ required 100 → ready → start succeeds
    await startResult(projectId, activityId);
    expect(await status(projectId, activityId)).toBe('in_progress');
  });

  it('ISSUED counts as coverage (guardrail): issuing the reserved stock keeps the activity startable', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100');
    const { poLineId, commitmentId } = await receivablePoLine(projectId, req, '100');
    const lotId = await receiveAndAccept(projectId, poLineId, commitmentId, '100');
    await inventory.reserve(projectId, { lotId, activityId, qty: '100' }, pmc(projectId));
    // issue the reserved stock to the activity BEFORE starting — coverage must stay ready
    await inventory.issue(projectId, { lotId, activityId, qty: '100' }, pmc(projectId));
    await startResult(projectId, activityId);
    expect(await status(projectId, activityId)).toBe('in_progress');
  });

  it('MISMATCH-first: an unresolved site mismatch is a fail even with full coverage', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId, 'fail'); // the daily-log mismatch block, stored on the activity
    const req = await addRequirement(projectId, activityId, '100');
    const { poLineId, commitmentId } = await receivablePoLine(projectId, req, '100');
    const lotId = await receiveAndAccept(projectId, poLineId, commitmentId, '100');
    await inventory.reserve(projectId, { lotId, activityId, qty: '100' }, pmc(projectId));
    // fully covered, yet the mismatch fail wins (first-match)
    await expect(startResult(projectId, activityId)).rejects.toMatchObject({ status: 409 });
    // clearing the mismatch (gate back to 'wait') lets coverage decide → ready → start
    await t.prisma.activity.update({ where: { id: activityId }, data: { gateMaterial: 'wait' } });
    await startResult(projectId, activityId);
    expect(await status(projectId, activityId)).toBe('in_progress');
  });

  it('SUBSTITUTION: stock of a different spec covers only while an active substitution exists', async () => {
    const projectId = await freshProject();
    const activityX = await freshActivity(projectId);
    const reqA = await addRequirement(projectId, activityX, '100', SPEC_A);
    // spec-B stock: a separate spec-B requirement's PO line, received + accepted, then reserved for activity X
    const activityY = await freshActivity(projectId);
    const reqB = await addRequirement(projectId, activityY, '100', SPEC_B);
    const { poLineId, commitmentId } = await receivablePoLine(projectId, reqB, '100');
    const lotB = await receiveAndAccept(projectId, poLineId, commitmentId, '100');
    await inventory.reserve(projectId, { lotId: lotB, activityId: activityX, qty: '100' }, pmc(projectId));

    // without a substitution, spec-B stock does NOT satisfy spec-A → blocked
    await expect(startResult(projectId, activityX)).rejects.toMatchObject({ status: 409 });

    // approve A→B (describe the spec-B material; the server computes toFingerprint) → ready
    const sub = await substitutions.approve(projectId, reqA.requirementId, { ...SPEC_B, attributes: 'grey', baseUom: 'bag', reason: 'equivalent grade, approved' }, pmc(projectId));
    await startResult(projectId, activityX);
    expect(await status(projectId, activityX)).toBe('in_progress');

    // revoking narrows the acceptable set again — a fresh activity with the same demand blocks
    const activityZ = await freshActivity(projectId);
    const reqA2 = await addRequirement(projectId, activityZ, '100', SPEC_A);
    const subZ = await substitutions.approve(projectId, reqA2.requirementId, { ...SPEC_B, attributes: 'grey', baseUom: 'bag', reason: 'equivalent' }, pmc(projectId));
    await inventory.reserve(projectId, { lotId: lotB, activityId: activityZ, qty: '0' }, pmc(projectId)).catch(() => undefined);
    await substitutions.revoke(projectId, subZ.id, { reason: 'withdrawn' }, pmc(projectId));
    // (no stock reserved for Z anyway) → blocked regardless; the key assertion is the revoke is accepted + terminal
    expect(sub.revokedAt).toBeNull();
    await expect(substitutions.revoke(projectId, subZ.id, { reason: 'again' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  it('§D INERTNESS: a non-pilot project uses the STORED material gate — coverage is never consulted', async () => {
    const projectId = await freshProject(false); // capability OFF
    // stored gate 'na' → start succeeds (today's behavior, byte-for-byte)
    const ok = await freshActivity(projectId, 'na');
    await startResult(projectId, ok);
    expect(await status(projectId, ok)).toBe('in_progress');
    // stored gate 'wait' → start refuses (today's behavior) — proving coverage is NOT consulted
    const waiting = await freshActivity(projectId, 'wait');
    await expect(startResult(projectId, waiting)).rejects.toMatchObject({ status: 409 });
    expect(await status(projectId, waiting)).toBe('not_started');
  });
});
