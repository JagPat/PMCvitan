import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { StorageService } from '../../media/storage.service';
import { fetchHubContent, type HubContentRef, type HubContentType, type HubFetchFailure, type HubFetchOptions } from './hub-client';

/** Where Hub bytes are kept: `<projectId>/hub/<uuid>.<ext>`, the only key shape the ledger accepts (U1a-3 B4). */
export const HUB_BLOB_KIND = 'hub';

export type HubBlob =
  | {
      ok: true;
      /** the ledger row's key, also the object's key in storage */
      storageKey: string;
      /** the stored object's URL (S3/R2), or null for the dev stub, where the caller keeps `bytes` itself */
      url: string | null;
      bytes: Buffer;
      mime: HubContentType;
      sizeBytes: number;
      sha256: string;
    }
  | { ok: false; failure: HubFetchFailure; status?: number; retryable: boolean };

/**
 * #1118 U4 — fetches one Hub version into storage (`notes/hub/1118-plan.md` U4), for U5 to import.
 *
 * In order:
 *  1. The bytes are fetched and checked ({@link fetchHubContent}). A refused fetch writes nothing anywhere.
 *  2. The ledger row (`HubFetchedBlob`: key, project, Hub version) commits in its own short transaction, outside any
 *     import transaction, BEFORE the upload starts. So every object a Hub fetch puts in storage has a ledger row, even
 *     when the process dies between the upload and the import, and the sweep (U5s), which walks only the ledger, can
 *     always find it. A row whose upload then failed names an object that isn't there; removing it is harmless.
 *  3. The bytes are stored under a new key in the Hub namespace, with the type read from the bytes, never one Hub or
 *     the event named.
 *
 * Nothing here decides whether the version is imported; U5 does, and an unused blob is the sweep's. A database or
 * storage error is thrown, so the delivery answers 5xx and Hub retries it.
 */
@Injectable()
export class HubBlobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async fetchIntoStorage(projectId: string, ref: HubContentRef, options: HubFetchOptions = {}): Promise<HubBlob> {
    const content = await fetchHubContent(ref, options);
    if (!content.ok) return content;

    const storageKey = this.storage.keyFor(projectId, HUB_BLOB_KIND, content.mime);
    await this.prisma.hubFetchedBlob.create({ data: { storageKey, projectId, hubVersionId: ref.versionId }, select: { id: true } });
    const { url } = await this.storage.put(storageKey, content.bytes, content.mime);
    return { ok: true, storageKey, url, bytes: content.bytes, mime: content.mime, sizeBytes: content.bytes.length, sha256: content.sha256 };
  }
}
