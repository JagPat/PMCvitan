import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { Decision, Lang, Role } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';
import { warmImports } from './warm-imports';

/**
 * #482 step 3 (Jagrut, 27 Oct: hand-hold every role) — the consultant's walkthrough: on the Decisions screen, the box
 * where they were asked for advice, then Send. The Send step finishes only when the advice really went (taken by the
 * server, or kept on this phone to send), and follows the one decision whose box the consultant wrote in.
 */

const DONE_KEY = 'vitan.guide.done.v1:user:u-con';

const asked = (id: string, consultee = 'u-con', answered = false): Decision =>
  ({
    id, title: `Title ${id}`, room: 'Kitchen', status: 'pending', deciderKind: 'client', photoSwatch: 'tile', approvalCycle: 0, ageDays: 1,
    options: [{ label: 'A', key: 'a', material: 'Granite', delta: 0, swatch: 'tile' }, { label: 'B', key: 'b', material: 'Quartz', delta: 0, swatch: 'tile' }],
    consultations: [{
      id: `c-${id}`, consulteeMembershipId: `m-${consultee}`, consulteeUserId: consultee, requestedById: 'u-pmc', question: 'Which holds up?', openCycle: 0,
      requestedAt: new Date().toISOString(),
      ...(answered ? { response: { response: 'Quartz', respondedById: consultee, respondedAt: new Date().toISOString() } } : {}),
    }],
  }) as unknown as Decision;

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/guide/GuideHost'), () => import('@/guide/guides'), () => import('@/guide/guideState'), () => import('@/guide/outcomes'), () => import('@/screens/DecisionLogScreen'), () => import('@/screens/ClientDecisionsScreen'));

beforeEach(() => {
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

async function start(decisions: Decision[], role: Role = 'consultant', lang: Lang = 'en') {
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
    screen: 'decision-log',
    lang,
    sessionUserId: 'u-con',
    decisions,
  } as never);
  const { GuideHost } = await import('@/guide/GuideHost');
  const { DecisionLogScreen } = await import('@/screens/DecisionLogScreen');
  const { useGuideState } = await import('@/guide/guideState');
  const outcomes = await import('@/guide/outcomes');
  const view = render(<><GuideHost /><DecisionLogScreen /></>);
  return { useStore, useGuideState, outcomes, view };
}

const tick = (ms = 400) => act(() => { vi.advanceTimersByTime(ms); });
const tip = () => document.querySelector<HTMLElement>('[data-testid="guide-tip"]');
const step = () => tip()?.getAttribute('data-guide-step') ?? null;
const done = (): string[] => JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[];
const press = (el: Element) => act(() => { fireEvent.click(el); });
const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
/** a server that never answers: the Send step waits on it (the register also asks it for the "Awaiting client" list) */
const silentServer = () => ({ respondToConsultation: vi.fn(() => new Promise(() => {})), awaitingClient: vi.fn(() => new Promise(() => {})) });
const box = (id: string) => byTestId(`consultation-respond-${id}`)!.querySelector('textarea')!;
const write = (id: string, text: string) => act(() => { fireEvent.change(box(id), { target: { value: text } }); });

/** the consultant on the Send step of DL-2, advice written */
async function atSend(decisions = [asked('DL-1'), asked('DL-2')]) {
  vi.useFakeTimers();
  const c = await start(decisions);
  tick();
  press(box('DL-2'));
  tick();
  expect(step()).toBe('1');
  write('DL-2', 'Quartz holds up better here.');
  return c;
}

