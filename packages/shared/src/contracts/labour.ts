/**
 * Phase 4 Task 1 — the LABOUR module contract (shared, runtime-importable on both sides).
 *
 * Labour owns TRUSTED WORKFORCE IDENTITY (plan §H) and the LABOUR REQUIREMENT DETAIL (plan §B).
 * It is a LEAF module (plan §G, round-3): `dependsOn: []`. The ONLY graph edge into it is
 * `activities → labour` (the Activities requirement command writes the `LabourRequirementSpec`
 * through the cycle-exempt `LabourParticipant.writeRequirementSpec`, and — from Task 4 — the
 * coverage read). Labour never reads Activities persistence.
 *
 * Task 1 scope: the labour capability + type-routed demand (a `type='labour'` revision of the
 * SAME type-neutral `ActivityRequirement`, whose detail is the Labour-owned
 * `LabourRequirementSpec` + its explicit per-`(civilDate, shift)` demand slices), and the
 * first-class `Worker`/`Crew`/`CrewMembership` identity with a `WorkerDevice`→`Worker` FK
 * binding. Every operational row is project-contained; a cross-project reference is
 * unrepresentable in PostgreSQL (same-project composite FKs).
 */

/** The labour module's state-changing commands (must equal the manifest `commands`).
 *  Task 1 = trusted-identity onboarding (the labour requirement demand is authored through the
 *  Activities-owned `requirements.*` command, routed by `type` — it is NOT a labour command). */
export const LABOUR_COMMANDS = [
  'labour.trade.define',
  'labour.skill.define',
  'labour.worker.onboard',
  'labour.worker.revoke',
  'labour.crew.form',
  'labour.crew.addMember',
  'labour.crew.removeMember',
] as const;
// Note: the WorkerDevice->Worker binding is a Task-1 STRUCTURAL foundation (the composite
// (projectId, workerId) FK + containment; proven by the cross-project forgery probe). The
// binding COMMAND — which sets `WorkerDevice.workerId` on the orgs-owned device row — lands with
// attendance in Task 3 through the owning module, so labour writes only labour-owned tables here.
export type LabourCommand = (typeof LABOUR_COMMANDS)[number];

/** The labour module's read queries (must equal the manifest `queries`). */
export const LABOUR_QUERIES = ['labour.workforce', 'labour.catalog'] as const;
export type LabourQuery = (typeof LABOUR_QUERIES)[number];

/**
 * The complete labour specification reference carried by a `type='labour'` requirement revision:
 * TECHNICAL identity (fingerprinted over `(tradeCode, skillCode, shift)`, §B) + AUTHORITATIVE
 * decision provenance (server-resolved approved version + option, or all-null for a manual
 * specification). Provenance is stored, NEVER hashed — the material-spec rule verbatim.
 */
export interface LabourSpecRef {
  readonly tradeCode: string;
  readonly skillCode: string | null;
  readonly shift: string; // 'day' | 'night' — part of the fingerprinted identity
  readonly labourSpecFingerprint: string;
  readonly decisionId: string | null;
  readonly decisionVersion: number | null;
  readonly optionKey: string | null;
  /** The explicit per-`(civilDate, shift)` demand slices (§B). `shift` is the spec's shift on
   *  every slice, so the slice triple `(civilDate, shift, personShiftQty)` is complete here even
   *  though storage normalizes the shared shift onto the spec. */
  readonly demandSlices: readonly LabourDemandSliceDto[];
}

/** One explicit `(civilDate, shift, personShiftQty)` demand slice (§B). */
export interface LabourDemandSliceDto {
  readonly civilDate: string; // ISO civil date (DATE column)
  readonly shift: string; // 'day' | 'night'
  readonly personShiftQty: number; // integer person-shifts, > 0
}

/** A labour trade catalog entry (project-contained). */
export interface LabourTradeDto {
  readonly code: string;
  readonly name: string;
}

/** A labour skill catalog entry (project-contained). */
export interface LabourSkillDto {
  readonly code: string;
  readonly name: string;
}

/** A trusted, project-contained worker identity (§H) — the atomic capacity source (round-1). */
export interface WorkerDto {
  readonly id: string;
  readonly name: string;
  readonly tradeCode: string;
  readonly skillCodes: readonly string[];
  readonly activeFrom: string; // ISO civil date
  readonly activeTo: string | null; // ISO civil date, null = open-ended
  readonly revokedAt: string | null; // ISO timestamp, null = active
  readonly revokedById: string | null;
  readonly createdAt: string;
  readonly createdById: string;
  /** Bound field-attendance devices (the token/trade are display-only; identity is the FK). */
  readonly devices: readonly WorkerDeviceDto[];
}

/** A field-attendance device bound to a `Worker` by FK (§H — free-text name/trade are
 *  display-only and NEVER readiness evidence). */
export interface WorkerDeviceDto {
  readonly id: string;
  readonly name: string | null;
  readonly trade: string | null;
  readonly boundAt: string;
}

/** A named set of workers under an in-charge (`mistri`) — ORGANIZATIONAL only, NOT an atomic
 *  capacity source (round-2 finding 1; the atomic source is the `Worker`). */
export interface CrewDto {
  readonly id: string;
  readonly name: string;
  readonly inchargeWorkerId: string | null;
  readonly activeFrom: string;
  readonly activeTo: string | null;
  readonly revokedAt: string | null;
  readonly members: readonly CrewMemberDto[];
}

/** One worker's membership in a crew (project-contained; a member can never cross projects). */
export interface CrewMemberDto {
  readonly workerId: string;
  readonly addedAt: string;
  readonly removedAt: string | null;
}

/** The `labour.workforce` query result — the project's trusted workforce register. */
export interface LabourWorkforceDto {
  readonly workers: readonly WorkerDto[];
  readonly crews: readonly CrewDto[];
}

/** The `labour.catalog` query result — the project's trade/skill catalog. */
export interface LabourCatalogDto {
  readonly trades: readonly LabourTradeDto[];
  readonly skills: readonly LabourSkillDto[];
}
