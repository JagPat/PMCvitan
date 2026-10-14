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

type Store = Awaited<ReturnType<typeof setup>>['useStore'];
/** what a picked photo does to the item (`addChecklistEvidence`): its photo count goes up */
function attachPhoto(useStore: Store, i: number) {
  act(() => {
    useStore.setState((st) => ({
      checklist: st.checklist && { ...st.checklist, items: st.checklist.items.map((it, j) => (j === i ? { ...it, photos: it.photos + 1 } : it)) },
    }));
  });
}

describe('the engineer is guided through raising an issue on the live checklist', () => {
  it('shows itself the first time, moves on as each step really happens, and is done at the end', async () => {
    const { view, useStore } = await engineer();
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

    // opening the camera and cancelling attaches nothing: the photo step stays
    press(view.getByTestId('evidence-1'));
    tick();
    expect(step()).toBe('1');
    // a photo lands on that item (what the picker's `onPicked` does): now the guide moves on
    attachPhoto(useStore, 1);
    tick();
    expect(step()).toBe('2');
    expect(tip()?.textContent).toContain('When you are done, send it from here.');

    // a refused submit (the failed item has no note yet) does not finish the guide
    press(view.getByTestId('submit-inspection'));
    tick();
    expect(step()).toBe('2');
    expect(done()).toEqual([]);

    act(() => {
      useStore.setState((st) => ({
        checklist: st.checklist && { ...st.checklist, items: st.checklist.items.map((it, j) => ({ ...it, state: it.state ?? 'pass', note: j === 1 ? 'Gap at the corner' : it.note })) },
      }));
    });
    press(view.getByTestId('submit-inspection'));
    tick();
    expect(tip()).toBeNull();
    expect(done()).toEqual(['raise-issue-engineer']);
  });

  it('points the photo step at the item just failed, not at an item failed earlier', async () => {
    const { view, useStore } = await engineer();
    // item 1 was already failed before the guide ran
    act(() => {
      useStore.setState((st) => ({ checklist: st.checklist && { ...st.checklist, items: st.checklist.items.map((it, j) => (j === 0 ? { ...it, state: 'fail' as const } : it)) } }));
    });
    tick();
    expect(view.container.querySelectorAll('[data-guide="fail-photo"]')).toHaveLength(1);
    // the failed item's own Fail is no longer a guide target (#862): only item 2's is
    const fails = view.container.querySelectorAll('[data-guide="mark-fail"]');
    expect(fails).toHaveLength(1);
    press(fails[0]!);
    tick();
    expect(step()).toBe('1');
    const { useGuideState } = await import('@/guide/guideState');
    const { findStepTarget } = await import('@/guide/guideTarget');
    const run = useGuideState.getState().run!;
    expect(findStepTarget(run.guide.steps[1]!, run.key)?.getAttribute('data-testid')).toBe('evidence-1');
    // a photo on the EARLIER failed item does not complete this step
    attachPhoto(useStore, 0);
    tick();
    expect(step()).toBe('1');
    attachPhoto(useStore, 1);
    tick();
    expect(step()).toBe('2');
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
    // inside the menu dialog, the tip (and its Skip) live IN the dialog, inside its focus trap
    expect(tip()?.closest('[role="dialog"]')).not.toBeNull();

    press(document.querySelector('[data-guide="create-inspection"]')!);
    tick();
    expect(step()).toBe('2');
    expect(document.querySelector('[data-guide="issue-checklist"]')?.getAttribute('data-testid')).toBe('save-checklist');
    expect(tip()?.closest('[role="dialog"]')?.contains(document.querySelector('[data-guide="issue-checklist"]'))).toBe(true);

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
    const view = render(<><s.GuideHost /><CreateControl /></>);
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('raise-issue-pmc');
    press(view.getByTestId('guide-skip'));
    tick(2000);
    expect(tip()).toBeNull();
    act(() => { s.useStore.setState({ screen: 'inbox' }); });
    act(() => { s.useStore.setState({ screen: 'dashboard' }); });
    tick();
    // the Dashboard's second guide, "record a decision"
    expect(tip()?.getAttribute('data-guide-id')).toBe('record-decision-pmc');
  });
});

