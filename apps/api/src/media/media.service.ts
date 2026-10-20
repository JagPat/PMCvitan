import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { StorageService } from './storage.service';
import { SignedUrlService } from './signed-url.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { SnapshotService } from '../snapshot/snapshot.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { DailyLogQueryService } from '../daily-log/daily-log.query';
import { InspectionsQueryService } from '../inspections/inspections.query';
import { InspectionParticipant } from '../inspections/inspection.participant';
import { InventoryParticipant } from '../inventory/inventory.participant';
import { LabourRequirementParticipant } from '../labour/labour.participant';
import { ActivityParticipant } from '../activities/activity.participant';
import { CommercialParticipant } from '../commercial/commercial.participant';
import { SiteVisitFilesParticipant } from '../site-visits/site-visit-files.participant';
import { isPlaceHiddenFrom, previewPublishedProjectNode, resolvePublishedProjectNode } from '../nodes/node-scope';
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
  /** #482 site photos — when the server recorded it (ISO), so a device shows the time the snapshot will */
  at: string;
}

/** The roles that keep the record-linked uploads: evidence for a decision or an inspection item, or a non-progress kind. */
const SITE_RECORD_ROLES: ReadonlySet<string> = new Set(['pmc', 'engineer']);

/** A plain site photo: a progress photo, optionally placed on the location tree and filed on the day's log it was
 *  taken for (#482, Board 14 Oct 2026: every member adds photos to that day's record), linked to no other record. */
function isPlainSitePhoto(input: CreateMediaInput): boolean {
  return input.kind === 'progress' && !input.decisionId && !input.inspectionId && !input.inspectionItemId;
}

/** A file added on a site visit (#792 SV2, Jagrut 19 Oct 2026: office staff and site engineers add them from their
 *  phones): kind 'visit', naming its visit, and filed on nothing else. Who may add one is the site-visits module's. */
function isSiteVisitFile(input: CreateMediaInput): boolean {
  return input.kind === 'visit' && input.siteVisit !== undefined
    && !input.decisionId && !input.dailyLogId && !input.inspectionId && !input.inspectionItemId;
}

/** Whether a voice note's first bytes are the container its type names: WebM (EBML), Ogg, or MP4 (`ftyp`). The type is
 *  the client's word; the bytes are checked so a file is served only as what it is. */
function voiceBytesMatch(mime: string, base64: string): boolean {
  const head = Buffer.from(base64.slice(0, 24), 'base64');
  if (mime === 'audio/webm') return head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === 'audio/ogg') return head.subarray(0, 4).toString('latin1') === 'OggS';
  if (mime === 'audio/mp4') return head.subarray(4, 8).toString('latin1') === 'ftyp';
  return false;
}

