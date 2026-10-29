import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { lockStandingAnchors } from '../common/standing-anchor';
import { lockProjectReadiness } from '../common/readiness-lock';
import { lockActorStanding, resolveActorEnvelope } from '../platform/actor-envelope';
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
import { MediaDisposability, SITE_RECORD_ROLES } from './media-disposability';
import { isPlaceHiddenFrom, previewPublishedProjectNode, resolvePublishedProjectNode } from '../nodes/node-scope';
import { resolveProjectRef } from '../common/project-ref';
import type { AuthUser } from '../common/auth';
import type { SnapshotDto } from '../snapshot/types';
import { VIDEO_CLIP_MAX_SEC, VOICE_NOTE_MAX_SEC, VOICE_NOTE_SEC_TOLERANCE, type AddPosterInput, type CreateMediaInput } from '../contracts';
import { MEDIA_NOT_FOUND_MESSAGE, NOT_A_VISIT_FILE_MESSAGE, SITE_PHOTO_DELETE_WINDOW_MS, SITE_PHOTO_DELETED_MESSAGE } from '@vitan/shared';
import { resolveActor } from '../common/actor';
import { emitEvent } from '../platform/events';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import { readVoiceRecording } from './voice-container';
import { readVideoClip } from './video-container';
import { readJpegStill } from './jpeg-still';

export interface UploadedMedia {
  id: string;
  url: string;
  /** #482 site photos — when the server recorded it (ISO), so a device shows the time the snapshot will */
  at: string;
}

/** The roles that keep the record-linked uploads: evidence for a decision or an inspection item, or a non-progress kind. */

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

/** What a clientKey replay must read to decide whether the caller may have the stored row back. */
const REPLAY_SELECT = { id: true, createdAt: true, kind: true, uploadedBy: true, decisionId: true, dailyLogId: true, inspectionId: true, inspectionItemId: true, nodeId: true } as const;
type ReplayRow = { id: string; createdAt: Date; kind: string; uploadedBy: string; decisionId: string | null; dailyLogId: string | null; inspectionId: string | null; inspectionItemId: string | null; nodeId: string | null };

/** #482 site photos — one send key at a time: the upload that may store a photo under it, and the delete that retires
 *  it. Always the FIRST statement of its transaction, so no transaction holds another lock while it waits for this one,
 *  and no cycle can pass through it. */
