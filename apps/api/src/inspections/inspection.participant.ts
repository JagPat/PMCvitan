import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { emitEvent } from '../platform/events';
import type { Actor } from '../common/actor';
import type { EmittedEventMeta } from '../platform/outbox/registry';

/**
 * Phase 2 Task 7 / Task 10 (Module 3) correction — the inspection module's transaction-bound WORKFLOW
 * PARTICIPANT.
 *
 * A foreign module (activities, media, nodes, orgs) that mutates an INSPECTION-OWNED fact the
 * `inspections.inbox` projection serializes must route that write THROUGH this participant, on the
 * foreign command's own transaction. The participant does two things atomically: it mutates the
 * inspection-owned rows, AND it appends an inspection-owned domain event (`inspection.*`). Because the
 * projection consumer dispatches on `inspection.*`, that appended event is what lets the ordered cursor
 * REFRESH the projection row from canonical state — the correction's core invariant. The events are
 * signal-only (they deduplicate with the foreign command's own socket invalidation; the foreign command
 * owns any push). A leaf provider (no injected dependencies) — `emitEvent` is a pure platform function, so
 * this creates no DI cycle with the services that call it.
 */
@Injectable()
export class InspectionParticipant {
  /**
   * Create the closing inspection for a completion claim (edge 1) and append `inspection.closing_created`
   * in the SAME transaction, so the projection observes the new review. ONE default sign-off item makes
   * rejection possible. The INSPECTION-OWNED `activityName` is stamped here (no live Activity read in the
   * serializer). Returns the event meta so the activities command dispatches it after commit.
   */
  async createClosingInspection(
    tx: Prisma.TransactionClient,
    params: {
      closingId: string;
      projectId: string;
      activity: { id: string; name: string; zone: string; nodeId: string | null };
      actor: Actor;
      inspectionDate: Date | null;
      dateLabel: string;
    },
  ): Promise<EmittedEventMeta> {
    const { closingId, projectId, activity, actor, inspectionDate, dateLabel } = params;
    await tx.inspection.create({
      data: {
        id: closingId,
        projectId,
        kind: 'review',
        closing: true,
        activityId: activity.id,
        activityName: activity.name, // inspection-owned label (was a live Activity read in the serializer)
        title: `Closing inspection: ${activity.name}`,
        zone: activity.zone,
        nodeId: activity.nodeId,
        date: dateLabel,
        inspectionDate,
        submitted: true,
        decided: false,
        by: actor.actorName,
        submittedById: actor.actorId,
        submittedByName: actor.actorName,
        items: { create: [{ name: 'Work complete and acceptable', order: 0, photos: 0, note: '' }] },
      },
    });
    return emitEvent(tx, { projectId, actor, eventType: 'inspection.closing_created', entityType: 'Inspection', entityId: closingId, payload: { activityId: activity.id }, effectKey: 'inspection.closing_created', dispatch: {} });
  }

  /**
   * Re-stamp the inspection-owned `activityName` on every inspection linked to a renamed activity, and
   * append `inspection.relabeled` when any row changed — so the projection's `activityName` tracks the
   * rename exactly as the pre-correction live read did (which read `Activity.name`). Returns the event
   * meta, or `null` when no linked inspection needed relabeling (no event, nothing to dispatch).
   */
  async relabelForActivity(
    tx: Prisma.TransactionClient,
    params: { projectId: string; actor: Actor; activityId: string; name: string },
  ): Promise<EmittedEventMeta | null> {
    const { projectId, actor, activityId, name } = params;
    const { count } = await tx.inspection.updateMany({
      where: { projectId, activityId, activityName: { not: name } },
      data: { activityName: name },
    });
    if (count === 0) return null;
    return emitEvent(tx, { projectId, actor, eventType: 'inspection.relabeled', entityType: 'Activity', entityId: activityId, payload: { activityName: name, relabeled: count }, effectKey: 'inspection.relabeled', dispatch: {} });
  }

