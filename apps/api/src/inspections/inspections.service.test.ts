import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { InspectionsService } from './inspections.service';
import type { PrismaService } from '../prisma.service';
import type { SnapshotService } from '../snapshot/snapshot.service';
import type { RealtimeGateway } from '../realtime/realtime.gateway';

type Insp = { id: string; projectId: string; submitted: boolean; decided: boolean; items: Array<{ name: string; state: string | null; photos: number; result: string | null; rejected: boolean }> };

function make(insp: Insp) {
  const prisma = {
    inspection: {
      findUnique: vi.fn(async () => insp),
      update: vi.fn(async () => ({})),
    },
    inspectionItem: { updateMany: vi.fn(async () => ({})) },
    notification: { create: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  } as unknown as PrismaService;
  const snapshot = { build: vi.fn(async () => ({})) } as unknown as SnapshotService;
  const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
  const svc = new InspectionsService(prisma, snapshot, realtime);
  const user = { sub: 'u1', role: 'engineer', projectId: 'ambli' } as never;
  return { svc, prisma, user };
}

const item = (name: string, over: Partial<Insp['items'][number]> = {}) => ({ name, state: null, photos: 0, result: null, rejected: false, ...over });

describe('InspectionsService.submit — state-machine guards (P2-3)', () => {
  it('rejects an empty payload against a non-empty issued checklist', async () => {
    const { svc, user } = make({ id: 'INSP-1', projectId: 'ambli', submitted: false, decided: false, items: [item('Waterproofing')] });
    await expect(svc.submit('ambli', 'INSP-1', { items: [] } as never, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects resubmission of an already-submitted inspection', async () => {
    const { svc, user } = make({ id: 'INSP-1', projectId: 'ambli', submitted: true, decided: false, items: [item('Waterproofing', { state: 'pass' })] });
    await expect(
      svc.submit('ambli', 'INSP-1', { items: [{ name: 'Waterproofing', state: 'pass', photos: 1, note: '' }] } as never, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a complete submission that covers every issued item', async () => {
    const { svc, user, prisma } = make({ id: 'INSP-1', projectId: 'ambli', submitted: false, decided: false, items: [item('Waterproofing')] });
    await svc.submit('ambli', 'INSP-1', { items: [{ name: 'Waterproofing', state: 'pass', photos: 1, note: 'ok' }] } as never, user);
    expect(prisma.inspection.update).toHaveBeenCalledWith({ where: { id: 'INSP-1' }, data: { submitted: true } });
  });
});

describe('InspectionsService.create — location spine (nodeId)', () => {
  function makeCreate(nodes: Array<{ id: string; projectId: string }>) {
    const created: Array<Record<string, unknown>> = [];
    const prisma = {
      inspection: {
        findMany: vi.fn(async () => []),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return { id: data.id }; }),
      },
      inspectionItem: { create: vi.fn(async () => ({})) },
      notification: { create: vi.fn(async () => ({})) },
      auditLog: { create: vi.fn(async () => ({})) },
      projectNode: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => nodes.find((n) => n.id === where.id) ?? null) },
      $transaction: vi.fn(async (ops: unknown[]) => ops),
    } as unknown as PrismaService;
    const snapshot = { build: vi.fn(async () => ({})) } as unknown as SnapshotService;
    const realtime = { notifyChanged: vi.fn() } as unknown as RealtimeGateway;
    const svc = new InspectionsService(prisma, snapshot, realtime);
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
});

describe('InspectionsService.decide — state-machine guards (P2-3)', () => {
  it('rejects deciding an inspection that was never submitted', async () => {
    const { svc, user } = make({ id: 'INSP-1', projectId: 'ambli', submitted: false, decided: false, items: [item('X', { state: 'pass' })] });
    await expect(svc.decide('ambli', 'INSP-1', { approve: true, rejectedItemNames: [] } as never, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects re-deciding an already-decided inspection', async () => {
    const { svc, user } = make({ id: 'INSP-1', projectId: 'ambli', submitted: true, decided: true, items: [item('X', { state: 'pass' })] });
    await expect(svc.decide('ambli', 'INSP-1', { approve: true, rejectedItemNames: [] } as never, user)).rejects.toBeInstanceOf(BadRequestException);
  });
});
