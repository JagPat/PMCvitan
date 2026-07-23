import type {
  MaterialReadinessResult,
  RequirementListItem,
  RequisitionDto,
  PurchaseOrderDto,
  StockLotDto,
  MaterialIssueDto,
} from '@vitan/shared';

/**
 * Phase 3 Task 7 — the pilot MATERIALS bundle: the module-owned reads the Materials hub renders
 * (requirements → procurement → deliveries → inventory → reservations → issues → readiness). This is
 * GREENFIELD module data (never in the legacy snapshot), so it is module-query-only: `loadMaterials()`
 * fetches it together, and ONLY when the active project has the `materials` capability. `null` until it
 * loads (or on a non-pilot project, where the Materials surfaces are absent from nav entirely).
 */
export interface MaterialsView {
  readiness: MaterialReadinessResult;
  requirements: RequirementListItem[];
  requisitions: RequisitionDto[];
  purchaseOrders: PurchaseOrderDto[];
  stock: StockLotDto[];
  issues: MaterialIssueDto[];
}
