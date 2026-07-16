import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Phase 2 Task 7 — the inspection module's transaction-bound WORKFLOW PARTICIPANT.
 *
 * Claiming an activity's completion (activities `complete`, edge 1) must create the LINKED
 * closing inspection in the SAME transaction. That Inspection write routes THROUGH this
 * participant, so it physically lives in the inspections module (its owner) while the
 * activities service orchestrates the workflow. A leaf provider (no injected
 * dependencies) — it creates no DI cycle with the services that use it.
 */
@Injectable()
export class InspectionParticipant {
  /**
   * Create the closing inspection for a completion claim (edge 1). ONE default sign-off
   * item makes rejection possible (a zero-item review could only ever be approved). The
   * caller passes the already-computed id, civil date and actor identity; the closing
   * shape (kind `review`, `closing=true`, submitted) lives here.
   */
  async createClosingInspection(
    tx: Prisma.TransactionClient,
    params: {
      closingId: string;
      projectId: string;
      activity: { id: string; name: string; zone: string; nodeId: string | null };
      actor: { actorId: string | null; actorName: string };
      inspectionDate: Date | null;
      dateLabel: string;
    },
  ): Promise<void> {
    const { closingId, projectId, activity, actor, inspectionDate, dateLabel } = params;
    await tx.inspection.create({
      data: {
        id: closingId,
        projectId,
        kind: 'review',
        closing: true,
        activityId: activity.id,
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
  }

  /**
   * Project-initialization participant (edge 8): create one Inspection (and its items)
   * while instantiating a new project's starting structure, on the caller's transaction.
   */
  createForInit(tx: Prisma.TransactionClient, args: Prisma.InspectionCreateArgs): Promise<{ id: string }> {
    return tx.inspection.create(args);
  }
}
