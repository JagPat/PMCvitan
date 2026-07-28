import type { Gate, GateReading } from '@vitan/shared';
import type { LabourExecutionVerdict, RequirementLabourCoverage } from './coverage';

/**
 * Phase 4 Task 4 — the §A Team-gate mapping, applied identically by every reader of canonical
 * labour coverage: the `activities.start` authority (in-tx, execution truth) and the read-path
 * bake. Keeping it in ONE function is why live == read agree by construction — the sibling of
 * `deriveMaterialReading`, owned by Labour so the import direction is the declared
 * `activities → labour` read edge.
 *
 * First-match (§A): an unresolved labour mismatch is a `fail` BEFORE coverage (the mismatch FACT
 * family lands in Task 5 — until then every caller passes `false`, and the parameter fixes the
 * seam so Task 5 changes no signature). Otherwise the per-requirement execution verdicts
 * aggregate WORST-WINS; zero requirements → `na`. Overrides are NOT applied here — the caller
 * layers an unexpired team override on top (the Phase-1 rule, unchanged), so this function is
 * the base the override supersedes.
 */
const VERDICT_TO_GATE: Record<LabourExecutionVerdict, Gate> = { fail: 'fail', wait: 'wait', ok: 'ok' };
const SEVERITY: Record<Gate, number> = { fail: 3, wait: 2, ok: 1, na: 0 };

export function deriveTeamReading(coverage: readonly RequirementLabourCoverage[], mismatchBlocked: boolean): GateReading {
  if (mismatchBlocked) {
    return { v: 'fail', source: 'derived', reason: 'Crew ≠ allocated — unresolved labour mismatch (§A)' };
  }
  if (coverage.length === 0) {
    return { v: 'na', source: 'derived', reason: 'No labour requirement for this activity' };
  }
  let worst = coverage[0];
  for (const c of coverage) {
    if (SEVERITY[VERDICT_TO_GATE[c.verdict]] > SEVERITY[VERDICT_TO_GATE[worst.verdict]]) worst = c;
  }
  return { v: VERDICT_TO_GATE[worst.verdict], source: 'derived', reason: worst.reason };
}
