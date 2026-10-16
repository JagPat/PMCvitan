import type { Decision, WaitParty } from '@vitan/shared';
import { viewerIsDecider } from '@vitan/shared';
import type { AppState } from '@/store/store';
import { isStrandedCountersign, selectDecisionsAwaitingAction, selectReinspectionsAwaitingSubmission } from '@/store/selectors';
import { API_BASE } from '@/data/apiGateway';
import { demoReviewOpenIssues } from '@/lib/locationTree';

/**
 * Stage 1 redesign (#482, Rev 3.1 unit H3) — whom each Dashboard tile's items wait on, read from the same records
 * the tile counts, so the words never claim a different set from the number. `null` when the tile counts nothing.
 */

type Party = Exclude<WaitParty, 'you' | 'several'>;

/** One party for the viewer: their own role reads "you", and items held by more than one party read "several". */
function combine(parties: readonly Party[], s: Pick<AppState, 'role'>): WaitParty | null {
  const seen = new Set<WaitParty>(parties.map((p) => (p === s.role ? 'you' : p)));
  if (seen.size === 0) return null;
  return seen.size === 1 ? [...seen][0] : 'several';
}

/**
 * A decision waits on its decider (a pending one, or one reopened by a change request), on the architect while it
 * awaits a countersign, and on the PMC once that countersign is stranded (no architect can give it). A decision the
 * viewer decides waits on them; a named member's decision names no role, since the record carries none.
 */
function decisionWaitsOn(d: Decision, s: Pick<AppState, 'role' | 'sessionUserId'>): Party | 'self' {
  if (d.status === 'awaiting_countersign') return isStrandedCountersign(d) ? 'pmc' : 'architect';
  if (viewerIsDecider(d, s.role, s.sessionUserId)) return 'self';
  if (d.deciderKind === 'client' || d.deciderKind === 'pmc' || d.deciderKind === 'architect') return d.deciderKind;
  return 'decider';
}

/** The decisions tile: the records `selectDecisionsAwaitingAction` counts. */
export function decisionsWaitOn(s: AppState): WaitParty | null {
  const waits = selectDecisionsAwaitingAction(s).map((d) => decisionWaitsOn(d, s));
  if (waits.length && waits.every((w) => w === 'self')) return 'you';
  const parties = waits.map((w) => (w === 'self' ? s.role : w)) as Party[];
  return combine(parties, s);
}

/** The inspection review tile: every undecided review is the PMC's to decide. */
export function reviewsWaitOn(s: AppState): WaitParty | null {
  return s.reviews.some((r) => !r.decided) ? combine(['pmc'], s) : null;
}

/**
 * The failed-items tile. Live: a failed item in a re-inspection still being worked waits on the engineer; one in a
 * re-inspection the engineer has sent waits on the PMC's review (`selectOpenReinspections`, the tile's count). The
 * API-less demo counts each review's open issues (`selectFailedCount`, `demoReviewOpenIssues`): an undecided
 * review's failed items wait on the PMC, and a decided one's rejected items, sent for re-inspection, on the engineer.
 */
export function failedWaitOn(s: AppState): WaitParty | null {
  const parties: Party[] = [];
  if (!API_BASE) {
    for (const r of s.reviews) {
      if (demoReviewOpenIssues(r) === 0) continue;
      parties.push(r.decided ? 'engineer' : 'pmc');
    }
    return combine(parties, s);
  }
  if (selectReinspectionsAwaitingSubmission(s).some((c) => c.items.length > 0)) parties.push('engineer');
  if (s.reviews.some((r) => r.reinspectionOfId && !r.decided && r.items.length > 0)) parties.push('pmc');
  return combine(parties, s);
}
