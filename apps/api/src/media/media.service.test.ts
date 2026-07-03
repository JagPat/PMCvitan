import { describe, it, expect, vi } from 'vitest';
import { MediaService } from './media.service';
import type { PrismaService } from '../prisma.service';
import type { StorageService } from './storage.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';
import type { CreateMediaInput } from '../contracts';

function make(storagePutUrl: string | null) {
  const created: unknown[] = [];
  const prisma = {
    media: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: 'med1', ...data };
        created.push(row);
        return row;
      }),
      findUnique: vi.fn(),
    },
  };
  const storage = {
    keyFor: vi.fn(() => 'ambli/progress/med1.jpg'),
    put: vi.fn(async () => ({ url: storagePutUrl })),
  };
  const realtime = { notifyChanged: vi.fn() };
  const svc = new MediaService(
    prisma as unknown as PrismaService,
    storage as unknown as StorageService,
    realtime as unknown as RealtimeGateway,
  );
  return { svc, prisma, storage, realtime };
}

const input: CreateMediaInput = { kind: 'progress', mime: 'image/jpeg', data: Buffer.from('hello').toString('base64') };

describe('MediaService.create', () => {
  it('dev stub: keeps bytes in the row and returns a /media/:id url', async () => {
    const { svc, prisma, realtime } = make(null);
    const res = await svc.create('ambli', 'user-1', input);

    expect(res).toEqual({ id: 'med1', url: '/media/med1' });
    const row = prisma.media.create.mock.calls[0][0].data;
    expect(row.data).toBeInstanceOf(Buffer);
    expect(row.data.toString()).toBe('hello');
    expect(row.url).toBeNull();
    expect(row.sizeBytes).toBe(5);
    expect(row.uploadedBy).toBe('user-1');
    expect(realtime.notifyChanged).toHaveBeenCalledWith('ambli');
  });

  it('S3 mode: drops the bytes and returns the absolute bucket url', async () => {
    const { svc, prisma } = make('https://cdn.vitan.in/ambli/progress/med1.jpg');
    const res = await svc.create('ambli', 'user-1', input);

    expect(res.url).toBe('https://cdn.vitan.in/ambli/progress/med1.jpg');
    const row = prisma.media.create.mock.calls[0][0].data;
    expect(row.data).toBeNull();
    expect(row.url).toBe('https://cdn.vitan.in/ambli/progress/med1.jpg');
  });
});

describe('MediaService.fetch', () => {
  it('returns bytes for a stub row, a redirect for an S3 row, null when missing', async () => {
    const { svc, prisma } = make(null);

    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', mime: 'image/png', data: Buffer.from('x'), url: null });
    expect(await svc.fetch('m')).toEqual({ mime: 'image/png', bytes: Buffer.from('x') });

    prisma.media.findUnique.mockResolvedValueOnce({ id: 'm', mime: 'image/png', data: null, url: 'https://cdn/x.png' });
    expect(await svc.fetch('m')).toEqual({ redirect: 'https://cdn/x.png' });

    prisma.media.findUnique.mockResolvedValueOnce(null);
    expect(await svc.fetch('missing')).toBeNull();
  });
});
