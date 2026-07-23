import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  parseQuantity, ROLE_POLICY,
  type DeliveryCommitmentDto, type DeliveryEventPayload, type PoEventPayload,
  type PurchaseOrderDto, type PurchaseOrderLineDto, type PurchaseOrderVersionDto,
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
  AmendPoInput, CancelPoInput, CloseShortPoInput, CommitDeliveryInput, CreatePoInput, IssuePoInput, ReviseDeliveryInput,
} from '../contracts';

/**
 * Phase 3 Task 3 — purchase orders + delivery commitments (§F).
 *
 * VERSIONED PO MACHINE: lifecycle lives on version rows — draft → issued →
 * partially_received → completed; issued → amended (a NEW version is issued and the prior
 * frozen snapshot is retained VERBATIM — PostgreSQL triggers freeze every commercial column)
 * | cancelled (only with zero accepted receipts; otherwise close-short with reason). The
 * "current" version is the highest one; every transition is a CAS on `(id, status)`.
 *
 * FROZEN SNAPSHOT: creation copies each line's commercial facts from the comparison-approved
 * SELECTED quote (spec fingerprint + base UOM from the pinned requirement revision via the
 * activities query contract; make/rate/taxes/landed from the quote line — never
 * caller-authored) and computes `committedAmountBase = rate × qty × uomConversion + tax +
 * freight` once, frozen (the Phase-5 commitment fact).
 *
 * ALLOCATION (§F bound 2): each PO line allocates against ONE requisition line —
 * Σ live PO-line allocations ≤ the line's qty, enforced in-transaction with the requisition
 * line row locked FOR UPDATE (the command also holds `lockProjectReadiness`). Versions in
 * 'amended'/'cancelled' release their allocation; 'closed_short' keeps only its received
 * portion (the un-received remainder is deliberately freed for a follow-up order). A
 * requisition line fully covered by live PO allocations flips to 'ordered' (and back to
 * 'open' when allocation frees) — 'ordered' lines still hold their §F bound-1 allocation.
 *
 * approvedOverage (§F bound-3 headroom for Task-4 receipts) is accepted ONLY by the
 * issue/amend commands, with a reason, per line.
 *
 * EVENTS (§G catalog): `po.issued|amended|cancelled` (cancelled only for a version that was
 * ANNOUNCED as issued — a draft cancel is an audit fact), `po.closed_short`,
 * `delivery.committed|revised|defaulted` and `delivery.fulfilled`. Task 6 F4: close-short and
 * fulfilment REMOVE inbound coverage, so both are readiness-locked and event-bearing (the
 * readiness projection consumes them) — no longer audit-only.
 */

const LIVE_PO_STATUSES = ['draft', 'issued', 'partially_received', 'completed'] as const;

type CommitmentRow = Prisma.DeliveryCommitmentGetPayload<{ include: { promises: true } }>;
type LineRow = Prisma.PurchaseOrderLineGetPayload<{ include: { commitments: { include: { promises: true } } } }>;
type VersionRow = Prisma.PurchaseOrderVersionGetPayload<{ include: { lines: { include: { commitments: { include: { promises: true } } } } } }>;
type PoRow = Prisma.PurchaseOrderGetPayload<{ include: { versions: { include: { lines: { include: { commitments: { include: { promises: true } } } } } } } }>;

