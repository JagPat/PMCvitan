import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CapabilitiesService, LABOUR_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

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
 * PO-line lock is taken at COMMIT — LAST, after whatever authority lock the command already holds.
 * The other side never takes an explicit PO-line lock: inserting a row whose FOREIGN KEY references
 * the line makes PostgreSQL take `FOR KEY SHARE` on it INLINE, and that transaction then reaches
 * its own authority check and waits for the membership row the first one holds. `FOR UPDATE`
 * conflicts with `FOR KEY SHARE`, and the cycle closes.
 *
 * PROBE 1 is the fix: a `FOR KEY SHARE` holder must NOT block the bound check.
 * PROBES 2 and 3 are the invariant the lock is actually there for — the Phase-4 T3 F3 lesson, in
 * the function's own words, that "two sessions that each counted a fold nobody was holding would
 * both pass and both commit". A fix that removed the false conflict AND the real ones would pass
 * probe 1 and be wrong, so the preserved conflicts are asserted, not assumed.
 * There is deliberately NO terminal bound-1 probe here, and that is a decision rather than an
 * omission. Round 1 added one (Codex #345 F2) and round 2 showed it was testing the wrong thing
 * twice over: with no acceptance seeded, ACCEPTED is 0 and each claim is disputed by the
 * over-ACCEPTED branch, never by the ordered bound it claimed to exercise; and the concurrent
 * interleaving it purported to drive CANNOT OCCUR, because `CommercialBillService.transition()`
 * takes `lockProjectReadiness` as its first act and serializes two same-project submissions long
 * before either reaches the check. Bound 1 is not what this change touches — the LOCK MODE is —
 * and bound 1 already has rigorous, DATABASE-level coverage in its owning suite:
 * `phase5-t4-vendor-bill.test.ts` PROBE 5h (it bites on ordered quantity, in units not rupees)
 * and its bound-1 seal probe (forcing past every service guard aborts at COMMIT naming bound 1,
 * with the paired disposition proving a legitimate withdrawal still commits). Restating that here
 * would add a second, weaker statement of a rule that already has a canonical one.
 *
 * EVERY probe runs on BOTH lock branches (Codex #345 F3). The migration rewrote the clause on
 * `PurchaseOrderLine` AND on `LabourPurchaseOrderLine`; a suite that only ever passed `p_material`
 * would stay green with the labour clause left at `FOR UPDATE` — the same deadlock, untested.
 *
 * Blocking is established by OBSERVING the waiting session in `pg_stat_activity`, and the holder
 * signals a REAL ACQUISITION BARRIER — a promise resolved after its lock statement returns —
 * rather than a fixed delay (Codex #345 F1). A 250 ms sleep does not prove the holder got there
 * first: on a loaded runner the racing session can run first, see nothing blocked, and let probe 1
 * pass against the very `FOR UPDATE` it exists to catch. A probe that cannot prove its own
 * experiment ran is not evidence (the Phase-4 T1 correction-4 lesson).
 */
describe('commercial deadlock — the §G bound check takes one lock order (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let vendors: VendorsService;
  let labour: LabourService;
  let labourCommercial: LabourProcurementService;
  let activation: CommercialActivationService;
  let capabilities: CapabilitiesService;
  let raceDb: PrismaClient;
  let seq = 0;

  const RESET_TABLES = ['VendorAdvance', 'PaymentReversal', 'Payment', 'PaymentApproval',
    'BillDeductionRelease', 'BillDeduction', 'SodException', 'SodGrant',
    'CertifiedMeasurementConsumption', 'CertifiedAcceptanceConsumption', 'BillCertificate',
    'BillVerification', 'VendorBillLine', 'VendorBillVersion', 'VendorBillRevision',
    'VendorBill', 'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
    'ProjectionGeneration', 'DecisionProjection', 'DailyLogProjection', 'DrawingsProjection',
    'InspectionsProjection', 'ActivitiesProjection', 'MaterialReadinessProjection',
    'CashForecastProjection', 'LabourReadinessProjection', 'Measurement', 'BudgetException',
    'BudgetLine', 'CommitmentAttribution', 'CostHead', 'LabourMismatchResolution',
    'LabourMismatch', 'ActivityWorkOutput', 'LabourWorkFact', 'WorkerAllocation',
    'LabourAttendance', 'ApprovedSkillSubstitution', 'CapacityPromise', 'CapacityCommitment',
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
    'DecisionApprovalRevision', 'ProjectCapability'
  ] as const;

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', orgId: f.orgA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    vendors = t.app.get(VendorsService);
    labour = t.app.get(LabourService);
    labourCommercial = t.app.get(LabourProcurementService);
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
    await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
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

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-CDL-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  /** One ISSUED MATERIAL PO line — the row the material arm of the bound check locks. */
  const issuedMaterialLine = async (projectId: string, qty = '100'): Promise<{ poLineId: string; vendorId: string }> => {
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
    return { poLineId: line.id, vendorId: v.id };
  };

  /**
   * One ISSUED LABOUR PO line — the row the LABOUR arm locks. F3: the migration rewrote this arm
   * too, so it gets the same three probes rather than being taken on trust.
   */
  const issuedLabourLine = async (projectId: string, orderedQty = 4): Promise<{ poLineId: string; vendorId: string }> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
    const activityId = await freshActivity(projectId);
    const civilDate = '2026-08-10';
    const req = await requirements.create(projectId, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day',
      demandSlices: [{ civilDate, personShiftQty: orderedQty }],
      decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null,
    } as any, pmc(projectId));
    const vendor = await vendors.create(f.orgA.id, { name: `Supplier ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const requisition = await labourCommercial.createRequisition(projectId, {
      title: `req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate, personShiftQty: orderedQty }],
    }, pmc(projectId));
    const line = requisition.lines[0]!;
    await labourCommercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await labourCommercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const rfq = await labourCommercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await labourCommercial.recordQuote(projectId, rfq.id, { vendorId: vendor.id, validUntil: '2026-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }] }, pmc(projectId));
    await labourCommercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await labourCommercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await labourCommercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparisonId = (await labourCommercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    const po = await labourCommercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: orderedQty }] }, pmc(projectId));
    const poLine = po.currentVersion.lines[0]!;
    await labourCommercial.issuePo(projectId, po.id, { costHeads: [{ labourPoLineId: poLine.id, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    return { poLineId: poLine.id, vendorId: vendor.id };
  };

  /**
   * F1 — a REAL acquisition barrier. `ready` resolves only after the lock statement has RETURNED,
   * so the racing session cannot be started before the holder actually holds. This replaces a fixed
   * delay, which proves nothing about ordering on a loaded runner.
   */
  interface Held { ready: Promise<void>; release: () => void; done: Promise<void> }
  const holdInTx = (sql: (tx: Prisma.TransactionClient) => Promise<unknown>): Held => {
    let signalReady!: () => void;
    let signalFailed!: (e: unknown) => void;
    let release!: () => void;
    const ready = new Promise<void>((res, rej) => { signalReady = res; signalFailed = rej; });
    const held = new Promise<void>((r) => { release = r; });
    const done = t.prisma.$transaction(async (tx) => {
      try { await sql(tx); } catch (e) { signalFailed(e); throw e; }
      signalReady();
      await held;
    }, { timeout: 30_000 }).then(() => undefined, (e) => { signalFailed(e); throw e; });
    return { ready, release, done };
  };

  /** Wait until a dispatched racing check has SETTLED (either way), or the window closes. */
  const settlesWithin = async (race: { state: () => string }, ms: number): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (race.state() !== 'pending') return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };

  /** Wait until `raceDb`'s tagged session is actually WAITING on a lock. */
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
   * Run the bound check on `raceDb`, tagged so this suite can find it in `pg_stat_activity`. The
   * promise is DISPATCHED here — a Prisma raw promise is lazy, and an undispatched one starts
   * nothing at all.
   */
  const boundCheckOnRace = (projectId: string, material: string | null, labourLine: string | null, marker: string) => {
    let settled: 'pending' | 'ok' | 'error' = 'pending';
    const promise = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SELECT phase5_t4_billed_bound_check($1, $2, $3) /* ${marker} */`,
        projectId, material, labourLine,
      );
    }).then(() => { settled = 'ok'; }, () => { settled = 'error'; });
    return { promise, state: () => settled };
  };

  // F3 — every probe runs on BOTH arms the migration rewrote.
  const BRANCHES = [
    {
      name: 'material',
      table: 'PurchaseOrderLine',
      make: (projectId: string) => issuedMaterialLine(projectId),
      args: (id: string): [string | null, string | null] => [id, null],
      // a NON-KEY column an ordinary UPDATE may touch (takes FOR NO KEY UPDATE)
      mutable: 'approvedOverage',
    },
    {
      name: 'labour',
      table: 'LabourPurchaseOrderLine',
      make: (projectId: string) => issuedLabourLine(projectId),
      args: (id: string): [string | null, string | null] => [null, id],
      // schema comment: "person-shifts committed (progress; the ONE mutable column)"
      mutable: 'committedQty',
    },
  ] as const;

  for (const branch of BRANCHES) {
    describe(`${branch.name} arm (${branch.table})`, () => {
      it('PROBE 1 (the fix): a FOR KEY SHARE holder — what an FK-referencing INSERT takes — does NOT block the bound check', async () => {
        const projectId = await freshProject();
        const { poLineId } = await branch.make(projectId);
        const marker = `cdl-p1-${branch.name}-${seq++}`;

        // exactly the lock PostgreSQL takes when a row whose FK references this line is inserted
        const holder = holdInTx((tx) => tx.$executeRawUnsafe(
          `SELECT 1 FROM "${branch.table}" WHERE "projectId" = $1 AND "id" = $2 FOR KEY SHARE`,
          projectId, poLineId,
        ));
        await holder.ready;

        const [m, l] = branch.args(poLineId);
        const race = boundCheckOnRace(projectId, m, l, marker);

        // POSITIVE proof, required while the holder STILL HOLDS (round 2, Codex R2-1). Asserting
        // "no lock wait was observed" is not proof of anything: if the racing session had not yet
        // reached PostgreSQL when the polling window closed, nothing was observed either — and
        // releasing the holder first lets even the original `FOR UPDATE` query succeed, so both
        // assertions pass against the very bug this probe exists to catch. Demanding COMPLETION
        // under the held lock cannot pass that way: at `8175c3e` the check blocks on the KEY SHARE
        // holder and never settles inside the window.
        const settled = await settlesWithin(race, 8000);
        expect(settled, 'the bound check must COMPLETE while a FOR KEY SHARE holder still holds it')
          .toBe(true);
        expect(race.state()).toBe('ok');
        // …and it got there without ever waiting on a lock — the same fact from the other side.
        expect(await blocksWithin(marker, 250)).toBe(false);

        holder.release();
        await holder.done;
        await race.promise;
      });

      it('PROBE 2 (invariant kept): two concurrent bound checks STILL serialize', async () => {
        const projectId = await freshProject();
        const { poLineId } = await branch.make(projectId);
        const marker = `cdl-p2-${branch.name}-${seq++}`;
        const [m, l] = branch.args(poLineId);

        const holder = holdInTx((tx) => tx.$executeRawUnsafe(
          `SELECT phase5_t4_billed_bound_check($1, $2, $3)`, projectId, m, l,
        ));
        await holder.ready;

        const race = boundCheckOnRace(projectId, m, l, marker);
        const blocked = await blocksWithin(marker, 4000);

        // the Phase-4 T3 F3 lesson: the check must not count a fold nobody is holding
        expect(blocked).toBe(true);

        holder.release();
        await holder.done;
        await race.promise;
        expect(race.state()).toBe('ok');
      });

      it('PROBE 3 (invariant kept): a concurrent UPDATE of the constraining quantity STILL serializes', async () => {
        const projectId = await freshProject();
        const { poLineId } = await branch.make(projectId);
        const marker = `cdl-p3-${branch.name}-${seq++}`;
        const [m, l] = branch.args(poLineId);

        // An ordinary UPDATE of a NON-KEY column takes FOR NO KEY UPDATE — exactly the lock the
        // bound check now takes — so the number cannot move underneath it.
        const holder = holdInTx((tx) => tx.$executeRawUnsafe(
          `UPDATE "${branch.table}" SET "${branch.mutable}" = "${branch.mutable}" WHERE "projectId" = $1 AND "id" = $2`,
          projectId, poLineId,
        ));
        await holder.ready;

        const race = boundCheckOnRace(projectId, m, l, marker);
        const blocked = await blocksWithin(marker, 4000);

        expect(blocked).toBe(true);

        holder.release();
        await holder.done;
        await race.promise;
        expect(race.state()).toBe('ok');
      });
    });
  }

});
