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
 * `resolveProjectNode` for a write that files a team-visible record on a place: the node must also be
 * one the caller can SEE — published, or a private draft the caller authored (the snapshot's own rule:
 * a draft is delivered only to its author). Another author's draft answers exactly like an unknown
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
  const node = await tx.projectNode.findUnique({ where: { id: nodeId } });
  if (!node || node.projectId !== projectId) throw new BadRequestException('Unknown location for this project');
  if (node.publishedAt == null && node.authorId !== userId) throw new BadRequestException('Unknown location for this project');
  return node.id;
}
