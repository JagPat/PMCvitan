import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Role } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import { countActionItems, selectActionItems } from '@/store/selectors';
import { HOME_NAV_CAPABILITY } from '@/lib/homeNav';
import { DashboardScreen } from '@/screens/DashboardScreen';

/**
 * Stage 1 redesign (#482, Rev 3.1 unit H2) — on a project whose `home-nav` switch is on, the Dashboard opens with
 * one line, "You have N actions", where N is the For You tab badge (the open project's count). It reads "—" until
 * the count is known, "Nothing needs you" at 0, and opens For You. With the switch off the Dashboard is as today.
 */
const s = () => useStore.getState();
const ROLES: Role[] = ['pmc', 'client', 'engineer', 'contractor', 'consultant'];
const forYouBadge = () => countActionItems(selectActionItems(s()));

beforeEach(() => {
  globalThis.localStorage?.clear();
  useStore.setState(getInitialState());
});
afterEach(() => cleanup());

const switchOn = (role: Role) =>
  useStore.setState((st) => {
    st.role = role;
    st.screen = 'dashboard';
    st.capabilities = [HOME_NAV_CAPABILITY];
    st.capabilitiesKnown = true;
  });

describe('the Dashboard’s actions line', () => {
  it('is absent with the switch off', () => {
    useStore.setState((st) => { st.role = 'pmc'; });
    const r = render(<DashboardScreen />);
    expect(r.queryByTestId('dash-actions')).not.toBeInTheDocument();
  });

  it('N equals the For You badge for every role, and tapping it opens For You', () => {
    for (const role of ROLES) {
      cleanup();
      useStore.setState(getInitialState());
      switchOn(role);
      const n = forYouBadge();
      const r = render(<DashboardScreen />);
      const line = r.getByTestId('dash-actions');
      expect(line.textContent, role).toBe(n === 0 ? 'Nothing needs you' : `You have ${n} action${n === 1 ? '' : 's'}`);
      fireEvent.click(line);
      expect(s().screen, role).toBe('inbox');
    }
  });

  it('follows the badge live: acting on an item lowers N at once', () => {
    switchOn('client');
    const before = forYouBadge();
    expect(before).toBeGreaterThan(0);
    const r = render(<DashboardScreen />);
    act(() => useStore.setState((st) => { st.decisions = st.decisions.filter((d) => d.status !== 'pending'); }));
    const after = forYouBadge();
    expect(after).toBeLessThan(before);
    expect(r.getByTestId('dash-actions').textContent).toBe(after === 0 ? 'Nothing needs you' : `You have ${after} action${after === 1 ? '' : 's'}`);
  });

  it('reads "—" while the project is still loading, never a false 0', () => {
    switchOn('pmc');
    useStore.setState((st) => { st.projectLoadState = 'loading'; });
    const r = render(<DashboardScreen />);
    expect(r.getByTestId('dash-actions').textContent).toBe('You have — actions');
    expect(r.getByTestId('dash-actions').getAttribute('data-known')).toBe('false');
  });

  it('on a pilot project the PMC’s count waits for the hubs: "—" while a hub loads or after its read failed', () => {
    for (const load of ['loading', 'error'] as const) {
      cleanup();
      useStore.setState(getInitialState());
      switchOn('pmc');
      useStore.setState((st) => { st.capabilities = [HOME_NAV_CAPABILITY, 'materials']; st.materialsLoad = load; });
      const r = render(<DashboardScreen />);
      expect(r.getByTestId('dash-actions').textContent, load).toBe('You have — actions');
    }
  });

  it('a hub the PMC’s project does not have, or a role it gives no actions, never holds the count', () => {
    switchOn('pmc');
    useStore.setState((st) => { st.labourLoad = 'error'; });
    let r = render(<DashboardScreen />);
    expect(r.getByTestId('dash-actions').getAttribute('data-known')).toBe('true');
    cleanup();
    switchOn('client');
    useStore.setState((st) => { st.capabilities = [HOME_NAV_CAPABILITY, 'materials']; st.materialsLoad = 'error'; });
    r = render(<DashboardScreen />);
    expect(r.getByTestId('dash-actions').getAttribute('data-known')).toBe('true');
  });

  it('reads "Nothing needs you" at 0, in Hindi and Gujarati too', () => {
    switchOn('consultant');
    useStore.setState((st) => { st.decisions = []; st.drawings = []; st.reviews = []; st.checklist = null; st.dailyLog = null; });
    expect(forYouBadge()).toBe(0);
    const r = render(<DashboardScreen />);
    expect(r.getByTestId('dash-actions').textContent).toBe('Nothing needs you');
    act(() => useStore.setState({ lang: 'hi' }));
    expect(r.getByTestId('dash-actions').textContent).toBe('अभी आपके लिए कुछ नहीं');
    act(() => useStore.setState({ lang: 'gu' }));
    expect(r.getByTestId('dash-actions').textContent).toBe('હમણાં તમારા માટે કંઈ નથી');
  });

  it('a count reads in Hindi and Gujarati', () => {
    switchOn('client');
    const n = forYouBadge();
    useStore.setState({ lang: 'hi' });
    const r = render(<DashboardScreen />);
    expect(r.getByTestId('dash-actions').textContent).toBe(`आपके लिए ${n} काम`);
    act(() => useStore.setState({ lang: 'gu' }));
    expect(r.getByTestId('dash-actions').textContent).toBe(`તમારા માટે ${n} કામ`);
  });
});
