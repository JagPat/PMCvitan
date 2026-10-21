import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CommercialBillService } from '../../src/commercial/commercial-bill.service';
import { CommercialVerificationService } from '../../src/commercial/commercial-verification.service';
import { CommercialCertificationService } from '../../src/commercial/commercial-certification.service';
import { CommercialMeasurementService } from '../../src/commercial/commercial-measurement.service';
import { CommercialDeductionService } from '../../src/commercial/commercial-deduction.service';
import { CommercialPaymentService } from '../../src/commercial/commercial-payment.service';
import { CommercialService } from '../../src/commercial/commercial.service';
import { CapabilitiesService, LABOUR_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { hashRequest } from '../../src/platform/commands';
import { lockProjectReadiness, readinessLockKey } from '../../src/common/readiness-lock';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 seen-state pins — the eight money and measure acts compared, under the lock that serializes
 * them, against the state the screen showed (`X-Vitan-Seen-State`), through HTTP.
 *
 * Reproduce-first: every refusal here fails on 00141ab, where the header is ignored and the stale
 * act commits. The acceptances fail there only on the audit row's `seenPin`, which is new; the rest
 * of each acceptance is the compatibility claim (the body and its request hash are today's, and a
 * committed act's keyed retry still replays).
 */
describe('#482 seen-state pins (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let activities: ActivitiesService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let vendors: VendorsService;
  let inventory: InventoryService;
  let labour: LabourService;
  let labourCommercial: LabourProcurementService;
  let capacity: LabourCapacityService;
  let activation: CommercialActivationService;
  let bills: CommercialBillService;
  let verification: CommercialVerificationService;
  let certification: CommercialCertificationService;
  let measurement: CommercialMeasurementService;
  let deductions: CommercialDeductionService;
  let payments: CommercialPaymentService;
  let commercial: CommercialService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const PREFIX = 'it-ssp-';
  const OPS = 'seen-state-pins-test-token-0123456789abcdef';
  const opsBefore = process.env.OPS_TOKEN;

  const RESET_TABLES = ['VendorAdvance', 'PaymentReversal', 'Payment', 'PaymentApproval',
    'BillDeductionRelease', 'BillDeduction', 'SodException', 'SodGrant',
    'CertifiedMeasurementConsumption', 'CertifiedAcceptanceConsumption', 'BillCertificate',
    'BillVerification', 'VendorBillLine', 'VendorBillVersion', 'VendorBillRevision', 'VendorBill',
    'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'ProjectionGeneration',
    'DecisionProjection', 'DailyLogProjection', 'DrawingsProjection', 'InspectionsProjection',
    'ActivitiesProjection', 'MaterialReadinessProjection', 'CashForecastProjection',
    'LabourReadinessProjection', 'Measurement', 'BudgetException', 'BudgetLine',
    'CommitmentAttribution', 'CostHead', 'LabourMismatchResolution', 'LabourMismatch',
    'ActivityWorkOutput', 'LabourWorkFact', 'WorkerAllocation', 'LabourAttendance',
    'ApprovedSkillSubstitution', 'CapacityPromise', 'CapacityCommitment',
    'LabourPurchaseOrderLine', 'LabourPurchaseOrderVersion', 'LabourPurchaseOrder',
    'LabourQuoteComparison', 'SupplierLabourQuoteLine', 'SupplierLabourQuote', 'LabourRfq',
    'LabourRequisitionLine', 'LabourRequisition', 'VendorLabourProfile', 'StockTransaction',
    'MaterialIssue', 'StockLot', 'DeliveryPromise', 'DeliveryCommitment', 'PurchaseOrderLine',
    'PurchaseOrderVersion', 'PurchaseOrder', 'VendorQuoteLine', 'QuoteComparison', 'VendorQuote',
    'Rfq', 'RequisitionLine', 'Requisition', 'ProjectPartyVendorSource',
    'ProjectPartyCompanySource', 'ProjectParty', 'ProjectVendor', 'CommandExecution',
    'CrewMembership', 'Crew', 'WorkerDevice', 'WorkerSkill', 'Worker', 'ApprovedSubstitution',
    'LabourDemandSlice', 'LabourRequirementSpec', 'LabourTrade', 'LabourSkill',
    'MaterialRequirementSpec', 'ActivityRequirement', 'ActivityRequirementRoot',
    'DecisionApprovalRevision', 'ProjectCapability',
  ] as const;

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const asUser = (projectId: string, userId: string): AuthUser => ({ sub: userId, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', projectId: '' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    activities = t.app.get(ActivitiesService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    vendors = t.app.get(VendorsService);
    inventory = t.app.get(InventoryService);
    labour = t.app.get(LabourService);
    labourCommercial = t.app.get(LabourProcurementService);
    capacity = t.app.get(LabourCapacityService);
    activation = t.app.get(CommercialActivationService);
    bills = t.app.get(CommercialBillService);
    verification = t.app.get(CommercialVerificationService);
    certification = t.app.get(CommercialCertificationService);
    measurement = t.app.get(CommercialMeasurementService);
    deductions = t.app.get(CommercialDeductionService);
    payments = t.app.get(CommercialPaymentService);
    commercial = t.app.get(CommercialService);
    capabilities = t.app.get(CapabilitiesService);
  });
  const cleanup = async () => {
    await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: PREFIX } }],
      ['media', { projectId: { startsWith: PREFIX } }],
      ['activity', { projectId: { startsWith: PREFIX } }],
      ['membership', { projectId: { startsWith: PREFIX } }],
      ['project', { id: { startsWith: PREFIX } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  };
  afterEach(async () => {
    if (opsBefore === undefined) delete process.env.OPS_TOKEN;
    else process.env.OPS_TOKEN = opsBefore;
    await cleanup();
  });
  afterAll(async () => {
    if (t) await cleanup();
    await f?.cleanup();
    await t?.close();
  });

  // ── fixtures (the 6A material chain and the Task 3 labour chain, reused) ─────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `${PREFIX}${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    await capabilities.enable(id, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(id, { code: 'mason', name: 'Mason' }, pmc(id));
    await labour.upsertSkill(id, { code: 'bar-bending', name: 'Bar Bending' }, pmc(id));
    await activation.activate(id, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }, { code: 'MEP', name: 'MEP works' }],
      materialLines: [], labourLines: [], reason: 'pilot activation',
    });
    return id;
  };

  /** A second pmc: §I keeps the certifier from approving, so approvals and grants are theirs. */
  const secondPmc = async (projectId: string): Promise<string> => {
    await t.prisma.membership.upsert({
      where: { projectId_userId: { projectId, userId: f.ownerUser.id } },
      create: { projectId, userId: f.ownerUser.id, role: 'pmc', status: 'active' },
      update: { role: 'pmc', status: 'active' },
    });
    return f.ownerUser.id;
  };
  const approver = async (projectId: string): Promise<AuthUser> => asUser(projectId, await secondPmc(projectId));

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-SSP-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  const freshMedia = async (projectId: string, kind = 'material'): Promise<string> => {
    const row = await t.prisma.media.create({ data: { projectId, kind, mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } });
    return row.id;
  };

  const boundVendor = async (projectId: string): Promise<string> => {
    const v = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    return v.id;
  };

  /** One issued, committed material PO line of `qty` at ₹1, attributed to CIVIL. */
  const issuedMaterialLine = async (projectId: string, qty = '100'): Promise<{ poLineId: string; vendorId: string; commitmentId: string }> => {
    const activityId = await freshActivity(projectId);
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
    const vendorId = await boundVendor(projectId);
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: '1', taxAmount: '0', freightAmount: '0', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }] }, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    await pos.issue(projectId, po.id, { costHeads: [{ poLineId: line.id, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const commitment = await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-09-01' }, pmc(projectId));
    return { poLineId: line.id, vendorId, commitmentId: commitment.id };
  };

  /** A certified ₹100 claim on CIVIL: received, accepted by the store user, verified, certified. */
  const certifiedClaim = async (projectId: string): Promise<{ billId: string; vendorId: string }> => {
    const line = await issuedMaterialLine(projectId);
    const lot = await inventory.recordReceipt(projectId, {
      poLineId: line.poLineId, commitmentId: line.commitmentId, storeLocation: 'main', purchaseQty: '100',
    }, pmc(projectId));
    await inventory.accept(projectId, {
      lotId: lot.id, storeLocation: 'main', qty: '100', qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId),
    }, await approver(projectId));
    const recorded = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: `V-${seq++}`, documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId));
    await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
    await bills.beginVerification(projectId, { billId: recorded.id }, pmc(projectId));
    const verdict = await verification.verify(projectId, { billId: recorded.id }, pmc(projectId));
    expect(verdict.verdict, 'the fixture must reach `verified`').toBe('matched');
    await certification.certify(projectId, { billId: recorded.id }, pmc(projectId));
    return { billId: recorded.id, vendorId: line.vendorId };
  };

  const revisionOf = async (projectId: string, billId: string): Promise<number> =>
    (await t.prisma.vendorBillRevision.findFirst({ where: { projectId, billId } }))?.revision ?? 0;

  /** A signed-off activity with recorded output and worked effort drawn from a committed labour line. */
  const measurableLine = async (projectId: string, qty = 4): Promise<{ activityId: string; poLineId: string; outputId: string }> => {
    const civilDate = '2026-08-10';
    const activityId = await freshActivity(projectId);
    const r = await requirements.create(projectId, {
      type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day',
      demandSlices: [{ civilDate, personShiftQty: qty }],
      decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any, pmc(projectId));
    const vendor = await vendors.create(f.orgA.id, { name: `Supplier ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const requisition = await labourCommercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [
      { requirementId: r.requirementId, revision: r.revision, civilDate, personShiftQty: qty },
    ] }, pmc(projectId));
    const line = requisition.lines[0]!;
    await labourCommercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await labourCommercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const rfq = await labourCommercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await labourCommercial.recordQuote(projectId, rfq.id, { vendorId: vendor.id, validUntil: '2026-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }] }, pmc(projectId));
    await labourCommercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await labourCommercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await labourCommercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparisonId = (await labourCommercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    const po = await labourCommercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: qty }] }, pmc(projectId));
    const poLine = po.currentVersion.lines.find((l) => l.requisitionLineId === line.id)!;
    await labourCommercial.issuePo(projectId, po.id, { costHeads: [{ labourPoLineId: poLine.id, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const commitment = await labourCommercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: civilDate }, pmc(projectId));
    for (let i = 0; i < qty; i += 1) {
      const w = await labour.onboardWorker(projectId, { name: `W${seq++}`, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01' }, pmc(projectId));
      const { allocations } = await capacity.allocate(projectId, {
        activityId, requirementId: r.requirementId, civilDate, workerId: w.id, capacityCommitmentId: commitment.id,
      }, pmc(projectId));
      await capacity.recordWork(projectId, { allocationId: allocations[0]!.id, workedMinutes: 720 }, pmc(projectId));
    }
    const out = await activities.recordOutput(projectId, {
      activityId, civilDate, shift: 'day', quantity: '100', uom: 'sqm', evidenceMediaId: await freshMedia(projectId, 'progress'),
    }, pmc(projectId));
    await t.prisma.activity.updateMany({ where: { id: activityId, projectId }, data: { status: 'done', doneAt: new Date() } });
    return { activityId, poLineId: poLine.id, outputId: out.id };
  };

  // ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

  const send = (projectId: string, path: string, body: object, opts: { seen?: string; key?: string } = {}) => {
    let r = request(t.app.getHttpServer())
      .post(`/projects/${projectId}/commercial/${path}`)
      .set('Authorization', `Bearer ${t.issueProjectToken(f.memberUser.id, projectId)}`);
    if (opts.key !== undefined) r = r.set('Idempotency-Key', opts.key);
    if (opts.seen !== undefined) r = r.set('X-Vitan-Seen-State', opts.seen);
    return r.send(body);
  };

  const receipts = (projectId: string, key: string) =>
    t.prisma.commandExecution.findMany({ where: { projectId, idempotencyKey: key } });

  const latestAudit = (projectId: string, action: string) =>
    t.prisma.auditLog.findFirstOrThrow({ where: { projectId, action }, orderBy: [{ at: 'desc' }, { id: 'desc' }] });

  const REVISION_MOVED = 'This claim has moved on since you read it — money on it has changed, so this act would be recorded against a claim you have not seen. Reload and try again.';
  const ADVANCE_MOVED = 'Another advance to this vendor was recorded after your screen loaded, so this one may repeat it. Reload, check the advances, and pay again if it is still needed.';
  const MEASUREMENTS_MOVED = "This line's measurements changed after your screen loaded, so this entry may repeat one already recorded. Reload and try again.";
  const ATTRIBUTION_MOVED = "This line's cost head was changed after your screen loaded. Reload and try again.";
  const UNREADABLE = "This entry's screen state could not be read. Reload and try again.";

  /**
   * One pinned act. `pin` is what the screen would send now, `move` is another person's write that
   * makes it stale, `body` is the act's request for the current state, and `rows` counts its
   * domain rows.
   */
  interface Family {
    action: string;
    path: string;
    moved: string;
    setup: (projectId: string) => Promise<{
      pin: () => Promise<string>;
      move: () => Promise<unknown>;
      body: () => Promise<object>;
      rows: () => Promise<number>;
    }>;
  }

  const claimActs = (projectId: string, billId: string) => ({
    pin: async () => String(await revisionOf(projectId, billId)),
    // a withholding committed after the screen read: it moves the revision and nothing else
    move: () => deductions.record(projectId, { billId, type: 'retention', amount: '1.00' }, pmc(projectId)),
  });

  const FAMILIES: Family[] = [
    {
      action: 'commercial.payment.record', path: 'payments/record', moved: REVISION_MOVED,
      setup: async (projectId) => {
        const { billId } = await certifiedClaim(projectId);
        const approval = await payments.approve(projectId, { billId, amount: '50.00' }, await approver(projectId));
        return {
          ...claimActs(projectId, billId),
          body: async () => ({ approvalId: approval.id, amount: '5.00', method: 'neft' }),
          rows: () => t.prisma.payment.count({ where: { projectId } }),
        };
      },
    },
    {
      action: 'commercial.payment.reverse', path: 'payments/reverse', moved: REVISION_MOVED,
      setup: async (projectId) => {
        const { billId } = await certifiedClaim(projectId);
        const approval = await payments.approve(projectId, { billId, amount: '50.00' }, await approver(projectId));
        const payment = await payments.record(projectId, { approvalId: approval.id, amount: '20.00', method: 'neft' }, pmc(projectId));
        return {
          ...claimActs(projectId, billId),
          body: async () => ({ paymentId: payment.id, amount: '1.00', reason: 'wrong account' }),
          rows: () => t.prisma.paymentReversal.count({ where: { projectId } }),
        };
      },
    },
    {
      action: 'commercial.deduction.record', path: 'deductions/record', moved: REVISION_MOVED,
      setup: async (projectId) => {
        const { billId } = await certifiedClaim(projectId);
        return {
          ...claimActs(projectId, billId),
          body: async () => ({ billId, type: 'retention', amount: '2.00' }),
          rows: () => t.prisma.billDeduction.count({ where: { projectId } }),
        };
      },
    },
    {
      action: 'commercial.deduction.release', path: 'deductions/release', moved: REVISION_MOVED,
      setup: async (projectId) => {
        const { billId } = await certifiedClaim(projectId);
        const held = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
        return {
          ...claimActs(projectId, billId),
          body: async () => ({ deductionId: held.id, amount: '1.00', reason: 'returned' }),
          rows: () => t.prisma.billDeductionRelease.count({ where: { projectId } }),
        };
      },
    },
    {
      action: 'commercial.advance.pay', path: 'advances', moved: ADVANCE_MOVED,
      setup: async (projectId) => {
        const vendorId = await boundVendor(projectId);
        return {
          pin: async () => String(await t.prisma.vendorAdvance.count({ where: { projectId, vendorId } })),
          move: () => deductions.payAdvance(projectId, { vendorId, amount: '10', reason: 'mobilisation', method: 'neft' }, pmc(projectId)),
          body: async () => ({ vendorId, amount: '25', reason: 'mobilisation', method: 'neft' }),
          rows: () => t.prisma.vendorAdvance.count({ where: { projectId } }),
        };
      },
    },
    {
      action: 'commercial.measurement.take', path: 'measurements', moved: MEASUREMENTS_MOVED,
      setup: async (projectId) => {
        const { activityId, poLineId, outputId } = await measurableLine(projectId);
        const take = { labourPoLineId: poLineId, activityId, quantity: '0.5', citedOutputId: outputId };
        return {
          pin: async () => String(await t.prisma.measurement.count({ where: { projectId, labourPoLineId: poLineId } })),
          move: () => measurement.take(projectId, take, pmc(projectId)),
          body: async () => take,
          rows: () => t.prisma.measurement.count({ where: { projectId } }),
        };
      },
    },
    {
      action: 'commercial.measurement.correct', path: 'measurements/corrections', moved: MEASUREMENTS_MOVED,
      setup: async (projectId) => {
        const { activityId, poLineId, outputId } = await measurableLine(projectId);
        const take = { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId };
        const first = await measurement.take(projectId, take, pmc(projectId));
        return {
          pin: async () => String(await t.prisma.measurement.count({ where: { projectId, labourPoLineId: poLineId } })),
          move: () => measurement.take(projectId, take, pmc(projectId)),
          body: async () => ({ measurementId: first.id, quantity: '-0.1', reason: 'over-measured' }),
          rows: () => t.prisma.measurement.count({ where: { projectId } }),
        };
      },
    },
    {
      action: 'commercial.attribution.reattribute', path: 'attributions', moved: ATTRIBUTION_MOVED,
      setup: async (projectId) => {
        const { poLineId } = await issuedMaterialLine(projectId, '10');
        const active = () => t.prisma.commitmentAttribution.findFirstOrThrow({ where: { projectId, poLineId, supersededAt: null } });
        const other = async () => ((await active()).costHeadCode === 'CIVIL' ? 'MEP' : 'CIVIL');
        return {
          pin: async () => (await active()).id,
          move: async () => commercial.reattribute(projectId, { poLineId, costHeadCode: await other(), reason: 'moved elsewhere' }, pmc(projectId)),
          body: async () => ({ poLineId, costHeadCode: await other(), reason: 'miscoded at issuance' }),
          rows: () => t.prisma.commitmentAttribution.count({ where: { projectId } }),
        };
      },
    },
  ];

  describe.each(FAMILIES)('$action', (family) => {
    it('refuses a stale pin with 409 before any write, again on a keyed retry, and a malformed one with 400', async () => {
      const projectId = await freshProject();
      const act = await family.setup(projectId);
      const seen = await act.pin();
      await act.move();
      const before = await act.rows();
      const body = await act.body();
      const key = `ssp-stale-${seq++}`;

      const refused = await send(projectId, family.path, body, { seen, key });
      expect(refused.status, refused.text).toBe(409);
      expect(refused.body.message).toBe(family.moved);
      expect(await act.rows(), 'no domain row').toBe(before);

      // the refusal is not a receipt: the same key is refused again, and still leaves nothing
      const again = await send(projectId, family.path, body, { seen, key });
      expect(again.status, again.text).toBe(409);
      expect(again.body.message).toBe(family.moved);
      expect(await act.rows()).toBe(before);
      expect(await receipts(projectId, key), 'no CommandExecution row').toEqual([]);

      const badKey = `ssp-bad-${seq++}`;
      const malformed = await send(projectId, family.path, body, { seen: 'a;b', key: badKey });
      expect(malformed.status, malformed.text).toBe(400);
      expect(malformed.body.message).toBe(UNREADABLE);
      expect(await act.rows()).toBe(before);
      expect(await receipts(projectId, badKey)).toEqual([]);
    });

    it('commits the current pin (present) and no header (absent) with today\'s body and hash, and replays a keyed retry', async () => {
      const projectId = await freshProject();
      const act = await family.setup(projectId);

      const seen = await act.pin();
      const pinnedBody = await act.body();
      const pinnedKey = `ssp-pinned-${seq++}`;
      const pinned = await send(projectId, family.path, pinnedBody, { seen, key: pinnedKey });
      expect(pinned.status, pinned.text).toBeLessThan(300);
      expect((await latestAudit(projectId, family.action)).payload).toEqual({ seenPin: 'present' });
      // G5 — the pin is not in the body, so the receipt hashes exactly today's request
      const [receipt] = await receipts(projectId, pinnedKey);
      expect(receipt?.status).toBe('succeeded');
      expect(receipt!.requestHash).toBe(hashRequest(pinnedBody));

      const plainBody = await act.body();
      const plainKey = `ssp-plain-${seq++}`;
      const plain = await send(projectId, family.path, plainBody, { key: plainKey });
      expect(plain.status, plain.text).toBeLessThan(300);
      expect((await latestAudit(projectId, family.action)).payload).toEqual({ seenPin: 'absent' });
      expect((await receipts(projectId, plainKey))[0]!.requestHash).toBe(hashRequest(plainBody));

      // the committed pinned act's retry replays before the comparison, though its pin is stale now
      const rows = await act.rows();
      const replay = await send(projectId, family.path, pinnedBody, { seen, key: pinnedKey });
      expect(replay.status, replay.text).toBeLessThan(300);
      expect(replay.body.id).toBe(pinned.body.id);
      expect(await act.rows(), 'the replay wrote nothing').toBe(rows);
    });
  });

  // ── barriers: each counts only this database's sessions, and G6's only the act's own lock ────

  // A session waiting on a ROW lock, which `pg_stat_activity` reports as `transactionid` (blocked
  // on the holder) or `tuple` (queued behind another waiter). Scoped to this database and to the
  // act's own claim-lock statement (`lockTag`: the payments' `… FROM "VendorBill" b … FOR UPDATE OF b`,
  // the deductions' `SELECT "id", "status" FROM "VendorBill" … FOR UPDATE`), so a waiter in another
  // suite's database, or the holder's own `SELECT "id" … FOR UPDATE`, never satisfies it.
  const waitForClaimLockWaiter = async (lockTag: string): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      const rows = await t.prisma.$queryRaw<Array<{ c: number }>>`
        SELECT COUNT(*)::int AS c FROM pg_stat_activity
         WHERE datname = current_database()
           AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')
           AND query LIKE ${lockTag}`;
      if (rows[0]!.c >= 1) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('barrier timeout: expected the act blocked on the claim row lock');
  };

  // Sessions waiting for THIS project's readiness lock: an ungranted advisory lock in this database
  // on the key `lockProjectReadiness` takes (a bigint lock is reported as classid = high 32 bits,
  // objid = low 32 bits), so another project's or another suite's waiter never satisfies it.
  const readinessWaiters = async (projectId: string): Promise<number> => {
    const rows = await t.prisma.$queryRaw<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM pg_locks l
       WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
         AND l.database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND ((l.classid::int8 << 32) | l.objid::int8) = hashtextextended(${readinessLockKey(projectId)}, 0)`;
    return rows[0]!.c;
  };
  const waitForReadinessWaiters = async (projectId: string, n: number): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if ((await readinessWaiters(projectId)) >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier timeout: expected ${n} readiness-lock waiter(s)`);
  };

  /** Hold the project's readiness lock, queue `sends` behind it one at a time, then let them go. */
  const queuedBehindReadiness = async <T>(projectId: string, sends: ReadonlyArray<() => Promise<T>>): Promise<T[]> => {
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (acquired = r));
    const holder = t.prisma.$transaction(
      async (tx) => { await lockProjectReadiness(tx, projectId); acquired(); await gate; },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await held;
    const queued: Promise<T>[] = [];
    for (const go of sends) {
      queued.push(go());
      await waitForReadinessWaiters(projectId, queued.length);
    }
    release();
    await holder;
    return Promise.all(queued);
  };

  // ── the same pin cannot pass twice: each committed act moves the pin it was compared with ─────

  describe.each(FAMILIES)('$action race', (family) => {
    it('two sends pinned to the same state, queued on readiness: one commits and one is refused', async () => {
      const projectId = await freshProject();
      const act = await family.setup(projectId);
      const seen = await act.pin();
      const body = await act.body();
      const before = await act.rows();

      const results = await queuedBehindReadiness(projectId, [
        () => send(projectId, family.path, body, { seen, key: `ssp-race-a-${seq++}` }).then((r) => r),
        () => send(projectId, family.path, body, { seen, key: `ssp-race-b-${seq++}` }).then((r) => r),
      ]);
      const committed = results.filter((r) => r.status < 300);
      const refused = results.filter((r) => r.status === 409);
      const answers = results.map((r) => `${r.status} ${r.text}`).join(' | ');
      expect(committed, `exactly one commits: ${answers}`).toHaveLength(1);
      expect(refused, `and the other is refused: ${answers}`).toHaveLength(1);
      expect(refused[0]!.body.message).toBe(family.moved);
      expect(await act.rows() - before, 'one domain row').toBe(1);
    });
  });

  // ── claim acts: the revision is read after the lock wait, not from the lock's own snapshot ────

  const mintCommand = async (projectId: string, commandType: string, resultRef: string): Promise<string> =>
    t.prisma.$transaction(async (tx) => {
      const c = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId: f.memberUser.id,
          commandType, idempotencyKey: `ssp-mint-${seq++}`, requestHash: 'x', status: 'reserved',
        },
        select: { id: true },
      });
      await tx.commandExecution.update({ where: { id: c.id }, data: { status: 'succeeded', resultRef, completedAt: new Date() } });
      return c.id;
    });

  const PAYMENT_CLAIM_LOCK = '%FROM "VendorBill" b%FOR UPDATE OF b%';
  const DEDUCTION_CLAIM_LOCK = '%SELECT "id", "status" FROM "VendorBill"%FOR UPDATE%';
  const G6_ACTS = [
    {
      name: 'payment record', path: 'payments/record', lockTag: PAYMENT_CLAIM_LOCK,
      setup: async (projectId: string, billId: string) => {
        const approval = await payments.approve(projectId, { billId, amount: '50.00' }, await approver(projectId));
        return { body: { approvalId: approval.id, amount: '5.00', method: 'neft' }, rows: () => t.prisma.payment.count({ where: { projectId } }) };
      },
    },
    {
      name: 'payment reverse', path: 'payments/reverse', lockTag: PAYMENT_CLAIM_LOCK,
      setup: async (projectId: string, billId: string) => {
        const approval = await payments.approve(projectId, { billId, amount: '50.00' }, await approver(projectId));
        const payment = await payments.record(projectId, { approvalId: approval.id, amount: '20.00', method: 'neft' }, pmc(projectId));
        return { body: { paymentId: payment.id, amount: '1.00', reason: 'wrong account' }, rows: () => t.prisma.paymentReversal.count({ where: { projectId } }) };
      },
    },
    {
      name: 'deduction record', path: 'deductions/record', lockTag: DEDUCTION_CLAIM_LOCK,
      setup: async (projectId: string, billId: string) =>
        // counts only the act's own 2.00 withholding: the holder's 1.00 is the one that moves the revision
        ({ body: { billId, type: 'retention', amount: '2.00' }, rows: () => t.prisma.billDeduction.count({ where: { projectId, amount: '2.00' } }) }),
    },
    {
      name: 'deduction release', path: 'deductions/release', lockTag: DEDUCTION_CLAIM_LOCK,
      setup: async (projectId: string, billId: string) => {
        const held = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
        return { body: { deductionId: held.id, amount: '1.00', reason: 'returned' }, rows: () => t.prisma.billDeductionRelease.count({ where: { projectId } }) };
      },
    },
  ];

  it.each(G6_ACTS)('G6 ($name): a withholding committed while the act waited on the claim row refuses the act pinned before it', async ({ path, lockTag, setup }) => {
    const projectId = await freshProject();
    const { billId } = await certifiedClaim(projectId);
    const act = await setup(projectId, billId);
    const seen = String(await revisionOf(projectId, billId));
    const before = await act.rows();
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const deductionId = `ssp-g6-${seq++}`;
    const commandId = await mintCommand(projectId, 'commercial.deduction.record', deductionId);

    const gate = new PrismaClient();
    try {
      let release!: () => void; let staged!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const ready = new Promise<void>((r) => { staged = r; });
      // the holder takes ONLY the claim row — never readiness — so the act queues on that row
      const holder = gate.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT "id" FROM "VendorBill" WHERE "projectId"=$1 AND "id"=$2 FOR UPDATE', projectId, billId);
        await tx.$executeRawUnsafe(
          `INSERT INTO "BillDeduction"("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
           VALUES ($1,$2,$3,$4,'retention',1.00,$5,$6)`,
          deductionId, projectId, cert.id, billId, f.memberUser.id, commandId,
        );
        staged();
        await held;
      }, { timeout: 30_000 });
      await ready;

      const acting = send(projectId, path, act.body, { seen, key: `ssp-g6-act-${seq++}` }).then((r) => r);
      await waitForClaimLockWaiter(lockTag);
      release();
      await holder;

      const r = await acting;
      expect(r.status, r.text).toBe(409);
      expect(r.body.message).toBe(REVISION_MOVED);
      expect(await act.rows()).toBe(before);
      expect(await revisionOf(projectId, billId), 'the holder moved the revision').toBe(Number(seen) + 1);
    } finally {
      await gate.$disconnect();
    }
  });

  // ── payAdvance: the count is per vendor ─────────────────────────────────────────────────────

  it('payAdvance: two concurrent advances pinned to the same count, one commits and one is refused; another vendor is not', async () => {
    const projectId = await freshProject();
    const vendorId = await boundVendor(projectId);
    const otherVendorId = await boundVendor(projectId);
    const body = { vendorId, amount: '25', reason: 'mobilisation', method: 'neft' };

    const [a, b] = await queuedBehindReadiness(projectId, [
      () => send(projectId, 'advances', body, { seen: '0', key: `ssp-adv-a-${seq++}` }).then((r) => r),
      () => send(projectId, 'advances', body, { seen: '0', key: `ssp-adv-b-${seq++}` }).then((r) => r),
    ]);
    // granted in queue order, so the first commits
    expect(a!.status, a!.text).toBeLessThan(300);
    expect(b!.status, b!.text).toBe(409);
    expect(b!.body.message).toBe(ADVANCE_MOVED);
    expect(await t.prisma.vendorAdvance.count({ where: { projectId, vendorId } })).toBe(1);

    // the count is per vendor: the other vendor's screen read zero, and zero is still true
    const other = await send(projectId, 'advances', { ...body, vendorId: otherVendorId }, { seen: '0' });
    expect(other.status, other.text).toBeLessThan(300);
    expect(await t.prisma.vendorAdvance.count({ where: { projectId, vendorId: otherVendorId } })).toBe(1);
  });

  // ── grantSodException: a duplicate is a fact, not a retry ───────────────────────────────────

  it('grantSodException: a second identical live grant gets a 409 that says it already stands', async () => {
    const projectId = await freshProject();
    const { billId } = await certifiedClaim(projectId);
    const other = await secondPmc(projectId);
    // the certification rule: the payment rule's duplicate is refused earlier, by `liveGrantStands`
    const grant = { billId, actorId: f.memberUser.id, reason: 'only pmc on site this week', rule: 'evidence-recorder-may-not-certify' as const };
    await certification.grantSodException(projectId, grant, asUser(projectId, other));
    await expect(certification.grantSodException(projectId, grant, asUser(projectId, other)))
      .rejects.toMatchObject({ status: 409, message: 'An exception for this person on this claim already stands. Reload to see it.' });
    expect(await t.prisma.sodGrant.count({ where: { projectId, consumedAt: null, retiredAt: null } })).toBe(1);
  });

  // ── the ops read that decides when the pin can be required ──────────────────────────────────

  it('GET /ops/compat/state-pins counts pinned and absent per action, with zeros, and refuses a bad `since`', async () => {
    process.env.OPS_TOKEN = OPS;
    const ops = (query: string) => request(t.app.getHttpServer()).get(`/ops/compat/state-pins${query}`).set('Authorization', `Bearer ${OPS}`);
    const [{ now }] = await t.prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;

    const projectId = await freshProject();
    const vendorId = await boundVendor(projectId);
    const body = { vendorId, amount: '25', reason: 'mobilisation', method: 'neft' };
    expect((await send(projectId, 'advances', body, { seen: '0' })).status).toBeLessThan(300);
    expect((await send(projectId, 'advances', body)).status).toBeLessThan(300);
    expect((await send(projectId, 'advances', body)).status).toBeLessThan(300);

    const r = await ops(`?since=${encodeURIComponent(now.toISOString())}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.since).toBe(now.toISOString());
    const actions = r.body.actions as Array<{ action: string; pinned: number; absent: number; lastPinned: string | null; lastAbsent: string | null }>;
    expect(actions.map((a) => a.action), 'all eight, zeros listed').toEqual(FAMILIES.map((fam) => fam.action));
    const advance = actions.find((a) => a.action === 'commercial.advance.pay')!;
    expect(advance).toMatchObject({ pinned: 1, absent: 2 });
    expect(advance.lastPinned).not.toBeNull();
    expect(advance.lastAbsent).not.toBeNull();
    for (const a of actions.filter((x) => x.action !== 'commercial.advance.pay')) {
      expect(a, a.action).toEqual({ action: a.action, pinned: 0, absent: 0, lastPinned: null, lastAbsent: null });
    }

    // a window that starts after the acts counts none of them
    const later = await ops(`?since=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
    expect(later.body.actions.find((a: { action: string }) => a.action === 'commercial.advance.pay')).toMatchObject({ pinned: 0, absent: 0 });

    expect((await ops('')).status).toBe(400);
    expect((await ops('?since=yesterday')).status).toBe(400);
    expect((await ops(`?since=${encodeURIComponent(now.toISOString())}&extra=1`)).status).toBe(400);
  });

  it('GET /ops/compat/state-pins is closed without the token', async () => {
    const since = encodeURIComponent(new Date().toISOString());
    delete process.env.OPS_TOKEN;
    expect((await request(t.app.getHttpServer()).get(`/ops/compat/state-pins?since=${since}`).set('Authorization', `Bearer ${OPS}`)).status).toBe(404);
    process.env.OPS_TOKEN = OPS;
    expect((await request(t.app.getHttpServer()).get(`/ops/compat/state-pins?since=${since}`)).status).toBe(401);
    const jwt = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    expect((await request(t.app.getHttpServer()).get(`/ops/compat/state-pins?since=${since}`).set('Authorization', `Bearer ${jwt}`)).status).toBe(401);
  });

  it('GET /ops/compat/state-pins checks the token before the limit: calls without it never spend the operator\'s', async () => {
    const since = encodeURIComponent(new Date().toISOString());
    process.env.OPS_TOKEN = OPS;
    // one more than the route's limit of 30 a minute; behind the limiter the last would be 429
    for (let i = 0; i < 31; i++) {
      expect((await request(t.app.getHttpServer()).get(`/ops/compat/state-pins?since=${since}`)).status, `call ${i + 1}`).toBe(401);
    }
    expect((await request(t.app.getHttpServer()).get(`/ops/compat/state-pins?since=${since}`).set('Authorization', `Bearer ${OPS}`)).status).toBe(200);
  });
});
