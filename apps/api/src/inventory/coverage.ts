import type { Prisma } from '@prisma/client';

/**
 * Phase 3 Task 6 — the canonical material-coverage contract between activities (which owns the
 * demand and the §A readiness judgement) and inventory (which owns physical truth and answers
 * `coverageFor`, §G edge `activities → inventory`).
 *
 * Activities builds ONE {@link CoverageRequirement} per open material requirement of an
 * activity, resolving `acceptableFingerprints` itself (the requirement's own spec fingerprint
 * PLUS the `toFingerprint` of every ACTIVE `ApprovedSubstitution` for it — §B satisfaction
 * rule) so inventory never reads activities' substitution table. Inventory returns one
 * {@link RequirementCoverage} per input, computed in the caller's transaction under the
 * project readiness lock.
 */
export interface CoverageRequirement {
  requirementId: string;
  revision: number;
  activityId: string;
  /** demand in the requirement's base UOM (Decimal) */
  requiredQty: Prisma.Decimal;
  baseUom: string;
  /** the requirement's own spec fingerprint + every active substitution target (§B) */
  acceptableFingerprints: string[];
}

/** §A per-requirement coverage verdict (before worst-wins aggregation and the mismatch row). */
export type CoverageVerdict = 'ready' | 'at-risk' | 'blocked';

export interface RequirementCoverage {
  requirementId: string;
  revision: number;
  activityId: string;
  requiredQty: string;
  /** reserved-for-this-activity + already-issued-to-this-activity, matching fingerprints (base UOM) */
  coveredQty: string;
  /** max(required − covered, 0) */
  shortfall: string;
  verdict: CoverageVerdict;
  /** the soonest covering commitment's civil promised date (only when `verdict === 'at-risk'`) */
  commitmentPromisedDate: string | null;
  reason: string;
}
