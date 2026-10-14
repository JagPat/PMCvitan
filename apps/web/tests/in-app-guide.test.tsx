import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Checklist, Lang, Role, ScreenKey } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 (board decision 14 Oct) — the in-app guide: coach marks on the live screen.
 *
 * The guide points at the REAL control (by `data-guide`), moves on when the person presses it, shows
 * itself once per person the first time they reach the task, and Skip or finishing marks it done for
 * that person in this browser. "Guide me" replays it. These tests drive the real screens.
 *
 * jsdom lays nothing out, so every connected element reports one client rect (shown) unless a test
 * hides it; positions are all zero, which is fine — the tests assert which control is pointed at.
 */

const DONE_KEY = 'vitan.guide.done.v1:user:u-1';

const checklist = (): Checklist => ({
  id: 'INSP-1',
  title: 'Rebar',
  zone: 'Ground floor',
  date: 'today',
  submitted: false,
  items: [
    { id: 'i1', name: 'Cover blocks', state: null, photos: 0, note: '', evidence: [] },
    { id: 'i2', name: 'Lap length', state: null, photos: 0, note: '', evidence: [] },
  ],
});

let hidden = new Set<string>();

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  hidden = new Set();
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    const shown = this.isConnected && !hidden.has(this.getAttribute('data-testid') ?? '');
    return (shown ? [new DOMRect(0, 0, 40, 40)] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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
  const { GuideMe } = await import('@/guide/GuideMe');
  const { GUIDES } = await import('@/guide/guides');
  return { useStore, GuideHost, GuideMe, GUIDES };
}

async function engineer(lang: Lang = 'en') {
  const s = await setup('engineer', 'engineer-check', lang);
  const c = checklist();
  s.useStore.setState({ openChecklists: [c], checklist: c, selectedChecklistId: null });
  const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
  const view = render(<><s.GuideHost /><s.GuideMe /><EngineerChecklistScreen /></>);
  return { ...s, view };
}

async function pmc() {
  const s = await setup('pmc', 'dashboard');
  const { CreateControl, CreateRailButton } = await import('@/layout/CreateControl');
  const view = render(<><s.GuideHost /><s.GuideMe /><CreateControl /><CreateRailButton /></>);
  return { ...s, view };
}

const tick = (ms = 400) => act(() => { vi.advanceTimersByTime(ms); });
const tip = () => document.querySelector<HTMLElement>('[data-testid="guide-tip"]');
const step = () => tip()?.getAttribute('data-guide-step') ?? null;
const done = (): string[] => JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[];
const press = (el: Element) => act(() => { fireEvent.click(el); });

describe('the engineer is guided through raising an issue on the live checklist', () => {
  it('shows itself the first time, moves on as each real control is pressed, and is done at the end', async () => {
    const { view } = await engineer();
    tick();
    expect(tip()?.textContent).toContain('Problem with an item? Tap Fail on it.');
    expect(step()).toBe('0');

    // the person fails the SECOND item: any Fail moves the guide on
    const fails = view.container.querySelectorAll('[data-guide="mark-fail"]');
    expect(fails).toHaveLength(2);
    press(fails[1]!);
    tick();
    expect(step()).toBe('1');
    expect(tip()?.textContent).toContain('Add a photo of the problem.');
    // only the failed item's photo button is the photo step's control
    expect(view.container.querySelectorAll('[data-guide="fail-photo"]')).toHaveLength(1);
    expect(view.getByTestId('evidence-1').getAttribute('data-guide')).toBe('fail-photo');

    press(view.getByTestId('evidence-1'));
    tick();
    expect(step()).toBe('2');
    expect(tip()?.textContent).toContain('When you are done, send it from here.');

    press(view.getByTestId('submit-inspection'));
    tick();
    expect(tip()).toBeNull();
    expect(done()).toEqual(['raise-issue-engineer']);
  });

  it('a press somewhere else does not move the guide on', async () => {
    const { view } = await engineer();
    tick();
    press(view.getAllByText('Pass')[0]!);
    tick();
    expect(step()).toBe('0');
    expect(done()).toEqual([]);
  });

  it('One tap on Skip ends it and it does not come back for that person', async () => {
    const first = await engineer();
    tick();
    press(first.view.getByTestId('guide-skip'));
    expect(tip()).toBeNull();
    expect(done()).toEqual(['raise-issue-engineer']);
    cleanup();

    await engineer();
    tick();
    expect(tip()).toBeNull();
  });

  it('a different person on the same phone still gets their first-time guide', async () => {
    localStorage.setItem('vitan.guide.done.v1:user:someone-else', JSON.stringify(['raise-issue-engineer']));
    await engineer();
    tick();
    expect(tip()).not.toBeNull();
  });

  it('when the photo step\'s control goes away, it steps back to Fail', async () => {
    const { view } = await engineer();
    tick();
    press(view.container.querySelectorAll('[data-guide="mark-fail"]')[0]!);
    tick();
    expect(step()).toBe('1');
    // the person changes their mind: the item passes, so there is no failed item's photo button
    press(view.getAllByText('Pass')[0]!);
    tick(400);
    tick(1000);
    expect(step()).toBe('0');
  });

  it('leaving the screen ends the run without marking it done, so it comes back next visit', async () => {
    const { useStore } = await engineer();
    tick();
    act(() => { useStore.setState({ screen: 'daily-log' }); });
    tick();
    expect(tip()).toBeNull();
    expect(done()).toEqual([]);
    act(() => { useStore.setState({ screen: 'engineer-check' }); });
    tick();
    expect(tip()).not.toBeNull();
  });

  it.each(['hi', 'gu'] as Lang[])('speaks %s with no leftover English, Skip and "Guide me" included', async (lang) => {
    const { view } = await engineer(lang);
    tick();
    expect(leftoverEnglish(tip()!)).toEqual([]);
    press(view.getByTestId('guide-skip'));
    expect(leftoverEnglish(view.getByTestId('guide-me'))).toEqual([]);
  });

  it('nothing to fail (no checklist, or a submitted one) means no guide and no "Guide me"', async () => {
    const s = await setup('engineer', 'engineer-check');
    s.useStore.setState({ openChecklists: [], checklist: { ...checklist(), submitted: true } });
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    const view = render(<><s.GuideHost /><s.GuideMe /><EngineerChecklistScreen /></>);
    tick();
    expect(tip()).toBeNull();
    expect(view.queryByTestId('guide-me')).toBeNull();
  });
});

