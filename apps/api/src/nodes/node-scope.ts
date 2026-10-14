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

async function assertPublishedNode(client: Prisma.TransactionClient, projectId: string, nodeId: string): Promise<string> {
  const node = await client.projectNode.findUnique({ where: { id: nodeId } });
  // any draft answers exactly like an unknown place, so a hidden draft's existence is never disclosed
  if (!node || node.projectId !== projectId || node.publishedAt === null) {
    throw new BadRequestException('Unknown location for this project');
  }
  return node.id;
}

/**
 * `resolveProjectNode` for a write that files a TEAM-VISIBLE record (a site photo) on a place: the place
 * must be PUBLISHED. A team record on a draft would carry the private draft to every member through each
 * read that shows the record (the photo list, inspection evidence, the daily log), so no draft is a
 * filing target, not even the author's own; the app's place pickers already offer published places
 * only (`LocationPicker`), so this is the server side of the same rule (#869 review). Any draft answers
 * exactly like an unknown node, so a hidden draft's existence is never disclosed.
 *
 * AUTHORITATIVE ONLY INSIDE THE WRITE'S TRANSACTION. Publication is the tree's state, and `publish`
 * changes it under the project tree lock; read without that lock, a publish committing in between is
 * missed and a now-published place is refused. So this takes the tree lock's SHARED side as the first
 * statement of `tx` and reads the node after it: an in-flight tree write finishes first, and the read
 * sees its outcome (#869 review). Call it as the first statement of the transaction that writes.
 */
export async function resolvePublishedProjectNode(
  tx: Prisma.TransactionClient,
  projectId: string,
  nodeId: string | null | undefined,
): Promise<string | null> {
  if (!nodeId) return null;
  await lockProjectTreeShared(tx, projectId);
  return assertPublishedNode(tx, projectId, nodeId);
}

/**
 * The same check BEFORE a write does expensive work it cannot roll back (an upload's bucket PUT), so a
 * draft or unknown place is refused before any bytes are stored (#869 review). It runs in its own short
 * transaction under the same shared tree lock, so an in-flight publish is waited for here too and a place
 * being published is never refused early. It is still a separate read: the write's own transaction
 * re-decides with `resolvePublishedProjectNode`, which stays the authority.
 */
export async function previewPublishedProjectNode(
  prisma: PrismaService,
  projectId: string,
  nodeId: string | null | undefined,
): Promise<string | null> {
  if (!nodeId) return null;
  return prisma.$transaction((tx) => resolvePublishedProjectNode(tx, projectId, nodeId));
}

/**
 * Draft places hidden from `viewerId` (Draft -> Publish: an unpublished place is private to its author):
 * every unpublished place of the project except the viewer's own drafts. A null author or no viewer hides
 * the draft from everyone. Records filed on these places before #881 (photos) share the place's privacy.
 */
export function hiddenDraftWhere(projectId: string, viewerId: string | null | undefined): Prisma.ProjectNodeWhereInput {
  return viewerId
    ? { projectId, publishedAt: null, OR: [{ authorId: null }, { authorId: { not: viewerId } }] }
    : { projectId, publishedAt: null };
}

/** The ids of the places `hiddenDraftWhere` describes — what a read must not show this viewer. */
export async function hiddenDraftNodeIds(
  client: Prisma.TransactionClient | PrismaService,
  projectId: string,
  viewerId: string | null | undefined,
): Promise<string[]> {
  const rows = await client.projectNode.findMany({ where: hiddenDraftWhere(projectId, viewerId), select: { id: true } });
  return rows.map((r) => r.id);
}

/**
 * Is the place `nodeId` a draft hidden from `viewerId`? Decided under the tree lock's SHARED side (the
 * first statement of `tx`, like `resolvePublishedProjectNode`), so a publish or delete in flight finishes
 * first. A write that moves a record OFF a place uses it, so a record on someone else's private draft is
 * answered as if it did not exist. An unfiled record (null) is never hidden.
 */
export async function isPlaceHiddenFrom(
  tx: Prisma.TransactionClient,
  projectId: string,
  nodeId: string | null | undefined,
  viewerId: string | null | undefined,
): Promise<boolean> {
  if (!nodeId) return false;
  await lockProjectTreeShared(tx, projectId);
  const hidden = await tx.projectNode.findFirst({ where: { id: nodeId, ...hiddenDraftWhere(projectId, viewerId) }, select: { id: true } });
  return hidden !== null;
}
