import { describe, it, expect } from 'vitest';
import { civilDateOf } from '@/lib/civilDate';

/**
 * Codex F3 — `takenAt` is stored as a true UTC instant, which is the right thing to store.
 * Reading a civil date off it with `slice(0, 10)` is not: the UTC date and the site's date
 * disagree for a good part of every day, so a morning's site evidence gets filed under
 * yesterday. The instant is formatted in the PROJECT's zone instead.
 */
describe('a photo instant reads as the civil date the SITE was on', () => {
  it('files an Ahmedabad small-hours photo under its own day, not the UTC one', () => {
    // 00:30 on the 26th in Asia/Kolkata is 19:00 on the 25th in UTC
    const instant = '2026-08-25T19:00:00.000Z';
    expect(instant.slice(0, 10)).toBe('2026-08-25');          // what the bug showed
    expect(civilDateOf(instant, 'Asia/Kolkata')).toBe('2026-08-26');
  });

  it('agrees with slicing when the instant is mid-day UTC', () => {
    expect(civilDateOf('2026-08-25T06:30:00.000Z', 'Asia/Kolkata')).toBe('2026-08-25');
  });

  it('yields nothing rather than inventing a date', () => {
    for (const bad of [null, undefined, '', 'not-a-date']) {
      expect(civilDateOf(bad, 'Asia/Kolkata')).toBe('');
    }
  });

  it('falls back to the browser zone when the project zone is unknown', () => {
    // pre-snapshot / local demo: no project zone yet, and a date is still better than a raw ISO string
    expect(civilDateOf('2026-08-25T06:30:00.000Z', null)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
