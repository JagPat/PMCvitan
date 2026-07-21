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
 * TASK 5 — the store-to-site §C flows. A `reservation` claims part of `acceptedOnHand`
 * for a NAMED activity (guard: `freeAvailable ≥ qty`); an `issue` is the ONLY transaction
 * that takes on-hand stock out of the store for work — it creates the §E-canonical
 * `MaterialIssue` record (what LEFT THE STORE), consumes the activity's reserved portion
 * first (an explicit `reservation_release` row appends in the same command), and is
 * guarded by `qty ≤ freeAvailable + reservedForThisActivity`. `consumption`, `site_return`
 * and `wastage` are recorded AGAINST the referenced `MaterialIssue` (§E) and move ONLY
 * `issuedToActivity` — consumption NEVER touches a store bucket (the double-count guard).
 * A `transfer` moves acceptedOnHand between store locations of the SAME project
 * (guard: `freeAvailable ≥ qty` at the source — reservations do not travel). The Daily Log
 * screen reads issued material through THIS module's `stock.issues` query — nothing is
 * ever copied into the daily-log's `SiteMaterial` observations (§E).
 */

/** The inventory module's state-changing commands (must equal the manifest `commands`). */
export const INVENTORY_COMMANDS = [
  'receipts.record',
  'receipts.accept',
  'receipts.reject',
  'receipts.vendorReturn',
  'stock.adjust',
  'stock.reverse',
  'stock.reserve',
  'stock.release',
  'stock.issue',
  'stock.consume',
  'stock.siteReturn',
  'stock.wastage',
  'stock.transfer',
] as const;
export type InventoryCommand = (typeof INVENTORY_COMMANDS)[number];

/** The inventory module's read queries (must equal the manifest `queries`). */
export const INVENTORY_QUERIES = ['stock.store', 'stock.issues'] as const;
export type InventoryQuery = (typeof INVENTORY_QUERIES)[number];

/** The §C ledger's transaction vocabulary (Tasks 4 + 5). */
export const STOCK_TRANSACTION_TYPES = [
  'receipt',
  'acceptance',
  'rejection',
  'vendor_return',
  'adjustment',
  'reversal',
  'reservation',
  'reservation_release',
  'issue',
  'consumption',
  'site_return',
  'wastage',
  'transfer',
] as const;
export type StockTransactionType = (typeof STOCK_TRANSACTION_TYPES)[number];

/** The §C buckets a ledger row may move quantity between (Tasks 4 + 5). */
export const STOCK_BUCKETS = ['quarantine', 'acceptedOnHand', 'rejected', 'reserved', 'issuedToActivity'] as const;
export type StockBucket = (typeof STOCK_BUCKETS)[number];

/** One stock key's derived §C buckets — NEVER stored, always folded from the ledger. */
export interface StockBucketsDto {
  readonly storeLocation: string;
  readonly quarantine: string; // Decimal strings, numeric(18,6)-exact, base UOM
  readonly acceptedOnHand: string;
  readonly reserved: string;
  readonly freeAvailable: string; // derived: acceptedOnHand − reserved
  readonly rejected: string;
  readonly issuedToActivity: string;
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
  readonly activityId: string | null; // reservation/release/issue/consumption/site-return/wastage rows
  readonly issueId: string | null; // the §E MaterialIssue: the issue row itself + custody movements against it
  readonly toStoreLocation: string | null; // transfer rows only — the destination stock key
  readonly reversedTxId: string | null; // reversal rows only — the row this one reverses
  readonly qualityResult: string | null; // acceptance rows
  readonly evidenceMediaId: string | null; // acceptance/rejection/wastage rows
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

/**
 * The §E-canonical record of material that LEFT THE STORE for an activity. Immutable —
 * corrections reverse the underlying ledger rows (§C rule iii); the issue record itself is
 * never edited or deleted, so a daily-log reference to it can never be orphaned. The custody
 * breakdown is DERIVED per issue from the ledger (`issuedToActivity` fold filtered by issue).
 */
export interface MaterialIssueDto {
  readonly id: string;
  readonly lotId: string;
  readonly storeLocation: string;
  readonly activityId: string;
  readonly qty: string; // base UOM
  readonly issuedAt: string;
  readonly issuedById: string;
  // the lot's §B identity, joined for display (never copied into daily-log rows — §E)
  readonly materialCategory: string;
  readonly make: string;
  readonly baseUom: string;
  readonly specFingerprint: string;
  // derived custody: qty − consumed − returned − wasted (± reversals), never below 0
  readonly remainingCustody: string;
}

/** The `stock.issues` query result — the §E Daily-Log read of issued material. */
export interface StockIssuesDto {
  readonly issues: readonly MaterialIssueDto[];
}

/** The `issue.recorded` event payload (§G catalog: issueId, activityId, locationId, qty).
 *  `locationId` carries the §C stock key's store location. */
export interface IssueRecordedPayload {
  readonly issueId: string;
  readonly activityId: string;
  readonly locationId: string;
  readonly qty: string;
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
