import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { ActivityReadinessRow, ActivityShortageRow, LabourActivityForecastDto, MaterialReadinessResult } from '@vitan/shared';
import type { MaterialsView } from '@/store/materials';
import type { LabourView } from '@/store/labour';
import { routedRecordState } from '@/lib/useRoutedRecord';
import { parseLocation, pathForScreen } from '@/lib/screens';
import { warmImports } from './warm-imports';

/**
 * Top 10 #3 gap 12 (#798), unit 12a — the pilot hubs' activity records. `/materials/<activityId>` and
 * `/labour/<activityId>` open ONE activity's readiness, reload-safe, from a settled bundle; a shortage card that
 * stands for one activity opens it rather than the hub.
 */

await warmImports(() => import('@/store/store'), () => import('@/store/selectors'), () => import('@/screens/InboxScreen'), () => import('@/screens/MaterialsScreen'), () => import('@/screens/LabourScreen'), () => import('@/lib/screens'), () => import('@/layout/RouteBridge'), () => import('@/screens/DailyLogScreen'));

afterEach(() => {
  cleanup();
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

const shortage = (activityId: string, over: Partial<ActivityShortageRow> = {}): ActivityShortageRow => ({
  activityId, activityName: `Activity ${activityId}`, verdict: 'blocked',
  requirementCount: 1, shortRequirementCount: 1, plannedStartDate: '2026-08-10', requiredBy: '2026-08-15',
  needBy: '2026-08-10', commitmentPromisedDate: null,
  reason: '1 of 1 requirement short', impact: 'no-supply', impactReason: 'No covering delivery', ...over,
});
const ready = (activityId: string): ActivityReadinessRow => ({ ...shortage(activityId), verdict: 'ready', shortRequirementCount: 0, reason: 'Covered' });
const materials = (shortages: ActivityShortageRow[], extra: ActivityReadinessRow[] = []): MaterialsView => {
  const readiness: MaterialReadinessResult = {
    requirements: [],
    activities: [...shortages, ...extra],
    shortages,
    summary: { ready: extra.length, atRisk: 0, blocked: shortages.length, total: shortages.length + extra.length },
  };
  return { readiness, requirements: [], requisitions: [], purchaseOrders: [], stock: [], issues: [] };
};
const forecast = (verdict: LabourActivityForecastDto['verdict']): LabourActivityForecastDto => ({ verdict, reason: `${verdict} reason`, coveringDate: null });
const labour = (entries: Record<string, LabourActivityForecastDto>): LabourView => ({
  readiness: { forecast: entries },
  requirements: [],
  workforce: { workers: [], crews: [] },
  catalog: { trades: [], skills: [] },
  requisitions: [],
  purchaseOrders: [],
  commitments: [],
  capacity: { allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] },
  presence: { civilDate: '2026-07-28', musters: [], mismatches: [] },
  productivity: { activities: [] },
  workerFingerprints: {},
});

describe('the hub record routes', () => {
  it('/materials/<id> and /labour/<id> name one activity and round-trip through pathForScreen', () => {
    expect(parseLocation('/projects/ambli/materials/ACT-1')).toEqual({ projectId: 'ambli', screen: 'materials', item: 'ACT-1' });
    expect(parseLocation('/projects/ambli/labour/ACT-2')).toEqual({ projectId: 'ambli', screen: 'labour', item: 'ACT-2' });
    expect(pathForScreen('materials', 'ambli', 'ACT 1')).toBe('/projects/ambli/materials/ACT%201');
    expect(pathForScreen('labour', 'ambli', null)).toBe('/projects/ambli/labour');
  });

  it('a routed record waits for its URL to be adopted, then for a settled slice, before it is shown or judged missing', () => {
    const slice = (settled: boolean, failed = false) => ({ settled, failed, holds: (id: string) => id === 'A' });
    expect(routedRecordState('A', null, slice(true))).toEqual({ state: 'opening', id: 'A' });
    expect(routedRecordState(null, 'A', slice(true))).toEqual({ state: 'returning' });
    expect(routedRecordState(null, null, slice(false))).toEqual({ state: 'list' });
    expect(routedRecordState('A', 'A', slice(false))).toEqual({ state: 'loading', id: 'A' });
    expect(routedRecordState('A', 'A', slice(false, true))).toEqual({ state: 'unavailable', id: 'A' });
    expect(routedRecordState('A', 'A', slice(true))).toEqual({ state: 'record', id: 'A' });
    expect(routedRecordState('B', 'B', slice(true))).toEqual({ state: 'missing', id: 'B' });
    // outside a router only the store's item counts
    expect(routedRecordState(undefined, 'A', slice(true))).toEqual({ state: 'record', id: 'A' });
  });
});

describe('For You shortage cards name their activity when they stand for exactly one', () => {
  it('materials: one short activity from a settled bundle carries its id; two, or an unsettled bundle, do not', async () => {
    const { useStore } = await demo({ role: 'pmc', materialsView: materials([shortage('ACT-1')]), materialsLoad: 'ready' });
    const sel = await import('@/store/selectors');
    const item = () => sel.selectActionItems(useStore.getState()).find((i) => i.key === 'material-shortage')?.item;
    expect(item()).toBe('ACT-1');
    useStore.setState({ materialsLoad: 'error' }); // a failed refresh retained the last-good bundle
    expect(item()).toBeUndefined();
    useStore.setState({ materialsLoad: 'ready', materialsView: materials([shortage('ACT-1'), shortage('ACT-2')]) });
    expect(item()).toBeUndefined();
  });

  it('labour: one shortfall from a settled bundle carries its activity; a ready activity does not count', async () => {
    const { useStore } = await demo({ role: 'engineer', labourView: labour({ 'ACT-1': forecast('blocked'), 'ACT-2': forecast('ready') }), labourLoad: 'ready' });
    const sel = await import('@/store/selectors');
    const item = () => sel.selectActionItems(useStore.getState()).find((i) => i.key === 'labour-shortage')?.item;
    expect(item()).toBe('ACT-1');
    useStore.setState({ labourLoad: 'loading', labourView: null });
    expect(item()).toBeUndefined();
    useStore.setState({ labourLoad: 'ready', labourView: labour({ 'ACT-1': forecast('blocked'), 'ACT-2': forecast('at-risk') }) });
    expect(item()).toBeUndefined();
  });

  it('the For You card opens the activity record, not the hub', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'inbox', materialsView: materials([shortage('ACT-1')]), materialsLoad: 'ready' });
    const { InboxScreen } = await import('@/screens/InboxScreen');
    const r = render(<InboxScreen />);
    fireEvent.click(r.getByTestId('inbox-cta-material-shortage'));
    expect({ screen: useStore.getState().screen, item: useStore.getState().routeItem }).toEqual({ screen: 'materials', item: 'ACT-1' });
  });
});

