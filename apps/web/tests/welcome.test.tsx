import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Lang, Role, ScreenKey } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';
import { warmImports } from './warm-imports';

/**
 * #482 — the first-time welcome (Jagrut, 27 Oct: hand-hold a first-time user). The first time a person opens a
 * project in this browser, a card at the top of the stage says what Vitan is for, for their role, and where Help
 * is; "Show me around" starts their first guide; closing it keeps it closed for that person.
 */

const ROLES: Role[] = ['pmc', 'engineer', 'client', 'consultant', 'contractor', 'architect'];
const SEEN = (key: string) => `vitan.guide.welcome.v1:${key}`;

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/guide/Welcome'), () => import('@/guide/guideState'), () => import('@/guide/guideDone'), () => import('@/guide/GuideHost'), () => import('@/guide/guideTarget'));

beforeEach(() => {
  localStorage.clear();
  // jsdom lays nothing out: a connected control counts as on screen
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.isConnected ? [new DOMRect(0, 0, 40, 40)] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function setup(role: Role, screen: ScreenKey = 'dashboard', lang: Lang = 'en', sessionUserId: string | null = 'u-1', api = true) {
  vi.resetModules();
  // the Dashboard's "Add site photo" exists only against the server
  if (api) vi.stubEnv('VITE_API_URL', 'http://api.test');
  else vi.unstubAllEnvs();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'project-a',
    projectScopeGeneration: 1,
    projectLoadState: 'ready',
    role,
    screen,
    lang,
    sessionUserId,
  });
  const { Welcome } = await import('@/guide/Welcome');
  const { useGuideState } = await import('@/guide/guideState');
  const done = await import('@/guide/guideDone');
  return { useStore, Welcome, useGuideState, done };
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const press = (el: Element) => act(() => { fireEvent.click(el); });

describe('the first-time welcome', () => {
  it('greets a PMC once, says what Vitan is for them and where Help is, and stays closed after "Not now"', async () => {
    const { Welcome } = await setup('pmc');
    const view = render(<Welcome />);
    expect(byTestId('welcome')?.textContent).toContain('Welcome to Vitan');
    expect(byTestId('welcome')?.textContent).toContain('send checks to the engineer');
    expect(byTestId('welcome')?.textContent).toContain('Help is at the top of every screen.');
    press(byTestId('welcome-close')!);
    expect(byTestId('welcome')).toBeNull();
    expect(localStorage.getItem(SEEN('user:u-1'))).toBe('1');
    view.unmount();
    render(<Welcome />);
    expect(byTestId('welcome')).toBeNull();
  });

  it('"Show me around" takes the PMC to their first unfinished guide on its screen', async () => {
    localStorage.setItem('vitan.guide.done.v1:user:u-1', JSON.stringify(['raise-issue-pmc']));
    const { Welcome, useStore, useGuideState } = await setup('pmc', 'decision-log');
    render(<Welcome />);
    press(byTestId('welcome-tour')!);
    expect(byTestId('welcome')).toBeNull();
    expect(useStore.getState().screen).toBe('dashboard');
    expect(useGuideState.getState().requested?.id).toBe('record-decision-pmc');
  });

  it('a role with no guide yet gets one "Got it"', async () => {
    const { Welcome } = await setup('client', 'client-decisions');
    render(<Welcome />);
    expect(byTestId('welcome')?.textContent).toContain('answer the choices put to you');
    expect(byTestId('welcome-tour')).toBeNull();
    expect(byTestId('welcome-close')?.textContent).toBe('Got it');
  });

  it('waits until the project is on screen', async () => {
    const { Welcome, useStore } = await setup('engineer');
    act(() => useStore.setState({ projectLoadState: 'loading' }));
    render(<Welcome />);
    expect(byTestId('welcome')).toBeNull();
    act(() => useStore.setState({ projectLoadState: 'ready' }));
    expect(byTestId('welcome')).toBeTruthy();
  });

  it('comes back with "Show the first-time tips again"', async () => {
    localStorage.setItem(SEEN('user:u-1'), '1');
    const { Welcome, useGuideState, done } = await setup('pmc');
    render(<Welcome />);
    expect(byTestId('welcome')).toBeNull();
    act(() => {
      done.clearGuidesDone('user:u-1');
      useGuideState.getState().tipsAgain('user:u-1');
    });
    expect(byTestId('welcome')).toBeTruthy();
  });

  it('closed before a dev sign-in settles, it stays closed for the signed-in user; another person still sees it', async () => {
    const { Welcome, useStore } = await setup('pmc', 'dashboard', 'en', null);
    render(<Welcome />);
    press(byTestId('welcome-close')!);
    act(() => useStore.setState({ sessionUserId: 'u-9' }));
    expect(localStorage.getItem(SEEN('user:u-9'))).toBe('1');
    expect(byTestId('welcome')).toBeNull();
    act(() => useStore.setState({ sessionUserId: 'u-2' }));
    expect(byTestId('welcome')).toBeTruthy();
  });

  it('no guide starts by itself under the welcome, nor after "Not now" on that visit', async () => {
    vi.useFakeTimers();
    const { Welcome } = await setup('pmc');
    const { GuideHost } = await import('@/guide/GuideHost');
    const { GUIDE_TICK_MS } = await import('@/guide/guideTarget');
    render(<><Welcome /><GuideHost /><button type="button" data-guide="add">+</button></>);
    await act(async () => { await vi.advanceTimersByTimeAsync(GUIDE_TICK_MS * 2); });
    expect(byTestId('welcome')).toBeTruthy();
    expect(byTestId('guide-tip')).toBeNull();
    press(byTestId('welcome-close')!);
    await act(async () => { await vi.advanceTimersByTimeAsync(GUIDE_TICK_MS * 2); });
    expect(byTestId('guide-tip')).toBeNull();
  });

  it('with the welcome already closed, the first guide still starts by itself', async () => {
    vi.useFakeTimers();
    localStorage.setItem(SEEN('user:u-1'), '1');
    const { Welcome } = await setup('pmc');
    const { GuideHost } = await import('@/guide/GuideHost');
    const { GUIDE_TICK_MS } = await import('@/guide/guideTarget');
    render(<><Welcome /><GuideHost /><button type="button" data-guide="add">+</button></>);
    await act(async () => { await vi.advanceTimersByTimeAsync(GUIDE_TICK_MS * 2); });
    expect(byTestId('guide-tip')?.getAttribute('data-guide-id')).toBe('raise-issue-pmc');
  });

  it('"Show me around" passes over a guide with nothing to show it on: an engineer with no checklist gets the photo guide', async () => {
    const onDashboard = await setup('engineer');
    render(<><onDashboard.Welcome /><button type="button" data-guide="add-site-photo">Add site photo</button></>);
    press(byTestId('welcome-tour')!);
    expect(onDashboard.useGuideState.getState().requested?.id).toBe('add-site-photo');
    cleanup();
    localStorage.clear();

    const onChecklists = await setup('engineer', 'engineer-check');
    render(<onChecklists.Welcome />);
    press(byTestId('welcome-tour')!);
    expect(onChecklists.useGuideState.getState().requested?.id).toBe('add-site-photo');
    expect(onChecklists.useStore.getState().screen).toBe('dashboard');
    cleanup();
    localStorage.clear();

    // a checklist on screen whose controls are frozen (pressable by nobody) has nothing to show the guide on either
    const frozen = await setup('engineer', 'engineer-check');
    render(<><frozen.Welcome /><button type="button" data-guide="mark-fail" disabled>Fail</button></>);
    press(byTestId('welcome-tour')!);
    expect(frozen.useGuideState.getState().requested?.id).toBe('add-site-photo');
  });

  it('from another screen, a checklist whose items are all failed already has nothing to mark failed: the photo guide', async () => {
    const all = (state: 'fail' | null) => ({
      id: 'INSP-1', title: 'Rebar', zone: 'Ground floor', date: 'today', submitted: false,
      items: [{ id: 'i1', name: 'Cover blocks', state, photos: 0, note: '', evidence: [] }],
    });
    const failed = await setup('engineer', 'site-visits');
    failed.useStore.setState({ openChecklists: [all('fail')] });
    render(<failed.Welcome />);
    press(byTestId('welcome-tour')!);
    expect(failed.useGuideState.getState().requested?.id).toBe('add-site-photo');
    cleanup();
    localStorage.clear();

    const open = await setup('engineer', 'site-visits');
    open.useStore.setState({ openChecklists: [all(null)] });
    render(<open.Welcome />);
    press(byTestId('welcome-tour')!);
    expect(open.useGuideState.getState().requested?.id).toBe('raise-issue-engineer');
  });

  it('closes even where the browser refuses to store it', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const { Welcome } = await setup('client', 'client-decisions');
    render(<Welcome />);
    press(byTestId('welcome-close')!);
    expect(byTestId('welcome')).toBeNull();
  });

  it('"Show me around" moves on to the next guide when the one it picked cannot start once on its screen', async () => {
    vi.useFakeTimers();
    const { Welcome, useStore, useGuideState } = await setup('engineer', 'site-visits');
    // a checklist out on site with an item to fail, but the checklist screen shows none to press (another one is open)
    useStore.setState({
      openChecklists: [{ id: 'INSP-2', title: 'Plaster', zone: 'First floor', date: 'today', submitted: false, items: [{ id: 'i1', name: 'Level', state: null, photos: 0, note: '', evidence: [] }] }],
    });
    const { GuideHost } = await import('@/guide/GuideHost');
    const { GUIDE_ARRIVE_MS, GUIDE_TICK_MS } = await import('@/guide/guideTarget');
    render(<><Welcome /><GuideHost /><button type="button" data-guide="add-site-photo">Add site photo</button></>);
    press(byTestId('welcome-tour')!);
    expect(useGuideState.getState().requested?.id).toBe('raise-issue-engineer');
    expect(useStore.getState().screen).toBe('engineer-check');
    await act(async () => { await vi.advanceTimersByTimeAsync(GUIDE_ARRIVE_MS + GUIDE_TICK_MS * 3); });
    expect(useStore.getState().screen).toBe('dashboard');
    expect(byTestId('guide-tip')?.getAttribute('data-guide-id')).toBe('add-site-photo');
    expect(useStore.getState().toast).toBeNull();
  });

  it('in demo mode (no "Add site photo") with no checklist to work on, there is nothing to show yet: Help says so', async () => {
    vi.useFakeTimers();
    const { Welcome, useStore, useGuideState } = await setup('engineer', 'site-visits', 'en', 'u-1', false);
    const { GuideHost } = await import('@/guide/GuideHost');
    const { GUIDE_ARRIVE_MS, GUIDE_TICK_MS } = await import('@/guide/guideTarget');
    render(<><Welcome /><GuideHost /></>);
    press(byTestId('welcome-tour')!);
    expect(useGuideState.getState().fallbacks).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(GUIDE_ARRIVE_MS + GUIDE_TICK_MS * 3); });
    expect(byTestId('guide-tip')).toBeNull();
    expect(useStore.getState().toast).toBe("Can't show that right now: there is nothing here to do it on yet.");
  });

  it.each(['hi', 'gu'] as const)('reads in %s with no English left over, for every role', async (lang) => {
    for (const role of ROLES) {
      const { Welcome } = await setup(role, 'dashboard', lang);
      render(<Welcome />);
      expect(byTestId('welcome')).toBeTruthy();
      expect(leftoverEnglish(document.body, ['Vitan'])).toEqual([]);
      cleanup();
    }
  });
});
