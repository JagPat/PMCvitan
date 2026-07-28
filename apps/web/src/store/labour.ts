import type {
  LabourReadinessDto,
  LabourWorkforceDto,
  LabourCatalogDto,
  LabourRequisitionDto,
  LabourPurchaseOrderDto,
  CapacityCommitmentDto,
  LabourCapacityDto,
  LabourPresenceDto,
  RequirementListItem,
} from '@vitan/shared';
import type { LabourProductivityResult } from '@/data/apiGateway';

/**
 * Phase 4 Task 6 (§J) — the labour twin of `MaterialsView`: the bundle `loadLabour()` fetches
 * together when the project has the `labour` capability. Every member is a greenfield
 * module-query read (never in the legacy snapshot). `requirements` is the SHARED type-neutral
 * list (the hub's demand tab filters to rows carrying a `labourSpec`).
 */
export interface LabourView {
  readiness: LabourReadinessDto;
  requirements: readonly RequirementListItem[];
  workforce: LabourWorkforceDto;
  catalog: LabourCatalogDto;
  requisitions: readonly LabourRequisitionDto[];
  purchaseOrders: readonly LabourPurchaseOrderDto[];
  commitments: readonly CapacityCommitmentDto[];
  capacity: LabourCapacityDto;
  presence: LabourPresenceDto;
  productivity: LabourProductivityResult;
  /** Codex F1 — every fingerprint each worker's own (trade, skills) identity can satisfy,
   *  computed once per load with the shared `computeLabourSpecFingerprint` so the allocate
   *  picker offers only workers the server's coverage rule would actually count. */
  workerFingerprints: Readonly<Record<string, readonly string[]>>;
}