function serializeCommitment(c: CommitmentRow): DeliveryCommitmentDto {
  return {
    id: c.id, poLineId: c.poLineId, status: c.status,
    createdAt: c.createdAt.toISOString(), createdById: c.createdById,
    promises: [...c.promises].sort((a, b) => a.seq - b.seq).map((p) => ({
      seq: p.seq, promisedDate: toIsoCivilDate(p.promisedDate) ?? '', reason: p.reason,
      recordedAt: p.recordedAt.toISOString(), recordedById: p.recordedById,
    })),
  };
}
function serializeLine(l: LineRow): PurchaseOrderLineDto {
  return {
    id: l.id, requisitionLineId: l.requisitionLineId, requirementId: l.requirementId, revision: l.revision,
    specFingerprint: l.specFingerprint, quotedMake: l.quotedMake, uom: l.uom,
    purchaseUom: l.purchaseUom, purchaseQty: l.purchaseQty.toString(),
    conversionToBase: l.conversionToBase.toString(), qty: l.qty.toString(), rate: l.rate.toString(),
    taxAmount: l.taxAmount.toString(), freightAmount: l.freightAmount.toString(),
    landedAmount: l.landedAmount.toString(), committedAmountBase: l.committedAmountBase.toString(),
    approvedOverage: l.approvedOverage.toString(), overageReason: l.overageReason,
    receivedQty: l.receivedQty.toString(),
    commitments: l.commitments.map(serializeCommitment),
  };
}
function serializeVersion(v: VersionRow): PurchaseOrderVersionDto {
  return {
    id: v.id, version: v.version, status: v.status, supersedesVersion: v.supersedesVersion,
    issuedById: v.issuedById, issuedAt: v.issuedAt ? v.issuedAt.toISOString() : null,
    amendReason: v.amendReason, cancelReason: v.cancelReason, closeShortReason: v.closeShortReason,
    createdAt: v.createdAt.toISOString(), createdById: v.createdById,
    lines: v.lines.map(serializeLine),
  };
}
function serializePo(po: PoRow): PurchaseOrderDto {
  return {
    id: po.id, vendorId: po.vendorId, requisitionId: po.requisitionId, comparisonId: po.comparisonId,
    createdAt: po.createdAt.toISOString(), createdById: po.createdById,
    versions: [...po.versions].sort((a, b) => a.version - b.version).map(serializeVersion),
  };
}
function poPayload(poId: string, version: VersionRow): PoEventPayload {
  return {
    poId, version: version.version,
    lines: version.lines.map((l) => ({
      poLineId: l.id, requisitionLineId: l.requisitionLineId,
      requirementId: l.requirementId, revision: l.revision,
      qty: l.qty.toString(), committedAmountBase: l.committedAmountBase.toString(),
      specFingerprint: l.specFingerprint,
    })),
  };
}
function deliveryPayload(c: CommitmentRow): DeliveryEventPayload {
  const history = [...c.promises].sort((a, b) => a.seq - b.seq);
  const latest = history[history.length - 1]!;
  return {
    commitmentId: c.id, poLineId: c.poLineId,
    promisedDate: toIsoCivilDate(latest.promisedDate) ?? '',
    history: history.map((p) => ({ seq: p.seq, promisedDate: toIsoCivilDate(p.promisedDate) ?? '', reason: p.reason })),
  };
}

@Injectable()
export class PurchaseOrdersService {
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

