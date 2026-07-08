import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StorageService } from '../media/storage.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { ddMmmYyyy } from '../domain/dates';
import type { IssueDrawingInput } from '../contracts';

export interface IssuedDrawing {
  drawingId: string;
  revisionId: string;
}

export type RevisionBytes = { mime: string; bytes: Buffer };
export type RevisionRedirect = { redirect: string };

/**
 * The drawings register (Slice 1). Issue a drawing revision — a new `number`
 * creates a register entry; an existing one adds a revision and supersedes the
 * prior ones, so the field always builds from the current `for_construction`
 * drawing. Files are held by StorageService (S3/R2 or the DB dev stub).
 */
@Injectable()
export class DrawingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async issue(projectId: string, issuedBy: string, input: IssueDrawingInput): Promise<IssuedDrawing> {
    const bytes = Buffer.from(input.data, 'base64');
    const key = this.storage.keyFor(projectId, 'drawings', input.mime);
    const { url } = await this.storage.put(key, bytes, input.mime);

    const revData = {
      rev: input.rev,
      status: input.status,
      mime: input.mime,
      // dev stub keeps the bytes in the row; S3/R2 mode drops them (url is set)
      data: url ? null : bytes,
      url,
      storageKey: key,
      sizeBytes: bytes.length,
      note: input.note ?? '',
      issuedBy,
      issuedAt: ddMmmYyyy(new Date()),
    };

    const existing = await this.prisma.drawing.findUnique({
      where: { projectId_number: { projectId, number: input.number } },
    });

    let drawingId: string;
    let revisionId: string;
    if (existing) {
      const [, rev] = await this.prisma.$transaction([
        // supersede whatever was current before this issue
        this.prisma.drawingRevision.updateMany({
          where: { drawingId: existing.id, status: { not: 'superseded' } },
          data: { status: 'superseded' },
        }),
        this.prisma.drawingRevision.create({ data: { ...revData, drawingId: existing.id } }),
        this.prisma.drawing.update({
          where: { id: existing.id },
          data: { title: input.title, discipline: input.discipline, zone: input.zone, activityId: input.activityId, decisionId: input.decisionId },
        }),
      ]);
      drawingId = existing.id;
      revisionId = rev.id;
    } else {
      const drawing = await this.prisma.drawing.create({
        data: {
          projectId,
          number: input.number,
          title: input.title,
          discipline: input.discipline,
          zone: input.zone,
          activityId: input.activityId,
          decisionId: input.decisionId,
          revisions: { create: revData },
        },
        include: { revisions: true },
      });
      drawingId = drawing.id;
      revisionId = drawing.revisions[0].id;
    }

    // issued to the people who build from it
    this.realtime.notifyChanged(projectId, `Drawing issued: ${input.number} Rev ${input.rev} — ${input.title}`, ['engineer', 'contractor']);
    return { drawingId, revisionId };
  }

  /** Fetch a revision's file: inline bytes (dev stub) or a redirect to the bucket URL. */
  async fetchRevision(id: string): Promise<RevisionBytes | RevisionRedirect | null> {
    const row = await this.prisma.drawingRevision.findUnique({ where: { id } });
    if (!row) return null;
    if (row.url) return { redirect: row.url };
    if (row.data) return { mime: row.mime, bytes: Buffer.from(row.data) };
    return null;
  }

  /** Delete a whole drawing (all revisions + files), scoped to the project. */
  async remove(id: string, projectId: string): Promise<boolean> {
    const drawing = await this.prisma.drawing.findUnique({ where: { id }, include: { revisions: true } });
    if (!drawing || drawing.projectId !== projectId) return false;
    await Promise.all(drawing.revisions.map((r) => (r.storageKey ? this.storage.remove(r.storageKey).catch(() => {}) : Promise.resolve())));
    await this.prisma.drawing.delete({ where: { id } }); // revisions cascade
    this.realtime.notifyChanged(projectId);
    return true;
  }
}
