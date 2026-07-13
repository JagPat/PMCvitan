import { describe, it, expect, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthUser } from '../common/auth';

/**
 * Phase 1 Task 1 — CHARACTERIZATION of today's server truth for start/complete.
 * These tests pin CURRENT behavior, including behavior Phase 1 deliberately
 * changes: Task 5 replaces the unconditional `done` write with
 * `awaiting_signoff` + a sign-off-controlled transition, and MUST update the
 * `complete` tests below in the same PR. Until then, this is the contract.
 */

interface ActRow {
  id: string;
  projectId: string;
  name: string;
  zone: string;
  status: string;
  gateMaterial: string;
  gateTeam: string;
  gateInspection: string;
  nodeId: string | null;
  decision: { status: string } | null;
}

function make(activity: ActRow) {
  const inspectionCreates: Array<Record<string, unknown>> = [];
  const activityUpdates: Array<Record<string, unknown>> = [];
  const prisma = {
    activity: {
      findUnique: vi.fn(async () => activity),
      update: vi.fn((args: { data: Record<string, unknown> }) => {
        activityUpdates.push(args.data);
        return Promise.resolve({});
      }),
    },
    project: {
      findUniqueOrThrow: vi.fn(async () => ({ timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') })),
    },
    inspection: {
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        inspectionCreates.push(args.data);
        return Promise.resolve({ id: args.data.id });
      }),
    },
    notification: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  const snapshot = { build: vi.fn(async () => ({ ok: true })) } as unknown as SnapshotService;
  const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
  const svc = new ActivitiesService(prisma, snapshot, realtime, { today: () => '2026-07-05' });
  const user = { sub: 'u-eng', role: 'engineer' } as AuthUser;
  return { svc, prisma, user, inspectionCreates, activityUpdates };
}

const act = (over: Partial<ActRow> = {}): ActRow => ({
  id: 'ACT-31',
  projectId: 'ambli',
  name: 'Living Room Flooring',
  zone: 'Ground Floor · Living',
  status: 'not_started',
  gateMaterial: 'ok',
  gateTeam: 'ok',
  gateInspection: 'ok',
  nodeId: 'r-living',
  decision: { status: 'approved' },
  ...over,
});

describe('ActivitiesService.start — characterization', () => {
  it('refuses to start an activity that is not in not_started (409)', async () => {
    const { svc, user } = make(act({ status: 'in_progress' }));
    await expect(svc.start('ambli', 'ACT-31', user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses to start when a stored gate is unready (409) — gateInspection is a stored flag, not a derived fact', async () => {
    const { svc, user } = make(act({ gateInspection: 'wait' }));
    await expect(svc.start('ambli', 'ACT-31', user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('derives the Decision gate LIVE from the linked decision status — a change-requested decision blocks start', async () => {
    const { svc, user } = make(act({ decision: { status: 'change' } }));
    await expect(svc.start('ambli', 'ACT-31', user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('starts a ready activity: in_progress + the real civil start date from the injected clock', async () => {
    const { svc, user, activityUpdates } = make(act());
    await svc.start('ambli', 'ACT-31', user);
    expect(activityUpdates[0].status).toBe('in_progress');
    expect((activityUpdates[0].actualStartDate as Date).toISOString().slice(0, 10)).toBe('2026-07-05');
  });
});

describe('ActivitiesService.complete — characterization (replaced by Task 5)', () => {
  it('refuses to complete an activity that is not running (409)', async () => {
    const { svc, user } = make(act({ status: 'not_started' }));
    await expect(svc.complete('ambli', 'ACT-31', user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('writes done IMMEDIATELY and creates the closing inspection in the SAME transaction', async () => {
    const { svc, prisma, user, inspectionCreates, activityUpdates } = make(act({ status: 'in_progress' }));
    await svc.complete('ambli', 'ACT-31', user);

    // completion is unconditional: done + actual end date, no sign-off state exists
    expect(activityUpdates[0].status).toBe('done');
    expect((activityUpdates[0].actualEndDate as Date).toISOString().slice(0, 10)).toBe('2026-07-05');

    // one atomic transaction carries update + closing inspection + notice + audit
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect((prisma.$transaction as ReturnType<typeof vi.fn>).mock.calls[0][0]).toHaveLength(4);

    // the closing inspection is a zero-item review linked ONLY by its id pattern
    expect(inspectionCreates).toHaveLength(1);
    const closing = inspectionCreates[0];
    expect(closing.id).toBe('INSP-ACT-31-close');
    expect(closing.kind).toBe('review');
    expect(closing.submitted).toBe(true);
    expect(closing.decided).toBe(false);
    expect('items' in closing).toBe(false); // zero items → it can only ever be approved
    expect('activityId' in closing).toBe(false); // no back-reference exists in the schema
  });

  it('performs NO readiness or inspection check and records NO completer identity', async () => {
    // gates all failing and the linked decision reopened — completion still succeeds
    const { svc, user, activityUpdates } = make(act({ status: 'in_progress', gateMaterial: 'fail', gateInspection: 'fail', decision: { status: 'change' } }));
    await svc.complete('ambli', 'ACT-31', user);
    expect(activityUpdates[0].status).toBe('done');
    // who claimed the work finished is not a fact anywhere on the row
    expect(Object.keys(activityUpdates[0]).sort()).toEqual(['actualEnd', 'actualEndDate', 'status']);
  });
});
