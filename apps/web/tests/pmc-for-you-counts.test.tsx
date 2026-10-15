import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Checklist, ChecklistItem, Decision, Role } from '@vitan/shared';

/**
 * #771 PMC For You slice — live-bug 3 as the PMC saw it (Dashboard 0, bell 9, For You 1). The Dashboard tile, the
 * For You decision cards and the Portfolio card's pending count are one number, `selectDecisionsAwaitingAction`
 * (the web mirror of the server's `countPending`); the re-inspections a rejection sent back reach For You as their
 * own per-record item and reconcile with the Dashboard's open re-inspections.
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
    d('P-CLIENT-1', { status: 'pending', deciderKind: 'client' }),
    d('P-CLIENT-2', { status: 'pending', deciderKind: 'client' }),
    d('P-PMC', { status: 'pending', deciderKind: 'pmc' }),
    d('P-ARCH', { status: 'pending', deciderKind: 'architect' }),
    d('P-MEMBER', { status: 'pending', deciderKind: 'member', deciderUserId: 'u-eng' }),
    d('P-DRAFT', { status: 'pending', deciderKind: 'client', draft: true }),
    d('C-CLIENT', { status: 'change', deciderKind: 'client' }),
    d('A-HELD', { status: 'awaiting_countersign', deciderKind: 'client', countersignRequired: true }),
    d('A-STRANDED', { status: 'awaiting_countersign', deciderKind: 'client', countersignRequired: undefined }),
    d('OK', { status: 'approved', deciderKind: 'client' }),
  ];
}

/** the decision cards' per-record counts: the viewer's own approvals and re-approvals, the other-held pending and
 *  change requests, and the stranded. #633 — a reopened decision is awaiting action on every surface */
const DECISION_KEYS = ['decider-pending', 'client-pending', 'decider-reapprove', 'client-reapprove', 'pmc-pending', 'pmc-change', 'pmc-stranded', 'arch-countersign'];

describe('one number for decisions awaiting action: Dashboard tile, For You cards, Portfolio card', () => {
  async function surfaces(role: Role, sessionUserId: string) {
    const { useStore, getInitialState } = await demo();
    const sel = await import('@/store/selectors');
    useStore.setState({ role, sessionUserId, decisions: decisions(getInitialState().decisions[0]) });
    const s = useStore.getState();
    const forYou = sel.selectActionItems(s).filter((i) => DECISION_KEYS.includes(i.key)).reduce((n, i) => n + (i.count ?? 1), 0);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const dash = render(<DashboardScreen />);
    const tile = dash.getByTestId('tile-pending-value').textContent;
    cleanup();
    const { PortfolioScreen } = await import('@/screens/PortfolioScreen');
    const port = render(<PortfolioScreen />);
    const chip = port.queryByTestId(`portfolio-${s.activeProjectId}-decisions`)?.textContent ?? '0 decisions';
    cleanup();
    return { selector: sel.selectDecisionsAwaitingAction(s).length, forYou, tile: Number(tile), portfolio: Number(chip.split(' ')[0]) };
  }

  it('pmc: every published pending or reopened decision plus the stranded countersign, on all three surfaces', async () => {
    // P-CLIENT-1, P-CLIENT-2, P-PMC, P-ARCH, P-MEMBER, the reopened C-CLIENT (#633) and A-STRANDED; never the draft or A-HELD
    expect(await surfaces('pmc', 'u-pmc')).toEqual({ selector: 7, forYou: 7, tile: 7, portfolio: 7 });
  });

  it('client, member-decider and architect: their own countPending, on all three surfaces', async () => {
    expect(await surfaces('client', 'u-client')).toEqual({ selector: 3, forYou: 3, tile: 3, portfolio: 3 });
    expect(await surfaces('engineer', 'u-eng')).toEqual({ selector: 1, forYou: 1, tile: 1, portfolio: 1 });
    expect(await surfaces('architect', 'u-arch')).toEqual({ selector: 3, forYou: 3, tile: 3, portfolio: 3 });
  });

  it('the live-bug shape: nine decisions waiting on the client are nine on For You, not one card counted once', async () => {
    const { useStore, getInitialState } = await demo();
    const sel = await import('@/store/selectors');
    const seed = getInitialState().decisions[0];
    const nine = Array.from({ length: 9 }, (_, i): Decision => ({ ...structuredClone(seed), id: `DL-${i}`, draft: false, status: 'pending', deciderKind: 'client' }));
    useStore.setState({ role: 'pmc', sessionUserId: 'u-pmc', decisions: nine, reviews: [], activities: [], drawings: [], openChecklists: [] });
    const items = sel.selectActionItems(useStore.getState());
    expect(items.find((i) => i.key === 'pmc-pending')).toMatchObject({ count: 9, title: '9 decisions awaiting the client' });
    expect(sel.countActionItems(items)).toBe(9);
    expect(sel.selectDecisionsAwaitingAction(useStore.getState()).length).toBe(9);
  });
});

