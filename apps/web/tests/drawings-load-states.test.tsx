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

/**
 * Wave 0 / F-1b — #584 review round 11, finding 1: THE VALID-BUT-EMPTY CONSULTANT DISCIPLINE.
 *
 * A consultant whose project HAS drawings but none in their own discipline sees one control and
 * one only: the escape back to the whole register. It shipped as a zero-padding 13.5px caption
 * and measured 116 x 15 the first time anything rendered the state.
 *
 * WHY THIS IS HERE AND NOT IN `mobile-fields.spec.ts`. That file measures real layout in a real
 * browser, which is the right instrument and cannot reach this state: the demo build has no API,
 * so a consultant's discipline is the hardcoded fallback, and the seed files a structural sheet.
 * I briefly changed that fallback to `mep` to open the branch and it broke `consultant.spec.ts`,
 * which proves the POPULATED default — the more important behaviour of the two. So the product
 * keeps the fallback that demonstrates the feature working, and the state a browser cannot reach
 * is driven here, where the store can simply be handed a register with no structural drawings.
 *
 * WHAT THIS TEST CAN AND CANNOT CLAIM, stated rather than implied. jsdom performs no layout, so
 * `getBoundingClientRect` is all zeros and no assertion here MEASURES anything. It asserts the
 * declared inline `min-height`, which is sound for THIS control precisely because its size is an
 * inline style with no stylesheet involved — there is no cascade for jsdom to get wrong. That is
 * the opposite of the 16px field rule, which is an `!important` author rule outranking inline
 * styles and therefore has to be measured in a browser. A weaker instrument is honest only when
 * the property is simple enough for it; it would not be honest for anything with a cascade.
 */
describe('the consultant escape from an empty discipline scope', () => {
  const arch = (id: string, number: string): Drawing => ({ ...dwg(id, number), discipline: 'architectural' });

  async function renderEmptyScope() {
    const { useStore, DrawingsScreen } = await loadScreen('snapshot', {
      role: 'consultant',
      memberships: [],                 // no membership -> the demo fallback discipline (structural)
      drawings: [arch('d1', 'A-201')], // a register WITH drawings, none of them structural
    });
    void useStore;
    return render(<DrawingsScreen />);
  }

  it('renders the escape when the scope is empty but the register is not', async () => {
    const { getByTestId, queryByTestId } = await renderEmptyScope();
    expect(queryByTestId('drawing-A-201')).toBeNull(); // scoped away: this is the empty state
    expect(getByTestId('scope-all-empty')).toBeTruthy();
  });

  it('the escape declares the 44px action-target floor', async () => {
    const { getByTestId } = await renderEmptyScope();
    const escape = getByTestId('scope-all-empty') as HTMLElement;
    expect(
      escape.style.minHeight,
      'the only way out of an empty discipline scope is an action target and owes the 44px floor',
    ).toBe('44px');
  });

  it('the escape actually escapes — it clears the scope and reveals the register', async () => {
    const { getByTestId, queryByTestId } = await renderEmptyScope();
    act(() => { fireEvent.click(getByTestId('scope-all-empty')); });
    expect(queryByTestId('drawing-A-201')).toBeTruthy();
  });
});
