import { describe, it, expect, vi, afterEach } from 'vitest';
import { MAX_TIMER_MS, setClampedTimeout } from '@/lib/clampedTimer';

/**
 * #1014's round 2 (r4323657327): a browser fires a setTimeout longer than 2^31-1 ms at once, so a far deadline (a
 * signed link valid for months) looped. Every Site Visits timer goes through `setClampedTimeout`.
 */
describe('setClampedTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('waits out a delay longer than a browser timer can hold, in steps, and fires once at its end', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    setClampedTimeout(fn, MAX_TIMER_MS * 2 + 5);
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(MAX_TIMER_MS * 3);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires a negative or not-a-number delay on the next turn, and never a cleared one', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    setClampedTimeout(fn, -50);
    setClampedTimeout(fn, Number.NaN);
    vi.advanceTimersByTime(0);
    expect(fn).toHaveBeenCalledTimes(2);
    const later = vi.fn();
    const t = setClampedTimeout(later, MAX_TIMER_MS + 10);
    vi.advanceTimersByTime(MAX_TIMER_MS);
    t.clear();
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(later).not.toHaveBeenCalled();
  });

  it('keeps to the clock: a phone that slept past the deadline runs it as the step it slept through fires', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const fn = vi.fn();
    setClampedTimeout(fn, MAX_TIMER_MS * 2 + 5);
    // the clock jumps past the deadline while the first step is waiting (a sleeping phone's timers fire late)
    vi.setSystemTime(Date.now() + MAX_TIMER_MS * 2 + 10);
    vi.advanceTimersByTime(MAX_TIMER_MS);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
