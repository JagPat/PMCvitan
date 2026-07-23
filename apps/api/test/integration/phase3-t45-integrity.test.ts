import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { DailyLogService } from '../../src/daily-log/daily-log.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Tasks 4–5 integrity correction — the DATABASE enforces the physical-truth invariants
 * that InventoryService and DailyLogService enforce in application code. Every probe here is a
 * HOSTILE raw/ORM insert that bypasses the service; each is RED at `b0edc5a` (the write persists)
 * and GREEN after the correction (PostgreSQL rejects it). One positive probe proves the unkeyed
 * receipt path now carries a same-project source command.
 *
 *   F1  every §C ledger row cites a same-project CommandExecution (unkeyed calls included).
 *   F2  the lot's PO-line/commitment/requirement chain is coherent, its frozen §B spec copy
 *       matches the pinned spec + base UOM, and each receipt row matches its lot.
 *   F3  an orphan MaterialIssue and a mis-scoped issue movement are rejected.
 *   F4  a resolution requires a matched=false observation; a resolved one can't re-match.
 */

describe('Phase 3 Tasks 4–5 integrity correction — PostgreSQL enforces §C/§E provenance (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let vendors: VendorsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let inventory: InventoryService;
  let dailyLog: DailyLogService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "StockTransaction", "MaterialIssue", "StockLot", "MismatchResolution", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "ApprovedSubstitution", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    vendors = t.app.get(VendorsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    inventory = t.app.get(InventoryService);
    dailyLog = t.app.get(DailyLogService);
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
      ['siteMaterial', { projectId: { startsWith: 'it-p3ic-' } }],
      ['dailyLog', { projectId: { startsWith: 'it-p3ic-' } }],
      ['media', { projectId: { startsWith: 'it-p3ic-' } }],
      ['notification', { projectId: { startsWith: 'it-p3ic-' } }],
      ['activity', { projectId: { startsWith: 'it-p3ic-' } }],
      ['decision', { projectId: { startsWith: 'it-p3ic-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3ic-' } }],
      ['membership', { projectId: { startsWith: 'it-p3ic-' } }],
      ['project', { id: { startsWith: 'it-p3ic-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (orgId = f.orgA.id): Promise<string> => {
    const id = `it-p3ic-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P3IC-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  const freshMedia = async (projectId: string): Promise<string> => {
    const row = await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } });
    return row.id;
  };

  const freshCommand = async (projectId: string): Promise<string> => {
    const { orgId } = await t.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { orgId: true } });
    const c = await t.prisma.commandExecution.create({
      data: { scopeKind: 'project', organizationId: orgId, projectId, actorId: f.memberUser.id,
        commandType: 'test.seal', idempotencyKey: `seal-${Date.now() % 1e6}-${seq++}`, requestHash: 'x', status: 'succeeded' },
      select: { id: true },
    });
    return c.id;
  };

  interface Chain {
    lotId: string; poLineId: string; commitmentId: string; requirementId: string; revision: number;
    materialCategory: string; make: string; grade: string; normalizedAttributes: string; baseUom: string;
    specFingerprint: string; decisionId: string | null; decisionVersion: number | null; optionKey: string | null;
  }

  /** A full Tasks 1–4 chain to an ACCEPTED lot at 'main', returning every provenance id needed to
   *  forge against. */
  const buildChain = async (projectId: string, qty = '100'): Promise<Chain> => {
    const activityId = await freshActivity(projectId);
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty, requiredBy: '2026-08-15', criticality: 'normal',
      decisionId: null, responsibleId: null, tolerance: null,
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
      lines: [{ requisitionLineId: lineId, baseRate: '100.00', taxAmount: '50.00', freightAmount: '25.00', landedCost: '999.99', quotedMake: 'UltraTech OPC', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'ok' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    const commitment = await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-09-01' }, pmc(projectId));
    const lot = await inventory.recordReceipt(projectId, { poLineId: line.id, commitmentId: commitment.id, purchaseQty: qty }, pmc(projectId));
    const evidence = await freshMedia(projectId);
    await inventory.accept(projectId, { lotId: lot.id, qty, qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId));
    const row = await t.prisma.stockLot.findFirstOrThrow({ where: { projectId, id: lot.id } });
    return {
      lotId: lot.id, poLineId: line.id, commitmentId: commitment.id, requirementId: row.requirementId, revision: row.revision,
      materialCategory: row.materialCategory, make: row.make, grade: row.grade, normalizedAttributes: row.normalizedAttributes,
      baseUom: row.baseUom, specFingerprint: row.specFingerprint, decisionId: row.decisionId, decisionVersion: row.decisionVersion, optionKey: row.optionKey,
    };
  };

  // ── F1 — command provenance ──────────────────────────────────────────────────────────────
  it('F1 (positive): a normal UNKEYED receipt records a NON-NULL, same-project source command', async () => {
    const projectId = await freshProject();
    const c = await buildChain(projectId);
    const receipt = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId: c.lotId, type: 'receipt' } });
    expect(receipt.sourceCommandId).not.toBeNull();
    const cmd = await t.prisma.commandExecution.findUniqueOrThrow({ where: { id: receipt.sourceCommandId! } });
    expect(cmd.projectId).toBe(projectId); // same-project provenance
    expect(cmd.idempotencyKey.startsWith('srv-')).toBe(true); // server one-shot command (no client key sent)
  });

  it('F1: a §C ledger row with a NULL sourceCommandId is rejected', async () => {
    const projectId = await freshProject();
    const c = await buildChain(projectId);
    // raw insert (the ORM type now forbids null) — must fail on the NOT NULL column
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "StockTransaction" ("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","reason","recordedById")
       VALUES ('it-p3ic-null-src','${projectId}','${c.lotId}','main','adjustment',1,'acceptedOnHand',NULL,'x','${f.memberUser.id}')`,
    )).rejects.toThrow();
  });

  it('F1: a §C ledger row citing a source command in ANOTHER project is rejected', async () => {
    const projectId = await freshProject();
    const other = await freshProject(f.orgB.id);
    const c = await buildChain(projectId);
    const foreignCmd = await freshCommand(other); // command belongs to `other`
    await expect(t.prisma.stockTransaction.create({
      data: { projectId, lotId: c.lotId, storeLocation: 'main', type: 'adjustment', qty: '1', fromBucket: 'acceptedOnHand', toBucket: null, reason: 'x', recordedById: f.memberUser.id, sourceCommandId: foreignCmd },
    })).rejects.toThrow();
  });

  // ── F2 — receipt / lot provenance ────────────────────────────────────────────────────────
  it('F2.1: a stock lot with a mixed procurement chain (commitment off its PO line) is rejected', async () => {
    const projectId = await freshProject();
    const a = await buildChain(projectId);
    const b = await buildChain(projectId);
    const cmd = await freshCommand(projectId);
    // a lot on a's PO line but citing b's commitment (which is on b's PO line) — chain incoherent
    await expect(t.prisma.stockLot.create({
      data: {
        projectId, poLineId: a.poLineId, commitmentId: b.commitmentId, requirementId: a.requirementId, revision: a.revision,
        materialCategory: a.materialCategory, make: a.make, grade: a.grade, normalizedAttributes: a.normalizedAttributes,
        baseUom: a.baseUom, specFingerprint: a.specFingerprint, decisionId: a.decisionId, decisionVersion: a.decisionVersion, optionKey: a.optionKey,
        receivedById: f.memberUser.id,
      },
    })).rejects.toThrow();
    void cmd;
  });

  it('F2.1: a stock lot whose requirement pin differs from its PO line pin is rejected', async () => {
    const projectId = await freshProject();
    const a = await buildChain(projectId);
    const b = await buildChain(projectId);
    // a lot on a's PO line + a's commitment, but carrying b's requirement pin (≠ the PO line's frozen pin)
    await expect(t.prisma.stockLot.create({
      data: {
        projectId, poLineId: a.poLineId, commitmentId: a.commitmentId, requirementId: b.requirementId, revision: b.revision,
        materialCategory: a.materialCategory, make: a.make, grade: a.grade, normalizedAttributes: a.normalizedAttributes,
        baseUom: a.baseUom, specFingerprint: a.specFingerprint, decisionId: a.decisionId, decisionVersion: a.decisionVersion, optionKey: a.optionKey,
        receivedById: f.memberUser.id,
      },
    })).rejects.toThrow();
  });

  it('F2.2: a stock lot whose frozen §B spec copy is forged (fingerprint / make / UOM) is rejected', async () => {
    const projectId = await freshProject();
    const a = await buildChain(projectId);
    const forge = (over: Record<string, unknown>) => t.prisma.stockLot.create({
      data: {
        projectId, poLineId: a.poLineId, commitmentId: a.commitmentId, requirementId: a.requirementId, revision: a.revision,
        materialCategory: a.materialCategory, make: a.make, grade: a.grade, normalizedAttributes: a.normalizedAttributes,
        baseUom: a.baseUom, specFingerprint: a.specFingerprint, decisionId: a.decisionId, decisionVersion: a.decisionVersion, optionKey: a.optionKey,
        receivedById: f.memberUser.id, ...over,
      },
    });
    await expect(forge({ specFingerprint: 'forged-fingerprint' })).rejects.toThrow();
    await expect(forge({ make: 'CounterfeitCo' })).rejects.toThrow();
    await expect(forge({ baseUom: 'tonne' })).rejects.toThrow(); // UOM must match the requirement revision
  });

  it('F2.3: a receipt row whose PO-line/commitment differs from its lot is rejected', async () => {
    const projectId = await freshProject();
    const a = await buildChain(projectId);
    const b = await buildChain(projectId);
    const cmd = await freshCommand(projectId);
    // a receipt against lot a, but citing b's (real) commitment — differs from a's lot tuple
    await expect(t.prisma.stockTransaction.create({
      data: {
        projectId, lotId: a.lotId, storeLocation: 'main', type: 'receipt', qty: '1', fromBucket: null, toBucket: 'quarantine',
        poLineId: a.poLineId, commitmentId: b.commitmentId, recordedById: f.memberUser.id, sourceCommandId: cmd,
      },
    })).rejects.toThrow();
  });

  // ── F3 — issue provenance ────────────────────────────────────────────────────────────────
  it('F3.2: an orphan MaterialIssue (no canonical issue movement) is rejected at commit', async () => {
    const projectId = await freshProject();
    const a = await buildChain(projectId);
    const activityId = await freshActivity(projectId);
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.materialIssue.create({
        data: { projectId, lotId: a.lotId, storeLocation: 'main', activityId, qty: '5', issuedById: f.memberUser.id },
      });
      // no issue movement appended → the DEFERRED constraint trigger fires at COMMIT
    })).rejects.toThrow();
  });

  it('F3.3: an issue-scoped movement with a different lot/location/activity than its MaterialIssue is rejected', async () => {
    const projectId = await freshProject();
    const a = await buildChain(projectId);
    const activityId = await freshActivity(projectId);
    const issue = await inventory.issue(projectId, { lotId: a.lotId, activityId, qty: '20' }, pmc(projectId));
    const cmd = await freshCommand(projectId);
    // a consumption recorded against the issue but at a DIFFERENT store location
    await expect(t.prisma.stockTransaction.create({
      data: {
        projectId, lotId: a.lotId, storeLocation: 'elsewhere', type: 'consumption', qty: '1',
        fromBucket: 'issuedToActivity', toBucket: null, activityId, issueId: issue.id, recordedById: f.memberUser.id, sourceCommandId: cmd,
      },
    })).rejects.toThrow();
    // …and a DIFFERENT activity is likewise rejected
    const otherActivity = await freshActivity(projectId);
    await expect(t.prisma.stockTransaction.create({
      data: {
        projectId, lotId: a.lotId, storeLocation: 'main', type: 'consumption', qty: '1',
        fromBucket: 'issuedToActivity', toBucket: null, activityId: otherActivity, issueId: issue.id, recordedById: f.memberUser.id, sourceCommandId: cmd,
      },
    })).rejects.toThrow();
  });

  // ── F4 — mismatch resolution ─────────────────────────────────────────────────────────────
  it('F4: a resolution on a matched=true observation is rejected', async () => {
    const projectId = await freshProject();
    const log = await t.prisma.dailyLog.create({ data: { projectId, date: '01 Jun 2026', logDate: new Date('2026-06-01'), submitted: false, checkedIn: true, progress: 10 } });
    const mat = await t.prisma.siteMaterial.create({ data: { projectId, dailyLogId: log.id, name: 'Tiles', qty: '5 boxes', zone: 'Bath', matched: true, swatch: 'tile', order: 0 } });
    await expect(t.prisma.mismatchResolution.create({
      data: { projectId, siteMaterialId: mat.id, resolution: 'x', reason: 'y', resolvedById: f.memberUser.id },
    })).rejects.toThrow();
  });

  it('F4: a resolved observation cannot revert to matched=true', async () => {
    const projectId = await freshProject();
    const log = await t.prisma.dailyLog.create({ data: { projectId, date: '01 Jun 2026', logDate: new Date('2026-06-01'), submitted: false, checkedIn: true, progress: 10 } });
    const mat = await t.prisma.siteMaterial.create({ data: { projectId, dailyLogId: log.id, name: 'Tiles', qty: '5 boxes', zone: 'Bath', matched: false, swatch: 'tile', order: 0 } });
    await t.prisma.mismatchResolution.create({ data: { projectId, siteMaterialId: mat.id, resolution: 'returned', reason: 'wrong batch', resolvedById: f.memberUser.id } });
    await expect(t.prisma.siteMaterial.update({ where: { id: mat.id }, data: { matched: true } })).rejects.toThrow();
    // an unrelated update (matched unchanged) still succeeds — the guard is narrow
    expect((await t.prisma.siteMaterial.update({ where: { id: mat.id }, data: { zone: 'Bath 2' } })).zone).toBe('Bath 2');
  });
});
