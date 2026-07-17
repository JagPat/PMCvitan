import { describe, it, expect, vi, type Mock } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DrawingsService } from './drawings.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import type { PrismaService } from '../prisma.service';
import type { StorageService } from './../media/storage.service';
import type { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { IssueDrawingInput } from '../contracts';

/**
 * PR C Task 2 — the service hands committed events to the single {@link ExternalEffectDispatcher}
 * instead of calling `notifyChanged`. The push body + roles are in each event's PERSISTED dispatch
 * intent (built from the external-effect catalog); these tests assert on that. Live-PG per-branch
 * send behaviour is pinned by test/integration/phase2-consequences.test.ts.
 */
type DispatcherMock = { dispatchCommitted: ReturnType<typeof vi.fn> };
type Intent = { effectKey: string; invalidate: boolean; push?: { body: string; roles: string[] } } | null;
const dispatchedIntents = (d: DispatcherMock): Intent[] =>
  ((d.dispatchCommitted.mock.calls.at(-1)?.[0] ?? []) as Array<{ dispatchIntent: Intent }>).map((e) => e.dispatchIntent);

interface Rev { id: string; drawingId: string; projectId?: string; status: string; rev: string; storageKey?: string | null; mime: string; data: Buffer | null; url: string | null; recipientsFrozenAt?: Date | null }
interface Draw { id: string; projectId: string; number: string; title: string; discipline: string; zone?: string | null; activityId?: string | null; decisionId?: string | null; nodeId?: string | null; publishedAt?: Date | null; authorId?: string | null; revisions: Rev[] }
interface NodeRow { id: string; projectId: string }
interface MemberRow { projectId: string; userId: string; role: string; status: string }

/** Real display names behind the test users — attribution must surface THESE. */
const NAMES: Record<string, string> = { u1: 'Ar. Meghna', 'u-eng': 'Ravi Iyer', 'u-con': 'Suresh & Co' };

/** In-memory Prisma stand-in for the drawings tables. Supports both $transaction
 *  forms (array + interactive callback). Methods mutate synchronously (before any
 *  await) so transactions preserve supersede-then-create ordering. */
function make(storagePutUrl: string | null = null, nodes: NodeRow[] = [], refs: { activities?: NodeRow[]; decisions?: NodeRow[] } = {}, members: MemberRow[] = []) {
  const draws: Draw[] = [];
  const acks: Array<{ revisionId: string; userId: string; userName?: string; role?: string }> = [];
  const recipients: Array<{ projectId: string; revisionId: string; userId: string; roleAtIssue: string }> = [];
  const audits: Array<{ actor: string; actorId?: string; actorRole?: string; action: string; payload?: Record<string, unknown> }> = [];
  let dseq = 0;
  let rseq = 0;
  const prisma = {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (NAMES[where.id] ? { name: NAMES[where.id] } : null)) },
    membership: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string; status: string; role: { in: string[] } } }) =>
        members.filter((m) => m.projectId === where.projectId && m.status === where.status && where.role.in.includes(m.role))),
    },
    activity: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId: string } }) =>
        (refs.activities ?? []).find((r) => r.id === where.id && r.projectId === where.projectId) ?? null),
    },
    decision: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId: string } }) =>
        (refs.decisions ?? []).find((r) => r.id === where.id && r.projectId === where.projectId) ?? null),
    },
    drawing: {
      findUnique: vi.fn(async ({ where, include }: { where: { id?: string; projectId_number?: { projectId: string; number: string } }; include?: unknown }) => {
        const d = where.id
          ? draws.find((x) => x.id === where.id)
          : draws.find((x) => x.projectId === where.projectId_number!.projectId && x.number === where.projectId_number!.number);
        if (!d) return null;
        return include ? d : { ...d, revisions: undefined };
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> & { revisions: { create: Omit<Rev, 'id' | 'drawingId'> } } }) => {
        const id = `d${++dseq}`;
        // real Prisma: nullable columns come back null, and a nested create inherits
        // the composite-FK scalars (projectId, drawingId) from its parent drawing
        const rev: Rev = { id: `r${++rseq}`, drawingId: id, projectId: data.projectId as string, recipientsFrozenAt: null, ...(data.revisions.create as Omit<Rev, 'id' | 'drawingId'>) };
        const d: Draw = { id, projectId: data.projectId as string, number: data.number as string, title: data.title as string, discipline: data.discipline as string, zone: data.zone as string, nodeId: (data.nodeId as string) ?? null, publishedAt: (data.publishedAt as Date) ?? null, authorId: (data.authorId as string) ?? null, revisions: [rev] };
        draws.push(d);
        return { ...d };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const d = draws.find((x) => x.id === where.id)!;
        Object.assign(d, data);
        return d;
      }),
      // CAS used by publish(): honors the publishedAt-null precondition
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; projectId: string; publishedAt?: Date | null }; data: Record<string, unknown> }) => {
        const hit = draws.filter((d) => d.id === where.id && d.projectId === where.projectId && (where.publishedAt === undefined || (d.publishedAt ?? null) === where.publishedAt));
        hit.forEach((d) => Object.assign(d, data));
        return { count: hit.length };
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = draws.findIndex((x) => x.id === where.id);
        return draws.splice(i, 1)[0];
      }),
    },
    drawingRevision: {
      updateMany: vi.fn((args: { where: { drawingId: string; status: string }; data: { status: string } }) => {
        const d = draws.find((x) => x.id === args.where.drawingId);
        let count = 0;
        d?.revisions.forEach((r) => { if (r.status === args.where.status) { r.status = args.data.status; count += 1; } });
        return Promise.resolve({ count });
      }),
      create: vi.fn((args: { data: Omit<Rev, 'id'> }) => {
        const d = draws.find((x) => x.id === args.data.drawingId)!;
        // the one-label-per-drawing unique, in miniature
        if (d.revisions.some((r) => r.rev === args.data.rev)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
        }
        const rev: Rev = { id: `r${++rseq}`, recipientsFrozenAt: null, ...args.data };
        d.revisions.push(rev);
        return Promise.resolve(rev);
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Rev> }) => {
        for (const d of draws) {
          const r = d.revisions.find((x) => x.id === where.id);
          if (r) { Object.assign(r, data); return r; }
        }
        throw new Error('rev not found');
      }),
      findMany: vi.fn(async ({ where }: { where: { drawingId: string; status?: { not: string }; recipientsFrozenAt?: null } }) => {
        const d = draws.find((x) => x.id === where.drawingId);
        return (d?.revisions ?? []).filter((r) =>
          (where.status?.not === undefined || r.status !== where.status.not) &&
          (where.recipientsFrozenAt !== null || (r.recipientsFrozenAt ?? null) === null));
      }),
      findUnique: vi.fn(async ({ where, include }: { where: { id: string }; include?: { drawing?: boolean } }) => {
        for (const d of draws) {
          const r = d.revisions.find((x) => x.id === where.id);
          if (r) return include?.drawing ? { ...r, drawing: d } : r;
        }
        return null;
      }),
    },
    drawingRecipient: {
      createMany: vi.fn(async ({ data }: { data: Array<{ projectId: string; revisionId: string; userId: string; roleAtIssue: string }> }) => {
        data.forEach((row) => {
          if (!recipients.some((r) => r.revisionId === row.revisionId && r.userId === row.userId)) recipients.push(row);
        });
        return { count: data.length };
      }),
    },
    drawingAck: {
      findUnique: vi.fn(async ({ where }: { where: { revisionId_userId: { revisionId: string; userId: string } } }) =>
        acks.find((a) => a.revisionId === where.revisionId_userId.revisionId && a.userId === where.revisionId_userId.userId) ?? null),
      create: vi.fn(async ({ data }: { data: { revisionId: string; userId: string; userName: string; role: string } }) => {
        if (acks.some((a) => a.revisionId === data.revisionId && a.userId === data.userId)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
        }
        acks.push({ ...data });
        return data;
      }),
      count: vi.fn(async ({ where }: { where: { revisionId: string } }) => acks.filter((a) => a.revisionId === where.revisionId).length),
    },
    auditLog: { create: vi.fn((args: { data: (typeof audits)[number] }) => { audits.push(args.data); return Promise.resolve(args.data); }) },
    project: { findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org-test' })) },
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
    projectNode: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => nodes.find((n) => n.id === where.id) ?? null),
    },
    // the SELECT ... FOR UPDATE row locks, in miniature: 2 bind values = the issue()
    // the per-project readiness advisory lock (gate finding 1) is a no-op in-memory
    $executeRaw: vi.fn(async () => 1),
    // lock on (projectId, number); 1 bind value = the publish() lock on id. Locking
    // semantics don't exist in-memory — tests assert the CAS/unique outcomes instead.
    $queryRaw: vi.fn(async (q: { values?: unknown[] }) => {
      const vals = q?.values ?? [];
      if (vals.length === 2) {
        const d = draws.find((x) => x.projectId === vals[0] && x.number === vals[1]);
        return d ? [{ id: d.id, publishedAt: d.publishedAt ?? null }] : [];
      }
      const d = draws.find((x) => x.id === vals[0]);
      return d ? [{ id: d.id }] : [];
    }),
    $transaction: (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
      typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
  };
  const storage = {
    keyFor: vi.fn(() => 'ambli/drawings/x.pdf'),
    put: vi.fn(async () => ({ url: storagePutUrl })),
    publicUrl: vi.fn((k: string) => `https://cdn.vitan.in/${k}`),
    presignPut: vi.fn(async () => (storagePutUrl ? { uploadUrl: 'https://cdn.vitan.in/upload?sig=x', url: storagePutUrl } : null)),
    remove: vi.fn(async () => {}),
  };
  const dispatcher = { dispatchCommitted: vi.fn() };
  const snapshot = { build: vi.fn(async () => ({ ok: true })) };
  const svc = new DrawingsService(prisma as unknown as PrismaService, storage as unknown as StorageService, dispatcher as unknown as ExternalEffectDispatcher, snapshot as unknown as SnapshotService, new DecisionsQueryService(prisma as unknown as PrismaService));
  return { svc, prisma, storage, dispatcher, snapshot, draws, acks, recipients, audits };
}

