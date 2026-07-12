import { describe, it, expect, vi } from 'vitest';
import { DailyLogService } from './daily-log.service';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthUser } from '../common/auth';

const user: AuthUser = { sub: 'u1', role: 'engineer', projectId: 'p1' } as AuthUser;

/**
 * "Latest daily log" must be chosen by the real creation instant, NEVER by ordering
 * the display-string date: lexical '03 Jul 2026' < '28 Jun 2026', so a date-string
 * sort silently picks the wrong day across month/year boundaries (audit P1).
 */
describe('DailyLogService — latest-log selection', () => {
  it('queries by createdAt desc (id tiebreak), not the display-string date', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { dailyLog: { findFirst } } as unknown as PrismaService;
    const svc = new DailyLogService(prisma, {} as SnapshotService, {} as RealtimeGateway);

    await expect(svc.flagMismatch('p1', { decisionId: 'DL-1' }, user)).rejects.toThrow('No daily log');

    expect(findFirst).toHaveBeenCalledTimes(1);
    const args = findFirst.mock.calls[0][0] as { orderBy: unknown };
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});
