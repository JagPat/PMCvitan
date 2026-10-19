import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { lockProjectTree } from '../common/tree-lock';
import { lockProjectReadiness } from '../common/readiness-lock';
import { lockActorStanding, resolveActorEnvelope } from '../platform/actor-envelope';
import type { Actor } from '../common/actor';

/** What the adder said about the file, as the upload carries it. */
export interface SiteVisitFileInput {
  visitId: string;
  note?: string;
  rating?: 'fine' | 'concern' | 'action_needed';
}

/** The visit row an add reads, locked. */
interface VisitForFile {
  visitorId: string;
  status: string;
}

/**
 * Site Visits #792 SV2 — a file added on a visit. The media module stores the file; this module writes the link to the
 * visit, in the upload's own transaction, as an inspection writes its evidence link.
 *
 * Who may add (Jagrut, 19 Oct 2026): the visitor, and anyone recorded as present on the visit (an attendee not
 * retired), while the visit is not closed. An ended visit still takes files, the way it takes a late place, so a
 * photo queued offline during the visit lands when the phone finds signal.
 *
 * The lock order is every visit act's (`SiteVisitsService`): the project's readiness lock, the project tree, the visit
 * row, then (the link's insert trigger) the file's place and the file, the adder's registers, the project row and
 * their identity, and last the upload's event. Under the tree lock a place's removal never interleaves with an add
 * (#988): the removal holds the tree from its first statement, before it locks any identity or node.
 */
@Injectable()
export class SiteVisitFilesParticipant {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The early no, before any byte is stored: the visit is this project's, not closed, and the caller is on it. It reads
   * without locks and may be stale; `lockForFile` asks again inside the upload's transaction and is the authority.
   */
  async assertMayAdd(projectId: string, visitId: string, userId: string): Promise<void> {
    const visit = await this.prisma.siteVisit.findFirst({ where: { projectId, id: visitId }, select: { visitorId: true, status: true } });
    await this.judge(this.prisma, projectId, visitId, userId, visit);
  }

  /** The first statements of the upload's transaction when it names a visit: the visit act's locks, then the same check. */
  async lockForFile(tx: Prisma.TransactionClient, projectId: string, visitId: string, userId: string): Promise<void> {
    await lockProjectReadiness(tx, projectId);
    await lockProjectTree(tx, projectId);
    const [visit] = await tx.$queryRaw<VisitForFile[]>(Prisma.sql`
      SELECT "visitorId", "status" FROM "SiteVisit" WHERE "projectId" = ${projectId} AND "id" = ${visitId} FOR UPDATE`);
    await this.judge(tx, projectId, visitId, userId, visit ?? null);
  }

  /**
   * The link, after the file's row is written and before its event: the adder's standing under the envelope's order,
   * then the row, attributed in the role they act in. The database copies their name and the file's place.
   */
  async attach(
    tx: Prisma.TransactionClient,
    input: SiteVisitFileInput & { projectId: string; mediaId: string; userId: string; actor: Actor },
  ): Promise<void> {
    await lockActorStanding(tx, input.projectId, input.userId);
    const [state] = await tx.$queryRaw<Array<{ operable: boolean }>>(Prisma.sql`SELECT phase6_project_operable(${input.projectId}) AS "operable"`);
    if (state?.operable !== true) throw new ForbiddenException('Project is unavailable');
    const envelope = await resolveActorEnvelope(tx, input.projectId, input.actor);
    if (!envelope) throw new ForbiddenException('Your role on this project has changed; sign in again');
    try {
      await tx.siteVisitMedia.create({
        data: {
          projectId: input.projectId, visitId: input.visitId, mediaId: input.mediaId,
          note: input.note ?? null, rating: input.rating ?? null,
          addedById: input.userId, addedByRole: envelope.actorRole,
        },
      });
    } catch (error) {
      // the file was refiled while it was being added: nothing was written, and the same upload may be sent again
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
        throw new ConflictException('This photo was moved to another place while it was being added; send it again');
      }
      throw error;
    }
  }

  /**
   * A file on a visit is part of the visit's record (SV2, M5): the photo delete would take its link with it, so the
   * delete is refused, as a photo cited as evidence is. The link is frozen and goes only with its project.
   */
  async assertMediaDisposable(tx: Prisma.TransactionClient, projectId: string, mediaId: string): Promise<void> {
    const link = await tx.siteVisitMedia.findFirst({ where: { projectId, mediaId }, select: { visitId: true } });
    if (link) throw new ConflictException('This photo is part of a site visit\'s record and cannot be deleted');
  }

  private async judge(
    db: Prisma.TransactionClient | PrismaService, projectId: string, visitId: string, userId: string, visit: VisitForFile | null,
  ): Promise<void> {
    if (!visit) throw new NotFoundException('Site visit not found');
    if (visit.status === 'closed') throw new ConflictException('This site visit was closed by the PMC and takes no more files');
    if (visit.visitorId === userId) return;
    const present = await db.siteVisitAttendee.findFirst({ where: { projectId, visitId, userId, retiredAt: null }, select: { id: true } });
    if (!present) throw new ForbiddenException('Only the visitor and the people recorded on this visit can add files to it');
  }
}
