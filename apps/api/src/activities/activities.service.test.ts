import { describe, it, expect, vi, type Mock } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { AuthUser } from '../common/auth';

/**
 * Phase 1 — start/complete contract. The `start` tests remain the Task 1
 * characterization. The `complete` tests are the Task 5 CONTRACT (updated in
 * the same PR that changed the behavior, as the Task 1 header demanded):
 * completion is a CLAIM — a CAS to `awaiting_signoff` recording the completer's
 * real identity and creating the LINKED, item-bearing closing inspection.
 * Nothing here writes `done`; only closing-inspection approval does
 * (inspections.service.test.ts pins that side).
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

interface Member { projectId: string; userId: string; role: string; status: string }

/** Real display names behind the test users — attribution must surface THESE. */
const NAMES: Record<string, string> = { 'u-eng': 'Ravi Iyer', 'u-pmc': 'Ar. Meghna' };

function make(activity: ActRow, opts: { members?: Member[] } = {}) {
  const inspectionCreates: Array<Record<string, unknown>> = [];
  const activityUpdates: Array<Record<string, unknown>> = [];
  const audits: Array<{ action: string; actorId?: string; actorRole?: string; payload?: Record<string, unknown> }> = [];
  const members = opts.members ?? [{ projectId: activity.projectId, userId: 'u-eng', role: 'engineer', status: 'active' }];
  const prisma = {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (NAMES[where.id] ? { name: NAMES[where.id] } : null)) },
    activity: {
      findUnique: vi.fn(async () => activity),
      update: vi.fn((args: { data: Record<string, unknown> }) => {
        activityUpdates.push(args.data);
        return Promise.resolve({});
      }),
      // the CAS claim: only an in_progress row transitions (count-checked by the service)
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matches = activity.id === where.id && activity.projectId === where.projectId
          && (where.status === undefined || activity.status === where.status);
        if (matches) {
          Object.assign(activity, data);
          activityUpdates.push(data);
        }
        return { count: matches ? 1 : 0 };
      }),
    },
    // the IN-TRANSACTION locked membership read (SELECT ... FOR UPDATE, Codex gate P1):
    // bind values are [projectId, userId] — resolve against the fixture members
    $queryRaw: vi.fn(async (q: { values: unknown[] }) => {
      const [projectId, userId] = q.values as [string, string];
      const m = members.find((x) => x.projectId === projectId && x.userId === userId);
      return m ? [{ status: m.status, role: m.role }] : [];
    }),
    project: {
      findUniqueOrThrow: vi.fn(async () => ({ timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') })),
    },
    inspection: {
      findMany: vi.fn(async () => [{ id: 'INSP-21' }]),
      create: vi.fn((args: { data: Record<string, unknown> }) => {
        inspectionCreates.push(args.data);
        return Promise.resolve({ id: args.data.id });
      }),
    },
    notification: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn((args: { data: (typeof audits)[number] }) => { audits.push(args.data); return Promise.resolve(args.data); }) },
    $transaction: vi.fn(async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  } as unknown as PrismaService;
  const snapshot = { build: vi.fn(async () => ({ ok: true })) } as unknown as SnapshotService;
  const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
  const svc = new ActivitiesService(prisma, snapshot, realtime, { today: () => '2026-07-05' });
  const user = { sub: 'u-eng', role: 'engineer' } as AuthUser;
  return { svc, prisma, user, inspectionCreates, activityUpdates, audits, activity };
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

describe('ActivitiesService.complete — the completion CLAIM (Phase 1 Task 5)', () => {
  it('refuses to claim completion of an activity that is not running (409)', async () => {
    const { svc, user } = make(act({ status: 'not_started' }));
    await expect(svc.complete('ambli', 'ACT-31', user)).rejects.toBeInstanceOf(ConflictException);
  });

  it('the claim is a CAS to awaiting_signoff — NOT done — recording the completer’s real identity and the claimed work-end day', async () => {
    const { svc, user, activityUpdates, activity } = make(act({ status: 'in_progress' }));
    await svc.complete('ambli', 'ACT-31', user);

    const claim = activityUpdates[0];
    expect(claim.status).toBe('awaiting_signoff'); // no path here writes done
    expect((claim.actualEndDate as Date).toISOString().slice(0, 10)).toBe('2026-07-05'); // the CLAIM day
    expect(claim.doneAt).toBeUndefined(); // the sign-off day belongs to the closing approval
    expect(claim.completionRequestedById).toBe('u-eng');
    expect(claim.completionRequestedByName).toBe('Ravi Iyer');
    expect(claim.completionRequestedAt).toBeInstanceOf(Date);
    expect(activity.status).toBe('awaiting_signoff');
  });

  it('creates the LINKED closing inspection in the same transaction: closing marker, activityId, ONE default item, the completer as submitter', async () => {
    const { svc, user, inspectionCreates } = make(act({ status: 'in_progress' }));
    await svc.complete('ambli', 'ACT-31', user);

    expect(inspectionCreates).toHaveLength(1);
    const closing = inspectionCreates[0] as Record<string, unknown> & { items: { create: Array<{ name: string }> } };
    expect(closing.closing).toBe(true); // the unambiguous marker — id-pattern linkage is retired
    expect(closing.activityId).toBe('ACT-31');
    expect(closing.id).toBe('INSP-022'); // a normal sequential id, never INSP-ACT-31-close
    expect(closing.kind).toBe('review');
    expect(closing.submitted).toBe(true);
    expect(closing.decided).toBe(false);
    expect(closing.submittedById).toBe('u-eng'); // the completer signs the claim
    expect(closing.submittedByName).toBe('Ravi Iyer');
    // ONE default item — so the PMC CAN reject it (a zero-item review could only be approved)
    expect(closing.items.create.map((i) => i.name)).toEqual(['Work complete and acceptable']);
  });

  it('audits the claim as activity.complete_requested with the actor’s full identity', async () => {
    const { svc, user, audits } = make(act({ status: 'in_progress' }));
    await svc.complete('ambli', 'ACT-31', user);
    const audit = audits.find((a) => a.action === 'activity.complete_requested');
    expect(audit?.actorId).toBe('u-eng');
    expect(audit?.actorRole).toBe('engineer');
    expect(audit?.payload?.closingInspectionId).toBe('INSP-022');
  });

  it('a concurrent claim loses the CAS and gets a deterministic 409 — no closing inspection is created for the loser', async () => {
    const { svc, prisma, user, inspectionCreates } = make(act({ status: 'in_progress' }));
    (prisma.activity.updateMany as Mock).mockResolvedValueOnce({ count: 0 });
    await expect(svc.complete('ambli', 'ACT-31', user)).rejects.toBeInstanceOf(ConflictException);
    expect(inspectionCreates).toHaveLength(0);
  });

  it('a caller WITHOUT an active membership cannot claim (the claim must be attributable to a member)', async () => {
    // no membership at all
    const a = make(act({ status: 'in_progress' }), { members: [] });
    await expect(a.svc.complete('ambli', 'ACT-31', a.user)).rejects.toBeInstanceOf(BadRequestException);
    // a removed membership is not an identity to claim with either
    const b = make(act({ status: 'in_progress' }), { members: [{ projectId: 'ambli', userId: 'u-eng', role: 'engineer', status: 'removed' }] });
    await expect(b.svc.complete('ambli', 'ACT-31', b.user)).rejects.toBeInstanceOf(BadRequestException);
    expect(b.activity.status).toBe('in_progress'); // nothing moved
  });

  it('the claim performs NO readiness re-check (gates guard START, not the claim)', async () => {
    const { svc, user, activity } = make(act({ status: 'in_progress', gateMaterial: 'fail', gateInspection: 'fail', decision: { status: 'change' } }));
    await svc.complete('ambli', 'ACT-31', user);
    expect(activity.status).toBe('awaiting_signoff');
  });
});