describe('the consultant is guided through answering a request for advice', () => {
  it('shows itself the first time, walks the advice box → Send, and is done once the advice is sent (demo)', async () => {
    vi.useFakeTimers();
    await start([asked('DL-1'), asked('DL-2')]);
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('answer-advice');
    expect(tip()?.textContent).toContain('You were asked for your advice on this. Write it here.');
    // the box of any decision moves it on, carrying its decision
    press(box('DL-2'));
    tick();
    expect(step()).toBe('1');
    expect(tip()?.textContent).toContain('Then tap here to send it.');
    write('DL-2', 'Quartz holds up better here.');
    press(byTestId('consultation-send-advice-DL-2')!);
    tick();
    expect(tip()).toBeNull();
    expect(done()).toEqual(['answer-advice']);
  });

  it('the Send step follows the decision written in: advice sent on another decision does not finish it', async () => {
    const { useGuideState, outcomes } = await atSend();
    act(() => outcomes.emitGuideOutcome('advice-sent', 'DL-1:c-DL-1', outcomes.guideRunToken()));
    tick();
    expect(useGuideState.getState().run?.step).toBe(1);
    act(() => outcomes.emitGuideOutcome('advice-send-failed', 'DL-2:c-DL-2', outcomes.guideRunToken()));
    tick();
    expect(useGuideState.getState().run?.step).toBe(1);
    expect(done()).toEqual([]);
    act(() => outcomes.emitGuideOutcome('advice-sent', 'DL-2:c-DL-2', outcomes.guideRunToken()));
    tick();
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).toEqual(['answer-advice']);
  });

  it('advice not kept on this phone ends the run unfinished, so it is offered again', async () => {
    const { useStore, useGuideState, outcomes } = await atSend();
    act(() => { useStore.getState()._setGateway(silentServer() as never); });
    press(byTestId('consultation-send-advice-DL-2')!);
    act(() => outcomes.emitGuideOutcome('advice-not-kept', 'DL-2:c-DL-2', outcomes.guideRunToken()));
    tick();
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).toEqual([]);
  });

  it('a refresh that shows the advice answered finishes it, once this run pressed Send', async () => {
    const { useStore, useGuideState } = await atSend();
    act(() => { useStore.getState()._setGateway(silentServer() as never); });
    press(byTestId('consultation-send-advice-DL-2')!);
    act(() => { useStore.setState({ decisions: [asked('DL-1'), asked('DL-2', 'u-con', true)] } as never); });
    tick();
    expect(useGuideState.getState().run).toBeNull();
    expect(done()).toEqual(['answer-advice']);
  });

  it('nothing asked of this viewer (asked of someone else, or already answered) means no guide', async () => {
    vi.useFakeTimers();
    await start([asked('DL-1', 'u-other'), asked('DL-2', 'u-con', true)]);
    tick();
    expect(tip()).toBeNull();
    const { GUIDES } = await import('@/guide/guides');
    expect(GUIDES.find((g) => g.id === 'answer-advice')?.available?.()).toBe(false);
  });

  it.each(['architect', 'pmc', 'engineer', 'contractor'] as const)('a %s asked for advice is guided the same way', async (role) => {
    vi.useFakeTimers();
    await start([asked('DL-1')], role);
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('answer-advice');
  });

  it('the advice box reached from the keyboard moves it on too', async () => {
    vi.useFakeTimers();
    await start([asked('DL-1')]);
    tick();
    act(() => { box('DL-1').focus(); });
    tick();
    expect(step()).toBe('1');
  });

  it('an earlier answer on the same decision is not this one: a refused send does not finish it', async () => {
    const first = asked('DL-2', 'u-con', true);
    const twice = { ...first, consultations: [...first.consultations!, { ...first.consultations![0]!, id: 'c-DL-2b', response: undefined }] } as Decision;
    const { useStore, useGuideState, outcomes } = await atSend([asked('DL-1'), twice]);
    expect(useGuideState.getState().run?.key).toBe('DL-2:c-DL-2b');
    act(() => { useStore.getState()._setGateway(silentServer() as never); });
    press(byTestId('consultation-send-advice-DL-2')!);
    tick();
    expect(useGuideState.getState().run?.step).toBe(1);
    act(() => outcomes.emitGuideOutcome('advice-send-failed', 'DL-2:c-DL-2b', outcomes.guideRunToken()));
    tick();
    expect(done()).toEqual([]);
  });

  it.each(['hi', 'gu'] as const)('reads in %s with no English left over', async (lang) => {
    vi.useFakeTimers();
    await start([asked('DL-1')], 'consultant', lang);
    tick();
    expect(leftoverEnglish(tip()!)).toEqual([]);
  });
});

