import { describe, it, expect, vi, type Mock } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { InspectionsService } from './inspections.service';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';

type Item = { id: string; name: string; state: string | null; photos: number; result: string | null; rejected: boolean };
type Insp = {
  id: string; projectId: string; submitted: boolean; decided: boolean;
  title?: string; zone?: string; nodeId?: string | null; activityId?: string | null;
  submittedById?: string | null; items: Item[];
};
type Member = { projectId: string; userId: string; role: string; status: string };

/** Real display names behind the test users — attribution must surface THESE. */
const NAMES: Record<string, string> = { u1: 'Ravi Iyer', 'u-pmc': 'Ar. Meghna', 'u-con': 'Suresh & Co' };

/** In-memory Prisma stand-in. `evidence` = linked Media rows per inspectionItemId.
 *  Supports both $transaction forms; the interactive form passes the stub itself. */
function make(insp: Insp, opts: { members?: Member[]; evidence?: string[] } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const audits: Array<{ action: string; actor: string; actorId?: string; actorRole?: string }> = [];
  const members = opts.members ?? [{ projectId: insp.projectId, userId: 'u1', role: 'engineer', status: 'active' }];
  const prisma = {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (NAMES[where.id] ? { name: NAMES[where.id] } : null)) },
    inspection: {
      findUnique: vi.fn(async () => ({ title: 'Ponding test', zone: 'Terrace', nodeId: null, activityId: null, submittedById: null, ...insp })),
      findMany: vi.fn(async () => [{ id: insp.id }]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: data.id }; }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matches = insp.id === where.id && insp.projectId === where.projectId
          && (where.submitted === undefined || insp.submitted === where.submitted)
          && (where.decided === undefined || insp.decided === where.decided);
        if (matches) Object.assign(insp, data);
        return { count: matches ? 1 : 0 };
      }),
    },
    inspectionItem: { updateMany: vi.fn(async () => ({ count: 1 })) },
    media: {
      groupBy: vi.fn(async ({ where }: { where: { inspectionItemId: { in: string[] } } }) =>
        (opts.evidence ?? []).filter((id) => where.inspectionItemId.in.includes(id)).map((id) => ({ inspectionItemId: id }))),
    },
    membership: {
      findUnique: vi.fn(async ({ where }: { where: { projectId_userId: { projectId: string; userId: string } } }) =>
        members.find((m) => m.projectId === where.projectId_userId.projectId && m.userId === where.projectId_userId.userId) ?? null),
    },
    project: { findUniqueOrThrow: vi.fn(async () => ({ timeZone: 'Asia/Kolkata' })) },
    notification: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn((args: { data: (typeof audits)[number] }) => { audits.push(args.data); return Promise.resolve(args.data); }) },
    $transaction: vi.fn(async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
  } as unknown as PrismaService;
  const snapshot = { build: vi.fn(async () => ({})) } as unknown as SnapshotService;
  const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
  const svc = new InspectionsService(prisma, snapshot, realtime, { today: () => '2026-07-03' });
  const user = { sub: 'u1', role: 'engineer', projectId: insp.projectId } as never;
  const pmc = { sub: 'u-pmc', role: 'pmc', projectId: insp.projectId } as never;
  return { svc, prisma, user, pmc, created, audits, insp };
}

const item = (id: string, name: string, over: Partial<Item> = {}): Item => ({ id, name, state: null, photos: 0, result: null, rejected: false, ...over });