  /**
   * Link an uploaded media as an inspection item's evidence (inspection-owned row) and append
   * `inspection.evidence_added` — invoked on the media-create transaction. Idempotent on the
   * (item, media) unique. Returns the event meta so media-create dispatches it after commit.
   */
  async addEvidence(
    tx: Prisma.TransactionClient,
    params: { projectId: string; actor: Actor; inspectionId: string; inspectionItemId: string; mediaId: string },
  ): Promise<EmittedEventMeta> {
    const { projectId, actor, inspectionId, inspectionItemId, mediaId } = params;
    await tx.inspectionEvidence.upsert({
      where: { inspectionItemId_mediaId: { inspectionItemId, mediaId } },
      create: { projectId, inspectionId, inspectionItemId, mediaId },
      update: {},
    });
    return emitEvent(tx, { projectId, actor, eventType: 'inspection.evidence_added', entityType: 'Inspection', entityId: inspectionId, payload: { inspectionItemId, mediaId }, effectKey: 'inspection.evidence_added', dispatch: {} });
  }

  /**
   * Unlink a deleted media from any inspection item's evidence and append `inspection.evidence_removed`
   * when a link existed — invoked on the media-remove transaction BEFORE the media row is deleted. Returns
   * the event meta, or `null` when the media was not item-level evidence (no event).
   */
  async removeEvidence(
    tx: Prisma.TransactionClient,
    params: { projectId: string; actor: Actor; mediaId: string },
  ): Promise<EmittedEventMeta | null> {
    const { projectId, actor, mediaId } = params;
    const links = await tx.inspectionEvidence.findMany({ where: { projectId, mediaId }, select: { inspectionId: true } });
    if (links.length === 0) return null;
    await tx.inspectionEvidence.deleteMany({ where: { projectId, mediaId } });
    return emitEvent(tx, { projectId, actor, eventType: 'inspection.evidence_removed', entityType: 'Inspection', entityId: links[0].inspectionId, payload: { mediaId, unlinked: links.length }, effectKey: 'inspection.evidence_removed', dispatch: {} });
  }

  /**
   * Clear the location of every inspection placed on a node being deleted (unfile) and append
   * `inspection.unfiled` when any row changed — invoked on the node-remove transaction BEFORE the node is
   * deleted, so the projection observes the location change (the FK stays as a database backstop). Returns
   * the event meta, or `null` when no placed inspection was affected.
   */
  async unfileForDeletedNodes(
    tx: Prisma.TransactionClient,
    params: { projectId: string; actor: Actor; nodeIds: readonly string[] },
  ): Promise<EmittedEventMeta | null> {
    const { projectId, actor, nodeIds } = params;
    if (nodeIds.length === 0) return null;
    const { count } = await tx.inspection.updateMany({
      where: { projectId, nodeId: { in: [...nodeIds] } },
      data: { nodeId: null },
    });
    if (count === 0) return null;
    return emitEvent(tx, { projectId, actor, eventType: 'inspection.unfiled', entityType: 'ProjectNode', entityId: nodeIds[0], payload: { unfiled: count }, effectKey: 'inspection.unfiled', dispatch: {} });
  }

  /**
   * Project-initialization participant (edge 8): create one Inspection (and its items) while instantiating
   * a new project's starting structure, on the caller's transaction, AND append `inspection.created` so the
   * inspections.inbox projection MATERIALIZES from init events instead of relying indefinitely on the live
   * fallback. Signal-only (no push at init). Returns the created id.
   */
  async createForInit(
    tx: Prisma.TransactionClient,
    args: Prisma.InspectionCreateArgs,
    emitCtx: { projectId: string; actor: Actor },
  ): Promise<{ id: string }> {
    const created = await tx.inspection.create(args);
    await emitEvent(tx, { projectId: emitCtx.projectId, actor: emitCtx.actor, eventType: 'inspection.created', entityType: 'Inspection', entityId: created.id, payload: { init: true }, effectKey: 'inspection.created', dispatch: {} });
    return created;
  }
}
