import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { SnapshotService } from './snapshot.service';
import type { PrismaService } from '../prisma.service';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4c — the snapshot reads the viewer's decision slice and the
 * notification feed (with the events its kinded notices are bound to) in ONE REPEATABLE READ
 * transaction, each through its owner's query. A kinded notice is served only if its decision is in
 * the slice, so the two reads must be one snapshot. The live arms are in
 * `test/integration/phase6-t4d-ii-a4c-kinded-feed.test.ts`.
 */
describe('SnapshotService.build — the decision slice and the feed are one snapshot (4d-ii-a / A4c)', () => {
  it('passes ONE repeatable-read transaction to the slice, the feed read and the event read', async () => {
    const tx = {
      notification: { findMany: vi.fn(async () => [
        { id: 'n1', text: 'x', color: '#000000', time: 'now', at: new Date(), decisionId: 'd1', kind: 'decision.published', eventId: 'e1', projectId: 'p1' },
      ]) },
      domainEvent: { findMany: vi.fn(async () => [{ eventId: 'e1', eventType: 'decision.published', payload: { title: 'T' }, dispatchIntent: { effectKey: 'decision.published' }, actorRole: 'pmc', actorName: 'P' }]) },
    };
    const transaction = vi.fn(async (fn: (client: typeof tx) => Promise<unknown>, _opts?: unknown) => fn(tx));
    const prisma = {
      project: { findUnique: vi.fn(async () => ({ id: 'p1', name: 'P', short: 'P', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', scheduleStartDate: null, scheduleEndDate: null, timeZone: 'Asia/Kolkata', elapsedPct: 0, todayDay: 0, milestonePct: 0 })) },
      media: { findMany: vi.fn(async () => []) },
      projectCompany: { findMany: vi.fn(async () => []) },
      projectNode: { findMany: vi.fn(async () => []) },
      $transaction: transaction,
    };
    const decisionsQuery = {
      snapshotSlice: vi.fn(async () => ({ decisions: [{ id: 'd1', status: 'pending', deciderKind: 'client' }], statuses: new Map(), drafts: new Set(), deciders: new Map() })),
      renderKindedNotice: vi.fn(() => ({ text: 'rendered', color: '#C08A2D' })),
      // 4d-ii-a / A7a — the revisions the kinded events name, read on the same transaction
      kindedNoticeRevisions: vi.fn(async () => new Map([['dar-d1-v1', { decisionId: 'd1', material: 'Granite', onBehalfOf: null }]])),
    };
    const svc = new SnapshotService(
      prisma as unknown as PrismaService,
      { mediaPath: () => '' } as never,
      decisionsQuery as never,
      { snapshotSlice: vi.fn(async () => ({ dailyLog: null })) } as never,
      { snapshotSlice: vi.fn(async () => []) } as never,
      { snapshotSlice: vi.fn(async () => ({ placedInspections: [], reviews: [], review: null, reinspectionCreated: [], checklist: null, openChecklists: [] })) } as never,
      { snapshotSlice: vi.fn(async () => ({ activities: [], phases: [] })) } as never,
    );

    const out = await svc.build('p1', 'pmc', 'u1');

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(transaction.mock.calls[0]![1]).toMatchObject({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    // the slice ran on the transaction, not on the service's own client
    expect(decisionsQuery.snapshotSlice).toHaveBeenCalledWith('p1', 'pmc', 'u1', tx);
    expect(tx.notification.findMany).toHaveBeenCalledTimes(1);
    expect(tx.domainEvent.findMany).toHaveBeenCalledTimes(1);
    // A7a — the revision read runs on the SAME transaction, with the events just read
    expect(decisionsQuery.kindedNoticeRevisions).toHaveBeenCalledTimes(1);
    expect(decisionsQuery.kindedNoticeRevisions.mock.calls[0]![0]).toBe(tx);
    expect(decisionsQuery.kindedNoticeRevisions.mock.calls[0]![1]).toBe('p1');
    expect([...(decisionsQuery.kindedNoticeRevisions.mock.calls[0]![2] as Map<string, unknown>).keys()]).toEqual(['e1']);
    // and the kinded row was handed to the decisions module with its event (envelope included), the
    // viewer's decision and the revisions
    expect(decisionsQuery.renderKindedNotice).toHaveBeenCalledWith(
      'decision.published', { eventType: 'decision.published', payload: { title: 'T' }, effectKey: 'decision.published', actorRole: 'pmc', actorName: 'P' },
      expect.objectContaining({ id: 'd1' }), 'pmc', 'u1', expect.any(Map),
    );
    expect((decisionsQuery.renderKindedNotice.mock.calls[0]![5] as Map<string, unknown>).get('dar-d1-v1')).toEqual({ decisionId: 'd1', material: 'Granite', onBehalfOf: null });
    // live bug 1 — the notice names its decision, which is in this viewer's slice
    expect(out.notifications).toEqual([{ text: 'rendered', time: 'now', color: '#C08A2D', decisionId: 'd1' }]);
  });
});
