import { describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { DrawingsService } from './drawings.service';
import type { PrismaService } from '../prisma.service';
import type { StorageService } from './../media/storage.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { IssueDrawingInput } from '../contracts';

interface Rev { id: string; drawingId: string; status: string; rev: string; storageKey?: string | null; mime: string; data: Buffer | null; url: string | null }
interface Draw { id: string; projectId: string; number: string; title: string; discipline: string; zone?: string | null; activityId?: string | null; decisionId?: string | null; nodeId?: string | null; publishedAt?: Date | null; authorId?: string | null; revisions: Rev[] }
interface NodeRow { id: string; projectId: string }

/** In-memory Prisma stand-in for the drawings tables. Methods mutate synchronously
 *  (before any await) so $transaction preserves supersede-then-create ordering. */
function make(storagePutUrl: string | null = null, nodes: NodeRow[] = [], refs: { activities?: NodeRow[]; decisions?: NodeRow[] } = {}) {
  const draws: Draw[] = [];
  const acks: Array<{ revisionId: string; userId: string; userName?: string; role?: string }> = [];
  let dseq = 0;
  let rseq = 0;
  const prisma = {
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
        const rev: Rev = { id: `r${++rseq}`, drawingId: id, ...(data.revisions.create as Omit<Rev, 'id' | 'drawingId'>) };
        const d: Draw = { id, projectId: data.projectId as string, number: data.number as string, title: data.title as string, discipline: data.discipline as string, zone: data.zone as string, nodeId: (data.nodeId as string) ?? null, publishedAt: (data.publishedAt as Date) ?? null, authorId: (data.authorId as string) ?? null, revisions: [rev] };
        draws.push(d);
        return { ...d };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const d = draws.find((x) => x.id === where.id)!;
        Object.assign(d, data);
        return d;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const i = draws.findIndex((x) => x.id === where.id);
        return draws.splice(i, 1)[0];
      }),
    },
    drawingRevision: {
      updateMany: vi.fn((args: { where: { drawingId: string; status: { not: string } }; data: { status: string } }) => {
        const d = draws.find((x) => x.id === args.where.drawingId);
        d?.revisions.forEach((r) => { if (r.status !== 'superseded') r.status = args.data.status; });
        return Promise.resolve({ count: 0 });
      }),
      create: vi.fn((args: { data: Omit<Rev, 'id'> }) => {
        const rev: Rev = { id: `r${++rseq}`, ...args.data };
        draws.find((x) => x.id === rev.drawingId)?.revisions.push(rev);
        return Promise.resolve(rev);
      }),
      findUnique: vi.fn(async ({ where, include }: { where: { id: string }; include?: { drawing?: boolean } }) => {
        for (const d of draws) {
          const r = d.revisions.find((x) => x.id === where.id);
          if (r) return include?.drawing ? { ...r, drawing: d } : r;
        }
        return null;
      }),
    },
    drawingAck: {
      upsert: vi.fn(async ({ where, create }: { where: { revisionId_userId: { revisionId: string; userId: string } }; update: Record<string, unknown>; create: Record<string, unknown> }) => {
        const key = where.revisionId_userId;
        const i = acks.findIndex((a) => a.revisionId === key.revisionId && a.userId === key.userId);
        if (i >= 0) { Object.assign(acks[i], create); return acks[i]; }
        const row = { ...create } as { revisionId: string; userId: string };
        acks.push(row);
        return row;
      }),
      count: vi.fn(async ({ where }: { where: { revisionId: string } }) => acks.filter((a) => a.revisionId === where.revisionId).length),
    },
    user: { findUnique: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
    projectNode: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => nodes.find((n) => n.id === where.id) ?? null),
    },
    $transaction: (arr: Promise<unknown>[]) => Promise.all(arr),
  };
  const storage = {
    keyFor: vi.fn(() => 'ambli/drawings/x.pdf'),
    put: vi.fn(async () => ({ url: storagePutUrl })),
    publicUrl: vi.fn((k: string) => `https://cdn.vitan.in/${k}`),
    presignPut: vi.fn(async () => (storagePutUrl ? { uploadUrl: 'https://cdn.vitan.in/upload?sig=x', url: storagePutUrl } : null)),
    remove: vi.fn(async () => {}),
  };
  const realtime = { notifyChanged: vi.fn() };
  const snapshot = { build: vi.fn(async () => ({ ok: true })) };
  const svc = new DrawingsService(prisma as unknown as PrismaService, storage as unknown as StorageService, realtime as unknown as RealtimeGateway, snapshot as unknown as SnapshotService);
  return { svc, prisma, storage, realtime, snapshot, draws, acks };
}

const drawUser = { sub: 'u1', role: 'pmc', projectId: 'ambli' } as never;

const base: IssueDrawingInput = { number: 'A-201', title: 'Living Room Flooring Layout', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: Buffer.from('%PDF-1.4').toString('base64') };

