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

  it('crew and photos open the Site screen, where they are recorded', async () => {
    const { useStore, r } = await loadToday({ dailyLog: log({ checkedIn: true }) });
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
    for (const cls of ['step', 'nowAction']) {
      const m = css.match(new RegExp(`\\.${cls} \\{[^}]*min-height: (\\d+)px`));
      expect(Number(m?.[1])).toBeGreaterThanOrEqual(44);
    }
    expect(r.getAllByRole('button').length).toBeGreaterThanOrEqual(5);
  });
});
