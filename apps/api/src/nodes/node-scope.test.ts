import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { resolveProjectNode } from './node-scope';
import type { PrismaService } from '../prisma.service';

function prismaWith(nodes: Array<{ id: string; projectId: string }>) {
  return {
    projectNode: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => nodes.find((n) => n.id === where.id) ?? null),
    },
  } as unknown as PrismaService;
}

describe('resolveProjectNode — the shared location-spine guard', () => {
  it('returns null for null/undefined without hitting the DB (unfiled item)', async () => {
    const prisma = prismaWith([]);
    expect(await resolveProjectNode(prisma, 'ambli', null)).toBeNull();
    expect(await resolveProjectNode(prisma, 'ambli', undefined)).toBeNull();
    expect((prisma as unknown as { projectNode: { findUnique: { mock: { calls: unknown[] } } } }).projectNode.findUnique.mock.calls).toHaveLength(0);
  });

  it('returns the id for a node in the same project', async () => {
    const prisma = prismaWith([{ id: 'r1', projectId: 'ambli' }]);
    expect(await resolveProjectNode(prisma, 'ambli', 'r1')).toBe('r1');
  });

  it('rejects a node from another project (tenant isolation)', async () => {
    const prisma = prismaWith([{ id: 'r1', projectId: 'other' }]);
    await expect(resolveProjectNode(prisma, 'ambli', 'r1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown node', async () => {
    const prisma = prismaWith([]);
    await expect(resolveProjectNode(prisma, 'ambli', 'ghost')).rejects.toBeInstanceOf(BadRequestException);
  });
});