describe('the re-inspections a rejection sent back reach the PMC’s For You', () => {
  const item = (id: string): ChecklistItem => ({ id, name: id, state: null, photos: 0, note: '', evidence: [] });
  const checklist = (id: string, over: Partial<Checklist>): Checklist =>
    ({ id, title: id, zone: 'Terrace', date: 'today', submitted: false, reinspectionOfId: null, items: [item(`${id}-a`)], ...over });

  it('one card per open re-inspection, reconciling with the Dashboard’s open re-inspections and the review queue', async () => {
    const { useStore, getInitialState } = await demo();
    const sel = await import('@/store/selectors');
    const seedReview = getInitialState().reviews[0];
    useStore.setState({
      role: 'pmc', sessionUserId: 'u-pmc', decisions: [], activities: [], drawings: [],
      openChecklists: [
        checklist('RE-1', { reinspectionOfId: 'INSP-1', dueDate: '2026-10-14', title: 'Re-inspection: Terrace' }),
        checklist('RE-4', { reinspectionOfId: 'INSP-4', dueDate: '2026-10-13', title: 'Re-inspection: Stair', items: [item('RE-4-a'), item('RE-4-b')] }),
        checklist('RE-5', { reinspectionOfId: 'INSP-5', dueDate: null, title: 'Re-inspection: Lift' }),
        checklist('RE-SUB', { reinspectionOfId: 'INSP-6', submitted: true }),
        checklist('CK-9', { reinspectionOfId: null }),
      ],
      reviews: [
        { ...seedReview, id: 'RE-2', decided: false, reinspectionOfId: 'INSP-2' },
        { ...seedReview, id: 'INSP-7', decided: false, reinspectionOfId: undefined },
        { ...seedReview, id: 'RE-3', decided: true, reinspectionOfId: 'INSP-3' },
      ],
    });
    const s = useStore.getState();
    const items = sel.selectActionItems(s);
    const re = items.find((i) => i.key === 'pmc-reinspections')!;
    expect(re).toMatchObject({ count: 3, title: '3 re-inspections with the engineer', screen: 'inspect-review', tone: 'amber' });
    // the open issues are the re-inspections' items (the server's `openIssues`, the Site Map's count); the earliest
    // stored civil due date, read from its parts
    expect(re.detail).toBe('4 open issues · Re-inspection: Terrace, Re-inspection: Stair, Re-inspection: Lift · next due 13 Oct');
    expect(re.facts).toMatchObject({ n: 3, issues: 4 });
    expect(re.item).toBeUndefined(); // three records: the card opens the list
    // the Dashboard's open re-inspections are exactly these plus the re-inspection already in the review queue
    const reviewsItem = items.find((i) => i.key === 'pmc-reviews')!;
    expect(reviewsItem.count).toBe(sel.selectReviewPending(s));
    const inReview = s.reviews.filter((r) => r.reinspectionOfId && !r.decided).length;
    expect(sel.selectOpenReinspections(s).count).toBe(re.count! + inReview);
    // and the open issues: this card's plus the in-review re-inspections' items are the Dashboard's failed items
    const inReviewItems = s.reviews.filter((r) => r.reinspectionOfId && !r.decided).reduce((n, r) => n + r.items.length, 0);
    expect(sel.selectOpenReinspections(s).items).toBe(re.facts!.issues! + inReviewItems);
  });

  it('a single open re-inspection opens at that record; no due date stored says none', async () => {
    const { useStore } = await demo();
    const sel = await import('@/store/selectors');
    useStore.setState({ role: 'pmc', reviews: [], openChecklists: [checklist('RE-1', { reinspectionOfId: 'INSP-1', dueDate: null, title: 'Re-inspection: Terrace' })] });
    const re = sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-reinspections')!;
    expect(re).toMatchObject({ count: 1, title: '1 re-inspection with the engineer', detail: '1 open issue · Re-inspection: Terrace', item: 'RE-1' });
    expect(sel.inspectionRecordLink(useStore.getState(), 'RE-1')).toEqual({ screen: 'inspect-review', item: 'RE-1' });
  });

  it('no card without a re-inspection: ordinary, submitted and unreported-lineage checklists, and other roles', async () => {
    const { useStore } = await demo();
    const sel = await import('@/store/selectors');
    const keys = () => sel.selectActionItems(useStore.getState()).map((i) => i.key);
    useStore.setState({
      role: 'pmc', reviews: [],
      openChecklists: [checklist('CK-1', { reinspectionOfId: null }), checklist('CK-OLD', { reinspectionOfId: undefined }), checklist('RE-SUB', { reinspectionOfId: 'INSP-1', submitted: true })],
    });
    expect(keys()).not.toContain('pmc-reinspections');
    useStore.setState({ openChecklists: [checklist('RE-1', { reinspectionOfId: 'INSP-1' })] });
    expect(keys()).toContain('pmc-reinspections');
    // a reported re-inspection beside an open checklist with unreported lineage: the total is unknown, so no
    // card claims a partial count (the Dashboard reads "—")
    useStore.setState({ openChecklists: [checklist('RE-1', { reinspectionOfId: 'INSP-1' }), checklist('CK-OLD', { reinspectionOfId: undefined })] });
    expect(sel.selectOpenReinspections(useStore.getState()).known).toBe(false);
    expect(keys()).not.toContain('pmc-reinspections');
    useStore.setState({ openChecklists: [checklist('RE-1', { reinspectionOfId: 'INSP-1' })] });
    for (const role of ['engineer', 'contractor', 'client', 'architect'] as const) {
      useStore.setState({ role });
      expect(keys()).not.toContain('pmc-reinspections');
    }
  });

  it('a slice that has not settled names no record', async () => {
    const { useStore } = await demo();
    const sel = await import('@/store/selectors');
    useStore.setState({
      role: 'pmc', reviews: [],
      openChecklists: [checklist('RE-1', { reinspectionOfId: 'INSP-1' })],
      commandReconcileOwed: { decisions: false, inspections: true, drawings: false, activities: false, dailyLog: false },
    });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-reinspections')).toMatchObject({ count: 1, item: undefined });
  });

});
