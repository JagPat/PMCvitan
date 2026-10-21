import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { warmImports } from './warm-imports';

/**
 * Top 10 #3a (#774) — every card about ONE record opens that record at its own URL (`openItem` → screen +
 * routeItem), never the parent list: For You items naming exactly one record, the Site Map's inspection,
 * decision and drawing rows, the Dashboard's single-review tile, the client's Health links and the Daily
 * Log's decision reference. Destinations follow the bell's rules (`decisionRecordLink`, `inspectionRecordLink`).
 */

await warmImports(() => import('@/store/store'), () => import('@/store/selectors'), () => import('@/screens/InboxScreen'), () => import('@/screens/PlacesScreen'), () => import('@/screens/DashboardScreen'), () => import('@/screens/ClientHealthScreen'), () => import('@/screens/DailyLogScreen'), () => import('@/lib/screens'), () => import('@/screens/ScheduleScreen'));

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
    // #777 Codex 4239476426 — nor is the whole schedule (its live controls) shown under the activity's URL
    expect(r.getByTestId('activities-loading')).toBeInTheDocument();
    expect(r.queryByTestId(/^edit-/)).toBeNull();
  });

  it('#777 Codex 4239476423 — with an API scope, the idle store (demo seeds before the first fetch) names no activity', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    const { useStore } = await demo({ role: 'pmc', projectLoadState: 'idle' });
    const sel = await import('@/store/selectors');
    const [a, b] = useStore.getState().activities;
    useStore.setState({ activities: [{ ...a, status: 'blocked' }, { ...b, status: 'not-started' }] });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-blocked')?.item).toBeUndefined();
    useStore.setState({ projectLoadState: 'ready' });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-blocked')?.item).toBe(a.id);
  });
});

describe('Top 10 #3c — the routed activity, through navigation and edits (#777 Codex)', () => {
  it('4239476418 — until the store adopts the URL item (or clears it after Back), nothing actionable is shown', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule', routeItem: null });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const { MemoryRouter } = await import('react-router-dom');
    const [a] = useStore.getState().activities;
    const cold = render(<MemoryRouter initialEntries={[`/projects/ambli/schedule/${a.id}`]}><ScheduleScreen /></MemoryRouter>);
    expect(cold.getByTestId('activities-opening').textContent).toContain(a.id);
    expect(cold.queryByTestId(/^edit-/)).toBeNull();
    cold.unmount();

    useStore.setState({ routeItem: a.id });
    const back = render(<MemoryRouter initialEntries={['/projects/ambli/schedule']}><ScheduleScreen /></MemoryRouter>);
    expect(back.getByTestId('activities-returning')).toBeInTheDocument();
  });

  it('4239476429 — deleting the routed activity releases the route once the removal lands; a refused deletion keeps it', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule' });
    const [a, ...rest] = useStore.getState().activities;
    useStore.setState({ routeItem: a.id });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    const del = async () => {
      fireEvent.click(r.getByTestId(`edit-${a.id}`));
      fireEvent.click(r.getByTestId('activity-delete'));
      await act(async () => { fireEvent.click(r.getByText('Delete activity')); });
    };
    await del(); // no server: refused, the row stays
    expect(useStore.getState().routeItem).toBe(a.id);
    expect(r.queryByText('Show the whole schedule')).toBeNull();

    useStore.setState({ deleteActivity: vi.fn(async () => true) }); // the server accepts it
    await del();
    act(() => useStore.setState({ activities: rest })); // the removal lands
    expect(useStore.getState().routeItem).toBeNull();
    expect(r.queryByText('Show the whole schedule')).toBeNull(); // never "not found" for one's own deletion
  });

  it('#780 — after a REFUSED delete, someone else removing the row reads as not found, not as one\'s own release', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule' });
    const [a, ...rest] = useStore.getState().activities;
    useStore.setState({ routeItem: a.id, deleteActivity: vi.fn(async () => false) });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    fireEvent.click(r.getByTestId(`edit-${a.id}`));
    fireEvent.click(r.getByTestId('activity-delete'));
    await act(async () => { fireEvent.click(r.getByText('Delete activity')); });
    act(() => useStore.setState({ activities: rest })); // a later, unrelated removal
    expect(useStore.getState().routeItem).toBe(a.id);
    expect(r.getByText('Show the whole schedule')).toBeInTheDocument();
  });

  it('#780 — a Site Map hand-off made while activities are unsettled still moves focus once they settle', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule' });
    const [a] = useStore.getState().activities;
    useStore.setState({ commandReconcileOwed: { ...useStore.getState().commandReconcileOwed, activities: true } });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    act(() => useStore.getState().openActivity(a.id));
    expect(r.getByTestId('activities-loading')).toBeInTheDocument();
    expect(useStore.getState().activityFocus).toBe(a.id); // the intent is kept
    act(() => useStore.setState({ commandReconcileOwed: { ...useStore.getState().commandReconcileOwed, activities: false } }));
    expect(document.activeElement?.id).toBe(`sched-${a.id}`);
    expect(useStore.getState().activityFocus).toBeNull();
  });

  it('4239476431 — the link reveals its row once; a schedule refresh does not pull the viewer back', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule' });
    const [a] = useStore.getState().activities;
    useStore.setState({ routeItem: a.id });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    render(<ScheduleScreen />);
    expect(scroll).toHaveBeenCalledTimes(1);
    act(() => useStore.setState({ activities: useStore.getState().activities.map((x) => ({ ...x })) }));
    expect(scroll).toHaveBeenCalledTimes(1);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});

