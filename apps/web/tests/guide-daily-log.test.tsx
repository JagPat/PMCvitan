import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { DailyLog } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * #482 step 3c (Jagrut, 27 Oct: hold people's hands wherever they ask for help): the engineer's daily log guide.
 * Check in (passed over when already checked in), then Submit Daily Log to PMC. Submit ends only on the server's answer,
 * once the log is kept on this phone to send, or once a refresh shows the log sent.
 */

const DONE_KEY = 'vitan.guide.done.v1:user:u-eng';

const log = (over: Partial<DailyLog> = {}): DailyLog => ({
  id: 'log-15', date: '15 Oct 2026', logDate: '2026-10-15', checkedIn: false, checkinTime: null, submitted: false, progress: 0,
  crew: [{ trade: 'Mason', count: 2 }], materials: [], photos: [],
  ...over,
} as DailyLog);

const snapshot = (dailyLog: DailyLog) => ({
  project: { id: 'qa', name: 'QA', short: 'QA', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog, notifications: [], companies: [], nodes: [], photos: [], materials: [],
});

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/screens/DailyLogScreen'), () => import('@/guide/GuideHost'), () => import('@/guide/guides'), () => import('@/guide/guideState'), () => import('@/guide/outcomes'));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) {
    return (this.isConnected ? [new DOMRect(0, 0, 40, 40)] : []) as unknown as DOMRectList;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function open(dailyLog: DailyLog | null, gateway: Record<string, unknown> | null, online = true) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T06:00:00Z'));
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.stubEnv('VITE_DAILYLOG_READ', 'snapshot');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'qa', projectScopeGeneration: 1, projectLoadState: 'ready', role: 'engineer', sessionUserId: 'u-eng', short: 'QA',
    lang: 'en', timeZone: 'Asia/Kolkata', screen: 'daily-log', online, outbox: [], syncQueue: [], dailyLog,
  } as never);
  if (gateway) useStore.getState()._setGateway({ snapshot: vi.fn(() => new Promise(() => {})), ...gateway } as never);
  const { GuideHost } = await import('@/guide/GuideHost');
  const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
  const { GUIDES } = await import('@/guide/guides');
  const { useGuideState } = await import('@/guide/guideState');
  const outcomes = await import('@/guide/outcomes');
  const seen: string[] = [];
  outcomes.subscribeGuideOutcome((o) => seen.push(o));
  render(<><GuideHost /><DailyLogScreen /></>);
  const guide = GUIDES.find((g) => g.id === 'send-daily-log')!;
  return { useStore, useGuideState, guide, outcomes, seen };
}

const tip = () => document.querySelector<HTMLElement>('[data-testid="guide-tip"]');
const step = () => tip()?.getAttribute('data-guide-step') ?? null;
const tipAt = (n: string) => vi.waitFor(() => { if (step() !== n) throw new Error(`tip at ${step()}`); });
const done = (): string[] => JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]') as string[];
const isDone = () => vi.waitFor(() => { if (!done().includes('send-daily-log')) throw new Error('not done'); });
const press = (testId: string) => act(() => { fireEvent.click(document.querySelector(`[data-testid="${testId}"]`)!); });

