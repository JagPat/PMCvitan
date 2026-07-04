import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { StorageService } from './storage.service';
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
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Persist an uploaded photo and return its id + resolvable URL. */
  async create(projectId: string, uploadedBy: string, input: CreateMediaInput): Promise<UploadedMedia> {
    const bytes = Buffer.from(input.data, 'base64');
    const key = this.storage.keyFor(projectId, input.kind, input.mime);
    const { url } = await this.storage.put(key, bytes, input.mime);

    const row = await this.prisma.media.create({
      data: {
        projectId,
        kind: input.kind,
        mime: input.mime,
        uploadedBy,
        sizeBytes: bytes.length,
        storageKey: key,
        // dev stub keeps the bytes in the row; S3/R2 mode drops them (url is set)
        data: url ? null : bytes,
        url,
        geoLat: input.geoLat,
        geoLng: input.geoLng,
        takenAt: input.takenAt,
        decisionId: input.decisionId,
        dailyLogId: input.dailyLogId,
      },
    });

    this.realtime.notifyChanged(projectId);
    // S3/R2 → absolute bucket URL; dev stub → relative path resolved against the API base
    return { id: row.id, url: url ?? `/media/${row.id}` };
  }

  /** Fetch a photo: inline bytes (dev stub) or a redirect to the bucket URL (S3/R2). */
  async fetch(id: string): Promise<MediaBytes | MediaRedirect | null> {
    const row = await this.prisma.media.findUnique({ where: { id } });
    if (!row) return null;
    if (row.url) return { redirect: row.url };
    if (row.data) return { mime: row.mime, bytes: Buffer.from(row.data) };
    return null;
  }
}
