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
  closing?: boolean; submittedById?: string | null; items: Item[];
};
type Member = { projectId: string; userId: string; role: string; status: string };
/** The activity a CLOSING inspection signs off (Phase 1 Task 5). */
type Act = { id: string; projectId: string; name: string; status: string; doneAt?: Date | null; completionRequestedById?: string | null };

/** Real display names behind the test users — attribution must surface THESE. */
const NAMES: Record<string, string> = { u1: 'Ravi Iyer', 'u-pmc': 'Ar. Meghna', 'u-con': 'Suresh & Co' };

/** In-memory Prisma stand-in. `evidence` = linked Media rows per inspectionItemId.
 *  Supports both $transaction forms; the interactive form passes the stub itself. */
function make(insp: Insp, opts: { members?: Member[]; evidence?: string[]; activity?: Act } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const audits: Array<{ action: string; entityId?: string; actor: string; actorId?: string; actorRole?: string; payload?: Record<string, unknown> }> = [];
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
    activity: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        (opts.activity && opts.activity.id === where.id ? { doneAt: null, completionRequestedById: null, ...opts.activity } : null)),
      // CAS transitions on the signed-off activity (status may be exact or an { in } set)
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; projectId: string; status?: string | { in: string[] } }; data: Record<string, unknown> }) => {
        const a = opts.activity;
        if (!a || a.id !== where.id || a.projectId !== where.projectId) return { count: 0 };
        const statusOk = where.status === undefined
          || (typeof where.status === 'string' ? a.status === where.status : where.status.in.includes(a.status));
        if (!statusOk) return { count: 0 };
        Object.assign(a, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(opts.activity ?? {}, data)),
    },
    inspectionItem: { updateMany: vi.fn(async () => ({ count: 1 })) },
    media: {
      groupBy: vi.fn(async ({ where }: { where: { inspectionItemId: { in: string[] } } }) =>
        (opts.evidence ?? []).filter((id) => where.inspectionItemId.in.includes(id)).map((id) => ({ inspectionItemId: id }))),
    },
    // the per-project readiness advisory lock (gate finding 1) is a no-op in-memory
    $executeRaw: vi.fn(async () => 1),
    // the IN-TRANSACTION locked assignee read (SELECT ... FOR UPDATE, Codex gate P1):
    // bind values are [projectId, assigneeId] — resolve against the fixture members
    $queryRaw: vi.fn(async (q: { values: unknown[] }) => {
      const [projectId, userId] = q.values as [string, string];
      const m = members.find((x) => x.projectId === projectId && x.userId === userId);
      return m ? [{ status: m.status, role: m.role }] : [];
    }),
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
      svc.submit('ambli', 'INSP-1', { items: [{ id: 'i1', name: 'Waterproofing', state: 'pass', photos: 1, note: '' }] } as never, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a complete submission and stamps the submitter REAL identity (Task 4)', async () => {
    const { svc, user, insp } = make({ id: 'INSP-1', projectId: 'ambli', submitted: false, decided: false, items: [item('i1', 'Waterproofing')] });
    await svc.submit('ambli', 'INSP-1', { items: [{ id: 'i1', name: 'Waterproofing', state: 'pass', photos: 1, note: 'ok' }] } as never, user);
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
      // the per-project readiness advisory lock (gate finding 1) is a no-op in-memory
      $executeRaw: vi.fn(async () => 1),
      $transaction: vi.fn(async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg)),
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
    await expect(svc.decide('ambli', 'INSP-1', { approve: true, rejectedItemIds: [] } as never, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects re-deciding an already-decided inspection', async () => {
    const { svc, user } = make({ id: 'INSP-1', projectId: 'ambli', submitted: true, decided: true, items: [item('i1', 'X', { state: 'pass' })] });
    await expect(svc.decide('ambli', 'INSP-1', { approve: true, rejectedItemIds: [] } as never, user)).rejects.toBeInstanceOf(BadRequestException);
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
  const failSubmit = { items: [{ id: 'i1', name: 'Drain slope', state: 'fail', photos: 1, note: 'pooling' }] };

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
    await svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemIds: ['i1'] } as never, pmc);

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
    await expect(svc.decide('ambli', 'INSP-close', { approve: false, rejectedItemIds: [] } as never, pmc)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('an assignee who is not a member, or holds an ineligible role, is a 400', async () => {
    const base: Insp = { id: 'INSP-21', projectId: 'ambli', submitted: true, decided: false, submittedById: 'u1', items: [item('i1', 'Drain slope', { result: 'FAIL' })] };
    // not a member at all
    const a = make({ ...base, items: [...base.items] }, { members: [] });
    await expect(a.svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemIds: ['i1'], assigneeId: 'u-ghost' } as never, a.pmc)).rejects.toThrow(/active engineer or contractor/i);
    // a CLIENT does not execute corrective site work
    const b = make({ ...base, items: [...base.items] }, { members: [{ projectId: 'ambli', userId: 'u-client', role: 'client', status: 'active' }] });
    await expect(b.svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemIds: ['i1'], assigneeId: 'u-client' } as never, b.pmc)).rejects.toThrow(/active engineer or contractor/i);
    // an INACTIVE engineer is not eligible either
    const c = make({ ...base, items: [...base.items] }, { members: [{ projectId: 'ambli', userId: 'u1', role: 'engineer', status: 'removed' }] });
    await expect(c.svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemIds: ['i1'] } as never, c.pmc)).rejects.toThrow(/active engineer or contractor/i);
  });

  it('a PMC may take the corrective work by naming THEMSELVES explicitly', async () => {
    const { svc, pmc, created } = make(
      { id: 'INSP-21', projectId: 'ambli', submitted: true, decided: false, submittedById: 'u1', items: [item('i1', 'Drain slope', { result: 'FAIL' })] },
      { members: [{ projectId: 'ambli', userId: 'u-pmc', role: 'pmc', status: 'active' }] },
    );
    await svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemIds: ['i1'], assigneeId: 'u-pmc' } as never, pmc);
    expect((created[0] as Record<string, unknown>).assigneeId).toBe('u-pmc');
  });

  it('a CAS loser gets a deterministic 409 (the decision raced and lost)', async () => {
    const { svc, prisma, pmc } = make({ id: 'INSP-21', projectId: 'ambli', submitted: true, decided: false, items: [item('i1', 'X', { state: 'pass' })] });
    (prisma.inspection.updateMany as Mock).mockResolvedValueOnce({ count: 0 });
    await expect(svc.decide('ambli', 'INSP-21', { approve: true, rejectedItemIds: [] } as never, pmc)).rejects.toBeInstanceOf(ConflictException);
  });
});

