import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  parseQuantity,
  type StockBucketsDto, type StockLotDto, type StockStoreDto, type StockTransactedPayload, type StockTransactionDto,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../platform/capabilities.service';
import { ProcurementParticipant } from '../procurement/procurement.participant';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { lockProjectReadiness } from '../common/readiness-lock';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, type CommandRunContext, type CommandScope, type CommandTx } from '../platform/commands';
import { resolveActor, type Actor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import type {
  AcceptStockInput, AdjustStockInput, RecordReceiptInput, RejectStockInput, ReverseStockInput, VendorReturnInput,
} from '../contracts';

/**
 * Phase 3 Task 4 — the inventory module: physical material truth (plan §C).
 *
 * EVERY quantity movement is ONE appended `StockTransaction` row — there is no
 * current-quantity column anywhere, and NO code path mutates a quantity outside a ledger
 * append. Buckets (`quarantine`, `acceptedOnHand`, `reserved`, `rejected`,
 * `issuedToActivity`, derived `freeAvailable`) fold from the ledger per stock key
 * `(projectId, storeLocation, stockLotId)`.
 *
 * §C rules, exactly:
 *   (i)  every balance-affecting command re-derives the affected key's buckets INSIDE its
 *        transaction while holding the lot row `SELECT … FOR UPDATE` (all commands also hold
 *        the project readiness lock — the established Phase-3 serialization protocol), and
 *        REFUSES any transaction that would drive ANY bucket (incl. derived freeAvailable)
 *        negative;
 *   (ii) each ledger row records its source action — the CommandExecution ledger row id the
 *        kernel hands to `run` — so a replayed command (which never re-runs) appends nothing;
 *   (iii) no row is ever updated or deleted (DB triggers); corrections append explicit
 *        reversal transactions referencing the reversed row, trigger-verified as its exact
 *        inverse.
 *
 * RECEIPT (§F bound 3): quantity is entered in the PO line's PURCHASE units and converted
 * via the PO's FROZEN `conversionToBase` (exact-6dp refusal, the Task-3 discipline). The
 * transaction-bound `ProcurementParticipant` FOR-UPDATE-locks the PO line, and
 * `applyReceiptProgress` enforces Σ (accepted + quarantined) ≤ ordered + approvedOverage
 * while appending the procurement-owned received-progress fact — one lock, one bound, one
 * transaction. A rejection frees that headroom (the vendor replaces rejected material); a
 * reversal restores whichever side it undoes, re-checking the bound when it re-adds.
 */

const DEFAULT_LOCATION = 'main';

type Bucket = 'quarantine' | 'acceptedOnHand' | 'rejected';

interface Buckets {
  quarantine: Prisma.Decimal;
  acceptedOnHand: Prisma.Decimal;
  rejected: Prisma.Decimal;
}

type TxRow = Prisma.StockTransactionGetPayload<Record<string, never>>;
type LotRow = Prisma.StockLotGetPayload<{ include: { transactions: true } }>;

const ZERO = new Prisma.Decimal(0);

/** The §C generic fold: every row moves qty from `fromBucket` to `toBucket` (null = outside). */
function foldBuckets(rows: ReadonlyArray<Pick<TxRow, 'qty' | 'fromBucket' | 'toBucket'>>): Buckets {
  const b: Buckets = { quarantine: ZERO, acceptedOnHand: ZERO, rejected: ZERO };
  for (const row of rows) {
    if (row.fromBucket) b[row.fromBucket as Bucket] = b[row.fromBucket as Bucket].sub(row.qty);
    if (row.toBucket) b[row.toBucket as Bucket] = b[row.toBucket as Bucket].add(row.qty);
  }
  return b;
}

function serializeTx(t: TxRow): StockTransactionDto {
  return {
    id: t.id, lotId: t.lotId, storeLocation: t.storeLocation, type: t.type,
    qty: t.qty.toString(), fromBucket: t.fromBucket, toBucket: t.toBucket,
    poLineId: t.poLineId, commitmentId: t.commitmentId, reversedTxId: t.reversedTxId,
    qualityResult: t.qualityResult, evidenceMediaId: t.evidenceMediaId, reason: t.reason,
    sourceCommandId: t.sourceCommandId,
    recordedAt: t.recordedAt.toISOString(), recordedById: t.recordedById,
  };
}

function ledgerOrder(a: TxRow, b: TxRow): number {
  const at = a.recordedAt.getTime();
  const bt = b.recordedAt.getTime();
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function serializeLot(lot: LotRow): StockLotDto {
  const ordered = [...lot.transactions].sort(ledgerOrder);
  const locations = [...new Set(ordered.map((t) => t.storeLocation))].sort();
  const perLocation: StockBucketsDto[] = locations.map((loc) => {
    const b = foldBuckets(ordered.filter((t) => t.storeLocation === loc));
    return {
      storeLocation: loc,
      quarantine: b.quarantine.toString(),
      acceptedOnHand: b.acceptedOnHand.toString(),
      reserved: '0', // Task 5
      freeAvailable: b.acceptedOnHand.toString(), // acceptedOnHand − reserved(=0)
      rejected: b.rejected.toString(),
      issuedToActivity: '0', // Task 5
    };
  });
  return {
    id: lot.id, poLineId: lot.poLineId, commitmentId: lot.commitmentId,
    requirementId: lot.requirementId, revision: lot.revision,
    materialCategory: lot.materialCategory, make: lot.make, grade: lot.grade,
    normalizedAttributes: lot.normalizedAttributes, baseUom: lot.baseUom,
    specFingerprint: lot.specFingerprint,
    decisionId: lot.decisionId, decisionVersion: lot.decisionVersion, optionKey: lot.optionKey,
    receivedAt: lot.receivedAt.toISOString(), receivedById: lot.receivedById,
    locations: perLocation,
    transactions: ordered.map(serializeTx),
  };
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly procurementParticipant: ProcurementParticipant,
    private readonly dispatcher: ExternalEffectDispatcher,
  ) {}

  private async begin(projectId: string, user: AuthUser): Promise<{ actor: Actor; scope: CommandScope }> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    return { actor, scope: { scopeKind: 'project', projectId } };
  }

  private parseQty(value: string, label: string): Prisma.Decimal {
    const parsed = parseQuantity(value);
    if (!parsed) throw new BadRequestException(`${label} must be a positive decimal with at most 6 fractional digits`);
    return new Prisma.Decimal(parsed);
  }

  /** §C rule i — the per-stock-key lock: `SELECT … FOR UPDATE` on the lot row. */
  private async lockLot(
    tx: CommandTx, projectId: string, lotId: string,
  ): Promise<{ id: string; poLineId: string; baseUom: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string; poLineId: string; baseUom: string }>>`
      SELECT "id", "poLineId", "baseUom"
      FROM "StockLot"
      WHERE "projectId" = ${projectId} AND "id" = ${lotId}
      FOR UPDATE`;
    const lot = rows[0];
    if (!lot) throw new NotFoundException('Stock lot not found in this project');
    return lot;
  }

  /**
   * §C rule i — re-derive the key's buckets from the ledger (under the lot lock), apply the
   * candidate movement, and REFUSE if any bucket would go negative. Returns nothing — the
   * caller appends the row only after this passes.
   */
  private async assertMovementLegal(
    tx: CommandTx, projectId: string, lotId: string, storeLocation: string,
    movement: { fromBucket: Bucket | null; toBucket: Bucket | null; qty: Prisma.Decimal },
  ): Promise<void> {
    const rows = await tx.stockTransaction.findMany({
      where: { projectId, lotId, storeLocation },
      select: { qty: true, fromBucket: true, toBucket: true },
    });
    const buckets = foldBuckets([...rows, movement]);
    for (const bucket of ['quarantine', 'acceptedOnHand', 'rejected'] as const) {
      if (buckets[bucket].lessThan(0)) {
        throw new ConflictException(
          `Refused: ${bucket} at '${storeLocation}' would go to ${buckets[bucket].toString()} (§C — no bucket may go negative)`,
        );
      }
    }
    // freeAvailable = acceptedOnHand − reserved; reserved is 0 until Task 5, so the
    // acceptedOnHand check above already covers it — recorded here so the derived-bucket
    // refusal stays explicit when reservations land.
  }

  /** Append ONE §C ledger row + its audit + `stock.transacted` event (§C rule ii provenance). */
  private async appendLedgerRow(
    tx: CommandTx, ctx: CommandRunContext, actor: Actor, projectId: string,
    data: {
      lotId: string; storeLocation: string; type: string; qty: Prisma.Decimal;
      fromBucket: Bucket | null; toBucket: Bucket | null;
      poLineId?: string; commitmentId?: string; reversedTxId?: string;
      qualityResult?: string; evidenceMediaId?: string; reason?: string;
    },
    auditAction: string,
  ): Promise<{ row: TxRow; event: EmittedEventMeta }> {
    const row = await tx.stockTransaction.create({
      data: {
        projectId, lotId: data.lotId, storeLocation: data.storeLocation, type: data.type,
        qty: data.qty, fromBucket: data.fromBucket, toBucket: data.toBucket,
        poLineId: data.poLineId ?? null, commitmentId: data.commitmentId ?? null,
        reversedTxId: data.reversedTxId ?? null,
        qualityResult: data.qualityResult ?? null, evidenceMediaId: data.evidenceMediaId ?? null,
        reason: data.reason ?? null,
        sourceCommandId: ctx.commandId, recordedById: actor.actorId,
      },
    });
    await recordAudit(tx, { projectId, actor, action: auditAction, entity: 'StockTransaction', entityId: row.id });
    const payload: StockTransactedPayload = {
      txId: row.id, type: row.type,
      stockKey: { projectId, storeLocation: row.storeLocation, stockLotId: row.lotId },
      qty: row.qty.toString(), sourceCommandId: row.sourceCommandId,
    };
    const event = await emitEvent(tx, {
      projectId, actor, eventType: 'stock.transacted', entityType: 'StockTransaction', entityId: row.id,
      payload: payload as unknown as Prisma.InputJsonValue,
      effectKey: 'stock.transacted', dispatch: {},
    });
    return { row, event };
  }

  private async assertEvidenceMedia(tx: CommandTx, projectId: string, mediaId: string): Promise<void> {
    const media = await tx.media.findFirst({ where: { projectId, id: mediaId }, select: { id: true } });
    if (!media) throw new BadRequestException('evidenceMediaId must name a photo in this project');
  }

  private async readLot(projectId: string, lotId: string): Promise<StockLotDto> {
    const lot = await this.prisma.stockLot.findFirst({ where: { projectId, id: lotId }, include: { transactions: true } });
    if (!lot) throw new NotFoundException('Stock lot not found in this project');
    return serializeLot(lot);
  }

  // ── Commands ───────────────────────────────────────────────────────────────────────────

  /**
   * `receipts.record` — material arrives: a NEW immutable lot (freezing the pinned
   * revision's full §B spec ref) + the `receipt` ledger row into quarantine (§C), with the
   * PO line locked and §F bound 3 enforced through the procurement participant.
   */
  async recordReceipt(projectId: string, input: RecordReceiptInput, user: AuthUser, idempotencyKey?: string): Promise<StockLotDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const purchaseQty = this.parseQty(input.purchaseQty, 'purchaseQty');
    const storeLocation = input.storeLocation ?? DEFAULT_LOCATION;
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'receipts.record', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const line = await this.procurementParticipant.lockPoLineForReceipt(tx, projectId, input.poLineId, input.commitmentId);
        // qty in base UOM via the PO's FROZEN conversion (§C receipt equation) — must land
        // exactly on numeric(18,6), the Task-3 purchase-triple discipline.
        const qty = purchaseQty.mul(line.conversionToBase);
        if (!qty.toDecimalPlaces(6).equals(qty)) {
          throw new BadRequestException('purchaseQty × the frozen conversionToBase must land exactly on 6 decimal places — restate the receipt in exact purchase units');
        }
        const lot = await tx.stockLot.create({
          data: {
            projectId, poLineId: line.poLineId, commitmentId: input.commitmentId,
            requirementId: line.requirementId, revision: line.revision,
            materialCategory: line.spec.materialCategory, make: line.spec.make, grade: line.spec.grade,
            normalizedAttributes: line.spec.normalizedAttributes, baseUom: line.spec.baseUom,
            specFingerprint: line.spec.specFingerprint,
            decisionId: line.spec.decisionId, decisionVersion: line.spec.decisionVersion, optionKey: line.spec.optionKey,
            receivedById: actor.actorId,
          },
        });
        // §F bound 3 under the PO-line FOR UPDATE lock + the received-progress fact — the
        // procurement-owned side of the §G participant edge, same transaction.
        await this.procurementParticipant.applyReceiptProgress(tx, projectId, line.poLineId, qty);
        const { event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation, type: 'receipt', qty,
          fromBucket: null, toBucket: 'quarantine',
          poLineId: line.poLineId, commitmentId: input.commitmentId, reason: input.note,
        }, 'stock.receipt');
        return { resultRef: lot.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readLot(projectId, outcome.resultRef);
  }

  /** `receipts.accept` — quality PASSED for qty: quarantine → acceptedOnHand (partial allowed). */
  async accept(projectId: string, input: AcceptStockInput, user: AuthUser, idempotencyKey?: string): Promise<StockLotDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const storeLocation = input.storeLocation ?? DEFAULT_LOCATION;
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'receipts.accept', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lot = await this.lockLot(tx, projectId, input.lotId);
        await this.assertEvidenceMedia(tx, projectId, input.evidenceMediaId);
        await this.assertMovementLegal(tx, projectId, lot.id, storeLocation, { fromBucket: 'quarantine', toBucket: 'acceptedOnHand', qty });
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation, type: 'acceptance', qty,
          fromBucket: 'quarantine', toBucket: 'acceptedOnHand',
          qualityResult: input.qualityResult, evidenceMediaId: input.evidenceMediaId, reason: input.note,
        }, 'stock.accept');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readLot(projectId, input.lotId);
  }

  /**
   * `receipts.reject` — quality FAILED for qty: quarantine → rejected, and the §F bound-3
   * headroom is freed on the PO line (the vendor replaces rejected material).
   */
  async reject(projectId: string, input: RejectStockInput, user: AuthUser, idempotencyKey?: string): Promise<StockLotDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const storeLocation = input.storeLocation ?? DEFAULT_LOCATION;
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'receipts.reject', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lot = await this.lockLot(tx, projectId, input.lotId);
        await this.assertEvidenceMedia(tx, projectId, input.evidenceMediaId);
        await this.assertMovementLegal(tx, projectId, lot.id, storeLocation, { fromBucket: 'quarantine', toBucket: 'rejected', qty });
        await this.procurementParticipant.applyReceiptProgress(tx, projectId, lot.poLineId, qty.negated());
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation, type: 'rejection', qty,
          fromBucket: 'quarantine', toBucket: 'rejected',
          evidenceMediaId: input.evidenceMediaId, reason: input.reason,
        }, 'stock.reject');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readLot(projectId, input.lotId);
  }

  /** `receipts.vendorReturn` — rejected material physically leaves for the vendor: rejected ↓. */
  async vendorReturn(projectId: string, input: VendorReturnInput, user: AuthUser, idempotencyKey?: string): Promise<StockLotDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const storeLocation = input.storeLocation ?? DEFAULT_LOCATION;
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'receipts.vendorReturn', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lot = await this.lockLot(tx, projectId, input.lotId);
        await this.assertMovementLegal(tx, projectId, lot.id, storeLocation, { fromBucket: 'rejected', toBucket: null, qty });
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation, type: 'vendor_return', qty,
          fromBucket: 'rejected', toBucket: null, reason: input.note,
        }, 'stock.vendorReturn');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readLot(projectId, input.lotId);
  }

  /**
   * `stock.adjust` — the ONLY free-form movement (§C): any → any within the Task-4 buckets,
   * or on/off the books (one side null). Audited, reasoned, pmc authority (route policy).
   * Adjustments never touch the PO line's received-progress fact — they correct STORE truth,
   * not procurement progress (a receipt-side error is corrected by `stock.reverse`).
   */
  async adjust(projectId: string, input: AdjustStockInput, user: AuthUser, idempotencyKey?: string): Promise<StockLotDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const storeLocation = input.storeLocation ?? DEFAULT_LOCATION;
    const fromBucket = input.fromBucket ?? null;
    const toBucket = input.toBucket ?? null;
    if (!fromBucket && !toBucket) throw new BadRequestException('An adjustment names at least one bucket');
    if (fromBucket === toBucket) throw new BadRequestException('An adjustment must move between two DIFFERENT buckets');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'stock.adjust', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lot = await this.lockLot(tx, projectId, input.lotId);
        await this.assertMovementLegal(tx, projectId, lot.id, storeLocation, { fromBucket, toBucket, qty });
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation, type: 'adjustment', qty,
          fromBucket, toBucket, reason: input.reason,
        }, 'stock.adjust');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readLot(projectId, input.lotId);
  }

  /**
   * `stock.reverse` — §C rule iii: the correction APPENDS the exact inverse of the reversed
   * row (DB-trigger-verified), never edits it. Reversing a receipt takes the quantity back
   * out of quarantine AND returns the §F bound-3 headroom; reversing a rejection restores
   * quarantine AND re-consumes headroom (re-checked under the PO-line lock). Each row is
   * reversible at most once (partial unique), and a reversal itself is not reversible.
   */
  async reverse(projectId: string, input: ReverseStockInput, user: AuthUser, idempotencyKey?: string): Promise<StockLotDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'stock.reverse', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const target = await tx.stockTransaction.findFirst({ where: { projectId, id: input.txId } });
        if (!target) throw new NotFoundException('Stock transaction not found in this project');
        if (target.type === 'reversal') {
          throw new ConflictException('A reversal cannot be reversed — append a new correcting transaction');
        }
        const lot = await this.lockLot(tx, projectId, target.lotId);
        const prior = await tx.stockTransaction.findFirst({ where: { projectId, reversedTxId: target.id }, select: { id: true } });
        if (prior) throw new ConflictException('This transaction is already reversed');
        const fromBucket = (target.toBucket ?? null) as Bucket | null;
        const toBucket = (target.fromBucket ?? null) as Bucket | null;
        await this.assertMovementLegal(tx, projectId, lot.id, target.storeLocation, { fromBucket, toBucket, qty: target.qty });
        if (target.type === 'receipt') {
          await this.procurementParticipant.applyReceiptProgress(tx, projectId, lot.poLineId, target.qty.negated());
        } else if (target.type === 'rejection') {
          await this.procurementParticipant.applyReceiptProgress(tx, projectId, lot.poLineId, target.qty);
        }
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation: target.storeLocation, type: 'reversal', qty: target.qty,
          fromBucket, toBucket, reversedTxId: target.id, reason: input.reason,
        }, 'stock.reverse');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const target = await this.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, id: input.txId }, select: { lotId: true } });
    return this.readLot(projectId, target.lotId);
  }

  // ── Query ──────────────────────────────────────────────────────────────────────────────

  /** `stock.store` — the project store: every lot with derived per-location buckets + ledger. */
  async store(projectId: string, user: AuthUser): Promise<StockStoreDto> {
    await this.begin(projectId, user);
    const lots = await this.prisma.stockLot.findMany({
      where: { projectId },
      include: { transactions: true },
      orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    });
    return { lots: lots.map(serializeLot) };
  }
}
