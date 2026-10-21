import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Decision, Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { HOME_NAV_CAPABILITY } from '@/lib/homeNav';
import { DashboardScreen } from '@/screens/DashboardScreen';
import { warmImports } from './warm-imports';

/**
 * Stage 1 redesign (#482, Rev 3.1 unit H3) — on a project whose `home-nav` switch is on, each Dashboard tile with
 * items says whom they wait on (you, the client, the PMC, the engineer), ahead of today's line, with today's counts
 * and today's destinations; the site photo tile reads in Hindi and Gujarati too. With the switch off, as today.
 */
const s = () => useStore.getState();
const TILES = ['pending', 'review', 'failed', 'photos'] as const;

await warmImports(() => import('@/store/store'), () => import('@/screens/dashboardWaitingOn'));

beforeEach(() => {
  globalThis.localStorage?.clear();
  useStore.setState(getInitialState());
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const asRole = (role: Role, on: boolean) =>
  useStore.setState((st) => {
    st.role = role;
    st.screen = 'dashboard';
    st.capabilities = on ? [HOME_NAV_CAPABILITY] : [];
    st.capabilitiesKnown = true;
  });
const sub = (r: ReturnType<typeof render>, key: string) => r.getByTestId(`tile-${key}-sub`).textContent;
const value = (r: ReturnType<typeof render>, key: string) => r.queryByTestId(`tile-${key}-value`)?.textContent ?? null;

describe('the Dashboard tiles say whom they wait on', () => {
  it('with the switch off, every tile reads as today', () => {
    asRole('pmc', false);
    const r = render(<DashboardScreen />);
    for (const key of ['pending', 'review', 'failed']) expect(sub(r, key), key).not.toMatch(/Waiting on/);
    act(() => useStore.setState({ lang: 'hi' }));
    expect(r.getByText('SITE PHOTOS ON RECORD')).toBeTruthy();
  });

  it('with the switch on, the counts and the screens each tile opens are today’s', () => {
    for (const role of ['pmc', 'client', 'engineer', 'contractor', 'consultant'] as Role[]) {
      cleanup();
      useStore.setState(getInitialState());
      asRole(role, false);
      let r = render(<DashboardScreen />);
      const before = TILES.map((k) => value(r, k));
      const opens = TILES.map((k) => {
        const tile = r.queryByTestId(`tile-${k}-value`)?.closest('button');
        if (!tile) return null;
        useStore.setState({ screen: 'dashboard' });
        fireEvent.click(tile);
        return s().screen;
      });
      cleanup();
      asRole(role, true);
      useStore.setState({ screen: 'dashboard' });
      r = render(<DashboardScreen />);
      expect(TILES.map((k) => value(r, k)), role).toEqual(before);
      expect(TILES.map((k) => {
        const tile = r.queryByTestId(`tile-${k}-value`)?.closest('button');
        if (!tile) return null;
        useStore.setState({ screen: 'dashboard' });
        fireEvent.click(tile);
        return s().screen;
      }), role).toEqual(opens);
    }
  });

  it('the client’s decisions tile reads "Waiting on you" for the decisions the client decides', () => {
    asRole('client', true);
    expect(s().decisions.some((d) => d.status === 'pending' && !d.draft)).toBe(true);
    const r = render(<DashboardScreen />);
    expect(sub(r, 'pending')).toMatch(/^Waiting on you · /);
  });

  it('the PMC reads whom each tile waits on: the client’s decisions, its own reviews', () => {
    asRole('pmc', true);
    useStore.setState((st) => { st.decisions = st.decisions.map((d) => ({ ...d, deciderKind: 'client' })); });
    const r = render(<DashboardScreen />);
    expect(sub(r, 'pending')).toMatch(/^Waiting on the client · /);
    expect(sub(r, 'review')).toMatch(/^Waiting on you · /);
    expect(sub(r, 'failed')).toMatch(/^Waiting on you · /);
  });

  it('decisions held by more than one party say so; a tile with nothing waiting reads as today', () => {
    asRole('pmc', true);
    useStore.setState((st) => {
      const pending = st.decisions.filter((d) => d.status === 'pending' && !d.draft);
      pending[0].deciderKind = 'pmc';
      pending.slice(1).forEach((d) => { d.deciderKind = 'client'; });
      expect(pending.length).toBeGreaterThan(1);
    });
    const r = render(<DashboardScreen />);
    expect(sub(r, 'pending')).toMatch(/^Waiting on more than one person · /);
    act(() => useStore.setState((st) => { st.decisions = []; st.reviews = []; }));
    expect(sub(r, 'pending')).toBe('All cleared');
    expect(sub(r, 'review')).toBe('Nothing pending');
    expect(sub(r, 'failed')).toBe('None');
  });

  it('reads in Hindi and Gujarati, the site photo tile included', () => {
    asRole('client', true);
    useStore.setState({ lang: 'hi' });
    const r = render(<DashboardScreen />);
    expect(sub(r, 'pending')).toMatch(/^आपकी राह · /);
    expect(r.getByText('दर्ज साइट फ़ोटो')).toBeTruthy();
    act(() => useStore.setState({ lang: 'gu' }));
    expect(sub(r, 'pending')).toMatch(/^તમારી રાહ · /);
    expect(r.getByText('નોંધાયેલા સાઇટ ફોટા')).toBeTruthy();
    act(() => useStore.setState((st) => { st.photos = []; }));
    expect(sub(r, 'photos')).toBe('હજી કોઈ નોંધાયા નથી');
  });
});

describe('on a live project, the failed items say whose turn it is', () => {
  async function live() {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const store = await import('@/store/store');
    const { failedWaitOn, decisionsWaitOn } = await import('@/screens/dashboardWaitingOn');
    const seed = { checklist: structuredClone(s().checklist), reviews: structuredClone(s().reviews), decisions: structuredClone(s().decisions) };
    store.useStore.setState(store.getInitialState());
    return { store, failedWaitOn, decisionsWaitOn, seed };
  }

  it('a re-inspection still being worked waits on the engineer; one sent for review, on the PMC', async () => {
    const { store, failedWaitOn, seed } = await live();
    const reinspection = { ...seed.checklist!, id: 'ri-1', submitted: false, reinspectionOfId: 'insp-0' };
    const review = { ...seed.reviews[0], id: 'rv-1', decided: false, reinspectionOfId: 'insp-9' };
    store.useStore.setState({ role: 'pmc', openChecklists: [reinspection], reviews: [] });
    expect(failedWaitOn(store.useStore.getState())).toBe('engineer');
    store.useStore.setState({ role: 'engineer' });
    expect(failedWaitOn(store.useStore.getState())).toBe('you');
    store.useStore.setState({ role: 'pmc', reviews: [review] });
    expect(failedWaitOn(store.useStore.getState())).toBe('several');
    store.useStore.setState({ openChecklists: [] });
    expect(failedWaitOn(store.useStore.getState())).toBe('you');
  });

  it('a stranded countersign waits on the PMC; a named member’s decision on its named decider', async () => {
    const { store, decisionsWaitOn, seed } = await live();
    const base = seed.decisions.find((d) => d.status === 'pending' && !d.draft)!;
    const stranded: Decision = { ...base, id: 'd-s', status: 'awaiting_countersign', countersignRequired: undefined };
    const named: Decision = { ...base, id: 'd-m', deciderKind: 'member', deciderUserId: 'someone-else' };
    store.useStore.setState({ role: 'pmc', sessionUserId: 'me', decisions: [stranded] });
    expect(decisionsWaitOn(store.useStore.getState())).toBe('you');
    store.useStore.setState({ decisions: [named] });
    expect(decisionsWaitOn(store.useStore.getState())).toBe('decider');
  });
});
