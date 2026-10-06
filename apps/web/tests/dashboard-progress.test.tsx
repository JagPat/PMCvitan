import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { selectProjectProgress } from '@/store/selectors';
import { DashboardScreen } from '@/screens/DashboardScreen';

/**
 * B7 (F-12, F-13) — progress you can trust. The overall figure and the phase dots are derived from
 * the activities and move the moment work is accepted; the photo figures are named apart (today's
 * log vs everything on record) and the photos-on-record tile is computed in every mode.
 */
const s = () => useStore.getState();

beforeEach(() => useStore.setState(getInitialState()));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe('selectProjectProgress', () => {
  it('derives the percentage from accepted activities, never the stored milestonePct', () => {
    useStore.setState((st) => {
      st.milestonePct = 72;
      st.activities = st.activities.slice(0, 4).map((a, i) => ({ ...a, status: i === 0 ? 'done' : i === 1 ? 'awaiting-signoff' : 'in-progress' }));
    });
    // one of four accepted — awaiting sign-off is not done
    expect(selectProjectProgress(s())).toEqual({ pct: 25, done: 1, total: 4, basis: 'derived' });
  });

  it('with no activities planned, shows the recorded figure and says it is not derived', () => {
    useStore.setState((st) => { st.activities = []; st.milestonePct = 0; });
    expect(selectProjectProgress(s())).toEqual({ pct: 0, done: 0, total: 0, basis: 'recorded' });
  });

  it('module-owned activities that FAILED to load are not "no plan": progress is unavailable, never the recorded figure (Codex 4180841684)', () => {
    vi.stubEnv('VITE_ACTIVITIES_READ', 'moduleQuery');
    useStore.setState((st) => { st.activities = []; st.milestonePct = 40; st.activitiesLoad = 'error'; });
    expect(selectProjectProgress(s())).toEqual({ pct: null, done: 0, total: 0, basis: 'unavailable' });
    useStore.setState((st) => { st.activitiesLoad = 'loading'; });
    expect(selectProjectProgress(s())).toEqual({ pct: null, done: 0, total: 0, basis: 'loading' });
    // a read that ANSWERED with no activities is a real empty plan
    useStore.setState((st) => { st.activitiesLoad = 'ready'; });
    expect(selectProjectProgress(s())).toEqual({ pct: 40, done: 0, total: 0, basis: 'recorded' });
  });

  it('a failed read with last-good activities still derives from them, as the Schedule shows them', () => {
    vi.stubEnv('VITE_ACTIVITIES_READ', 'moduleQuery');
    useStore.setState((st) => {
      st.activities = st.activities.slice(0, 2).map((a, i) => ({ ...a, status: i === 0 ? 'done' : 'in-progress' }));
      st.activitiesLoad = 'error';
    });
    expect(selectProjectProgress(s())).toEqual({ pct: 50, done: 1, total: 2, basis: 'derived' });
  });
});

describe('Dashboard progress — an unavailable activity read', () => {
  it('says the activities could not be loaded, and shows no percentage and no "no activities planned" (Codex 4180841684)', () => {
    vi.stubEnv('VITE_ACTIVITIES_READ', 'moduleQuery');
    useStore.setState((st) => { st.activities = []; st.milestonePct = 40; st.activitiesLoad = 'error'; });
    const r = render(<DashboardScreen />);
    expect(r.getByTestId('dash-progress-pct').textContent).toBe('—');
    expect(r.getByTestId('dash-progress-basis').textContent).toMatch(/could not be loaded/);
    expect(r.getByTestId('dash-progress-basis').textContent).not.toMatch(/No activities planned/);
  });
});

describe('Dashboard progress', () => {
  it('the headline and a phase dot move when its last activity is accepted', () => {
    const r = render(<DashboardScreen />);
    const before = s().activities;
    const total = before.length;
    const doneBefore = before.filter((a) => a.status === 'done').length;
    expect(r.getByTestId('dash-progress-pct').textContent).toBe(`${Math.round((doneBefore / total) * 100)}% complete`);
    expect(r.getByTestId('dash-progress-basis').textContent).toBe(`${doneBefore} of ${total} activities accepted as done`);

    // PH-services holds one done and one blocked activity: started, not done
    expect(r.getByTestId('milestone-PH-services').getAttribute('data-state')).toBe('started');
    expect(r.getByTestId('milestone-PH-services').getAttribute('aria-label')).toBe('Services & Waterproofing: 1 of 2 activities done');

    act(() => {
      useStore.setState((st) => {
        for (const a of st.activities) if (a.phaseId === 'PH-services') a.status = 'done';
      });
    });
    const doneAfter = s().activities.filter((a) => a.status === 'done').length;
    expect(doneAfter).toBeGreaterThan(doneBefore);
    expect(r.getByTestId('dash-progress-pct').textContent).toBe(`${Math.round((doneAfter / total) * 100)}% complete`);
    expect(r.getByTestId('milestone-PH-services').getAttribute('data-state')).toBe('done');
  });

  it('a phase whose only started work is now blocked still reads as started, not not-started', () => {
    // PH-services: ACT-22 done + ACT-28 blocked WITH an actual start. Un-done ACT-22 so the blocked,
    // already-begun ACT-28 is the only evidence of work in the phase.
    act(() => {
      useStore.setState((st) => {
        for (const a of st.activities) if (a.id === 'ACT-22') { a.status = 'not-started'; a.as = null; a.ae = null; }
      });
    });
    const r = render(<DashboardScreen />);
    expect(s().activities.find((a) => a.id === 'ACT-28')).toMatchObject({ status: 'blocked', as: 24 });
    expect(r.getByTestId('milestone-PH-services').getAttribute('data-state')).toBe('started');
  });

  it('names the two photo figures apart and computes the on-record total in demo mode too', () => {
    const r = render(<DashboardScreen />);
    expect(r.getByText('PROGRESS PHOTOS · DAILY LOG')).toBeTruthy();
    expect(r.queryByText("PHOTOS IN TODAY'S LOG")).toBeNull(); // the log's count is not a daily media count
    expect(r.getByText('SITE PHOTOS ON RECORD')).toBeTruthy();
    expect(r.queryByText('PROGRESS PHOTOS THIS WEEK')).toBeNull();
    expect(r.getByTestId('tile-photos-value').textContent).toBe(String(s().photos.length));
    expect(r.queryByText('Across 6 zones')).toBeNull();
  });
});