const drawUser = { sub: 'u1', role: 'pmc', projectId: 'ambli' } as never;

const base: IssueDrawingInput = { number: 'A-201', title: 'Living Room Flooring Layout', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') };

describe('DrawingsService.issue', () => {
  it('creates a new register entry as a private draft by default (no team notice)', async () => {
    const { svc, draws, dispatcher } = make();
    await svc.issue('ambli', drawUser, base);
    expect(draws).toHaveLength(1);
    expect(draws[0].revisions).toHaveLength(1);
    expect(draws[0].revisions[0].status).toBe('for_construction');
    expect(draws[0].publishedAt).toBeNull(); // it's a draft
    expect(draws[0].authorId).toBe('u1'); // owned by its creator
    // a draft's dispatched issue event is WEIGHTLESS — no invalidate, no push (reaches no one)
    expect(dispatchedIntents(dispatcher)).toEqual([{ effectKey: 'drawing.issued_draft', invalidate: false, coverageVersion: expect.any(String) }]);
  });

  it('issues in one step when publish is set — publishedAt set, build team notified', async () => {
    const { svc, draws, dispatcher } = make();
    await svc.issue('ambli', drawUser, { ...base, publish: true });
    expect(draws[0].publishedAt).not.toBeNull();
    expect(dispatchedIntents(dispatcher)[0]).toMatchObject({ effectKey: 'drawing.issued', invalidate: true, push: { body: expect.stringContaining('A-201 Rev A'), roles: ['engineer', 'contractor'] } });
  });

  it('publish() flips a draft drawing live and notifies; re-publishing conflicts', async () => {
    const { svc, draws, dispatcher } = make();
    await svc.issue('ambli', drawUser, base); // draft
    const id = draws[0].id;
    expect(dispatchedIntents(dispatcher)[0]).toMatchObject({ effectKey: 'drawing.issued_draft', invalidate: false }); // draft: weightless

    await svc.publish('ambli', id, drawUser);
    expect(draws[0].publishedAt).not.toBeNull();
    expect(dispatchedIntents(dispatcher)[0]).toMatchObject({ effectKey: 'drawing.published', invalidate: true, push: { body: expect.stringContaining('A-201'), roles: ['engineer', 'contractor'] } });

    await expect(svc.publish('ambli', id, drawUser)).rejects.toBeInstanceOf(ConflictException);
  });

  it('adds a revision and supersedes the prior CONSTRUCTION revision for an existing number', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', drawUser, base);
    await svc.issue('ambli', drawUser, { ...base, rev: 'B', title: 'Living Room Flooring Layout' });

    expect(draws).toHaveLength(1); // same register entry
    const revs = draws[0].revisions;
    expect(revs).toHaveLength(2);
    expect(revs.find((r) => r.rev === 'A')!.status).toBe('superseded');
    expect(revs.find((r) => r.rev === 'B')!.status).toBe('for_construction');
  });

  it('accepts a presigned storageKey (skips put, records the bucket pointer, stores no public url)', async () => {
    const { svc, draws, storage } = make();
    await svc.issue('ambli', drawUser, { ...base, data: undefined as never, storageKey: 'ambli/drawings/big.pdf', sizeBytes: 9_000_000 });
    expect(storage.put).not.toHaveBeenCalled();
    const rev = draws[0].revisions[0];
    expect(rev.storageKey).toBe('ambli/drawings/big.pdf');
    expect(rev.url).toBeNull(); // private delivery: never persist the public bucket url
    expect(rev.data).toBeNull();
  });

  it('rejects a storageKey that belongs to another project (cross-project drawing read)', async () => {
    const { svc } = make();
    await expect(
      svc.issue('ambli', drawUser, { ...base, data: undefined as never, storageKey: 'villa/drawings/secret.pdf', sizeBytes: 100 }),
    ).rejects.toThrow(/does not belong to this project/);
  });

  it('S3 mode drops the bytes and stores no public url; dev stub keeps the bytes', async () => {
    const s3 = make('https://cdn.vitan.in/ambli/drawings/x.pdf');
    await s3.svc.issue('ambli', drawUser, base);
    expect(s3.draws[0].revisions[0].url).toBeNull(); // private delivery
    expect(s3.draws[0].revisions[0].data).toBeNull();
    expect(s3.draws[0].revisions[0].storageKey).toBe('ambli/drawings/x.pdf');

    const stub = make(null);
    await stub.svc.issue('ambli', drawUser, base);
    expect(stub.draws[0].revisions[0].url).toBeNull();
    expect(stub.draws[0].revisions[0].data).toBeInstanceOf(Buffer);
  });
});

