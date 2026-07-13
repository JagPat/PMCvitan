import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../media/storage.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SnapshotService } from '../snapshot/snapshot.service';
import { resolveProjectNode } from '../nodes/node-scope';
import { resolveProjectRef } from '../common/project-ref';
import { ddMmmYyyy } from '../domain/dates';
import { resolveActor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type { SnapshotDto } from '../snapshot/types';
import type { IssueDrawingInput } from '../contracts';

export interface IssuedDrawing {
  drawingId: string;
  revisionId: string;
}

export type RevisionBytes = { mime: string; bytes: Buffer };
export type RevisionRedirect = { redirect: string };

/** The Prisma transaction client — what `$transaction(async (tx) => …)` hands the callback. */
type Tx = Prisma.TransactionClient;

/**
 * The drawings register. Issue a drawing revision — a new `number` creates a
 * register entry; an existing one adds a revision. Supersession is SCOPED
 * (Phase 1 Task 3): a for_construction issue supersedes only the prior
 * for_construction set; a for_review issue supersedes NOTHING (it coexists as
 * a review copy and can never govern the field). Issuing to the team FREEZES
 * the distribution: the active engineer/contractor members at that moment
 * become DrawingRecipient rows. Files are held by StorageService.
 */
@Injectable()
export class DrawingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeGateway,
    private readonly snapshot: SnapshotService,
  ) {}

  /** A presigned direct-to-bucket upload target for a large drawing (Slice 3), or
   *  `{ presign: null }` with no bucket configured — the client then posts base64. */
  async presign(projectId: string, mime: string): Promise<{ uploadUrl: string; storageKey: string } | { presign: null }> {
    const key = this.storage.keyFor(projectId, 'drawings', mime);
    const res = await this.storage.presignPut(key, mime);
    return res ? { uploadUrl: res.uploadUrl, storageKey: key } : { presign: null };
  }

  /**
   * Freeze the distribution for a revision: snapshot the project's ACTIVE
   * engineer/contractor members as DrawingRecipient rows and stamp
   * `recipientsFrozenAt` — EVEN when the frozen set is empty ("snapshot ran and
   * was empty" is a different fact from the legacy null). Runs inside the issue/
   * publish transaction so the distribution commits with the revision itself.
   */
  private async freezeRecipients(tx: Tx, projectId: string, revisionId: string): Promise<void> {
    const members = await tx.membership.findMany({
      where: { projectId, status: 'active', role: { in: ['engineer', 'contractor'] } },
      select: { userId: true, role: true },
    });
    if (members.length) {
      await tx.drawingRecipient.createMany({
        data: members.map((m) => ({ projectId, revisionId, userId: m.userId, roleAtIssue: m.role })),
        skipDuplicates: true,
      });
    }
    await tx.drawingRevision.update({ where: { id: revisionId }, data: { recipientsFrozenAt: new Date() } });
  }

  async issue(projectId: string, user: AuthUser, input: IssueDrawingInput): Promise<IssuedDrawing> {
    const actor = await resolveActor(this.prisma, user);
    // Location spine: validate the place this drawing governs belongs to this project.
    const nodeId = await resolveProjectNode(this.prisma, projectId, input.nodeId);
    // Project-owned references: the linked activity/decision must be THIS project's
    // (the composite DB foreign keys are the backstop; this gives a readable error).
    const activityId = await resolveProjectRef(this.prisma, 'activity', projectId, input.activityId, 'activityId');
    const decisionId = await resolveProjectRef(this.prisma, 'decision', projectId, input.decisionId, 'decisionId');
    let key: string;
    let data: Buffer | null;
    let sizeBytes: number;
    if (input.storageKey) {
      // presigned path: the bytes are already in the (private) bucket; record the pointer.
      // The key is client-supplied (echoed back from /presign), so bind it to this project:
      // our keys are `${projectId}/drawings/<uuid>.<ext>` — reject anything else so a PMC
      // can't point a revision at (and later serve) another project's object.
      if (!input.storageKey.startsWith(`${projectId}/drawings/`)) {
        throw new BadRequestException('storageKey does not belong to this project');
      }
      key = input.storageKey;
      data = null;
      sizeBytes = input.sizeBytes ?? 0;
    } else {
      // base64 path (dev stub / small files): S3 mode PUTs to the private bucket and drops
      // the bytes from the row; dev stub keeps them. We never persist a public bucket URL —
      // the file is only reached through the token-gated serve endpoint (presigned GET).
      const bytes = Buffer.from(input.data!, 'base64');
      key = this.storage.keyFor(projectId, 'drawings', input.mime);
      const { url: bucketUrl } = await this.storage.put(key, bytes, input.mime);
      data = bucketUrl ? null : bytes;
      sizeBytes = bytes.length;
    }

    // NOTE: no projectId here — the nested create inherits BOTH composite-FK scalars
    // (projectId, drawingId) from its parent drawing; the standalone revision create
    // below supplies them explicitly. Containment is the (projectId, drawingId) FK.
    const revData = {
      rev: input.rev,
      status: input.status,
      mime: input.mime,
      data,
      url: null, // never store a public bucket URL (private-file delivery)
      storageKey: key,
      sizeBytes,
      note: input.note ?? '',
      issuedBy: actor.actorName,
      issuedAt: ddMmmYyyy(new Date()),
    };

    let drawingId = '';
    let revisionId = '';
    // Draft → Publish: a brand-new drawing is a private draft unless `publish` is set. An
    // existing drawing that's already published stays published (adding a revision is a normal
    // issue); publishing an existing draft is also honoured. `published` decides the notice.
    let published = false;
    let isRevise = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        // SERIALIZE on the parent drawing (gate finding 2): lock the register row so a
        // concurrent issue/publish of the same number waits, then sees THIS issue's
        // committed state — the supersede/create pair executes strictly one-at-a-time
        // and exactly one live for_construction revision can survive (the partial
        // unique index is the database backstop). Every decision about the drawing is
        // taken from the LOCKED row, never from a stale pre-transaction read.
        const [locked] = await tx.$queryRaw<Array<{ id: string; publishedAt: Date | null }>>(
          Prisma.sql`SELECT "id", "publishedAt" FROM "Drawing" WHERE "projectId" = ${projectId} AND "number" = ${input.number} FOR UPDATE`,
        );
        if (locked) {
          isRevise = true;
          published = locked.publishedAt !== null || input.publish;
          const wasDraft = locked.publishedAt === null;
          const publishedAt = locked.publishedAt ?? (input.publish ? new Date() : null);
          // SCOPED supersession: only a construction issue displaces the construction
          // set — a review copy coexists and displaces nothing (Phase 1 Task 3).
          if (input.status === 'for_construction') {
            await tx.drawingRevision.updateMany({
              where: { drawingId: locked.id, status: 'for_construction' },
              data: { status: 'superseded' },
            });
          }
          const rev = await tx.drawingRevision.create({ data: { ...revData, projectId, drawingId: locked.id } });
          await tx.drawing.update({
            where: { id: locked.id },
            data: { title: input.title, discipline: input.discipline, zone: input.zone, activityId, decisionId, nodeId, publishedAt },
          });
          drawingId = locked.id;
          revisionId = rev.id;
          // Freeze WHO the published intent reaches. A one-step publish of an existing
          // DRAFT is the issue moment for EVERY live revision it accumulated (gate
          // finding 5) — not just the newest; an already-published drawing freezes
          // only the new revision. A continuing draft freezes nothing yet.
          if (published) {
            if (wasDraft && input.publish) {
              const unfrozen = await tx.drawingRevision.findMany({
                where: { drawingId: locked.id, status: { not: 'superseded' }, recipientsFrozenAt: null },
                select: { id: true },
              });
              for (const r of unfrozen) await this.freezeRecipients(tx, projectId, r.id);
            } else {
              await this.freezeRecipients(tx, projectId, revisionId);
            }
          }
        } else {
          published = input.publish;
          const drawing = await tx.drawing.create({
            data: {
              projectId,
              number: input.number,
              title: input.title,
              discipline: input.discipline,
              zone: input.zone,
              activityId,
              decisionId,
              nodeId,
              authorId: user.sub,
              publishedAt: published ? new Date() : null,
              revisions: { create: revData },
            },
            include: { revisions: true },
          });
          drawingId = drawing.id;
          revisionId = drawing.revisions[0].id;
          if (published) await this.freezeRecipients(tx, projectId, revisionId);
        }
        await tx.auditLog.create({
          data: {
            projectId,
            actor: actor.actorName,
            actorId: actor.actorId,
            actorRole: actor.actorRole,
            action: isRevise ? 'drawing.revise' : 'drawing.issue',
            entity: 'DrawingRevision',
            entityId: revisionId,
            payload: { number: input.number, rev: input.rev, status: input.status },
          },
        });
      });
    } catch (e) {
      // a unique fired: the (drawingId, rev) label, a concurrent same-number create,
      // or the one-construction-per-drawing backstop — all mean "someone else won"
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`Rev ${input.rev} of ${input.number} conflicts with a concurrent issue — reload and retry`);
      }
      throw e;
    }

    // A draft notifies no one — only a published drawing reaches the people who build from it.
    if (published) {
      this.realtime.notifyChanged(projectId, `Drawing issued: ${input.number} Rev ${input.rev} — ${input.title}`, ['engineer', 'contractor']);
    }
    return { drawingId, revisionId };
  }

  /** Publish a private draft drawing → issue it to the build team. PMC authority; the fresh
   *  snapshot returns it. Publishing IS the issue for its revisions, so the distribution is
   *  frozen now (for every revision that never had a snapshot). Re-publishing conflicts —
   *  and the publish is serialized on the drawing row + CAS-guarded, so a concurrent
   *  duplicate can never publish (or audit/notify) twice (gate finding 2). */
  async publish(projectId: string, drawingId: string, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const d = await this.prisma.drawing.findUnique({ where: { id: drawingId } });
    if (!d || d.projectId !== projectId) throw new NotFoundException('Drawing not found');
    if (d.publishedAt) throw new ConflictException('Drawing is already published');

    await this.prisma.$transaction(async (tx) => {
      // lock the drawing row, then CAS on publishedAt STILL null — the loser of a
      // concurrent publish (or a racing one-step issue) gets a clean 409, not a
      // second publication with duplicate audit/notification
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Drawing" WHERE "id" = ${drawingId} FOR UPDATE`);
      const { count } = await tx.drawing.updateMany({
        where: { id: drawingId, projectId, publishedAt: null },
        data: { publishedAt: new Date() },
      });
      if (count === 0) throw new ConflictException('Drawing is already published');
      const unfrozen = await tx.drawingRevision.findMany({
        where: { drawingId, status: { not: 'superseded' }, recipientsFrozenAt: null },
        select: { id: true },
      });
      for (const rev of unfrozen) await this.freezeRecipients(tx, projectId, rev.id);
      await tx.auditLog.create({
        data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'drawing.publish', entity: 'Drawing', entityId: drawingId, payload: { number: d.number } },
      });
    });
    this.realtime.notifyChanged(projectId, `Drawing issued: ${d.number} — ${d.title}`, ['engineer', 'contractor']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Re-file a drawing onto a location-tree node (or null to unfile). Scoped to the
   *  caller's project. Returns the fresh snapshot so the client reconciles. Location spine. */
  async setNode(id: string, projectId: string, nodeId: string | null, user: AuthUser): Promise<SnapshotDto> {
    const drawing = await this.prisma.drawing.findUnique({ where: { id } });
    if (!drawing || drawing.projectId !== projectId) throw new NotFoundException('Drawing not found');
    const resolved = await resolveProjectNode(this.prisma, projectId, nodeId);
    const actor = await resolveActor(this.prisma, user);
    await this.prisma.$transaction([
      this.prisma.drawing.update({ where: { id }, data: { nodeId: resolved } }),
      this.prisma.auditLog.create({
        data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'drawing.refile', entity: 'Drawing', entityId: id, payload: { nodeId: resolved } },
      }),
    ]);
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /**
   * Record a build-acknowledgement: the caller confirms they are building to this
   * revision. IDEMPOTENT AS A COMMAND (gate finding 3): the first call creates the
   * ack row AND its audit in one transaction and notifies the PMC; a replay (the
   * offline outbox re-sending, a double-tap, a concurrent duplicate) records
   * NOTHING new and just returns the current count. Ack and audit are atomic —
   * neither can exist without the other. Client can't acknowledge (they don't build).
   */
  async acknowledge(projectId: string, revisionId: string, user: AuthUser): Promise<{ ok: boolean; ackCount: number }> {
    if (user.role === 'client') throw new ForbiddenException('Only the build team acknowledges drawings');
    const rev = await this.prisma.drawingRevision.findUnique({ where: { id: revisionId }, include: { drawing: true } });
    if (!rev || rev.drawing.projectId !== projectId) throw new NotFoundException('Drawing revision not found');

    const actor = await resolveActor(this.prisma, user);

    let firstAck = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.drawingAck.findUnique({ where: { revisionId_userId: { revisionId, userId: user.sub } } });
        if (existing) return; // replay — the fact is already recorded and audited
        await tx.drawingAck.create({ data: { revisionId, userId: user.sub, userName: actor.actorName, role: user.role } });
        await tx.auditLog.create({
          data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'drawing.ack', entity: 'DrawingRevision', entityId: revisionId, payload: { number: rev.drawing.number, rev: rev.rev } },
        });
        firstAck = true;
      });
    } catch (e) {
      // a concurrent duplicate slipped past the read — the unique makes it a replay
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        firstAck = false;
      } else {
        throw e;
      }
    }

    const ackCount = await this.prisma.drawingAck.count({ where: { revisionId } });
    // only the FIRST acknowledgement announces — a replay repeats nothing
    if (firstAck) this.realtime.notifyChanged(projectId, `${actor.actorName} is building to ${rev.drawing.number} Rev ${rev.rev}`, ['pmc']);
    return { ok: true, ackCount };
  }

  /** Fetch a revision's file: inline bytes (dev stub) or a redirect to the bucket URL. */
  async fetchRevision(id: string): Promise<RevisionBytes | RevisionRedirect | null> {
    const row = await this.prisma.drawingRevision.findUnique({ where: { id } });
    if (!row) return null;
    if (row.data) return { mime: row.mime, bytes: Buffer.from(row.data) };
    if (row.storageKey) {
      const signed = await this.storage.presignGet(row.storageKey);
      if (signed) return { redirect: signed };
    }
    if (row.url) return { redirect: row.url }; // legacy public row (back-compat)
    return null;
  }

  /** Delete a whole drawing (all revisions + files), scoped to the project. Audited. */
  async remove(id: string, projectId: string, user: AuthUser): Promise<boolean> {
    const drawing = await this.prisma.drawing.findUnique({ where: { id }, include: { revisions: true } });
    if (!drawing || drawing.projectId !== projectId) return false;
    const actor = await resolveActor(this.prisma, user);
    await Promise.all(drawing.revisions.map((r) => (r.storageKey ? this.storage.remove(r.storageKey).catch(() => {}) : Promise.resolve())));
    await this.prisma.$transaction([
      this.prisma.drawing.delete({ where: { id } }), // revisions + recipients cascade
      this.prisma.auditLog.create({
        data: { projectId, actor: actor.actorName, actorId: actor.actorId, actorRole: actor.actorRole, action: 'drawing.remove', entity: 'Drawing', entityId: id, payload: { number: drawing.number } },
      }),
    ]);
    this.realtime.notifyChanged(projectId);
    return true;
  }
}
