import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { resolveProjectNode, resolveVisibleProjectNode } from './node-scope';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';

function prismaWith(nodes: Array<{ id: string; projectId: string; publishedAt?: Date | null; authorId?: string | null }>) {
  return {
    projectNode: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => nodes.find((n) => n.id === where.id) ?? null),
    },
    $executeRaw: vi.fn(async () => 1),
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

const tx = (nodes: Parameters<typeof prismaWith>[0]) => prismaWith(nodes) as unknown as Prisma.TransactionClient;

describe('resolveVisibleProjectNode — filing on a place the caller can see', () => {
  it('takes the tree lock\'s shared side BEFORE reading the node, and only when a place is given', async () => {
    const db = tx([{ id: 'p1', projectId: 'ambli', publishedAt: new Date(), authorId: 'pmc-1' }]) as unknown as {
      $executeRaw: { mock: { calls: unknown[][]; invocationCallOrder: number[] } };
      projectNode: { findUnique: { mock: { invocationCallOrder: number[] } } };
    };
    await resolveVisibleProjectNode(db as unknown as Prisma.TransactionClient, 'ambli', 'p1', 'someone');
    expect(String((db.$executeRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?'))).toContain('pg_advisory_xact_lock_shared');
    expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.projectNode.findUnique.mock.invocationCallOrder[0]);
    const unfiled = tx([]) as unknown as { $executeRaw: { mock: { calls: unknown[] } } };
    expect(await resolveVisibleProjectNode(unfiled as unknown as Prisma.TransactionClient, 'ambli', null, 'someone')).toBeNull();
    expect(unfiled.$executeRaw.mock.calls).toHaveLength(0);
  });

  const published = { id: 'p1', projectId: 'ambli', publishedAt: new Date(), authorId: 'pmc-1' };
  const draft = { id: 'd1', projectId: 'ambli', publishedAt: null, authorId: 'pmc-1' };

  it('accepts a published place for anyone', async () => {
    expect(await resolveVisibleProjectNode(tx([published]), 'ambli', 'p1', 'someone')).toBe('p1');
  });

  it('accepts a private draft for its own author', async () => {
    expect(await resolveVisibleProjectNode(tx([draft]), 'ambli', 'd1', 'pmc-1')).toBe('d1');
  });

  it('refuses another author\'s private draft exactly like an unknown place', async () => {
    const err = await resolveVisibleProjectNode(tx([draft]), 'ambli', 'd1', 'engineer-1').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Unknown location for this project');
  });

  it('keeps the project guard and the unfiled case', async () => {
    await expect(resolveVisibleProjectNode(tx([{ ...published, projectId: 'other' }]), 'ambli', 'p1', 'pmc-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(await resolveVisibleProjectNode(tx([]), 'ambli', null, 'pmc-1')).toBeNull();
  });
});