/**
 * Phase 1 Task 3 — the CONTROLLED lifecycle contract: scoped supersession,
 * tenant identity on every revision, frozen distributions, one label per
 * drawing, and real-identity audits. (Replaces the Task 1 characterization
 * of the pre-control behavior.)
 */
describe('DrawingsService — controlled lifecycle (Phase 1 Task 3)', () => {
  const team: MemberRow[] = [
    { projectId: 'ambli', userId: 'u-eng', role: 'engineer', status: 'active' },
    { projectId: 'ambli', userId: 'u-con', role: 'contractor', status: 'active' },
    { projectId: 'ambli', userId: 'u1', role: 'pmc', status: 'active' }, // never a recipient
    { projectId: 'ambli', userId: 'u-gone', role: 'engineer', status: 'removed' }, // inactive — excluded
  ];

  it('a for_review issue supersedes NOTHING — the construction set keeps governing', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', drawUser, base); // Rev A, for_construction
    await svc.issue('ambli', drawUser, { ...base, rev: 'B', status: 'for_review' });

    const revs = draws[0].revisions;
    expect(revs.find((r) => r.rev === 'A')!.status).toBe('for_construction'); // NOT displaced
    expect(revs.find((r) => r.rev === 'B')!.status).toBe('for_review'); // coexists as a review copy
  });

  it('a for_construction issue supersedes ONLY the construction set — review copies survive', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', drawUser, base); // A: for_construction
    await svc.issue('ambli', drawUser, { ...base, rev: 'B', status: 'for_review' });
    await svc.issue('ambli', drawUser, { ...base, rev: 'C', status: 'for_construction' });

    const revs = draws[0].revisions;
    expect(revs.find((r) => r.rev === 'A')!.status).toBe('superseded');
    expect(revs.find((r) => r.rev === 'B')!.status).toBe('for_review'); // untouched
    expect(revs.find((r) => r.rev === 'C')!.status).toBe('for_construction');
  });

  it('every revision row carries its tenant identity — inherited on create, explicit on revise', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', drawUser, base);
    expect(draws[0].revisions[0].projectId).toBe('ambli'); // via the parent drawing
    await svc.issue('ambli', drawUser, { ...base, rev: 'B' });
    expect(draws[0].revisions.find((r) => r.rev === 'B')!.projectId).toBe('ambli'); // standalone create
  });

  it('a duplicate revision label on the same drawing is a 409 (the DB unique fires)', async () => {
    const { svc } = make();
    await svc.issue('ambli', drawUser, base);
    await expect(svc.issue('ambli', drawUser, { ...base })).rejects.toBeInstanceOf(ConflictException);
  });

  it('a PUBLISHED issue freezes the distribution: active engineer/contractor members, stamped', async () => {
    const { svc, draws, recipients } = make(null, [], {}, team);
    await svc.issue('ambli', drawUser, { ...base, publish: true });
    const rev = draws[0].revisions[0];
    expect(rev.recipientsFrozenAt).toBeInstanceOf(Date); // the snapshot RAN
    expect(recipients.map((r) => [r.userId, r.roleAtIssue]).sort()).toEqual([
      ['u-con', 'contractor'],
      ['u-eng', 'engineer'],
    ]); // pmc + removed member excluded
  });

  it('freezing an EMPTY set still stamps recipientsFrozenAt (≠ legacy null)', async () => {
    const { svc, draws, recipients } = make(null, [], {}, []); // no eligible members
    await svc.issue('ambli', drawUser, { ...base, publish: true });
    expect(draws[0].revisions[0].recipientsFrozenAt).toBeInstanceOf(Date);
    expect(recipients).toHaveLength(0);
  });

  it('a DRAFT freezes nothing; publish() then freezes its unfrozen revisions', async () => {
    const { svc, draws, recipients } = make(null, [], {}, team);
    await svc.issue('ambli', drawUser, base); // draft
    expect(draws[0].revisions[0].recipientsFrozenAt).toBeNull();
    expect(recipients).toHaveLength(0);

    await svc.publish('ambli', draws[0].id, drawUser);
    expect(draws[0].revisions[0].recipientsFrozenAt).toBeInstanceOf(Date);
    expect(recipients).toHaveLength(2);
  });

  it('issue and revise are audited with the caller REAL identity (drawing.issue / drawing.revise)', async () => {
    const { svc, audits } = make();
    await svc.issue('ambli', drawUser, base);
    await svc.issue('ambli', drawUser, { ...base, rev: 'B' });
    const issue = audits.find((a) => a.action === 'drawing.issue');
    const revise = audits.find((a) => a.action === 'drawing.revise');
    expect(issue?.actorId).toBe('u1');
    expect(issue?.actor).toBe('Ar. Meghna'); // the display name, not a role label
    expect(issue?.payload).toMatchObject({ number: 'A-201', rev: 'A' });
    expect(revise?.actorId).toBe('u1');
    expect(revise?.payload).toMatchObject({ rev: 'B' });
  });
});