describe('Top 10 #3c — round 2 (#777 Codex on 2461392)', () => {
  it('4239523475 — a routed row the unsettled slice still holds is not actionable until the slice settles', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule' });
    const [a] = useStore.getState().activities;
    useStore.setState({ routeItem: a.id, commandReconcileOwed: { ...useStore.getState().commandReconcileOwed, activities: true } });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(r.getByTestId('activities-loading')).toBeInTheDocument();
    expect(r.queryByTestId(`edit-${a.id}`)).toBeNull();
    act(() => useStore.setState({ commandReconcileOwed: { ...useStore.getState().commandReconcileOwed, activities: false } }));
    expect(r.getByTestId(`edit-${a.id}`)).toBeInTheDocument();
  });

  it('4239523461 — a failed project snapshot shows the failure and Retry, not an endless "Loading"', async () => {
    // module read-ownership: the activities read retained a last-good slice ('ready') while the snapshot failed
    vi.stubEnv('VITE_ACTIVITIES_READ', 'moduleQuery');
    await demo({ role: 'pmc', screen: 'site-schedule', routeItem: 'ACT-ABSENT', projectLoadState: 'error', activitiesLoad: 'ready' });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(r.getByTestId('activities-unavailable')).toBeInTheDocument();
    expect(r.getByTestId('activities-retry')).toBeInTheDocument();
  });

  it('4239523467 — a place filter that hides the routed activity is cleared, and the row revealed', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule', routeItem: null });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    fireEvent.change(r.getByTestId('sched-place-filter'), { target: { value: 'z-terrace' } });
    expect(r.queryByTestId('edit-ACT-31')).toBeNull(); // Living Room Flooring is outside the Terrace
    act(() => useStore.setState({ routeItem: 'ACT-31' }));
    expect((r.getByTestId('sched-place-filter') as HTMLSelectElement).value).toBe('');
    expect(r.getByTestId('edit-ACT-31')).toBeInTheDocument();
  });

  it('4239523470 — A → unknown B → Back to A reveals A again', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule' });
    const [a] = useStore.getState().activities;
    useStore.setState({ routeItem: a.id });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    expect(scroll).toHaveBeenCalledTimes(1);
    act(() => useStore.setState({ routeItem: 'ACT-UNKNOWN' }));
    expect(r.getByText('Show the whole schedule')).toBeInTheDocument();
    act(() => useStore.setState({ routeItem: a.id }));
    expect(scroll).toHaveBeenCalledTimes(2);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
});

describe('Top 10 #3c — round 3 (#777 Codex on 02fbc68)', () => {
  it('4239561636 — two expiring overrides on ONE activity open that activity; on two activities, the schedule', async () => {
    const { useStore } = await demo({ role: 'pmc' });
    const sel = await import('@/store/selectors');
    const [a, b] = useStore.getState().activities;
    const soon = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    const ov = (id: string) => ({ ...(a.overrides?.[0] ?? {}), id, expiresAt: soon, reason: 'r' }) as never;
    useStore.setState({ activities: [{ ...a, overrides: [ov('o1'), ov('o2')] }, { ...b, overrides: [] }] });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-override-expiry')?.item).toBe(a.id);
    useStore.setState({ activities: [{ ...a, overrides: [ov('o1')] }, { ...b, overrides: [ov('o2')] }] });
    expect(sel.selectActionItems(useStore.getState()).find((i) => i.key === 'pmc-override-expiry')?.item).toBeUndefined();
  });
});

