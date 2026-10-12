import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { ApiSnapshot } from '@/data/apiGateway';
import type { Checklist, Review } from '@vitan/shared';

/**
 * #771 (owner record #482 6114668018) — the Dashboard's "failed items awaiting re-inspection" never shows a
 * confident number it cannot know.
 *
 * Re-inspections are counted from their lineage (`reinspectionOfId`). A review row has carried it since Phase 1
 * Task 4, but an OPEN checklist only since #773, and until this unit an ordinary checklist simply omitted it. So a
 * server older than #773 served an open re-inspection with no lineage, and the tile read it as an ordinary
 * checklist: a confident "0 · None" while real failed work waited on site. Now a current server marks an ordinary
 * checklist explicitly (`reinspectionOfId: null`), and an open checklist with NO lineage key means the server did
 * not report it — the tile says so ("—") instead of guessing. A known zero stays an exact zero.
 *
 * Every case goes through `applySnapshot`, the path a live snapshot takes. Isolated automated tests only.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

type Store = typeof import('@/store/store');

const item = (id: string) => ({ id, name: id, state: null, photos: 0, note: '', evidence: [] });
const reviewItem = (id: string) => ({ id, name: id, result: 'FAIL' as const, swatch: 'concrete' as const, note: '', rejected: false, evidence: [] });
/** An open checklist as a server serves it; `lineage` omitted = a server that predates the field. */
const open = (id: string, items: number, lineage?: string | null, submitted = false): Checklist => ({
  id, title: id, zone: 'GF', date: 'today', submitted,
  ...(lineage !== undefined ? { reinspectionOfId: lineage } : {}),
  items: Array.from({ length: items }, (_, i) => item(`${id}-${i}`)),
});
const review = (id: string, items: number, over: Partial<Review> = {}): Review => ({
  id, title: id, zone: 'GF', by: 'Eng', date: 'today', decided: false,
  items: Array.from({ length: items }, (_, i) => reviewItem(`${id}-${i}`)), ...over,
} as Review);

function snapshot(partial: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    project: { id: 'villa-b', name: 'Villa', short: 'Villa', descriptor: '', stage: 'x', siteCode: 'V', location: '', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
    ...partial,
  } as ApiSnapshot;
}

/** A live PMC session on villa-b with `snap` applied the way a fetched snapshot is. */
async function live(snap: ApiSnapshot, over: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = (await import('@/store/store')) as Store;
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', role: 'pmc', name: 'Villa' });
  expect(useStore.getState().applySnapshot(snap)).toBe(true);
  if (Object.keys(over).length) useStore.setState(over);
  const { DashboardScreen } = await import('@/screens/DashboardScreen');
  const { selectOpenReinspections } = await import('@/store/selectors');
  return { useStore, selectOpenReinspections, r: render(<DashboardScreen />) };
}
const tile = (r: ReturnType<typeof render>) => r.getByTestId('tile-failed-value').textContent;

describe('#771 — an old server that omits open-checklist lineage never reads as a confident zero', () => {
  it('reproduce: an open re-inspection served WITHOUT lineage shows "—" and says why, never "0 · None"', async () => {
    const { r, useStore, selectOpenReinspections } = await live(snapshot({ openChecklists: [open('RE-1', 2)] }));
    expect(tile(r)).toBe('—');
    expect(r.getByText('Re-inspection status not reported')).toBeInTheDocument();
    expect(r.queryByText('None')).not.toBeInTheDocument();
    expect(selectOpenReinspections(useStore.getState()).known).toBe(false);
  });

  it('an older server still on the single `checklist` field: its open checklist has no lineage, so "—"', async () => {
    const snap = snapshot({ checklist: open('RE-1', 1) });
    delete (snap as Partial<ApiSnapshot>).openChecklists;
    const { r } = await live(snap);
    expect(tile(r)).toBe('—');
  });

  it('an unreported row beside reported ones still makes the total unknown (a partial count is not the count)', async () => {
    const { r } = await live(snapshot({
      openChecklists: [open('RE-1', 2, 'INSP-1'), open('CK-OLD', 3)],
      reviews: [review('RE-2', 1, { reinspectionOfId: 'INSP-5' })],
    }));
    expect(tile(r)).toBe('—');
  });

  it('an old payload with NO open checklist is still exact: review rows have always carried lineage', async () => {
    const { r } = await live(snapshot({
      openChecklists: [open('CK-DONE', 2, undefined, true)], // submitted: not open work, lineage irrelevant
      reviews: [review('RE-2', 2, { reinspectionOfId: 'INSP-5' }), review('INSP-7', 1)],
    }));
    expect(tile(r)).toBe('2');
    expect(r.getByText('In 1 open re-inspection')).toBeInTheDocument();
  });

  it('an old payload with nothing open at all is a known, exact zero', async () => {
    const { r } = await live(snapshot({ openChecklists: [], reviews: [] }));
    expect(tile(r)).toBe('0');
    expect(r.getByText('None')).toBeInTheDocument();
  });
});

