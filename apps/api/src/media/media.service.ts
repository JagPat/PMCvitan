import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StorageService } from './storage.service';
import { SignedUrlService } from './signed-url.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import type { CreateMediaInput } from '../contracts';

export interface UploadedMedia {
  id: string;
  url: string;
}

export type MediaBytes = { mime: string; bytes: Buffer };
export type MediaRedirect = { redirect: string };

/** Create + serve site photos, backed by StorageService (S3/R2 or the DB dev stub). */
@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly signed: SignedUrlService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Persist an uploaded photo and return its id + a signed, resolvable URL. */
  async create(projectId: string, uploadedBy: string, input: CreateMediaInput): Promise<UploadedMedia> {
    const bytes = Buffer.from(input.data, 'base64');
    const key = this.storage.keyFor(projectId, input.kind, input.mime);
    // S3 mode PUTs the bytes to the (private) bucket and returns its url; we DON'T persist
    // that public url — the file is only ever reached through the token-gated serve
    // endpoint, which presigns a GET on demand. Dev stub keeps the bytes in the row.
    const { url: bucketUrl } = await this.storage.put(key, bytes, input.mime);

    const row = await this.prisma.media.create({
      data: {
        projectId,
        kind: input.kind,
        mime: input.mime,
        uploadedBy,
        sizeBytes: bytes.length,
        storageKey: key,
        data: bucketUrl ? null : bytes, // bucket mode drops the bytes; stub keeps them
        url: null, // never store a public bucket URL (private-file delivery)
        geoLat: input.geoLat,
        geoLng: input.geoLng,
        takenAt: input.takenAt,
        decisionId: input.decisionId,
        dailyLogId: input.dailyLogId,
      },
    });

    this.realtime.notifyChanged(projectId);
    // a short-lived, signed path resolved against the API base by the frontend
    return { id: row.id, url: this.signed.mediaPath(row.id) };
  }

  /**
   * Fetch a photo for the serve endpoint (which has already verified the file token):
   * inline bytes (dev stub), a presigned private-bucket GET (S3/R2), or a legacy public
   * url redirect (rows created before private delivery — none exist in dev-stub prod).
   */
  async fetch(id: string): Promise<MediaBytes | MediaRedirect | null> {
    const row = await this.prisma.media.findUnique({ where: { id } });
    if (!row) return null;
    if (row.data) return { mime: row.mime, bytes: Buffer.from(row.data) };
    if (row.storageKey) {
      const signed = await this.storage.presignGet(row.storageKey);
      if (signed) return { redirect: signed };
    }
    if (row.url) return { redirect: row.url }; // legacy public row (back-compat)
    return null;
  }

  /**
   * Delete a photo (bucket object + DB row). Scoped to the caller's project so
   * one project can't delete another's media. Returns false when not found /
   * out of scope. Best-effort on the bucket delete (dev stub is a no-op).
   */
  async remove(id: string, projectId: string): Promise<boolean> {
    const row = await this.prisma.media.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) return false;
    if (row.storageKey) await this.storage.remove(row.storageKey).catch(() => {});
    await this.prisma.media.delete({ where: { id } });
    this.realtime.notifyChanged(projectId);
    return true;
  }
}
