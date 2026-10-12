import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Decision } from '@vitan/shared';

/**
 * Top 10 #2a (#771) — one source of truth for counts, and live-bug 3 (the PMC's Dashboard read 0 while
 * the bell and For You did not). The Dashboard "decisions awaiting approval" tile is the server's
 * `countPending` (the Portfolio card's number), the For You badge counts the records the viewer acts on
 * one by one, and a live tile never shows a confident 0 before its slice has settled.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

type Store = typeof import('@/store/store');

async function demo() {
  vi.resetModules();
  const mod: Store = await import('@/store/store');
  mod.useStore.setState(mod.getInitialState());
  return mod;
}

function decisions(seed: Decision): Decision[] {
  const d = (id: string, over: Partial<Decision>): Decision => ({ ...structuredClone(seed), id, draft: false, ...over });
  return [
    d('P-CLIENT', { status: 'pending', deciderKind: 'client' }),
    d('P-PMC', { status: 'pending', deciderKind: 'pmc' }),
    d('P-ARCH', { status: 'pending', deciderKind: 'architect' }),
    d('P-MEMBER', { status: 'pending', deciderKind: 'member', deciderUserId: 'u-eng' }),
    d('P-DRAFT', { status: 'pending', deciderKind: 'client', draft: true }),
    d('C-CLIENT', { status: 'change', deciderKind: 'client' }),
    d('A-HELD', { status: 'awaiting_countersign', deciderKind: 'client', countersignRequired: true }),
    d('A-STRANDED', { status: 'awaiting_countersign', deciderKind: 'client', countersignRequired: undefined }), // served without the chain overlay
    d('OK', { status: 'approved', deciderKind: 'client' }),
  ];
}

describe('selectDecisionsAwaitingAction mirrors the server countPending, arm by arm', () => {
  it('pmc: every published pending decision plus the stranded countersigns — no change, held-awaiting or draft', async () => {
    const { useStore } = await demo();
    const sel = await import('@/store/selectors');
    useStore.setState({ role: 'pmc', decisions: decisions(useStore.getState().decisions[0]) });
    expect(sel.selectDecisionsAwaitingAction(useStore.getState()).map((d) => d.id).sort())
      .toEqual(['A-STRANDED', 'P-ARCH', 'P-CLIENT', 'P-MEMBER', 'P-PMC']);
  });

  it('client / member / architect: their own decider-scoped pending, and the architect every countersign', async () => {
    const { useStore } = await demo();
    const sel = await import('@/store/selectors');
    const rows = decisions(useStore.getState().decisions[0]);
    const ids = (over: Record<string, unknown>) => {
      useStore.setState({ decisions: rows, ...over });
      return sel.selectDecisionsAwaitingAction(useStore.getState()).map((d) => d.id).sort();
    };
    expect(ids({ role: 'client', sessionUserId: 'u-client' })).toEqual(['P-CLIENT']);
    expect(ids({ role: 'engineer', sessionUserId: 'u-eng' })).toEqual(['P-MEMBER']);
    expect(ids({ role: 'contractor', sessionUserId: 'u-con' })).toEqual([]);
    expect(ids({ role: 'architect', sessionUserId: 'u-arch' })).toEqual(['A-HELD', 'A-STRANDED', 'P-ARCH']);
  });
});

describe('For You counts the records the viewer acts on one by one', () => {
  it('pmc: reviews, change requests and every decision awaiting action count per record; informational cards count once', async () => {
    const { useStore } = await demo();
    const sel = await import('@/store/selectors');
    const [review] = useStore.getState().reviews;
    useStore.setState({
      role: 'pmc',
      decisions: decisions(useStore.getState().decisions[0]),
      reviews: [{ ...review, id: 'R1', decided: false }, { ...review, id: 'R2', decided: false }, { ...review, id: 'R3', decided: true }],
    });
    const items = sel.selectActionItems(useStore.getState());
    const count = (key: string) => items.find((i) => i.key === key)?.count;
    expect(count('pmc-reviews')).toBe(2);
    expect(count('pmc-change')).toBe(1);
    expect(count('pmc-stranded')).toBe(1);
    expect(count('decider-pending')).toBe(1); // the PMC-held P-PMC
    // #771 PMC slice: the PMC manages every pending decision (countPending), so the other-held ones count per
    // record too; a countersign the architect holds is outside countPending and stays one informational card
    expect(count('pmc-pending')).toBe(3);
    expect(count('pmc-countersign')).toBeUndefined();
    // the review part of the badge equals the Inspection Review badge
    expect(count('pmc-reviews')).toBe(sel.selectReviewPending(useStore.getState()));
  });

  it('architect: each countersign owed counts, as the Decision Log badge does', async () => {
    const { useStore } = await demo();
    const sel = await import('@/store/selectors');
    useStore.setState({ role: 'architect', sessionUserId: 'u-arch', decisions: decisions(useStore.getState().decisions[0]) });
    const item = sel.selectActionItems(useStore.getState()).find((i) => i.key === 'arch-countersign')!;
    expect(item.count).toBe(sel.selectCountersignObligations(useStore.getState()).length);
    expect(item.count).toBe(2);
  });
});

describe('the live Dashboard tiles', () => {
  async function live(over: Record<string, unknown>) {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = (await import('@/store/store')) as Store;
    const scope = await import('@/store/projectScope');
    const seed = getInitialState();
    useStore.setState(seed);
    useStore.setState({
      ...scope.emptyProjectData(),
      activeProjectId: 'villa-b',
      projectLoadState: 'ready',
      role: 'pmc',
      name: 'Villa at Bodakdev',
      decisions: decisions(seed.decisions[0]),
      ...over,
    });
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    return { useStore, r: render(<DashboardScreen />) };
  }

  it('the decisions tile is the countPending number (pending + stranded), labelled for any decider', async () => {
    const { r } = await live({});
    expect(r.getByTestId('tile-pending-value').textContent).toBe('5');
    expect(r.getByText('DECISIONS AWAITING APPROVAL')).toBeInTheDocument();
    expect(r.queryByText(/PENDING WITH CLIENT/)).not.toBeInTheDocument();
  });

  it('never a confident 0 before the slices settle: "—" while loading, and says so when a read failed', async () => {
    const loading = await live({ projectLoadState: 'loading' });
    for (const key of ['pending', 'review', 'failed']) expect(loading.r.getByTestId(`tile-${key}-value`).textContent).toBe('—');
    expect(loading.r.getAllByText('Loading…').length).toBe(3);
    cleanup();
    vi.resetModules();
    const owed = await live({ commandReconcileOwed: { decisions: true, inspections: false, drawings: false } });
    expect(owed.r.getByTestId('tile-pending-value').textContent).toBe('—');
    expect(owed.r.getByTestId('tile-review-value').textContent).toBe('0');
    cleanup();
    vi.resetModules();
    const failed = await live({ inspectionsLoad: 'error' });
    expect(failed.r.getByTestId('tile-review-value').textContent).toBe('—');
    expect(failed.r.getAllByText('Could not load — try again').length).toBe(2);
    expect(failed.r.getByTestId('tile-pending-value').textContent).toBe('5');
  });
});

describe('Top 10 #2b — the live failed-items tile reads the open re-inspections', () => {
  async function liveFailed(over: Record<string, unknown>) {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = (await import('@/store/store')) as Store;
    const scope = await import('@/store/projectScope');
    const seed = getInitialState();
    useStore.setState(seed);
    useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', role: 'pmc', name: 'Villa', ...over });
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    return { seed, r: render(<DashboardScreen />) };
  }
  const item = (id: string) => ({ id, name: id, state: null, photos: 0, note: '', evidence: [] });

  it('counts the failed items in re-inspections not yet decided — open or awaiting review — and nothing else', async () => {
    const seedReview = (await demo()).getInitialState().reviews[0];
    cleanup();
    const { r } = await liveFailed({
      openChecklists: [
        { id: 'RE-1', title: 'Re-inspection: Terrace', zone: 'Terrace', date: 'today', submitted: false, reinspectionOfId: 'INSP-1', items: [item('a'), item('b')] },
        { id: 'CK-9', title: 'Ordinary checklist', zone: 'GF', date: 'today', submitted: false, reinspectionOfId: null, items: [item('c')] },
      ],
      reviews: [
        { ...seedReview, id: 'RE-2', decided: false, reinspectionOfId: 'INSP-5', items: seedReview.items.slice(0, 1) },
        { ...seedReview, id: 'RE-3', decided: true, reinspectionOfId: 'INSP-6' },
        { ...seedReview, id: 'INSP-7', decided: false, reinspectionOfId: undefined },
      ],
    });
    expect(r.getByTestId('tile-failed-value').textContent).toBe('3');
    expect(r.getByText('In 2 open re-inspections')).toBeInTheDocument();
  });

  it('after a rejection the tile is no longer structurally 0: the decided original is gone, its re-inspection counts', async () => {
    const seedReview = (await demo()).getInitialState().reviews[0];
    cleanup();
    const { r } = await liveFailed({
      reinspectionCreated: true,
      reviews: [{ ...seedReview, id: 'INSP-1', decided: true, items: seedReview.items.map((it) => ({ ...it, rejected: true })) }],
      openChecklists: [{ id: 'RE-1', title: 'Re-inspection', zone: 'Terrace', date: 'today', submitted: false, reinspectionOfId: 'INSP-1', items: [item('a')] }],
    });
    expect(r.getByTestId('tile-failed-value').textContent).toBe('1');
  });
});

