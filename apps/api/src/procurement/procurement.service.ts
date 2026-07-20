import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  parseQuantity, ROLE_POLICY,
  type QuoteComparisonDto, type RequisitionDto, type RequisitionEventPayload, type RequisitionLineDto,
  type RfqDto, type VendorQuoteDto, type VendorQuoteLineDto,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../platform/capabilities.service';
import { RequirementsQueryService } from '../activities/requirements.query';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { lockProjectReadiness } from '../common/readiness-lock';
import { fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor, type Actor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type {
  ApproveComparisonInput, CreateRequisitionInput, CreateRfqInput, RecordQuoteInput, RejectRequisitionInput,
} from '../contracts';

/**
 * Phase 3 Task 2 — the §F procurement pipeline through comparison approval.
 *
 * CAPABILITY GATE (§D): every entry point asserts the `materials` capability (404 off-pilot).
 * CAS MACHINES (§F): every transition is `updateMany` on `(id, projectId, status)` — one
 * winner, the loser gets a deterministic 409. ALLOCATION (§F bound 1): a requisition line
 * pins the requirement revision through the Task-1 composite triple FK, the revision row is
 * locked FOR UPDATE via the activities query contract inside the command transaction (which
 * also holds `lockProjectReadiness`, serializing against requirement revise/cancel), and
 * Σ active allocations + the new line may never exceed the revision's required qty.
 * COMPARISON (§F): approval records REAL authority + reason; selecting anything but the
 * lowest landed total among live quotes additionally demands an explicit justification.
 * Quotes: recording a newer quote for the same (rfq, vendor) SUPERSEDES the prior one;
 * a quote whose validity has passed is CAS'd to EXPIRED at comparison approval and can win
 * nothing. Only `requisition.submitted|approved` and `comparison.approved` are domain
 * events (§G catalog); every other step is an audited command.
 */

type LineRow = Prisma.RequisitionLineGetPayload<Record<string, never>>;
type ReqRow = Prisma.RequisitionGetPayload<{ include: { lines: true } }>;
type QuoteRow = Prisma.VendorQuoteGetPayload<{ include: { lines: true } }>;

function serializeLine(l: LineRow): RequisitionLineDto {
  return { id: l.id, requirementId: l.requirementId, revision: l.revision, qty: l.qty.toString(), status: l.status };
}
function serializeRequisition(r: ReqRow): RequisitionDto {
  return {
    id: r.id, title: r.title, status: r.status, notes: r.notes,
    lines: r.lines.map(serializeLine),
    createdAt: r.createdAt.toISOString(), createdById: r.createdById,
    submittedById: r.submittedById, approvedById: r.approvedById, rejectedReason: r.rejectedReason,
  };
}
function serializeQuoteLine(l: Prisma.VendorQuoteLineGetPayload<Record<string, never>>): VendorQuoteLineDto {
  return {
    id: l.id, requisitionLineId: l.requisitionLineId,
    baseRate: l.baseRate.toString(), taxAmount: l.taxAmount.toString(),
    freightAmount: l.freightAmount.toString(), landedCost: l.landedCost.toString(),
    quotedMake: l.quotedMake, matchesSpecification: l.matchesSpecification,
    sampleCompliant: l.sampleCompliant, vendorStockQty: l.vendorStockQty ? l.vendorStockQty.toString() : null,
    deliveryPromise: toIsoCivilDate(l.deliveryPromise),
  };
}
function serializeQuote(q: QuoteRow): VendorQuoteDto {
  return {
    id: q.id, vendorId: q.vendorId, status: q.status, validUntil: toIsoCivilDate(q.validUntil) ?? '',
    leadTimeDays: q.leadTimeDays, paymentTerms: q.paymentTerms, warrantyTerms: q.warrantyTerms,
    historicalScore: q.historicalScore ? q.historicalScore.toString() : null,
    recordedAt: q.recordedAt.toISOString(), recordedById: q.recordedById,
    lines: q.lines.map(serializeQuoteLine),
  };
}
function serializeComparison(c: Prisma.QuoteComparisonGetPayload<Record<string, never>>): QuoteComparisonDto {
  return {
    id: c.id, status: c.status, selectedQuoteId: c.selectedQuoteId, selectedVendorId: c.selectedVendorId,
    reason: c.reason, justification: c.justification,
    approvedById: c.approvedById, approvedAt: c.approvedAt ? c.approvedAt.toISOString() : null,
  };
}
function requisitionPayload(r: ReqRow): RequisitionEventPayload {
  return {
    requisitionId: r.id,
    lines: r.lines.filter((l) => l.status === 'open').map((l) => ({ requirementId: l.requirementId, revision: l.revision, qty: l.qty.toString() })),
  };
}

@Injectable()
export class ProcurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly requirementsQuery: RequirementsQueryService,
    private readonly dispatcher: ExternalEffectDispatcher,
  ) {}

  private async begin(projectId: string, user: AuthUser): Promise<{ actor: Actor; scope: CommandScope }> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    return { actor, scope: { scopeKind: 'project', projectId } };
  }

  /** §F bound 1 — inside the command tx: lock the revision, sum ACTIVE allocations, refuse overflow. */
  private async assertAllocationFits(
    tx: Prisma.TransactionClient, projectId: string, requirementId: string, revision: number, addQty: Prisma.Decimal,
  ): Promise<void> {
    const rev = await this.requirementsQuery.revisionForAllocation(tx, projectId, requirementId, revision);
    const allocated = await tx.requisitionLine.aggregate({
      where: {
        projectId, requirementId, revision, status: 'open',
        requisition: { status: { notIn: ['rejected', 'closed'] } },
      },
      _sum: { qty: true },
    });
    const already = allocated._sum.qty ?? new Prisma.Decimal(0);
    if (already.add(addQty).greaterThan(rev.requiredQty)) {
      throw new ConflictException(
        `Allocation exceeds the requirement revision: required ${rev.requiredQty.toString()} ${rev.baseUom}, already allocated ${already.toString()}, requested ${addQty.toString()} (§F bound 1 — raise the ceiling with a requirement revision, never an override)`,
      );
    }
  }

  async createRequisition(projectId: string, input: CreateRequisitionInput, user: AuthUser, idempotencyKey?: string): Promise<RequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qtys = input.lines.map((l) => {
      const q = parseQuantity(l.qty);
      if (!q) throw new BadRequestException('line qty must be a positive decimal with at most 6 fractional digits');
      return new Prisma.Decimal(q);
    });
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'requisitions.create', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const created = await tx.requisition.create({
          data: { projectId, title: input.title, notes: input.notes ?? null, createdById: actor.actorId },
        });
        for (let i = 0; i < input.lines.length; i++) {
          const line = input.lines[i]!;
          await this.assertAllocationFits(tx, projectId, line.requirementId, line.revision, qtys[i]!);
          await tx.requisitionLine.create({
            data: { projectId, requisitionId: created.id, requirementId: line.requirementId, revision: line.revision, qty: qtys[i]! },
          });
        }
        await recordAudit(tx, { projectId, actor, action: 'requisition.create', entity: 'Requisition', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    return this.readRequisition(projectId, outcome.resultRef);
  }

  async submit(projectId: string, requisitionId: string, user: AuthUser, idempotencyKey?: string): Promise<RequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'requisitions.submit', idempotencyKey, requestHash: hashRequest({ requisitionId }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.requisition.updateMany({
          where: { id: requisitionId, projectId, status: 'draft' },
          data: { status: 'submitted', submittedById: actor.actorId, submittedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only a draft requisition can be submitted — reload and retry');
        const full = await tx.requisition.findFirstOrThrow({ where: { projectId, id: requisitionId }, include: { lines: true } });
        if (!full.lines.some((l) => l.status === 'open')) throw new BadRequestException('A requisition needs at least one open line to submit');
        await recordAudit(tx, { projectId, actor, action: 'requisition.submit', entity: 'Requisition', entityId: requisitionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requisition.submitted', entityType: 'Requisition', entityId: requisitionId,
          payload: requisitionPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'requisition.submitted', dispatch: {},
        });
        return { resultRef: requisitionId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readRequisition(projectId, requisitionId);
  }

  async approve(projectId: string, requisitionId: string, user: AuthUser, idempotencyKey?: string): Promise<RequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'requisitions.approve', idempotencyKey, requestHash: hashRequest({ requisitionId }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.requisition.updateMany({
          where: { id: requisitionId, projectId, status: 'submitted' },
          data: { status: 'approved', approvedById: actor.actorId, approvedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only a submitted requisition can be approved — reload and retry');
        const full = await tx.requisition.findFirstOrThrow({ where: { projectId, id: requisitionId }, include: { lines: true } });
        await recordAudit(tx, { projectId, actor, action: 'requisition.approve', entity: 'Requisition', entityId: requisitionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requisition.approved', entityType: 'Requisition', entityId: requisitionId,
          payload: requisitionPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'requisition.approved', dispatch: {},
        });
        return { resultRef: requisitionId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readRequisition(projectId, requisitionId);
  }

  async reject(projectId: string, requisitionId: string, input: RejectRequisitionInput, user: AuthUser, idempotencyKey?: string): Promise<RequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'requisitions.reject', idempotencyKey, requestHash: hashRequest({ requisitionId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.requisition.updateMany({
          where: { id: requisitionId, projectId, status: 'submitted' },
          data: { status: 'rejected', rejectedReason: input.reason },
        });
        if (count === 0) throw new ConflictException('Only a submitted requisition can be rejected — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'requisition.reject', entity: 'Requisition', entityId: requisitionId });
        return { resultRef: requisitionId, events: [] };
      },
    });
    return this.readRequisition(projectId, requisitionId);
  }

  /** Cancel ONE open line — frees its allocation (the §F disposition unit). */
  async cancelLine(projectId: string, requisitionId: string, lineId: string, user: AuthUser, idempotencyKey?: string): Promise<RequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'requisitions.cancelLine', idempotencyKey, requestHash: hashRequest({ requisitionId, lineId }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const req = await tx.requisition.findFirst({ where: { id: requisitionId, projectId }, select: { status: true } });
        if (!req) throw new NotFoundException('Requisition not found');
        if (req.status === 'rejected' || req.status === 'closed') throw new ConflictException('A rejected or closed requisition has no lines to cancel');
        const { count } = await tx.requisitionLine.updateMany({
          where: { id: lineId, projectId, requisitionId, status: 'open' },
          data: { status: 'cancelled', cancelledAt: new Date(), cancelledById: actor.actorId },
        });
        if (count === 0) throw new ConflictException('Only an open line can be cancelled — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'requisition.cancelLine', entity: 'RequisitionLine', entityId: lineId });
        return { resultRef: requisitionId, events: [] };
      },
    });
    return this.readRequisition(projectId, requisitionId);
  }

  /** approved → closed: every line ordered (Task 3) or cancelled. */
  async close(projectId: string, requisitionId: string, user: AuthUser, idempotencyKey?: string): Promise<RequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'requisitions.close', idempotencyKey, requestHash: hashRequest({ requisitionId }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const open = await tx.requisitionLine.count({ where: { projectId, requisitionId, status: 'open' } });
        if (open > 0) throw new ConflictException(`Requisition still has ${open} open line(s) — order or cancel them first`);
        const { count } = await tx.requisition.updateMany({
          where: { id: requisitionId, projectId, status: 'approved' },
          data: { status: 'closed', closedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only an approved requisition can be closed — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'requisition.close', entity: 'Requisition', entityId: requisitionId });
        return { resultRef: requisitionId, events: [] };
      },
    });
    return this.readRequisition(projectId, requisitionId);
  }

  async createRfq(projectId: string, input: CreateRfqInput, user: AuthUser, idempotencyKey?: string): Promise<RfqDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'rfqs.create', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        const req = await tx.requisition.findFirst({ where: { id: input.requisitionId, projectId }, select: { status: true } });
        if (!req) throw new BadRequestException('requisitionId does not belong to this project');
        if (req.status !== 'approved') throw new ConflictException('An RFQ is issued from an APPROVED requisition');
        const created = await tx.rfq.create({ data: { projectId, requisitionId: input.requisitionId, issuedById: actor.actorId } });
        await recordAudit(tx, { projectId, actor, action: 'rfq.create', entity: 'Rfq', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    return this.readRfq(projectId, outcome.resultRef, user);
  }

  async closeRfq(projectId: string, rfqId: string, user: AuthUser, idempotencyKey?: string): Promise<RfqDto> {
    const { actor, scope } = await this.begin(projectId, user);
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'rfqs.close', idempotencyKey, requestHash: hashRequest({ rfqId }),
      run: async (tx) => {
        const { count } = await tx.rfq.updateMany({
          where: { id: rfqId, projectId, status: 'issued' },
          data: { status: 'closed', closedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only an issued RFQ can be closed — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'rfq.close', entity: 'Rfq', entityId: rfqId });
        return { resultRef: rfqId, events: [] };
      },
    });
    return this.readRfq(projectId, rfqId, user);
  }

  /** Record a vendor's quote; a prior RECORDED quote of the same (rfq, vendor) is SUPERSEDED (CAS). */
  async recordQuote(projectId: string, rfqId: string, input: RecordQuoteInput, user: AuthUser, idempotencyKey?: string): Promise<RfqDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const validUntil = fromIsoCivilDate(input.validUntil);
    if (!validUntil) throw new BadRequestException('validUntil must be an ISO civil date');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'quotes.record', idempotencyKey, requestHash: hashRequest({ rfqId, ...input }),
      run: async (tx) => {
        const rfq = await tx.rfq.findFirst({ where: { id: rfqId, projectId }, select: { status: true, requisitionId: true } });
        if (!rfq) throw new BadRequestException('rfqId does not belong to this project');
        if (rfq.status !== 'issued') throw new ConflictException('Quotes are recorded against an ISSUED RFQ');
        // §H: the vendor must be BOUND to this project (the FK is the backstop)
        const binding = await tx.projectVendor.findUnique({ where: { projectId_vendorId: { projectId, vendorId: input.vendorId } } });
        if (!binding) throw new BadRequestException('vendorId is not bound to this project — bind the vendor first (§H)');
        // recording anew SUPERSEDES the vendor's prior recorded quote on this RFQ (§F transition)
        await tx.vendorQuote.updateMany({
          where: { projectId, rfqId, vendorId: input.vendorId, status: 'recorded' },
          data: { status: 'superseded' },
        });
        const created = await tx.vendorQuote.create({
          data: {
            projectId, rfqId, vendorId: input.vendorId, validUntil,
            leadTimeDays: input.leadTimeDays ?? null, paymentTerms: input.paymentTerms ?? null,
            warrantyTerms: input.warrantyTerms ?? null,
            historicalScore: input.historicalScore != null ? new Prisma.Decimal(input.historicalScore) : null,
            recordedById: actor.actorId,
          },
        });
        for (const line of input.lines) {
          const reqLine = await tx.requisitionLine.findFirst({
            where: { id: line.requisitionLineId, projectId, requisitionId: rfq.requisitionId, status: 'open' },
            select: { id: true },
          });
          if (!reqLine) throw new BadRequestException('requisitionLineId must be an OPEN line of this RFQ’s requisition');
          const promise = line.deliveryPromise != null ? fromIsoCivilDate(line.deliveryPromise) : null;
          if (line.deliveryPromise != null && !promise) throw new BadRequestException('deliveryPromise must be an ISO civil date');
          await tx.vendorQuoteLine.create({
            data: {
              projectId, quoteId: created.id, requisitionLineId: line.requisitionLineId,
              baseRate: new Prisma.Decimal(line.baseRate), taxAmount: new Prisma.Decimal(line.taxAmount),
              freightAmount: new Prisma.Decimal(line.freightAmount), landedCost: new Prisma.Decimal(line.landedCost),
              quotedMake: line.quotedMake, matchesSpecification: line.matchesSpecification,
              sampleCompliant: line.sampleCompliant ?? null,
              vendorStockQty: line.vendorStockQty != null ? new Prisma.Decimal(line.vendorStockQty) : null,
              deliveryPromise: promise,
            },
          });
        }
        await recordAudit(tx, { projectId, actor, action: 'quote.record', entity: 'VendorQuote', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    void outcome;
    return this.readRfq(projectId, rfqId, user);
  }

  async createComparison(projectId: string, rfqId: string, user: AuthUser, idempotencyKey?: string): Promise<RfqDto> {
    const { actor, scope } = await this.begin(projectId, user);
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'comparisons.create', idempotencyKey, requestHash: hashRequest({ rfqId }),
      run: async (tx) => {
        const rfq = await tx.rfq.findFirst({ where: { id: rfqId, projectId }, select: { id: true } });
        if (!rfq) throw new BadRequestException('rfqId does not belong to this project');
        const existing = await tx.quoteComparison.findUnique({ where: { projectId_rfqId: { projectId, rfqId } } });
        if (existing) throw new ConflictException('A comparison already exists for this RFQ');
        const created = await tx.quoteComparison.create({ data: { projectId, rfqId, createdById: actor.actorId } });
        await recordAudit(tx, { projectId, actor, action: 'comparison.create', entity: 'QuoteComparison', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    return this.readRfq(projectId, rfqId, user);
  }

  /** §F — draft → approved: authority + reason always; NON-LOWEST selection demands justification. */
  async approveComparison(projectId: string, rfqId: string, input: ApproveComparisonInput, user: AuthUser, idempotencyKey?: string): Promise<RfqDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'comparisons.approve', idempotencyKey, requestHash: hashRequest({ rfqId, ...input }),
      run: async (tx) => {
        const comparison = await tx.quoteComparison.findUnique({ where: { projectId_rfqId: { projectId, rfqId } } });
        if (!comparison) throw new NotFoundException('No comparison exists for this RFQ');
        if (comparison.status !== 'draft') throw new ConflictException('The comparison is already approved');
        // validity is settled INSIDE the approving transaction: recorded quotes past their
        // validity date are CAS'd to EXPIRED here and can win nothing (§F transition)
        const today = new Date(new Date().toISOString().slice(0, 10));
        await tx.vendorQuote.updateMany({
          where: { projectId, rfqId, status: 'recorded', validUntil: { lt: today } },
          data: { status: 'expired' },
        });
        const live = await tx.vendorQuote.findMany({ where: { projectId, rfqId, status: 'recorded' }, include: { lines: true } });
        if (live.length === 0) throw new ConflictException('No live (recorded, unexpired) quotes to compare');
        const selected = live.find((q) => q.id === input.selectedQuoteId);
        if (!selected) throw new BadRequestException('selectedQuoteId must name a LIVE quote of this RFQ (recorded and unexpired)');
        const totals = new Map(live.map((q) => [q.id, q.lines.reduce((s, l) => s.add(l.landedCost), new Prisma.Decimal(0))]));
        const lowest = [...totals.values()].reduce((a, b) => (b.lessThan(a) ? b : a));
        const selectedTotal = totals.get(selected.id)!;
        if (selectedTotal.greaterThan(lowest) && !input.justification) {
          throw new BadRequestException(
            `Selected landed total ${selectedTotal.toString()} exceeds the lowest ${lowest.toString()} — a non-lowest selection demands an explicit justification (§F)`,
          );
        }
        const { count } = await tx.quoteComparison.updateMany({
          where: { id: comparison.id, projectId, status: 'draft' },
          data: {
            status: 'approved', selectedQuoteId: selected.id, selectedVendorId: selected.vendorId,
            reason: input.reason, justification: input.justification ?? null,
            approvedById: actor.actorId, approvedAt: new Date(),
          },
        });
        if (count === 0) throw new ConflictException('The comparison changed while approving — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'comparison.approve', entity: 'QuoteComparison', entityId: comparison.id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'comparison.approved', entityType: 'QuoteComparison', entityId: comparison.id,
          payload: { comparisonId: comparison.id, selectedVendorId: selected.vendorId, authority: actor.actorId, reason: input.reason } as unknown as Prisma.InputJsonValue,
          effectKey: 'comparison.approved', dispatch: {},
        });
        return { resultRef: comparison.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readRfq(projectId, rfqId, user);
  }

  // ── reads (route AND service enforce the explicit procurement.read policy) ────────────────

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['procurement.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The procurement pipeline is a pmc/engineer surface');
    }
  }

  private async readRequisition(projectId: string, requisitionId: string): Promise<RequisitionDto> {
    const row = await this.prisma.requisition.findFirstOrThrow({ where: { projectId, id: requisitionId }, include: { lines: true } });
    return serializeRequisition(row);
  }

  async listRequisitions(projectId: string, user: AuthUser): Promise<{ requisitions: RequisitionDto[] }> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    this.assertRead(user);
    const rows = await this.prisma.requisition.findMany({ where: { projectId }, include: { lines: true }, orderBy: { createdAt: 'asc' } });
    return { requisitions: rows.map(serializeRequisition) };
  }

  async readRfq(projectId: string, rfqId: string, user: AuthUser): Promise<RfqDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    this.assertRead(user);
    const rfq = await this.prisma.rfq.findFirst({
      where: { id: rfqId, projectId },
      include: { quotes: { include: { lines: true }, orderBy: { recordedAt: 'asc' } }, comparison: true },
    });
    if (!rfq) throw new NotFoundException('RFQ not found');
    return {
      id: rfq.id, requisitionId: rfq.requisitionId, status: rfq.status,
      issuedAt: rfq.issuedAt.toISOString(), issuedById: rfq.issuedById,
      quotes: rfq.quotes.map(serializeQuote),
      comparison: rfq.comparison ? serializeComparison(rfq.comparison) : null,
    };
  }
}
