import { describe, it, expect, vi } from 'vitest';
import { NotFoundException, BadRequestException, ConflictException, ForbiddenException, GoneException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MediaService } from './media.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { DailyLogQueryService } from '../daily-log/daily-log.query';
import type { InspectionsQueryService } from '../inspections/inspections.query';
import type { InspectionParticipant } from '../inspections/inspection.participant';
import type { InventoryParticipant } from '../inventory/inventory.participant';
import type { LabourRequirementParticipant } from '../labour/labour.participant';
import type { ActivityParticipant } from '../activities/activity.participant';
import type { CommercialParticipant } from '../commercial/commercial.participant';
import type { PrismaService } from '../prisma.service';
import type { StorageService } from './storage.service';
import type { SignedUrlService } from './signed-url.service';
import type { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { CreateMediaInput } from '../contracts';
import { answerActorEnvelope } from '../../test/unit-support/actor-envelope-stub';

// a node without `publishedAt` is a published place; `publishedAt: null` is a private draft of `authorId`
interface NodeRow { id: string; projectId: string; publishedAt?: Date | null; authorId?: string | null }
interface RefRow { id: string; projectId: string }

function make(
  storagePutUrl: string | null,
  presignedGet: string | null = null,
  nodes: NodeRow[] = [],
  refs: { decisions?: RefRow[]; dailyLogs?: RefRow[] } = {},
) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    decision: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId: string } }) =>
        (refs.decisions ?? []).find((r) => r.id === where.id && r.projectId === where.projectId) ?? null),
    },
    dailyLog: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId: string } }) =>
        (refs.dailyLogs ?? []).find((r) => r.id === where.id && r.projectId === where.projectId) ?? null),
    },
    media: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'med1', createdAt: new Date('2026-10-19T09:30:00.000Z'), ...data };
        created.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === 'med1' ? { id: 'med1', projectId: 'ambli' } : null)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'med1', ...data })),
      delete: vi.fn(async () => ({})),
    },
    // #482 — no key here was ever retired
    mediaTombstone: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    projectNode: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const n = nodes.find((x) => x.id === where.id);
        return n ? { publishedAt: new Date(), authorId: null, ...n } : null;
      }),
    },
    // resolveActor (Task 3) + the platform event kernel (Task 4) now run inside these mutations
    user: { findUnique: vi.fn(async () => ({ name: 'Tester' })) },
    project: { findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org-test' })) },
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
    // 4d-ii-a / A1 — emitEvent resolves the actor envelope from the platform registers; no rows
    // here means no standing is proven, so the event is written with a NULL pair.
    $queryRaw: vi.fn(answerActorEnvelope(async () => [])),
    // 4d-ii-a / A6d — materializeDeliveries takes the registration key SHARED and reads the
    // catalog (`$queryRaw` above answers with no rows, so no delivery is written in-memory)
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[])),
  };
  const storage = {
    keyFor: vi.fn(() => 'ambli/progress/med1.jpg'),
    put: vi.fn(async () => ({ url: storagePutUrl })),
    presignGet: vi.fn(async () => presignedGet),
    remove: vi.fn(async () => {}),
  };
  const signed = { mediaPath: vi.fn((id: string) => `/media/${id}?t=tok`) };
  const dispatcher = { dispatchCommitted: vi.fn() };
  const snapshot = { build: vi.fn(async () => ({ ok: true })) };
  // Task 10 (Module 3) — an evidence target is validated through the inspections query, and item evidence
  // is linked/unlinked through the inspections participant; the unit under test doesn't upload item
  // evidence, so null-returning stubs suffice (remove() just proceeds with its own media.removed event).
  const inspections = { assertEvidenceTarget: vi.fn(async () => {}) } as unknown as InspectionsQueryService;
  const inspectionParticipant = {
    addEvidence: vi.fn(async () => ({ eventId: 'ev-add' })),
    removeEvidence: vi.fn(async () => null),
    // #571 round 9, finding 1 — the binding-assignment authority for evidence mutation. Permissive
    // in this stub: these probes are about DELETE ORDERING, and the authority rule has its own
    // live-PostgreSQL probes where a real assignment can exist.
    assertEvidenceMutable: vi.fn(async () => undefined),
    assertEvidenceDisposable: vi.fn(async () => undefined),
  } as unknown as InspectionParticipant;
  // Phase 3 Task 4 — no media under test is stock-ledger evidence, so the guard passes.
  const inventoryParticipant = { assertMediaDisposable: vi.fn(async () => {}) } as unknown as InventoryParticipant;
  // Phase 4 Task 3 correction (F2) — the delete tx also asks LABOUR whether the photo is cited as
  // presence evidence; the live refusal has its own probe in `phase4-t3-correction.test.ts`.
  const labourParticipant = { assertMediaDisposable: vi.fn(async () => {}) } as unknown as LabourRequirementParticipant;
  // Phase 4 Task 5 (§I) — the delete tx also asks ACTIVITIES whether the photo is cited as
  // measured-output evidence; the live refusal has its own probe in the Task-5 suite.
  const activityParticipant = { assertMediaDisposable: vi.fn(async () => {}) } as unknown as ActivityParticipant;
  // Phase 5 Task 3 (§D) — and whether it is cited as MEASUREMENT evidence; the live refusal has
  // its own probe (R14) in `phase5-t3-measurement.test.ts`.
  const commercialParticipant = { assertMediaDisposable: vi.fn(async () => {}) } as unknown as CommercialParticipant;
  const svc = new MediaService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    signed as unknown as SignedUrlService,
    dispatcher as unknown as ExternalEffectDispatcher,
    snapshot as unknown as SnapshotService,
    new DecisionsQueryService(prisma as unknown as PrismaService, new OrgsParticipant()),
    // Task 10 — a linked daily-log reference is validated through the daily-log query (same prisma mock).
    new DailyLogQueryService(prisma as unknown as PrismaService),
    inspections,
    inspectionParticipant,
    inventoryParticipant,
    labourParticipant,
    activityParticipant,
    commercialParticipant,
    // #792 SV2 — no upload here names a site visit, and no photo here is on one; both have their live suite
    { assertMediaDisposable: vi.fn(async () => {}) } as unknown as SiteVisitFilesParticipant,
  );
  return { svc, prisma, storage, signed, dispatcher, snapshot, created, inventoryParticipant, labourParticipant, commercialParticipant };
}

