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
 *
 * Task 5 — store-to-site flows (§§C/E): reservations, issues (the §E-canonical
 * `MaterialIssue` — "an issue is NOT a delivery"), consumption/site-return/wastage against
 * the referenced issue, and location transfers. `inventory → activities` is a SECOND
 * workflow-participant edge, not a read edge — reserve/issue validate their named activity
 * through `ActivityParticipant.materialTarget` inside the command transaction (the
 * cycle-exempt channel: §G's read edge runs activities → inventory in Task 6, so an
 * inventory → activities read edge would close a cycle). The `stock/issues` read serves the
 * §E Daily-Log screen (composed client-side — nothing copied into daily-log rows).
 */
export const inventoryManifest: ModuleManifest = {
  id: 'inventory',
  title: 'Store & Stock Ledger',
  kind: 'domain',
  ownsModels: ['stockLot', 'stockTransaction', 'materialIssue'],
  readEncapsulated: ['stockLot', 'stockTransaction', 'materialIssue'],
  // No foreign READS: the receipt's PO-line facts arrive through the procurement participant
  // and the reserve/issue activity target through the activities participant (workflow
  // edges, §G) — never a direct table read.
  dependsOn: [],
  workflowParticipants: ['procurement', 'activities'],
  producesEvents: ['stock.transacted', 'issue.recorded'],
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
    'POST /projects/:projectId/stock/reserve',
    'POST /projects/:projectId/stock/release',
    'POST /projects/:projectId/stock/issue',
    'POST /projects/:projectId/stock/consume',
    'POST /projects/:projectId/stock/site-return',
    'POST /projects/:projectId/stock/wastage',
    'POST /projects/:projectId/stock/transfer',
  ],
  permissions: ['pmc', 'engineer'],
};