describe('the Materials hub shows a routed activity on its own', () => {
  it('shows only that activity, with a way back to the whole hub', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'materials', capabilities: ['materials'], routeItem: 'ACT-1', materialsView: materials([shortage('ACT-1')], [ready('ACT-2')]), materialsLoad: 'ready' });
    const { MaterialsScreen } = await import('@/screens/MaterialsScreen');
    const r = render(<MaterialsScreen />);
    expect(r.getByTestId('materials-record')).toBeTruthy();
    expect(r.getByTestId('materials-activity-ACT-1')).toBeTruthy();
    expect(r.queryByTestId('materials-activity-ACT-2')).toBeNull();
    expect(r.queryByTestId('materials-summary')).toBeNull();
    fireEvent.click(r.getByTestId('materials-record-show-all'));
    expect(useStore.getState().routeItem).toBeNull();
    expect(r.getByTestId('materials-activity-ACT-2')).toBeTruthy();
  });

  it('an activity the settled bundle does not hold is "not found"; a resolved shortage is still its record', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'materials', capabilities: ['materials'], routeItem: 'GONE', materialsView: materials([], [ready('ACT-2')]), materialsLoad: 'ready' });
    const { MaterialsScreen } = await import('@/screens/MaterialsScreen');
    const r = render(<MaterialsScreen />);
    expect(r.getByTestId('item-not-found').textContent).toContain('GONE');
    cleanup();
    useStore.setState({ routeItem: 'ACT-2' });
    const again = render(<MaterialsScreen />);
    expect(again.getByTestId('materials-verdict-ACT-2').textContent).toBe('READY');
  });

  it('a retained or unloaded bundle shows a boundary, never the record\'s live controls or "not found"', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'materials', capabilities: ['materials'], routeItem: 'ACT-1', materialsView: materials([shortage('ACT-1')]), materialsLoad: 'error' });
    const { MaterialsScreen } = await import('@/screens/MaterialsScreen');
    const r = render(<MaterialsScreen />);
    expect(r.getByTestId('materials-record-unavailable')).toBeTruthy();
    expect(r.queryByTestId('materials-cover-ACT-1')).toBeNull();
    expect(r.queryByTestId('item-not-found')).toBeNull();
    cleanup();
    useStore.setState({ materialsView: null, materialsLoad: 'loading' });
    const loading = render(<MaterialsScreen />);
    expect(loading.getByTestId('materials-record-loading')).toBeTruthy();
    expect(loading.queryByTestId('item-not-found')).toBeNull();
  });

  it('a cold link waits for RouteBridge to adopt the URL\'s activity before showing anything actionable', async () => {
    await demo({ role: 'pmc', screen: 'materials', capabilities: ['materials'], routeItem: null, materialsView: materials([shortage('ACT-1')]), materialsLoad: 'ready' });
    const { MaterialsScreen } = await import('@/screens/MaterialsScreen');
    const { MemoryRouter } = await import('react-router-dom');
    const r = render(<MemoryRouter initialEntries={['/projects/ambli/materials/ACT-1']}><MaterialsScreen /></MemoryRouter>);
    expect(r.getByTestId('materials-record-opening')).toBeTruthy();
    expect(r.queryByTestId('materials-cover-ACT-1')).toBeNull();
  });
});

