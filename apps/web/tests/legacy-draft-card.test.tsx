import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { SEED_DAILY_LOG, engineerLegacyDraftLabels as L, type DailyLog } from '@vitan/shared';
import { todayCivil } from '@/lib/civilDate';
import type { DailyLogDraft } from '@/store/dailyLogDraft';

/**
 * Owner ruling (#692): unsent work saved before the log carried its id is kept aside, never added to a
 * log on its own. Today shows it; the engineer adds it to this log (same unsent day only) or discards
 * it, and a discard asks once more.
 */

const TODAY = todayCivil(null);

afterEach(() => {
  cleanup();
  vi.resetModules();
});

const log = (over: Partial<DailyLog> = {}): DailyLog => ({
  ...structuredClone(SEED_DAILY_LOG),
  id: 'log-b', crew: SEED_DAILY_LOG.crew.map((c) => ({ ...c, count: 0 })), progress: 0, photos: [],
  logDate: TODAY, checkedIn: false, checkinTime: null, submitted: false, ...over,
});
const firstTrade = SEED_DAILY_LOG.crew[0]!.trade;
const kept = (over: Partial<DailyLogDraft> = {}): DailyLogDraft => ({
  projectId: 'villa-b', logKey: `civil:${TODAY}`,
  checkIn: { checkedIn: true, checkinTime: '9:05 AM' }, crew: { [firstTrade]: 4 }, photosAdded: 1, ...over,
});

async function loadToday(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', role: 'engineer', lang: 'en',
    short: 'Villa Bodakdev', screen: 'inbox', dailyLog: log(), legacyDailyLogDraft: kept(), ...overrides,
  });
  const { InboxScreen } = await import('@/screens/InboxScreen');
  return { useStore, r: render(<InboxScreen />) };
}

describe('#692 — Today shows kept-aside work and adds it only on confirmation', () => {
  it('shows what it holds and the day it was for; nothing is on the log until the engineer adds it', async () => {
    const { useStore, r } = await loadToday();
    const card = r.getByTestId('legacy-draft');
    expect(card.textContent).toContain(L.title.en);
    expect(r.getByTestId('legacy-draft-summary').textContent).toBe(`Checked in 9:05 AM · ${firstTrade} 4 · 1 photo`);
    expect(useStore.getState().dailyLog).toMatchObject({ checkedIn: false, progress: 0 });
    fireEvent.click(r.getByTestId('legacy-draft-add'));
    expect(r.queryByTestId('legacy-draft')).toBeNull();
    expect(useStore.getState().dailyLog).toMatchObject({ checkedIn: true, checkinTime: '9:05 AM', progress: 1 });
    expect(useStore.getState().dailyLog?.crew[0]?.count).toBe(4);
    expect(useStore.getState().dailyLogDraft).toMatchObject({ logId: 'log-b' });
  });

  it('a discard asks once more, and "Keep it" keeps it', async () => {
    const { useStore, r } = await loadToday();
    fireEvent.click(r.getByTestId('legacy-draft-discard'));
    expect(useStore.getState().legacyDailyLogDraft).not.toBeNull();
    fireEvent.click(r.getByTestId('legacy-draft-keep'));
    expect(r.getByTestId('legacy-draft-add')).toBeTruthy();
    fireEvent.click(r.getByTestId('legacy-draft-discard'));
    fireEvent.click(r.getByTestId('legacy-draft-discard-yes'));
    expect(r.queryByTestId('legacy-draft')).toBeNull();
    expect(useStore.getState().legacyDailyLogDraft).toBeNull();
    expect(useStore.getState().dailyLog).toMatchObject({ checkedIn: false, progress: 0 });
  });

  it('work saved for another day can be read and discarded, never added', async () => {
    const { r } = await loadToday({ legacyDailyLogDraft: kept({ logKey: 'civil:2026-01-02' }) });
    expect(r.getByTestId('legacy-draft').textContent).toContain(L.otherDay.en);
    expect(r.queryByTestId('legacy-draft-add')).toBeNull();
    expect(r.getByTestId('legacy-draft-discard')).toBeTruthy();
  });

  it('nothing kept aside, no card', async () => {
    const { r } = await loadToday({ legacyDailyLogDraft: null });
    expect(r.queryByTestId('legacy-draft')).toBeNull();
  });
});
