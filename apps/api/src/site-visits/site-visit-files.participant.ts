import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { VISIT_FILE_GONE_MESSAGE } from '@vitan/shared';
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

  /** Whether a file is on this visit (Stage 1 markup: a marked-up copy goes on the visit its original is on). A link is
   *  frozen and never removed on its own (SV2, M3 and M5), so the answer cannot change while the visit is locked. */
  async isFileOnVisit(db: Prisma.TransactionClient | PrismaService, projectId: string, visitId: string, mediaId: string): Promise<boolean> {
    const link = await db.siteVisitMedia.findFirst({ where: { projectId, visitId, mediaId }, select: { mediaId: true } });
    return link !== null;
  }

  /**
   * A file on a visit is part of the visit's record (SV2, M5): the photo delete would take its link with it, so the
   * delete is refused, as a photo cited as evidence is, unless this transaction already wrote the visit's line for its
   * removal ({@link recordRemoval}, #1179). The database refuses the same delete without that line (20280125000000).
   */
  async assertMediaDisposable(tx: Prisma.TransactionClient, projectId: string, mediaId: string): Promise<void> {
    const link = await tx.siteVisitMedia.findFirst({ where: { projectId, mediaId }, select: { visitId: true } });
    if (!link) return;
    const removal = await tx.siteVisitFileRemoval.findFirst({ where: { projectId, mediaId }, select: { mediaId: true } });
    if (!removal) throw new ConflictException('This photo is part of a site visit\'s record and cannot be deleted');
  }

  /** #1179 — the visit a file is on, read without locks (the removal's early answer and its lock target); null when it is
   *  on none. A link is frozen, so its visit never changes. */
  async visitOf(db: Prisma.TransactionClient | PrismaService, projectId: string, mediaId: string): Promise<string | null> {
    const link = await db.siteVisitMedia.findFirst({ where: { projectId, mediaId }, select: { visitId: true } });
    return link?.visitId ?? null;
  }

  /** #1179 — the first statements of a removal's transaction (after the file's send key): a visit act's locks, the
   *  project's readiness key, the project tree and the visit row, in `lockForFile`'s order, so the file row the caller
   *  locks next is taken after the visit, as an upload takes it. */
  async lockForRemoval(tx: Prisma.TransactionClient, projectId: string, visitId: string): Promise<void> {
    await lockProjectReadiness(tx, projectId);
    await lockProjectTree(tx, projectId);
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "SiteVisit" WHERE "projectId" = ${projectId} AND "id" = ${visitId} FOR UPDATE`);
  }

  /**
   * #1179 (Jagrut, 27 Oct 2026) — take a file off its visit, under {@link lockForRemoval}'s locks and the file row's: the
   * person who added it may, within an hour of the server taking it (by the database's clock) and while the visit is
   * open (Jagrut's card: not once its visitor ended it or the PMC closed it; Codex 4397416722); the project's PMC may remove any file at any time, saying why unless it is their own within that hour.
   * Writes the visit's removal line, which the database stamps and completes; the caller then deletes the file.
   */
  async recordRemoval(
    tx: Prisma.TransactionClient,
    input: { projectId: string; mediaId: string; userId: string; actor: Actor; reason: string | null },
  ): Promise<void> {
    const { projectId, mediaId, userId } = input;
    const [link] = await tx.$queryRaw<Array<{ visitId: string; addedById: string; inHour: boolean; status: string }>>(Prisma.sql`
      SELECT m."visitId", m."addedById", (m."addedAt" + interval '1 hour' >= site_visits_now()) AS "inHour", v."status"
        FROM "SiteVisitMedia" m JOIN "SiteVisit" v ON v."projectId" = m."projectId" AND v."id" = m."visitId"
       WHERE m."projectId" = ${projectId} AND m."mediaId" = ${mediaId} FOR SHARE OF m`);
    if (!link) throw new NotFoundException(VISIT_FILE_GONE_MESSAGE);
    await lockActorStanding(tx, projectId, userId);
    const [state] = await tx.$queryRaw<Array<{ operable: boolean }>>(Prisma.sql`SELECT phase6_project_operable(${projectId}) AS "operable"`);
    if (state?.operable !== true) throw new ForbiddenException('Project is unavailable');
    const envelope = await resolveActorEnvelope(tx, projectId, input.actor);
    if (!envelope) throw new ForbiddenException('Your role on this project has changed; sign in again');
    const ownInHour = link.addedById === userId && link.inHour === true;
    if (envelope.actorRole === 'pmc') {
      if (!ownInHour && input.reason === null) throw new BadRequestException('Say why you are removing this file');
    } else {
      if (link.addedById !== userId) throw new ForbiddenException('Only the person who added this file, or the PMC, may remove it');
      if (link.status === 'closed') throw new ConflictException('This site visit was closed by the PMC; ask the PMC to remove the file');
      if (link.status !== 'open') throw new ConflictException('This site visit has ended; ask the PMC to remove the file');
      if (!ownInHour) throw new ForbiddenException('A file can be removed only within an hour of adding it; ask the PMC');
    }
    try {
      // the database copies the adder, the kind and the remover's name, and stamps the time, whatever is sent here
      await tx.siteVisitFileRemoval.create({
        // only the PMC's reason is kept: anyone else removes only their own file within the hour, which needs none, so a
        // line with no reason leaves the database's CHECK to judge the hour at the line's own stamp (Codex 4397768832)
        data: { projectId, visitId: link.visitId, mediaId, addedById: link.addedById, removedById: userId, removedByRole: envelope.actorRole, reason: envelope.actorRole === 'pmc' ? input.reason : null },
      });
    } catch (error) {
      // the hour ran out between the check above and the line's own stamp (the database's CHECK on a line with no reason)
      const refused = error instanceof Prisma.PrismaClientUnknownRequestError || error instanceof Prisma.PrismaClientKnownRequestError;
      if (refused && /SiteVisitFileRemoval_shape_check/.test(error.message)) {
        if (envelope.actorRole === 'pmc') throw new BadRequestException('Say why you are removing this file');
        throw new ForbiddenException('A file can be removed only within an hour of adding it; ask the PMC');
      }
      throw error;
    }
  }

  /** #482 site photos — the batched form of {@link assertMediaDisposable}: which of these photos a site visit holds, in one read
   *  of this module's own rows, so the snapshot asks once for its whole photo window (Codex 4320515415). */
  async pinnedMedia(db: Prisma.TransactionClient | PrismaService, projectId: string, mediaIds: string[]): Promise<Set<string>> {
    if (mediaIds.length === 0) return new Set();
    const rows = await db.siteVisitMedia.findMany({ where: { projectId, mediaId: { in: mediaIds } }, select: { mediaId: true } });
    return new Set(rows.map((r) => r.mediaId));
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
