import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';

/** The project-owned models an optional reference may point at (exhaustive —
 *  never accept arbitrary model names from a caller). `decision` (Task 8), `dailyLog` (Task 10),
 *  `inspection` (Task 10 Module 3) and `activity` (Task 10 Module 4) are NOT here: they are
 *  read-encapsulated. Decision/daily-log/inspection references are validated through the owning
 *  module's query (`resolveRefInProject`); an ACTIVITY reference is stored by modules UPSTREAM of
 *  activities in the dependsOn graph (inspections, drawings), which cannot take the activities query
 *  without a cycle — there the composite `(projectId, activityId)` tenant FK is the validation
 *  authority and {@link rethrowActivityRefViolation} translates its violation into the same
 *  human-readable 400 this helper used to raise. */
export type ProjectRefModel = 'media' | 'node';

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

/**
 * Task 10 (Module 4) — translate a composite `(projectId, activityId)` tenant-FK violation (Prisma
 * P2003 on `<Table>_projectId_activityId_fkey`) into the SAME human-readable 400 the query-based
 * validation used to raise. The modules that STORE an activity reference (inspections, drawings) sit
 * UPSTREAM of activities in the dependsOn graph — activities depends on THEIR queries for its
 * readiness bake — so they cannot validate through `ActivitiesQueryService` without a dependency
 * cycle. The composite tenant FK is the validation authority (it admits exactly this project's
 * activities); this translation keeps the caller-facing contract identical. Any other error
 * rethrows untouched.
 */
export function rethrowActivityRefViolation(e: unknown, field = 'activityId'): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
    const meta = (e.meta ?? {}) as Record<string, unknown>;
    const constraint = String(meta.constraint ?? meta.field_name ?? '');
    if (constraint.includes('activityId')) {
      throw new BadRequestException(`${field} does not belong to this project`);
    }
  }
  throw e;
}