/** an engineer whose checklist is ready to submit, on the guide's Submit step */
async function engineerAtSubmit() {
  const e = await engineer();
  tick();
  press(e.view.container.querySelectorAll('[data-guide="mark-fail"]')[1]!);
  tick();
  attachPhoto(e.useStore, 1);
  tick();
  act(() => {
    e.useStore.setState((st) => ({
      checklist: st.checklist && { ...st.checklist, items: st.checklist.items.map((it, j) => ({ ...it, state: it.state ?? 'pass', note: j === 1 ? 'Gap at the corner' : it.note })) },
    }));
  });
  expect(step()).toBe('2');
  return e;
}

/** a PMC on the guide's last step, inside a filled "Issue checklist" form */
async function pmcAtIssue() {
  const s = await setup('pmc', 'dashboard');
  s.useStore.setState({ nodes: [{ id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 }] } as never);
  const { CreateControl } = await import('@/layout/CreateControl');
  const view = render(<><s.GuideHost /><CreateControl /></>);
  tick();
  press(view.getByTestId('create-fab'));
  tick();
  press(document.querySelector('[data-guide="create-inspection"]')!);
  tick();
  expect(step()).toBe('2');
  fireEvent.change(view.getByTestId('chk-title'), { target: { value: 'Waterproofing' } });
  fireEvent.change(view.getByTestId('chk-item-0'), { target: { value: 'Second coat' } });
  // the form opened from the + inherits no place: pick the one zone
  fireEvent.change(view.getByTestId('chk-loc-select-zone'), { target: { value: 'gf' } });
  expect(document.querySelector<HTMLButtonElement>('[data-guide="issue-checklist"]')?.disabled).toBe(false);
  return { ...s, view };
}

describe('a step that can fail finishes only when it really succeeds (review round 2)', () => {
  it('an online submit that fails keeps the engineer on Submit; the guide waits while it is on its way', async () => {
    const { useStore } = await engineerAtSubmit();
    let fail!: (e: Error) => void;
    const gw = { submitInspection: vi.fn(() => new Promise((_, reject) => { fail = reject; })) };
    act(() => {
      useStore.getState()._setGateway(gw as never);
      useStore.setState({ online: true });
    });
    press(document.querySelector('[data-testid="submit-inspection"]')!);
    expect(gw.submitInspection).toHaveBeenCalledTimes(1);
    tick(2000);
    // sending: not finished, and not given up on
    expect(done()).toEqual([]);
    const { useGuideState } = await import('@/guide/guideState');
    expect(useGuideState.getState().run?.step).toBe(2);
    await act(async () => { fail(new Error('offline')); await Promise.resolve(); });
    tick();
    expect(done()).toEqual([]);
    expect(step()).toBe('2');
    expect(useStore.getState().submission.status).toBe('idle');
  });

  it('a submit saved offline (queued) finishes the guide', async () => {
    const { useStore } = await engineerAtSubmit();
    act(() => {
      useStore.getState()._setGateway({} as never);
      useStore.setState({ online: false });
    });
    press(document.querySelector('[data-testid="submit-inspection"]')!);
    expect(useStore.getState().submission.status).toBe('queued');
    tick();
    expect(tip()).toBeNull();
    expect(done()).toEqual(['raise-issue-engineer']);
  });

  it('"Issue to engineer" refused (no server in demo) does not finish the PMC guide; it steps back to +', async () => {
    const { useStore } = await pmcAtIssue();
    expect(useStore.getState().nodes).toHaveLength(1);
    press(document.querySelector('[data-guide="issue-checklist"]')!);
    tick(400);
    tick(1000);
    expect(done()).toEqual([]);
    expect(step()).toBe('0');
  });

  it('"Issue to engineer" online: the guide waits while it is sent, a failure steps back, a success finishes', async () => {
    const { useStore } = await pmcAtIssue();
    let refuse!: (e: Error) => void;
    const gw = { createInspection: vi.fn(() => new Promise((_, reject) => { refuse = reject; })) };
    act(() => { useStore.getState()._setGateway(gw as never); });
    const { useGuideState } = await import('@/guide/guideState');
    // the form closes at once, whatever the server will say
    press(document.querySelector('[data-guide="issue-checklist"]')!);
    expect(gw.createInspection).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-guide="issue-checklist"]')).toBeNull();
    // however slow the server is, the guide never steps back to + while the request is still on its
    // way (review round 3): following it then would send the same checklist twice
    tick(2000);
    expect(useGuideState.getState().run?.step).toBe(2);
    tick(60_000);
    expect(useGuideState.getState().run?.step).toBe(2);
    expect(gw.createInspection).toHaveBeenCalledTimes(1);
    expect(done()).toEqual([]);
    // refused: the wait ends and, with the form gone, the guide steps back to +
    await act(async () => { refuse(new Error('refused')); await Promise.resolve(); await Promise.resolve(); });
    tick(400);
    tick(1000);
    expect(useGuideState.getState().run?.step).toBe(0);
    expect(done()).toEqual([]);
    // accepted on another go (what the store reports when the server takes it): done
    const { emitGuideOutcome } = await import('@/guide/outcomes');
    act(() => { useGuideState.getState().setStep(2); });
    act(() => { emitGuideOutcome('checklist-issued'); });
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).toEqual(['raise-issue-pmc']);
  });

  it('the store reports a real issue outcome: refused without a server, and the server\'s answer when there is one', async () => {
    const s = await setup('pmc', 'dashboard');
    const { subscribeGuideOutcome } = await import('@/guide/outcomes');
    const seen: string[] = [];
    subscribeGuideOutcome((o) => seen.push(o));
    const input = { title: 'T', zone: 'Z', items: ['a'] };
    s.useStore.getState().issueChecklist(input);
    expect(seen).toEqual(['checklist-issue-failed']);
    act(() => { s.useStore.getState()._setGateway({ createInspection: vi.fn().mockRejectedValue(new Error('no')) } as never); });
    s.useStore.getState().issueChecklist(input);
    await vi.waitFor(() => expect(seen).toEqual(['checklist-issue-failed', 'checklist-issue-failed']));
  });
});