const user = { sub: 'u1', role: 'pmc', projectId: 'ambli' } as never;
// create() now takes the AuthUser (sub becomes uploadedBy); remove() derives projectId from it
const uploader = { sub: 'user-1', role: 'pmc', projectId: 'ambli' } as never;

const input: CreateMediaInput = { kind: 'progress', mime: 'image/jpeg', data: Buffer.from('hello').toString('base64') };

describe('MediaService.create', () => {
  it('dev stub: keeps bytes in the row and returns a signed serve path (no public url stored)', async () => {
    const { svc, prisma, dispatcher } = make(null);
    const res = await svc.create('ambli', uploader, input);

    expect(res).toEqual({ id: 'med1', url: '/media/med1?t=tok', at: '2026-10-19T09:30:00.000Z' });
    const row = prisma.media.create.mock.calls[0][0].data;
    expect(row.data).toBeInstanceOf(Buffer);
    expect(row.data.toString()).toBe('hello');
    expect(row.url).toBeNull(); // never persist a public bucket URL
    expect(row.sizeBytes).toBe(5);
    expect(row.uploadedBy).toBe('user-1');
    // the fresh upload hands its committed event to the single sender exactly once (signal-only)
    expect(dispatcher.dispatchCommitted).toHaveBeenCalledTimes(1);
  });

  it('S3 mode: drops the bytes, stores NO public url, and returns a signed serve path', async () => {
    const { svc, prisma } = make('https://cdn.vitan.in/ambli/progress/med1.jpg');
    const res = await svc.create('ambli', uploader, input);

    expect(res.url).toBe('/media/med1?t=tok'); // signed path, not the bucket url
    const row = prisma.media.create.mock.calls[0][0].data;
    expect(row.data).toBeNull(); // bytes went to the bucket
    expect(row.url).toBeNull(); // public bucket url is never stored (private delivery)
    expect(row.storageKey).toBe('ambli/progress/med1.jpg');
  });
});

