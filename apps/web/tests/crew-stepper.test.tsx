import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { SEED_DAILY_LOG, engineerCrewLabels as C, engineerTodayLabels as L, type DailyLog } from '@vitan/shared';
import { todayCivil } from '@/lib/civilDate';

const TODAY = todayCivil(null);

/**
 * U1 (design review, Engineer · Log board): Today's crew step asked one trade at a time — a large
 * count with one-less / one-more, "Nobody today" and Next. Presentation only: every tap is the Site
 * screen's own `crewStep` on the open log, so both views hold the same counts.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const TRADES = SEED_DAILY_LOG.crew.map((c) => c.trade); // five trades

const log = (over: Partial<DailyLog> = {}): DailyLog => ({
  ...structuredClone(SEED_DAILY_LOG),
  crew: SEED_DAILY_LOG.crew.map((c) => ({ ...c, count: 0 })),
  progress: 0,
  photos: [],
  logDate: TODAY,
  checkedIn: true,
  ...over,
});

async function loadToday(overrides: Record<string, unknown> = {}) {
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
    dailyLog: log(),
    ...overrides,
  });
  const { InboxScreen } = await import('@/screens/InboxScreen');
  return { useStore, r: render(<InboxScreen />) };
}

const counts = (useStore: { getState: () => { dailyLog: DailyLog | null } }) => useStore.getState().dailyLog!.crew.map((c) => c.count);

describe('U1 — the crew step, one trade at a time', () => {
  it("Today's crew action opens the questions in place, not the Site screen", async () => {
    const { useStore, r } = await loadToday();
    expect(r.getByTestId('today-now').dataset.action).toBe('crew');
    fireEvent.click(r.getByTestId('today-action'));
    expect(r.getByTestId('crew-stepper')).toBeTruthy();
    expect(r.queryByTestId('engineer-today')).toBeNull();
    expect(useStore.getState().screen).toBe('inbox');
  });

  it("the path's crew step opens the questions too; the photos step still opens the Site screen", async () => {
    const { useStore, r } = await loadToday();
    fireEvent.click(r.getByTestId('today-step-crew'));
    expect(r.getByTestId('crew-stepper')).toBeTruthy();
    fireEvent.click(r.getByTestId('crew-back'));
    fireEvent.click(r.getByTestId('today-step-photos'));
    expect(useStore.getState().screen).toBe('daily-log');
  });

  it('asks about one trade per screen, with its position and the trades still to come', async () => {
    const { r } = await loadToday();
    fireEvent.click(r.getByTestId('today-action'));
    expect(r.getByTestId('crew-question').textContent).toBe(`${TRADES[0]}: how many came today?`);
    expect(r.getByTestId('crew-position').textContent).toBe(`1 / ${TRADES.length}`);
    expect(r.getByRole('img', { name: `Question 1 of ${TRADES.length}` })).toBeTruthy();
    // the next three are named, the rest counted
    const ahead = r.getByTestId('crew-ahead').textContent!;
    expect(ahead).toContain(`${C.laterAsk.en}: ${TRADES.slice(1, 4).join(', ')}`);
    expect(ahead).toContain('1 more');
    // the question takes focus, so a screen reader announces it
    expect(document.activeElement).toBe(r.getByTestId('crew-question'));
  });

  it("one more / one less change this trade's count on the log — the Site screen's own counts", async () => {
    const { useStore, r } = await loadToday();
    fireEvent.click(r.getByTestId('today-action'));
    const less = r.getByTestId('crew-less') as HTMLButtonElement;
    expect(less.disabled).toBe(true); // nothing to take away from zero
    fireEvent.click(r.getByTestId('crew-more'));
    fireEvent.click(r.getByTestId('crew-more'));
    fireEvent.click(r.getByTestId('crew-more'));
    expect(r.getByTestId('crew-count').textContent).toBe('3');
    fireEvent.click(r.getByTestId('crew-less'));
    expect(counts(useStore)).toEqual([2, 0, 0, 0, 0]);
    // kept in the device's pending draft, as the Site screen's stepper does, so a reconcile keeps it
    expect(useStore.getState().dailyLogDraft?.crew?.[TRADES[0]]).toBe(2);

    const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
    const site = render(<DailyLogScreen />);
    expect(site.getByTestId('crew-total').textContent).toBe('2 workers');
  });

  it('Next moves to the next trade; the last one finishes back on Today with the crew step done', async () => {
    const { useStore, r } = await loadToday();
    fireEvent.click(r.getByTestId('today-action'));
    fireEvent.click(r.getByTestId('crew-more'));
    for (let i = 1; i < TRADES.length; i++) {
      fireEvent.click(r.getByTestId('crew-next'));
      expect(r.getByTestId('crew-stepper').dataset.trade).toBe(TRADES[i]);
      expect(r.getByTestId('crew-position').textContent).toBe(`${i + 1} / ${TRADES.length}`);
    }
    expect(r.queryByTestId('crew-ahead')).toBeNull();
    expect(r.getByTestId('crew-next').textContent).toContain(C.finish.en);
    fireEvent.click(r.getByTestId('crew-next'));
    expect(r.queryByTestId('crew-stepper')).toBeNull();
    expect(r.getByTestId('today-step-crew').dataset.state).toBe('done');
    expect(r.getByTestId('today-now').dataset.action).toBe('photos');
    expect(counts(useStore)).toEqual([1, 0, 0, 0, 0]);
  });

  it('"Nobody today" records zero for this trade and moves on', async () => {
    const counted = log();
    counted.crew[0].count = 4;
    const { useStore, r } = await loadToday({ dailyLog: counted });
    fireEvent.click(r.getByTestId('today-step-crew'));
    fireEvent.click(r.getByTestId('crew-nobody'));
    expect(counts(useStore)[0]).toBe(0);
    expect(r.getByTestId('crew-stepper').dataset.trade).toBe(TRADES[1]);
  });

  it('Back returns to Today and changes nothing', async () => {
    const { useStore, r } = await loadToday();
    fireEvent.click(r.getByTestId('today-action'));
    fireEvent.click(r.getByTestId('crew-back'));
    expect(r.getByTestId('engineer-today')).toBeTruthy();
    expect(counts(useStore)).toEqual([0, 0, 0, 0, 0]);
  });

  it('a log with no trades yet keeps the crew step on the Site screen', async () => {
    const { useStore, r } = await loadToday({ dailyLog: log({ crew: [] }) });
    fireEvent.click(r.getByTestId('today-action'));
    expect(r.queryByTestId('crew-stepper')).toBeNull();
    expect(useStore.getState().screen).toBe('daily-log');
  });

  it('a send on its way closes the questions: the log it carries is frozen', async () => {
    const { useStore, r } = await loadToday();
    fireEvent.click(r.getByTestId('today-action'));
    expect(r.getByTestId('crew-stepper')).toBeTruthy();
    const ready = useStore.getState().dailyLog!;
    act(() =>
      useStore.setState({
        online: false,
        outbox: [{ t: 'submitDailyLog', log: { checkedIn: true, checkinTime: null, progress: 0, crew: ready.crew }, idempotencyKey: 'k' }],
      }),
    );
    expect(r.queryByTestId('crew-stepper')).toBeNull();
    expect(r.getByTestId('today-now').dataset.action).toBe('pending-send');
    expect(r.getByText(L.pendingSend.en)).toBeTruthy();
  });

  it('a project switch or a replaced log closes the questions: they never carry over to another log', async () => {
    const { useStore, r } = await loadToday();
    fireEvent.click(r.getByTestId('today-action'));
    act(() => useStore.setState({ activeProjectId: 'villa-c' }));
    expect(r.queryByTestId('crew-stepper')).toBeNull();
    expect(r.getByTestId('engineer-today')).toBeTruthy();

    fireEvent.click(r.getByTestId('today-action'));
    expect(r.getByTestId('crew-stepper')).toBeTruthy();
    act(() => useStore.setState({ dailyLog: log({ logDate: '2026-09-28', date: '28 Sep 2026' }) }));
    expect(r.queryByTestId('crew-stepper')).toBeNull();
  });

  it("an earlier day's unsent log is asked about without calling it today's", async () => {
    const { r } = await loadToday({ dailyLog: log({ logDate: '2026-09-28' }) });
    fireEvent.click(r.getByTestId('today-action'));
    expect(r.getByTestId('crew-question').textContent).toBe(`${TRADES[0]}: how many came?`);
  });

  it("asks in the engineer's language", async () => {
    const { r } = await loadToday({ lang: 'gu' });
    fireEvent.click(r.getByTestId('today-action'));
    expect(r.getByTestId('crew-question').textContent).toBe(`${TRADES[0]}: આજે કેટલા આવ્યા?`);
    expect(r.getByTestId('crew-nobody').textContent).toBe(C.nobody.gu);
    expect(r.getByRole('button', { name: `${C.more.gu}: ${TRADES[0]}` })).toBeTruthy();
  });
});
