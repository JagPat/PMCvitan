import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { DailyLog, Role } from '@vitan/shared';

/**
 * #482 (QA 15 Oct, item 7) — on the Daily Site Log the PMC reviews the site's day, the engineer runs it: the
 * PMC sees no Check in, Check out, Start new day or Start today's log, and keeps adding a site photo. The
 * engineer's buttons are unchanged.
 */

const log = (over: Partial<DailyLog> = {}): DailyLog => ({
  id: 'log-15', date: '15 Oct 2026', logDate: '2026-10-15', checkedIn: false, checkinTime: null, submitted: false, progress: 0,
  crew: [{ trade: 'Mason', count: 2 }], materials: [], photos: [],
  ...over,
} as DailyLog);

async function screen(role: Role, dailyLog: DailyLog | null) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T06:00:00Z')); // 11:30 IST on the 15th
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.stubEnv('VITE_DAILYLOG_READ', 'snapshot');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'qa', projectLoadState: 'ready', role, short: 'QA Test Project', lang: 'en', timeZone: 'Asia/Kolkata', dailyLog,
  });
  const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
  return render(<DailyLogScreen />);
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const DAY_BUTTONS = ['check-in', 'check-out', 'start-new-day'];
const shown = (r: ReturnType<typeof render>) => DAY_BUTTONS.filter((id) => r.queryByTestId(id));

describe('#482 the PMC’s Daily Site Log has no day-running buttons', () => {
  it('before check-in: no Check in for the PMC, Add photo stays', async () => {
    const r = await screen('pmc', log());
    expect(shown(r)).toEqual([]);
    expect(r.container.textContent).not.toContain('Check in at site');
    expect(r.getByText('Add')).toBeTruthy();
  });

  it('checked in: the PMC sees who checked in, without Check out', async () => {
    const r = await screen('pmc', log({ checkedIn: true, checkinTime: '09:00' }));
    expect(shown(r)).toEqual([]);
    expect(r.container.textContent).toContain('Checked in');
  });

  it('a sent log of today: no Start new day for the PMC', async () => {
    const r = await screen('pmc', log({ checkedIn: true, checkinTime: '09:00', submitted: true }));
    expect(shown(r)).toEqual([]);
  });

  it('no log today, or none at all: no Start today’s log for the PMC', async () => {
    expect(shown(await screen('pmc', log({ logDate: '2026-10-14', date: '14 Oct 2026', submitted: true })))).toEqual([]);
    cleanup();
    expect(shown(await screen('pmc', null))).toEqual([]);
  });

  it('the engineer keeps every button', async () => {
    expect(shown(await screen('engineer', log()))).toEqual(['check-in']);
    cleanup();
    expect(shown(await screen('engineer', log({ checkedIn: true, checkinTime: '09:00' })))).toEqual(['check-out']);
    cleanup();
    expect(shown(await screen('engineer', log({ checkedIn: true, checkinTime: '09:00', submitted: true })))).toEqual(['check-out', 'start-new-day']);
    cleanup();
    expect(shown(await screen('engineer', null))).toEqual(['start-new-day']);
  });
});
