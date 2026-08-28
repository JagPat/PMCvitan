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

  it('targets specific roles when given, broadcasts to all when not', async () => {
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;

    const prisma = fakePrisma();
    const svc = new PushService(prisma as unknown as PrismaService);

    await svc.notifyProject('ambli', { title: 'Vitan PMC', body: 'approved' }, ['contractor', 'client']);
    expect(prisma.pushSubscription.findMany).toHaveBeenLastCalledWith({ where: { projectId: 'ambli', role: { in: ['contractor', 'client'] } } });

    await svc.notifyProject('ambli', { title: 'Vitan PMC', body: 'all' }, []); // empty ⇒ broadcast
    expect(prisma.pushSubscription.findMany).toHaveBeenLastCalledWith({ where: { projectId: 'ambli' } });
  });
});

describe('PushService — Phase 6 4b round-1 corrections (Codex F1/F4)', () => {
  const linked = { userId: 'u-a', credentialVersion: 3, expiresAt: new Date('2027-01-01T00:00:00Z') };

  it('F1: unlink clears ONLY a link still belonging to the calling user — a late request cannot strip the next user\'s re-attributed link', async () => {
    const prisma = { pushSubscription: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    const svc = new PushService(prisma as unknown as PrismaService, {} as never);
    await svc.unlink('https://push.example/shared', 'u-a');
    expect(prisma.pushSubscription.updateMany).toHaveBeenCalledWith({
      where: { endpoint: 'https://push.example/shared', linkedUserId: 'u-a' },
      data: { linkedUserId: null, linkedCredentialVersion: null, linkedExpiresAt: null },
    });
    // no authenticated caller → no write at all (never an unconditional clear)
    prisma.pushSubscription.updateMany.mockClear();
    await svc.unlink('https://push.example/shared', '');
    expect(prisma.pushSubscription.updateMany).not.toHaveBeenCalled();
  });

  it('F4: subscribe attributes the link through the orgs-owned identity answer — never a direct User read', async () => {
    const prisma = fakePrisma();
    const orgs = { resolveUserIdentity: vi.fn().mockResolvedValue({ id: 'u-a' }) };
    const svc = new PushService(prisma as unknown as PrismaService, orgs as never);
    await svc.subscribe('ambli', { endpoint: 'e1', keys: { p256dh: 'p', auth: 'a' } }, 'client', linked);
    expect(orgs.resolveUserIdentity).toHaveBeenCalledWith(prisma, 'u-a');
    expect(prisma.pushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ linkedUserId: 'u-a', linkedCredentialVersion: 3 }) }),
    );
    // an identity the owner cannot resolve stores the subscription UNLINKED
    orgs.resolveUserIdentity.mockResolvedValue(null);
    await svc.subscribe('ambli', { endpoint: 'e2', keys: { p256dh: 'p', auth: 'a' } }, 'client', linked);
    expect(prisma.pushSubscription.upsert).toHaveBeenLastCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ linkedUserId: null }) }),
    );
  });
});
