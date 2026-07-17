import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { StorageService } from './storage.service';
import { SignedUrlService } from './signed-url.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { SnapshotService } from '../snapshot/snapshot.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { resolveProjectNode } from '../nodes/node-scope';
import { resolveProjectRef } from '../common/project-ref';
import type { AuthUser } from '../common/auth';
import type { SnapshotDto } from '../snapshot/types';
import type { CreateMediaInput } from '../contracts';
import { resolveActor } from '../common/actor';
import { emitEvent } from '../platform/events';
import type { EmittedEventMeta } from '../platform/outbox/registry';

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
    // PR C Task 2 — the single external-effect sender (replaces the in-request RealtimeGateway).
    private readonly dispatcher: ExternalEffectDispatcher,
    private readonly snapshot: SnapshotService,
    // Task 8 — a linked decision reference is validated through the decisions query.
    private readonly decisions: DecisionsQueryService,
  ) {}

  /** Persist an uploaded photo and return its id + a signed, resolvable URL.
   *  IDEMPOTENT per (projectId, clientKey): replaying the same key returns the
   *  already-stored row — an offline photo uploads exactly once (Phase 1 Task 4). */
  async create(projectId: string, user: AuthUser, input: CreateMediaInput): Promise<UploadedMedia> {
    const uploadedBy = user.sub;
    // idempotency fast-path: this exact photo already landed
    if (input.clientKey) {
      const existing = await this.prisma.media.findUnique({
        where: { projectId_clientKey: { projectId, clientKey: input.clientKey } },
        select: { id: true },
      });
      if (existing) return { id: existing.id, url: this.signed.mediaPath(existing.id) };
    }
    // Location spine: validate the place tag belongs to this project before storing.
    const nodeId = await resolveProjectNode(this.prisma, projectId, input.nodeId);
    // Project-owned references: a photo may only point at THIS project's decision/log.
    const decisionId = await this.decisions.resolveRefInProject(projectId, input.decisionId, 'decisionId');
    const dailyLogId = await resolveProjectRef(this.prisma, 'dailyLog', projectId, input.dailyLogId, 'dailyLogId');
    // Evidence linkage (Task 4): the item requires ITS inspection — validated here for a
    // readable 400; the composite-FK chain + CHECK are the database backstop.
    if (input.inspectionItemId && !input.inspectionId) {
      throw new BadRequestException('inspectionItemId requires its inspectionId');
    }
    if (input.inspectionId) {
      const insp = await this.prisma.inspection.findUnique({ where: { id: input.inspectionId }, select: { projectId: true } });
      if (!insp || insp.projectId !== projectId) throw new BadRequestException('Unknown inspection for this project');
      if (input.inspectionItemId) {
        const item = await this.prisma.inspectionItem.findUnique({ where: { id: input.inspectionItemId }, select: { inspectionId: true } });
        if (!item || item.inspectionId !== input.inspectionId) throw new BadRequestException('The item does not belong to that inspection');
      }
    }
    const bytes = Buffer.from(input.data, 'base64');
    const key = this.storage.keyFor(projectId, input.kind, input.mime);
    // S3 mode PUTs the bytes to the (private) bucket and returns its url; we DON'T persist
    // that public url — the file is only ever reached through the token-gated serve
    // endpoint, which presigns a GET on demand. Dev stub keeps the bytes in the row.
    const { url: bucketUrl } = await this.storage.put(key, bytes, input.mime);
    const actor = await resolveActor(this.prisma, user);

    let row;
    let ev: EmittedEventMeta | undefined;
    try {
      // the row and its `media.uploaded` event commit together (a replay of the same
      // clientKey lands on the unique below and records NO second event)
      row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.media.create({
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
            decisionId,
            dailyLogId,
            nodeId,
            inspectionId: input.inspectionId ?? null,
            inspectionItemId: input.inspectionItemId ?? null,
            clientKey: input.clientKey ?? null,
          },
        });
        ev = await emitEvent(tx, { projectId, actor, eventType: 'media.uploaded', entityType: 'Media', entityId: created.id, payload: { kind: input.kind }, effectKey: 'media.uploaded', dispatch: {} });
        return created;
      });
    } catch (e) {
      // a concurrent replay of the same clientKey landed first — return ITS row
      // (the unique is the DB proof the photo persisted exactly once)
      if (input.clientKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.media.findUniqueOrThrow({
          where: { projectId_clientKey: { projectId, clientKey: input.clientKey } },
          select: { id: true },
        });
        return { id: winner.id, url: this.signed.mediaPath(winner.id) };
      }
      throw e;
    }

    // a fresh upload signals its project once; a replay (P2002 return above) never reaches here
    if (ev) await this.dispatcher.dispatchCommitted([ev]);
    // a short-lived, signed path resolved against the API base by the frontend
    return { id: row.id, url: this.signed.mediaPath(row.id) };
  }

  /** Re-file a photo onto a location-tree node (or null to unfile). Scoped to the
   *  caller's project. Returns the fresh snapshot so the client reconciles. Location spine. */
  async setNode(id: string, projectId: string, nodeId: string | null, user: AuthUser): Promise<SnapshotDto> {
    const row = await this.prisma.media.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Media not found');
    const resolved = await resolveProjectNode(this.prisma, projectId, nodeId);
    const actor = await resolveActor(this.prisma, user);
    const ev = await this.prisma.$transaction(async (tx) => {
      await tx.media.update({ where: { id }, data: { nodeId: resolved } });
      return emitEvent(tx, { projectId, actor, eventType: 'media.refiled', entityType: 'Media', entityId: id, payload: { nodeId: resolved }, effectKey: 'media.refiled', dispatch: {} });
    });
    await this.dispatcher.dispatchCommitted([ev]);
    return this.snapshot.build(projectId, user.role, user.sub);
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
  async remove(id: string, user: AuthUser): Promise<boolean> {
    const projectId = user.projectId;
    const row = await this.prisma.media.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) return false;
    if (row.storageKey) await this.storage.remove(row.storageKey).catch(() => {});
    const actor = await resolveActor(this.prisma, user);
    const ev = await this.prisma.$transaction(async (tx) => {
      await tx.media.delete({ where: { id } });
      return emitEvent(tx, { projectId, actor, eventType: 'media.removed', entityType: 'Media', entityId: id, effectKey: 'media.removed', dispatch: {} });
    });
    await this.dispatcher.dispatchCommitted([ev]);
    return true;
  }
}
