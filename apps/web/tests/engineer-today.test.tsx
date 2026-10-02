import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { SEED_DAILY_LOG, engineerTodayLabels as L, type DailyLog } from '@vitan/shared';
import { todayPath } from '@/lib/engineerToday';
import { todayCivil } from '@/lib/civilDate';

const TODAY = todayCivil(null);

/**
 * UX slice 2a — the site engineer's Today: one "do this now" action and the day's four-step
 * path, read from the daily log the Site screen already records (presentation only).
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const log = (over: Partial<DailyLog> = {}): DailyLog => ({
  ...structuredClone(SEED_DAILY_LOG),
  crew: SEED_DAILY_LOG.crew.map((c) => ({ ...c, count: 0 })),
  progress: 0,
  photos: [],
  logDate: TODAY,
  ...over,
});

describe('todayPath — the day read from the log', () => {
  it('no log yet: the one action is to start it, nothing is done', () => {
    const p = todayPath(null, 0);
    expect(p.action).toBe('start');
    expect(p.doneCount).toBe(0);
  });

  it('walks check in → crew → photos → send, one step at a time', () => {
    expect(todayPath(log(), 0).action).toBe('checkIn');
    expect(todayPath(log({ checkedIn: true }), 0).action).toBe('crew');
    expect(todayPath(log({ checkedIn: true }), 7).action).toBe('photos');
    const ready = todayPath(log({ checkedIn: true, progress: 2 }), 7);
    expect(ready.action).toBe('send');
    expect(ready.doneCount).toBe(3);
  });

  it('a submitted log is done, and says only what the log shows', () => {
    const p = todayPath(log({ checkedIn: true, submitted: true, progress: 1 }), 0, TODAY);
    expect(p.action).toBe('done');
    expect(p.done).toEqual({ checkIn: true, crew: false, photos: true, send: true });
  });

  it('a log sent on an earlier civil day is finished: today starts fresh', () => {
    const sent = log({ checkedIn: true, submitted: true, progress: 2, logDate: '2026-09-28' });
    const p = todayPath(sent, 5, '2026-09-29');
    expect(p.action).toBe('start');
    expect(p.doneCount).toBe(0);
    // the same log on its own day is done
    expect(todayPath(sent, 5, '2026-09-28').action).toBe('done');
  });

  it('a sent log with no civil date (a legacy row) is history: today starts fresh', () => {
    expect(todayPath(log({ checkedIn: true, submitted: true, logDate: null }), 5, '2026-09-29').action).toBe('start');
    // an unsent undated log is still the one to finish
    expect(todayPath(log({ checkedIn: true, logDate: null }), 5, '2026-09-29').action).toBe('photos');
  });

  it('an earlier log never sent is still the one to finish', () => {
    expect(todayPath(log({ checkedIn: true, logDate: '2026-09-28' }), 0, '2026-09-29').action).toBe('crew');
  });

  it('only this log’s photos count: the project’s older progress media is not today’s', () => {
    const older = [{ id: 'm1', url: 'data:x' } as DailyLog['photos'][number]];
    const p = todayPath(log({ checkedIn: true, photos: older, progress: 0 }), 3, TODAY);
    expect(p.done.photos).toBe(false);
    expect(p.action).toBe('photos');
    expect(todayPath(log({ checkedIn: true, photos: older, progress: 1 }), 3, TODAY).done.photos).toBe(true);
  });
});

async function loadToday(overrides: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'engineer',
    lang: 'en',
    short: 'Villa Bodakdev',
    screen: 'inbox',
    ...overrides,
  });
  const { InboxScreen } = await import('@/screens/InboxScreen');
  return { useStore, r: render(<InboxScreen />) };
}

describe('Engineer Today — the screen', () => {
  it('an engineer opens to Today, not the generic For You list', async () => {
    const { r } = await loadToday({ dailyLog: log() });
    expect(r.getByTestId('engineer-today')).toBeTruthy();
    expect(r.queryByText(/FOR YOU/)).toBeNull();
    // the site-log card is carried by the path, so it isn't repeated below
    expect(r.queryByTestId('inbox-item-eng-log')).toBeNull();
  });

  it('other roles keep For You', async () => {
    const { r } = await loadToday({ role: 'pmc' });
    expect(r.queryByTestId('engineer-today')).toBeNull();
    expect(r.getByText(/FOR YOU/)).toBeTruthy();
  });

  it('the big action checks in, and the path moves on to crew', async () => {
    const { useStore, r } = await loadToday({ dailyLog: log() });
    expect(r.getByTestId('today-now').dataset.action).toBe('checkIn');
    fireEvent.click(r.getByTestId('today-action'));
    expect(useStore.getState().dailyLog?.checkedIn).toBe(true);
    expect(r.getByTestId('today-now').dataset.action).toBe('crew');
    expect(r.getByTestId('today-step-checkIn').dataset.state).toBe('done');
    expect(r.getByTestId('today-step-crew').dataset.state).toBe('next');
    expect(r.getByTestId('today-count').textContent).toBe('1 of 4 done');
  });

  // U1: the crew step is asked in place, one trade at a time (tests/crew-stepper.test.tsx)
  it('photos open the Site screen, where they are recorded', async () => {
    const counted = log({ checkedIn: true });
    counted.crew[0].count = 3;
    const { useStore, r } = await loadToday({ dailyLog: counted });
    expect(r.getByTestId('today-now').dataset.action).toBe('photos');
    fireEvent.click(r.getByTestId('today-action'));
    expect(useStore.getState().screen).toBe('daily-log');
  });

  it('when everything is logged, one tap sends it to PMC', async () => {
    const withCrew = log({ checkedIn: true, progress: 2 });
    withCrew.crew[0].count = 3;
    const { useStore, r } = await loadToday({ dailyLog: withCrew });
    expect(r.getByTestId('today-now').dataset.action).toBe('send');
    fireEvent.click(r.getByTestId('today-action'));
    expect(useStore.getState().dailyLog?.submitted).toBe(true);
    expect(r.getByTestId('today-now').dataset.action).toBe('done');
    expect(r.getByText(L.action.done.en)).toBeTruthy();
    expect(r.queryByTestId('today-action')).toBeNull();
  });

  it('a sent log with no crew (a holiday) reads as a record: the crew step is "Not recorded", not an open step', async () => {
    const { r } = await loadToday({ dailyLog: log({ checkedIn: true, progress: 1, submitted: true }) });
    expect(r.getByTestId('today-now').dataset.action).toBe('done');
    const crew = r.getByTestId('today-step-crew');
    expect(crew.dataset.state).toBe('skipped');
    expect(crew.textContent).toContain(L.notRecorded.en);
    expect(crew.textContent).not.toContain(L.estimate.crew.en);
    expect(r.getByTestId('today-count').textContent).toBe('3 of 4 done');
    // no step on a sent log is ever an open to-do
    for (const k of ['checkIn', 'crew', 'photos', 'send']) expect(r.getByTestId(`today-step-${k}`).dataset.state).not.toMatch(/todo|next/);
  });

  it('done is shown in words, not colour alone', async () => {
    const { r } = await loadToday({ dailyLog: log({ checkedIn: true }) });
    expect(r.getByTestId('today-step-checkIn').textContent).toContain(L.done.en);
    expect(r.getByTestId('today-step-crew').textContent).toContain(L.next.en);
  });

  it('with no log yet, the action is to start one', async () => {
    const { r } = await loadToday({ dailyLog: null });
    expect(r.getByTestId('today-now').dataset.action).toBe('start');
    expect(r.getByTestId('today-action').textContent).toContain(L.action.start.en);
  });

  it('speaks Gujarati to a Gujarati reader', async () => {
    const { r } = await loadToday({ dailyLog: log(), lang: 'gu' });
    expect(r.getByTestId('today-action').textContent).toContain(L.action.checkIn.gu);
    expect(r.getByText(L.path.gu)).toBeTruthy();
    expect(r.getByTestId('today-count').textContent).toBe('4 માંથી 0 થયાં');
  });

  it('and Hindi to a Hindi reader', async () => {
    const { r } = await loadToday({ dailyLog: log(), lang: 'hi' });
    expect(r.getByTestId('today-action').textContent).toContain(L.action.checkIn.hi);
    expect(r.getByTestId('today-step-send').textContent).toContain(L.step.send.hi);
  });

  it('while the module read is loading it never offers to start a log', async () => {
    const { r } = await loadToday({ dailyLog: null, dailyLogLoad: 'loading' }, { VITE_DAILYLOG_READ: 'moduleQuery' });
    expect(r.getByTestId('today-now').dataset.action).toBe('loading');
    expect(r.queryByTestId('today-action')).toBeNull();
  });

  it('a failed read offers a retry, not a blank day', async () => {
    const { r } = await loadToday({ dailyLog: null, dailyLogLoad: 'error' }, { VITE_DAILYLOG_READ: 'moduleQuery' });
    expect(r.getByTestId('today-now').dataset.action).toBe('unavailable');
    expect(r.getByTestId('today-retry')).toBeTruthy();
  });

  it('a failed refresh over a last-known log shows the failure and a retry, never the log as done', async () => {
    const sent = log({ checkedIn: true, progress: 2, submitted: true });
    const { r } = await loadToday({ dailyLog: sent, dailyLogLoad: 'error' }, { VITE_DAILYLOG_READ: 'moduleQuery' });
    expect(r.getByTestId('today-now').dataset.action).toBe('unavailable');
    expect(r.getByText(L.staleDetail.en)).toBeTruthy();
    expect(r.getByTestId('today-retry')).toBeTruthy();
    expect(r.queryByText(L.action.done.en)).toBeNull();
    expect(r.queryByTestId('today-action')).toBeNull();
  });

  it('while a retry is loading over a retained sent log, it shows loading — not the log as done', async () => {
    const sent = log({ checkedIn: true, progress: 2, submitted: true });
    const { r } = await loadToday({ dailyLog: sent, dailyLogLoad: 'loading' }, { VITE_DAILYLOG_READ: 'moduleQuery' });
    expect(r.getByTestId('today-now').dataset.action).toBe('loading');
    expect(r.queryByText(L.action.done.en)).toBeNull();
    expect(r.queryByTestId('today-action')).toBeNull();
    // the path would be read from the unconfirmed log, so it waits for the read too
    expect(r.queryByTestId('today-step-send')).toBeNull();
  });

  it('a failed read hides the path read from the retained log', async () => {
    const sent = log({ checkedIn: true, progress: 2, submitted: true });
    const { r } = await loadToday({ dailyLog: sent, dailyLogLoad: 'error' }, { VITE_DAILYLOG_READ: 'moduleQuery' });
    expect(r.queryByTestId('today-count')).toBeNull();
  });

  it('a send already queued is shown as sending — the button is not offered twice', async () => {
    const ready = log({ checkedIn: true, progress: 2 });
    ready.crew[0].count = 3;
    const queued = { t: 'submitDailyLog' as const, log: { checkedIn: true, checkinTime: null, progress: 2, crew: ready.crew }, idempotencyKey: 'k1' };
    const { r } = await loadToday({ dailyLog: ready, outbox: [queued], online: false });
    expect(r.getByTestId('today-now').dataset.action).toBe('pending-send');
    expect(r.getByText(L.pendingSend.en)).toBeTruthy();
    expect(r.getByText(L.savedOffline.en)).toBeTruthy();
    expect(r.queryByTestId('today-action')).toBeNull();
  });

  it('a start already queued is shown as starting — no second start', async () => {
    const { r } = await loadToday({ dailyLog: null, outbox: [{ t: 'startDailyLog', idempotencyKey: 'k2' }], online: true });
    expect(r.getByTestId('today-now').dataset.action).toBe('pending-start');
    expect(r.queryByText(L.savedOffline.en)).toBeNull();
    expect(r.queryByTestId('today-action')).toBeNull();
  });

  it('after the server commits a send, the stale log never offers Send again before its read lands', async () => {
    const ready = log({ checkedIn: true, progress: 2 });
    ready.crew[0].count = 3;
    const { useStore, r } = await loadToday({ dailyLog: ready, dailyLogLoad: 'ready', outbox: [], dailyLogReconcileAfter: 7, dailyLogReconcileKind: 'send' }, { VITE_DAILYLOG_READ: 'moduleQuery' });
    expect(r.getByTestId('today-now').dataset.action).toBe('pending-send');
    expect(r.queryByTestId('today-action')).toBeNull();
    // the reconcile's read lands the submitted log and clears the flag
    act(() => useStore.setState({ dailyLog: { ...ready, submitted: true }, dailyLogReconcileAfter: null, dailyLogReconcileKind: null }));
    expect(r.getByTestId('today-now').dataset.action).toBe('done');
  });

  it('the next morning, yesterday’s sent log leads to starting today’s', async () => {
    const yesterday = log({ checkedIn: true, progress: 2, submitted: true, logDate: '2000-01-01' });
    const { r } = await loadToday({ dailyLog: yesterday, timeZone: 'Asia/Kolkata' });
    expect(r.getByTestId('today-now').dataset.action).toBe('start');
    expect(r.getByTestId('today-count').textContent).toBe('0 of 4 done');
  });

  it('the heading names the site’s day, not the device’s', async () => {
    // 20:30 UTC on 28 Sep is already 29 Sep in Kolkata
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-28T20:30:00Z'));
    try {
      const { r } = await loadToday({ dailyLog: log({ logDate: '2026-09-29' }), timeZone: 'Asia/Kolkata' });
      expect(r.getByTestId('engineer-today').textContent).toContain('29 September');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a page left open across the site’s midnight moves on to the new day', async () => {
    vi.useFakeTimers();
    // 23:59 in Kolkata on 29 Sep
    vi.setSystemTime(new Date('2026-09-29T18:29:00Z'));
    try {
      const sent = log({ checkedIn: true, progress: 2, submitted: true, logDate: '2026-09-29' });
      sent.crew[0].count = 3;
      const { r } = await loadToday({ dailyLog: sent, timeZone: 'Asia/Kolkata' });
      expect(r.getByTestId('today-now').dataset.action).toBe('done');
      await act(async () => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      expect(r.getByTestId('today-now').dataset.action).toBe('start');
      expect(r.getByTestId('engineer-today').textContent).toContain('30 September');
    } finally {
      vi.useRealTimers();
    }
  });

  it('every step is a tap target at least 44px tall', async () => {
    const { r } = await loadToday({ dailyLog: log() });
    // CSS Modules don't compute in jsdom; the floor lives in the stylesheet and is asserted there
    const css = (await import('node:fs')).readFileSync('src/screens/EngineerToday.module.css', 'utf8');
    for (const cls of ['step', 'nowAction', 'nowSecondary']) {
      const m = css.match(new RegExp(`\\.${cls} \\{[^}]*min-height: (\\d+)px`));
      expect(Number(m?.[1])).toBeGreaterThanOrEqual(44);
    }
    expect(r.getAllByRole('button').length).toBeGreaterThanOrEqual(5);
  });
});

describe('review round 7 — what the log really records, and what the server really requires', () => {
  it('a check-in-only log (a rain day) can be sent from the card: crew and photos never gate Send', async () => {
    const { useStore, r } = await loadToday({ dailyLog: log({ checkedIn: true }) });
    expect(r.getByTestId('today-now').dataset.action).toBe('crew');
    const anyway = r.getByTestId('today-send-anyway');
    expect(anyway.textContent).toContain(L.sendAnyway.en);
    fireEvent.click(anyway);
    expect(useStore.getState().dailyLog?.submitted).toBe(true);
    expect(r.getByTestId('today-now').dataset.action).toBe('done');
  });

  it('Send-anyway needs a checked-in log and the send permission', async () => {
    const { r } = await loadToday({ dailyLog: log() });
    expect(r.getByTestId('today-now').dataset.action).toBe('checkIn');
    expect(r.queryByTestId('today-send-anyway')).toBeNull();
  });

  it('only this log’s own photo count counts: project media is never evidence, even from the same day', () => {
    const taken = (iso: string) => [{ id: 'm1', url: 'data:x', takenAt: iso }] as DailyLog['photos'];
    const today = '2026-09-29';
    // a second log started the same day (the server allows it once the first is sent) sees the
    // first log's same-day photo in the project gallery — it is not this log's photo
    const secondLog = log({ checkedIn: true, progress: 0, logDate: today, photos: taken('2026-09-29T06:10:00Z') });
    expect(todayPath(secondLog, 3, today).done.photos).toBe(false);
    expect(todayPath(secondLog, 3, today).action).toBe('photos');
    expect(todayPath(log({ checkedIn: true, progress: 1, logDate: today }), 3, today).done.photos).toBe(true);
  });

  it('a photos step that reads not-done (e.g. after a reload) never withholds Send', async () => {
    const reloaded = log({ checkedIn: true, progress: 0, photos: [{ id: 'm1', url: 'data:x', takenAt: new Date().toISOString() }] });
    reloaded.crew[0].count = 3;
    const { r } = await loadToday({ dailyLog: reloaded });
    expect(r.getByTestId('today-now').dataset.action).toBe('photos');
    expect(r.getByTestId('today-send-anyway')).toBeTruthy();
  });

  it('an earlier day’s unsent log is named by its date, never as today’s', async () => {
    const old = log({ checkedIn: true, progress: 2, logDate: '2000-01-01' });
    old.crew[0].count = 3;
    const { r } = await loadToday({ dailyLog: old, timeZone: 'Asia/Kolkata' });
    expect(r.getByTestId('today-now').dataset.action).toBe('send');
    expect(r.getByTestId('today-overdue').textContent).toContain('1 January');
    expect(r.getByTestId('today-action').textContent).toContain(L.sendThisLog.en);
    expect(r.getByTestId('today-action').textContent).not.toContain(L.action.send.en);
    expect(r.getByText('Log for 1 January')).toBeTruthy();
  });

  it('today’s log carries no overdue line', async () => {
    const { r } = await loadToday({ dailyLog: log({ checkedIn: true }) });
    expect(r.queryByTestId('today-overdue')).toBeNull();
  });
});

describe('one rule for every writer — a start or send already on its way is never sent twice', () => {
  async function loadStore(overrides: Record<string, unknown>) {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    useStore.setState(getInitialState());
    // a gateway that never answers: the write-ahead op stays queued, exactly as offline or in flight
    const never = () => new Promise(() => {});
    useStore.getState()._setGateway({ submitDailyLog: vi.fn(never), startDailyLog: vi.fn(never), snapshot: vi.fn(never) } as never);
    useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', role: 'engineer', lang: 'en', online: false, ...overrides });
    return useStore;
  }
  const sentOps = (useStore: Awaited<ReturnType<typeof loadStore>>, t: string) => useStore.getState().outbox.filter((o) => o.t === t).length;

  it('the store queues a second send neither while the first is queued nor while it is being read back', async () => {
    const ready = log({ checkedIn: true, progress: 2 });
    const useStore = await loadStore({ dailyLog: ready });
    useStore.getState().submitDailyLog();
    useStore.getState().submitDailyLog();
    expect(sentOps(useStore, 'submitDailyLog')).toBe(1);
    // committed, awaiting the read-back: the outbox is empty but the log on screen predates the send
    useStore.setState({ outbox: [], dailyLogReconcileAfter: 5, dailyLogReconcileKind: 'send' });
    useStore.getState().submitDailyLog();
    expect(sentOps(useStore, 'submitDailyLog')).toBe(0);
  });

  it('the store queues a second start neither while the first is queued nor while it is being read back', async () => {
    const useStore = await loadStore({ dailyLog: null });
    useStore.getState().startDailyLog();
    useStore.getState().startDailyLog();
    expect(sentOps(useStore, 'startDailyLog')).toBe(1);
    useStore.setState({ outbox: [], dailyLogReconcileAfter: 5, dailyLogReconcileKind: 'start' });
    useStore.getState().startDailyLog();
    expect(sentOps(useStore, 'startDailyLog')).toBe(0);
  });

  it('the Site screen shows the send on its way and does not offer Submit again', async () => {
    const ready = log({ checkedIn: true, progress: 2 });
    const useStore = await loadStore({ dailyLog: ready, dailyLogReconcileAfter: 5, dailyLogReconcileKind: 'send' });
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    const submit = r.getByTestId('submit-daily-log') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain('Sending to PMC');
    // once the read-back lands the log is sent, and nothing is pending
    act(() => useStore.setState({ dailyLog: { ...ready, submitted: true }, dailyLogReconcileAfter: null, dailyLogReconcileKind: null }));
    expect((r.getByTestId('submit-daily-log') as HTMLButtonElement).textContent).toContain('sent to PMC');
  });

  it('the Site screen does not offer Start again while a start is on its way', async () => {
    await loadStore({ dailyLog: null, outbox: [{ t: 'startDailyLog', idempotencyKey: 'k' }] });
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    expect((r.getByTestId('start-new-day') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('review round 9 — the pending card names the command actually on its way', () => {
  it('a start queued over a log already sent today shows as starting, not as "with PMC"', async () => {
    const sentToday = log({ checkedIn: true, progress: 1, submitted: true });
    const { r } = await loadToday({ dailyLog: sentToday, outbox: [{ t: 'startDailyLog', idempotencyKey: 'k' }], online: false });
    expect(r.getByTestId('today-now').dataset.action).toBe('pending-start');
    expect(r.getByText(L.savedOffline.en)).toBeTruthy();
    expect(r.queryByText(L.action.done.en)).toBeNull();
  });

  it('a committed start still being read back shows as starting, over the previous sent log', async () => {
    const sentToday = log({ checkedIn: true, progress: 1, submitted: true });
    const { r } = await loadToday({ dailyLog: sentToday, dailyLogLoad: 'ready', dailyLogReconcileAfter: 3, dailyLogReconcileKind: 'start' }, { VITE_DAILYLOG_READ: 'moduleQuery' });
    expect(r.getByTestId('today-now').dataset.action).toBe('pending-start');
  });

  it('a committed send being read back is shown as sending — never as a start', async () => {
    const ready = log({ checkedIn: true, progress: 2 });
    const { r } = await loadToday({ dailyLog: ready, dailyLogLoad: 'ready', dailyLogReconcileAfter: 3, dailyLogReconcileKind: 'send' }, { VITE_DAILYLOG_READ: 'moduleQuery' });
    expect(r.getByTestId('today-now').dataset.action).toBe('pending-send');
    expect(r.queryByText(L.pendingStart.en)).toBeNull();
  });
});

describe('shadow review — a log already sent is never sent again', () => {
  it('the store refuses to send a log that is already sent', async () => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    useStore.setState(getInitialState());
    const never = () => new Promise(() => {});
    useStore.getState()._setGateway({ submitDailyLog: vi.fn(never), snapshot: vi.fn(never) } as never);
    useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', role: 'engineer', online: false, dailyLog: log({ checkedIn: true, submitted: true }) });
    useStore.getState().submitDailyLog();
    expect(useStore.getState().outbox.filter((o) => o.t === 'submitDailyLog')).toHaveLength(0);
  });

  it('the Site screen’s Submit is disabled once the log is sent', async () => {
    await loadToday({ dailyLog: log({ checkedIn: true, submitted: true }) });
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    expect((r.getAllByTestId('submit-daily-log').at(-1) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('shadow review — the heading and the path read one clock', () => {
  it('a re-render just after the site’s midnight names the new day in both, before any minute tick', async () => {
    vi.useFakeTimers();
    // 23:59:30 in Kolkata on 29 Sep
    vi.setSystemTime(new Date('2026-09-29T18:29:30Z'));
    try {
      const unsent = log({ checkedIn: true, progress: 2, logDate: '2026-09-29' });
      unsent.crew[0].count = 3;
      const { useStore, r } = await loadToday({ dailyLog: unsent, timeZone: 'Asia/Kolkata', online: true });
      expect(r.queryByTestId('today-overdue')).toBeNull();
      // 00:00:05 on the 30th — no timer has fired; an unrelated store update re-renders
      vi.setSystemTime(new Date('2026-09-29T18:30:05Z'));
      act(() => useStore.setState({ online: false }));
      expect(r.getByTestId('engineer-today').textContent).toContain('30 September');
      expect(r.getByTestId('today-overdue').textContent).toContain('29 September');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('review round 10 — a send on its way freezes the log, and a stalled one can be retried', () => {
  it('the Site screen freezes crew, photos and materials while a send is on its way', async () => {
    const ready = log({ checkedIn: true, progress: 2 });
    await loadToday({ dailyLog: ready, outbox: [{ t: 'submitDailyLog', log: { checkedIn: true, checkinTime: null, progress: 2, crew: ready.crew }, idempotencyKey: 'k' }], online: false });
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    const trade = ready.crew[0].trade;
    expect((r.getAllByLabelText(`Add ${trade}`).at(-1) as HTMLButtonElement).disabled).toBe(true);
    expect((r.getAllByLabelText(`Remove ${trade}`).at(-1) as HTMLButtonElement).disabled).toBe(true);
    expect((r.getAllByTestId('add-progress-photo').at(-1) as HTMLButtonElement).disabled).toBe(true);
    // the send carries the check-in too, so checking out waits as well
    expect((r.getAllByTestId('check-out').at(-1) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the Site screen’s log stays editable when nothing is on its way', async () => {
    const ready = log({ checkedIn: true, progress: 2 });
    await loadToday({ dailyLog: ready, outbox: [] });
    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const r = render(<DailyLogScreen />);
    expect((r.getAllByLabelText(`Add ${ready.crew[0].trade}`).at(-1) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a queued send that stalled online offers Try again, which replays the queued op', async () => {
    const ready = log({ checkedIn: true, progress: 2 });
    ready.crew[0].count = 3;
    const queued = { t: 'submitDailyLog' as const, log: { checkedIn: true, checkinTime: null, progress: 2, crew: ready.crew }, idempotencyKey: 'k1' };
    const { useStore, r } = await loadToday({ dailyLog: ready, outbox: [queued], online: true });
    const flush = vi.fn().mockResolvedValue({ ran: true });
    act(() => useStore.setState({ flushOutbox: flush }));
    fireEvent.click(r.getByTestId('today-retry-send'));
    expect(flush).toHaveBeenCalledTimes(1);
    // the queued op keeps its key — nothing new is queued
    expect(useStore.getState().outbox).toEqual([queued]);
  });

  it('offline, the queued send says it is saved on the phone instead of offering a retry', async () => {
    const ready = log({ checkedIn: true, progress: 2 });
    const { r } = await loadToday({ dailyLog: ready, outbox: [{ t: 'submitDailyLog', log: { checkedIn: true, checkinTime: null, progress: 2, crew: ready.crew }, idempotencyKey: 'k' }], online: false });
    expect(r.queryByTestId('today-retry-send')).toBeNull();
    expect(r.getByText(L.savedOffline.en)).toBeTruthy();
  });
});
