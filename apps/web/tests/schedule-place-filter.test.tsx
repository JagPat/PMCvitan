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
