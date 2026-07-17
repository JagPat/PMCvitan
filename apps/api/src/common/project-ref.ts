import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma.service';

/** The project-owned models an optional reference may point at (exhaustive —
 *  never accept arbitrary model names from a caller). `decision` (Task 8) and `dailyLog` (Task 10)
 *  are NOT here: they are read-encapsulated, so their references are validated through the owning
 *  module's query (`DecisionsQueryService`/`DailyLogQueryService.resolveRefInProject`), not this helper. */
export type ProjectRefModel = 'activity' | 'inspection' | 'media' | 'node';

/**
 * Resolve an OPTIONAL project-owned reference (Phase 0 Task 5): null/undefined
 * pass through as null; a present id must belong to THIS project or the write
 * is rejected. Use before every service write that stores such a reference —
 * the composite (projectId, id) foreign keys are the database backstop, this
 * is the first line with a human-readable error.
 */
export async function resolveProjectRef(
  prisma: PrismaService,
  model: ProjectRefModel,
  projectId: string,
  id: string | null | undefined,
  field: string,
): Promise<string | null> {
  if (!id) return null;
  let row: { id: string } | null;
  switch (model) {
    case 'activity':
      row = await prisma.activity.findFirst({ where: { id, projectId }, select: { id: true } });
      break;
    case 'inspection':
      row = await prisma.inspection.findFirst({ where: { id, projectId }, select: { id: true } });
      break;
    case 'media':
      row = await prisma.media.findFirst({ where: { id, projectId }, select: { id: true } });
      break;
    case 'node':
      row = await prisma.projectNode.findFirst({ where: { id, projectId }, select: { id: true } });
      break;
  }
  if (!row) throw new BadRequestException(`${field} does not belong to this project`);
  return id;
}
