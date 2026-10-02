import { describe, expect, it, vi } from 'vitest';
import { computeDailyLogSlice } from './daily-log-serialize';

const logRow = (over: Record<string, unknown> = {}) => ({
  id: 'log-b', date: '02 Oct 2026', logDate: new Date('2026-10-02T00:00:00Z'), checkedIn: false, checkinTime: null,
  submitted: false, progress: 0, crew: [{ trade: 'Mason', count: 0 }], materials: [], ...over,
});
const clientWith = (rows: unknown[]) => ({
  dailyLog: { findMany: vi.fn(async () => rows) },
  siteMaterial: { findMany: vi.fn(async () => []) },
});

// U1 (#690, Codex finding 4165349940): two daily logs can share a civil day — the server allows a new
// log once the last is sent — so the slice carries the log's own id for a client to tell them apart.
describe('computeDailyLogSlice — the log carries its own id', () => {
  it('serializes the latest log with its server id beside its civil date', async () => {
    const slice = await computeDailyLogSlice(clientWith([logRow()]) as never, 'p1');
    expect(slice.dailyLog?.id).toBe('log-b');
    expect(slice.dailyLog?.logDate).toBe('2026-10-02');
  });

  it('no log, no id', async () => {
    expect((await computeDailyLogSlice(clientWith([]) as never, 'p1')).dailyLog).toBeNull();
  });
});

// U1b: "Same as yesterday (N)" — the slice carries the log before the latest, as sent
describe('computeDailyLogSlice — the log before this one', () => {
  it('reads the latest two logs in the one order and carries the earlier one\'s civil day and crew', async () => {
    const before = logRow({ id: 'log-a', logDate: new Date('2026-10-01T00:00:00Z'), submitted: true, crew: [{ trade: 'Mason', count: 6 }, { trade: 'Helper', count: 2 }] });
    const client = clientWith([logRow(), before]);
    const slice = await computeDailyLogSlice(client as never, 'p1');
    expect(slice.dailyLog?.previous).toEqual({ logDate: '2026-10-01', crew: [{ trade: 'Mason', count: 6 }, { trade: 'Helper', count: 2 }] });
    expect(client.dailyLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { projectId: 'p1' },
      take: 2,
      orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
    }));
  });

  it('a project\'s first log has no previous one: null, never absent', async () => {
    const slice = await computeDailyLogSlice(clientWith([logRow()]) as never, 'p1');
    expect(slice.dailyLog).toHaveProperty('previous', null);
  });
});