/** What a clientKey replay must read to decide whether the caller may have the stored row back. */
const REPLAY_SELECT = { id: true, createdAt: true, kind: true, uploadedBy: true, decisionId: true, dailyLogId: true, inspectionId: true, inspectionItemId: true, nodeId: true } as const;
type ReplayRow = { id: string; createdAt: Date; kind: string; uploadedBy: string; decisionId: string | null; dailyLogId: string | null; inspectionId: string | null; inspectionItemId: string | null; nodeId: string | null };

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
    // Task 10 — a linked daily-log reference is validated through the daily-log query.
    private readonly dailyLog: DailyLogQueryService,
    // Task 10 (Module 3) — an evidence upload's inspection linkage is validated through the inspections query.
    private readonly inspections: InspectionsQueryService,
    // Task 10 (Module 3) correction — item evidence is linked through the inspections participant (in-tx),
    // which appends the inspection-owned evidence event so the projection observes the change.
    private readonly inspectionParticipant: InspectionParticipant,
    // Phase 3 Task 4 — a delete is refused while the photo is immutable stock-ledger evidence.
    private readonly inventoryParticipant: InventoryParticipant,
    private readonly labourParticipant: LabourRequirementParticipant,
    // Phase 4 Task 5 (§I) — measured-output evidence is delete-sealed while cited.
    private readonly activityParticipant: ActivityParticipant,
    // Phase 5 Task 3 (§D) — measurement evidence is delete-sealed while cited.
    private readonly commercialParticipant: CommercialParticipant,
    // #792 SV2 — a file added on a site visit is linked to it by the site-visits participant, in the upload's transaction
    private readonly siteVisitFiles: SiteVisitFilesParticipant,
  ) {}

  /** A clientKey replay returns the stored row only when the caller could have created it: for the roles
   *  narrowed to plain site photos, that is their OWN plain photo — never another member's evidence.
   *  And never a photo the caller cannot see now: one filed (before #881) on another member's private
   *  draft is answered as if it did not exist, as the snapshot and re-filing already answer it (#884). */
  private async replayed(projectId: string, user: AuthUser, row: ReplayRow): Promise<UploadedMedia> {
    if (!SITE_RECORD_ROLES.has(user.role)) {
      const plain = (row.kind === 'progress' || row.kind === 'visit') && !row.decisionId && !row.inspectionId && !row.inspectionItemId;
      if (!plain || row.uploadedBy !== user.sub) throw new ForbiddenException('This upload key belongs to another photo');
    }
    if (row.nodeId && (await this.prisma.$transaction((tx) => isPlaceHiddenFrom(tx, projectId, row.nodeId, user.sub)))) {
      throw new NotFoundException('Media not found');
    }
    return { id: row.id, url: this.signed.mediaPath(row.id), at: row.createdAt.toISOString() };
  }

  /** The photo a marked-up copy is drawn on: an image of this project that is a file on the same visit. The copy takes
   *  its camera time and location. The database refuses a copy of anything else as well (#990, K1 and K4). */
  private async markupSource(
    db: Prisma.TransactionClient | PrismaService, projectId: string, visitId: string, mediaId: string,
  ): Promise<{ id: string; takenAt: string | null; geoLat: number | null; geoLng: number | null }> {
    const row = await db.media.findFirst({ where: { projectId, id: mediaId }, select: { id: true, mime: true, takenAt: true, geoLat: true, geoLng: true } });
    if (!row || !(await this.siteVisitFiles.isFileOnVisit(db, projectId, visitId, mediaId))) {
      throw new NotFoundException('The photo to mark up is not on this site visit');
    }
    if (!row.mime.startsWith('image/')) throw new BadRequestException('Only a photo can be marked up');
    return { id: row.id, takenAt: row.takenAt, geoLat: row.geoLat, geoLng: row.geoLng };
  }

  /** Persist an uploaded photo and return its id + a signed, resolvable URL.
   *  IDEMPOTENT per (projectId, clientKey): replaying the same key returns the
   *  already-stored row — an offline photo uploads exactly once (Phase 1 Task 4). */
  async create(projectId: string, user: AuthUser, input: CreateMediaInput): Promise<UploadedMedia> {
    const uploadedBy = user.sub;
    // #482 (Board, 14 Oct 2026) — every member may add a SITE photo, filed on the day's log it was taken for; only
    // the PMC and the engineer may add one that is evidence for something (a decision, an inspection item) or a
    // non-progress kind.
    // Asked before the idempotency read and before any byte is stored, so a refused caller learns nothing
    // about another photo's key and leaves nothing in the bucket.
    if (input.siteVisit && !isSiteVisitFile(input)) {
      throw new BadRequestException('A file on a site visit is filed on the visit only, not on a log, a decision or an inspection');
    }
    // Stage 1 markup, site visits first (Jagrut, 19 Oct 2026): a marked-up copy goes on the visit beside the photo it
    // was drawn on, and keeps that photo's camera time and location, which the device does not send again
    if (input.sourceMediaId !== undefined) {
      if (!isSiteVisitFile(input)) throw new BadRequestException('A marked-up copy is added on a site visit, beside the photo it was drawn on');
      if (input.takenAt !== undefined || input.geoLat !== undefined || input.geoLng !== undefined) {
        throw new BadRequestException('A marked-up copy keeps the camera time and location of the photo it was drawn on');
      }
    }
    // Stage 1 voice notes, site visits first (Jagrut, 19 Oct 2026): a voice note is a file on a visit, never a copy
    if (input.mime.startsWith('audio/')) {
      if (!isSiteVisitFile(input) || input.sourceMediaId !== undefined) {
        throw new BadRequestException('A voice note is added on a site visit');
      }
      if (!voiceBytesMatch(input.mime, input.data)) throw new BadRequestException('This file is not the voice recording its type says');
    }
    if (!SITE_RECORD_ROLES.has(user.role) && !isPlainSitePhoto(input) && !isSiteVisitFile(input)) {
      throw new ForbiddenException('Your role may add a site photo, not evidence linked to a record');
    }
    // idempotency fast-path: this exact photo already landed
    if (input.clientKey) {
      const existing = await this.prisma.media.findUnique({
        where: { projectId_clientKey: { projectId, clientKey: input.clientKey } },
        select: REPLAY_SELECT,
      });
      if (existing) return this.replayed(projectId, user, existing);
    }
    // Location spine: the place must be this project's and PUBLISHED (a team photo never goes on a draft).
    // Checked here BEFORE the bytes are stored, as an early no; the tree's state is decided again under its
    // lock inside the transaction below, which is the authority.
    const nodeId = await previewPublishedProjectNode(this.prisma, projectId, input.nodeId);
    // A visit file: the visit is this project's, not closed, and the caller is on it (an early no, as above)
    const visit = input.siteVisit;
    if (visit) await this.siteVisitFiles.assertMayAdd(projectId, visit.visitId, user.sub);
    const source = visit && input.sourceMediaId ? await this.markupSource(this.prisma, projectId, visit.visitId, input.sourceMediaId) : null;
    // Project-owned references: a photo may only point at THIS project's decision/log.
    const decisionId = await this.decisions.resolveRefInProject(projectId, input.decisionId, 'decisionId');
    // Task 10 — a daily-log reference is validated through the daily-log module's query, not `project-ref`.
    const dailyLogId = await this.dailyLog.resolveRefInProject(projectId, input.dailyLogId, 'dailyLogId');
    // Evidence linkage (Task 4): the item requires ITS inspection — validated through the inspections
    // module's query (Task 10) for a readable 400; the composite-FK chain + CHECK are the database backstop.
    if (input.inspectionItemId && !input.inspectionId) {
      throw new BadRequestException('inspectionItemId requires its inspectionId');
    }
    if (input.inspectionId) {
      await this.inspections.assertEvidenceTarget(projectId, input.inspectionId, input.inspectionItemId);
      // AUTHORITY BEFORE BYTES (#571 round 10, finding 2). The authoritative check runs inside the
      // transaction below, where it cannot be overtaken — but `storage.put` has already written the
      // object by then, and the rollback that follows a refusal does not reach the bucket. A caller
      // refused here would still have persisted the bytes, and could do it again with a fresh
      // `clientKey` for as long as they liked: 403 after 403, each one leaving an unreferenced object
      // behind. This preflight is a CHEAP EARLY NO, not the authority — it reads outside any
      // transaction and may be stale, exactly like the submit path's pre-transaction guard, and the
      // in-transaction recheck below is what actually decides.
      await this.inspectionParticipant.assertEvidenceMutable(this.prisma as unknown as Prisma.TransactionClient, { projectId, inspectionId: input.inspectionId, actorUserId: user.sub, forUpdate: false });
    }
    const bytes = Buffer.from(input.data, 'base64');
    const key = this.storage.keyFor(projectId, input.kind, input.mime);
    // S3 mode PUTs the bytes to the (private) bucket and returns its url; we DON'T persist
    // that public url — the file is only ever reached through the token-gated serve
    // endpoint, which presigns a GET on demand. Dev stub keeps the bytes in the row.
    const { url: bucketUrl } = await this.storage.put(key, bytes, input.mime);
    const actor = await resolveActor(this.prisma, user);

    let row;
    let events: EmittedEventMeta[] = [];
    try {
      // the row and its `media.uploaded` event commit together (a replay of the same
      // clientKey lands on the unique below and records NO second event)
      row = await this.prisma.$transaction(async (tx) => {
        // a visit file's first statements are a visit act's: the readiness lock, the tree lock and the visit row, and
        // the adder is judged again under them (#792 SV2; the order that keeps a place's removal from interleaving)
        if (visit) await this.siteVisitFiles.lockForFile(tx, projectId, visit.visitId, user.sub);
        // ... and a copy's original is asked again under them (a visit's file is never taken off it, nor deleted)
        if (visit && source) await this.markupSource(tx, projectId, visit.visitId, source.id);
        // first statement otherwise: the place's publication under the tree lock's shared side (a refusal here
        // rolls back and goes through the earned object cleanup below)
        await resolvePublishedProjectNode(tx, projectId, nodeId);
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
            geoLat: source ? source.geoLat : input.geoLat,
            geoLng: source ? source.geoLng : input.geoLng,
            takenAt: source ? source.takenAt : input.takenAt,
            sourceMediaId: source?.id ?? null,
            durationSec: input.durationSec ?? null,
            decisionId,
            dailyLogId,
            nodeId,
            inspectionId: input.inspectionId ?? null,
            inspectionItemId: input.inspectionItemId ?? null,
            clientKey: input.clientKey ?? null,
          },
        });
        // the visit link, before the upload's event: the adder's standing, then the row (site-visits writes it)
        if (visit) await this.siteVisitFiles.attach(tx, { ...visit, projectId, mediaId: created.id, userId: user.sub, actor });
        const uploadedEv = await emitEvent(tx, { projectId, actor, eventType: 'media.uploaded', entityType: 'Media', entityId: created.id, payload: { kind: input.kind }, effectKey: 'media.uploaded', dispatch: {} });
        const evs: EmittedEventMeta[] = [uploadedEv];
        // Task 10 (Module 3) correction — ITEM-LEVEL evidence (both ids present) links through the
        // inspections participant, which writes the inspection-owned InspectionEvidence row AND appends
        // `inspection.evidence_added`, so the inspections.inbox projection observes the new evidence.
        if (input.inspectionId && input.inspectionItemId) {
          // #571 round 9, finding 1 — containment is not authority. `assertEvidenceTarget` above
          // proves the item belongs to the inspection and the inspection to this project; it says
          // nothing about whether this actor may change THIS inspection's evidence. Asked here,
          // inside the transaction that writes the link, so the answer cannot be overtaken.
          const { observedAssigneeId } = await this.inspectionParticipant.assertEvidenceMutable(tx, { projectId, inspectionId: input.inspectionId, actorUserId: user.sub });
          // the value the authorisation saw travels WITH the write it authorised (#571 round 11, F1)
          evs.push(await this.inspectionParticipant.addEvidence(tx, { projectId, actor, inspectionId: input.inspectionId, inspectionItemId: input.inspectionItemId, mediaId: created.id, observedAssigneeId }));
        }
        events = evs;
        return created;
      });
    } catch (e) {
      // a concurrent replay of the same clientKey landed first — return ITS row
      // (the unique is the DB proof the photo persisted exactly once). The winner's row points at
      // the WINNER's object: every request stores under its own random key, so this request's
      // object is unreferenced either way and goes through the earned cleanup below (#482).
      if (input.clientKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await this.prisma.media.findUniqueOrThrow({
          where: { projectId_clientKey: { projectId, clientKey: input.clientKey } },
          select: REPLAY_SELECT,
        });
        let replay: UploadedMedia | undefined;
        try {
          replay = await this.replayed(projectId, user, winner);
        } catch (refused) {
          // the key is another member's, or its photo is hidden from the caller: refused, after the same cleanup
          e = refused;
        }
        await this.removeIfUnreferenced(projectId, key);
        if (replay) return replay;
        throw e;
      }
      // THE ROLLBACK DOES NOT REACH THE BUCKET (#571 round 11, finding 3). The preflight above is
      // deliberately advisory, so the authoritative in-transaction check is the one that can refuse
      // a request whose bytes are already stored: an inactive assignee reactivated between the two
      // is exactly that interleaving, and it left one unreferenced object per refusal.
      //
      // BUT A REJECTED `$transaction` DOES NOT PROVE A ROLLBACK (#571 round 12, finding 2). Round 11
      // wrote that every failure here means "the transaction rolled back and NOTHING references this
      // key", and named a lost connection as one of them. A connection lost AFTER PostgreSQL commits
      // rejects the client promise over rows that are durable — so the unconditional cleanup that
      // sentence justified would delete the object those committed rows reference and destroy the
      // evidence permanently. The claim was the failure mode: an assumption about the database's
      // state, asserted from the client's error rather than checked against the database.
      //
      // So the cleanup is EARNED, not assumed. The object is removed only once a fresh read proves
      // no row references its key. A read that itself fails leaves the object alone — an orphan to
      // sweep is a cost; a deleted photo behind a committed row is not recoverable, and where the two
      // are not distinguishable the harmless one is the only admissible guess.
      await this.removeIfUnreferenced(projectId, key);
      throw e;
    }

    // a fresh upload signals its project once; a replay (P2002 return above) never reaches here
    if (events.length) await this.dispatcher.dispatchCommitted(events);
    // a short-lived, signed path resolved against the API base by the frontend
    return { id: row.id, url: this.signed.mediaPath(row.id), at: row.createdAt.toISOString() };
  }

  /** The earned cleanup (#571 round 12): remove this request's stored object only once a fresh read
   *  proves no row references its key. A read that fails leaves the object alone. */
  private async removeIfUnreferenced(projectId: string, key: string | null | undefined): Promise<void> {
    if (!key) return;
    const persisted = await this.prisma.media
      .findFirst({ where: { projectId, storageKey: key }, select: { id: true } })
      .catch(() => ({ id: 'unknown' }) as { id: string });
    if (!persisted) await this.storage.remove(key).catch(() => {});
  }

  /** Re-file a photo onto a location-tree node (or null to unfile). Scoped to the
   *  caller's project. Returns the fresh snapshot so the client reconciles. Location spine. */
  async setNode(id: string, projectId: string, nodeId: string | null, user: AuthUser): Promise<SnapshotDto> {
    const row = await this.prisma.media.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) throw new NotFoundException('Media not found');
    const actor = await resolveActor(this.prisma, user);
    const ev = await this.prisma.$transaction(async (tx) => {
      // a photo on someone else's private draft (filed before #881) is answered as if it did not exist:
      // its current place is decided under the tree lock's shared side, inside this transaction
      const current = await tx.media.findUnique({ where: { id }, select: { nodeId: true } });
      if (!current || (await isPlaceHiddenFrom(tx, projectId, current.nodeId, user.sub))) {
        throw new NotFoundException('Media not found');
      }
      // the target place's publication under the same shared lock
      const resolved = await resolvePublishedProjectNode(tx, projectId, nodeId);
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
    const actor = await resolveActor(this.prisma, user);
    const events = await this.prisma.$transaction(async (tx) => {
      // #482 site photos — a photo filed on a day's log: that log row is held FOR SHARE until this delete commits, so a
      // send (which takes the row FOR UPDATE and then counts the photos filed on it) waits and never counts this one
      if (row.dailyLogId) await this.dailyLog.sentLogs(projectId, [row.dailyLogId], tx, true);
      // Phase 3 Task 4 — the §C stock ledger is immutable, so a photo cited as stock quality
      // evidence can never be unlinked: the inventory participant REFUSES the delete (409)
      // before anything is touched (the ledger's composite FK is the database backstop).
      await this.inventoryParticipant.assertMediaDisposable(tx, projectId, id);
      // Phase 4 Task 3 correction (F2) — the same rule for LABOUR presence evidence: a muster is an
      // append-only observation the Team gate reads, so its selfie/QR capture cannot be deleted
      // while cited (the attendance composite FK is the database backstop).
      await this.labourParticipant.assertMediaDisposable(tx, projectId, id);
      // Phase 4 Task 5 (§I): a photo cited as measured-output evidence is not deletable
      await this.activityParticipant.assertMediaDisposable(tx, projectId, id);
      // Phase 5 Task 3 (§D): nor one cited as MEASUREMENT evidence — a measurement is immutable
      // and becomes a payable quantity, so this is the strictest case of the same rule.
      await this.commercialParticipant.assertMediaDisposable(tx, projectId, id);
      // #792 SV2: nor one added on a site visit — it is part of the visit's record, which keeps it
      await this.siteVisitFiles.assertMediaDisposable(tx, projectId, id);
      // #571 round 9, finding 1 — and the same rule for ASSIGNED inspection evidence: while an
      // assignment binds, only its assignee may destroy the photos that stand behind that work.
      // This is the sharpest case of the whole assignment rule, because a delete does not come back.
      const observedEvidence = await this.inspectionParticipant.assertEvidenceDisposable(tx, { projectId, mediaId: id, actorUserId: user.sub });
      // Task 10 (Module 3) correction — unlink any inspection-owned evidence FIRST (participant appends
      // `inspection.evidence_removed` when a link existed), THEN delete the media row, so the projection
      // observes the removal. `null` when this media was not item-level evidence.
      const evidenceEv = await this.inspectionParticipant.removeEvidence(tx, { projectId, actor, mediaId: id, observed: observedEvidence });
      await tx.media.delete({ where: { id } });
      const removedEv = await emitEvent(tx, { projectId, actor, eventType: 'media.removed', entityType: 'Media', entityId: id, effectKey: 'media.removed', dispatch: {} });
      return evidenceEv ? [evidenceEv, removedEv] : [removedEv];
    });
    // Task-3 correction 2 (finding 2) — the bucket object is removed LAST, and only on the success
    // path. It used to go first, so a participant refusal above (labour presence evidence, inventory
    // ledger evidence) left the row intact with its bytes already gone: an append-only fact still
    // citing evidence that no longer existed. Now a rejected delete touches neither the row nor the
    // object, and by the time we get here the database no longer references the object at all, so
    // failing to clean it up is a harmless orphan — never a reason to fail a committed delete.
    if (row.storageKey) await this.storage.remove(row.storageKey).catch(() => {});
    await this.dispatcher.dispatchCommitted(events);
    return true;
  }
}
