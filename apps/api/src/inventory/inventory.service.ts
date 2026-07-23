import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  parseQuantity,
  type IssueRecordedPayload, type MaterialIssueDto, type StockBucketsDto, type StockIssuesDto,
  type StockLotDto, type StockStoreDto, type StockTransactedPayload, type StockTransactionDto,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { CoverageRequirement, RequirementCoverage } from './coverage';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../platform/capabilities.service';
import { ProcurementParticipant } from '../procurement/procurement.participant';
import { ActivityParticipant } from '../activities/activity.participant';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { lockProjectReadiness } from '../common/readiness-lock';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, type CommandRunContext, type CommandScope, type CommandTx } from '../platform/commands';
import { resolveActor, type Actor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import type {
  AcceptStockInput, AdjustStockInput, ConsumeStockInput, IssueStockInput, RecordReceiptInput, RejectStockInput,
  ReleaseReservationInput, ReserveStockInput, ReverseStockInput, SiteReturnInput, TransferStockInput,
  VendorReturnInput, WastageInput,
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
 *
 * TASK 5 — store-to-site flows, all through the SAME generic fold:
 *   • `reservation`/`reservation_release` claim/release part of acceptedOnHand for a NAMED
 *     activity ((outside) ↔ `reserved`); the freeAvailable ≥ 0 refusal IS the §C
 *     `freeAvailable ≥ qty` reservation guard.
 *   • `issue` (acceptedOnHand → issuedToActivity) creates the §E-canonical `MaterialIssue`
 *     and CONSUMES the activity's reserved portion first by appending an explicit
 *     `reservation_release` row in the same command — so the §C guard
 *     `qty ≤ freeAvailable + reservedForThisActivity` falls out of the fold refusal.
 *   • `consumption`/`site_return`/`wastage` are recorded AGAINST a MaterialIssue and move
 *     ONLY `issuedToActivity` (the CHECK arms cannot name a store bucket — the §C
 *     double-count guard is structural). Per-issue custody derives by the SAME fold
 *     restricted to the issue's rows; per-activity reservation by the fold restricted to
 *     the activity's rows.
 *   • `transfer` moves acceptedOnHand between two store locations in ONE row (the row's
 *     `storeLocation` is the source, `toStoreLocation` the destination); the source-key
 *     freeAvailable ≥ 0 refusal enforces "reservations do not travel".
 */

const DEFAULT_LOCATION = 'main';

type Bucket = 'quarantine' | 'acceptedOnHand' | 'rejected' | 'reserved' | 'issuedToActivity';
const BUCKETS = ['quarantine', 'acceptedOnHand', 'rejected', 'reserved', 'issuedToActivity'] as const;

type Buckets = Record<Bucket, Prisma.Decimal>;

type TxRow = Prisma.StockTransactionGetPayload<Record<string, never>>;
type LotRow = Prisma.StockLotGetPayload<{ include: { transactions: true } }>;

const ZERO = new Prisma.Decimal(0);

type Movement = Pick<TxRow, 'qty' | 'fromBucket' | 'toBucket'> & {
  storeLocation: string;
  toStoreLocation: string | null;
};

/** A movement carrying its per-activity/per-issue scope (every persisted TxRow satisfies this). */
type ScopedMovement = Movement & { activityId: string | null; issueId: string | null };

/**
 * The §C generic fold AT one stock key: every row moves qty from `fromBucket` to `toBucket`
 * (null = outside the store). A row carrying `toStoreLocation` (a transfer, or a transfer
 * reversal) spans TWO keys: its `fromBucket` side applies at `storeLocation` and its
 * `toBucket` side at `toStoreLocation` — everything else applies both sides at its own key.
 */
function foldBuckets(rows: readonly Movement[], storeLocation: string): Buckets {
  const b = Object.fromEntries(BUCKETS.map((k) => [k, ZERO])) as Buckets;
  for (const row of rows) {
    const fromApplies = row.storeLocation === storeLocation;
    const toApplies = row.toStoreLocation ? row.toStoreLocation === storeLocation : fromApplies;
    if (row.fromBucket && fromApplies) b[row.fromBucket as Bucket] = b[row.fromBucket as Bucket].sub(row.qty);
    if (row.toBucket && toApplies) b[row.toBucket as Bucket] = b[row.toBucket as Bucket].add(row.qty);
  }
  return b;
}

function serializeTx(t: TxRow): StockTransactionDto {
  return {
    id: t.id, lotId: t.lotId, storeLocation: t.storeLocation, type: t.type,
    qty: t.qty.toString(), fromBucket: t.fromBucket, toBucket: t.toBucket,
    poLineId: t.poLineId, commitmentId: t.commitmentId,
    activityId: t.activityId, issueId: t.issueId, toStoreLocation: t.toStoreLocation,
    reversedTxId: t.reversedTxId,
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
  const locations = [...new Set(ordered.flatMap((t) => (t.toStoreLocation ? [t.storeLocation, t.toStoreLocation] : [t.storeLocation])))].sort();
  const perLocation: StockBucketsDto[] = locations.map((loc) => {
    const b = foldBuckets(ordered, loc);
    return {
      storeLocation: loc,
      quarantine: b.quarantine.toString(),
      acceptedOnHand: b.acceptedOnHand.toString(),
      reserved: b.reserved.toString(),
      freeAvailable: b.acceptedOnHand.sub(b.reserved).toString(),
      rejected: b.rejected.toString(),
      issuedToActivity: b.issuedToActivity.toString(),
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

type IssueRow = Prisma.MaterialIssueGetPayload<{
  include: {
    lot: { select: { materialCategory: true; make: true; baseUom: true; specFingerprint: true } };
    transactions: true;
  };
}>;

const ISSUE_INCLUDE = {
  lot: { select: { materialCategory: true, make: true, baseUom: true, specFingerprint: true } },
  transactions: true,
} as const;

/** The §E-canonical issue record + its DERIVED remaining custody (the fold restricted to the
 *  issue's own ledger rows — `issue` minus consumption/site-return/wastage, ± reversals). */
function serializeIssue(issue: IssueRow): MaterialIssueDto {
  const custody = foldBuckets(issue.transactions, issue.storeLocation).issuedToActivity;
  return {
    id: issue.id, lotId: issue.lotId, storeLocation: issue.storeLocation, activityId: issue.activityId,
    qty: issue.qty.toString(), issuedAt: issue.issuedAt.toISOString(), issuedById: issue.issuedById,
    materialCategory: issue.lot.materialCategory, make: issue.lot.make,
    baseUom: issue.lot.baseUom, specFingerprint: issue.lot.specFingerprint,
    remainingCustody: custody.toString(),
  };
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly procurementParticipant: ProcurementParticipant,
    // Task 5 — reservations and issues NAME an activity (§C); the target is validated
    // through the activities participant (the cycle-exempt channel — §G's dependency edge
    // runs activities → inventory in Task 6, so inventory may not READ activities).
    private readonly activityParticipant: ActivityParticipant,
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

  /** Every ledger row of one lot (all locations — a transfer row spans two keys). */
  private async lotRows(tx: CommandTx, projectId: string, lotId: string): Promise<TxRow[]> {
    return tx.stockTransaction.findMany({ where: { projectId, lotId } });
  }

  /**
   * §C rule i — re-derive the affected keys' buckets from the ledger (under the lot lock),
   * apply the candidate movement, and REFUSE if ANY bucket — including the derived
   * `freeAvailable = acceptedOnHand − reserved` — would go negative at ANY touched key.
   * A transfer candidate touches two keys; both are re-derived.
   */
  private assertMovementLegal(rows: readonly Movement[], candidate: Movement): void {
    const touched = candidate.toStoreLocation
      ? [candidate.storeLocation, candidate.toStoreLocation]
      : [candidate.storeLocation];
    for (const loc of touched) {
      const buckets = foldBuckets([...rows, candidate], loc);
      for (const bucket of BUCKETS) {
        if (buckets[bucket].lessThan(0)) {
          throw new ConflictException(
            `Refused: ${bucket} at '${loc}' would go to ${buckets[bucket].toString()} (§C — no bucket may go negative)`,
          );
        }
      }
      const freeAvailable = buckets.acceptedOnHand.sub(buckets.reserved);
      if (freeAvailable.lessThan(0)) {
        throw new ConflictException(
          `Refused: freeAvailable at '${loc}' would go to ${freeAvailable.toString()} (§C — acceptedOnHand − reserved may never go negative)`,
        );
      }
    }
  }

  /** The activity's reserved portion at one stock key (the fold restricted to its rows). */
  private reservedForActivity(rows: readonly ScopedMovement[], storeLocation: string, activityId: string): Prisma.Decimal {
    const scoped = rows.filter((r) => r.activityId === activityId);
    return foldBuckets(scoped, storeLocation).reserved;
  }

  /** The issue's remaining custody (the fold restricted to its rows — §E: consumption,
   *  site-return and wastage are recorded AGAINST the referenced MaterialIssue). */
  private issueCustody(rows: readonly ScopedMovement[], storeLocation: string, issueId: string): Prisma.Decimal {
    const scoped = rows.filter((r) => r.issueId === issueId);
    return foldBuckets(scoped, storeLocation).issuedToActivity;
  }

  /** Append ONE §C ledger row + its audit + `stock.transacted` event (§C rule ii provenance). */
  private async appendLedgerRow(
    tx: CommandTx, ctx: CommandRunContext, actor: Actor, projectId: string,
    data: {
      lotId: string; storeLocation: string; type: string; qty: Prisma.Decimal;
      fromBucket: Bucket | null; toBucket: Bucket | null;
      poLineId?: string; commitmentId?: string; reversedTxId?: string;
      activityId?: string | null; issueId?: string | null; toStoreLocation?: string | null;
      qualityResult?: string; evidenceMediaId?: string; reason?: string;
    },
    auditAction: string,
  ): Promise<{ row: TxRow; event: EmittedEventMeta }> {
    // F1 — every §C ledger row cites its source command (NOT NULL + project-contained FK). All
    // inventory commands run with `synthesizeKeyWhenAbsent`, so `ctx.commandId` is always set;
    // this guard makes the invariant explicit rather than surfacing a raw NOT-NULL error.
    if (!ctx.commandId) throw new Error('inventory ledger append requires a source command (F1 invariant)');
    const row = await tx.stockTransaction.create({
      data: {
        projectId, lotId: data.lotId, storeLocation: data.storeLocation, type: data.type,
        qty: data.qty, fromBucket: data.fromBucket, toBucket: data.toBucket,
        poLineId: data.poLineId ?? null, commitmentId: data.commitmentId ?? null,
        reversedTxId: data.reversedTxId ?? null,
        activityId: data.activityId ?? null, issueId: data.issueId ?? null,
        toStoreLocation: data.toStoreLocation ?? null,
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
      scope, actor, commandType: 'receipts.record', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
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
      scope, actor, commandType: 'receipts.accept', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lot = await this.lockLot(tx, projectId, input.lotId);
        await this.assertEvidenceMedia(tx, projectId, input.evidenceMediaId);
        this.assertMovementLegal(await this.lotRows(tx, projectId, lot.id), { qty, fromBucket: 'quarantine', toBucket: 'acceptedOnHand', storeLocation, toStoreLocation: null });
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
      scope, actor, commandType: 'receipts.reject', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lot = await this.lockLot(tx, projectId, input.lotId);
        await this.assertEvidenceMedia(tx, projectId, input.evidenceMediaId);
        this.assertMovementLegal(await this.lotRows(tx, projectId, lot.id), { qty, fromBucket: 'quarantine', toBucket: 'rejected', storeLocation, toStoreLocation: null });
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
      scope, actor, commandType: 'receipts.vendorReturn', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lot = await this.lockLot(tx, projectId, input.lotId);
        this.assertMovementLegal(await this.lotRows(tx, projectId, lot.id), { qty, fromBucket: 'rejected', toBucket: null, storeLocation, toStoreLocation: null });
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
      scope, actor, commandType: 'stock.adjust', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lot = await this.lockLot(tx, projectId, input.lotId);
        this.assertMovementLegal(await this.lotRows(tx, projectId, lot.id), { qty, fromBucket, toBucket, storeLocation, toStoreLocation: null });
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
      scope, actor, commandType: 'stock.reverse', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
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
        // The exact inverse (DB-trigger-verified): a transfer reverses by SWAPPING the two
        // locations with the buckets unchanged (the fold then moves the quantity back);
        // everything else swaps the buckets in place. The activity/issue scope is copied
        // VERBATIM — the correction stays attributable to the same reservation/custody.
        const inverse: ScopedMovement = target.toStoreLocation
          ? {
              qty: target.qty, fromBucket: target.fromBucket, toBucket: target.toBucket,
              storeLocation: target.toStoreLocation, toStoreLocation: target.storeLocation,
              activityId: target.activityId, issueId: target.issueId,
            }
          : {
              qty: target.qty, fromBucket: target.toBucket, toBucket: target.fromBucket,
              storeLocation: target.storeLocation, toStoreLocation: null,
              activityId: target.activityId, issueId: target.issueId,
            };
        const rows = await this.lotRows(tx, projectId, lot.id);
        this.assertMovementLegal(rows, inverse);
        // Scoped §C re-checks — the store-wide fold cannot see PER-ACTIVITY/PER-ISSUE truth:
        // un-reserving what the activity no longer holds (its reservation was consumed), or
        // pulling back custody the issue already consumed/returned, must refuse even when
        // every store-wide bucket stays non-negative.
        const withInverse: ScopedMovement[] = [...rows, inverse];
        if (target.activityId) {
          const reserved = this.reservedForActivity(withInverse, target.storeLocation, target.activityId);
          if (reserved.lessThan(0)) {
            throw new ConflictException(`Refused: the activity's reserved portion at '${target.storeLocation}' would go to ${reserved.toString()} (§C — the reservation was already consumed)`);
          }
        }
        if (target.issueId) {
          const custody = this.issueCustody(withInverse, target.storeLocation, target.issueId);
          if (custody.lessThan(0)) {
            throw new ConflictException(`Refused: the issue's remaining custody would go to ${custody.toString()} (§C — already consumed, returned or wasted)`);
          }
        }
        if (target.type === 'receipt') {
          await this.procurementParticipant.applyReceiptProgress(tx, projectId, lot.poLineId, target.qty.negated());
        } else if (target.type === 'rejection') {
          await this.procurementParticipant.applyReceiptProgress(tx, projectId, lot.poLineId, target.qty);
        }
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation: inverse.storeLocation, type: 'reversal', qty: target.qty,
          fromBucket: inverse.fromBucket as Bucket | null, toBucket: inverse.toBucket as Bucket | null,
          reversedTxId: target.id, reason: input.reason,
          activityId: target.activityId, issueId: target.issueId, toStoreLocation: inverse.toStoreLocation,
        }, 'stock.reverse');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const target = await this.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, id: input.txId }, select: { lotId: true } });
    return this.readLot(projectId, target.lotId);
  }

  /**
   * `stock.reserve` — §C: claim part of a store key's FREE pool for a NAMED activity
   * ((outside) → `reserved`). The §C guard `freeAvailable ≥ qty` IS the fold refusal: the
   * candidate row drives `freeAvailable = acceptedOnHand − reserved` negative exactly when
   * the free pool is short. The activity target is validated through the activities
   * participant (the cycle-exempt channel — inventory may not READ activities).
   */
  async reserve(projectId: string, input: ReserveStockInput, user: AuthUser, idempotencyKey?: string): Promise<StockLotDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const storeLocation = input.storeLocation ?? DEFAULT_LOCATION;
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'stock.reserve', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const activity = await this.activityParticipant.materialTarget(tx, { projectId, activityId: input.activityId });
        if (!activity) throw new NotFoundException('Activity not found in this project');
        const lot = await this.lockLot(tx, projectId, input.lotId);
        this.assertMovementLegal(await this.lotRows(tx, projectId, lot.id), { qty, fromBucket: null, toBucket: 'reserved', storeLocation, toStoreLocation: null });
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation, type: 'reservation', qty,
          fromBucket: null, toBucket: 'reserved', activityId: activity.id,
        }, 'stock.reserve');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readLot(projectId, input.lotId);
  }

  /**
   * `stock.release` — §C: return part of an activity's reserved portion to the free pool
   * (`reserved` → (outside); cancel / revise / no-longer-needed). Guarded by the ACTIVITY's
   * scoped fold — one activity can never release another activity's reservation.
   */
  async release(projectId: string, input: ReleaseReservationInput, user: AuthUser, idempotencyKey?: string): Promise<StockLotDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const storeLocation = input.storeLocation ?? DEFAULT_LOCATION;
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'stock.release', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lot = await this.lockLot(tx, projectId, input.lotId);
        const rows = await this.lotRows(tx, projectId, lot.id);
        const reserved = this.reservedForActivity(rows, storeLocation, input.activityId);
        if (reserved.lessThan(qty)) {
          throw new ConflictException(`Refused: the activity holds ${reserved.toString()} reserved at '${storeLocation}' — cannot release ${qty.toString()}`);
        }
        this.assertMovementLegal(rows, { qty, fromBucket: 'reserved', toBucket: null, storeLocation, toStoreLocation: null });
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation, type: 'reservation_release', qty,
          fromBucket: 'reserved', toBucket: null, activityId: input.activityId, reason: input.note,
        }, 'stock.release');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readLot(projectId, input.lotId);
  }

  /**
   * `stock.issue` — §C/§E: material physically LEAVES the store for a named activity. ONE
   * command, three facts on one transaction:
   *   1. the §E-canonical `MaterialIssue` record (what left, for whom, from where, by whom);
   *   2. the activity's reserved portion is consumed FIRST — an explicit, attributable
   *      `reservation_release` ledger row for min(reservedForThisActivity, qty);
   *   3. the `issue` ledger row (acceptedOnHand → issuedToActivity).
   * The §C guard `qty ≤ freeAvailable + reservedForThisActivity` IS the fold refusal after
   * the release row: what the release freed plus the free pool must cover the issue.
   * An issue is NOT a delivery (§E) — nothing is copied into daily-log rows; the Daily-Log
   * screen reads issued material through `stock.issues`.
   */
  async issue(projectId: string, input: IssueStockInput, user: AuthUser, idempotencyKey?: string): Promise<MaterialIssueDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const storeLocation = input.storeLocation ?? DEFAULT_LOCATION;
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'stock.issue', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const activity = await this.activityParticipant.materialTarget(tx, { projectId, activityId: input.activityId });
        if (!activity) throw new NotFoundException('Activity not found in this project');
        const lot = await this.lockLot(tx, projectId, input.lotId);
        const rows = await this.lotRows(tx, projectId, lot.id);
        const events: EmittedEventMeta[] = [];
        const issue = await tx.materialIssue.create({
          data: { projectId, lotId: lot.id, storeLocation, activityId: activity.id, qty, issuedById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'stock.issue', entity: 'MaterialIssue', entityId: issue.id });
        const reserved = this.reservedForActivity(rows, storeLocation, activity.id);
        const releaseQty = Prisma.Decimal.min(reserved, qty);
        const withRelease: ScopedMovement[] = [...rows];
        if (releaseQty.greaterThan(0)) {
          const { row: releaseRow, event: releaseEvent } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
            lotId: lot.id, storeLocation, type: 'reservation_release', qty: releaseQty,
            fromBucket: 'reserved', toBucket: null, activityId: activity.id, reason: 'consumed by issue',
          }, 'stock.issue');
          withRelease.push(releaseRow);
          events.push(releaseEvent);
        }
        this.assertMovementLegal(withRelease, { qty, fromBucket: 'acceptedOnHand', toBucket: 'issuedToActivity', storeLocation, toStoreLocation: null });
        const { event: issueEvent } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation, type: 'issue', qty,
          fromBucket: 'acceptedOnHand', toBucket: 'issuedToActivity',
          activityId: activity.id, issueId: issue.id, reason: input.note,
        }, 'stock.issue');
        events.push(issueEvent);
        const payload: IssueRecordedPayload = { issueId: issue.id, activityId: activity.id, locationId: storeLocation, qty: qty.toString() };
        events.push(await emitEvent(tx, {
          projectId, actor, eventType: 'issue.recorded', entityType: 'MaterialIssue', entityId: issue.id,
          payload: payload as unknown as Prisma.InputJsonValue, effectKey: 'issue.recorded', dispatch: {},
        }));
        return { resultRef: issue.id, events };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readIssue(projectId, outcome.resultRef);
  }

  /**
   * `stock.consume` — §C: material recorded as USED for the work, AGAINST the referenced
   * issue (§E): `issuedToActivity` ↓ ONLY. The double-count guard is structural — the CHECK
   * arm cannot name a store bucket, so consumption can never touch store on-hand.
   */
  async consume(projectId: string, input: ConsumeStockInput, user: AuthUser, idempotencyKey?: string): Promise<MaterialIssueDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'stock.consume', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const issue = await this.lockIssue(tx, projectId, input.issueId);
        const lot = await this.lockLot(tx, projectId, issue.lotId);
        const rows = await this.lotRows(tx, projectId, lot.id);
        this.assertIssueCustodyCovers(rows, issue, qty, 'consume');
        this.assertMovementLegal(rows, { qty, fromBucket: 'issuedToActivity', toBucket: null, storeLocation: issue.storeLocation, toStoreLocation: null });
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation: issue.storeLocation, type: 'consumption', qty,
          fromBucket: 'issuedToActivity', toBucket: null,
          activityId: issue.activityId, issueId: issue.id, reason: input.note,
        }, 'stock.consume');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readIssue(projectId, input.issueId);
  }

  /**
   * `stock.siteReturn` — §C: unused material comes BACK to the store from the site, against
   * the referenced issue (§E): `issuedToActivity` ↓ → `acceptedOnHand` ↑ at the issue's key.
   */
  async siteReturn(projectId: string, input: SiteReturnInput, user: AuthUser, idempotencyKey?: string): Promise<MaterialIssueDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'stock.siteReturn', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const issue = await this.lockIssue(tx, projectId, input.issueId);
        const lot = await this.lockLot(tx, projectId, issue.lotId);
        const rows = await this.lotRows(tx, projectId, lot.id);
        this.assertIssueCustodyCovers(rows, issue, qty, 'return');
        this.assertMovementLegal(rows, { qty, fromBucket: 'issuedToActivity', toBucket: 'acceptedOnHand', storeLocation: issue.storeLocation, toStoreLocation: null });
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation: issue.storeLocation, type: 'site_return', qty,
          fromBucket: 'issuedToActivity', toBucket: 'acceptedOnHand',
          activityId: issue.activityId, issueId: issue.id, reason: input.note,
        }, 'stock.siteReturn');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readIssue(projectId, input.issueId);
  }

  /**
   * `stock.wastage` — §C: material LOST at site, against the referenced issue (§E):
   * `issuedToActivity` ↓ with a REASON and photographic EVIDENCE, pmc authority (route
   * policy `stock.adjust`). The evidence media is thereafter delete-sealed (Task 4).
   */
  async wastage(projectId: string, input: WastageInput, user: AuthUser, idempotencyKey?: string): Promise<MaterialIssueDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'stock.wastage', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const issue = await this.lockIssue(tx, projectId, input.issueId);
        const lot = await this.lockLot(tx, projectId, issue.lotId);
        await this.assertEvidenceMedia(tx, projectId, input.evidenceMediaId);
        const rows = await this.lotRows(tx, projectId, lot.id);
        this.assertIssueCustodyCovers(rows, issue, qty, 'record as wastage');
        this.assertMovementLegal(rows, { qty, fromBucket: 'issuedToActivity', toBucket: null, storeLocation: issue.storeLocation, toStoreLocation: null });
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation: issue.storeLocation, type: 'wastage', qty,
          fromBucket: 'issuedToActivity', toBucket: null,
          activityId: issue.activityId, issueId: issue.id,
          reason: input.reason, evidenceMediaId: input.evidenceMediaId,
        }, 'stock.wastage');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readIssue(projectId, input.issueId);
  }

  /**
   * `stock.transfer` — §C: accepted material moves between two STORE locations in ONE ledger
   * row (`storeLocation` = source, `toStoreLocation` = destination, buckets
   * acceptedOnHand → acceptedOnHand — the fold applies each side at its own key).
   * Reservations DO NOT travel: they stay at the source key, so the source's
   * `freeAvailable ≥ 0` refusal is exactly the §C `freeAvailable@A ≥ qty` guard.
   */
  async transfer(projectId: string, input: TransferStockInput, user: AuthUser, idempotencyKey?: string): Promise<StockLotDto> {
    const { actor, scope } = await this.begin(projectId, user);
    const qty = this.parseQty(input.qty, 'qty');
    const storeLocation = input.storeLocation ?? DEFAULT_LOCATION;
    if (input.toStoreLocation === storeLocation) {
      throw new BadRequestException('A transfer moves between two DIFFERENT store locations');
    }
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'stock.transfer', idempotencyKey, requestHash: hashRequest(input), synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lot = await this.lockLot(tx, projectId, input.lotId);
        this.assertMovementLegal(await this.lotRows(tx, projectId, lot.id), {
          qty, fromBucket: 'acceptedOnHand', toBucket: 'acceptedOnHand',
          storeLocation, toStoreLocation: input.toStoreLocation,
        });
        const { row, event } = await this.appendLedgerRow(tx, ctx, actor, projectId, {
          lotId: lot.id, storeLocation, type: 'transfer', qty,
          fromBucket: 'acceptedOnHand', toBucket: 'acceptedOnHand',
          toStoreLocation: input.toStoreLocation, reason: input.note,
        }, 'stock.transfer');
        return { resultRef: row.id, events: [event] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readLot(projectId, input.lotId);
  }

  /** The issue a consumption/site-return/wastage is recorded AGAINST (§E). */
  private async lockIssue(
    tx: CommandTx, projectId: string, issueId: string,
  ): Promise<{ id: string; lotId: string; storeLocation: string; activityId: string }> {
    const issue = await tx.materialIssue.findFirst({
      where: { projectId, id: issueId },
      select: { id: true, lotId: true, storeLocation: true, activityId: true },
    });
    if (!issue) throw new NotFoundException('Material issue not found in this project');
    return issue;
  }

  /** §E custody guard: the referenced issue's remaining custody must cover the quantity. */
  private assertIssueCustodyCovers(
    rows: readonly TxRow[], issue: { id: string; storeLocation: string }, qty: Prisma.Decimal, verb: string,
  ): void {
    const custody = this.issueCustody(rows, issue.storeLocation, issue.id);
    if (custody.lessThan(qty)) {
      throw new ConflictException(`Refused: the issue's remaining custody is ${custody.toString()} — cannot ${verb} ${qty.toString()} (§E — recorded against the referenced issue)`);
    }
  }

  private async readIssue(projectId: string, issueId: string): Promise<MaterialIssueDto> {
    const issue = await this.prisma.materialIssue.findFirst({ where: { projectId, id: issueId }, include: ISSUE_INCLUDE });
    if (!issue) throw new NotFoundException('Material issue not found in this project');
    return serializeIssue(issue);
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

  /**
   * `stock.issues` — the §E Daily-Log read: every `MaterialIssue` (what LEFT the store, for
   * which activity) with its lot's §B identity joined for display and DERIVED remaining
   * custody. The Daily-Log SCREEN composes this alongside its own observations — nothing is
   * copied into daily-log rows.
   */
  async issues(projectId: string, user: AuthUser): Promise<StockIssuesDto> {
    await this.begin(projectId, user);
    const rows = await this.prisma.materialIssue.findMany({
      where: { projectId },
      include: ISSUE_INCLUDE,
      orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
    });
    return { issues: rows.map(serializeIssue) };
  }

  /**
   * Phase 3 Task 6 (§A/§G) — the CANONICAL material-coverage authority. Called by activities
   * (`activities.start` and the readiness projection consumer) INSIDE the caller's transaction,
   * AFTER it has taken `lockProjectReadiness` — so the answer is a canonical physical-truth
   * fact, never a projection. NOT a controller surface (no capability `begin`): the activities
   * caller already gated on the pilot capability.
   *
   * Per requirement, coverage = reserved-for-this-activity + already-issued-to-this-activity of
   * stock whose fingerprint the requirement accepts (its own OR an approved substitution — the
   * caller resolves `acceptableFingerprints`, keeping the substitution table activities-owned)
   * at the requirement's base UOM. Issued stock COUNTS as coverage for its activity (the §A
   * Task-1 GO guardrail — issuing reserved stock must never make the activity unready). A
   * covered ≥ required requirement is `ready`; a shortfall with a confirmed covering commitment
   * (procurement, §A at-risk) is `at-risk`; a shortfall with none is `blocked`.
   */
  async coverageFor(
    tx: CommandTx,
    projectId: string,
    requirements: readonly CoverageRequirement[],
  ): Promise<RequirementCoverage[]> {
    if (requirements.length === 0) return [];

    const acceptable = new Set(requirements.flatMap((r) => r.acceptableFingerprints));
    const activityIds = [...new Set(requirements.map((r) => r.activityId))];

    const [lots, issues, commitments] = await Promise.all([
      acceptable.size === 0
        ? Promise.resolve([])
        : tx.stockLot.findMany({
            where: { projectId, specFingerprint: { in: [...acceptable] } },
            select: { specFingerprint: true, baseUom: true, transactions: true },
          }),
      tx.materialIssue.findMany({
        where: { projectId, activityId: { in: activityIds } },
        select: {
          activityId: true,
          storeLocation: true,
          lot: { select: { specFingerprint: true, baseUom: true } },
          transactions: true,
        },
      }),
      // one batched procurement read (§G inventory → procurement) for the at-risk determination
      this.procurementParticipant.coveringCommitments(
        tx,
        projectId,
        requirements.map((r) => ({ requirementId: r.requirementId, revision: r.revision })),
      ),
    ]);

    return requirements.map((req) => {
      const fps = new Set(req.acceptableFingerprints);
      let covered = ZERO;
      // reserved for THIS activity, matching fingerprint + base UOM, summed across every store key
      for (const lot of lots) {
        if (!fps.has(lot.specFingerprint) || lot.baseUom !== req.baseUom) continue;
        const rows = lot.transactions as ScopedMovement[];
        const locations = new Set(
          rows.flatMap((t) => (t.toStoreLocation ? [t.storeLocation, t.toStoreLocation] : [t.storeLocation])),
        );
        for (const loc of locations) covered = covered.add(this.reservedForActivity(rows, loc, req.activityId));
      }
      // already ISSUED to THIS activity (remaining custody) counts as coverage (§A guardrail)
      for (const issue of issues) {
        if (issue.activityId !== req.activityId) continue;
        if (!fps.has(issue.lot.specFingerprint) || issue.lot.baseUom !== req.baseUom) continue;
        covered = covered.add(foldBuckets(issue.transactions as ScopedMovement[], issue.storeLocation).issuedToActivity);
      }

      const shortfall = req.requiredQty.sub(covered);
      const base = {
        requirementId: req.requirementId,
        revision: req.revision,
        activityId: req.activityId,
        requiredQty: req.requiredQty.toString(),
        coveredQty: covered.toString(),
      };
      if (shortfall.lessThanOrEqualTo(0)) {
        return {
          ...base,
          shortfall: '0',
          verdict: 'ready' as const,
          commitmentPromisedDate: null,
          reason: `Covered ${covered.toString()} of ${req.requiredQty.toString()} ${req.baseUom} (reserved + issued)`,
        };
      }
      const promised = commitments.get(`${req.requirementId}#${req.revision}`) ?? null;
      if (promised) {
        return {
          ...base,
          shortfall: shortfall.toString(),
          verdict: 'at-risk' as const,
          commitmentPromisedDate: promised,
          reason: `Short by ${shortfall.toString()} ${req.baseUom}; covering delivery promised ${promised}`,
        };
      }
      return {
        ...base,
        shortfall: shortfall.toString(),
        verdict: 'blocked' as const,
        commitmentPromisedDate: null,
        reason: `Short by ${shortfall.toString()} ${req.baseUom} with no covering delivery commitment`,
      };
    });
  }
}
