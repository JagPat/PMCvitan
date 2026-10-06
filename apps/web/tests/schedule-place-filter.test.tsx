import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { scheduleStatusCounts } from '@/store/selectors';
import { ScheduleScreen } from '@/screens/ScheduleScreen';

/**
 * B8 — the Schedule's RUNNING / DONE / BLOCKED cards describe the rows listed. With a place filter on, that is
 * the place and everything inside it, never the whole project (Codex 4180886620).
 */
const s = () => useStore.getState();
const cards = (r: ReturnType<typeof render>) => ({
  running: r.getByTestId('sch-running').textContent,
  done: r.getByTestId('sch-done').textContent,
  blocked: r.getByTestId('sch-blocked').textContent,
});

beforeEach(() => useStore.setState(getInitialState()));
afterEach(cleanup);

describe('Schedule summary cards under a place filter', () => {
  it('count only the filtered place and its subtree, and return to the project when cleared', () => {
    const project = scheduleStatusCounts(s().activities);
    // the demo project has accepted and blocked work, none of it on the Ground Floor
    expect(project.doneWeek).toBeGreaterThan(0);
    expect(project.blocked).toBeGreaterThan(0);
    const r = render(<ScheduleScreen />);
    expect(cards(r)).toEqual({ running: String(project.inProgress), done: String(project.doneWeek), blocked: String(project.blocked) });

    fireEvent.change(r.getByTestId('sched-place-filter'), { target: { value: 'z-gf' } });
    expect(cards(r)).toEqual({ running: '0', done: '0', blocked: '0' }); // Ground Floor: two not-started activities

    fireEvent.change(r.getByTestId('sched-place-filter'), { target: { value: 'z-terrace' } });
    expect(cards(r).blocked).toBe('1'); // Terrace holds the blocked activity
    expect(cards(r).done).toBe('0');

    fireEvent.change(r.getByTestId('sched-place-filter'), { target: { value: '' } });
    expect(cards(r)).toEqual({ running: String(project.inProgress), done: String(project.doneWeek), blocked: String(project.blocked) });
  });
});

describe('the place filter\'s options', () => {
  it('list each place once and terminate on malformed parent data (shadow review on 7f71670)', () => {
    // a duplicated id filed under itself: a walk without a visited set would recurse forever
    useStore.setState((st) => {
      st.nodes = [
        { id: 'z-x', parentId: null, name: 'Zone X', kind: 'zone', order: 0 },
        { id: 'z-x', parentId: 'z-x', name: 'Zone X again', kind: 'room', order: 0 },
        { id: 'r-y', parentId: 'z-x', name: 'Room Y', kind: 'room', order: 1 },
      ];
    });
    const r = render(<ScheduleScreen />);
    const options = Array.from((r.getByTestId('sched-place-filter') as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);
    expect(options).toEqual(['z-x', 'r-y']);
  });
});
