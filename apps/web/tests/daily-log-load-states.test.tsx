import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { DailyLog } from '@vitan/shared';

/**
 * Phase 2 Task 10 (correction, finding 4) — honest daily-log load states.
 *
 * Under module read-ownership (VITE_DAILYLOG_READ=moduleQuery) the daily-log read is a SEPARATE
 * async surface from the project snapshot, with its own load state. The screen must:
 *   • show "Loading today's log…" while the module read is in flight (idle/loading), never the
 *     "No daily log started" empty state;
 *   • show an "unavailable" boundary + Retry when the read FAILED and there is no last-good log;
 *   • show "No daily log started" ONLY after a read has SUCCEEDED with null;
 *   • disable the mutating commands (start / add-material / flag / submit) while the read is
 *     loading or unavailable — never act on an unsettled log.
 * In the DEFAULT 'snapshot' mode `dailyLogLoad` stays 'idle' and none of these gates trigger.
 * The store also TEARS DOWN the module read state on a scope change (switch / re-auth / sign-out)
 * so a blank new scope never inherits the previous project's 'ready'/'projection'.
 *
 * VITE_* flags resolve against import.meta.env, so each test stubs them, resets the module
 * registry, and dynamically imports the store + screen fresh.
 */

const fullLog = (over: Partial<DailyLog> = {}): DailyLog => ({
  date: '01 Jun 2026', logDate: '2026-06-01', checkedIn: true, checkinTime: '09:00', submitted: false, progress: 3,
  crew: [{ trade: 'Mason', count: 2 }],
  materials: [{ name: 'Cement', decisionId: 'DL-1', qty: '10 bags', zone: 'GF', matched: true, swatch: 'tile', photo: false }],
  photos: [],
  ...over,
});

type StoreState = Record<string, unknown>;

async function loadScreen(mode: 'snapshot' | 'moduleQuery', overrides: StoreState) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.stubEnv('VITE_DAILYLOG_READ', mode);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'engineer',
    short: 'Villa Bodakdev',
    ...overrides,
  });
  const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
  return { useStore, DailyLogScreen };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});
beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('finding 4 — DailyLogScreen honest module-read states (moduleQuery)', () => {
  it('loading: a read in flight shows "Loading…", NOT "No daily log started"', async () => {
    const { DailyLogScreen } = await loadScreen('moduleQuery', { dailyLog: null, dailyLogLoad: 'loading' });
    const r = render(<DailyLogScreen />);
    expect(r.getByText(/Loading today's log/i)).toBeInTheDocument();
    expect(r.queryByText('No daily log started')).not.toBeInTheDocument();
  });

  it('idle (before the first fetch): also treated as loading, not an empty log', async () => {
    const { DailyLogScreen } = await loadScreen('moduleQuery', { dailyLog: null, dailyLogLoad: 'idle' });
    const r = render(<DailyLogScreen />);
    expect(r.getByText(/Loading today's log/i)).toBeInTheDocument();
    expect(r.queryByText('No daily log started')).not.toBeInTheDocument();
  });

  it('error + no last-good: shows the unavailable boundary and a Retry that refetches', async () => {
    const { useStore, DailyLogScreen } = await loadScreen('moduleQuery', { dailyLog: null, dailyLogLoad: 'error' });
    const refetch = vi.fn();
    useStore.setState({ requestFreshSnapshot: refetch });
    const r = render(<DailyLogScreen />);
    expect(r.getByText(/Daily log unavailable/i)).toBeInTheDocument();
    expect(r.queryByText('No daily log started')).not.toBeInTheDocument();
    fireEvent.click(r.getByTestId('daily-log-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('ready + null: "No daily log started" appears ONLY after a successful null read', async () => {
    const { DailyLogScreen } = await loadScreen('moduleQuery', { dailyLog: null, dailyLogLoad: 'ready' });
    const r = render(<DailyLogScreen />);
    expect(r.getByText('No daily log started')).toBeInTheDocument();
    expect(r.queryByText(/Loading today's log/i)).not.toBeInTheDocument();
    expect(r.queryByText(/Daily log unavailable/i)).not.toBeInTheDocument();
  });

  it('error WITH last-good: renders the retained log but LOCKS the mutating commands', async () => {
    const { DailyLogScreen } = await loadScreen('moduleQuery', { dailyLog: fullLog(), dailyLogLoad: 'error' });
    const r = render(<DailyLogScreen />);
    // the last-good log is shown (not blanked)…
    expect(r.getByTestId('submit-daily-log')).toBeInTheDocument();
    // …but its mutating actions are disabled while the read is unavailable
    expect(r.getByTestId('submit-daily-log')).toBeDisabled();
    expect(r.getByTestId('add-material')).toBeDisabled();
    expect(r.getByTestId('flag-DL-1')).toBeDisabled();
  });

  // ── Round 2 finding 2: a failed reconcile that RETAINS last-good must expose a stale warning + Retry ──
  it('round2 finding 2: error WITH last-good shows a visible stale/unavailable warning AND a Retry', async () => {
    const { DailyLogScreen } = await loadScreen('moduleQuery', { dailyLog: fullLog(), dailyLogLoad: 'error' });
    const r = render(<DailyLogScreen />);
    // NOT left silently on stale data with dead controls — a warning + Retry are visible…
    expect(r.getByTestId('daily-log-stale-warning')).toBeInTheDocument();
    expect(r.getByTestId('daily-log-retry')).toBeInTheDocument();
    // …and the mutating commands stay locked until it refreshes
    expect(r.getByTestId('submit-daily-log')).toBeDisabled();
    expect(r.getByTestId('add-material')).toBeDisabled();
  });

  it('round2 finding 2: Retry re-runs the module read; a successful refresh clears the warning and re-enables actions', async () => {
    const { useStore, DailyLogScreen } = await loadScreen('moduleQuery', { dailyLog: fullLog(), dailyLogLoad: 'error' });
    const refetch = vi.fn();
    useStore.setState({ requestFreshSnapshot: refetch });
    const r = render(<DailyLogScreen />);
    // clicking Retry re-runs the scope-guarded module read
    fireEvent.click(r.getByTestId('daily-log-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
    // when the read SUCCEEDS (dailyLogLoad → ready), the warning is gone and the actions unlock
    act(() => { useStore.setState({ dailyLogLoad: 'ready' }); });
    expect(r.queryByTestId('daily-log-stale-warning')).not.toBeInTheDocument();
    expect(r.getByTestId('submit-daily-log')).not.toBeDisabled();
    expect(r.getByTestId('add-material')).not.toBeDisabled();
  });

  it('loading WITH last-good: the log shows but the commands stay locked until the read settles', async () => {
    const { DailyLogScreen } = await loadScreen('moduleQuery', { dailyLog: fullLog(), dailyLogLoad: 'loading' });
    const r = render(<DailyLogScreen />);
    expect(r.getByTestId('submit-daily-log')).toBeDisabled();
    expect(r.getByTestId('add-material')).toBeDisabled();
  });

  it('ready WITH log: the commands are ENABLED once the read has settled', async () => {
    const { DailyLogScreen } = await loadScreen('moduleQuery', { dailyLog: fullLog(), dailyLogLoad: 'ready' });
    const r = render(<DailyLogScreen />);
    expect(r.getByTestId('submit-daily-log')).not.toBeDisabled();
    expect(r.getByTestId('add-material')).not.toBeDisabled();
    expect(r.getByTestId('flag-DL-1')).not.toBeDisabled();
  });
});

describe('finding 4 — snapshot mode is unaffected (no regression)', () => {
  it('idle + null in snapshot mode still shows "No daily log started" (snapshot slice is authoritative)', async () => {
    const { DailyLogScreen } = await loadScreen('snapshot', { dailyLog: null, dailyLogLoad: 'idle' });
    const r = render(<DailyLogScreen />);
    expect(r.getByText('No daily log started')).toBeInTheDocument();
    expect(r.queryByText(/Loading today's log/i)).not.toBeInTheDocument();
  });

  it('a snapshot-mode log leaves the commands enabled (the read state never locks them)', async () => {
    const { DailyLogScreen } = await loadScreen('snapshot', { dailyLog: fullLog(), dailyLogLoad: 'idle' });
    const r = render(<DailyLogScreen />);
    expect(r.getByTestId('submit-daily-log')).not.toBeDisabled();
  });
});

describe('finding 4 — the store tears down the module read state on a scope change', () => {
  async function freshStore() {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    return useStore;
  }

  it('sign-out resets dailyLogLoad → idle and dailyLogSource → null', async () => {
    const useStore = await freshStore();
    useStore.setState({ dailyLogLoad: 'ready', dailyLogSource: 'projection', decisionsLoad: 'error', decisionsSource: 'live' });
    useStore.getState().signOut();
    expect(useStore.getState().dailyLogLoad).toBe('idle');
    expect(useStore.getState().dailyLogSource).toBeNull();
    // the decisions read meta is torn down at the same site (same latent staleness)
    expect(useStore.getState().decisionsLoad).toBe('idle');
    expect(useStore.getState().decisionsSource).toBeNull();
  });

  it('switching project resets the module read state synchronously, before the new snapshot lands', async () => {
    const useStore = await freshStore();
    // a held gateway so the switch stays mid-flight while we inspect the synchronous reset
    const gw = { switchProject: vi.fn().mockImplementation(() => new Promise(() => {})) };
    useStore.getState()._setGateway(gw as never);
    useStore.setState({ activeProjectId: 'ambli', dailyLogLoad: 'ready', dailyLogSource: 'projection' });
    void useStore.getState().switchProject('villa-b');
    expect(useStore.getState().projectLoadState).toBe('switching');
    expect(useStore.getState().dailyLogLoad).toBe('idle');   // not the previous project's 'ready'
    expect(useStore.getState().dailyLogSource).toBeNull();
  });
});