describe('the daily log guide (#482 step 3c)', () => {
  it('walks Check in → Submit, and is done once the server takes the log', async () => {
    // the server's answer reads the log back unsent, so only the send's own report can finish the run
    const submitDailyLog = vi.fn(async () => snapshot(log({ checkedIn: true, checkinTime: '11:30', submitted: false })));
    const { useGuideState, guide, seen } = await open(log(), { submitDailyLog });
    expect(guide.available!()).toBe(true);
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('0');
    press('check-in');
    await tipAt('1');
    press('submit-daily-log');
    await isDone();
    expect(submitDailyLog).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['daily-log-sent']);
    expect(useGuideState.getState().run).toBeNull();
  });

  it('already checked in: starts at Submit', async () => {
    const { useGuideState, guide } = await open(log({ checkedIn: true, checkinTime: '09:00' }), { submitDailyLog: vi.fn(() => new Promise(() => {})) });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('1');
    expect(useGuideState.getState().run?.pressed).toBe(false);
  });

  it('a send the server refuses leaves it on Submit, unfinished', async () => {
    const submitDailyLog = vi.fn(async () => { throw Object.assign(new Error('closed'), { status: 409 }); });
    const { useGuideState, guide } = await open(log({ checkedIn: true, checkinTime: '09:00' }), { submitDailyLog });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('1');
    press('submit-daily-log');
    await vi.waitFor(() => { if (submitDailyLog.mock.calls.length !== 1 || useGuideState.getState().run?.waiting !== false) throw new Error('waiting'); });
    expect(done()).not.toContain('send-daily-log');
    expect(useGuideState.getState().run?.step).toBe(1);
  });

  it('without signal: done once the log is kept on this phone to send', async () => {
    const submitDailyLog = vi.fn();
    const { useStore, useGuideState, guide } = await open(log({ checkedIn: true, checkinTime: '09:00' }), { submitDailyLog }, false);
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('1');
    press('submit-daily-log');
    await isDone();
    expect(submitDailyLog).not.toHaveBeenCalled();
    expect(useStore.getState().outbox).toHaveLength(1);
  });

  it('the demo (no server) records the log sent: done', async () => {
    const { useStore, useGuideState, guide, seen } = await open(log({ checkedIn: true, checkinTime: '09:00' }), null);
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('1');
    press('submit-daily-log');
    await isDone();
    expect(seen).toEqual(['daily-log-sent']);
    expect(useStore.getState().dailyLog?.submitted).toBe(true);
  });

  it('without signal, a log this phone would not keep ends the run unfinished, so it is offered again', async () => {
    const submitDailyLog = vi.fn();
    const { useStore, useGuideState, guide, seen } = await open(log({ checkedIn: true, checkinTime: '09:00' }), { submitDailyLog }, false);
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('1');
    // the phone's storage refuses every write, so the queued send is not kept
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    press('submit-daily-log');
    await vi.waitFor(() => { if (seen.length === 0) throw new Error('not told'); });
    expect(seen).toEqual(['daily-log-not-kept']);
    expect(useGuideState.getState().run).toBeNull();
    expect(submitDailyLog).not.toHaveBeenCalled();
    expect(useStore.getState().dailyLog?.submitted).toBe(false);
  });

  it('checked out before Submit: the send is refused at once and told, so the guide does not wait', async () => {
    const submitDailyLog = vi.fn();
    const { useStore, useGuideState, guide, seen } = await open(log({ checkedIn: true, checkinTime: '09:00' }), { submitDailyLog });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('1');
    act(() => { useStore.setState((s) => { s.dailyLog!.checkedIn = false; }); });
    press('submit-daily-log');
    expect(seen).toEqual(['daily-log-send-failed']);
    expect(submitDailyLog).not.toHaveBeenCalled();
    expect(useGuideState.getState().run?.waiting ?? false).toBe(false);
    expect(done()).not.toContain('send-daily-log');
    // the guide goes back to Check in, which is on screen again
    await tipAt('0');
  });

  it('a send the server refuses while checked in stays on Submit, not Check in (not on screen)', async () => {
    const submitDailyLog = vi.fn(async () => { throw Object.assign(new Error('closed'), { status: 409 }); });
    const { useGuideState, guide } = await open(log({ checkedIn: true, checkinTime: '09:00' }), { submitDailyLog });
    act(() => { useGuideState.getState().start(guide); });
    await tipAt('1');
    expect(document.querySelector('[data-testid="check-in"]')).toBeNull();
    press('submit-daily-log');
    await vi.waitFor(() => { if (useGuideState.getState().run?.waiting !== false) throw new Error('waiting'); });
    await tipAt('1');
  });

  it('is not offered once the log is sent, or with no log today', async () => {
    const { useStore, guide } = await open(log({ checkedIn: true, submitted: true }), null);
    expect(guide.available!()).toBe(false);
    act(() => { useStore.setState({ dailyLog: null }); });
    expect(guide.available!()).toBe(false);
    expect(guide.roles).toEqual(['engineer']);
  });
});
