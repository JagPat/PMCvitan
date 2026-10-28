import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { InspectionParticipant } from '../inspections/inspection.participant';
import { InventoryParticipant } from '../inventory/inventory.participant';
import { LabourRequirementParticipant } from '../labour/labour.participant';
import { ActivityParticipant } from '../activities/activity.participant';
import { CommercialParticipant } from '../commercial/commercial.participant';
import { SiteVisitFilesParticipant } from '../site-visits/site-visit-files.participant';

/**
 * May this photo be deleted, as far as the records that cite it go? Each module that keeps a photo as evidence answers
 * for itself (stock ledger, labour muster, measured output, measurement, site visit, assigned inspection), so one list of
 * those questions serves both the delete and the snapshot that offers it (#482 site photos, Codex 4320129763, 4320515415,
 * 4320515416). Every column that holds a media id is covered: StockTransaction, LabourAttendance, ActivityWorkOutput,
 * GateOverride, Measurement, SiteVisitMedia and InspectionEvidence. (Media.sourceMediaId needs no check of its own: a
 * marked-up copy's original is always a site-visit file, which the site-visits answer already keeps.)
 */
/** The roles that keep the site record: they delete any photo, at any age, and add every kind of media. */
export const SITE_RECORD_ROLES: ReadonlySet<string> = new Set(['pmc', 'engineer']);

@Injectable()
export class MediaDisposability {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inspectionParticipant: InspectionParticipant,
    private readonly inventoryParticipant: InventoryParticipant,
    private readonly labourParticipant: LabourRequirementParticipant,
    private readonly activityParticipant: ActivityParticipant,
    private readonly commercialParticipant: CommercialParticipant,
    private readonly siteVisitFiles: SiteVisitFilesParticipant,
  ) {}

  /**
   * Throws when a record still rests on the photo; otherwise returns the inspections it is evidence for, as observed,
   * for the delete to fence its unlink against. Asked inside the delete's own transaction, one photo at a time.
   */
  async assertDisposable(
    tx: Prisma.TransactionClient,
    params: { projectId: string; mediaId: string; actorUserId: string; ownSitePhoto?: boolean },
  ): Promise<Array<{ inspectionId: string; observedAssigneeId: string | null }>> {
    const { projectId, mediaId: id, actorUserId, ownSitePhoto = false } = params;
    // #482 site photos — a member deletes only their own plain site photo, and one linked as inspection evidence is not
    // plain, whether or not its inspection has an assignee (Codex 4321452704)
    if (ownSitePhoto && (await this.inspectionParticipant.linkedEvidence(tx, projectId, [id])).size > 0) {
      throw new ConflictException('This photo is evidence on an inspection and cannot be deleted');
    }
    // Phase 3 Task 4 — the §C stock ledger is immutable, so a photo cited as stock quality
    // evidence can never be unlinked: the inventory participant REFUSES the delete (409)
    // before anything is touched (the ledger's composite FK is the database backstop).
    await this.inventoryParticipant.assertMediaDisposable(tx, projectId, id);
    // Phase 4 Task 3 correction (F2) — the same rule for LABOUR presence evidence: a muster is an
    // append-only observation the Team gate reads, so its selfie/QR capture cannot be deleted
    // while cited (the attendance composite FK is the database backstop).
    await this.labourParticipant.assertMediaDisposable(tx, projectId, id);
    // Phase 4 Task 5 (§I): a photo cited as measured-output evidence is not deletable, nor one a gate override cites
    await this.activityParticipant.assertMediaDisposable(tx, projectId, id);
    // Phase 5 Task 3 (§D): nor one cited as MEASUREMENT evidence — a measurement is immutable
    // and becomes a payable quantity, so this is the strictest case of the same rule.
    await this.commercialParticipant.assertMediaDisposable(tx, projectId, id);
    // #792 SV2: nor one added on a site visit — it is part of the visit's record, which keeps it
    await this.siteVisitFiles.assertMediaDisposable(tx, projectId, id);
    // #571 round 9, finding 1 — and the same rule for ASSIGNED inspection evidence: while an
    // assignment binds, only its assignee may destroy the photos that stand behind that work.
    // This is the sharpest case of the whole assignment rule, because a delete does not come back.
    return this.inspectionParticipant.assertEvidenceDisposable(tx, { projectId, mediaId: id, actorUserId });
  }

  /** #482 site photos — which of these photos the delete would let `actorUserId` remove now, record-wise, so the snapshot
   *  offers a delete only where the server would take it. One batched read per owning module for the whole window, never
   *  one per photo (Codex 4320515415); read without locks — the delete asks again and is the authority. */
  async disposable(projectId: string, ids: string[], actorUserId: string, ownSitePhotos = false): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const db = this.prisma as unknown as Prisma.TransactionClient;
    const pinned = await Promise.all([
      this.inventoryParticipant.pinnedMedia(db, projectId, ids),
      this.labourParticipant.pinnedMedia(db, projectId, ids),
      this.activityParticipant.pinnedMedia(db, projectId, ids),
      this.commercialParticipant.pinnedMedia(db, projectId, ids),
      this.siteVisitFiles.pinnedMedia(db, projectId, ids),
      // a member's own site photos: any inspection link pins them, as on delete; staff: the assignment rule
      ownSitePhotos
        ? this.inspectionParticipant.linkedEvidence(db, projectId, ids)
        : this.inspectionParticipant.pinnedEvidence(db, { projectId, mediaIds: ids, actorUserId }),
    ]);
    return new Set(ids.filter((id) => !pinned.some((set) => set.has(id))));
  }

  /** #1179 — which of these site-visit files another record still cites, so that a removal from the visit (which asks
   *  {@link assertDisposable} as staff, past the visit's own link) would refuse them: the visit's offer leaves them out
   *  (Codex 4397416732). Batched and read without locks, as {@link disposable}; the removal asks again. */
  async citedElsewhere(projectId: string, ids: string[], actorUserId: string): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const db = this.prisma as unknown as Prisma.TransactionClient;
    const pinned = await Promise.all([
      this.inventoryParticipant.pinnedMedia(db, projectId, ids),
      this.labourParticipant.pinnedMedia(db, projectId, ids),
      this.activityParticipant.pinnedMedia(db, projectId, ids),
      this.commercialParticipant.pinnedMedia(db, projectId, ids),
      this.inspectionParticipant.pinnedEvidence(db, { projectId, mediaIds: ids, actorUserId }),
    ]);
    return new Set(ids.filter((id) => pinned.some((set) => set.has(id))));
  }
}