  /**
   * §F bound 2 — inside the command tx: FOR UPDATE the requisition line (the parent row),
   * sum LIVE PO-line allocations against it, refuse overflow. Returns the line row.
   * 'amended'/'cancelled' versions release; 'closed_short' counts only its received portion.
   */
  private async lockLineAndAssertOrderFits(
    tx: Prisma.TransactionClient, projectId: string, requisitionLineId: string, addQty: Prisma.Decimal,
  ): Promise<{ id: string; requirementId: string; revision: number; qty: Prisma.Decimal; requisitionId: string }> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; requirementId: string; revision: number; qty: Prisma.Decimal; status: string; requisitionId: string }>
    >`
      SELECT "id", "requirementId", "revision", "qty", "status", "requisitionId"
      FROM "RequisitionLine"
      WHERE "projectId" = ${projectId} AND "id" = ${requisitionLineId}
      FOR UPDATE`;
    const line = rows[0];
    if (!line) throw new NotFoundException('Requisition line not found in this project');
    if (line.status === 'cancelled') throw new ConflictException('A cancelled requisition line cannot be ordered');
    const req = await tx.requisition.findFirstOrThrow({ where: { projectId, id: line.requisitionId }, select: { status: true } });
    if (req.status !== 'approved') throw new ConflictException('Purchase orders execute an APPROVED requisition');
    const allocated = await this.liveAllocation(tx, projectId, requisitionLineId);
    if (allocated.add(addQty).greaterThan(line.qty)) {
      throw new ConflictException(
        `Order exceeds the requisition line: line qty ${line.qty.toString()}, already ordered ${allocated.toString()}, requested ${addQty.toString()} (§F bound 2 — split within the line's remaining qty, never beyond it)`,
      );
    }
    return { id: line.id, requirementId: line.requirementId, revision: line.revision, qty: line.qty, requisitionId: line.requisitionId };
  }

  /** Σ live PO-line allocations against one requisition line (closed_short → received only). */
  private async liveAllocation(tx: Prisma.TransactionClient, projectId: string, requisitionLineId: string): Promise<Prisma.Decimal> {
    const rows = await tx.purchaseOrderLine.findMany({
      where: { projectId, requisitionLineId, poVersion: { status: { in: [...LIVE_PO_STATUSES, 'closed_short'] } } },
      select: { qty: true, receivedQty: true, poVersion: { select: { status: true } } },
    });
    return rows.reduce(
      (sum, r) => sum.add(r.poVersion.status === 'closed_short' ? r.receivedQty : r.qty),
      new Prisma.Decimal(0),
    );
  }

  /** Recompute a requisition line's ordered/open flag after its live allocation changed. */
  private async refreshOrderedFlag(tx: Prisma.TransactionClient, projectId: string, requisitionLineId: string): Promise<void> {
    const line = await tx.requisitionLine.findFirst({ where: { projectId, id: requisitionLineId }, select: { qty: true, status: true } });
    if (!line || line.status === 'cancelled') return;
    const allocated = await this.liveAllocation(tx, projectId, requisitionLineId);
    const fullyOrdered = allocated.greaterThanOrEqualTo(line.qty);
    const want = fullyOrdered ? 'ordered' : 'open';
    if (line.status !== want) {
      await tx.requisitionLine.updateMany({ where: { projectId, id: requisitionLineId, status: line.status }, data: { status: want } });
    }
  }

  /** The current (highest) version of a PO — every lifecycle command targets it. */
  private async currentVersion(tx: Prisma.TransactionClient, projectId: string, poId: string): Promise<VersionRow> {
    const version = await tx.purchaseOrderVersion.findFirst({
      where: { projectId, poId },
      orderBy: { version: 'desc' },
      include: { lines: { include: { commitments: { include: { promises: true } } } } },
    });
    if (!version) throw new NotFoundException('Purchase order not found in this project');
    return version;
  }

  /** Create the frozen version-N line set from the comparison's SELECTED quote. */
  private async freezeLines(
    tx: Prisma.TransactionClient, projectId: string, poVersionId: string,
    requisitionId: string, selectedQuoteId: string,
    lines: CreatePoInput['lines'],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const input of lines) {
      if (seen.has(input.requisitionLineId)) throw new BadRequestException('Each requisition line may appear at most once per PO version');
      seen.add(input.requisitionLineId);
      // F2 correction — the EXPLICIT purchase triple: the caller orders purchaseQty in the
      // vendor's purchase unit with a purchase→base conversion; the base quantity is DERIVED
      // and must round-trip numeric(18,6) EXACTLY (the DB CHECK re-derives it).
      const purchaseQtyStr = parseQuantity(input.purchaseQty);
      if (!purchaseQtyStr) throw new BadRequestException('purchaseQty must be a positive decimal with at most 6 fractional digits');
      const purchaseQty = new Prisma.Decimal(purchaseQtyStr);
      const conversionStr = input.conversionToBase != null ? parseQuantity(input.conversionToBase) : '1';
      if (!conversionStr) throw new BadRequestException('conversionToBase must be a positive decimal with at most 6 fractional digits');
      const conversionToBase = new Prisma.Decimal(conversionStr);
      const qty = purchaseQty.mul(conversionToBase);
      if (!qty.toDecimalPlaces(6).equals(qty)) {
        throw new BadRequestException('purchaseQty × conversionToBase must land exactly on 6 decimal places — restate the order in exact base quantities');
      }

      const line = await this.lockLineAndAssertOrderFits(tx, projectId, input.requisitionLineId, qty);
      if (line.requisitionId !== requisitionId) {
        throw new BadRequestException('requisitionLineId must belong to the comparison’s requisition');
      }
      // the commercial snapshot comes from the comparison-approved SELECTED quote — never the caller
      const quoteLine = await tx.vendorQuoteLine.findFirst({
        where: { projectId, quoteId: selectedQuoteId, requisitionLineId: line.id },
      });
      if (!quoteLine) throw new BadRequestException('The selected quote does not quote this requisition line — a PO freezes quoted terms only');
      // F1 defense in depth: approval already refuses non-matching selections; a PO line can
      // still never label offered material with the demanded fingerprint.
      if (!quoteLine.matchesSpecification) {
        throw new BadRequestException('The quoted material does NOT match the approved specification — it cannot be ordered without an approved substitution');
      }
      const snapshot = await this.requirementsQuery.revisionSnapshotForOrder(tx, projectId, line.requirementId, line.revision);
      if (snapshot.type !== 'material' || !snapshot.specFingerprint) {
        throw new BadRequestException('Only MATERIAL requirements with a specification identity flow through purchase orders');
      }
      // F2 — dimensionally exact commitment: rate is the quote's per-BASE-unit rate, so
      // rate × purchaseQty × conversionToBase = rate × baseQty; a PARTIAL order carries its
      // base-quantity share of the quote line's tax/freight amounts (2 dp, documented).
      const shareFactor = qty.div(line.qty);
      const taxAmount = quoteLine.taxAmount.mul(shareFactor).toDecimalPlaces(2);
      const freightAmount = quoteLine.freightAmount.mul(shareFactor).toDecimalPlaces(2);
      const committedAmountBase = quoteLine.baseRate.mul(purchaseQty).mul(conversionToBase)
        .add(taxAmount).add(freightAmount).toDecimalPlaces(2);
      await tx.purchaseOrderLine.create({
        data: {
          projectId, poVersionId, requisitionLineId: line.id,
          requisitionId: line.requisitionId,
          requirementId: line.requirementId, revision: line.revision,
          specFingerprint: snapshot.specFingerprint, quotedMake: quoteLine.quotedMake,
          uom: snapshot.baseUom, purchaseUom: input.purchaseUom ?? snapshot.baseUom,
          purchaseQty, conversionToBase, qty,
          rate: quoteLine.baseRate, taxAmount, freightAmount,
          landedAmount: quoteLine.landedCost, committedAmountBase,
        },
      });
      await this.refreshOrderedFlag(tx, projectId, line.id);
    }
  }

  /** Apply issuance/amendment-time approvedOverage — the ONLY §F path that sets it. */
  private async applyOverages(
    tx: Prisma.TransactionClient, projectId: string, poVersionId: string, overages: IssuePoInput['overages'],
  ): Promise<void> {
    for (const o of overages ?? []) {
      const overStr = parseQuantity(o.approvedOverage);
      if (!overStr) throw new BadRequestException('approvedOverage must be a positive decimal with at most 6 fractional digits');
      const { count } = await tx.purchaseOrderLine.updateMany({
        where: { projectId, poVersionId, requisitionLineId: o.requisitionLineId },
        data: { approvedOverage: new Prisma.Decimal(overStr), overageReason: o.reason },
      });
      if (count === 0) throw new BadRequestException('approvedOverage names a requisition line this PO version does not order');
    }
  }

  // ── commands ──────────────────────────────────────────────────────────────────────────────

  /** Create a DRAFT PO (version 1) from an APPROVED comparison — allocation reserved under §F bound 2. */
  async create(projectId: string, input: CreatePoInput, user: AuthUser, idempotencyKey?: string): Promise<PurchaseOrderDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'pos.create', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const comparison = await tx.quoteComparison.findFirst({
          where: { projectId, id: input.comparisonId },
          include: { rfq: { select: { requisitionId: true } } },
        });
        if (!comparison) throw new BadRequestException('comparisonId does not belong to this project');
        if (comparison.status !== 'approved' || !comparison.selectedQuoteId || !comparison.selectedVendorId) {
          throw new ConflictException('A purchase order executes an APPROVED comparison');
        }
        const po = await tx.purchaseOrder.create({
          data: {
            projectId, vendorId: comparison.selectedVendorId, requisitionId: comparison.rfq.requisitionId,
            comparisonId: comparison.id, createdById: actor.actorId,
          },
        });
        const version = await tx.purchaseOrderVersion.create({
          data: { projectId, poId: po.id, requisitionId: po.requisitionId, version: 1, createdById: actor.actorId },
        });
        await this.freezeLines(tx, projectId, version.id, comparison.rfq.requisitionId, comparison.selectedQuoteId, input.lines);
        await recordAudit(tx, { projectId, actor, action: 'po.create', entity: 'PurchaseOrder', entityId: po.id });
        return { resultRef: po.id, events: [] };
      },
    });
    return this.readPo(projectId, outcome.resultRef, user);
  }

  /** draft → issued: freezes become effective; approvedOverage is set HERE (with reason). */
  async issue(projectId: string, poId: string, input: IssuePoInput, user: AuthUser, idempotencyKey?: string): Promise<PurchaseOrderDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'pos.issue', idempotencyKey, requestHash: hashRequest({ poId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const current = await this.currentVersion(tx, projectId, poId);
        const { count } = await tx.purchaseOrderVersion.updateMany({
          where: { id: current.id, projectId, status: 'draft' },
          data: { status: 'issued', issuedById: actor.actorId, issuedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only a draft purchase order can be issued — reload and retry');
        await this.applyOverages(tx, projectId, current.id, input.overages);
        const issued = await this.currentVersion(tx, projectId, poId);
        await recordAudit(tx, { projectId, actor, action: 'po.issue', entity: 'PurchaseOrderVersion', entityId: current.id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'po.issued', entityType: 'PurchaseOrder', entityId: poId,
          payload: poPayload(poId, issued) as unknown as Prisma.InputJsonValue,
          effectKey: 'po.issued', dispatch: {},
        });
        return { resultRef: poId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readPo(projectId, poId, user);
  }

  /**
   * issued → amended: the current version is CAS'd to 'amended' (its frozen snapshot is
   * retained verbatim — DB triggers guarantee it) and a NEW version is ISSUED in the same
   * transaction, referencing the amended one; its lines re-freeze from the same selected
   * quote and re-validate §F bound 2 (the amended version's allocation is already released).
   */
  async amend(projectId: string, poId: string, input: AmendPoInput, user: AuthUser, idempotencyKey?: string): Promise<PurchaseOrderDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'pos.amend', idempotencyKey, requestHash: hashRequest({ poId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const po = await tx.purchaseOrder.findFirst({ where: { projectId, id: poId }, select: { requisitionId: true, comparisonId: true } });
        if (!po) throw new NotFoundException('Purchase order not found in this project');
        const current = await this.currentVersion(tx, projectId, poId);
        const { count } = await tx.purchaseOrderVersion.updateMany({
          where: { id: current.id, projectId, status: 'issued' },
          data: { status: 'amended', amendReason: input.reason, amendedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only an ISSUED purchase order can be amended — reload and retry');
        // the amended version's lines no longer count as live allocation — refresh its lines' flags
        for (const l of current.lines) await this.refreshOrderedFlag(tx, projectId, l.requisitionLineId);
        const comparison = await tx.quoteComparison.findFirstOrThrow({ where: { projectId, id: po.comparisonId }, select: { selectedQuoteId: true } });
        const next = await tx.purchaseOrderVersion.create({
          data: {
            projectId, poId, requisitionId: po.requisitionId, version: current.version + 1, status: 'issued',
            supersedesVersion: current.version,
            issuedById: actor.actorId, issuedAt: new Date(), createdById: actor.actorId,
          },
        });
        await this.freezeLines(tx, projectId, next.id, po.requisitionId, comparison.selectedQuoteId!, input.lines);
        await this.applyOverages(tx, projectId, next.id, input.overages);
        const issued = await this.currentVersion(tx, projectId, poId);
        await recordAudit(tx, { projectId, actor, action: 'po.amend', entity: 'PurchaseOrderVersion', entityId: next.id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'po.amended', entityType: 'PurchaseOrder', entityId: poId,
          payload: poPayload(poId, issued) as unknown as Prisma.InputJsonValue,
          effectKey: 'po.amended', dispatch: {},
        });
        return { resultRef: poId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readPo(projectId, poId, user);
  }

  /** draft|issued → cancelled — ONLY with zero accepted receipts; otherwise close-short (§F). */
  async cancel(projectId: string, poId: string, input: CancelPoInput, user: AuthUser, idempotencyKey?: string): Promise<PurchaseOrderDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'pos.cancel', idempotencyKey, requestHash: hashRequest({ poId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const current = await this.currentVersion(tx, projectId, poId);
        const received = current.lines.reduce((s, l) => s.add(l.receivedQty), new Prisma.Decimal(0));
        if (received.greaterThan(0)) {
          throw new ConflictException('This purchase order has accepted receipts — close it SHORT with a reason instead of cancelling (§F)');
        }
        const wasIssued = current.status === 'issued';
        const { count } = await tx.purchaseOrderVersion.updateMany({
          where: { id: current.id, projectId, status: { in: ['draft', 'issued'] } },
          data: { status: 'cancelled', cancelReason: input.reason, cancelledAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only a draft or issued purchase order can be cancelled — reload and retry');
        for (const l of current.lines) await this.refreshOrderedFlag(tx, projectId, l.requisitionLineId);
        await recordAudit(tx, { projectId, actor, action: 'po.cancel', entity: 'PurchaseOrderVersion', entityId: current.id });
        // §G: only a version the world SAW as issued announces its cancellation
        if (wasIssued) {
          const cancelled = await this.currentVersion(tx, projectId, poId);
          const ev = await emitEvent(tx, {
            projectId, actor, eventType: 'po.cancelled', entityType: 'PurchaseOrder', entityId: poId,
            payload: poPayload(poId, cancelled) as unknown as Prisma.InputJsonValue,
            effectKey: 'po.cancelled', dispatch: {},
          });
          return { resultRef: poId, events: [ev] };
        }
        return { resultRef: poId, events: [] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readPo(projectId, poId, user);
  }

  /** issued|partially_received → closed_short with reason: the un-received remainder is released. */
  async closeShort(projectId: string, poId: string, input: CloseShortPoInput, user: AuthUser, idempotencyKey?: string): Promise<PurchaseOrderDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'pos.closeShort', idempotencyKey, requestHash: hashRequest({ poId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const current = await this.currentVersion(tx, projectId, poId);
        const { count } = await tx.purchaseOrderVersion.updateMany({
          where: { id: current.id, projectId, status: { in: ['issued', 'partially_received'] } },
          data: { status: 'closed_short', closeShortReason: input.reason, closedShortAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only an issued or partially received purchase order can be closed short — reload and retry');
        for (const l of current.lines) await this.refreshOrderedFlag(tx, projectId, l.requisitionLineId);
        await recordAudit(tx, { projectId, actor, action: 'po.closeShort', entity: 'PurchaseOrderVersion', entityId: current.id });
        // §G (Task 6 F4): a closed-short version releases its lines' UN-received inbound coverage —
        // announce it so the readiness projection re-derives. A closeable version was always issued,
        // so it was always announced (unlike a draft cancel, which stays an audit fact).
        const closed = await this.currentVersion(tx, projectId, poId);
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'po.closed_short', entityType: 'PurchaseOrder', entityId: poId,
          payload: poPayload(poId, closed) as unknown as Prisma.InputJsonValue,
          effectKey: 'po.closed_short', dispatch: {},
        });
        return { resultRef: poId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readPo(projectId, poId, user);
  }

  /** Commit a delivery promise on a LIVE issued PO line — the first dated promise row. */
  async commitDelivery(projectId: string, input: CommitDeliveryInput, user: AuthUser, idempotencyKey?: string): Promise<DeliveryCommitmentDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const promised = fromIsoCivilDate(input.promisedDate);
    if (!promised) throw new BadRequestException('promisedDate must be an ISO civil date');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'deliveries.commit', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const line = await tx.purchaseOrderLine.findFirst({
          where: { projectId, id: input.poLineId },
          select: { id: true, poVersion: { select: { status: true } } },
        });
        if (!line) throw new NotFoundException('Purchase order line not found in this project');
        if (line.poVersion.status !== 'issued' && line.poVersion.status !== 'partially_received') {
          throw new ConflictException('A delivery is committed against a line of an ISSUED purchase order version');
        }
        // F6 correction: EXACTLY ONE commitment per PO line — its promise history carries
        // every revision. The unique index (projectId, poLineId) is the database backstop.
        const existing = await tx.deliveryCommitment.findFirst({ where: { projectId, poLineId: line.id }, select: { id: true } });
        if (existing) {
          throw new ConflictException('This PO line already has its delivery commitment — REVISE it instead of committing a second one');
        }
        const commitment = await tx.deliveryCommitment.create({
          data: { projectId, poLineId: line.id, createdById: actor.actorId },
        });
        await tx.deliveryPromise.create({
          data: { projectId, commitmentId: commitment.id, seq: 1, promisedDate: promised, recordedById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'delivery.commit', entity: 'DeliveryCommitment', entityId: commitment.id });
        const full = await tx.deliveryCommitment.findFirstOrThrow({ where: { projectId, id: commitment.id }, include: { promises: true } });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'delivery.committed', entityType: 'DeliveryCommitment', entityId: commitment.id,
          payload: deliveryPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'delivery.committed', dispatch: {},
        });
        return { resultRef: commitment.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readCommitment(projectId, outcome.resultRef);
  }

  /** committed|revised → revised: APPENDS the next dated promise (reason required). */
  async reviseDelivery(projectId: string, commitmentId: string, input: ReviseDeliveryInput, user: AuthUser, idempotencyKey?: string): Promise<DeliveryCommitmentDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const promised = fromIsoCivilDate(input.promisedDate);
    if (!promised) throw new BadRequestException('promisedDate must be an ISO civil date');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'deliveries.revise', idempotencyKey, requestHash: hashRequest({ commitmentId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.deliveryCommitment.updateMany({
          where: { id: commitmentId, projectId, status: { in: ['committed', 'revised'] } },
          data: { status: 'revised' },
        });
        if (count === 0) throw new ConflictException('Only a live (committed/revised) delivery commitment can be revised — reload and retry');
        const head = await tx.deliveryPromise.findFirstOrThrow({
          where: { projectId, commitmentId }, orderBy: { seq: 'desc' }, select: { seq: true },
        });
        await tx.deliveryPromise.create({
          data: { projectId, commitmentId, seq: head.seq + 1, promisedDate: promised, reason: input.reason, recordedById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'delivery.revise', entity: 'DeliveryCommitment', entityId: commitmentId });
        const full = await tx.deliveryCommitment.findFirstOrThrow({ where: { projectId, id: commitmentId }, include: { promises: true } });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'delivery.revised', entityType: 'DeliveryCommitment', entityId: commitmentId,
          payload: deliveryPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'delivery.revised', dispatch: {},
        });
        return { resultRef: commitmentId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readCommitment(projectId, commitmentId);
  }

  /**
   * committed|revised → fulfilled. Task 6 F4: fulfilment REMOVES the commitment from inbound
   * coverage (a fulfilled delivery's stock is received, not still coming), so it joins the
   * readiness-lock protocol AND emits `delivery.fulfilled` for the projection. Fulfilling a
   * commitment with NO accepted receipts is refused — it would drop inbound coverage for material
   * that never arrived.
   */
  async fulfillDelivery(projectId: string, commitmentId: string, user: AuthUser, idempotencyKey?: string): Promise<DeliveryCommitmentDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'deliveries.fulfill', idempotencyKey, requestHash: hashRequest({ commitmentId }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const commitment = await tx.deliveryCommitment.findFirst({
          where: { projectId, id: commitmentId },
          select: { id: true, poLine: { select: { qty: true, receivedQty: true } } },
        });
        if (!commitment) throw new NotFoundException('Delivery commitment not found in this project');
        // Task 6 correction (finding 1): fulfilment requires the FULL ordered quantity received —
        // no outstanding committed quantity (`receivedQty >= qty`). A partial receipt cannot
        // terminalize the commitment (that would silently drop the outstanding balance from inbound
        // coverage); the balance stays committed/revised, or the PO is closed short with a reason.
        if (commitment.poLine.receivedQty.lessThan(commitment.poLine.qty)) {
          const outstanding = commitment.poLine.qty.sub(commitment.poLine.receivedQty);
          throw new ConflictException(
            `Cannot fulfil a delivery commitment with ${outstanding.toString()} still outstanding — receive the full ordered quantity, or close the purchase order short (§F/Task 6 finding 1)`,
          );
        }
        const { count } = await tx.deliveryCommitment.updateMany({
          where: { id: commitmentId, projectId, status: { in: ['committed', 'revised'] } },
          data: { status: 'fulfilled', fulfilledAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only a live (committed/revised) delivery commitment can be fulfilled — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'delivery.fulfill', entity: 'DeliveryCommitment', entityId: commitmentId });
        const full = await tx.deliveryCommitment.findFirstOrThrow({ where: { projectId, id: commitmentId }, include: { promises: true } });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'delivery.fulfilled', entityType: 'DeliveryCommitment', entityId: commitmentId,
          payload: deliveryPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'delivery.fulfilled', dispatch: {},
        });
        return { resultRef: commitmentId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readCommitment(projectId, commitmentId);
  }

  /** committed|revised → defaulted: the vendor missed the latest promise (drives §A at-risk). */
  async defaultDelivery(projectId: string, commitmentId: string, user: AuthUser, idempotencyKey?: string): Promise<DeliveryCommitmentDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'deliveries.default', idempotencyKey, requestHash: hashRequest({ commitmentId }),
      run: async (tx) => {
        // §A: a default removes a covering commitment (a shortfall that WAS at-risk becomes
        // blocked), so this command joins the readiness-lock protocol — it serializes against
        // `activities.start` exactly like commit/revise. (fulfil is exempt: it only marks a
        // commitment terminal once its stock is already accepted through the LOCKED receipts.)
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.deliveryCommitment.updateMany({
          where: { id: commitmentId, projectId, status: { in: ['committed', 'revised'] } },
          data: { status: 'defaulted', defaultedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only a live (committed/revised) delivery commitment can be defaulted — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'delivery.default', entity: 'DeliveryCommitment', entityId: commitmentId });
        const full = await tx.deliveryCommitment.findFirstOrThrow({ where: { projectId, id: commitmentId }, include: { promises: true } });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'delivery.defaulted', entityType: 'DeliveryCommitment', entityId: commitmentId,
          payload: deliveryPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'delivery.defaulted', dispatch: {},
        });
        return { resultRef: commitmentId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readCommitment(projectId, commitmentId);
  }

  // ── reads (route AND service enforce the explicit procurement.read policy) ────────────────

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['procurement.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The procurement pipeline is a pmc/engineer surface');
    }
  }

  private readonly poInclude = {
    versions: { include: { lines: { include: { commitments: { include: { promises: true } } } } } },
  } as const;

  async listPos(projectId: string, user: AuthUser): Promise<{ purchaseOrders: PurchaseOrderDto[] }> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    this.assertRead(user);
    const rows = await this.prisma.purchaseOrder.findMany({
      where: { projectId }, include: this.poInclude, orderBy: { createdAt: 'asc' },
    });
    return { purchaseOrders: rows.map(serializePo) };
  }

  async readPo(projectId: string, poId: string, user: AuthUser): Promise<PurchaseOrderDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    this.assertRead(user);
    const row = await this.prisma.purchaseOrder.findFirst({ where: { projectId, id: poId }, include: this.poInclude });
    if (!row) throw new NotFoundException('Purchase order not found');
    return serializePo(row);
  }

  private async readCommitment(projectId: string, commitmentId: string): Promise<DeliveryCommitmentDto> {
    const row = await this.prisma.deliveryCommitment.findFirstOrThrow({ where: { projectId, id: commitmentId }, include: { promises: true } });
    return serializeCommitment(row);
  }
}
