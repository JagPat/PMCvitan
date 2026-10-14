import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { lockProjectTreeShared } from '../common/tree-lock';

/**
 * Validate that a location-tree node belongs to `projectId`. Returns the node id when
 * valid, or `null` when `nodeId` is null/undefined (an intentionally unfiled item).
 * Throws 400 for an unknown or cross-project node — the same guard decisions use, so a
 * photo or drawing can never be pinned to another project's location. Location spine.
 */
export async function resolveProjectNode(
  prisma: PrismaService,
  projectId: string,
  nodeId: string | null | undefined,
): Promise<string | null> {
  if (!nodeId) return null;
  const node = await prisma.projectNode.findUnique({ where: { id: nodeId } });
  if (!node || node.projectId !== projectId) throw new BadRequestException('Unknown location for this project');
  return node.id;
}

/**
 * The ONE place-visibility rule (Draft -> Publish): a published place is the team's; an unpublished
 * draft is private to its author. The snapshot's place list, its photo list and every filing write use
 * these two forms, so the rule cannot drift between what a member sees and what they may file on.
 */
export function isNodeVisibleTo(node: { publishedAt: Date | null; authorId: string | null }, userId: string | null | undefined): boolean {
  return node.publishedAt !== null || (Boolean(userId) && node.authorId === userId);
}

/** `isNodeVisibleTo` as a query filter, for reads that must not return records on a hidden place. */
export function visibleNodeWhere(userId: string | null | undefined): Prisma.ProjectNodeWhereInput {
  return userId ? { OR: [{ publishedAt: { not: null } }, { authorId: userId }] } : { publishedAt: { not: null } };
}

async function assertVisibleNode(
  client: Prisma.TransactionClient,
  projectId: string,
  nodeId: string,
  userId: string,
): Promise<string> {
  const node = await client.projectNode.findUnique({ where: { id: nodeId } });
  // another author's draft answers exactly like an unknown place, so its existence is never disclosed
  if (!node || node.projectId !== projectId || !isNodeVisibleTo(node, userId)) {
    throw new BadRequestException('Unknown location for this project');
  }
  return node.id;
}

/**
 * `resolveProjectNode` for a write that files a team-visible record on a place: the node must also be
 * one the caller can SEE (`isNodeVisibleTo`). Another author's draft answers exactly like an unknown
 * node, so a hidden draft's existence is never disclosed. Owned here so node visibility has one home.
 *
 * AUTHORITATIVE ONLY INSIDE THE WRITE'S TRANSACTION. Visibility is the tree's state, and `publish`
 * changes it under the project tree lock; read without that lock, a publish committing in between is
 * missed and a now-visible place is refused. So this takes the tree lock's SHARED side as the first
 * statement of `tx` and reads the node after it: an in-flight tree write finishes first, and the read
 * sees its outcome (#869 review). Call it as the first statement of the transaction that writes.
 */
export async function resolveVisibleProjectNode(
  tx: Prisma.TransactionClient,
  projectId: string,
  nodeId: string | null | undefined,
  userId: string,
): Promise<string | null> {
  if (!nodeId) return null;
  await lockProjectTreeShared(tx, projectId);
  return assertVisibleNode(tx, projectId, nodeId, userId);
}

/**
 * The same check BEFORE a write does expensive work it cannot roll back (an upload's bucket PUT), so a
 * hidden place is refused before any bytes are stored (#869 review). It runs in its own short transaction
 * under the same shared tree lock, so an in-flight publish is waited for here too and a place being
 * published is never refused early. It is still a separate read: the write's own transaction re-decides
 * with `resolveVisibleProjectNode`, which stays the authority.
 */
export async function previewVisibleProjectNode(
  prisma: PrismaService,
  projectId: string,
  nodeId: string | null | undefined,
  userId: string,
): Promise<string | null> {
  if (!nodeId) return null;
  return prisma.$transaction((tx) => resolveVisibleProjectNode(tx, projectId, nodeId, userId));
}