describe('DrawingsService.issue', () => {
  it('creates a new register entry as a private draft by default (no team notice)', async () => {
    const { svc, draws, realtime } = make();
    await svc.issue('ambli', 'user-1', base);
    expect(draws).toHaveLength(1);
    expect(draws[0].revisions).toHaveLength(1);
    expect(draws[0].revisions[0].status).toBe('for_construction');
    expect(draws[0].publishedAt).toBeNull(); // it's a draft
    expect(draws[0].authorId).toBe('user-1'); // owned by its creator
    expect(realtime.notifyChanged).not.toHaveBeenCalled(); // a draft notifies no one
  });

  it('issues in one step when publish is set — publishedAt set, build team notified', async () => {
    const { svc, draws, realtime } = make();
    await svc.issue('ambli', 'user-1', { ...base, publish: true });
    expect(draws[0].publishedAt).not.toBeNull();
    expect(realtime.notifyChanged).toHaveBeenCalledWith('ambli', expect.stringContaining('A-201 Rev A'), ['engineer', 'contractor']);
  });

  it('publish() flips a draft drawing live and notifies; re-publishing conflicts', async () => {
    const { svc, draws, realtime } = make();
    await svc.issue('ambli', 'user-1', base); // draft
    const id = draws[0].id;
    expect(realtime.notifyChanged).not.toHaveBeenCalled();

    await svc.publish('ambli', id, drawUser);
    expect(draws[0].publishedAt).not.toBeNull();
    expect(realtime.notifyChanged).toHaveBeenCalledWith('ambli', expect.stringContaining('A-201'), ['engineer', 'contractor']);

    await expect(svc.publish('ambli', id, drawUser)).rejects.toBeInstanceOf(ConflictException);
  });

  it('adds a revision and supersedes the prior one for an existing number', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', 'u1', base);
    await svc.issue('ambli', 'u1', { ...base, rev: 'B', title: 'Living Room Flooring Layout' });

    expect(draws).toHaveLength(1); // same register entry
    const revs = draws[0].revisions;
    expect(revs).toHaveLength(2);
    expect(revs.find((r) => r.rev === 'A')!.status).toBe('superseded');
    expect(revs.find((r) => r.rev === 'B')!.status).toBe('for_construction');
  });

  /**
   * Phase 1 Task 1 — CHARACTERIZATION: today a for_review issue supersedes the
   * for_construction set and becomes the latest non-superseded (i.e. governing)
   * revision, and revision rows carry no projectId. Task 3 deliberately changes
   * both (review copies never supersede; projectId + composite identities) and
   * MUST update these tests in the same PR. Until then, this is the contract.
   */
  it('a for_review issue supersedes the for_construction revision and becomes current (replaced by Task 3)', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', 'u1', base); // Rev A, for_construction
    await svc.issue('ambli', 'u1', { ...base, rev: 'B', status: 'for_review' });

    const revs = draws[0].revisions;
    expect(revs.find((r) => r.rev === 'A')!.status).toBe('superseded'); // the construction set was displaced
    expect(revs.find((r) => r.rev === 'B')!.status).toBe('for_review'); // ...by a review copy
    // `current` derivation = latest non-superseded regardless of status, so the
    // review copy now governs — the invariant Task 3 introduces does not exist yet
    expect(revs.filter((r) => r.status !== 'superseded')).toHaveLength(1);
    expect(revs.find((r) => r.status !== 'superseded')!.rev).toBe('B');
  });

  it('revision rows carry NO projectId — no composite tenant identity exists on DrawingRevision (replaced by Task 3)', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', 'u1', base);
    expect('projectId' in draws[0].revisions[0]).toBe(false);
  });

  it('accepts a presigned storageKey (skips put, records the bucket pointer, stores no public url)', async () => {
    const { svc, draws, storage } = make();
    await svc.issue('ambli', 'pmc-1', { ...base, data: undefined as never, storageKey: 'ambli/drawings/big.pdf', sizeBytes: 9_000_000 });
    expect(storage.put).not.toHaveBeenCalled();
    const rev = draws[0].revisions[0];
    expect(rev.storageKey).toBe('ambli/drawings/big.pdf');
    expect(rev.url).toBeNull(); // private delivery: never persist the public bucket url
    expect(rev.data).toBeNull();
  });

  it('rejects a storageKey that belongs to another project (cross-project drawing read)', async () => {
    const { svc } = make();
    await expect(
      svc.issue('ambli', 'pmc-1', { ...base, data: undefined as never, storageKey: 'villa/drawings/secret.pdf', sizeBytes: 100 }),
    ).rejects.toThrow(/does not belong to this project/);
  });

  it('S3 mode drops the bytes and stores no public url; dev stub keeps the bytes', async () => {
    const s3 = make('https://cdn.vitan.in/ambli/drawings/x.pdf');
    await s3.svc.issue('ambli', 'u1', base);
    expect(s3.draws[0].revisions[0].url).toBeNull(); // private delivery
    expect(s3.draws[0].revisions[0].data).toBeNull();
    expect(s3.draws[0].revisions[0].storageKey).toBe('ambli/drawings/x.pdf');

    const stub = make(null);
    await stub.svc.issue('ambli', 'u1', base);
    expect(stub.draws[0].revisions[0].url).toBeNull();
    expect(stub.draws[0].revisions[0].data).toBeInstanceOf(Buffer);
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

  it('records a build-acknowledgement and notifies the PMC', async () => {
    const { svc, draws, acks, realtime } = make();
    await svc.issue('ambli', 'pmc-1', base);
    const revId = draws[0].revisions[0].id;

    const res = await svc.acknowledge('ambli', revId, asUser('contractor'));
    expect(res).toEqual({ ok: true, ackCount: 1 });
    expect(acks).toHaveLength(1);
    expect(realtime.notifyChanged).toHaveBeenLastCalledWith('ambli', expect.stringContaining('building to A-201 Rev A'), ['pmc']);
  });

  it('is idempotent per (revision, user)', async () => {
    const { svc, draws, acks } = make();
    await svc.issue('ambli', 'pmc-1', base);
    const revId = draws[0].revisions[0].id;
    await svc.acknowledge('ambli', revId, asUser('engineer', 'u1'));
    await svc.acknowledge('ambli', revId, asUser('engineer', 'u1'));
    expect(acks).toHaveLength(1);
  });

  it('refuses the client (they do not build)', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', 'pmc-1', base);
    const revId = draws[0].revisions[0].id;
    await expect(svc.acknowledge('ambli', revId, asUser('client'))).rejects.toThrow();
  });

  it('refuses a revision from another project (tenant isolation)', async () => {
    const { svc, draws } = make();
    await svc.issue('ambli', 'pmc-1', base);
    const revId = draws[0].revisions[0].id;
    await expect(svc.acknowledge('other', revId, asUser('contractor'))).rejects.toThrow();
  });
});