describe('"Guide me" replays the current screen\'s guide', () => {
  it('is hidden while a guide runs, and replays a finished guide from its first step', async () => {
    localStorage.setItem(DONE_KEY, JSON.stringify(['raise-issue-engineer']));
    const { view } = await engineer();
    tick();
    expect(tip()).toBeNull();
    press(view.getByTestId('guide-me'));
    tick();
    expect(step()).toBe('0');
    expect(view.queryByTestId('guide-me')).toBeNull();
  });

  it('is offered only to a role with a guide on this screen', async () => {
    const s = await setup('client', 'dashboard');
    const view = render(<><s.GuideHost /><s.GuideMe /></>);
    tick();
    expect(view.queryByTestId('guide-me')).toBeNull();
    expect(tip()).toBeNull();
  });
});

describe('the PMC is guided from + to issuing a check', () => {
  it('walks + → "Check something here" → "Issue to engineer", and steps back when the form is cancelled', async () => {
    const { view } = await pmc();
    tick();
    expect(tip()?.textContent).toContain('Tap + to raise it.');

    press(view.getByTestId('create-fab'));
    tick();
    expect(step()).toBe('1');
    expect(tip()?.textContent).toContain('have the engineer check it');

    press(document.querySelector('[data-guide="create-inspection"]')!);
    tick();
    expect(step()).toBe('2');
    expect(document.querySelector('[data-guide="issue-checklist"]')?.getAttribute('data-testid')).toBe('save-checklist');

    // Cancel closes the form and the menu is gone too: back to the + step
    press(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!);
    tick(400);
    tick(1000);
    expect(step()).toBe('0');
  });

  it('a menu still opening is not mistaken for a control that went away', async () => {
    const { view } = await pmc();
    tick();
    const { useGuideState } = await import('@/guide/guideState');
    press(view.getByTestId('create-fab'));
    expect(useGuideState.getState().run?.step).toBe(1);
    tick(100);
    expect(useGuideState.getState().run?.step).toBe(1);
    tick(400);
    expect(step()).toBe('1');
  });

  it('points at the shown Add button, not its hidden twin', async () => {
    hidden.add('create-fab');
    await pmc();
    const { findGuideTarget } = await import('@/guide/guideTarget');
    expect(findGuideTarget('add')?.getAttribute('data-testid')).toBe('create-rail');
  });

  it('only one guide shows itself per visit: a second one waits for the next visit', async () => {
    const s = await setup('pmc', 'dashboard');
    const { CreateControl } = await import('@/layout/CreateControl');
    (s.GUIDES as unknown as unknown[]).push({ id: 'second', roles: ['pmc'], screen: 'dashboard', steps: [{ target: 'add', tip: 'issueAdd' }] });
    const view = render(<><s.GuideHost /><CreateControl /></>);
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('raise-issue-pmc');
    press(view.getByTestId('guide-skip'));
    tick(2000);
    expect(tip()).toBeNull();
    act(() => { s.useStore.setState({ screen: 'inbox' }); });
    act(() => { s.useStore.setState({ screen: 'dashboard' }); });
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('second');
  });
});

describe('storage that refuses is never an error', () => {
  it('a throwing localStorage still shows the guide and Skip still closes it', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { view } = await engineer();
    tick();
    expect(tip()).not.toBeNull();
    press(view.getByTestId('guide-skip'));
    expect(tip()).toBeNull();
  });
});
