/**
 * Phase 3 Task 1 (correction) — the SHARED requirement contract: the module-owned DTO and the
 * complete requirement event payload, published through `@vitan/shared` so the API, the web
 * gateway and every event consumer model the SAME shape (review finding 4).
 *
 * Phase 4 Task 1 — the requirement is TYPE-ROUTED: a `type='material'` revision carries a
 * material `spec`; a `type='labour'` revision carries a Labour-owned `labourSpec` instead
 * (the DB enforces exactly-one detail per revision — plan §B type↔detail correspondence). The
 * generic `requirement.created/revised/cancelled` events stay Activities-owned and carry a
 * discriminated `type` payload (plan §G, round-2 finding 5 — there is NO `labour_requirement.*`).
 */
import type { LabourSpecRef } from './labour';

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
  readonly type: string; // 'material' | 'labour' (Phase 4 Task 1) — the immutable root type
  readonly spec: RequirementSpecRef | null; // set iff type='material'; null otherwise
  readonly labourSpec: LabourSpecRef | null; // set iff type='labour'; null otherwise (Phase 4)
  readonly qty: string; // decimal string, numeric(18,6)-exact — total person-shifts for labour
  readonly baseUom: string; // 'person-shift' for labour
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
  readonly type: string; // 'material' | 'labour' — the discriminant (round-2 finding 5)
  readonly specRef: RequirementSpecRef | null; // set iff type='material'
  readonly labourSpecRef: LabourSpecRef | null; // set iff type='labour' (Phase 4)
  readonly qty: string;
  readonly baseUom: string;
  readonly requiredBy: string; // ISO civil date
  readonly status: string;
  readonly reason?: string; // cancellation reason
}
