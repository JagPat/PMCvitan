import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
afterEach(cleanup);

describe('selectProjectProgress', () => {
  it('derives the percentage from accepted activities, never the stored milestonePct', () => {
    useStore.setState((st) => {
      st.milestonePct = 72;
      st.activities = st.activities.slice(0, 4).map((a, i) => ({ ...a, status: i === 0 ? 'done' : i === 1 ? 'awaiting-signoff' : 'in-progress' }));
    });
    // one of four accepted — awaiting sign-off is not done
    expect(selectProjectProgress(s())).toEqual({ pct: 25, done: 1, total: 4, derived: true });
  });

  it('with no activities planned, shows the recorded figure and says it is not derived', () => {
    useStore.setState((st) => { st.activities = []; st.milestonePct = 0; });
    expect(selectProjectProgress(s())).toEqual({ pct: 0, done: 0, total: 0, derived: false });
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

  it('names the two photo figures apart and computes the on-record total in demo mode too', () => {
    const r = render(<DashboardScreen />);
    expect(r.getByText("PHOTOS IN TODAY'S LOG")).toBeTruthy();
    expect(r.getByText('SITE PHOTOS ON RECORD')).toBeTruthy();
    expect(r.queryByText('PROGRESS PHOTOS THIS WEEK')).toBeNull();
    expect(r.getByTestId('tile-photos-value').textContent).toBe(String(s().photos.length));
    expect(r.queryByText('Across 6 zones')).toBeNull();
  });
});