describe('follow-ups from review (#858, #861, #862)', () => {
  it('the Submit step follows the guided checklist: another checklist\'s submit does not finish it', async () => {
    await engineerAtSubmit();
    expect(document.querySelector('[data-guide="submit-inspection"]')?.getAttribute('data-guide-key')).toBe('INSP-1');
    const { emitGuideOutcome } = await import('@/guide/outcomes');
    const { useGuideState } = await import('@/guide/guideState');
    act(() => { useGuideState.getState().setWait(true); });
    act(() => { emitGuideOutcome('inspection-submitted', 'INSP-2'); });
    expect(useGuideState.getState().run?.step).toBe(2);
    expect(done()).toEqual([]);
    act(() => { emitGuideOutcome('inspection-submitted', 'INSP-1'); });
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).toEqual(['raise-issue-engineer']);
  });

  it('a live refresh that shows the checklist submitted before the request answers still finishes the guide', async () => {
    const { useStore } = await engineerAtSubmit();
    const gw = { submitInspection: vi.fn(() => new Promise(() => {})) };
    act(() => {
      useStore.getState()._setGateway(gw as never);
      useStore.setState({ online: true });
    });
    press(document.querySelector('[data-testid="submit-inspection"]')!);
    tick(2000);
    expect(done()).toEqual([]);
    // what the socket refresh does: the submitted checklist leaves the open set (and the request's
    // own answer, when it lands, is dropped as a retired attempt)
    act(() => { useStore.setState({ openChecklists: [], checklist: null }); });
    tick();
    expect(tip()).toBeNull();
    expect(done()).toEqual(['raise-issue-engineer']);
  });

  it('an already-failed item\'s Fail is never the spotlit control (pressing it would clear the failure)', async () => {
    const s = await setup('engineer', 'engineer-check');
    const c = checklist();
    c.items[0] = { ...c.items[0]!, state: 'fail' };
    s.useStore.setState({ openChecklists: [c], checklist: c, selectedChecklistId: null });
    const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
    render(<><s.GuideHost /><EngineerChecklistScreen /></>);
    tick();
    const fails = document.querySelectorAll('[data-guide="mark-fail"]');
    expect(fails).toHaveLength(1);
    expect(fails[0]!.getAttribute('data-guide-key')).toBe('INSP-1:1');
    expect(step()).toBe('0');
  });

  it('a viewport that shrinks under the control moves the tip above it', async () => {
    await engineer();
    tick();
    expect(tip()?.style.top).not.toBe('');
    const before = window.innerHeight;
    try {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 100 });
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(tip()?.style.top).toBe('');
      expect(tip()?.style.bottom).not.toBe('');
    } finally {
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: before });
    }
  });

  it('a wrong-project answer to "Issue to engineer" is not an issued checklist', async () => {
    const s = await setup('pmc', 'dashboard');
    const { subscribeGuideOutcome } = await import('@/guide/outcomes');
    const seen: string[] = [];
    subscribeGuideOutcome((o) => seen.push(o));
    act(() => {
      s.useStore.getState()._setGateway({
        createInspection: vi.fn().mockResolvedValue({ project: { id: 'another-project' } }),
        snapshot: vi.fn(() => new Promise(() => {})),
      } as never);
    });
    s.useStore.getState().issueChecklist({ title: 'T', zone: 'Z', items: ['a'] });
    await vi.waitFor(() => expect(seen).toEqual(['checklist-issue-failed']));
  });

  it('a wrong-project answer overtaken by a newer pull is still not an issued checklist', async () => {
    const s = await setup('pmc', 'dashboard');
    const { subscribeGuideOutcome } = await import('@/guide/outcomes');
    const seen: string[] = [];
    subscribeGuideOutcome((o) => seen.push(o));
    const replies: Array<(v: unknown) => void> = [];
    act(() => {
      s.useStore.getState()._setGateway({
        createInspection: vi.fn(() => new Promise((resolve) => { replies.push(resolve); })),
        snapshot: vi.fn(() => new Promise(() => {})),
      } as never);
    });
    s.useStore.getState().issueChecklist({ title: 'T', zone: 'Z', items: ['a'] });
    // a newer lease in the same project: the first reply comes back superseded
    s.useStore.getState().issueChecklist({ title: 'T2', zone: 'Z', items: ['a'] });
    replies[0]!({ project: { id: 'another-project' } });
    await vi.waitFor(() => expect(seen).toEqual(['checklist-issue-failed']));
  });
});

