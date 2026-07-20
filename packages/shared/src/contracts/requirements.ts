/**
 * Phase 3 Task 1 (correction) — the SHARED requirement contract: the module-owned DTO and the
 * complete requirement event payload, published through `@vitan/shared` so the API, the web
 * gateway and every event consumer model the SAME shape (review finding 4).
 */

/** The complete material specification reference carried by a requirement revision:
 *  TECHNICAL identity (fingerprinted, §B) + AUTHORITATIVE decision provenance (server-resolved
 *  approved version + selected option, or all-null for a manual specification). */
export interface RequirementSpecRef {
  readonly materialCategory: string;
  readonly make: string;
  readonly grade: string;
  readonly normalizedAttributes: string;
  readonly baseUom: string;
  readonly specFingerprint: string;
  readonly decisionId: string | null;
  readonly decisionVersion: number | null;
  readonly optionKey: string | null;
}

/** One requirement REVISION as served by the module read and returned by every command. */
export interface RequirementDto {
  readonly id: string; // revision row id
  readonly requirementId: string; // the stable root identity
  readonly revision: number;
  readonly activityId: string;
  readonly type: string; // 'material' in Phase 3 Task 1
  readonly spec: RequirementSpecRef | null; // null for future non-material types
  readonly qty: string; // decimal string, numeric(18,6)-exact
  readonly baseUom: string;
  readonly requiredBy: string; // ISO civil date (DATE column)
  readonly responsibleId: string | null;
  readonly criticality: string;
  readonly tolerance: string | null;
  readonly status: string; // 'open' | 'cancelled'
  readonly createdAt: string;
  readonly createdById: string;
}

/** The module list read: each requirement's CURRENT head revision + its revision count. */
export interface RequirementListItem extends RequirementDto {
  readonly revisions: number;
}

/** The COMPLETE `requirement.created|revised|cancelled` event payload (Phase 3 event catalog):
 *  identity, revision, activity, the full spec reference, quantity, unit and the needed-by date. */
export interface RequirementEventPayload {
  readonly requirementId: string;
  readonly revision: number;
  readonly activityId: string;
  readonly specRef: RequirementSpecRef | null;
  readonly qty: string;
  readonly baseUom: string;
  readonly requiredBy: string; // ISO civil date
  readonly status: string;
  readonly reason?: string; // cancellation reason
}
