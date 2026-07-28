import type { LabourForecastVerdict, LabourSliceCoverageDto } from '@vitan/shared';

/**
 * Phase 4 Task 4 — the §A/§B labour coverage input contract (the labour sibling of
 * `inventory/coverage.ts`).
 *
 * One entry per OPEN labour requirement HEAD. The caller resolves it from ITS OWN canonical
 * truth — `activities.start` from `ActivityRequirement` heads (Activities-owned) with the labour
 * detail routed through `LabourRequirementQuery` (the `activities → labour` read edge), the
 * forecast projection from the labour-owned `requirement.*` event read-model — and passes it IN,
 * so Labour never reads Activities persistence (Labour stays a LEAF, §G).
 *
 * `acceptableFingerprints` = the head's own `labourSpecFingerprint` PLUS every ACTIVE
 * `ApprovedSkillSubstitution` target whose `fromFingerprint` still equals the head fingerprint
 * (the Phase-3 T6-F2 rule verbatim, §B). `slices` are the head revision's explicit
 * `(civilDate, personShiftQty)` demand slices in ascending civil-date order; the shift is the
 * head spec's (§B: one shift per spec identity — it is part of the fingerprint).
 */
export interface LabourCoverageRequirement {
  requirementId: string;
  revision: number;
  activityId: string;
  shift: string;
  acceptableFingerprints: string[];
  slices: ReadonlyArray<{ civilDate: string; personShiftQty: number }>;
}

/**
 * The EXECUTION verdict for one labour requirement (§A execution table, first match, evaluated
 * at the project-timezone civil date `asOf`):
 *
 * - `wait` — the labour window has not begun (`asOf` precedes the earliest demand slice), OR
 *   every slice due today is allocated in full but at least one required worker is not yet
 *   present (muster pending);
 * - `fail` — a slice dated before `asOf` went unfulfilled (present-or-worked short of its
 *   `personShiftQty`), OR a slice due today is under-allocated;
 * - `ok` — every slice due today is covered by present-or-worked person-shifts AND every past
 *   slice was fulfilled (a window wholly in the past whose slices were all worked is genuinely
 *   satisfied; an empty due-today set reaches `ok` only AFTER the before-window and overdue
 *   rows have not fired — never vacuously).
 *
 * The `na` gate (no labour requirement) is applied by `deriveTeamReading` on an EMPTY coverage
 * array, mirroring the material pattern.
 */
export type LabourExecutionVerdict = 'ok' | 'wait' | 'fail';

export interface RequirementLabourCoverage {
  requirementId: string;
  revision: number;
  activityId: string;
  verdict: LabourExecutionVerdict;
  reason: string;
  slices: LabourSliceCoverageDto[];
}

/** The FORECAST result for one labour requirement (§A forecast table; presence never consulted). */
export interface RequirementLabourForecast {
  requirementId: string;
  revision: number;
  activityId: string;
  verdict: LabourForecastVerdict;
  /** Set ONLY when `verdict === 'at-risk'`: the latest covering arrival-promise date. */
  coveringDate: string | null;
  reason: string;
}