describe('a guide whose first control goes away ends instead of hanging (review round 2)', () => {
  it('the checklist leaves while on the first step: the run ends, not done, and "Guide me" offers it when it is back', async () => {
    const { useStore, view } = await engineer();
    tick();
    expect(step()).toBe('0');
    const c = useStore.getState().checklist;
    act(() => { useStore.setState({ checklist: null, openChecklists: [] }); });
    tick(400);
    tick(1000);
    const { useGuideState } = await import('@/guide/guideState');
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).toEqual([]);
    act(() => { useStore.setState({ checklist: c, openChecklists: c ? [c] : [] }); });
    tick();
    // this visit's automatic start is used up; the replay is one tap away
    expect(tip()).toBeNull();
    press(view.getByTestId('guide-me'));
    tick();
    expect(step()).toBe('0');
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

/** a PMC who has finished the "raise an issue" guide, so the Dashboard's next guide is "record a decision" */
async function pmcForDecision(lang: Lang = 'en') {
  const s = await setup('pmc', 'dashboard', lang);
  localStorage.setItem(DONE_KEY, JSON.stringify(['raise-issue-pmc']));
  s.useStore.setState({ nodes: [{ id: 'gf', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 }] } as never);
  const { CreateControl } = await import('@/layout/CreateControl');
  const view = render(<><s.GuideHost /><s.GuideMe /><CreateControl /></>);
  return { ...s, view };
}

/** …on the guide's last step, inside a filled "New decision" form */
async function pmcAtPublish() {
  const p = await pmcForDecision();
  act(() => { p.useStore.getState()._setGateway({ listMembers: vi.fn().mockResolvedValue([]), snapshot: vi.fn(() => new Promise(() => {})) } as never); });
  tick();
  press(p.view.getByTestId('create-fab'));
  tick();
  press(document.querySelector('[data-guide="create-decision"]')!);
  tick();
  expect(step()).toBe('2');
  fireEvent.change(p.view.getByTestId('dec-title'), { target: { value: 'Veneer finish' } });
  fireEvent.change(p.view.getByTestId('dec-opt-0'), { target: { value: 'Teak' } });
  fireEvent.change(p.view.getByTestId('dec-opt-1'), { target: { value: 'Walnut' } });
  fireEvent.change(document.querySelector('select[data-testid$="select-zone"]')!, { target: { value: 'gf' } });
  expect(document.querySelector<HTMLButtonElement>('[data-guide="publish-decision"]')?.disabled).toBe(false);
  return p;
}

describe('the PMC is guided from + to publishing a decision', () => {
  it('starts on the Dashboard visit after "raise an issue" and walks + → "Something to decide here" → Publish', async () => {
    const { view } = await pmcForDecision();
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('record-decision-pmc');
    expect(tip()?.textContent).toContain('Something for the client to choose?');
    press(view.getByTestId('create-fab'));
    tick();
    expect(step()).toBe('1');
    expect(document.querySelector('[data-guide="create-decision"]')?.getAttribute('data-testid')).toBe('create-decision');
    press(document.querySelector('[data-guide="create-decision"]')!);
    tick();
    expect(step()).toBe('2');
    expect(document.querySelector('[data-guide="publish-decision"]')?.getAttribute('data-testid')).toBe('save-decision');
    expect(tip()?.closest('[role="dialog"]')?.contains(document.querySelector('[data-guide="publish-decision"]'))).toBe(true);
  });

  it('Publish waits for the server: a slow answer never steps back, an accepted one finishes the guide', async () => {
    const { useStore } = await pmcAtPublish();
    const replies: Array<(v: unknown) => void> = [];
    const createDecision = vi.fn(() => new Promise((resolve) => { replies.push(resolve); }));
    act(() => { useStore.getState()._setGateway({ createDecision, listMembers: vi.fn().mockResolvedValue([]), snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    const { useGuideState } = await import('@/guide/guideState');
    press(document.querySelector('[data-guide="publish-decision"]')!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(createDecision).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-guide="publish-decision"]')).toBeNull();
    tick(60_000);
    expect(useGuideState.getState().run?.step).toBe(2);
    expect(done()).toEqual(['raise-issue-pmc']);
    // the server's answer for this project (overtaken by a newer pull, so it is not re-applied)
    useStore.getState().issueDecision({ title: 'Other', nodeId: 'gf', publish: true, options: [] } as never);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { replies[0]!({ project: { id: 'project-a' } }); await Promise.resolve(); await Promise.resolve(); });
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).toEqual(['raise-issue-pmc', 'record-decision-pmc']);
  });

  it('a refused Publish does not finish it: the wait ends and the guide steps back to +', async () => {
    const { useStore } = await pmcAtPublish();
    let refuse!: (e: Error) => void;
    act(() => { useStore.getState()._setGateway({ createDecision: vi.fn(() => new Promise((_, reject) => { refuse = reject; })), listMembers: vi.fn().mockResolvedValue([]) } as never); });
    const { useGuideState } = await import('@/guide/guideState');
    press(document.querySelector('[data-guide="publish-decision"]')!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    tick(2000);
    expect(useGuideState.getState().run?.step).toBe(2);
    await act(async () => { refuse(new Error('refused')); await Promise.resolve(); await Promise.resolve(); });
    tick(400);
    tick(1000);
    expect(useGuideState.getState().run?.step).toBe(0);
    expect(done()).toEqual(['raise-issue-pmc']);
  });

  it('"Save as draft" is not publishing: the guide steps back to + and is not done', async () => {
    const { useStore, view } = await pmcAtPublish();
    const createDecision = vi.fn().mockResolvedValue({ project: { id: 'project-a' } });
    act(() => { useStore.getState()._setGateway({ createDecision, listMembers: vi.fn().mockResolvedValue([]), snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    press(view.getByTestId('save-draft'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    tick(400);
    tick(1000);
    expect(step()).toBe('0');
    expect(done()).toEqual(['raise-issue-pmc']);
  });

  it('the store reports a publish outcome: no server, a refusal and a wrong-project answer are failures; a draft reports nothing', async () => {
    const s = await setup('pmc', 'dashboard');
    const { subscribeGuideOutcome } = await import('@/guide/outcomes');
    const seen: string[] = [];
    subscribeGuideOutcome((o) => seen.push(o));
    const input = { title: 'T', nodeId: 'gf', publish: true, options: [] } as never;
    s.useStore.getState().issueDecision(input);
    expect(seen).toEqual(['decision-publish-failed']);
    act(() => { s.useStore.getState()._setGateway({ createDecision: vi.fn().mockRejectedValue(new Error('no')) } as never); });
    s.useStore.getState().issueDecision(input);
    await vi.waitFor(() => expect(seen).toEqual(['decision-publish-failed', 'decision-publish-failed']));
    act(() => { s.useStore.getState()._setGateway({ createDecision: vi.fn().mockResolvedValue({ project: { id: 'another-project' } }), snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    s.useStore.getState().issueDecision(input);
    await vi.waitFor(() => expect(seen).toHaveLength(3));
    expect(seen[2]).toBe('decision-publish-failed');
    s.useStore.getState().issueDecision({ title: 'D', nodeId: 'gf', publish: false, options: [] } as never);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(seen).toHaveLength(3);
  });

  it('a wrong-project answer overtaken by a newer pull is still not a published decision', async () => {
    const s = await setup('pmc', 'dashboard');
    const { subscribeGuideOutcome } = await import('@/guide/outcomes');
    const seen: string[] = [];
    subscribeGuideOutcome((o) => seen.push(o));
    const replies: Array<(v: unknown) => void> = [];
    act(() => {
      s.useStore.getState()._setGateway({
        createDecision: vi.fn(() => new Promise((resolve) => { replies.push(resolve); })),
        snapshot: vi.fn(() => new Promise(() => {})),
      } as never);
    });
    const input = { title: 'T', nodeId: 'gf', publish: true, options: [] } as never;
    s.useStore.getState().issueDecision(input);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    s.useStore.getState().issueDecision(input);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[0]!({ project: { id: 'another-project' } });
    await vi.waitFor(() => expect(seen).toEqual(['decision-publish-failed']));
  });

  it.each(['hi', 'gu'] as const)('speaks %s with no leftover English', async (lang) => {
    const { view } = await pmcForDecision(lang);
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('record-decision-pmc');
    expect(leftoverEnglish(tip()!)).toEqual([]);
    press(view.getByTestId('create-fab'));
    tick();
    expect(leftoverEnglish(tip()!)).toEqual([]);
  });
});

describe('review round 1 on "record a decision"', () => {
  it('"Guide me" reaches both Dashboard guides: one not done first, then each in turn', async () => {
    const { view } = await pmcForDecision();
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('record-decision-pmc');
    press(view.getByTestId('guide-skip'));
    tick();
    // both done; the guide started last was "record a decision", so the replay offers the other one
    press(view.getByTestId('guide-me'));
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('raise-issue-pmc');
    press(view.getByTestId('guide-skip'));
    tick();
    press(view.getByTestId('guide-me'));
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('record-decision-pmc');
  });

  it('a record-only publish ("Nobody — record only") is not the guided task', async () => {
    const s = await setup('pmc', 'dashboard');
    const { subscribeGuideOutcome } = await import('@/guide/outcomes');
    const seen: string[] = [];
    subscribeGuideOutcome((o) => seen.push(o));
    // a second publish takes a newer lease, so the record's reply comes back superseded (not re-applied)
    const replies: Array<(v: unknown) => void> = [];
    act(() => { s.useStore.getState()._setGateway({ createDecision: vi.fn(() => new Promise((resolve) => { replies.push(resolve); })), snapshot: vi.fn(() => new Promise(() => {})) } as never); });
    s.useStore.getState().issueDecision({ title: 'R', nodeId: 'gf', publish: true, options: [], deciderKind: 'none' } as never);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    s.useStore.getState().issueDecision({ title: 'D', nodeId: 'gf', publish: true, options: [] } as never);
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    replies[0]!({ project: { id: 'project-a' } });
    await vi.waitFor(() => expect(seen).toEqual(['decision-publish-failed']));
  });

  it('a publish or issue that answers after a project switch reports nothing to the guide now on screen', async () => {
    const s = await setup('pmc', 'dashboard');
    const { subscribeGuideOutcome } = await import('@/guide/outcomes');
    const seen: string[] = [];
    subscribeGuideOutcome((o) => seen.push(o));
    let refuseDecision!: (e: Error) => void;
    let refuseIssue!: (e: Error) => void;
    act(() => {
      s.useStore.getState()._setGateway({
        createDecision: vi.fn(() => new Promise((_, reject) => { refuseDecision = reject; })),
        createInspection: vi.fn(() => new Promise((_, reject) => { refuseIssue = reject; })),
      } as never);
    });
    s.useStore.getState().issueDecision({ title: 'T', nodeId: 'gf', publish: true, options: [] } as never);
    s.useStore.getState().issueChecklist({ title: 'T', zone: 'Z', items: ['a'] });
    await vi.waitFor(() => expect(refuseDecision).toBeTypeOf('function'));
    act(() => { s.useStore.setState({ activeProjectId: 'project-b', projectScopeGeneration: 2 }); });
    await act(async () => { refuseDecision(new Error('no')); refuseIssue(new Error('no')); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(seen).toEqual([]);
  });
});
