import { describe, it, expect, vi } from 'vitest';
import { DailyLogService } from './daily-log.service';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { ActivityParticipant } from '../activities/activity.participant';
import type { AuthUser } from '../common/auth';

const user: AuthUser = { sub: 'u1', role: 'engineer', projectId: 'p1' } as AuthUser;

/**
 * "Latest daily log" must be chosen by the real creation instant, NEVER by ordering
 * the display-string date: lexical '03 Jul 2026' < '28 Jun 2026', so a date-string
 * sort silently picks the wrong day across month/year boundaries (audit P1).
 */
describe('DailyLogService — latest-log selection', () => {
  it('queries by the real civil day (logDate desc, nulls last), createdAt + id as tie-breakers', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    // flagMismatch now reads INSIDE its locked transaction (gate round-2 finding 1):
    // the interactive form passes the stub itself; the advisory lock is a no-op here
    const prisma: Record<string, unknown> = {
      user: { findUnique: vi.fn(async () => ({ name: 'Ravi (Engineer)' })) },
      dailyLog: { findFirst },
      $executeRaw: vi.fn(async () => 1),
      $transaction: vi.fn(async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
    };
    const svc = new DailyLogService(prisma as unknown as PrismaService, {} as SnapshotService, { dispatchCommitted: vi.fn() } as unknown as ExternalEffectDispatcher, { today: () => '2026-07-03' }, new ActivityParticipant());

    await expect(svc.flagMismatch('p1', { decisionId: 'DL-1' }, user)).rejects.toThrow('No daily log');

    expect(findFirst).toHaveBeenCalledTimes(1);
    const args = findFirst.mock.calls[0][0] as { orderBy: unknown };
    expect(args.orderBy).toEqual([{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }]);
  });
});
