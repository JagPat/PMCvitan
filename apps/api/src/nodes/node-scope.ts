import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';

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
 */
export async function resolveVisibleProjectNode(
  prisma: PrismaService,
  projectId: string,
  nodeId: string | null | undefined,
  userId: string,
): Promise<string | null> {
  if (!nodeId) return null;
  const node = await prisma.projectNode.findUnique({ where: { id: nodeId } });
  if (!node || node.projectId !== projectId) throw new BadRequestException('Unknown location for this project');
  if (node.publishedAt == null && node.authorId !== userId) throw new BadRequestException('Unknown location for this project');
  return node.id;
}
