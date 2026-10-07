import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CommercialBudgetService } from '../../src/commercial/commercial-budget.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { COMMERCIAL_MONEY_EVENT } from '../../src/commercial/cash-forecast.projection';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A2 — the commercial attribution seam carries the acting role to the
 * `commercial.money_moved` envelope (§A.3 obligation 7, P37's seam arms before the trailing seal).
 *
 * `AttributionActor` IS the kernel's `EventActor` now, and every human lifecycle site passes the
 * resolved `Actor` it holds, so the compiler is the tripwire for a site that hands the seam less.
 * This pins the runtime half across the seam: a PO issue on a commercial-enabled project announces
 * money several frames below the command body, and the envelope still names the actor's role and
 * the account name read in the transaction. §L activation is a SYSTEM-kind operator process: since
 * 4d-iii / R0c its announcement carries the SYSTEM pair naming the automation (`system`,
 * `commercial-activation`), with the operator's id as `systemActor`.
 */
describe('4d-ii-a / A2 — the commercial seam carries the envelope pair (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let vendors: VendorsService;
  let activation: CommercialActivationService;
  let budget: CommercialBudgetService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const RESET_TABLES = ['BudgetException', 'BudgetLine', 'CommitmentAttribution', 'CostHead',
    'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
    'ProjectionGeneration', 'CashForecastProjection', 'DeliveryPromise', 'DeliveryCommitment',
    'PurchaseOrderLine', 'PurchaseOrderVersion', 'PurchaseOrder', 'VendorQuoteLine',
    'VendorQuote', 'QuoteComparison', 'Rfq', 'RequisitionLine', 'Requisition',
    'ProjectPartyVendorSource', 'ProjectPartyCompanySource', 'ProjectParty', 'ProjectVendor',
    'CommandExecution', 'MaterialRequirementSpec', 'ActivityRequirement',
    'ActivityRequirementRoot', 'ProjectCapability'
  ] as const;

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', orgId: f.orgA.id }) as AuthUser;

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-a2seam-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-A2SEAM-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableCommercial = (projectId: string) =>
    activation.activate(projectId, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [], reason: 'pilot activation',
    });

  /** requirement → approved comparison → DRAFT material PO. The shortest path to a command that
   *  attributes a commitment, which is what makes the participant announce money on a FOREIGN
   *  command's transaction. */
  const draftPo = async (projectId: string, activityId: string): Promise<{ poId: string; poLineId: string }> => {
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty: '100', requiredBy: '2026-08-15', criticality: 'normal', decisionId: null,
      responsibleId: null, tolerance: null,
    };
    const req = await requirements.create(projectId, input, pmc(projectId));
    const created = await procurement.createRequisition(projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '100' }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendor = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: vendor.id, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: '1', taxAmount: '0', freightAmount: '0', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: '100' }] }, pmc(projectId));
    const poLine = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    return { poId: po.id, poLineId: poLine.id };
  };


  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    vendors = t.app.get(VendorsService);
    activation = t.app.get(CommercialActivationService);
    budget = t.app.get(CommercialBudgetService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, RESET_TABLES, { cascade: true });
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-a2seam-' } }],
      ['activity', { projectId: { startsWith: 'it-a2seam-' } }],
      ['membership', { projectId: { startsWith: 'it-a2seam-' } }],
      ['project', { id: { startsWith: 'it-a2seam-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  /** The envelopes of the project's money announcements, optionally narrowed to one `reason`. */
  const moneyEnvelopes = (projectId: string, reason?: string) => t.prisma.domainEvent.findMany({
    where: { projectId, eventType: COMMERCIAL_MONEY_EVENT, ...(reason ? { payload: { path: ['reason'], equals: reason } } : {}) },
    select: { actorId: true, actorKind: true, actorRole: true, actorName: true },
    orderBy: { streamPosition: 'asc' },
  });
  const identityName = async (userId: string) =>
    (await t.prisma.$queryRawUnsafe<Array<{ displayName: string }>>(
      `SELECT "displayName" FROM "UserIdentity" WHERE "userId" = $1`, userId,
    ))[0]!.displayName;

  it('a PO issue announces money with the issuer\'s role and account name, through the participant seam', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    const { poId, poLineId } = await draftPo(projectId, activityId);

    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId), `iss-${seq++}`);

    const envelopes = await moneyEnvelopes(projectId, 'commitment');
    expect(envelopes.length, 'issuing an attributed PO moved headroom').toBeGreaterThan(0);
    const name = await identityName(f.memberUser.id);
    for (const e of envelopes) {
      expect(e).toEqual({ actorId: f.memberUser.id, actorKind: 'human', actorRole: 'pmc', actorName: name });
    }
  });

  it('a budget revision (a commercial service site) carries the pair too', async () => {
    const projectId = await freshProject();
    await enableCommercial(projectId);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500', reason: 'sanctioned' }, pmc(projectId), `bud-${seq++}`);
    const envelopes = await moneyEnvelopes(projectId, 'budget_revision');
    expect(envelopes.length).toBeGreaterThan(0);
    for (const e of envelopes) expect(e).toMatchObject({ actorRole: 'pmc', actorName: await identityName(f.memberUser.id) });
  });

  it('§L activation is a system-kind operator process: its announcements carry the system pair naming the automation (4d-iii / R0c)', async () => {
    const projectId = await freshProject();
    await enableCommercial(projectId);
    const envelopes = await t.prisma.domainEvent.findMany({
      where: { projectId, eventType: COMMERCIAL_MONEY_EVENT },
      select: { actorId: true, actorKind: true, systemActor: true, actorRole: true, actorName: true },
    });
    expect(envelopes.length, 'activation authors the initial heads and announces them').toBeGreaterThan(0);
    for (const e of envelopes) {
      expect(e).toEqual({ actorId: null, actorKind: 'system', systemActor: f.memberUser.id, actorRole: 'system', actorName: 'commercial-activation' });
    }
  });
});
