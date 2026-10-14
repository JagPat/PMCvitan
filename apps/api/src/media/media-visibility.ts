import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { hiddenDraftNodeIds } from '../nodes/node-scope';

/**
 * The media module's answer to "which of these photos may this viewer not see?" — a photo filed on a
 * private draft place (before #881 made drafts unfileable) is as private as the place. Other modules ask
 * here instead of reading the media-owned `Media` table (the same infrastructure style as
 * `SignedUrlService`, which they already use to mint the paths this guards).
 */
export async function mediaHiddenFrom(
  client: Prisma.TransactionClient | PrismaService,
  projectId: string,
  viewerId: string | null | undefined,
  mediaIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (mediaIds.length === 0) return new Set();
  const hiddenNodes = await hiddenDraftNodeIds(client, projectId, viewerId);
  if (hiddenNodes.length === 0) return new Set();
  const rows = await client.media.findMany({ where: { projectId, id: { in: [...mediaIds] }, nodeId: { in: hiddenNodes } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** How many photos are filed on `nodeIds` (the caller passes the draft places a delete would remove). */
export function countMediaOnNodes(tx: Prisma.TransactionClient, projectId: string, nodeIds: readonly string[]): Promise<number> {
  if (nodeIds.length === 0) return Promise.resolve(0);
  return tx.media.count({ where: { projectId, nodeId: { in: [...nodeIds] } } });
}
