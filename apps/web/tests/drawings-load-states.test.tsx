import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Drawing, DrawingRevision } from '@vitan/shared';

/**
 * Phase 2 Task 10 (Module 2 — Drawings; finding-4 discipline) — honest drawings load states.
 *
 * Under module read-ownership (VITE_DRAWINGS_READ=moduleQuery) the drawing register is a SEPARATE async
 * surface from the project snapshot, with its own load state. The screen must:
 *   • show "Loading the drawing register…" while the module read is in flight (idle/loading), never the
 *     "No drawings issued yet" empty state;
 *   • show an "unavailable" boundary + Retry when the read FAILED and there is no last-good register;
 *   • show "No drawings issued yet" ONLY after a read has SUCCEEDED empty;
 *   • when the read failed but a last-good register is retained, show a stale warning + Retry and LOCK
 *     the mutating commands (issue / acknowledge) — never act on an unsettled register.
 * In the DEFAULT 'snapshot' mode `drawingsLoad` stays 'idle' and none of these gates trigger. The store
 * also TEARS DOWN the module read state on a scope change (switch / re-auth / sign-out) so a blank new
 * scope never inherits the previous project's 'ready'/'projection'.
 *
 * VITE_* flags resolve against import.meta.env, so each test stubs them, resets the module registry, and
 * dynamically imports the store + screen fresh.
 */

const rev = (id: string): DrawingRevision => ({
  id, rev: 'A', status: 'for_construction', mime: 'application/pdf', url: `/drawings/rev/${id}?t=tok`, sizeBytes: 10, note: '', issuedBy: 'PMC', issuedAt: 'now', acks: [],
});
const dwg = (id: string, number: string): Drawing => ({
  id, number, title: 'Plan', discipline: 'architectural', zone: 'GF', activityId: null, decisionId: null,
  draft: false, current: rev(`${id}-r`), ackedByMe: false, revisions: [rev(`${id}-r`)],
});

type StoreState = Record<string, unknown>;

async function loadScreen(mode: 'snapshot' | 'moduleQuery', overrides: StoreState) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.stubEnv('VITE_DRAWINGS_READ', mode);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'pmc', // pmc can issue → the Issue button is present, so we can assert its locked/enabled state
    short: 'Villa Bodakdev',
    ...overrides,
  });
  const { DrawingsScreen } = await import('@/screens/DrawingsScreen');
  return { useStore, DrawingsScreen };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});
beforeEach(() => {
  vi.unstubAllEnvs();
});