describe('DrawingsService.remove', () => {
  it('deletes a drawing in the project and refuses one from another project', async () => {
    const { svc, draws, storage } = make();
    await svc.issue('ambli', 'u1', base);
    const id = draws[0].id;

    expect(await svc.remove(id, 'other')).toBe(false); // tenant isolation
    expect(draws).toHaveLength(1);

    expect(await svc.remove(id, 'ambli')).toBe(true);
    expect(draws).toHaveLength(0);
    expect(storage.remove).toHaveBeenCalled();
  });
});

describe('DrawingsService — location spine (nodeId)', () => {
  it('files a drawing on a valid node at issue', async () => {
    const { svc, draws } = make(null, [{ id: 'z1', projectId: 'ambli' }]);
    await svc.issue('ambli', 'u1', { ...base, nodeId: 'z1' });
    expect(draws[0].nodeId).toBe('z1');
  });

  it('rejects a drawing filed to another project’s node', async () => {
    const { svc } = make(null, [{ id: 'z1', projectId: 'other' }]);
    await expect(svc.issue('ambli', 'u1', { ...base, nodeId: 'z1' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('setNode re-files a drawing and returns a snapshot', async () => {
    const { svc, draws, snapshot } = make(null, [{ id: 'r1', projectId: 'ambli' }]);
    await svc.issue('ambli', 'u1', base);
    const id = draws[0].id;
    const out = await svc.setNode(id, 'ambli', 'r1', drawUser);
    expect(draws[0].nodeId).toBe('r1');
    expect(snapshot.build).toHaveBeenCalled();
    expect(out).toEqual({ ok: true });
  });

  it('setNode with null unfiles, and refuses a drawing from another project', async () => {
    const { svc, draws } = make(null, [{ id: 'r1', projectId: 'ambli' }]);
    await svc.issue('ambli', 'u1', { ...base, nodeId: 'r1' });
    const id = draws[0].id;
    await svc.setNode(id, 'ambli', null, drawUser);
    expect(draws[0].nodeId).toBeNull();
    await expect(svc.setNode(id, 'other', null, drawUser)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('DrawingsService — project-owned references (Phase 0 Task 5)', () => {
  const base: IssueDrawingInput = { number: 'A-201', title: 'Plan', discipline: 'Architecture', rev: 'P1', status: 'for_review', mime: 'application/pdf', data: Buffer.from('pdf').toString('base64'), publish: true };

  it('rejects a forged activityId from another project', async () => {
    const { svc } = make(null, [], { activities: [{ id: 'ACT-9', projectId: 'other' }] });
    await expect(svc.issue('ambli', 'u1', { ...base, activityId: 'ACT-9' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a forged decisionId from another project', async () => {
    const { svc } = make(null, [], { decisions: [{ id: 'DL-9', projectId: 'other' }] });
    await expect(svc.issue('ambli', 'u1', { ...base, decisionId: 'DL-9' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts same-project activity + decision links', async () => {
    const { svc, prisma } = make(null, [], {
      activities: [{ id: 'ACT-1', projectId: 'ambli' }],
      decisions: [{ id: 'DL-1', projectId: 'ambli' }],
    });
    await svc.issue('ambli', 'u1', { ...base, activityId: 'ACT-1', decisionId: 'DL-1' });
    const row = prisma.drawing.create.mock.calls[0][0].data;
    expect(row.activityId).toBe('ACT-1');
    expect(row.decisionId).toBe('DL-1');
  });
});
