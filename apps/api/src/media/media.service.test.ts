import { describe, it, expect, vi } from 'vitest';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { MediaService } from './media.service';
import type { PrismaService } from '../prisma.service';
import type { StorageService } from './storage.service';
import type { SignedUrlService } from './signed-url.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { CreateMediaInput } from '../contracts';

interface NodeRow { id: string; projectId: string }

function make(storagePutUrl: string | null, presignedGet: string | null = null, nodes: NodeRow[] = []) {
  const created: Record<string, unknown>[] = [];
  const prisma = {
    media: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'med1', ...data };
        created.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === 'med1' ? { id: 'med1', projectId: 'ambli' } : null)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'med1', ...data })),
      delete: vi.fn(async () => ({})),
    },
    projectNode: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => nodes.find((n) => n.id === where.id) ?? null),
    },
  };
  const storage = {
    keyFor: vi.fn(() => 'ambli/progress/med1.jpg'),
    put: vi.fn(async () => ({ url: storagePutUrl })),
    presignGet: vi.fn(async () => presignedGet),
    remove: vi.fn(async () => {}),
  };
  const signed = { mediaPath: vi.fn((id: string) => `/media/${id}?t=tok`) };
  const realtime = { notifyChanged: vi.fn() };
  const snapshot = { build: vi.fn(async () => ({ ok: true })) };
  const svc = new MediaService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    signed as unknown as SignedUrlService,
    realtime as unknown as RealtimeGateway,
    snapshot as unknown as SnapshotService,
  );
  return { svc, prisma, storage, signed, realtime, snapshot, created };
}

const user = { sub: 'u1', role: 'pmc', projectId: 'ambli' } as never;

const input: CreateMediaInput = { kind: 'progress', mime: 'image/jpeg', data: Buffer.from('hello').toString('base64') };

describe('MediaService.create', () => {
  it('dev stub: keeps bytes in the row and returns a signed serve path (no public url stored)', async () => {
    const { svc, prisma, realtime } = make(null);
    const res = await svc.create('ambli', 'user-1', input);

    expect(res).toEqual({ id: 'med1', url: '/media/med1?t=tok' });
    const row = prisma.media.create.mock.calls[0][0].data;
    expect(row.data).toBeInstanceOf(Buffer);
    expect(row.data.toString()).toBe('hello');
    expect(row.url).toBeNull(); // never persist a public bucket URL
    expect(row.sizeBytes).toBe(5);
    expect(row.uploadedBy).toBe('user-1');
    expect(realtime.notifyChanged).toHaveBeenCalledWith('ambli');
  });

  it('S3 mode: drops the bytes, stores NO public url, and returns a signed serve path', async () => {
    const { svc, prisma } = make('https://cdn.vitan.in/ambli/progress/med1.jpg');
    const res = await svc.create('ambli', 'user-1', input);

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
    const { svc, prisma, storage, realtime } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', projectId: 'ambli', storageKey: 'ambli/progress/m.jpg' });

    expect(await svc.remove('m', 'ambli')).toBe(true);
    expect(storage.remove).toHaveBeenCalledWith('ambli/progress/m.jpg');
    expect(prisma.media.delete).toHaveBeenCalledWith({ where: { id: 'm' } });
    expect(realtime.notifyChanged).toHaveBeenCalledWith('ambli');
  });

  it('refuses to delete media from another project (tenant isolation)', async () => {
    const { svc, prisma, storage } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', projectId: 'other', storageKey: 'k' });

    expect(await svc.remove('m', 'ambli')).toBe(false);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(prisma.media.delete).not.toHaveBeenCalled();
  });

  it('returns false when the media does not exist', async () => {
    const { svc, prisma } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce(null);
    expect(await svc.remove('missing', 'ambli')).toBe(false);
  });
});

describe('MediaService — location spine (nodeId)', () => {
  it('stores a valid nodeId with the photo', async () => {
    const { svc, prisma } = make(null, null, [{ id: 'r1', projectId: 'ambli' }]);
    await svc.create('ambli', 'user-1', { ...input, nodeId: 'r1' });
    expect(prisma.media.create.mock.calls[0][0].data.nodeId).toBe('r1');
  });

  it('rejects a photo pinned to another project’s node', async () => {
    const { svc } = make(null, null, [{ id: 'r1', projectId: 'other' }]);
    await expect(svc.create('ambli', 'user-1', { ...input, nodeId: 'r1' })).rejects.toBeInstanceOf(BadRequestException);
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

  it('setNode refuses media from another project', async () => {
    const { svc, prisma } = make(null);
    prisma.media.findUnique.mockResolvedValueOnce({ id: 'med1', projectId: 'other' });
    await expect(svc.setNode('med1', 'ambli', null, user)).rejects.toBeInstanceOf(NotFoundException);
  });
});
