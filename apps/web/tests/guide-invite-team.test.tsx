import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { warmImports } from './warm-imports';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 step 3c (Jagrut, 27 Oct: hold people's hands wherever they ask for help): the PMC's team guide. It points at the
 * add form until the name and a whole email or phone are in, then at Add (its tip asks to check the role), and ends only
 * on the add's own answer. An add that did not go through goes back to the form (Add empties it either way). Only under a server.
 */

const DONE_KEY = 'vitan.guide.done.v1:user:u-pmc';

await warmImports(() => import('@/store/store'), () => import('@/screens/TeamScreen'), () => import('@/guide/GuideHost'), () => import('@/guide/guides'), () => import('@/guide/guideState'), () => import('@/guide/outcomes'));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.isConnected ? [new DOMRect(0, 0, 40, 40)] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** the Team screen for `role` (the PMC by default), under a server when `gateway` */
async function open(gateway: Record<string, unknown> | null, { lang = 'en' as 'en' | 'hi' | 'gu', role = 'pmc', api = 'http://api.test' } = {}) {
  vi.stubEnv('VITE_API_URL', api);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({
    activeProjectId: 'qa', projectScopeGeneration: 1, projectLoadState: 'ready', role, sessionUserId: 'u-pmc', short: 'QA',
    lang, screen: 'team', online: true, outbox: [], syncQueue: [], members: [], memberships: [], myOrgs: [], routeItem: null,
  } as never);
  if (gateway) useStore.getState()._setGateway({ snapshot: vi.fn(() => new Promise(() => {})), listMembers: vi.fn(async () => []), ...gateway } as never);
  const { GuideHost } = await import('@/guide/GuideHost');
  const { TeamScreen } = await import('@/screens/TeamScreen');
  const { GUIDES } = await import('@/guide/guides');
  const { useGuideState } = await import('@/guide/guideState');
  const outcomes = await import('@/guide/outcomes');
  const seen: string[] = [];
  outcomes.subscribeGuideOutcome((o) => seen.push(o));
  render(<><GuideHost /><TeamScreen /></>);
  const guide = GUIDES.find((g) => g.id === 'invite-team-member')!;
  return { useStore, useGuideState, guide, seen };
}

const tip = () => document.querySelector<HTMLElement>('[data-testid="guide-tip"]');
const step = () => tip()?.getAttribute('data-guide-step') ?? null;
const tipAt = (n: string, timeout = 1000) => vi.waitFor(() => { if (step() !== n) throw new Error(`tip at ${step()}`); }, { timeout });
const done = (): string[] => JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[];
const isDone = () => vi.waitFor(() => { if (!done().includes('invite-team-member')) throw new Error('not done'); });
// a tap moves the focus to the button, as in a browser (jsdom's click alone leaves it where it was)
const press = (testId: string) => act(() => { const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)!; el.focus(); fireEvent.click(el); });
const type = (testId: string, value: string) => act(() => { fireEvent.change(document.querySelector(`[data-testid="${testId}"]`)!, { target: { value } }); });

/** the name and email typed in: the tip moves to Add */
async function fillForm() {
  await tipAt('0');
  type('member-name', 'Nilesh');
  type('member-contact', 'nilesh@vitan.in');
  await tipAt('1');
}

const member = { userId: 'u-n', name: 'Nilesh', role: 'engineer', email: 'nilesh@vitan.in' };

