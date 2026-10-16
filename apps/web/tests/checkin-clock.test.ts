import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkinClock } from '@/lib/civilDate';
import { useStore, getInitialState } from '@/store/store';

/**
 * #482 Board decision D13 (16 Oct 2026) — every sent daily log carried the check-in time "8:12 AM",
 * whatever the real time was, because the store hard-coded it. The check-in now records the tap's own
 * time on the project's clock, and the send carries that time unchanged.
 */
const s = () => useStore.getState();

describe('checkinClock — the time of the tap, on the project clock', () => {
  it('formats the instant in the project timezone, with a plain space before AM/PM', () => {
    // 03:30 UTC is 9:00 AM in India
    expect(checkinClock('Asia/Kolkata', new Date('2026-10-16T03:30:00Z'))).toBe('9:00 AM');
    expect(checkinClock('Asia/Kolkata', new Date('2026-10-16T12:47:00Z'))).toBe('6:17 PM');
  });

  it('falls back to the browser clock when the zone is unknown or invalid', () => {
    const now = new Date(2026, 9, 16, 7, 5);
    expect(checkinClock(null, now)).toBe('7:05 AM');
    expect(checkinClock('Not/AZone', now)).toBe('7:05 AM');
  });
});

describe('checkIn stores the real time, not a fixed one', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    useStore.setState(getInitialState());
    s()._setGateway(null);
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('stamps the log and the pending draft with the project-clock time of the tap', () => {
    useStore.setState((st) => { st.timeZone = 'Asia/Kolkata'; });
    vi.setSystemTime(new Date('2026-10-16T04:07:00Z')); // 9:37 AM IST
    s().checkIn();
    expect(s().dailyLog).toMatchObject({ checkedIn: true, checkinTime: '9:37 AM' });
    expect(s().dailyLogDraft?.checkIn).toEqual({ checkedIn: true, checkinTime: '9:37 AM' });
  });

  it('checking in again later records the new time, not the first one', () => {
    useStore.setState((st) => { st.timeZone = 'Asia/Kolkata'; });
    vi.setSystemTime(new Date('2026-10-16T02:00:00Z')); // 7:30 AM IST
    s().checkIn();
    expect(s().dailyLog?.checkinTime).toBe('7:30 AM');
    s().checkOut();
    vi.setSystemTime(new Date('2026-10-16T05:15:00Z')); // 10:45 AM IST
    s().checkIn();
    expect(s().dailyLog?.checkinTime).toBe('10:45 AM');
  });
});