describe('MediaService.fetch', () => {
  it('returns bytes for a stub row', async () => {
    const { svc, prisma } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', mime: 'image/png', data: Buffer.from('x'), storageKey: 'k', url: null });
    expect(await svc.fetch('m')).toEqual({ mime: 'image/png', bytes: Buffer.from('x') });
  });

  it('presigns a private-bucket GET for an S3 row (never exposes the object url)', async () => {
    const { svc, prisma, storage } = make(null, 'https://cdn/ambli/x.jpg?sig=abc');
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', mime: 'image/png', data: null, storageKey: 'ambli/x.jpg', url: null });
    expect(await svc.fetch('m')).toEqual({ redirect: 'https://cdn/ambli/x.jpg?sig=abc' });
    expect(storage.presignGet).toHaveBeenCalledWith('ambli/x.jpg');
  });

  it('falls back to a legacy public url row, and returns null when missing', async () => {
    const { svc, prisma } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', mime: 'image/png', data: null, storageKey: null, url: 'https://cdn/x.png' });
    expect(await svc.fetch('m')).toEqual({ redirect: 'https://cdn/x.png' });

    prisma.media.findUnique.mockResolvedValueOnce(null);
    expect(await svc.fetch('missing')).toBeNull();
  });
});

describe('MediaService.remove', () => {
  it('deletes the bucket object + row for a media in the caller’s project', async () => {
    const { svc, prisma, storage, dispatcher } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', projectId: 'ambli', storageKey: 'ambli/progress/m.jpg' });

    expect(await svc.remove('m', user)).toBe(true);
    expect(storage.remove).toHaveBeenCalledWith('ambli/progress/m.jpg');
    expect(prisma.media.delete).toHaveBeenCalledWith({ where: { id: 'm' } });
    expect(dispatcher.dispatchCommitted).toHaveBeenCalledTimes(1);
  });

  it('a keyed photo\'s delete writes no record itself: the database writes it in the delete\'s statement (#482)', async () => {
    const { svc, prisma } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', projectId: 'ambli', storageKey: 'ambli/progress/m.jpg', clientKey: 'k' });
    expect(await svc.remove('m', user)).toBe(true);
    expect(prisma.media.delete).toHaveBeenCalledWith({ where: { id: 'm' } });
    expect(prisma.mediaTombstone.create).not.toHaveBeenCalled();
  });

  it('refuses to delete media from another project (tenant isolation)', async () => {
    const { svc, prisma, storage } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', projectId: 'other', storageKey: 'k' });

    expect(await svc.remove('m', user)).toBe(false);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(prisma.media.delete).not.toHaveBeenCalled();
  });

  it('returns false when the media does not exist', async () => {
    const { svc, prisma } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce(null);
    expect(await svc.remove('missing', user)).toBe(false);
  });
});

/**
 * Phase 4 Task 3 correction ROUND 2, finding 2 — DELETION ORDERING.
 *
 * The bucket object was removed BEFORE the transaction that decides whether the delete is even
 * allowed. A participant refusal (labour presence evidence, inventory ledger evidence) therefore
 * left the database row intact and its bytes already gone — the row still cites evidence that no
 * longer exists, which is precisely the state the append-only rule exists to prevent. Storage is
 * the LAST step and only on the success path, where it is a best-effort cleanup of an object the
 * database no longer references.
 */
describe('MediaService.remove — evidence deletion ordering', () => {
  it('a LABOUR refusal leaves both the row and the storage object untouched (storage.remove never called)', async () => {
    const { svc, prisma, storage, dispatcher, labourParticipant } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', projectId: 'ambli', storageKey: 'ambli/attendance/m.jpg' });
    // the photo is cited as presence evidence — the owning module refuses the delete
    (labourParticipant.assertMediaDisposable as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException('this photo is attendance evidence'),
    );

    await expect(svc.remove('m', user)).rejects.toBeInstanceOf(ConflictException);

    // RED before the fix: storage.remove had already run, so the bytes were gone while the row —
    // and the muster citing it — survived.
    expect(storage.remove, 'a refused delete must not touch the bucket').not.toHaveBeenCalled();
    expect(prisma.media.delete).not.toHaveBeenCalled();
    expect(dispatcher.dispatchCommitted).not.toHaveBeenCalled();
  });

  it('an INVENTORY refusal likewise leaves the bucket object in place', async () => {
    const { svc, prisma, storage, inventoryParticipant } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', projectId: 'ambli', storageKey: 'ambli/stock/m.jpg' });
    (inventoryParticipant.assertMediaDisposable as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ConflictException('this photo is stock quality evidence'),
    );

    await expect(svc.remove('m', user)).rejects.toBeInstanceOf(ConflictException);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(prisma.media.delete).not.toHaveBeenCalled();
  });

  it('on the success path the DATABASE row is deleted first, and only then the object is cleaned up', async () => {
    const { svc, prisma, storage } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', projectId: 'ambli', storageKey: 'ambli/progress/m.jpg' });

    expect(await svc.remove('m', user)).toBe(true);
    expect(prisma.media.delete).toHaveBeenCalledWith({ where: { id: 'm' } });
    expect(storage.remove).toHaveBeenCalledWith('ambli/progress/m.jpg');
    // ordering, not merely both-happened: the commit precedes the best-effort object cleanup
    expect(prisma.media.delete.mock.invocationCallOrder[0]).toBeLessThan(storage.remove.mock.invocationCallOrder[0]);
  });

  it('a failed bucket cleanup does NOT fail the delete — the row is already gone and stays gone', async () => {
    const { svc, prisma, storage } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', projectId: 'ambli', storageKey: 'ambli/progress/m.jpg' });
    storage.remove.mockRejectedValueOnce(new Error('bucket unreachable'));

    expect(await svc.remove('m', user)).toBe(true);
    expect(prisma.media.delete).toHaveBeenCalledWith({ where: { id: 'm' } });
  });
});

