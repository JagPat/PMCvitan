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

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/guide/Welcome'), () => import('@/guide/guideState'), () => import('@/guide/guideDone'));

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.resetModules();
});

async function setup(role: Role, screen: ScreenKey = 'dashboard', lang: Lang = 'en', sessionUserId: string | null = 'u-1') {
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
