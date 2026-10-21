import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * The media module's read contract for other modules: a foreign reader asks here instead of reading
 * the media-owned `Media` table directly, so media can change its read model without silently breaking
 * a rollup elsewhere.
 */
@Injectable()
export class MediaQueryService {
  constructor(private readonly prisma: PrismaService) {}

  /** U3a — how many progress photos a project gained at or after `since` (the PMC brief's figure). */
  progressPhotoCountSince(projectId: string, since: Date): Promise<number> {
    return this.prisma.media.count({ where: { projectId, kind: 'progress', createdAt: { gte: since } } });
  }

  /** #792 SV2 — what a visit's files show beside their link: each file's type, when the device took it, and, to its
   *  own uploader (`viewerId`) alone, the uploading device's key for it (so that phone can tell its queued copy from
   *  the stored file; nobody else's key is sent, as the snapshot's photos: Codex 4324453890), by id. A marked-up copy
   *  also names the photo it was drawn on (M3), which is on the same visit, so every reader of the visit has it too. */
  async fileFacts(projectId: string, ids: string[], viewerId: string): Promise<Map<string, { mime: string; takenAt: string | null; clientKey: string | null; sourceMediaId: string | null }>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.media.findMany({
      where: { projectId, id: { in: ids } }, select: { id: true, mime: true, takenAt: true, clientKey: true, uploadedBy: true, sourceMediaId: true },
    });
    return new Map(rows.map((r) => [r.id, {
      mime: r.mime, takenAt: r.takenAt, clientKey: r.uploadedBy === viewerId ? r.clientKey : null, sourceMediaId: r.sourceMediaId,
    }]));
  }
}