describe('DrawingsService.presign', () => {
  it('returns a presigned upload target in S3 mode', async () => {
    const { svc } = make('https://cdn.vitan.in/ambli/drawings/x.pdf');
    const res = await svc.presign('ambli', 'application/pdf');
    expect(res).toMatchObject({ storageKey: 'ambli/drawings/x.pdf', uploadUrl: expect.stringContaining('upload') });
  });

  it('returns { presign: null } with no bucket (dev stub → client posts base64)', async () => {
    const { svc } = make(null);
    expect(await svc.presign('ambli', 'application/pdf')).toEqual({ presign: null });
  });
});

describe('DrawingsService.acknowledge', () => {
  const asUser = (role: string, sub = 'u1') => ({ sub, role, projectId: 'ambli' }) as never;

  it('records a build-acknowledgement, audits drawing.ack with actorId, and notifies the PMC', async () => {
    const { svc, draws, acks, audits, dispatcher } = make();
    await svc.issue('ambli', drawUser, base);
    const revId = draws[0].revisions[0].id;

    const res = await svc.acknowledge('ambli', revId, asUser('contractor', 'u-con'));
    expect(res).toEqual({ ok: true, ackCount: 1 });
    expect(acks).toHaveLength(1);
    expect(acks[0].userName).toBe('Suresh & Co'); // real name on the register
    const audit = audits.find((a) => a.action === 'drawing.ack');
    expect(audit?.actorId).toBe('u-con');
    expect(dispatchedIntents(dispatcher)[0]).toMatchObject({ effectKey: 'drawing.acknowledged', invalidate: true, push: { body: expect.stringContaining('building to A-201 Rev A'), roles: ['pmc'] } });
  });

  it('is idempotent per (revision, user)', async () => {
    const { svc, draws, acks } = make();
    await svc.issue('ambli', drawUser, base);
    const revId = draws[0].revisions[0].id;
    await svc.acknowledge('ambli', revId, asUser('engineer', 'u-eng'));
    await svc.acknowledge('ambli', revId, asUser('engineer', 'u-eng'));
    expect(acks).toHaveLength(1);
  });

  it('refuses the client (they do not build)', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', drawUser, base);
    const revId = draws[0].revisions[0].id;
    await expect(svc.acknowledge('ambli', revId, asUser('client'))).rejects.toThrow();
  });

  it('refuses a revision from another project (tenant isolation)', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', drawUser, base);
    const revId = draws[0].revisions[0].id;
    await expect(svc.acknowledge('other', revId, asUser('contractor'))).rejects.toThrow();
  });
});

