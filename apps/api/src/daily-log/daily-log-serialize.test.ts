import { describe, expect, it, vi } from 'vitest';
import { computeDailyLogSlice } from './daily-log-serialize';

// U1 (#690, Codex finding 4165349940): two daily logs can share a civil day — the server allows a new
// log once the last is sent — so the slice carries the log's own id for a client to tell them apart.
describe('computeDailyLogSlice — the log carries its own id', () => {
  it('serializes the latest log with its server id beside its civil date', async () => {
    const row = {
      id: 'log-b', date: '02 Oct 2026', logDate: new Date('2026-10-02T00:00:00Z'), checkedIn: false, checkinTime: null,
      submitted: false, progress: 0, crew: [{ trade: 'Mason', count: 0 }], materials: [],
    };
    const client = {
      dailyLog: { findFirst: vi.fn(async () => row) },
      siteMaterial: { findMany: vi.fn(async () => []) },
    };
    const slice = await computeDailyLogSlice(client as never, 'p1');
    expect(slice.dailyLog?.id).toBe('log-b');
    expect(slice.dailyLog?.logDate).toBe('2026-10-02');
  });

  it('no log, no id', async () => {
    const client = { dailyLog: { findFirst: vi.fn(async () => null) }, siteMaterial: { findMany: vi.fn(async () => []) } };
    expect((await computeDailyLogSlice(client as never, 'p1')).dailyLog).toBeNull();
  });
});
