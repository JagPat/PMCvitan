import type { Gate, GateReading } from '@vitan/shared';
import type { CoverageVerdict, RequirementCoverage } from '../inventory/coverage';

/**
 * Phase 3 Task 6 — the §A material-gate mapping, applied identically by every reader of
 * canonical coverage: the `activities.start` authority (in-tx), the readiness projection
 * consumer, and the snapshot bake. Keeping it in ONE function is why live == projection ==
 * rebuild by construction.
 *
 * First-match (§A): an unresolved site mismatch is a `fail` BEFORE coverage. Otherwise the
 * per-requirement verdicts aggregate WORST-WINS; zero requirements → `na`. Overrides are NOT
 * applied here — the caller layers an unexpired material override on top (the Phase-1 rule,
 * unchanged), so this function is the base the override supersedes.
 */
const VERDICT_TO_GATE: Record<CoverageVerdict, Gate> = { blocked: 'fail', 'at-risk': 'wait', ready: 'ok' };
const SEVERITY: Record<Gate, number> = { fail: 3, wait: 2, ok: 1, na: 0 };

export function deriveMaterialReading(coverage: readonly RequirementCoverage[], mismatchBlocked: boolean): GateReading {
  if (mismatchBlocked) {
    return { v: 'fail', source: 'derived', reason: 'Material ≠ approved — unresolved site mismatch (§A)' };
  }
  if (coverage.length === 0) {
    return { v: 'na', source: 'derived', reason: 'No material requirement for this activity' };
  }
  let worst = coverage[0];
  for (const c of coverage) {
    if (SEVERITY[VERDICT_TO_GATE[c.verdict]] > SEVERITY[VERDICT_TO_GATE[worst.verdict]]) worst = c;
  }
  return { v: VERDICT_TO_GATE[worst.verdict], source: 'derived', reason: worst.reason };
}
