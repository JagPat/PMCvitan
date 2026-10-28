import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Lang, Role, ScreenKey } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';
import { warmImports } from './warm-imports';

/**
 * #482 — Help on every screen of every project, for every role (Jagrut, 27 Oct: "the help should not disappear
 * whenever a user calls for assistance"). The Help button lives in the shell, so no screen and no project can lose
 * it; its sheet says what the current screen is for and lists "Show me how" for each task the role has a guide for,
 * taking the person to that task's screen and starting the guide there.
 *
 * jsdom lays nothing out, so every connected element reports one client rect (shown) unless a test hides it.
 */

const DONE_KEY = 'vitan.guide.done.v1:user:u-1';
const ROLES: Role[] = ['pmc', 'engineer', 'client', 'consultant', 'contractor'];

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/guide/GuideHost'), () => import('@/guide/Help'), () => import('@/guide/guides'), () => import('@/guide/guideState'), () => import('@/guide/words'), () => import('@/layout/CreateControl'), () => import('@/layout/AppShell'), () => import('react-router-dom'));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.isConnected ? [new DOMRect(0, 0, 40, 40)] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function setup(role: Role, screen: ScreenKey, lang: Lang = 'en') {
  vi.resetModules();
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
    sessionUserId: 'u-1',
  });
  const { GuideHost } = await import('@/guide/GuideHost');
  const { HelpButton } = await import('@/guide/Help');
  const { useGuideState } = await import('@/guide/guideState');
  return { useStore, GuideHost, HelpButton, useGuideState };
}

const tick = (ms = 400) => act(() => { vi.advanceTimersByTime(ms); });
const tip = () => document.querySelector<HTMLElement>('[data-testid="guide-tip"]');
const press = (el: Element) => act(() => { fireEvent.click(el); });
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe('Help is in the shell, for every role', () => {
  it.each(ROLES)('the stage carries Help for %s, also while the project loads or fails to', async (role) => {
    const { useStore } = await setup(role, 'dashboard');
    const { AppShell } = await import('@/layout/AppShell');
    const { MemoryRouter } = await import('react-router-dom');
    render(<MemoryRouter><AppShell /></MemoryRouter>);
    expect(document.querySelectorAll('[data-testid="help-open"]')).toHaveLength(1);
    act(() => useStore.setState({ projectLoadState: 'loading' }));
    expect(document.querySelectorAll('[data-testid="help-open"]')).toHaveLength(1);
    act(() => useStore.setState({ projectLoadState: 'error', projectLoadError: 'boom' } as never));
    expect(document.querySelectorAll('[data-testid="help-open"]')).toHaveLength(1);
  });
});

describe('the Help sheet', () => {
  it('says what every screen is for', async () => {
    const { SCREEN_HELP } = await import('@/guide/words');
    const screens = Object.keys(SCREEN_HELP) as ScreenKey[];
    expect(screens.length).toBeGreaterThan(15);
    for (const screen of screens) {
      const { HelpButton, useStore } = await setup('pmc', screen);
      render(<HelpButton />);
      press(byTestId('help-open')!);
      expect(byTestId('help-screen-line')?.textContent).toBe(SCREEN_HELP[screen].en);
      expect(useStore.getState().screen).toBe(screen);
      cleanup();
    }
  });

  it('lists the PMC its tasks, and a client that there is no step-by-step help yet', async () => {
    const pmc = await setup('pmc', 'decision-log');
    render(<pmc.HelpButton />);
    press(byTestId('help-open')!);
    expect(byTestId('help-guide-raise-issue-pmc')).toBeTruthy();
    expect(byTestId('help-guide-record-decision-pmc')).toBeTruthy();
    expect(byTestId('help-guide-raise-issue-engineer')).toBeNull();
    expect(byTestId('help-no-guides')).toBeNull();
    cleanup();

    const client = await setup('client', 'client-decisions');
    render(<client.HelpButton />);
    press(byTestId('help-open')!);
    expect(byTestId('help-no-guides')?.textContent).toBe('No step-by-step help for your role yet.');
    expect(document.querySelectorAll('[data-testid^="help-guide-"]')).toHaveLength(0);
    expect(byTestId('help-tips-again')).toBeNull();
  });

  it.each(['hi', 'gu'] as const)('reads in %s with no English left over, for every role', async (lang) => {
    for (const role of ROLES) {
      const { HelpButton } = await setup(role, 'dashboard', lang);
      render(<HelpButton />);
      expect(leftoverEnglish(document.body)).toEqual([]);
      press(byTestId('help-open')!);
      expect(byTestId('help-sheet')).toBeTruthy();
      expect(leftoverEnglish(document.body)).toEqual([]);
      cleanup();
    }
  });
});