describe('finding 4 — DrawingsScreen honest module-read states (moduleQuery)', () => {
  it('loading: a read in flight shows "Loading the drawing register…", NOT "No drawings issued yet"', async () => {
    const { DrawingsScreen } = await loadScreen('moduleQuery', { drawings: [], drawingsLoad: 'loading' });
    const r = render(<DrawingsScreen />);
    expect(r.getByTestId('drawings-loading')).toBeInTheDocument();
    expect(r.queryByText('No drawings issued yet.')).not.toBeInTheDocument();
  });

  it('idle (before the first fetch): also treated as loading, not an empty register', async () => {
    const { DrawingsScreen } = await loadScreen('moduleQuery', { drawings: [], drawingsLoad: 'idle' });
    const r = render(<DrawingsScreen />);
    expect(r.getByTestId('drawings-loading')).toBeInTheDocument();
    expect(r.queryByText('No drawings issued yet.')).not.toBeInTheDocument();
  });

  it('error + no last-good: shows the unavailable boundary and a Retry that refetches', async () => {
    const { useStore, DrawingsScreen } = await loadScreen('moduleQuery', { drawings: [], drawingsLoad: 'error' });
    const refetch = vi.fn();
    useStore.setState({ requestFreshSnapshot: refetch });
    const r = render(<DrawingsScreen />);
    expect(r.getByTestId('drawings-unavailable')).toBeInTheDocument();
    expect(r.queryByText('No drawings issued yet.')).not.toBeInTheDocument();
    fireEvent.click(r.getByTestId('drawings-retry-empty'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('ready + empty: "No drawings issued yet" appears ONLY after a successful empty read', async () => {
    const { DrawingsScreen } = await loadScreen('moduleQuery', { drawings: [], drawingsLoad: 'ready' });
    const r = render(<DrawingsScreen />);
    expect(r.getByText('No drawings issued yet.')).toBeInTheDocument();
    expect(r.queryByTestId('drawings-loading')).not.toBeInTheDocument();
    expect(r.queryByTestId('drawings-unavailable')).not.toBeInTheDocument();
  });

  it('error WITH last-good: renders the retained register + a stale warning + Retry, and LOCKS the Issue button', async () => {
    const { DrawingsScreen } = await loadScreen('moduleQuery', { drawings: [dwg('DWG-1', 'A-101')], drawingsLoad: 'error' });
    const r = render(<DrawingsScreen />);
    // the last-good register is shown (not blanked)…
    expect(r.getByTestId('drawing-A-101')).toBeInTheDocument();
    // …with a visible stale/unavailable warning + Retry (never silent stale data with a live Issue button)
    expect(r.getByTestId('drawings-stale-warning')).toBeInTheDocument();
    expect(r.getByTestId('drawings-retry')).toBeInTheDocument();
    // …and the Issue command is disabled while the read is unavailable
    expect(r.getByTestId('issue-drawing')).toBeDisabled();
  });

  it('Retry re-runs the module read; a successful refresh clears the warning and re-enables the Issue button', async () => {
    const { useStore, DrawingsScreen } = await loadScreen('moduleQuery', { drawings: [dwg('DWG-1', 'A-101')], drawingsLoad: 'error' });
    const refetch = vi.fn();
    useStore.setState({ requestFreshSnapshot: refetch });
    const r = render(<DrawingsScreen />);
    fireEvent.click(r.getByTestId('drawings-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
    // when the read SUCCEEDS (drawingsLoad → ready), the warning is gone and the action unlocks
    act(() => { useStore.setState({ drawingsLoad: 'ready' }); });
    expect(r.queryByTestId('drawings-stale-warning')).not.toBeInTheDocument();
    expect(r.getByTestId('issue-drawing')).not.toBeDisabled();
  });

  it('loading WITH last-good: the register shows but the Issue button stays locked until the read settles', async () => {
    const { DrawingsScreen } = await loadScreen('moduleQuery', { drawings: [dwg('DWG-1', 'A-101')], drawingsLoad: 'loading' });
    const r = render(<DrawingsScreen />);
    expect(r.getByTestId('drawing-A-101')).toBeInTheDocument();
    expect(r.getByTestId('issue-drawing')).toBeDisabled();
  });

  it('ready WITH register: the Issue button is ENABLED once the read has settled', async () => {
    const { DrawingsScreen } = await loadScreen('moduleQuery', { drawings: [dwg('DWG-1', 'A-101')], drawingsLoad: 'ready' });
    const r = render(<DrawingsScreen />);
    expect(r.getByTestId('drawing-A-101')).toBeInTheDocument();
    expect(r.getByTestId('issue-drawing')).not.toBeDisabled();
  });
});

describe('finding 4 — snapshot mode is unaffected (no regression)', () => {
  it('idle + empty in snapshot mode still shows "No drawings issued yet" (snapshot slice is authoritative)', async () => {
    const { DrawingsScreen } = await loadScreen('snapshot', { drawings: [], drawingsLoad: 'idle' });
    const r = render(<DrawingsScreen />);
    expect(r.getByText('No drawings issued yet.')).toBeInTheDocument();
    expect(r.queryByTestId('drawings-loading')).not.toBeInTheDocument();
  });

  it('a snapshot-mode register leaves the Issue button enabled (the read state never locks it)', async () => {
    const { DrawingsScreen } = await loadScreen('snapshot', { drawings: [dwg('DWG-1', 'A-101')], drawingsLoad: 'idle' });
    const r = render(<DrawingsScreen />);
    expect(r.getByTestId('issue-drawing')).not.toBeDisabled();
  });
});

describe('finding 4 — the store tears down the drawings module read state on a scope change', () => {
  async function freshStore() {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    return useStore;
  }

  it('sign-out resets drawingsLoad → idle and drawingsSource → null', async () => {
    const useStore = await freshStore();
    useStore.setState({ drawingsLoad: 'ready', drawingsSource: 'projection' });
    useStore.getState().signOut();
    expect(useStore.getState().drawingsLoad).toBe('idle');
    expect(useStore.getState().drawingsSource).toBeNull();
  });

  it('switching project resets the drawings module read state synchronously, before the new snapshot lands', async () => {
    const useStore = await freshStore();
    const gw = { switchProject: vi.fn().mockImplementation(() => new Promise(() => {})) };
    useStore.getState()._setGateway(gw as never);
    useStore.setState({ activeProjectId: 'ambli', drawingsLoad: 'ready', drawingsSource: 'projection' });
    void useStore.getState().switchProject('villa-b');
    expect(useStore.getState().projectLoadState).toBe('switching');
    expect(useStore.getState().drawingsLoad).toBe('idle');   // not the previous project's 'ready'
    expect(useStore.getState().drawingsSource).toBeNull();
  });
});