async function lockSendKey(tx: Prisma.TransactionClient, projectId: string, clientKey: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`media-send-key:${projectId}:${clientKey}`}, 0))`);
}

/** #482 site photos — a key whose photo was deleted is never used again: a late copy of its send stores nothing. The
 *  web matches this exact text (shared), so it is never changed here alone. */
const DELETED_PHOTO = SITE_PHOTO_DELETED_MESSAGE;

/** #482 site photos — the database's own refusal of a deleted photo's key (`Media_tombstone_guard`, 20280118, SQLSTATE
 *  MT410). Prisma reports a trigger's error on a model write as an unknown request error carrying the code in its
 *  text, and on a raw statement as P2010 with the code in `meta`. */
function isDeletedKeyRefusal(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) return (e.meta as { code?: unknown } | undefined)?.code === 'MT410';
  if (e instanceof Prisma.PrismaClientUnknownRequestError) return /\bcode: "MT410"/.test(e.message);
  return false;
}

/** The P2002 is the (projectId, clientKey) unique's, whichever way Prisma names it. */
function isSendKeyConflict(e: Prisma.PrismaClientKnownRequestError): boolean {
  const target = (e.meta as { target?: unknown } | undefined)?.target;
  if (Array.isArray(target)) return target.length === 2 && target.includes('projectId') && target.includes('clientKey');
  return target === 'Media_projectId_clientKey_key';
}

/** #995 V1b — what a still frame's request must read of its clip, early and again under the clip's row lock. */
type PosterTarget = { projectId: string; kind: string; mime: string; uploadedBy: string; posterStorageKey: string | null };

/** #995 V1b — a still frame goes only on a video clip on a site visit, and only from the member who recorded it: a clip
 *  in another project is answered as if it did not exist. */
function assertMayAddPoster(row: PosterTarget | null | undefined, projectId: string, user: AuthUser): asserts row is PosterTarget {
  if (!row || row.projectId !== projectId) throw new NotFoundException(MEDIA_NOT_FOUND_MESSAGE);
  if (row.uploadedBy !== user.sub) throw new ForbiddenException('Only the person who recorded this video may add its still frame');
  if (row.kind !== 'visit' || !row.mime.startsWith('video/')) throw new BadRequestException('A still frame is added only to a video on a site visit');
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
  ) {
    this.disposability = new MediaDisposability(prisma, inspectionParticipant, inventoryParticipant, labourParticipant, activityParticipant, commercialParticipant, siteVisitFiles);
  }

  /** What may be deleted as far as the records citing a photo go — the guards the snapshot asks as well (Codex 4320129763). */
  private readonly disposability: MediaDisposability;

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
    }
    // #995 — so is a video clip, on the same terms
    if (input.mime.startsWith('video/')) {
      if (!isSiteVisitFile(input) || input.sourceMediaId !== undefined) {
        throw new BadRequestException('A video is added on a site visit');
      }
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
      // #482 — its photo was deleted: an early no, before any bytes are stored (asked again under the key's lock below)
      const deleted = await this.prisma.mediaTombstone.findUnique({ where: { projectId_clientKey: { projectId, clientKey: input.clientKey } } });
      if (deleted) throw new GoneException(DELETED_PHOTO);
    }
    // Location spine: the place must be this project's and PUBLISHED (a team photo never goes on a draft).
    // Checked here BEFORE the bytes are stored, as an early no; the tree's state is decided again under its
    // lock inside the transaction below, which is the authority.
    const nodeId = await previewPublishedProjectNode(this.prisma, projectId, input.nodeId);
    // A visit file: the visit is this project's, not closed, and the caller is on it (an early no, as above)
    const visit = input.siteVisit;
    if (visit) await this.siteVisitFiles.assertMayAdd(projectId, visit.visitId, user.sub);
    // a voice note is read only once its adder may add to the visit (Codex P1 on #1013 round 3): the type is the
    // client's word, so the file is served only as what it is, an audio-only recording (Codex P2 on #1010), and its
    // length is the file's own, for the two-minute cap and the play bar, never the request's (Codex P2 on #1013 round 3)
    let durationSec: number | null = null;
    if (input.mime.startsWith('audio/')) {
      const recording = readVoiceRecording(input.mime, Buffer.from(input.data, 'base64'));
      if (!recording) throw new BadRequestException('This file is not the voice recording its type says');
      // the rules apply to the length as stored, the file's rounded to the nearest second (#1013 replacement review):
      // under half a second the reader refuses, and 120.5 s or more would be stored past two minutes, so is refused
      durationSec = recording.durationSec;
      if (durationSec > VOICE_NOTE_MAX_SEC) throw new BadRequestException('A voice note is at most two minutes long');
      if (input.durationSec !== undefined && Math.abs(input.durationSec - recording.seconds) > VOICE_NOTE_SEC_TOLERANCE) {
        throw new BadRequestException('This voice note is not as long as its upload says');
      }
    }
    // #995 — a video clip is read on the same terms, once its adder may add to the visit: a video with a picture in it
    // in the container its type names, its length the file's own, rounded, at most a minute
    if (input.mime.startsWith('video/')) {
      const clip = readVideoClip(input.mime, Buffer.from(input.data, 'base64'));
      if (!clip) throw new BadRequestException('This file is not the video its type says');
      durationSec = clip.durationSec;
      if (durationSec > VIDEO_CLIP_MAX_SEC) throw new BadRequestException('A video is at most a minute long');
      if (input.durationSec !== undefined && Math.abs(input.durationSec - clip.seconds) > VOICE_NOTE_SEC_TOLERANCE) {
        throw new BadRequestException('This video is not as long as its upload says');
      }
    }
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
        // #482 — the send key's lock comes first, and a key whose photo was deleted meanwhile stores nothing. A refusal
        // here rolls back and goes through the earned object cleanup below. No visit act takes this lock, so the visit
        // order that follows is unchanged.
        if (input.clientKey) {
          await lockSendKey(tx, projectId, input.clientKey);
          if (await tx.mediaTombstone.findUnique({ where: { projectId_clientKey: { projectId, clientKey: input.clientKey } } })) {
            throw new GoneException(DELETED_PHOTO);
          }
        }
        // a visit file's first statements are a visit act's: the readiness lock, the tree lock and the visit row, and
        // the adder is judged again under them (#792 SV2; the order that keeps a place's removal from interleaving)
        if (visit) await this.siteVisitFiles.lockForFile(tx, projectId, visit.visitId, user.sub);
        // ... and a copy's original is asked again under them (a visit's file is never taken off it, nor deleted)
        if (visit && source) await this.markupSource(tx, projectId, visit.visitId, source.id);
        // first statement otherwise: the place's publication under the tree lock's shared side (a refusal here
        // rolls back and goes through the earned object cleanup below)
        await resolvePublishedProjectNode(tx, projectId, nodeId);
        // #1061 — the uploader's standing anchor after the keys and before the insert: outside a visit this takes no
        // project key, and the insert key-share locks a linked decision, which a forward holding this person's
        // anchor exclusive waits on; taking the anchor only at the emit would close the cycle
        await lockStandingAnchors(tx, { read: [user.sub] });
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
            durationSec,
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
      if (input.clientKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && isSendKeyConflict(e)) {
        const winner = await this.prisma.media.findUnique({
          where: { projectId_clientKey: { projectId, clientKey: input.clientKey } },
          select: REPLAY_SELECT,
        });
        let replay: UploadedMedia | undefined;
        try {
          if (winner) replay = await this.replayed(projectId, user, winner);
          // #482 — no winner any more: "deleted" only on the database's word, its record of the key (written in the
          // delete's own statement); without it the original error stands, unexplained
          else if (await this.prisma.mediaTombstone.findUnique({ where: { projectId_clientKey: { projectId, clientKey: input.clientKey } } })) {
            throw new GoneException(DELETED_PHOTO);
          }
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
      // #482 — the database refused the key (its photo was deleted while this send waited, by a release that takes no
      // key lock): the same answer as the record read above, after the same cleanup
      if (isDeletedKeyRefusal(e)) throw new GoneException(DELETED_PHOTO);
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
   * #995 V1b — give a video clip its still frame: a JPEG the recording phone draws from the clip. The first one stays:
   * a replay, or any later frame, is answered with the stored one's link and stores nothing new, so the request is
   * idempotent by the clip's identity alone. The clip is complete without one.
   *
   * Authority before bytes, as for an upload: the caller and the clip are asked first, outside any transaction (a cheap
   * early no), then the bytes are read whole and stored, and then the clip's row is locked and every question asked
   * again, with the adder's standing and the project's state, under a visit file act's locks; that answer decides. An
   * object that no row took, or whose PUT failed, is removed, but only once a fresh read proves no row references it.
   *
   * No event: a new event type is a new external-effect catalog generation, which is a migration of its own. A still
   * frame adds no file to its visit, and other viewers see it on their next read of the visit's files.
   */
  async addPoster(projectId: string, mediaId: string, user: AuthUser, input: AddPosterInput): Promise<{ id: string; posterUrl: string }> {
    // minted at each return, after the PUT and the lock wait, so its link outlives the request (Codex P2 on #1166)
    const answer = () => ({ id: mediaId, posterUrl: this.signed.posterPath(mediaId) });
    const select = { projectId: true, kind: true, mime: true, uploadedBy: true, posterStorageKey: true } as const;
    const early = await this.prisma.media.findUnique({ where: { id: mediaId }, select });
    assertMayAddPoster(early, projectId, user);
    const bytes = Buffer.from(input.data, 'base64');
    if (!readJpegStill(bytes)) throw new BadRequestException('This file is not a still frame the app can show');
    // a replay after a lost reply, or a later frame: the stored one stands, and nothing is stored
    if (early.posterStorageKey !== null) return answer();
    // the dev stub keeps a file's bytes in its row, and a clip's row has room for one file only
    if (!this.storage.configured) throw new ConflictException('This server has no file storage for a still frame');
    const key = this.storage.keyFor(projectId, 'visit', 'image/jpeg');
    const actor = await resolveActor(this.prisma, user);
    let stored: string;
    try {
      // inside the cleanup: a PUT whose reply was lost may still have stored the object
      await this.storage.put(key, bytes, 'image/jpeg');
      stored = await this.prisma.$transaction(async (tx) => {
        // a visit file act's order (Codex P1 on #1166): the project's readiness key first, so a removal or an archive
        // is wholly before or after this; then the clip's row; then the adder's standing, as a visit file's link takes it
        await lockProjectReadiness(tx, projectId);
        const [row] = await tx.$queryRaw<PosterTarget[]>(Prisma.sql`
          SELECT "projectId", kind, mime, "uploadedBy", "posterStorageKey" FROM "Media" WHERE id = ${mediaId} FOR NO KEY UPDATE`);
        assertMayAddPoster(row, projectId, user);
        await lockActorStanding(tx, projectId, user.sub);
        const [state] = await tx.$queryRaw<Array<{ operable: boolean }>>(Prisma.sql`SELECT phase6_project_operable(${projectId}) AS "operable"`);
        if (state?.operable !== true) throw new ForbiddenException('Project is unavailable');
        if (!(await resolveActorEnvelope(tx, projectId, actor))) throw new ForbiddenException('Your role on this project has changed; sign in again');
        if (row.posterStorageKey !== null) return row.posterStorageKey;
        await tx.media.update({ where: { id: mediaId }, data: { posterStorageKey: key } });
        return key;
      });
    } catch (e) {
      await this.removePosterIfUnreferenced(projectId, key);
      throw e;
    }
    if (stored !== key) await this.removePosterIfUnreferenced(projectId, key);
    return answer();
  }

  /** {@link removeIfUnreferenced} for a still frame's object: removed only once a fresh read proves no clip names it. */
  private async removePosterIfUnreferenced(projectId: string, key: string): Promise<void> {
    const persisted = await this.prisma.media
      .findFirst({ where: { projectId, posterStorageKey: key }, select: { id: true } })
      .catch(() => ({ id: 'unknown' }) as { id: string });
    if (!persisted) await this.storage.remove(key).catch(() => {});
  }

  /** #995 V1b — a clip's still frame for its serve endpoint (which has verified the frame's own token): a presigned
   *  private-bucket GET, or null when the clip has none. */
  async fetchPoster(id: string): Promise<MediaRedirect | null> {
    const row = await this.prisma.media.findUnique({ where: { id }, select: { posterStorageKey: true } });
    if (!row?.posterStorageKey) return null;
    const signed = await this.storage.presignGet(row.posterStorageKey);
    return signed ? { redirect: signed } : null;
  }

  /**
   * #1179 (Jagrut, 27 Oct 2026) — take a voice note, video or photo off its site visit and delete it: the person who
   * added it within the hour while the visit is open, or the PMC at any time with a reason (the site-visits module's
   * rule, `recordRemoval`). The visit keeps a line saying who removed what, when and why; the file's row, its stored
   * object, a clip's still frame and anything that goes with the row by key (a transcript) go. A file that is not on a
   * visit, or not this project's, is not found.
   *
   * Lock order, an upload's: the file's send key, then the visit act's locks (readiness, tree, visit), then the file's
   * row FOR UPDATE, which `addPoster` takes FOR NO KEY UPDATE after the same readiness key. The still frame's key is
   * read under that lock (#1166's "latent orphan"), so a frame a racing `addPoster` stored is either named here and
   * removed after commit, or written after this commit and refused, its object cleaned by `addPoster` itself.
   */
  async removeFromVisit(projectId: string, mediaId: string, user: AuthUser, reason: string | null): Promise<void> {
    if (user.projectId !== projectId) throw new NotFoundException(MEDIA_NOT_FOUND_MESSAGE);
    const early = await this.prisma.media.findUnique({ where: { id: mediaId }, select: { projectId: true, clientKey: true } });
    if (!early || early.projectId !== projectId) throw new NotFoundException(MEDIA_NOT_FOUND_MESSAGE);
    const visitId = await this.siteVisitFiles.visitOf(this.prisma, projectId, mediaId);
    if (!visitId) throw new NotFoundException(NOT_A_VISIT_FILE_MESSAGE);
    const actor = await resolveActor(this.prisma, user);
    const { keys, events } = await this.prisma.$transaction(async (tx) => {
      if (early.clientKey) await lockSendKey(tx, projectId, early.clientKey);
      await this.siteVisitFiles.lockForRemoval(tx, projectId, visitId);
      const [row] = await tx.$queryRaw<Array<{ storageKey: string | null; posterStorageKey: string | null }>>(Prisma.sql`
        SELECT "storageKey", "posterStorageKey" FROM "Media" WHERE "projectId" = ${projectId} AND "id" = ${mediaId} FOR UPDATE`);
      if (!row) throw new NotFoundException(MEDIA_NOT_FOUND_MESSAGE);
      await this.siteVisitFiles.recordRemoval(tx, { projectId, mediaId, userId: user.sub, actor, reason });
      // every other record that keeps this file as evidence still refuses, as for any photo
      const observed = await this.disposability.assertDisposable(tx, { projectId, mediaId, actorUserId: user.sub });
      const evidenceEv = await this.inspectionParticipant.removeEvidence(tx, { projectId, actor, mediaId, observed });
      try {
        await tx.media.delete({ where: { id: mediaId } });
      } catch (e) {
        // as for a photo: a record that cited this file after the guards above asked holds it by its key
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
          throw new ConflictException('This file was just cited as evidence on another record, so it cannot be removed');
        }
        throw e;
      }
      const removedEv = await emitEvent(tx, { projectId, actor, eventType: 'media.removed', entityType: 'Media', entityId: mediaId, effectKey: 'media.removed', dispatch: {} });
      return { keys: [row.storageKey, row.posterStorageKey], events: evidenceEv ? [evidenceEv, removedEv] : [removedEv] };
    });
    // after the commit that removed every reference, and only on success (POLICY: destructive side effects last)
    for (const key of keys) if (key) await this.storage.remove(key).catch(() => {});
    await this.dispatcher.dispatchCommitted(events);
  }

  /**
   * Delete a photo (bucket object + DB row). Scoped to the caller's project so
   * one project can't delete another's media. Returns false when not found /
   * out of scope. Best-effort on the bucket delete (dev stub is a no-op).
   */
  async remove(id: string, user: AuthUser): Promise<boolean> {
    return (await this.removeFiled(id, user)) !== null;
  }

  /** {@link remove}, saying which day's log counted the photo (`dailyLogId`, a progress photo filed on one), or
   *  null when not found / out of scope. A photo another delete removed after this one read it is a 404
   *  (`MEDIA_NOT_FOUND_MESSAGE`) thrown from inside the transaction, so nothing this delete began is kept. */
  async removeFiled(id: string, user: AuthUser): Promise<{ dailyLogId: string | null } | null> {
    const projectId = user.projectId;
    const row = await this.prisma.media.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) return null;
    // #482 (Board, 14 Oct 2026) — every member may delete a plain site photo THEY added, within an hour of the server
    // recording it; any other photo stays the PMC's and the engineer's. Asked before anything is touched.
    if (!SITE_RECORD_ROLES.has(user.role)) {
      const plain = row.kind === 'progress' && !row.decisionId && !row.inspectionId && !row.inspectionItemId;
      if (!plain || row.uploadedBy !== user.sub) throw new ForbiddenException('Only the person who added this site photo may delete it');
      if (Date.now() - row.createdAt.getTime() > SITE_PHOTO_DELETE_WINDOW_MS) {
        throw new ForbiddenException('A site photo can be deleted only within an hour of adding it');
      }
    }
    const ownSitePhoto = !SITE_RECORD_ROLES.has(user.role);
    const actor = await resolveActor(this.prisma, user);
    const events = await this.prisma.$transaction(async (tx) => {
      // #482 site photos — the photo's send key first, before any other lock: a send of the same key waits for this
      // delete, and then finds the record the database writes in the delete's own statement (20280117)
      if (row.clientKey) await lockSendKey(tx, projectId, row.clientKey);
      // #482 site photos — a photo filed on a day's log: that log row is held FOR SHARE until this delete commits, so a
      // send (which takes the row FOR UPDATE and then counts the photos filed on it) waits and never counts this one.
      // A member's own photo on a log already sent is part of that record now, so theirs no longer (Codex 4316959509).
      const sent = row.dailyLogId ? await this.dailyLog.sentLogs(projectId, [row.dailyLogId], tx, true) : new Set<string>();
      if (ownSitePhoto && row.dailyLogId && sent.has(row.dailyLogId)) {
        throw new ForbiddenException('This photo is part of a daily log that was already sent');
      }
      // every record that keeps this photo as evidence (stock ledger, labour muster, measured output, measurement, site
      // visit, assigned inspection) refuses the delete before anything is touched — the same questions the snapshot asks
      const observedEvidence = await this.disposability.assertDisposable(tx, { projectId, mediaId: id, actorUserId: user.sub, ownSitePhoto });
      // Task 10 (Module 3) correction — unlink any inspection-owned evidence FIRST (participant appends
      // `inspection.evidence_removed` when a link existed), THEN delete the media row, so the projection
      // observes the removal. `null` when this media was not item-level evidence.
      const evidenceEv = await this.inspectionParticipant.removeEvidence(tx, { projectId, actor, mediaId: id, observed: observedEvidence });
      try {
        await tx.media.delete({ where: { id } });
      } catch (e) {
        // #482 site photos — a record that cited this photo after the guards above asked (a gate override, a stock
        // row) is held by its key, which is the last word: the delete is refused like any other cited photo, nothing
        // is touched, and the stored file stays (Codex 4320912811)
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
          throw new ConflictException('This photo was just cited as evidence on another record, so it cannot be deleted');
        }
        // another delete of this photo committed after the read above (two taps, two tabs, two people): it is gone, and
        // this delete answers as the route does for a photo it no longer holds. Thrown, not returned, so the rollback
        // undoes the evidence unlink above; the stored files are the first delete's to remove
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          throw new NotFoundException(MEDIA_NOT_FOUND_MESSAGE);
        }
        throw e;
      }
      const removedEv = await emitEvent(tx, { projectId, actor, eventType: 'media.removed', entityType: 'Media', entityId: id, effectKey: 'media.removed', dispatch: {} });
      return evidenceEv ? [evidenceEv, removedEv] : [removedEv];
    });
    // Task-3 correction 2 (finding 2) — the bucket object is removed LAST, and only on the success
    // path. It used to go first, so a participant refusal above (labour presence evidence, inventory
    // ledger evidence) left the row intact with its bytes already gone: an append-only fact still
    // citing evidence that no longer existed. Now a rejected delete touches neither the row nor the
    // object, and by the time we get here the database no longer references the object at all, so
    // failing to clean it up is a harmless orphan — never a reason to fail a committed delete.
    // #995 — a video's still frame goes with it, on the same terms.
    for (const key of [row.storageKey, row.posterStorageKey]) if (key) await this.storage.remove(key).catch(() => {});
    await this.dispatcher.dispatchCommitted(events);
    return { dailyLogId: row.kind === 'progress' ? row.dailyLogId : null };
  }
}