describe('the store reports a sent advice\'s outcome for the guide', () => {
  const settles = (cond: () => boolean) => vi.waitFor(() => { if (!cond()) throw new Error('not settled'); }, { timeout: 5000, interval: 10 });
  const answer = (projectId: string) => ({
    project: { id: projectId, name: 'A', short: 'A', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  });

  async function store(online = true) {
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    useStore.setState(getInitialState());
    useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'project-a', projectScopeGeneration: 1, projectLoadState: 'ready', role: 'consultant', sessionUserId: 'u-con', online, outbox: [], syncQueue: [], decisions: [asked('DL-1')] } as never);
    const { subscribeGuideOutcome } = await import('@/guide/outcomes');
    const seen: Array<[string, string | null]> = [];
    subscribeGuideOutcome((o, key) => seen.push([o, key]));
    const send = () => useStore.getState().respondToConsultation('DL-1', 'c-DL-1', 'Quartz.');
    return { useStore, seen, send };
  }

  it('demo: sent', async () => {
    const { seen, send } = await store();
    send();
    expect(seen).toEqual([['advice-sent', 'DL-1:c-DL-1']]);
  });

  it('online: taken by the server is sent', async () => {
    const { useStore, seen, send } = await store();
    useStore.getState()._setGateway({ respondToConsultation: vi.fn().mockResolvedValue(answer('project-a')), snapshot: vi.fn(() => new Promise(() => {})) } as never);
    send();
    await settles(() => seen.length > 0);
    expect(seen).toEqual([['advice-sent', 'DL-1:c-DL-1']]);
  });

  it('online: refused for good is failed', async () => {
    const { useStore, seen, send } = await store();
    useStore.getState()._setGateway({ respondToConsultation: vi.fn().mockRejectedValue(Object.assign(new Error('closed'), { status: 409 })) } as never);
    send();
    await settles(() => seen.length > 0);
    expect(seen).toEqual([['advice-send-failed', 'DL-1:c-DL-1']]);
  });

  it('online: left to send again, and kept on this phone, is queued (sent)', async () => {
    const { useStore, seen, send } = await store();
    useStore.getState()._setGateway({ respondToConsultation: vi.fn().mockRejectedValue(new Error('network')) } as never);
    send();
    await settles(() => seen.length > 0);
    expect(seen).toEqual([['advice-sent', 'DL-1:c-DL-1']]);
    expect(useStore.getState().outbox).toHaveLength(1);
  });

  it('online, then the signal is lost before the act settles: kept on this phone is queued (sent)', async () => {
    const { useStore, seen, send } = await store();
    const respond = vi.fn(() => new Promise(() => {}));
    useStore.getState()._setGateway({ respondToConsultation: respond } as never);
    send();
    // the request is on the wire before the signal goes (signals, not clocks)
    await settles(() => respond.mock.calls.length === 1);
    useStore.getState().toggleOnline();
    await settles(() => seen.length > 0);
    expect(seen).toEqual([['advice-sent', 'DL-1:c-DL-1']]);
  });

  it('the signal lost before the advice is written on this phone waits for the write: kept is queued (sent)', async () => {
    const { useStore, seen, send } = await store();
    useStore.getState()._setGateway({ respondToConsultation: vi.fn(() => new Promise(() => {})) } as never);
    send();
    // at once, before the write-ahead has run
    useStore.getState().toggleOnline();
    expect(seen).toEqual([]);
    await settles(() => seen.length > 0);
    expect(seen).toEqual([['advice-sent', 'DL-1:c-DL-1']]);
  });

  it('offline: kept on this phone is queued (sent)', async () => {
    const { seen, send } = await store(false);
    const { useStore } = await import('@/store/store');
    useStore.getState()._setGateway({ respondToConsultation: vi.fn() } as never);
    send();
    await settles(() => seen.length > 0);
    expect(seen).toEqual([['advice-sent', 'DL-1:c-DL-1']]);
  });
});

describe('Codex round 1 on #1198', () => {
  it('a box already focused before the guide started counts as reached: the guide moves on to Send', async () => {
    vi.useFakeTimers();
    const { useGuideState } = await start([asked('DL-1'), asked('DL-2')]);
    const { guidesFor } = await import('@/guide/guides');
    // no run yet when the box is tapped (the tip had not come up): no later focusin will say so
    act(() => { useGuideState.getState().stop(); });
    act(() => { box('DL-2').focus(); });
    expect(useGuideState.getState().run).toBeNull();
    const guide = guidesFor('consultant', 'decision-log').find((x) => x.id === 'answer-advice')!;
    act(() => { useGuideState.getState().start(guide); });
    tick();
    expect(useGuideState.getState().run?.step).toBe(1);
    expect(useGuideState.getState().run?.key).toBe('DL-2:c-DL-2');
    // and it follows the decision whose box has the focus
    write('DL-2', 'Quartz holds up better here.');
    press(byTestId('consultation-send-advice-DL-2')!);
    tick();
    expect(done()).toEqual(['answer-advice']);
  });

  it('a client asked for advice is guided on their own Decisions screen, through the same box and Send', async () => {
    vi.useFakeTimers();
    localStorage.setItem('vitan.guide.done.v1:user:u-cli', JSON.stringify(['approve-decision-client']));
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    useStore.setState(getInitialState());
    useStore.setState({
      ...scope.emptyProjectData(),
      activeProjectId: 'project-a',
      projectScopeGeneration: 1,
      projectLoadState: 'ready',
      role: 'client',
      screen: 'client-decisions',
      lang: 'en',
      sessionUserId: 'u-cli',
      decisions: [asked('DL-1', 'u-cli')],
    } as never);
    const { GuideHost } = await import('@/guide/GuideHost');
    const { ClientDecisionsScreen } = await import('@/screens/ClientDecisionsScreen');
    render(<><GuideHost /><ClientDecisionsScreen /></>);
    tick();
    expect(tip()?.getAttribute('data-guide-id')).toBe('answer-advice-client');
    press(box('DL-1'));
    tick();
    expect(step()).toBe('1');
    write('DL-1', 'Quartz, please.');
    press(byTestId('consultation-send-advice-DL-1')!);
    tick();
    expect(tip()).toBeNull();
    expect(JSON.parse(localStorage.getItem('vitan.guide.done.v1:user:u-cli') ?? '[]')).toContain('answer-advice-client');
  });
});
