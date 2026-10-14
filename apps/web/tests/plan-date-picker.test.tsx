import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { ScheduleScreen } from '@/screens/ScheduleScreen';
import { DatePicker, pickerLabel, inclusiveDays } from '@/components';

/**
 * #827 (approved mockup "PlanDates") — the PMC picks a plan's start and end on a calendar instead of
 * typing day numbers. The form sends the real dates and the matching day offsets from the schedule's
 * anchor; a project with no anchor keeps the day-number boxes.
 */


beforeEach(() => {
  useStore.setState(getInitialState());
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T06:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the calendar picker', () => {
  it('shows the chosen day, opens a Monday-first month and picks a day', () => {
    const onChange = vi.fn();
    const r = render(<DatePicker label="Starts" value="2026-10-20" onChange={onChange} min="2026-10-05" today="2026-10-13" testId="p" />);
    expect(r.getByTestId('p').textContent).toContain('Tue 20 Oct 2026');
    fireEvent.click(r.getByTestId('p'));
    // October 2026 starts on a Thursday: three blanks, then the 1st
    expect(r.getByTestId('p-day-2026-10-01')).toBeTruthy();
    expect((r.getByTestId('p-day-2026-10-04') as HTMLButtonElement).disabled).toBe(true); // before `min`
    expect(r.getByTestId('p-day-2026-10-20').getAttribute('aria-pressed')).toBe('true');
    expect(r.getByTestId('p-day-2026-10-13').getAttribute('aria-current')).toBe('date');
    expect(r.getByRole('button', { name: '25 October 2026' })).toBeTruthy();
    fireEvent.click(r.getByTestId('p-day-2026-10-25'));
    expect(onChange).toHaveBeenCalledWith('2026-10-25');
    expect(r.queryByTestId('p-calendar')).toBeNull();
  });

  it('moves between months, and not back past `min`', () => {
    const r = render(<DatePicker label="Ends" value="2026-12-31" onChange={() => {}} min="2026-12-02" testId="p" />);
    fireEvent.click(r.getByTestId('p'));
    expect((r.getByRole('button', { name: 'Previous month' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(r.getByRole('button', { name: 'Next month' }));
    expect(r.getByTestId('p-day-2027-01-31')).toBeTruthy();
    expect(r.queryByTestId('p-day-2026-12-31')).toBeNull();
  });

  it('labels and spans', () => {
    expect(pickerLabel('2026-02-28')).toBe('Sat 28 Feb 2026');
    expect(inclusiveDays('2026-10-20', '2026-10-25')).toBe(6);
    expect(inclusiveDays('2026-10-20', '2026-10-20')).toBe(1);
  });
});

describe('the Plan activity form', () => {
  const planWith = (createActivity: ReturnType<typeof vi.fn>, anchor: string | null) => {
    useStore.setState({ role: 'pmc', scheduleStartDate: anchor, timeZone: 'Asia/Kolkata', createActivity } as never);
    const r = render(<ScheduleScreen />);
    fireEvent.click(r.getByTestId('plan-activity'));
    fireEvent.change(r.getByTestId('act-name'), { target: { value: 'Kitchen tiling' } });
    return r;
  };

  it('picks dates on the calendar and sends them with the matching day offsets', () => {
    const createActivity = vi.fn();
    const r = planWith(createActivity, '2026-10-01');
    // a new plan starts today and runs a week
    expect(r.getByTestId('act-start').textContent).toContain('Tue 13 Oct 2026');
    expect(r.getByTestId('act-end').textContent).toContain('Tue 20 Oct 2026');
    fireEvent.click(r.getByTestId('act-start'));
    fireEvent.click(r.getByTestId('act-start-day-2026-10-20'));
    fireEvent.click(r.getByTestId('act-end'));
    fireEvent.click(r.getByTestId('act-end-day-2026-10-25'));
    expect(r.getByTestId('act-span').textContent).toBe('6 days');
    fireEvent.click(r.getByTestId('save-activity'));
    expect(createActivity).toHaveBeenCalledTimes(1);
    expect(createActivity.mock.calls[0][0]).toMatchObject({
      name: 'Kitchen tiling', plannedStartDate: '2026-10-20', plannedEndDate: '2026-10-25', plannedStart: 19, plannedEnd: 24,
    });
  });

  it('moving the start past the end moves the end with it, and the end cannot precede the start', () => {
    const createActivity = vi.fn();
    const r = planWith(createActivity, '2026-10-01');
    fireEvent.click(r.getByTestId('act-start'));
    fireEvent.click(r.getByTestId('act-start-day-2026-10-28'));
    expect(r.getByTestId('act-end').textContent).toContain('Wed 28 Oct 2026');
    fireEvent.click(r.getByTestId('act-end'));
    expect((r.getByTestId('act-end-day-2026-10-27') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a project with no schedule anchor keeps the day-number boxes', () => {
    const createActivity = vi.fn();
    const r = planWith(createActivity, null);
    expect(r.queryByTestId('act-start')).toBeNull();
    expect(r.getByText(/Plan start \(day\)/)).toBeTruthy();
    fireEvent.click(r.getByTestId('save-activity'));
    expect(createActivity.mock.calls[0][0]).not.toHaveProperty('plannedStartDate');
    expect(createActivity.mock.calls[0][0]).toMatchObject({ plannedStart: 0, plannedEnd: 7 });
  });
});
