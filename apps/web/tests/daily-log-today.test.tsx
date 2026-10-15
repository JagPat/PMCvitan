import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { DailyLog, Lang } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #482 (QA 15 Oct, item 1) — the Daily Site Log showed 14 Oct "Submitted" while the Today card and the PMC
 * brief said there was no log today. Every screen now judges "today" on the project's civil day (IST for
 * Asia/Kolkata): a log sent on an earlier day is not today's, so the Daily Site Log says "No site log yet
 * today" and offers to start it, the same answer the Today card gives at the same moment.
 */

const log = (over: Partial<DailyLog> = {}): DailyLog => ({
  id: 'log-14', date: '14 Oct 2026', logDate: '2026-10-14', checkedIn: true, checkinTime: '09:00', submitted: true, progress: 2,
  crew: [{ trade: 'Mason', count: 2 }], materials: [], photos: [],
  ...over,
} as DailyLog);

async function screen(now: string, over: Record<string, unknown>, lang: Lang = 'en') {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.stubEnv('VITE_DAILYLOG_READ', 'snapshot');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'qa', projectLoadState: 'ready', role: 'engineer', short: 'QA Test Project', lang, timeZone: 'Asia/Kolkata',
    ...over,
  });
  const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
  const { todayPath } = await import('@/lib/engineerToday');
  const { todayCivil } = await import('@/lib/civilDate');
  const r = render(<DailyLogScreen />);
  const s = useStore.getState();
  return { r, todayCard: todayPath(s.dailyLog, 0, todayCivil(s.timeZone)) };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('#482 the Daily Site Log and the Today card agree on today (IST)', () => {
  it('a log sent yesterday is not today’s: no log yet today, start offered (the QA case, 06:30 IST)', async () => {
    const { r, todayCard } = await screen('2026-10-15T01:00:00Z', { dailyLog: log() });
    expect(r.queryByTestId('daily-log-no-today')).not.toBeNull();
    expect(r.container.textContent).toContain('No site log yet today');
    expect(r.container.textContent).toContain('The last log (14 Oct 2026) was sent.');
    expect(r.container.textContent).not.toContain('Submitted');
    expect(r.getByTestId('start-new-day').textContent).toContain("Start today's log");
    expect(todayCard.action).toBe('start');
  });

  it('IST, not UTC: at 00:30 IST on the 15th (still the 14th in UTC) the 14th’s log is already yesterday’s', async () => {
    const { r, todayCard } = await screen('2026-10-14T19:00:00Z', { dailyLog: log() });
    expect(r.queryByTestId('daily-log-no-today')).not.toBeNull();
    expect(todayCard.action).toBe('start');
  });

  it('the same log on its own day is today’s, shown as sent', async () => {
    const { r, todayCard } = await screen('2026-10-14T17:00:00Z', { dailyLog: log() }); // 22:30 IST on the 14th
    expect(r.queryByTestId('daily-log-no-today')).toBeNull();
    expect(r.container.textContent).toContain('Submitted');
    expect(todayCard.action).toBe('done');
  });

  it('an earlier day’s log never sent stays on screen to finish, as on the Today card', async () => {
    const { r, todayCard } = await screen('2026-10-15T01:00:00Z', { dailyLog: log({ submitted: false }) });
    expect(r.queryByTestId('daily-log-no-today')).toBeNull();
    expect(todayCard.overdue).toBe('2026-10-14');
  });

  it('a role that cannot start a log sees the state without the button', async () => {
    const { r } = await screen('2026-10-15T01:00:00Z', { dailyLog: log(), role: 'client' });
    expect(r.queryByTestId('daily-log-no-today')).not.toBeNull();
    expect(r.queryByTestId('start-new-day')).toBeNull();
  });

  for (const lang of ['hi', 'gu'] as const) {
    it(`${lang}: the no-log-today state has no leftover English`, async () => {
      const { r } = await screen('2026-10-15T01:00:00Z', { dailyLog: log() }, lang);
      expect(r.queryByTestId('daily-log-no-today')).not.toBeNull();
      expect(leftoverEnglish(r.container, ['QA Test Project', 'PMC'])).toEqual([]);
    });
  }
});