describe('DrawingsService.remove', () => {
  it('deletes a drawing in the project (audited) and refuses one from another project', async () => {
    const { svc, draws, storage, audits } = make();
    await svc.issue('ambli', drawUser, base);
    const id = draws[0].id;

    expect(await svc.remove(id, 'other', drawUser)).toBe(false); // tenant isolation
    expect(draws).toHaveLength(1);

    expect(await svc.remove(id, 'ambli', drawUser)).toBe(true);
    expect(draws).toHaveLength(0);
    expect(storage.remove).toHaveBeenCalled();
    expect(audits.find((a) => a.action === 'drawing.remove')?.actorId).toBe('u1');
  });
});

describe('DrawingsService — location spine (nodeId)', () => {
  it('files a drawing on a valid node at issue', async () => {
    const { svc, draws } = make(null, [{ id: 'z1', projectId: 'ambli' }]);
    await svc.issue('ambli', drawUser, { ...base, nodeId: 'z1' });
    expect(draws[0].nodeId).toBe('z1');
  });

  it('rejects a drawing filed to another project’s node', async () => {
    const { svc } = make(null, [{ id: 'z1', projectId: 'other' }]);
    await expect(svc.issue('ambli', drawUser, { ...base, nodeId: 'z1' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('setNode re-files a drawing (audited drawing.refile) and returns a snapshot', async () => {
    const { svc, draws, snapshot, audits } = make(null, [{ id: 'r1', projectId: 'ambli' }]);
    await svc.issue('ambli', drawUser, base);
    const id = draws[0].id;
    const out = await svc.setNode(id, 'ambli', 'r1', drawUser);
    expect(draws[0].nodeId).toBe('r1');
    expect(snapshot.build).toHaveBeenCalled();
    expect(out).toEqual({ ok: true });
    expect(audits.find((a) => a.action === 'drawing.refile')?.actorId).toBe('u1');
  });

  it('setNode with null unfiles, and refuses a drawing from another project', async () => {
    const { svc, draws } = make(null, [{ id: 'r1', projectId: 'ambli' }]);
    await svc.issue('ambli', drawUser, { ...base, nodeId: 'r1' });
    const id = draws[0].id;
    await svc.setNode(id, 'ambli', null, drawUser);
    expect(draws[0].nodeId).toBeNull();
    await expect(svc.setNode(id, 'other', null, drawUser)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DrawingsService — project-owned references (Phase 0 Task 5)', () => {
  const refBase: IssueDrawingInput = { number: 'A-201', title: 'Plan', discipline: 'Architecture', rev: 'P1', status: 'for_review', mime: 'application/pdf', data: Buffer.from('pdf').toString('base64'), publish: true };

  it('rejects a forged activityId from another project', async () => {
    const { svc } = make(null, [], { activities: [{ id: 'ACT-9', projectId: 'other' }] });
    await expect(svc.issue('ambli', drawUser, { ...refBase, activityId: 'ACT-9' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a forged decisionId from another project', async () => {
    const { svc } = make(null, [], { decisions: [{ id: 'DL-9', projectId: 'other' }] });
    await expect(svc.issue('ambli', drawUser, { ...refBase, decisionId: 'DL-9' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts same-project activity + decision links', async () => {
    const { svc, prisma } = make(null, [], {
      activities: [{ id: 'ACT-1', projectId: 'ambli' }],
      decisions: [{ id: 'DL-1', projectId: 'ambli' }],
    });
    await svc.issue('ambli', drawUser, { ...refBase, activityId: 'ACT-1', decisionId: 'DL-1' });
    const row = prisma.drawing.create.mock.calls[0][0].data;
    expect(row.activityId).toBe('ACT-1');
    expect(row.decisionId).toBe('DL-1');
  });
});

/**
 * Gate remediation (findings 2, 3, 5 + role-at-action) — the corrected contract:
 * publish is CAS-guarded, acks are idempotent AS A COMMAND (ack + audit atomic,
 * announced once), a one-step publish freezes every live revision, and every
 * drawing audit snapshots the role held at action time.
 */
describe('DrawingsService — gate remediation (findings 2, 3, 5)', () => {
  const eng = { sub: 'u-eng', role: 'engineer', projectId: 'ambli' } as never;

  it('publish CAS: the loser of a concurrent publish gets a 409 and audits nothing', async () => {
    const { svc, prisma, draws, audits } = make();
    await svc.issue('ambli', drawUser, base); // a draft
    (prisma.drawing.updateMany as Mock).mockResolvedValueOnce({ count: 0 }); // the race was lost
    await expect(svc.publish('ambli', draws[0].id, drawUser)).rejects.toBeInstanceOf(ConflictException);
    expect(audits.filter((a) => a.action === 'drawing.publish')).toHaveLength(0); // no duplicate publication trail
  });

  it('GATE FINDING 3: an ack replay records nothing new — one row, ONE audit, announced once', async () => {
    const { svc, draws, acks, audits, dispatcher } = make();
    await svc.issue('ambli', drawUser, { ...base, publish: true });
    const revId = draws[0].revisions[0].id;

    const first = await svc.acknowledge('ambli', revId, eng);
    const announced = (dispatcher.dispatchCommitted as Mock).mock.calls.length;
    const replay = await svc.acknowledge('ambli', revId, eng);

    expect(first).toEqual({ ok: true, ackCount: 1 });
    expect(replay).toEqual({ ok: true, ackCount: 1 }); // replay-safe result shape
    expect(acks).toHaveLength(1);
    expect(audits.filter((a) => a.action === 'drawing.ack')).toHaveLength(1); // audit written WITH the ack, once
    expect((dispatcher.dispatchCommitted as Mock).mock.calls.length).toBe(announced); // the replay dispatched nothing
  });

  it('GATE FINDING 5: a one-step publish of an existing draft freezes EVERY live revision', async () => {
    const members = [{ projectId: 'ambli', userId: 'u-eng', role: 'engineer', status: 'active' }];
    const { svc, draws } = make(null, [], {}, members);
    await svc.issue('ambli', drawUser, base); // draft Rev A (construction)
    await svc.issue('ambli', drawUser, { ...base, rev: 'B', status: 'for_review' }); // still a draft
    await svc.issue('ambli', drawUser, { ...base, rev: 'C', status: 'for_review', publish: true }); // ONE-STEP publish

    for (const r of draws[0].revisions.filter((x) => x.status !== 'superseded')) {
      expect(r.recipientsFrozenAt, `rev ${r.rev}`).toBeInstanceOf(Date);
    }
  });

  it('drawing audits carry the role held at action time', async () => {
    const { svc, draws, audits } = make();
    await svc.issue('ambli', drawUser, { ...base, publish: true });
    await svc.issue('ambli', drawUser, { ...base, rev: 'B' });
    const revB = draws[0].revisions.find((r) => r.rev === 'B')!;
    await svc.acknowledge('ambli', revB.id, eng);
    expect(audits.find((a) => a.action === 'drawing.issue')?.actorRole).toBe('pmc');
    expect(audits.find((a) => a.action === 'drawing.revise')?.actorRole).toBe('pmc');
    expect(audits.find((a) => a.action === 'drawing.ack')?.actorRole).toBe('engineer');
  });
});
