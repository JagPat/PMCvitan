import type { PlaceContents } from './locationTree';

/** One count on a Site Map card or place header, in words ("1 open issue", "3 drawings"). */
export interface PlaceCountWord {
  key: 'openIssues' | 'decisions' | 'drawings' | 'photos' | 'activities' | 'materials' | 'inspections';
  text: string;
  /** an open issue is the one count drawn as a warning */
  alert: boolean;
}

const NOUNS: Record<PlaceCountWord['key'], [string, string]> = {
  openIssues: ['open issue', 'open issues'],
  inspections: ['inspection', 'inspections'],
  decisions: ['decision', 'decisions'],
  drawings: ['drawing', 'drawings'],
  photos: ['photo', 'photos'],
  activities: ['activity', 'activities'],
  materials: ['material', 'materials'],
};

/**
 * #633 (mockups 7 and 10) — a place's counts as words, open issues first, zeros left out. A child card and
 * the place it opens read the SAME `placeContents` counts, so the two can never disagree.
 *
 * - `inspections`: whether this viewer sees inspections at all (AUTH-02, pmc/engineer). Others never see an
 *   inspection or open-issue count, not even a zero.
 * - `activitiesKnown`: false while the activities are still loading or failed to load — their count is then
 *   unknown and left out rather than shown as none.
 * An unknown open-issue count (`null`, an older server) is left out, never shown as 0.
 */
export function placeCountWords(
  counts: PlaceContents['counts'],
  opts: { inspections: boolean; activitiesKnown: boolean },
): PlaceCountWord[] {
  const n: Partial<Record<PlaceCountWord['key'], number | null>> = {
    openIssues: opts.inspections ? counts.openIssues : null,
    inspections: opts.inspections ? counts.inspections : null,
    decisions: counts.decisions,
    drawings: counts.drawings,
    photos: counts.photos,
    activities: opts.activitiesKnown ? counts.activities : null,
    materials: counts.materials,
  };
  const out: PlaceCountWord[] = [];
  for (const key of Object.keys(NOUNS) as PlaceCountWord['key'][]) {
    const v = n[key];
    if (typeof v !== 'number' || v <= 0) continue;
    out.push({ key, text: `${v} ${NOUNS[key][v === 1 ? 0 : 1]}`, alert: key === 'openIssues' });
  }
  return out;
}
