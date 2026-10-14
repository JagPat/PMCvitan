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

export interface PlaceCountOptions {
  /** AUTH-02: `hidden` for a viewer who never sees inspections (no inspection or issue count, not even a
   *  zero); `unknown` while a viewer who does see them has no settled read yet; `known` once it has */
  inspections: 'hidden' | 'unknown' | 'known';
  /** false while the activities are still loading or failed to load: their count is then unknown */
  activitiesKnown: boolean;
  /** the snapshot carries only the newest site photos once that window is full: a count read from it is a
   *  count of RECENT photos, never the place's whole record */
  photosCapped: boolean;
}

/**
 * #633 (mockups 7 and 10) — a place's counts as words, open issues first, zeros left out. A child card and
 * the place it opens read the SAME `placeContents` counts, so the two can never disagree.
 *
 * An unknown count is left out, never shown as 0. An empty result never means "nothing filed here": every
 * module read (decisions, drawings, daily log, inspections, activities) can still be loading or have failed,
 * so the Site Map never claims a place is empty from its counts (Codex 4265796887, 4266016679).
 */
export function placeCountWords(
  counts: PlaceContents['counts'],
  opts: PlaceCountOptions,
): PlaceCountWord[] {
  const inspectionsKnown = opts.inspections === 'known';
  const n: Record<PlaceCountWord['key'], number | null> = {
    openIssues: inspectionsKnown ? counts.openIssues : null,
    inspections: inspectionsKnown ? counts.inspections : null,
    decisions: counts.decisions,
    drawings: counts.drawings,
    photos: counts.photos,
    activities: opts.activitiesKnown ? counts.activities : null,
    materials: counts.materials,
  };
  const words: PlaceCountWord[] = [];
  for (const key of Object.keys(NOUNS) as PlaceCountWord['key'][]) {
    const v = n[key];
    if (typeof v !== 'number' || v <= 0) continue;
    const noun = NOUNS[key][v === 1 ? 0 : 1];
    words.push({ key, text: `${v} ${key === 'photos' && opts.photosCapped ? `recent ${noun}` : noun}`, alert: key === 'openIssues' });
  }
  return words;
}