describe('MediaService — a replayed upload key (#482)', () => {
  const contractor = { sub: 'c1', role: 'contractor', projectId: 'ambli' } as never;
  const p2002 = (target: unknown = ['projectId', 'clientKey']) => new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test', meta: { target } });

  it('a concurrent replay onto another member\'s evidence is refused, and this request\'s object is cleaned up', async () => {
    const { svc, prisma, storage } = make(null);
    prisma.media.create.mockRejectedValueOnce(p2002());
    Object.assign(prisma.media, {
      findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'pmc-evidence', createdAt: new Date('2026-10-19T09:30:00.000Z'), kind: 'material', uploadedBy: 'pmc-1', decisionId: null, dailyLogId: null, inspectionId: null, inspectionItemId: null }),
      findFirst: vi.fn(async () => null),
    });
    await expect(svc.create('ambli', contractor, { ...input, clientKey: 'k' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(storage.remove).toHaveBeenCalledWith('ambli/progress/med1.jpg');
  });

  it('a concurrent replay of the caller\'s own plain photo returns that row, and cleans up this request\'s object', async () => {
    const { svc, prisma, storage } = make(null);
    prisma.media.create.mockRejectedValueOnce(p2002());
    Object.assign(prisma.media, {
      findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'own', createdAt: new Date('2026-10-19T09:30:00.000Z'), kind: 'progress', uploadedBy: 'c1', decisionId: null, dailyLogId: null, inspectionId: null, inspectionItemId: null }),
      findFirst: vi.fn(async () => null),
    });
    expect(await svc.create('ambli', contractor, { ...input, clientKey: 'k' })).toEqual({ id: 'own', url: '/media/own?t=tok', at: '2026-10-19T09:30:00.000Z' });
    // the winner's row points at the winner's object; this request's own key is unreferenced
    expect(prisma.media.findFirst).toHaveBeenCalledWith({ where: { projectId: 'ambli', storageKey: 'ambli/progress/med1.jpg' }, select: { id: true } });
    expect(storage.remove).toHaveBeenCalledWith('ambli/progress/med1.jpg');
  });

  it('a concurrent replay whose winner was deleted before it could be read is answered 410, and this request\'s object is cleaned up', async () => {
    const { svc, prisma, storage } = make(null);
    prisma.media.create.mockRejectedValueOnce(p2002());
    Object.assign(prisma.media, { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) });
    // the fast read before the bytes finds no record; the read after the conflict does (the winner's delete wrote it)
    prisma.mediaTombstone.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce({ projectId: 'ambli', clientKey: 'k' });
    await expect(svc.create('ambli', contractor, { ...input, clientKey: 'k' })).rejects.toBeInstanceOf(GoneException);
    expect(storage.remove).toHaveBeenCalledWith('ambli/progress/med1.jpg');
  });

  it('a conflict with no winner and no record of the key is not "deleted": the original error stands, after the cleanup', async () => {
    const { svc, prisma, storage } = make(null);
    const conflict = p2002();
    prisma.media.create.mockRejectedValueOnce(conflict);
    Object.assign(prisma.media, { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) });
    await expect(svc.create('ambli', contractor, { ...input, clientKey: 'k' })).rejects.toBe(conflict);
    expect(storage.remove).toHaveBeenCalledWith('ambli/progress/med1.jpg');
  });

  it('a conflict on another unique is never read as a replay or a deleted photo', async () => {
    const { svc, prisma, storage } = make(null);
    const conflict = p2002(['storageKey']);
    prisma.media.create.mockRejectedValueOnce(conflict);
    Object.assign(prisma.media, { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) });
    await expect(svc.create('ambli', contractor, { ...input, clientKey: 'k' })).rejects.toBe(conflict);
    expect(prisma.media.findUnique).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith('ambli/progress/med1.jpg');
  });

  it('the database\'s refusal of a deleted key (MT410) is answered 410, after the same cleanup', async () => {
    const { svc, prisma, storage } = make(null);
    prisma.media.create.mockRejectedValueOnce(new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution: ConnectorError(... PostgresError { code: "MT410", message: "media: this photo was deleted (ambli, k)" ...', { clientVersion: 'test' }));
    Object.assign(prisma.media, { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) });
    await expect(svc.create('ambli', contractor, { ...input, clientKey: 'k' })).rejects.toBeInstanceOf(GoneException);
    expect(storage.remove).toHaveBeenCalledWith('ambli/progress/med1.jpg');
  });

  it('only MT410 itself is a deleted photo: the guard\'s isolation refusal (MTISO) stays a server error, never a 4xx', async () => {
    // a 4xx is final on the web and would drop a photo that was never deleted; a 5xx is kept and sent again
    for (const err of [
      new Prisma.PrismaClientUnknownRequestError(
        'Error occurred during query execution: ConnectorError(... PostgresError { code: "MTISO", message: "media: a photo with a send key is stored only under READ COMMITTED, not repeatable read" ...', { clientVersion: 'test' }),
      new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: 'test', meta: { code: 'MTISO' } }),
      new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: 'test', meta: { code: 'MT41' } }),
    ]) {
      const { svc, prisma, storage } = make(null);
      prisma.media.create.mockRejectedValueOnce(err);
      Object.assign(prisma.media, { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) });
      await expect(svc.create('ambli', contractor, { ...input, clientKey: 'k' })).rejects.toBe(err);
      expect(storage.remove).toHaveBeenCalledWith('ambli/progress/med1.jpg');
    }
  });

  it('a concurrent replay keeps this request\'s object when a row still references it', async () => {
    const { svc, prisma, storage } = make(null);
    prisma.media.create.mockRejectedValueOnce(p2002());
    Object.assign(prisma.media, {
      findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ id: 'own', createdAt: new Date('2026-10-19T09:30:00.000Z'), kind: 'progress', uploadedBy: 'c1', decisionId: null, dailyLogId: null, inspectionId: null, inspectionItemId: null }),
      findFirst: vi.fn(async () => ({ id: 'own' })),
    });
    expect(await svc.create('ambli', contractor, { ...input, clientKey: 'k' })).toEqual({ id: 'own', url: '/media/own?t=tok', at: '2026-10-19T09:30:00.000Z' });
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe('MediaService — location spine (nodeId)', () => {
  it('stores a valid nodeId with the photo', async () => {
    const { svc, prisma } = make(null, null, [{ id: 'r1', projectId: 'ambli' }]);
    await svc.create('ambli', uploader, { ...input, nodeId: 'r1' });
    expect(prisma.media.create.mock.calls[0][0].data.nodeId).toBe('r1');
  });

  it('refuses another author\'s private draft BEFORE storing any bytes', async () => {
    const { svc, prisma, storage } = make(null, null, [{ id: 'd1', projectId: 'ambli', publishedAt: null, authorId: 'someone-else' }]);
    await expect(svc.create('ambli', uploader, { ...input, nodeId: 'd1' })).rejects.toBeInstanceOf(BadRequestException);
    // the early no: nothing reaches the bucket, so nothing can be orphaned
    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.media.create).not.toHaveBeenCalled();
  });

  it('still decides inside the transaction: a place hidden after the early check is refused and its object cleaned up', async () => {
    const { svc, prisma, storage } = make(null, null, [{ id: 'd1', projectId: 'ambli', publishedAt: new Date(), authorId: 'someone-else' }]);
    Object.assign(prisma.media, { findFirst: vi.fn(async () => null) });
    // the preflight sees it published; by the locked read it is another author's draft again
    prisma.projectNode.findUnique
      .mockResolvedValueOnce({ id: 'd1', projectId: 'ambli', publishedAt: new Date(), authorId: 'someone-else' })
      .mockResolvedValueOnce({ id: 'd1', projectId: 'ambli', publishedAt: null, authorId: 'someone-else' });
    await expect(svc.create('ambli', uploader, { ...input, nodeId: 'd1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(prisma.media.create).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith('ambli/progress/med1.jpg');
  });

  it('refuses the uploader\'s own private draft too: a team photo never goes on a draft', async () => {
    const { svc, prisma, storage } = make(null, null, [{ id: 'd1', projectId: 'ambli', publishedAt: null, authorId: 'user-1' }]);
    await expect(svc.create('ambli', uploader, { ...input, nodeId: 'd1' })).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.media.create).not.toHaveBeenCalled();
  });

  it('rejects a photo pinned to another project’s node', async () => {
    const { svc } = make(null, null, [{ id: 'r1', projectId: 'other' }]);
    await expect(svc.create('ambli', uploader, { ...input, nodeId: 'r1' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('setNode refuses another author\'s private draft and writes nothing', async () => {
    const { svc, prisma } = make(null, null, [{ id: 'd1', projectId: 'ambli', publishedAt: null, authorId: 'someone-else' }]);
    await expect(svc.setNode('med1', 'ambli', 'd1', user)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.media.update).not.toHaveBeenCalled();
  });

  it('setNode re-files onto a node and returns a snapshot', async () => {
    const { svc, prisma, snapshot } = make(null, null, [{ id: 'r1', projectId: 'ambli' }]);
    const out = await svc.setNode('med1', 'ambli', 'r1', user);
    expect(prisma.media.update).toHaveBeenCalledWith({ where: { id: 'med1' }, data: { nodeId: 'r1' } });
    expect(snapshot.build).toHaveBeenCalled();
    expect(out).toEqual({ ok: true });
  });

  it('setNode with null unfiles the photo', async () => {
    const { svc, prisma } = make(null);
    await svc.setNode('med1', 'ambli', null, user);
    expect(prisma.media.update).toHaveBeenCalledWith({ where: { id: 'med1' }, data: { nodeId: null } });
  });

  it('setNode answers a photo on someone else\'s private draft as not found and writes nothing', async () => {
    const { svc, prisma } = make(null, null, [{ id: 'r1', projectId: 'ambli' }]);
    // the photo sits on a draft the caller did not author (filed before #881)
    for (let i = 0; i < 2; i++) prisma.media.findUnique.mockResolvedValueOnce({ id: 'med1', projectId: 'ambli' }).mockResolvedValueOnce({ nodeId: 'd1' });
    (prisma.projectNode as unknown as { findFirst: unknown }).findFirst = vi.fn(async () => ({ id: 'd1' }));
    await expect(svc.setNode('med1', 'ambli', 'r1', user)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.setNode('med1', 'ambli', null, user)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.media.update).not.toHaveBeenCalled();
  });

  it('setNode refuses media from another project', async () => {
    const { svc, prisma } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'med1', projectId: 'other' });
    await expect(svc.setNode('med1', 'ambli', null, user)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MediaService — project-owned references (Phase 0 Task 5)', () => {
  it('rejects a forged decisionId from another project', async () => {
    const { svc } = make(null, null, [], { decisions: [{ id: 'DL-9', projectId: 'other' }] });
    await expect(svc.create('ambli', uploader, { ...input, decisionId: 'DL-9' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a forged dailyLogId from another project', async () => {
    const { svc } = make(null, null, [], { dailyLogs: [{ id: 'log-9', projectId: 'other' }] });
    await expect(svc.create('ambli', uploader, { ...input, dailyLogId: 'log-9' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts same-project decision + daily-log references', async () => {
    const { svc, prisma } = make(null, null, [], {
      decisions: [{ id: 'DL-1', projectId: 'ambli' }],
      dailyLogs: [{ id: 'log-1', projectId: 'ambli' }],
    });
    await svc.create('ambli', uploader, { ...input, decisionId: 'DL-1', dailyLogId: 'log-1' });
    const row = prisma.media.create.mock.calls[0][0].data;
    expect(row.decisionId).toBe('DL-1');
    expect(row.dailyLogId).toBe('log-1');
  });
});