/**
 * Phase 1 Task 5 — a CLOSING inspection owns its activity's completion. These
 * tests pin the sign-off contract: approval writes done + doneAt via CAS;
 * rejection reverts to execution and assigns the corrective chain to the
 * RECORDED completer only while that identity stays active AND role-eligible;
 * legacy zero-item closings stay decidable through the `closing` flag.
 */
describe('InspectionsService — closing sign-off controls the activity (Phase 1 Task 5)', () => {
  const signItem = item('i1', 'Work complete and acceptable');
  const closingInsp = (over: Partial<Insp> = {}): Insp => ({
    id: 'INSP-40', projectId: 'ambli', submitted: true, decided: false, closing: true,
    activityId: 'ACT-31', submittedById: 'u1', title: 'Closing inspection: Flooring',
    items: [{ ...signItem }], ...over,
  });
  const claimedAct = (over: Partial<Act> = {}): Act => ({
    id: 'ACT-31', projectId: 'ambli', name: 'Flooring', status: 'awaiting_signoff',
    doneAt: null, completionRequestedById: 'u1', ...over,
  });

  it('APPROVING a closing inspection completes the activity: awaiting_signoff → done + doneAt, audited as activity.signoff', async () => {
    const activity = claimedAct();
    const { svc, pmc, audits, insp } = make(closingInsp(), { activity });
    await svc.decide('ambli', 'INSP-40', { approve: true, rejectedItemIds: [] } as never, pmc);

    expect(insp.decided).toBe(true);
    expect(activity.status).toBe('done'); // the PMC's acceptance IS the completion
    expect((activity.doneAt as Date).toISOString().slice(0, 10)).toBe('2026-07-03'); // the sign-off civil day
    const audit = audits.find((a) => a.action === 'activity.signoff');
    expect(audit?.entityId).toBe('ACT-31');
    expect(audit?.actorId).toBe('u-pmc');
    expect(audit?.actorRole).toBe('pmc');
  });

  it('approving when the activity is in an UNEXPECTED state (neither awaiting_signoff nor done) is a 409, not a guess', async () => {
    const { svc, pmc } = make(closingInsp(), { activity: claimedAct({ status: 'in_progress' }) });
    await expect(svc.decide('ambli', 'INSP-40', { approve: true, rejectedItemIds: [] } as never, pmc)).rejects.toBeInstanceOf(ConflictException);
  });

  it('approving a LEGACY closing (activity already done) is tolerated: the sign-off day is recorded, nothing re-transitions', async () => {
    const activity = claimedAct({ status: 'done', doneAt: null, completionRequestedById: null });
    const { svc, pmc, insp } = make(closingInsp({ id: 'INSP-ACT-31-close', items: [], submittedById: null }), { activity });
    await svc.decide('ambli', 'INSP-ACT-31-close', { approve: true, rejectedItemIds: [] } as never, pmc);
    expect(insp.decided).toBe(true);
    expect(activity.status).toBe('done'); // legacy done STAYS done
    expect(activity.doneAt).toBeInstanceOf(Date); // but the acceptance day is now a fact
  });

  it('REJECTING a closing returns the activity to execution and assigns the chain to the RECORDED completer — not the submitter', async () => {
    // the claim (u1) and the inspection submitter deliberately differ — the CLAIM wins
    const activity = claimedAct({ completionRequestedById: 'u1' });
    const { svc, pmc, created, audits } = make(closingInsp({ submittedById: 'u-someone-else' }), { activity });
    await svc.decide('ambli', 'INSP-40', { approve: false, rejectedItemIds: ['i1'] } as never, pmc);

    expect(activity.status).toBe('in_progress'); // back to execution
    expect(activity.doneAt).toBeNull();
    const child = created[0] as Record<string, unknown> & { items: { create: Array<{ name: string }> } };
    expect(child.assigneeId).toBe('u1'); // the recorded completer corrects the work
    expect(child.closing).toBeUndefined(); // corrective checklist — NOT itself a sign-off
    expect(child.activityId).toBe('ACT-31'); // requirement edge inherited
    expect(child.items.create.map((i) => i.name)).toEqual(['Work complete and acceptable']);
    const audit = audits.find((a) => a.action === 'activity.signoff_rejected');
    expect(audit?.entityId).toBe('ACT-31');
    expect(audit?.actorId).toBe('u-pmc');
  });

  it('completer role changed to an INELIGIBLE one since the claim: the default is refused (400); an eligible explicit assignee succeeds; an ineligible explicit one does not', async () => {
    const members: Member[] = [
      { projectId: 'ambli', userId: 'u1', role: 'client', status: 'active' }, // engineer → client since the claim
      { projectId: 'ambli', userId: 'u-con', role: 'contractor', status: 'active' },
    ];
    // default (no explicit assignee) → refused with the completer-specific message
    const a = make(closingInsp(), { activity: claimedAct(), members: [...members] });
    await expect(a.svc.decide('ambli', 'INSP-40', { approve: false, rejectedItemIds: ['i1'] } as never, a.pmc)).rejects.toThrow(/recorded completer/i);
    // naming the now-client completer explicitly is still refused
    const b = make(closingInsp(), { activity: claimedAct(), members: [...members] });
    await expect(b.svc.decide('ambli', 'INSP-40', { approve: false, rejectedItemIds: ['i1'], assigneeId: 'u1' } as never, b.pmc)).rejects.toThrow(/active engineer or contractor/i);
    // an ACTIVE contractor named explicitly resolves it
    const c = make(closingInsp(), { activity: claimedAct(), members: [...members] });
    await c.svc.decide('ambli', 'INSP-40', { approve: false, rejectedItemIds: ['i1'], assigneeId: 'u-con' } as never, c.pmc);
    expect((c.created[0] as Record<string, unknown>).assigneeId).toBe('u-con');
    expect(c.insp.decided).toBe(true);
  });

  it('completer membership REMOVED since the claim: the default is refused (400) and nothing changes', async () => {
    const activity = claimedAct();
    const { svc, pmc, insp } = make(closingInsp(), { activity, members: [{ projectId: 'ambli', userId: 'u1', role: 'engineer', status: 'removed' }] });
    await expect(svc.decide('ambli', 'INSP-40', { approve: false, rejectedItemIds: ['i1'] } as never, pmc)).rejects.toThrow(/recorded completer/i);
    expect(insp.decided).toBe(false);
    expect(activity.status).toBe('awaiting_signoff');
  });

  it('a LEGACY zero-item closing may be REJECTED: no recorded completer → an explicit assignee is required; the child gets the default sign-off item', async () => {
    const activity = claimedAct({ status: 'done', completionRequestedById: null });
    const members: Member[] = [{ projectId: 'ambli', userId: 'u-con', role: 'contractor', status: 'active' }];
    // zero items + no completer + no explicit assignee → 400 naming the gap
    const a = make(closingInsp({ id: 'INSP-ACT-31-close', items: [], submittedById: null }), { activity: { ...activity }, members: [...members] });
    await expect(a.svc.decide('ambli', 'INSP-ACT-31-close', { approve: false, rejectedItemIds: [] } as never, a.pmc)).rejects.toThrow(/no recorded completer/i);
    // with an explicit eligible assignee the rejection reopens the DONE activity — an
    // attributable PMC decision (never a migration guess) — and yields workable items
    const b = make(closingInsp({ id: 'INSP-ACT-31-close', items: [], submittedById: null }), { activity, members });
    await b.svc.decide('ambli', 'INSP-ACT-31-close', { approve: false, rejectedItemIds: [], assigneeId: 'u-con' } as never, b.pmc);
    expect(activity.status).toBe('in_progress');
    const child = b.created[0] as Record<string, unknown> & { items: { create: Array<{ name: string }> } };
    expect(child.items.create.map((i) => i.name)).toEqual(['Work complete and acceptable']);
    expect(child.assigneeId).toBe('u-con');
  });

  it('an ORDINARY zero-rejected reject stays a 400 — the closing escape hatch never leaks to normal inspections', async () => {
    const { svc, pmc } = make({ id: 'INSP-21', projectId: 'ambli', submitted: true, decided: false, items: [] });
    await expect(svc.decide('ambli', 'INSP-21', { approve: false, rejectedItemIds: [] } as never, pmc)).rejects.toBeInstanceOf(BadRequestException);
  });
});
