import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

/**
 * Top 10 #3a (#774) — every card about ONE record opens that record at its own URL (`openItem` → screen +
 * routeItem), never the parent list: For You items naming exactly one record, the Site Map's inspection,
 * decision and drawing rows, the Dashboard's single-review tile, the client's Health links and the Daily
 * Log's decision reference. Destinations follow the bell's rules (`decisionRecordLink`, `inspectionRecordLink`).
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

type Store = typeof import('@/store/store');
async function demo(over: Record<string, unknown> = {}) {
  vi.resetModules();
  const mod: Store = await import('@/store/store');
  mod.useStore.setState(mod.getInitialState());
  mod.useStore.setState(over);
  return mod;
}
const where = (useStore: Store['useStore']) => ({ screen: useStore.getState().screen, item: useStore.getState().routeItem ?? useStore.getState().decisionFocus });

describe('For You items name their record when they stand for exactly one', () => {
  it('a single review, change request or checklist carries its id; a group of two does not', async () => {
    const { useStore } = await demo({ role: 'pmc' });
    const sel = await import('@/store/selectors');
    const [review] = useStore.getState().reviews;
    useStore.setState({ reviews: [{ ...review, id: 'R-1', decided: false }] });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-reviews')?.item).toBe('R-1');
    useStore.setState({ reviews: [{ ...review, id: 'R-1', decided: false }, { ...review, id: 'R-2', decided: false }] });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-reviews')?.item).toBeUndefined();

    useStore.setState({ role: 'engineer' });
    const cl = useStore.getState().checklist;
    if (cl && !cl.submitted) {
      expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'eng-checklist')?.item).toBe(cl.id);
    }
  });

  it('the For You card opens the record, not the list', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'inbox' });
    const [review] = useStore.getState().reviews;
    useStore.setState({ reviews: [{ ...review, id: 'R-1', decided: false }] });
    const { InboxScreen } = await import('@/screens/InboxScreen');
    const r = render(<InboxScreen />);
    fireEvent.click(r.getByTestId('inbox-cta-pmc-reviews'));
    expect(where(useStore)).toEqual({ screen: 'inspect-review', item: 'R-1' });
  });
});

describe('the record-link helpers follow the bell', () => {
  it('a decision opens on the approval screen only when it awaits this viewer, else in the Decision Log', async () => {
    const { useStore } = await demo();
    const sel = await import('@/store/selectors');
    const d = useStore.getState().decisions[0];
    useStore.setState({ role: 'client' });
    expect(sel.decisionRecordLink(useStore.getState(), { ...d, status: 'pending', deciderKind: 'client', draft: false }).screen).toBe('client-decisions');
    expect(sel.decisionRecordLink(useStore.getState(), { ...d, status: 'approved', deciderKind: 'client', draft: false }).screen).toBe('decision-log');
    useStore.setState({ role: 'pmc' });
    expect(sel.decisionRecordLink(useStore.getState(), { ...d, status: 'pending', deciderKind: 'client', draft: false }).screen).toBe('decision-log');
  });

  it('an inspection opens only on an inspection screen the role holds and that resolves it', async () => {
    const { useStore } = await demo();
    const sel = await import('@/store/selectors');
    const [review] = useStore.getState().reviews;
    useStore.setState({ role: 'pmc', reviews: [{ ...review, id: 'R-1', decided: false }], openChecklists: [] });
    expect(sel.inspectionRecordLink(useStore.getState(), 'R-1')).toEqual({ screen: 'inspect-review', item: 'R-1' });
    expect(sel.inspectionRecordLink(useStore.getState(), 'GONE')).toBeNull();
    useStore.setState({ role: 'client' });
    expect(sel.inspectionRecordLink(useStore.getState(), 'R-1')).toBeNull();
  });
});

describe('screens that name one record open it', () => {
  it('the Site Map: a decision row opens its record; a drawing opens at /drawings/<id>; an inspection the role can open is a link', async () => {
    const { useStore } = await demo({ role: 'pmc' });
    const s = useStore.getState();
    const decision = s.decisions.find((d) => !d.draft && d.nodeId);
    const drawing = s.drawings.find((d) => !d.draft && d.nodeId);
    const { PlacesScreen } = await import('@/screens/PlacesScreen');
    const r = render(<PlacesScreen />);
    if (decision) {
      fireEvent.click(r.getByTestId(`place-decision-${decision.id}`));
      expect(where(useStore)).toEqual({ screen: 'decision-log', item: decision.id });
    }
    cleanup();
    useStore.setState({ screen: 'places', routeItem: null });
    const r2 = render(<PlacesScreen />);
    if (drawing) {
      fireEvent.click(r2.getByTestId(`place-drawing-${drawing.number}`));
      expect(where(useStore)).toEqual({ screen: 'drawings', item: drawing.id });
    }
    expect(decision || drawing).toBeTruthy();
  });

  it('the Dashboard: the single-review tile opens that review', async () => {
    const { useStore } = await demo({ role: 'pmc' });
    const [review] = useStore.getState().reviews;
    useStore.setState({ reviews: [{ ...review, id: 'R-1', decided: false }] });
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    fireEvent.click(r.getByTestId('tile-review'));
    expect(where(useStore)).toEqual({ screen: 'inspect-review', item: 'R-1' });
  });

  it('client Health: one waiting decision opens at it; a recently approved row opens its record', async () => {
    const { useStore } = await demo({ role: 'client' });
    const sel = await import('@/store/selectors');
    const waiting = sel.selectDecisionsNeedingViewer(useStore.getState());
    useStore.setState({ decisions: useStore.getState().decisions.filter((d) => d.id === waiting[0].id || d.status === 'approved') });
    const { ClientHealthScreen } = await import('@/screens/ClientHealthScreen');
    const r = render(<ClientHealthScreen />);
    fireEvent.click(r.getByText(/1 decision waiting for you/));
    expect(where(useStore)).toEqual({ screen: 'client-decisions', item: waiting[0].id });
    const approved = sel.selectApprovedDecisions(useStore.getState())[0];
    if (approved) {
      fireEvent.click(r.getByTestId(`health-approved-${approved.id}`));
      expect(where(useStore)).toEqual({ screen: 'decision-log', item: approved.id });
    }
  });

  it('the Daily Log: the decision a material is checked against opens at its record', async () => {
    const { useStore } = await demo({ role: 'engineer' });
    const log = useStore.getState().dailyLog!;
    const idx = log.materials.findIndex((m) => m.decisionId);
    expect(idx).toBeGreaterThanOrEqual(0);
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    fireEvent.click(r.getByTestId(`material-decision-${idx}`));
    expect(where(useStore)).toEqual({ screen: 'decision-log', item: log.materials[idx].decisionId });
  });
});

describe('#775 Codex findings', () => {
  it('4239168287 — a contractor\'s single open change request opens at its record', async () => {
    const { useStore } = await demo({ role: 'contractor' });
    const sel = await import('@/store/selectors');
    const d = useStore.getState().decisions[0];
    useStore.setState({ decisions: [{ ...d, id: 'C-1', status: 'change', draft: false }], drawings: [] });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'con-change')?.item).toBe('C-1');
  });

  it('4239168284 — an unsettled decision slice never opens live approval controls', async () => {
    const { useStore } = await demo({ role: 'client' });
    const sel = await import('@/store/selectors');
    const d = { ...useStore.getState().decisions[0], status: 'pending' as const, deciderKind: 'client' as const, draft: false };
    expect(sel.decisionRecordLink(useStore.getState(), d).screen).toBe('client-decisions');
    useStore.setState({ commandReconcileOwed: { ...useStore.getState().commandReconcileOwed, decisions: true } });
    expect(sel.decisionRecordLink(useStore.getState(), d).screen).toBe('decision-log');
    useStore.setState({ commandReconcileOwed: { ...useStore.getState().commandReconcileOwed, decisions: false }, decisionsLoad: 'error' });
    expect(sel.decisionRecordLink(useStore.getState(), d).screen).toBe('decision-log');
    useStore.setState({ decisions: [d] });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'client-pending')?.item).toBeUndefined();
  });

  it('4239168292 — the Daily Log\'s decision link opens where the viewer decides it', async () => {
    const { useStore } = await demo({ role: 'engineer', sessionUserId: 'u-eng' });
    const log = useStore.getState().dailyLog!;
    const idx = log.materials.findIndex((m) => m.decisionId);
    const id = log.materials[idx].decisionId!;
    useStore.setState({
      decisions: useStore.getState().decisions.map((d) => (d.id === id ? { ...d, status: 'pending', draft: false, deciderKind: 'member', deciderUserId: 'u-eng' } : d)),
    });
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    fireEvent.click(r.getByTestId(`material-decision-${idx}`));
    expect(where(useStore)).toEqual({ screen: 'client-decisions', item: id });
  });
});

describe('#775 Codex 4239201827 — inspection links only from a settled slice', () => {
  it('a retained review is no link while the inspection read failed or a reconcile is owed', async () => {
    const { useStore } = await demo({ role: 'pmc' });
    const sel = await import('@/store/selectors');
    const [review] = useStore.getState().reviews;
    useStore.setState({ reviews: [{ ...review, id: 'R-1', decided: false }], openChecklists: [] });
    expect(sel.inspectionRecordLink(useStore.getState(), 'R-1')).not.toBeNull();
    useStore.setState({ inspectionsLoad: 'error' });
    expect(sel.inspectionRecordLink(useStore.getState(), 'R-1')).toBeNull();
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-reviews')?.item).toBeUndefined();
    useStore.setState({ inspectionsLoad: 'idle', commandReconcileOwed: { ...useStore.getState().commandReconcileOwed, inspections: true } });
    expect(sel.inspectionRecordLink(useStore.getState(), 'R-1')).toBeNull();
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    const r = render(<DashboardScreen />);
    fireEvent.click(r.getByTestId('tile-review'));
    expect(where(useStore)).toEqual({ screen: 'inspect-review', item: null });
  });
});

describe('#775 root-cause audit — every record link waits for its slice', () => {
  it('a drawing card and the client Health CTA never open live controls from an unsettled slice', async () => {
    const { useStore } = await demo({ role: 'contractor' });
    const sel = await import('@/store/selectors');
    const d = useStore.getState().drawings.find((x) => !x.draft && x.current?.status === 'for_construction');
    if (d) {
      useStore.setState({ drawings: [{ ...d, ackedByMe: false, recipientOfCurrent: true }] });
      expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'con-ack')?.item).toBe(d.id);
      useStore.setState({ drawingsLoad: 'error' });
      expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'con-ack')?.item).toBeUndefined();
    }
    cleanup();
    const client = await demo({ role: 'client' });
    const waiting = sel.selectDecisionsNeedingViewer(client.useStore.getState());
    client.useStore.setState({ decisions: client.useStore.getState().decisions.filter((x) => x.id === waiting[0].id), decisionsLoad: 'error' });
    const { ClientHealthScreen } = await import('@/screens/ClientHealthScreen');
    const r = render(<ClientHealthScreen />);
    fireEvent.click(r.getByText(/1 decision waiting for you/));
    expect(where(client.useStore)).toEqual({ screen: 'decision-log', item: waiting[0].id });
  });
});

describe('Top 10 #3c — an activity is a record: /schedule/<activityId>', () => {
  it('the schedule is an item screen: the URL names the activity and parses back', async () => {
    const { pathForScreen, parseLocation } = await import('@/lib/screens');
    expect(pathForScreen('site-schedule', 'ambli', 'ACT-28')).toBe('/projects/ambli/schedule/ACT-28');
    expect(parseLocation('/projects/ambli/schedule/ACT-28')).toEqual({ projectId: 'ambli', screen: 'site-schedule', item: 'ACT-28' });
  });

  it('"View in schedule" and a single blocked / override item open the activity at its URL', async () => {
    const { useStore } = await demo({ role: 'pmc' });
    const sel = await import('@/store/selectors');
    const [a, b] = useStore.getState().activities;
    useStore.getState().openActivity(a.id);
    expect(where(useStore)).toEqual({ screen: 'site-schedule', item: a.id });
    useStore.setState({ activities: [{ ...a, status: 'blocked' }, { ...b, status: 'not-started' }] });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-blocked')?.item).toBe(a.id);
    const soon = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    useStore.setState({ activities: [{ ...a, overrides: [{ ...(a.overrides?.[0] ?? {}), expiresAt: soon, reason: 'r' } as never] }, { ...b, overrides: [] }] });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-override-expiry')?.item).toBe(a.id);
  });

  it('an activity the settled schedule does not hold says so, and "Show the whole schedule" clears the link', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule', routeItem: 'ACT-GONE' });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(r.getByText(/ACT-GONE/)).toBeInTheDocument();
    fireEvent.click(r.getByText('Show the whole schedule'));
    expect(useStore.getState().routeItem).toBeNull();
  });
});

describe('Top 10 #3c — activity links wait for the activity spine', () => {
  it('a single blocked activity names no record while an activity reconcile is owed', async () => {
    const { useStore } = await demo({ role: 'pmc' });
    const sel = await import('@/store/selectors');
    const [a, b] = useStore.getState().activities;
    useStore.setState({ activities: [{ ...a, status: 'blocked' }, { ...b, status: 'not-started' }] });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-blocked')?.item).toBe(a.id);
    useStore.setState({ commandReconcileOwed: { ...useStore.getState().commandReconcileOwed, activities: true } });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-blocked')?.item).toBeUndefined();
  });

  it('a linked activity is not called missing while an activity reconcile is owed', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule', routeItem: 'ACT-NEW' });
    useStore.setState({ commandReconcileOwed: { ...useStore.getState().commandReconcileOwed, activities: true } });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(r.queryByText('Show the whole schedule')).toBeNull();
  });
});