describe('InspectionsService.submit — state-machine guards (P2-3)', () => {
  it('rejects an empty payload against a non-empty issued checklist', async () => {
    const { svc, user } = make({ id: 'INSP-1', projectId: 'ambli', submitted: false, decided: false, items: [item('i1', 'Waterproofing')] });
    await expect(svc.submit('ambli', 'INSP-1', { items: [] } as never, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects resubmission of an already-submitted inspection', async () => {
    const { svc, user } = make({ id: 'INSP-1', projectId: 'ambli', submitted: true, decided: false, items: [item('i1', 'Waterproofing', { state: 'pass' })] });
    await expect(
      svc.submit('ambli', 'INSP-1', { items: [{ name: 'Waterproofing', state: 'pass', photos: 1, note: '' }] } as never, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a complete submission and stamps the submitter REAL identity (Task 4)', async () => {
    const { svc, user, insp } = make({ id: 'INSP-1', projectId: 'ambli', submitted: false, decided: false, items: [item('i1', 'Waterproofing')] });
    await svc.submit('ambli', 'INSP-1', { items: [{ name: 'Waterproofing', state: 'pass', photos: 1, note: 'ok' }] } as never, user);
    expect(insp.submitted).toBe(true);
    expect((insp as Record<string, unknown>).submittedById).toBe('u1');
    expect((insp as Record<string, unknown>).submittedByName).toBe('Ravi Iyer');
  });
});

describe('InspectionsService.create — location spine (nodeId)', () => {
  function makeCreate(nodes: Array<{ id: string; projectId: string }>) {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ name: 'Ar. Meghna' })) },
      inspection: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: data.id }; }),
      },
      inspectionItem: { create: vi.fn(async () => ({})) },
      notification: { create: vi.fn(async () => ({})) },
      auditLog: { create: vi.fn(async () => ({})) },
      projectNode: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => nodes.find((n) => n.id === where.id) ?? null) },
      activity: { findFirst: vi.fn(async () => null) },
      project: { findUniqueOrThrow: vi.fn(async () => ({ timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') })) },
      $transaction: vi.fn(async (ops: unknown[]) => ops),
    } as unknown as PrismaService;
    const snapshot = { build: vi.fn(async () => ({})) } as unknown as SnapshotService;
    const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
    const svc = new InspectionsService(prisma, snapshot, realtime, { today: () => '2026-07-03' });
    const user = { sub: 'u1', role: 'pmc', projectId: 'ambli' } as never;
    return { svc, user, created };
  }

  it('files a checklist on a valid node', async () => {
    const { svc, user, created } = makeCreate([{ id: 'r1', projectId: 'ambli' }]);
    await svc.create('ambli', { title: 'Waterproofing', zone: 'Terrace', items: ['coat 2'], nodeId: 'r1' }, user);
    expect(created[0].nodeId).toBe('r1');
  });

  it('rejects a checklist filed to another project’s node', async () => {
    const { svc, user } = makeCreate([{ id: 'r1', projectId: 'other' }]);
    await expect(svc.create('ambli', { title: 'X', zone: 'Y', items: ['a'], nodeId: 'r1' }, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a requirement edge naming another project’s activity (Task 4)', async () => {
    const { svc, user } = makeCreate([]);
    await expect(svc.create('ambli', { title: 'X', zone: 'Y', items: ['a'], activityId: 'ACT-foreign' }, user)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('InspectionsService.decide — state-machine guards (P2-3)', () => {
  it('rejects deciding an inspection that was never submitted', async () => {
    const { svc, user } = make({ id: 'INSP-1', projectId: 'ambli', submitted: false, decided: false, items: [item('i1', 'X', { state: 'pass' })] });
    await expect(svc.decide('ambli', 'INSP-1', { approve: true, rejectedItemNames: [] } as never, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects re-deciding an already-decided inspection', async () => {
    const { svc, user } = make({ id: 'INSP-1', projectId: 'ambli', submitted: true, decided: true, items: [item('i1', 'X', { state: 'pass' })] });
    await expect(svc.decide('ambli', 'INSP-1', { approve: true, rejectedItemNames: [] } as never, user)).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * Phase 1 Task 4 — the evidence + reinspection contract (replaces the Task 1
 * characterization of the pre-evidence behavior): a failed item needs a LINKED
 * Media row (the counter is display-only); rejection creates exactly ONE linked,
 * assigned, dated reinspection inheriting the requirement edge; both transitions
 * are CAS-guarded and attributable.
 */
describe('InspectionsService — evidence + linked reinspections (Phase 1 Task 4)', () => {
  const failSubmit = { items: [{ name: 'Drain slope', state: 'fail', photos: 1, note: 'pooling' }] };

  it('EVIDENCE RULE: a failed item without a linked Media row cannot be submitted, whatever the counter says', async () => {
    const { svc, user } = make({ id: 'INSP-1', projectId: 'ambli', submitted: false, decided: false, items: [item('i1', 'Drain slope')] }, { evidence: [] });
    await expect(svc.submit('ambli', 'INSP-1', failSubmit as never, user)).rejects.toThrow(/photo evidence/i);
  });

  it('a failed item WITH linked evidence submits fine', async () => {
    const { svc, user, insp } = make({ id: 'INSP-1', projectId: 'ambli', submitted: false, decided: false, items: [item('i1', 'Drain slope')] }, { evidence: ['i1'] });
    await svc.submit('ambli', 'INSP-1', failSubmit as never, user);
    expect(insp.submitted).toBe(true);
  });

  it('REJECT creates the linked reinspection: fresh rejected items, inherited activityId, assignee + due date, attributed', async () => {
    const { svc, pmc, created, audits, insp } = make({
      id: 'INSP-21', projectId: 'ambli', submitted: true, decided: false, activityId: 'ACT-9', submittedById: 'u1',
      items: [item('i1', 'Drain slope', { result: 'FAIL' }), item('i2', 'Sealant', { result: 'PASS' })],
    });
    await svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemNames: ['Drain slope'] } as never, pmc);

    expect(insp.decided).toBe(true);
    expect((insp as Record<string, unknown>).decidedById).toBe('u-pmc');
    expect((insp as Record<string, unknown>).decidedByName).toBe('Ar. Meghna');

    expect(created).toHaveLength(1);
    const child = created[0] as Record<string, unknown> & { items: { create: Array<{ name: string }> } };
    expect(child.reinspectionOfId).toBe('INSP-21');
    expect(child.activityId).toBe('ACT-9'); // the requirement edge is INHERITED
    expect(child.assigneeId).toBe('u1'); // defaults to the recorded submitter (active engineer)
    expect(child.dueDate).toBeInstanceOf(Date);
    expect(child.items.create.map((i) => i.name)).toEqual(['Drain slope']); // only the rejected work returns
    expect(audits.find((a) => a.action === 'inspection.reject')?.actorId).toBe('u-pmc');
    expect(audits.find((a) => a.action === 'inspection.reject')?.actorRole).toBe('pmc');
  });

  it('a ZERO-rejected reject is still a 400 — approve is the right verb', async () => {
    const { svc, pmc } = make({ id: 'INSP-close', projectId: 'ambli', submitted: true, decided: false, items: [] });
    await expect(svc.decide('ambli', 'INSP-close', { approve: false, rejectedItemNames: [] } as never, pmc)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an assignee who is not a member, or holds an ineligible role, is a 400', async () => {
    const base: Insp = { id: 'INSP-21', projectId: 'ambli', submitted: true, decided: false, submittedById: 'u1', items: [item('i1', 'Drain slope', { result: 'FAIL' })] };
    // not a member at all
    const a = make({ ...base, items: [...base.items] }, { members: [] });
    await expect(a.svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemNames: ['Drain slope'], assigneeId: 'u-ghost' } as never, a.pmc)).rejects.toThrow(/active engineer or contractor/i);
    // a CLIENT does not execute corrective site work
    const b = make({ ...base, items: [...base.items] }, { members: [{ projectId: 'ambli', userId: 'u-client', role: 'client', status: 'active' }] });
    await expect(b.svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemNames: ['Drain slope'], assigneeId: 'u-client' } as never, b.pmc)).rejects.toThrow(/active engineer or contractor/i);
    // an INACTIVE engineer is not eligible either
    const c = make({ ...base, items: [...base.items] }, { members: [{ projectId: 'ambli', userId: 'u1', role: 'engineer', status: 'removed' }] });
    await expect(c.svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemNames: ['Drain slope'] } as never, c.pmc)).rejects.toThrow(/active engineer or contractor/i);
  });

  it('a PMC may take the corrective work by naming THEMSELVES explicitly', async () => {
    const { svc, pmc, created } = make(
      { id: 'INSP-21', projectId: 'ambli', submitted: true, decided: false, submittedById: 'u1', items: [item('i1', 'Drain slope', { result: 'FAIL' })] },
      { members: [{ projectId: 'ambli', userId: 'u-pmc', role: 'pmc', status: 'active' }] },
    );
    await svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemNames: ['Drain slope'], assigneeId: 'u-pmc' } as never, pmc);
    expect((created[0] as Record<string, unknown>).assigneeId).toBe('u-pmc');
  });

  it('a CAS loser gets a deterministic 409 (the decision raced and lost)', async () => {
    const { svc, prisma, pmc } = make({ id: 'INSP-21', projectId: 'ambli', submitted: true, decided: false, items: [item('i1', 'X', { state: 'pass' })] });
    (prisma.inspection.updateMany as Mock).mockResolvedValueOnce({ count: 0 });
    await expect(svc.decide('ambli', 'INSP-21', { approve: true, rejectedItemNames: [] } as never, pmc)).rejects.toBeInstanceOf(ConflictException);
  });
});
