import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { lockProjectTree } from '../common/tree-lock';
import { lockProjectReadiness } from '../common/readiness-lock';
import { lockActorStanding, resolveActorEnvelope } from '../platform/actor-envelope';
import type { Actor } from '../common/actor';

/** The visit row a link reads, locked. */
interface VisitForLink {
  visitorId: string;
  status: string;
}

/**
 * Guided site inspections, step 3c — an inspection walked during a site visit. The inspections module submits the walk;
 * this module writes the visit's line for it ("SiteVisitInspection", 20280212000000), in the submit's own transaction, as
 * it writes a visit's file in the upload's.
 *
 * Who may record a walk on a visit is who may add a file to it (Jagrut, 19 Oct 2026): the visitor, and anyone recorded
 * as present (an attendee not retired), while the visit is not closed. An ended visit still takes a walk, so a checklist
 * finished offline during the visit lands when the phone finds signal.
 *
 * The lock order is every visit act's: the project's readiness key, the project tree, the visit row ({@link lockForLink},
 * the first statements of the submit's transaction, before the inspection row), then ({@link link}, after the submit's
 * CAS and before its event) the linker's registers, the project row and their identity.
 */
@Injectable()
export class SiteVisitInspectionsParticipant {
  constructor(private readonly prisma: PrismaService) {}

  /** The early no, before the submit's transaction: the visit is this project's, not closed, and the caller is on it.
   *  It reads without locks; {@link lockForLink} asks again inside the transaction and is the authority. */
  async assertMayLink(projectId: string, visitId: string, userId: string): Promise<void> {
    const visit = await this.prisma.siteVisit.findFirst({ where: { projectId, id: visitId }, select: { visitorId: true, status: true } });
    await this.judge(this.prisma, projectId, visitId, userId, visit);
  }

  /** The first statements of the submit's transaction when it names a visit: the visit act's locks, then the same check. */
  async lockForLink(tx: Prisma.TransactionClient, projectId: string, visitId: string, userId: string): Promise<void> {
    await lockProjectReadiness(tx, projectId);
    await lockProjectTree(tx, projectId);
    const [visit] = await tx.$queryRaw<VisitForLink[]>(Prisma.sql`
      SELECT "visitorId", "status" FROM "SiteVisit" WHERE "projectId" = ${projectId} AND "id" = ${visitId} FOR UPDATE`);
    await this.judge(tx, projectId, visitId, userId, visit ?? null);
  }

  /** The visit's line for the walk, after the submit's CAS and before its event: the linker's standing under the envelope's
   *  order, then the row, attributed in the role they act in. The database checks the role, copies their name and stamps
   *  the time. */
  async link(
    tx: Prisma.TransactionClient,
    input: { projectId: string; visitId: string; inspectionId: string; userId: string; actor: Actor },
  ): Promise<void> {
    await lockActorStanding(tx, input.projectId, input.userId);
    const [state] = await tx.$queryRaw<Array<{ operable: boolean }>>(Prisma.sql`SELECT phase6_project_operable(${input.projectId}) AS "operable"`);
    if (state?.operable !== true) throw new ForbiddenException('Project is unavailable');
    const envelope = await resolveActorEnvelope(tx, input.projectId, input.actor);
    if (!envelope) throw new ForbiddenException('Your role on this project has changed; sign in again');
    try {
      await tx.siteVisitInspection.create({
        data: {
          projectId: input.projectId, visitId: input.visitId, inspectionId: input.inspectionId,
          linkedById: input.userId, linkedByRole: envelope.actorRole,
        },
      });
    } catch (error) {
      // an inspection is walked on at most one visit; the submit's CAS lets one submit through, so this is a raced write
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('This checklist is already recorded on a site visit — reload and retry');
      }
      throw error;
    }
  }

  private async judge(
    db: Prisma.TransactionClient | PrismaService, projectId: string, visitId: string, userId: string, visit: VisitForLink | null,
  ): Promise<void> {
    if (!visit) throw new NotFoundException('Site visit not found');
    if (visit.status === 'closed') throw new ConflictException('This site visit was closed by the PMC and takes no more checklists');
    if (visit.visitorId === userId) return;
    const present = await db.siteVisitAttendee.findFirst({ where: { projectId, visitId, userId, retiredAt: null }, select: { id: true } });
    if (!present) throw new ForbiddenException('Only the visitor and the people recorded on this visit can record a checklist on it');
  }
}
