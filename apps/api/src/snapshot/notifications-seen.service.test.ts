import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NotificationsSeenService, isRetryableWriteFailure } from './notifications-seen.service';
import type { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';

/**
 * Top 10 #4b unit C (#778) — the write's failure handling, which a live database cannot force on demand:
 * a serialization failure or deadlock is retried ONCE internally, then answered 409, and a failed attempt
 * confirms nothing. The live arms are in `test/integration/top10-4b-notifications-seen.test.ts`.
 */
const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test', meta });

describe('NotificationsSeenService — retry once, then 409', () => {
  const user: AuthUser = { sub: 'u1', role: 'client', projectId: 'p1' };
  const build = (outcomes: Array<'conflict' | 'deadlock' | 'ok'>) => {
    const read = { slice: { decisions: [] }, feed: [{ id: 'n1', kind: null, text: 'x', color: '#000', time: 'now', at: new Date(0), decisionId: null, inspectionId: null }], events: new Map(), revisions: new Map(), seen: new Set() };
    let call = 0;
    const transaction = vi.fn(async (fn: unknown, opts?: { isolationLevel?: string }) => {
      if (opts?.isolationLevel === Prisma.TransactionIsolationLevel.RepeatableRead) return read;
      const outcome = outcomes[call++];
      if (outcome === 'conflict') throw known('P2034');
      if (outcome === 'deadlock') throw known('P2010', { code: '40P01' });
      return ['n1'];
    });
    const svc = new NotificationsSeenService({ $transaction: transaction } as unknown as PrismaService, {} as never);
    return { svc, transaction };
  };

  it('classifies a serialization failure and a deadlock as retryable, and nothing else', () => {
    expect(isRetryableWriteFailure(known('P2034'))).toBe(true);
    expect(isRetryableWriteFailure(known('P2010', { code: '40001' }))).toBe(true);
    expect(isRetryableWriteFailure(known('P2010', { code: '40P01' }))).toBe(true);
    expect(isRetryableWriteFailure(known('P2010', { code: '23503' }))).toBe(false);
    expect(isRetryableWriteFailure(known('P2002'))).toBe(false);
    expect(isRetryableWriteFailure(new Error('x'))).toBe(false);
  });

  it('retries a failed write once and answers with the retry\'s confirmation', async () => {
    const { svc, transaction } = build(['deadlock', 'ok']);
    await expect(svc.markSeen('p1', user, ['n1'])).resolves.toEqual({ confirmed: ['n1'] });
    // one REPEATABLE READ eligibility read, then two READ COMMITTED write attempts
    expect(transaction.mock.calls.map((c) => (c[1] as { isolationLevel: string }).isolationLevel)).toEqual([
      Prisma.TransactionIsolationLevel.RepeatableRead, Prisma.TransactionIsolationLevel.ReadCommitted, Prisma.TransactionIsolationLevel.ReadCommitted,
    ]);
  });

  it('answers 409 when the retry fails too, confirming nothing', async () => {
    const { svc, transaction } = build(['conflict', 'conflict', 'ok']);
    await expect(svc.markSeen('p1', user, ['n1'])).rejects.toBeInstanceOf(ConflictException);
    expect(transaction).toHaveBeenCalledTimes(3); // the read and exactly two write attempts
  });

  it('a worker device confirms nothing and touches no table', async () => {
    const { svc, transaction } = build(['ok']);
    await expect(svc.markSeen('p1', { ...user, role: 'worker', worker: true }, ['n1'])).resolves.toEqual({ confirmed: [] });
    expect(transaction).not.toHaveBeenCalled();
  });
});
