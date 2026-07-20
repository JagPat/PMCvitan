/**
 * Phase 3 Task 4 — the INVENTORY module contract (shared, runtime-importable on both sides).
 *
 * Inventory owns PHYSICAL TRUTH (plan §G): stock lots and the append-only §C stock ledger.
 * There is NO current-quantity column anywhere — every bucket (`quarantine`,
 * `acceptedOnHand`, `reserved`, `rejected`, `issuedToActivity`, and the derived
 * `freeAvailable = acceptedOnHand − reserved`) is derived by folding the ledger for one
 * stock key `(projectId, storeLocation, stockLotId)`. Every balance-affecting command
 * re-derives the affected key's buckets inside its transaction while holding the lot row
 * `FOR UPDATE`, and REFUSES any transaction that would drive ANY bucket negative (§C rule i).
 *
 * Every ledger row records its source action — the `CommandExecution` ledger row id — so a
 * replayed command appends nothing (§C rule ii). No ledger row is ever updated or deleted;
 * corrections append explicit REVERSAL transactions referencing the reversed row (§C rule
 * iii).
 *
 * RECEIPT (§F bound 3): a receipt references its PO line + delivery commitment through the
 * transaction-bound `ProcurementParticipant` (§G — the owner-aligned pattern: procurement
 * code validates and FOR-UPDATE-locks the PO line and appends the procurement-owned
 * received-progress fact in the SAME transaction). Receipt quantity is entered in the PO
 * line's PURCHASE units and converted to base via the PO's FROZEN `conversionToBase`;
 * `Σ (accepted + quarantined) per PO line ≤ ordered + approvedOverage` always.
 *
 * Task 4 carries receipts/acceptance/rejection/vendor-return/adjustment/reversal ONLY.
 * Reservations, transfers, issues, consumption, site-returns and wastage are Task 5.
 */

/** The inventory module's state-changing commands (must equal the manifest `commands`). */
export const INVENTORY_COMMANDS = [
  'receipts.record',
  'receipts.accept',
  'receipts.reject',
  'receipts.vendorReturn',
  'stock.adjust',
  'stock.reverse',
] as const;
export type InventoryCommand = (typeof INVENTORY_COMMANDS)[number];

/** The inventory module's read queries (must equal the manifest `queries`). */
export const INVENTORY_QUERIES = ['stock.store'] as const;
export type InventoryQuery = (typeof INVENTORY_QUERIES)[number];

/** The §C ledger's transaction vocabulary shipped in Task 4 (Task 5 extends it). */
export const STOCK_TRANSACTION_TYPES = [
  'receipt',
  'acceptance',
  'rejection',
  'vendor_return',
  'adjustment',
  'reversal',
] as const;
export type StockTransactionType = (typeof STOCK_TRANSACTION_TYPES)[number];

/** The §C buckets a Task-4 ledger row may move quantity between. */
export const STOCK_BUCKETS = ['quarantine', 'acceptedOnHand', 'rejected'] as const;
export type StockBucket = (typeof STOCK_BUCKETS)[number];

/** One stock key's derived §C buckets — NEVER stored, always folded from the ledger. */
export interface StockBucketsDto {
  readonly storeLocation: string;
  readonly quarantine: string; // Decimal strings, numeric(18,6)-exact, base UOM
  readonly acceptedOnHand: string;
  readonly reserved: string; // 0 until Task 5
  readonly freeAvailable: string; // derived: acceptedOnHand − reserved
  readonly rejected: string;
  readonly issuedToActivity: string; // 0 until Task 5
}

/** One append-only §C ledger row. */
export interface StockTransactionDto {
  readonly id: string;
  readonly lotId: string;
  readonly storeLocation: string;
  readonly type: string; // StockTransactionType
  readonly qty: string; // base UOM, > 0
  readonly fromBucket: string | null;
  readonly toBucket: string | null;
  readonly poLineId: string | null; // receipt rows only
  readonly commitmentId: string | null; // receipt rows only
  readonly reversedTxId: string | null; // reversal rows only — the row this one reverses
  readonly qualityResult: string | null; // acceptance rows
  readonly evidenceMediaId: string | null; // acceptance/rejection rows
  readonly reason: string | null;
  readonly sourceCommandId: string | null; // the CommandExecution ledger row (§C rule ii)
  readonly recordedAt: string;
  readonly recordedById: string;
}

/**
 * One immutable received batch. The lot carries its full §B `MaterialSpecificationRef` —
 * technical identity + decision provenance — frozen from the PINNED requirement revision the
 * received PO line executes (selection is match-only until substitutions land).
 */
export interface StockLotDto {
  readonly id: string;
  readonly poLineId: string; // provenance: the PO line this batch was received against
  readonly commitmentId: string; // provenance: the delivery commitment fulfilled
  readonly requirementId: string; // the PO line's frozen requirement pin
  readonly revision: number;
  readonly materialCategory: string; // §B technical identity, verbatim
  readonly make: string;
  readonly grade: string;
  readonly normalizedAttributes: string;
  readonly baseUom: string;
  readonly specFingerprint: string;
  readonly decisionId: string | null; // §B provenance (all-null = manual spec)
  readonly decisionVersion: number | null;
  readonly optionKey: string | null;
  readonly receivedAt: string;
  readonly receivedById: string;
  readonly locations: readonly StockBucketsDto[]; // derived buckets per store location
  readonly transactions: readonly StockTransactionDto[]; // the lot's full ledger, ordered
}

/** The `stock.store` query result — the project store view. */
export interface StockStoreDto {
  readonly lots: readonly StockLotDto[];
}

/** The `stock.transacted` event payload (§G catalog: txId, type, stockKey, qty, sourceCommandId). */
export interface StockTransactedPayload {
  readonly txId: string;
  readonly type: string; // StockTransactionType
  readonly stockKey: {
    readonly projectId: string;
    readonly storeLocation: string;
    readonly stockLotId: string;
  };
  readonly qty: string;
  readonly sourceCommandId: string | null;
}