describe('"Show me how" from anywhere', () => {
  it('takes the PMC from another screen to the Dashboard and starts the guide there, even when it was done before', async () => {
    localStorage.setItem(DONE_KEY, JSON.stringify(['raise-issue-pmc', 'record-decision-pmc', 'add-site-photo']));
    const { useStore, GuideHost, HelpButton } = await setup('pmc', 'decision-log');
    const { CreateControl } = await import('@/layout/CreateControl');
    render(<><GuideHost /><HelpButton /><CreateControl /></>);
    tick();
    expect(tip()).toBeNull();

    press(byTestId('help-open')!);
    press(byTestId('help-guide-record-decision-pmc')!);
    expect(byTestId('help-sheet')).toBeNull();
    expect(useStore.getState().screen).toBe('dashboard');
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('record-decision-pmc');
    expect(tip()?.textContent).toContain('Something to be decided? Tap +.');
  });

  it('on the same screen it replaces a guide already running', async () => {
    const { GuideHost, HelpButton, useGuideState } = await setup('pmc', 'dashboard');
    const { CreateControl } = await import('@/layout/CreateControl');
    render(<><GuideHost /><HelpButton /><CreateControl /></>);
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('raise-issue-pmc');

    press(byTestId('help-open')!);
    press(byTestId('help-guide-record-decision-pmc')!);
    // one look starts the asked-for guide, the next measures its control
    tick();
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('record-decision-pmc');
    expect(useGuideState.getState().requested).toBeNull();
  });

  it('says so, instead of nothing, when the task cannot be shown there yet', async () => {
    // the engineer has no checklist out: there is no Fail button to point at
    const { useStore, GuideHost, HelpButton, useGuideState } = await setup('engineer', 'dashboard');
    render(<><GuideHost /><HelpButton /></>);
    press(byTestId('help-open')!);
    press(byTestId('help-guide-raise-issue-engineer')!);
    expect(useStore.getState().screen).toBe('engineer-check');
    tick(1000);
    expect(useGuideState.getState().requested?.id).toBe('raise-issue-engineer');
    expect(useStore.getState().toast).toBeNull();
    tick(3000);
    expect(useGuideState.getState().requested).toBeNull();
    expect(useStore.getState().toast).toBe("Can't show that right now: there is nothing here to do it on yet.");
    expect(tip()).toBeNull();
  });

  it('drops the ask when the person goes to another screen first', async () => {
    const { useStore, GuideHost, useGuideState } = await setup('engineer', 'dashboard');
    const { GUIDES } = await import('@/guide/guides');
    render(<GuideHost />);
    act(() => {
      useGuideState.getState().request(GUIDES.find((g) => g.id === 'raise-issue-engineer')!);
      useStore.getState().setScreen('engineer-check');
    });
    expect(useGuideState.getState().requested?.id).toBe('raise-issue-engineer');
    act(() => useStore.getState().setScreen('daily-log'));
    expect(useGuideState.getState().requested).toBeNull();
  });
});

describe('"Show me how": record focus, role and identity (Codex round 1)', () => {
  it('on its own screen it leaves a record left open, so the screen shows what the guide points at', async () => {
    const { useStore, GuideHost, HelpButton, useGuideState } = await setup('engineer', 'engineer-check');
    act(() => useStore.setState({ routeItem: 'INSP-gone' }));
    render(<><GuideHost /><HelpButton /></>);
    press(byTestId('help-open')!);
    press(byTestId('help-guide-raise-issue-engineer')!);
    expect(useStore.getState().screen).toBe('engineer-check');
    expect(useStore.getState().routeItem).toBeNull();
    expect(useGuideState.getState().requested?.id).toBe('raise-issue-engineer');
  });

  it('drops a guide asked for under a role the person no longer has here', async () => {
    const { useStore, GuideHost, HelpButton, useGuideState } = await setup('pmc', 'decision-log');
    const { CreateControl } = await import('@/layout/CreateControl');
    render(<><GuideHost /><HelpButton /><CreateControl /></>);
    act(() => useStore.setState({ projectLoadState: 'loading' }));
    press(byTestId('help-open')!);
    press(byTestId('help-guide-record-decision-pmc')!);
    // the project switch lands: the person is the engineer here, who also has a + on the Dashboard
    act(() => useStore.setState({ role: 'engineer', projectLoadState: 'ready' }));
    tick();
    tick();
    expect(useGuideState.getState().requested).toBeNull();
    expect(tip()?.getAttribute('data-guide-id')).not.toBe('record-decision-pmc');
  });

  it('tips reset before a dev sign-in settles also reset the signed-in key it settles to', async () => {
    const userKey = 'vitan.guide.done.v1:user:u-9';
    localStorage.setItem(userKey, JSON.stringify(['raise-issue-pmc', 'record-decision-pmc', 'add-site-photo']));
    const { useStore, GuideHost, HelpButton } = await setup('pmc', 'decision-log');
    act(() => useStore.setState({ sessionUserId: null }));
    render(<><GuideHost /><HelpButton /></>);
    press(byTestId('help-open')!);
    press(byTestId('help-tips-again')!);
    act(() => useStore.setState({ sessionUserId: 'u-9' }));
    expect(localStorage.getItem(userKey)).toBeNull();
  });

  it('a different person signing in keeps their own finished guides', async () => {
    const otherKey = 'vitan.guide.done.v1:user:u-2';
    localStorage.setItem(otherKey, JSON.stringify(['raise-issue-pmc']));
    const { useStore, GuideHost, HelpButton } = await setup('pmc', 'decision-log');
    render(<><GuideHost /><HelpButton /></>);
    press(byTestId('help-open')!);
    press(byTestId('help-tips-again')!);
    act(() => useStore.setState({ sessionUserId: 'u-2' }));
    expect(localStorage.getItem(otherKey)).toBe(JSON.stringify(['raise-issue-pmc']));
  });
});

describe('the first-time tips again', () => {
  it('forgets which guides this person finished, and the screen offers its first guide by itself again', async () => {
    localStorage.setItem(DONE_KEY, JSON.stringify(['raise-issue-pmc', 'record-decision-pmc', 'add-site-photo']));
    const { useStore, GuideHost, HelpButton } = await setup('pmc', 'dashboard');
    const { CreateControl } = await import('@/layout/CreateControl');
    render(<><GuideHost /><HelpButton /><CreateControl /></>);
    tick();
    expect(tip()).toBeNull();

    press(byTestId('help-open')!);
    press(byTestId('help-tips-again')!);
    expect(localStorage.getItem(DONE_KEY)).toBeNull();
    expect(useStore.getState().toast).toBe('First-time tips are back on.');
    tick();
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('raise-issue-pmc');
  });
});