describe('Top 10 #3c follow-up — #781 Codex on 4a15d38', () => {
  it('4240026311 — the row leaving while a delete is in flight releases nothing; the refusal then shows not found', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule' });
    const [a, ...rest] = useStore.getState().activities;
    let settle: (ok: boolean) => void = () => {};
    useStore.setState({ routeItem: a.id, deleteActivity: vi.fn(() => new Promise<boolean>((r) => { settle = r; })) });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    fireEvent.click(r.getByTestId(`edit-${a.id}`));
    fireEvent.click(r.getByTestId('activity-delete'));
    fireEvent.click(r.getByText('Delete activity'));
    act(() => useStore.setState({ activities: rest })); // a refresh removes it while the request is pending
    expect(useStore.getState().routeItem).toBe(a.id); // not released
    expect(r.getByTestId('activities-loading')).toBeInTheDocument(); // nor called missing yet
    await act(async () => { settle(false); }); // the server refuses this attempt
    expect(useStore.getState().routeItem).toBe(a.id);
    expect(r.getByText('Show the whole schedule')).toBeInTheDocument(); // someone else's removal: not found
  });

  it('4240026312 — a hand-off waiting on an unsettled schedule is abandoned when the viewer navigates away', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'places' });
    const [a] = useStore.getState().activities;
    useStore.setState({ commandReconcileOwed: { ...useStore.getState().commandReconcileOwed, activities: true } });
    useStore.getState().openActivity(a.id);
    expect(useStore.getState().activityFocus).toBe(a.id);
    useStore.getState().setScreen('inbox');
    expect(useStore.getState().activityFocus).toBeNull();
    useStore.getState().openActivity(a.id);
    useStore.getState().openItem('decision-log', 'DL-014');
    expect(useStore.getState().activityFocus).toBeNull();
  });
});

describe('Top 10 #3c follow-up — #781 Codex on f3bfe37', () => {
  it('4240054970 — an earlier attempt\'s refusal does not clear a later attempt still in flight', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule' });
    const [a, ...rest] = useStore.getState().activities;
    const settles: Array<(ok: boolean) => void> = [];
    useStore.setState({ routeItem: a.id, deleteActivity: vi.fn(() => new Promise<boolean>((r) => { settles.push(r); })) });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    const confirm = () => {
      fireEvent.click(r.getByTestId(`edit-${a.id}`));
      fireEvent.click(r.getByTestId('activity-delete'));
      fireEvent.click(r.getByText('Delete activity'));
    };
    confirm(); confirm(); // two attempts on a slow connection
    await act(async () => { settles[0](false); }); // the first is refused
    act(() => useStore.setState({ activities: rest })); // the row leaves while the second is outstanding
    expect(r.getByTestId('activities-loading')).toBeInTheDocument(); // not "not found" yet
    await act(async () => { settles[1](true); }); // the second is accepted
    expect(useStore.getState().routeItem).toBeNull();
  });
});

describe('Top 10 #3c follow-up — #781 Codex on 1dd46d5', () => {
  it('4240078396 — a NEWER attempt refused first leaves the older one pending (reverse settlement order)', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'site-schedule' });
    const [a, ...rest] = useStore.getState().activities;
    const settles: Array<(ok: boolean) => void> = [];
    useStore.setState({ routeItem: a.id, deleteActivity: vi.fn(() => new Promise<boolean>((r) => { settles.push(r); })) });
    const { ScheduleScreen } = await import('@/screens/ScheduleScreen');
    const r = render(<ScheduleScreen />);
    const confirm = () => {
      fireEvent.click(r.getByTestId(`edit-${a.id}`));
      fireEvent.click(r.getByTestId('activity-delete'));
      fireEvent.click(r.getByText('Delete activity'));
    };
    confirm(); confirm();
    await act(async () => { settles[1](false); }); // the newer attempt is refused first
    act(() => useStore.setState({ activities: rest })); // the row leaves while the older one is outstanding
    expect(r.getByTestId('activities-loading')).toBeInTheDocument();
    await act(async () => { settles[0](false); }); // the older is refused too: now someone else's removal
    expect(useStore.getState().routeItem).toBe(a.id);
    expect(r.getByText('Show the whole schedule')).toBeInTheDocument();
  });
});