describe('#771 — a current server reports lineage on every open checklist, so the count is exact', () => {
  it('known empty: "0 · None"', async () => {
    const { r, useStore, selectOpenReinspections } = await live(snapshot({ openChecklists: [], reviews: [] }));
    expect(tile(r)).toBe('0');
    expect(r.getByText('None')).toBeInTheDocument();
    expect(selectOpenReinspections(useStore.getState())).toEqual({ count: 0, items: 0, known: true });
  });

  it('ordinary checklists only (`reinspectionOfId: null`): a valid zero, not unknown', async () => {
    const { r } = await live(snapshot({ openChecklists: [open('CK-1', 3, null), open('CK-2', 1, null)] }));
    expect(tile(r)).toBe('0');
    expect(r.getByText('None')).toBeInTheDocument();
  });

  it('a real re-inspection counts its items while open, while in review, and not once decided', async () => {
    const opened = await live(snapshot({ openChecklists: [open('RE-1', 2, 'INSP-1'), open('CK-1', 4, null)] }));
    expect(tile(opened.r)).toBe('2');
    expect(opened.r.getByText('In 1 open re-inspection')).toBeInTheDocument();
    cleanup();

    const inReview = await live(snapshot({ openChecklists: [open('CK-1', 4, null)], reviews: [review('RE-1', 2, { reinspectionOfId: 'INSP-1' })] }));
    expect(tile(inReview.r)).toBe('2');
    cleanup();

    const decided = await live(snapshot({ openChecklists: [open('CK-1', 4, null)], reviews: [review('RE-1', 2, { reinspectionOfId: 'INSP-1', decided: true })] }));
    expect(tile(decided.r)).toBe('0');
    expect(decided.r.getByText('None')).toBeInTheDocument();
  });

  it('a submitted re-inspection is counted once, from the review queue, not again from the checklist list', async () => {
    const { r } = await live(snapshot({
      openChecklists: [open('RE-1', 2, 'INSP-1', true)],
      reviews: [review('RE-1', 2, { reinspectionOfId: 'INSP-1' })],
    }));
    expect(tile(r)).toBe('2');
  });
});

describe('#771 — loading, failure, refresh and the openable records', () => {
  it('a later snapshot from an updated server replaces "unknown" with the exact count, and back', async () => {
    const { r, useStore } = await live(snapshot({ openChecklists: [open('RE-1', 2)] }));
    expect(tile(r)).toBe('—');
    act(() => { expect(useStore.getState().applySnapshot(snapshot({ openChecklists: [open('RE-1', 2, 'INSP-1')] }))).toBe(true); });
    expect(tile(r)).toBe('2');
    act(() => { expect(useStore.getState().applySnapshot(snapshot({ openChecklists: [open('CK-1', 1)] }))).toBe(true); });
    expect(tile(r)).toBe('—');
  });

  it('loading and a failed read keep their own "—" and wording, ahead of the lineage note', async () => {
    const loading = await live(snapshot({ openChecklists: [open('RE-1', 2)] }), { projectLoadState: 'loading' });
    expect(tile(loading.r)).toBe('—');
    expect(loading.r.queryByText('Re-inspection status not reported')).not.toBeInTheDocument();
    cleanup();
    const failed = await live(snapshot({ openChecklists: [open('RE-1', 2)] }), { inspectionsLoad: 'error' });
    expect(tile(failed.r)).toBe('—');
    expect(failed.r.getAllByText('Could not load — try again').length).toBeGreaterThan(0);
  });

  it('the unknown tile still opens the records it is about (the inspections the PMC can open)', async () => {
    const { r, useStore } = await live(snapshot({ openChecklists: [open('RE-1', 2)] }));
    fireEvent.click(r.getByTestId('tile-failed-value'));
    expect(useStore.getState().screen).toBe('inspect-review');
  });

  it('the other tiles are untouched: the review queue still counts exactly beside an unknown failed-items tile', async () => {
    const { r } = await live(snapshot({ openChecklists: [open('RE-1', 2)], reviews: [review('INSP-7', 1)] }));
    expect(tile(r)).toBe('—');
    expect(r.getByTestId('tile-review-value').textContent).toBe('1');
  });
});
