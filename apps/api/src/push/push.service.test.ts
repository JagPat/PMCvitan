import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as webpush from 'web-push';
import { PushService } from './push.service';
import type { PrismaService } from '../prisma.service';

function fakePrisma() {
  return {
    pushSubscription: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
}

beforeEach(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

describe('PushService — dev stub (no VAPID)', () => {
  it('reports unconfigured, empty public key, and no-ops on send', async () => {
    const prisma = fakePrisma();
    const svc = new PushService(prisma as unknown as PrismaService);
    expect(svc.configured).toBe(false);
    expect(svc.publicKey).toBe('');

    await svc.notifyProject('ambli', { title: 'Vitan PMC', body: 'hi' });
    expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled(); // send skipped
  });

  it('still stores subscriptions (so enabling keys later just works)', async () => {
    const prisma = fakePrisma();
    const svc = new PushService(prisma as unknown as PrismaService);
    await svc.subscribe('ambli', { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }, 'engineer');
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { endpoint: 'https://push.example/abc' },
        create: expect.objectContaining({ projectId: 'ambli', endpoint: 'https://push.example/abc', p256dh: 'p', auth: 'a', role: 'engineer' }),
      }),
    );
  });
});

describe('PushService — configured (VAPID present)', () => {
  it('exposes the public key and sends to subscriptions', async () => {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;

    const prisma = fakePrisma();
    const svc = new PushService(prisma as unknown as PrismaService);
    expect(svc.configured).toBe(true);
    expect(svc.publicKey).toBe(keys.publicKey);

    await svc.notifyProject('ambli', { title: 'Vitan PMC', body: 'hi' });
    expect(prisma.pushSubscription.findMany).toHaveBeenCalledWith({ where: { projectId: 'ambli' } });
  });
});
