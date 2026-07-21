import { INVENTORY_COMMANDS, INVENTORY_QUERIES, type ModuleManifest } from '@vitan/shared';

/**
 * Phase 3 Task 4 — the INVENTORY module (plan §§C/G/H): physical material truth. Immutable
 * received batches (`StockLot`, each carrying its full §B MaterialSpecificationRef) and the
 * append-only §C stock ledger (`StockTransaction`) every bucket derives from — receipts into
 * quarantine, quality acceptance/rejection, vendor returns, audited adjustments and exact
 * reversal corrections. NO current-quantity column exists anywhere; every balance-affecting
 * command re-derives its stock key's buckets under the lot row FOR UPDATE and refuses any
 * negative bucket (§C rule i).
 *
 * Every project surface is capability-gated (§D). §G edges: `inventory → procurement` is a
 * WORKFLOW-PARTICIPANT edge, not a read edge — the receipt command invokes the
 * procurement-owned `ProcurementParticipant.lockPoLineForReceipt` / `applyReceiptProgress`
 * inside its transaction (§F bound-3 under the PO-line FOR UPDATE lock + the received-
 * progress fact). In REVERSE, the media delete command invokes this module's
 * `InventoryParticipant.assertMediaDisposable` (declared by the media manifest): ledger
 * evidence is immutable, so cited photos are not deletable. Authority per the §H matrix:
 * receipt/accept/reject/vendor-return are pmc/engineer; adjustment + reversal are pmc; the
 * store read is pmc/engineer.
 */
export const inventoryManifest: ModuleManifest = {
  id: 'inventory',
  title: 'Store & Stock Ledger',
  kind: 'domain',
  ownsModels: ['stockLot', 'stockTransaction'],
  readEncapsulated: ['stockLot', 'stockTransaction'],
  // No foreign READS: the receipt's PO-line facts arrive through the procurement participant
  // (a workflow edge, §G), never a direct table read.
  dependsOn: [],
  workflowParticipants: ['procurement'],
  producesEvents: ['stock.transacted'],
  consumesEvents: [],
  commands: [...INVENTORY_COMMANDS],
  queries: [...INVENTORY_QUERIES],
  routes: [
    'POST /projects/:projectId/stock/receipts',
    'POST /projects/:projectId/stock/accept',
    'POST /projects/:projectId/stock/reject',
    'POST /projects/:projectId/stock/vendor-return',
    'POST /projects/:projectId/stock/adjust',
    'POST /projects/:projectId/stock/reverse',
  ],
  permissions: ['pmc', 'engineer'],
};
