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
 * Phase 3 Task 6 — the §A BOTH-ORDERING concurrency races vs `activities.start` (live PG). Every
 * coverage-affecting §A command serializes against start on the per-project readiness lock: start
 * evaluates canonical coverage IN its locked transaction, so a racing write lands strictly BEFORE
 * (start refuses) or strictly AFTER (it waits for start's commit) — never torn inside the window.
 *
 * Pairs (the plan's §A set): reservation release · audited stock adjustment · requirement revision ·
 * substitution revocation · issue — each vs start.
 */
describe('Phase 3 Task 6 — §A both-ordering races vs activities.start (live PG)', () => {
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
  let origLoadReadiness: ActivitiesService['loadReadiness'];
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "MaterialReadinessProjection", "ActivitiesProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';
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
    origLoadReadiness = activities.loadReadiness.bind(activities);
  });
  afterEach(async () => {
    activities.loadReadiness = origLoadReadiness;
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    for (const [model, where] of [
      ['media', { projectId: { startsWith: 'it-p3rc-' } }],
      ['activity', { projectId: { startsWith: 'it-p3rc-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3rc-' } }],
      ['membership', { projectId: { startsWith: 'it-p3rc-' } }],
      ['project', { id: { startsWith: 'it-p3rc-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-p3rc-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P3RC-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Z', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const media = async (projectId: string): Promise<string> => (await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } })).id;

  const SPEC_A = { materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53' };
  const SPEC_B = { materialCategory: 'Cement', make: 'ACC', grade: 'OPC 53' };
  const addReq = async (projectId: string, activityId: string, qty = '100', spec = SPEC_A) => {
    const input: CreateRequirementInput = { activityId, ...spec, attributes: 'grey', baseUom: 'bag', qty, requiredBy: '2026-08-15', criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null };
    const r = await requirements.create(projectId, input, pmc(projectId));
    return { requirementId: r.requirementId, revision: r.revision };
  };
  /** issued PO + commitment on a requirement, received + accepted to `main`; returns the lot id. */
  const acceptedLot = async (projectId: string, req: { requirementId: string; revision: number }): Promise<string> => {
    const created = await procurement.createRequisition(projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '100' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendor = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const withQuote = await procurement.recordQuote(projectId, rfq.id, { vendorId: vendor.id, validUntil: '2027-01-01', lines: [{ requisitionLineId: lineId, baseRate: '100.00', taxAmount: '50.00', freightAmount: '25.00', landedCost: '999.99', quotedMake: 'm', matchesSpecification: true }] }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'ok' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: '100' }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    const commitment = await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-09-01' }, pmc(projectId));
    const lot = await inventory.recordReceipt(projectId, { poLineId: line.id, commitmentId: commitment.id, purchaseQty: '100' }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, qty: '100', qualityResult: 'passed', evidenceMediaId: await media(projectId) }, pmc(projectId));
    return lot.id;
  };

  /** Park start at its readiness evaluation (AFTER it has taken the readiness lock) until released. */
  function holdAtReadiness() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const held = new Promise<void>((r) => (arrived = r));
    activities.loadReadiness = async (...args: Parameters<ActivitiesService['loadReadiness']>) => {
      arrived();
      await gate;
      return origLoadReadiness(...args);
    };
    return { held, release };
  }
  const settledWithin = (p: Promise<unknown>, ms: number): Promise<'settled' | 'pending'> =>
    Promise.race([p.then(() => 'settled' as const, () => 'settled' as const), new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
  const status = async (projectId: string, activityId: string) => (await t.prisma.activity.findUniqueOrThrow({ where: { id: activityId }, select: { status: true } })).status;

  /**
   * Drive ONE §A race pair. `arm(projectId)` returns a READY activity + the racing write thunk;
   * `flips` says whether the write turns the activity un-startable (so the write-first ordering
   * refuses start) — an issue does NOT flip (issued counts as coverage).
   */
  async function racePair(name: string, arm: (projectId: string) => Promise<{ activityId: string; write: () => Promise<unknown> }>, flips: boolean) {
    // ordering 1 — the write races INTO start's locked window: it blocks on the readiness lock
    const p1 = await freshProject();
    const armed1 = await arm(p1);
    const { held, release } = holdAtReadiness();
    const startReq = Promise.resolve(activities.start(p1, armed1.activityId, pmc(p1)));
    await held; // start holds the readiness lock, parked at its coverage evaluation
    const writeReq = Promise.resolve(armed1.write());
    expect(await settledWithin(writeReq, 400), `${name}: the §A write must WAIT for start's locked window`).toBe('pending');
    release();
    await expect(startReq).resolves.toBeDefined(); // start held the slot first — it wins
    await writeReq; // ...and the write lands strictly AFTER start's commit
    expect(await status(p1, armed1.activityId)).toBe('in_progress');
    activities.loadReadiness = origLoadReadiness;

    // ordering 2 — the write commits FIRST; start then observes it
    const p2 = await freshProject();
    const armed2 = await arm(p2);
    await armed2.write();
    if (flips) {
      await expect(activities.start(p2, armed2.activityId, pmc(p2)), `${name}: a write committed before start must refuse it`).rejects.toMatchObject({ status: 409 });
      expect(await status(p2, armed2.activityId)).toBe('not_started');
    } else {
      await activities.start(p2, armed2.activityId, pmc(p2)); // issue does not un-ready the activity
      expect(await status(p2, armed2.activityId)).toBe('in_progress');
    }
  }

  it('reservation release vs start', async () => {
    await racePair('reservation release', async (projectId) => {
      const activityId = await freshActivity(projectId);
      const req = await addReq(projectId, activityId, '100');
      const lotId = await acceptedLot(projectId, req);
      await inventory.reserve(projectId, { lotId, activityId, qty: '100' }, pmc(projectId));
      return { activityId, write: () => inventory.release(projectId, { lotId, activityId, qty: '100' }, pmc(projectId)) };
    }, true);
  });

  it('audited stock adjustment vs start', async () => {
    await racePair('stock adjustment', async (projectId) => {
      const activityId = await freshActivity(projectId);
      const req = await addReq(projectId, activityId, '100');
      const lotId = await acceptedLot(projectId, req);
      await inventory.reserve(projectId, { lotId, activityId, qty: '100' }, pmc(projectId));
      // a valid reasoned write-ON (adds fresh accepted stock) — does not touch the activity's reserved
      // coverage, so this pair proves SERIALIZATION (the adjustment waits for start's lock); it never flips.
      return { activityId, write: () => inventory.adjust(projectId, { lotId, qty: '10', toBucket: 'acceptedOnHand', reason: 'cycle-count correction' }, pmc(projectId)) };
    }, false);
  });

  it('requirement revision vs start', async () => {
    await racePair('requirement revision', async (projectId) => {
      const activityId = await freshActivity(projectId);
      const req = await addReq(projectId, activityId, '100');
      const lotId = await acceptedLot(projectId, req);
      await inventory.reserve(projectId, { lotId, activityId, qty: '100' }, pmc(projectId));
      // revise the demand UP to 200 — the head revision now needs 200 vs 100 reserved → shortfall
      return {
        activityId,
        write: () => requirements.revise(projectId, req.requirementId, { activityId, ...SPEC_A, attributes: 'grey', baseUom: 'bag', qty: '200', requiredBy: '2026-08-15', criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null, expectedRevision: req.revision }, pmc(projectId)),
      };
    }, true);
  });

  it('substitution revocation vs start', async () => {
    await racePair('substitution revocation', async (projectId) => {
      const activityId = await freshActivity(projectId);
      const reqA = await addReq(projectId, activityId, '100', SPEC_A);
      // spec-B stock reserved for the activity; a substitution A→B makes it acceptable (ready)
      const other = await freshActivity(projectId);
      const reqB = await addReq(projectId, other, '100', SPEC_B);
      const lotB = await acceptedLot(projectId, reqB);
      await inventory.reserve(projectId, { lotId: lotB, activityId, qty: '100' }, pmc(projectId));
      const sub = await substitutions.approve(projectId, reqA.requirementId, { ...SPEC_B, attributes: 'grey', baseUom: 'bag', reason: 'equivalent' }, pmc(projectId));
      return { activityId, write: () => substitutions.revoke(projectId, sub.id, { reason: 'withdrawn' }, pmc(projectId)) };
    }, true);
  });

  it('issue vs start (issued stock still counts as coverage — never un-readies)', async () => {
    await racePair('issue', async (projectId) => {
      const activityId = await freshActivity(projectId);
      const req = await addReq(projectId, activityId, '100');
      const lotId = await acceptedLot(projectId, req);
      await inventory.reserve(projectId, { lotId, activityId, qty: '100' }, pmc(projectId));
      return { activityId, write: () => inventory.issue(projectId, { lotId, activityId, qty: '100' }, pmc(projectId)) };
    }, false);
  });
});
