import { describe, it, expect, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { isNodeVisibleTo, previewPublishedProjectNode, resolveProjectNode, resolvePublishedProjectNode, visibleNodeWhere } from './node-scope';
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

describe('resolvePublishedProjectNode — a team photo is filed only on a published place', () => {
  it('takes the tree lock\'s shared side BEFORE reading the node, and only when a place is given', async () => {
    const db = tx([{ id: 'p1', projectId: 'ambli', publishedAt: new Date(), authorId: 'pmc-1' }]) as unknown as {
      $executeRaw: { mock: { calls: unknown[][]; invocationCallOrder: number[] } };
      projectNode: { findUnique: { mock: { invocationCallOrder: number[] } } };
    };
    await resolvePublishedProjectNode(db as unknown as Prisma.TransactionClient, 'ambli', 'p1');
    expect(String((db.$executeRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?'))).toContain('pg_advisory_xact_lock_shared');
    expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.projectNode.findUnique.mock.invocationCallOrder[0]);
    const unfiled = tx([]) as unknown as { $executeRaw: { mock: { calls: unknown[] } } };
    expect(await resolvePublishedProjectNode(unfiled as unknown as Prisma.TransactionClient, 'ambli', null)).toBeNull();
    expect(unfiled.$executeRaw.mock.calls).toHaveLength(0);
  });

  const published = { id: 'p1', projectId: 'ambli', publishedAt: new Date(), authorId: 'pmc-1' };
  const draft = { id: 'd1', projectId: 'ambli', publishedAt: null, authorId: 'pmc-1' };

  it('accepts a published place', async () => {
    expect(await resolvePublishedProjectNode(tx([published]), 'ambli', 'p1')).toBe('p1');
  });

  it('refuses every draft, its author\'s own included, exactly like an unknown place', async () => {
    const err = await resolvePublishedProjectNode(tx([draft]), 'ambli', 'd1').catch((e) => e);
    const unknown = await resolvePublishedProjectNode(tx([]), 'ambli', 'ghost').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe(unknown.message);
  });

  it('keeps the project guard and the unfiled case', async () => {
    await expect(resolvePublishedProjectNode(tx([{ ...published, projectId: 'other' }]), 'ambli', 'p1')).rejects.toBeInstanceOf(BadRequestException);
    expect(await resolvePublishedProjectNode(tx([]), 'ambli', null)).toBeNull();
  });
});

describe('previewPublishedProjectNode — the early no before an upload stores bytes', () => {
  it('applies the same rule in its own transaction, under the same shared tree lock', async () => {
    const db = prismaWith([
      { id: 'p1', projectId: 'ambli', publishedAt: new Date(), authorId: 'pmc-1' },
      { id: 'd1', projectId: 'ambli', publishedAt: null, authorId: 'pmc-1' },
    ]) as unknown as { $executeRaw: { mock: { calls: unknown[][] } }; $transaction: unknown };
    db.$transaction = vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(db));
    expect(await previewPublishedProjectNode(db as unknown as PrismaService, 'ambli', 'p1')).toBe('p1');
    expect(String((db.$executeRaw.mock.calls[0][0] as { strings: string[] }).strings.join('?'))).toContain('pg_advisory_xact_lock_shared');
    const err = await previewPublishedProjectNode(db as unknown as PrismaService, 'ambli', 'd1').catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('Unknown location for this project');
    expect(await previewPublishedProjectNode(db as unknown as PrismaService, 'ambli', null)).toBeNull();
    expect(db.$transaction).toHaveBeenCalledTimes(2);
  });
});

describe('the one place-visibility rule', () => {
  it('a published place is everyone\'s; a draft only its author\'s; no viewer sees no draft', () => {
    expect(isNodeVisibleTo({ publishedAt: new Date(), authorId: 'a' }, 'b')).toBe(true);
    expect(isNodeVisibleTo({ publishedAt: null, authorId: 'a' }, 'a')).toBe(true);
    expect(isNodeVisibleTo({ publishedAt: null, authorId: 'a' }, 'b')).toBe(false);
    expect(isNodeVisibleTo({ publishedAt: null, authorId: null }, undefined)).toBe(false);
  });

  it('the query form says the same', () => {
    expect(visibleNodeWhere('a')).toEqual({ OR: [{ publishedAt: { not: null } }, { authorId: 'a' }] });
    expect(visibleNodeWhere(undefined)).toEqual({ publishedAt: { not: null } });
  });
});