describe('the Labour hub shows a routed activity on its own', () => {
  it('shows only that activity\'s forecast; an unknown one is "not found"; an unsettled bundle waits', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'labour', capabilities: ['labour'], routeItem: 'ACT-1', labourView: labour({ 'ACT-1': forecast('blocked'), 'ACT-2': forecast('ready') }), labourLoad: 'ready' });
    const { LabourScreen } = await import('@/screens/LabourScreen');
    const r = render(<LabourScreen />);
    expect(r.getByTestId('labour-record')).toBeTruthy();
    expect(r.getByTestId('labour-verdict-ACT-1').textContent).toBe('BLOCKED');
    expect(r.queryByTestId('labour-activity-ACT-2')).toBeNull();
    fireEvent.click(r.getByTestId('labour-record-show-all'));
    expect(useStore.getState().routeItem).toBeNull();
    cleanup();

    useStore.setState({ routeItem: 'GONE' });
    expect(render(<LabourScreen />).getByTestId('item-not-found').textContent).toContain('GONE');
    cleanup();

    useStore.setState({ routeItem: 'ACT-1', labourLoad: 'error' });
    const failed = render(<LabourScreen />);
    expect(failed.getByTestId('labour-record-unavailable')).toBeTruthy();
    expect(failed.queryByTestId('labour-activity-ACT-1')).toBeNull();
  });
});

describe('the site log is a record at /site/log/<dailyLogId> (12c)', () => {
  const log = (over: Record<string, unknown> = {}) => ({
    id: 'LOG-1', date: '12 Oct 2026', logDate: '2026-10-12', checkedIn: true, checkinTime: '08:10', submitted: false,
    crew: [], materials: [], progress: 0, photos: [], ...over,
  });

  it('the route parses, and the PMC reaches it by link (and, since 14 Oct 2026, from its nav)', async () => {
    const screens = await import('@/lib/screens');
    expect(parseLocation('/projects/ambli/site/log/LOG-1')).toEqual({ projectId: 'ambli', screen: 'daily-log', item: 'LOG-1' });
    expect(screens.screensFor('pmc').map((m) => m.key)).toContain('daily-log');
    expect(screens.routableScreensFor('pmc')).toContain('daily-log');
    expect(screens.routableScreensFor('pmc')[0]).toBe(screens.screensFor('pmc')[0].key); // home unchanged
    expect(screens.routableScreensFor('client')).not.toContain('daily-log');
  });

  it('RouteBridge keeps a PMC on a log link; a client is still sent home', async () => {
    const { useStore } = await demo({ role: 'pmc', screen: 'inbox', dailyLog: log() });
    const { RouteBridge } = await import('@/layout/RouteBridge');
    const { MemoryRouter } = await import('react-router-dom');
    render(<MemoryRouter initialEntries={['/projects/ambli/site/log/LOG-1']}><RouteBridge /></MemoryRouter>);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect({ screen: useStore.getState().screen, item: useStore.getState().routeItem }).toEqual({ screen: 'daily-log', item: 'LOG-1' });
    cleanup();
    useStore.setState({ role: 'client', screen: 'inbox', routeItem: null });
    render(<MemoryRouter initialEntries={['/projects/ambli/site/log/LOG-1']}><RouteBridge /></MemoryRouter>);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(useStore.getState().screen).not.toBe('daily-log');
  });

  it('the engineer\'s "site log isn\'t submitted" card names the log, only from a settled slice', async () => {
    const { useStore } = await demo({ role: 'engineer', dailyLog: log() });
    const sel = await import('@/store/selectors');
    const item = () => sel.selectActionItems(useStore.getState()).find((i) => i.key === 'eng-log')?.item;
    expect(item()).toBe('LOG-1');
    useStore.setState({ projectLoadState: 'loading' });
    expect(item()).toBeUndefined();
  });

  it('shows the log it names; another log is "not found", with a way to the current one', async () => {
    const { useStore } = await demo({ role: 'engineer', screen: 'daily-log', routeItem: 'LOG-1', dailyLog: log() });
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    expect(r.queryByTestId('item-not-found')).toBeNull();
    expect(r.getByText('DAILY SITE LOG')).toBeTruthy();
    cleanup();
    useStore.setState({ routeItem: 'LOG-OLD' });
    const other = render(<DailyLogScreen />);
    expect(other.getByTestId('item-not-found').textContent).toContain('LOG-OLD');
    fireEvent.click(other.getByTestId('item-not-found-show-all'));
    expect(useStore.getState().routeItem).toBeNull();
  });

  it('an unsettled slice waits rather than judging the log missing', async () => {
    await demo({ role: 'engineer', screen: 'daily-log', routeItem: 'LOG-2', dailyLog: log(), projectLoadState: 'loading' });
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    expect(r.getByTestId('daily-log-record-loading')).toBeTruthy();
    expect(r.queryByTestId('item-not-found')).toBeNull();
  });

  it('starting a new day from a sent log\'s URL releases the route, so the viewer\'s own start never reads as "not found"', async () => {
    const { useStore } = await demo({ role: 'engineer', screen: 'daily-log', routeItem: 'LOG-1', dailyLog: log({ submitted: true }) });
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    fireEvent.click(r.getByTestId('start-new-day'));
    expect(useStore.getState().routeItem).toBeNull();
  });
});
