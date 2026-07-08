import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/gif': 'gif',
  // documents (drawings register): PDF for the field, DWG as the CAD source
  'application/pdf': 'pdf',
  'image/vnd.dwg': 'dwg',
  'application/acad': 'dwg',
  'application/dxf': 'dxf',
  'image/vnd.dxf': 'dxf',
};

/**
 * Object storage for site photos. Provider-agnostic, dev-stub-first:
 *   • S3/R2 configured (S3_ENDPOINT + S3_BUCKET + key/secret) → bytes are
 *     PUT to the bucket and a public URL is returned.
 *   • no provider → returns { url: null }; the caller keeps the bytes in the
 *     DB row and serves them from GET /media/:id (the dev stub).
 * Flipping from stub to cloud is env-only — no code change (mirrors SmsService).
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger('StorageService');
  private client: S3Client | null = null;

  /** True when a bucket is configured; otherwise photos are kept in the DB (dev stub). */
  get configured(): boolean {
    return Boolean(
      process.env.S3_ENDPOINT &&
        process.env.S3_BUCKET &&
        process.env.S3_ACCESS_KEY_ID &&
        process.env.S3_SECRET_ACCESS_KEY,
    );
  }

  private s3(): S3Client {
    this.client ??= new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: process.env.S3_REGION || 'auto',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
      },
    });
    return this.client;
  }

  /** Deterministic-ish object key: <project>/<kind>/<uuid>.<ext>. */
  keyFor(projectId: string, kind: string, mime: string): string {
    const ext = MIME_EXT[mime] ?? 'bin';
    return `${projectId}/${kind}/${randomUUID()}.${ext}`;
  }

  /** Public URL for an object key (S3 mode). */
  publicUrl(key: string): string {
    const base = (process.env.S3_PUBLIC_BASE || `${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}`).replace(/\/+$/, '');
    return `${base}/${key}`;
  }

  /** Store bytes. S3 mode → returns the public URL; dev stub → returns { url: null }. */
  async put(key: string, bytes: Buffer, mime: string): Promise<{ url: string | null }> {
    if (!this.configured) return { url: null };
    await this.s3().send(
      new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: bytes, ContentType: mime }),
    );
    this.log.log(`stored ${key} (${bytes.length} bytes) in S3`);
    return { url: this.publicUrl(key) };
  }

  /**
   * A presigned PUT URL for a direct-to-bucket upload (S3 mode) — the client PUTs
   * the file's bytes straight to the bucket, bypassing the API's request-body
   * limit (large drawings, Slice 3). Returns null when no bucket is configured, so
   * the caller falls back to the base64 body path (the current dev-stub default).
   */
  async presignPut(key: string, mime: string, expiresIn = 900): Promise<{ uploadUrl: string; url: string } | null> {
    if (!this.configured) return null;
    const cmd = new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, ContentType: mime });
    const uploadUrl = await getSignedUrl(this.s3(), cmd, { expiresIn });
    return { uploadUrl, url: this.publicUrl(key) };
  }

  /** Delete a stored object (S3 mode). Dev stub keeps bytes in the DB row, so no-op here. */
  async remove(key: string): Promise<void> {
    if (!this.configured) return;
    await this.s3().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    this.log.log(`deleted ${key} from S3`);
  }

  /** @internal test seam — inject a fake S3 client. */
  _setClient(c: S3Client): void {
    this.client = c;
  }
}
