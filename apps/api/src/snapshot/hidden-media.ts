import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';
import { hiddenDraftNodeIds } from '../nodes/node-scope';

/**
 * The read-side answer to "which photos may this viewer not see?": a photo filed on someone else's private
 * draft place (before #881 made drafts unfileable) is as private as the place. Composed here, on the
 * read-orchestration side that already serves the photo layer, and handed to the inspections read as an
 * input, so no domain module reads another's persistence for it (#884).
 */
export async function mediaOnNodes(
  client: Prisma.TransactionClient | PrismaService,
  projectId: string,
  nodeIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (nodeIds.length === 0) return new Set();
  const rows = await client.media.findMany({ where: { projectId, nodeId: { in: [...nodeIds] } }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

/** The photos hidden from `viewerId`: those on the drafts the nodes module names as hidden from them. */
export async function hiddenMediaIds(
  client: Prisma.TransactionClient | PrismaService,
  projectId: string,
  viewerId: string | null | undefined,
): Promise<ReadonlySet<string>> {
  return mediaOnNodes(client, projectId, await hiddenDraftNodeIds(client, projectId, viewerId));
}