describe('the team guide (#482 step 3c)', () => {
  it('the form, then Add: done once the server adds them', async () => {
    const addMember = vi.fn(async () => member);
    const { useGuideState, guide, seen } = await open({ addMember });
    expect(guide.available!()).toBe(true);
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('add-member');
    await isDone();
    expect(addMember).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['member-added']);
    expect(useGuideState.getState().run).toBeNull();
  });

  it('a role picked on the Add step is added in that role, and finishes it', async () => {
    const addMember = vi.fn(async (_input: unknown, _key?: string) => ({ ...member, role: 'contractor' }));
    const { useGuideState, guide } = await open({ addMember });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    expect(tip()!.textContent).toContain('Check the role');
    type('member-role', 'contractor');
    await tipAt('1');
    press('add-member');
    await isDone();
    expect(addMember.mock.calls[0]![0]).toMatchObject({ name: 'Nilesh', role: 'contractor' });
  });

  it('the tip stays on the form until the name and a whole email or phone are in, then points at Add', async () => {
    const { useGuideState, guide } = await open({ addMember: vi.fn() });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    type('member-name', 'Nilesh');
    // the first character of the contact, or an email still being typed, is not a whole contact yet
    // nor a mobile cut short, with or without its country code
    for (const partial of ['9', '98765', '98765432', '+91 987654', '+91 98765 4321', 'nilesh@', 'nilesh@vitan']) {
      type('member-contact', partial);
      await tipAt('0');
      expect(document.querySelector('[data-guide="add-member"]')).toBeNull();
    }
    type('member-contact', '98765 43210');
    await tipAt('1');
    type('member-contact', '+91 98765 43210');
    await tipAt('1');
    // a box emptied again: Add is no target, and the tip goes back to the form
    type('member-contact', '');
    await tipAt('0', 5000);
  });

  it('an add the server refuses goes back to the form, unfinished', async () => {
    const addMember = vi.fn(async () => { throw Object.assign(new Error('refused'), { status: 400 }); });
    const { useGuideState, guide, seen } = await open({ addMember });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('add-member');
    await vi.waitFor(() => { if (seen.length === 0) throw new Error('not told'); });
    expect(seen).toEqual(['member-add-failed']);
    await tipAt('0');
    expect(done()).not.toContain('invite-team-member');
  });

  it('an answer lost goes back to the form; the same details again resend the same add and finish it', async () => {
    const addMember = vi.fn()
      .mockImplementationOnce(async () => { throw new TypeError('Failed to fetch'); })
      .mockImplementationOnce(async () => member);
    const { useGuideState, guide, seen } = await open({ addMember });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('add-member');
    await tipAt('0');
    expect(seen).toEqual(['member-add-failed']);
    await fillForm();
    press('add-member');
    await isDone();
    expect(seen).toEqual(['member-add-failed', 'member-added']);
    // the retry carried the first attempt's key: the server runs the add once
    expect(addMember.mock.calls[1]![1]).toBe(addMember.mock.calls[0]![1]);
  });

  it('the same add already on its way from before the run goes back to the form, and its late answer does not finish this run', async () => {
    let answer!: (m: unknown) => void;
    const addMember = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const { useStore, useGuideState, guide, seen } = await open({ addMember });
    // pressed before the guide started: still on its way
    act(() => { useStore.getState().addMember({ name: 'Nilesh', role: 'engineer', email: 'nilesh@vitan.in' }); });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('add-member');
    expect(addMember).toHaveBeenCalledTimes(1);
    await tipAt('0');
    expect(seen).toEqual(['member-add-failed']);
    await act(async () => { answer(member); });
    await vi.waitFor(() => { if (seen.length < 2) throw new Error('not told'); });
    expect(seen).toEqual(['member-add-failed', 'member-added']);
    await tipAt('0');
    expect(done()).not.toContain('invite-team-member');
  });

  it('another add pressed before the run, answered while the guided one is on its way, does not finish it', async () => {
    const answers: ((m: unknown) => void)[] = [];
    const addMember = vi.fn(() => new Promise((resolve) => { answers.push(resolve); }));
    const { useStore, useGuideState, guide, seen } = await open({ addMember });
    act(() => { useStore.getState().addMember({ name: 'Priya', role: 'engineer', email: 'priya@vitan.in' }); });
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('add-member');
    expect(addMember).toHaveBeenCalledTimes(2);
    await act(async () => { answers[0]!({ ...member, userId: 'u-p', name: 'Priya' }); });
    await vi.waitFor(() => { if (seen.length === 0) throw new Error('not told'); });
    expect(useGuideState.getState().run?.step).toBe(1);
    expect(done()).not.toContain('invite-team-member');
    await act(async () => { answers[1]!(member); });
    await isDone();
  });

  it('signed out of the server (no gateway yet): Add says so and the tip goes back to the form', async () => {
    const { useGuideState, guide, seen } = await open(null);
    act(() => { useGuideState.getState().start(guide); });
    await fillForm();
    press('add-member');
    await tipAt('0');
    expect(seen).toEqual(['member-add-failed']);
    expect(done()).not.toContain('invite-team-member');
  });

  it('is for the PMC on Team, and never shows in the demo (no server): it cannot add anyone there', async () => {
    const { guide } = await open({ addMember: vi.fn() });
    expect(guide.roles).toEqual(['pmc']);
    expect(guide.screen).toBe('team');
    expect(document.querySelector('[data-guide="member-form"]')).not.toBeNull();
    cleanup();
    const demo = await open(null, { api: '' });
    expect(demo.guide.available!()).toBe(false);
    expect(document.querySelector('[data-testid="member-name"]')).not.toBeNull();
    expect(document.querySelector('[data-guide="member-form"]')).toBeNull();
    act(() => { demo.useGuideState.getState().start(demo.guide); });
    await vi.waitFor(() => { if (demo.useGuideState.getState().run) throw new Error('still running'); }, { timeout: 5000 });
    expect(tip()).toBeNull();
  });

  it.each(['hi', 'gu'] as const)('reads in %s with no English left over', async (lang) => {
    const { useGuideState, guide } = await open({ addMember: vi.fn(() => new Promise(() => {})) }, { lang });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    expect(leftoverEnglish(tip()!)).toEqual([]);
    type('member-name', 'Nilesh');
    type('member-contact', 'nilesh@vitan.in');
    await tipAt('1');
    expect(leftoverEnglish(tip()!)).toEqual([]);
  });
});
