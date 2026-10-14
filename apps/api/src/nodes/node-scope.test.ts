import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { resolveProjectNode, resolveVisibleProjectNode } from './node-scope';
import type { PrismaService } from '../prisma.service';

function prismaWith(nodes: Array<{ id: string; projectId: string; publishedAt?: Date | null; authorId?: string | null }>) {
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

describe('resolveVisibleProjectNode — filing on a place the caller can see', () => {
  const published = { id: 'p1', projectId: 'ambli', publishedAt: new Date(), authorId: 'pmc-1' };
  const draft = { id: 'd1', projectId: 'ambli', publishedAt: null, authorId: 'pmc-1' };

  it('accepts a published place for anyone', async () => {
    expect(await resolveVisibleProjectNode(prismaWith([published]), 'ambli', 'p1', 'someone')).toBe('p1');
  });

  it('accepts a private draft for its own author', async () => {
    expect(await resolveVisibleProjectNode(prismaWith([draft]), 'ambli', 'd1', 'pmc-1')).toBe('d1');
  });

  it('refuses another author\'s private draft exactly like an unknown place', async () => {
    const err = await resolveVisibleProjectNode(prismaWith([draft]), 'ambli', 'd1', 'engineer-1').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Unknown location for this project');
  });

  it('keeps the project guard and the unfiled case', async () => {
    await expect(resolveVisibleProjectNode(prismaWith([{ ...published, projectId: 'other' }]), 'ambli', 'p1', 'pmc-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(await resolveVisibleProjectNode(prismaWith([]), 'ambli', null, 'pmc-1')).toBeNull();
  });
});
