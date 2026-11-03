import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { tallyOpenWork, type OpenWorkCounts } from '../common/open-work';
import { emitEvent } from '../platform/events';
import type { Actor } from '../common/actor';
import type { EmittedEventMeta } from '../platform/outbox/registry';

/**
 * Phase 2 Task 10 (Module 4) correction — the drawings module's transaction-bound WORKFLOW PARTICIPANT.
 *
 * The drawings.inbox projection serializes two DRAWING-OWNED references that, before this correction,
 * could mutate through a database `ON DELETE SET NULL` FK action with NO drawing-owned event: the
 * governed-activity link (`Drawing.activityId`, nulled when the linked Activity is deleted) and the
 * filing location (`Drawing.nodeId`, nulled when the filed ProjectNode is deleted). The deleting
 * command's own events (`activity.deleted` / `node.removed`) are NOOPs for the drawings consumer, so
 * the ordered cursor advanced past the change and the generation served a silently-stale reference —
 * the Module-3 owner-aligned lesson resurfacing through the FK side channel.
 *
 * Each method here performs the EXPLICIT `updateMany` on the caller's transaction BEFORE the owning
 * delete (the SET NULL FK stays as the database backstop for anything the update did not reach) and
 * appends a drawing-owned signal event ONLY when rows actually changed, so the drawings.inbox cursor
 * observes every base change. Signal-only (invalidate, never push). A leaf provider (no injected
 * dependencies — `emitEvent` is a pure platform function), so it creates no DI cycle with the
 * services that call it.
 */
@Injectable()
export class DrawingParticipant {
  /**
   * Redbracket ID A4b-2 — drawings still waiting on these accounts, per project: each revision that governs
   * construction (`for_construction`) whose frozen recipient set names the account and which the account has not
   * acknowledged. A superseded revision no longer waits on anyone. Read by the operator door's list of retired accounts.
   */
  async openWorkOf(db: Prisma.TransactionClient, userIds: string[]): Promise<OpenWorkCounts> {
    const counts: OpenWorkCounts = new Map();
    if (userIds.length === 0) return counts;
    const waiting = await db.drawingRecipient.findMany({
      where: { userId: { in: userIds }, revision: { status: 'for_construction' } },
      select: { projectId: true, revisionId: true, userId: true },
    });
    if (waiting.length === 0) return counts;
    const acks = await db.drawingAck.findMany({
      where: { revisionId: { in: [...new Set(waiting.map((w) => w.revisionId))] }, userId: { in: userIds } },
      select: { revisionId: true, userId: true },
    });
    const acked = new Set(acks.map((a) => `${a.revisionId}\u0000${a.userId}`));
    for (const w of waiting) if (!acked.has(`${w.revisionId}\u0000${w.userId}`)) tallyOpenWork(counts, w.userId, w.projectId);
    return counts;
  }

  /**
   * Clear the governed-activity link of every drawing linked to an activity being deleted (edge 5's
   * owner-aligned half) and append `drawing.activity_unlinked` when any row changed — invoked on the
   * activity-remove transaction BEFORE the activity row is deleted. Returns the event meta (dispatched
   * by the caller post-commit), or `null` when no linked drawing existed.
   */
  async unlinkFromDeletedActivity(
    tx: Prisma.TransactionClient,
    params: { projectId: string; actor: Actor; activityId: string },
  ): Promise<EmittedEventMeta | null> {
    const { projectId, actor, activityId } = params;
    const { count } = await tx.drawing.updateMany({
      where: { projectId, activityId },
      data: { activityId: null },
    });
    if (count === 0) return null;
    return emitEvent(tx, { projectId, actor, eventType: 'drawing.activity_unlinked', entityType: 'Activity', entityId: activityId, payload: { unlinked: count }, effectKey: 'drawing.activity_unlinked', dispatch: {} });
  }

  /**
   * Clear the location of every drawing filed on a node being deleted (unfile) and append
   * `drawing.unfiled` when any row changed — invoked on the node-remove transaction BEFORE the node is
   * deleted (the FK stays as the database backstop). Returns the event meta, or `null` when no filed
   * drawing was affected.
   */
  async unfileForDeletedNodes(
    tx: Prisma.TransactionClient,
    params: { projectId: string; actor: Actor; nodeIds: readonly string[] },
  ): Promise<EmittedEventMeta | null> {
    const { projectId, actor, nodeIds } = params;
    if (nodeIds.length === 0) return null;
    const { count } = await tx.drawing.updateMany({
      where: { projectId, nodeId: { in: [...nodeIds] } },
      data: { nodeId: null },
    });
    if (count === 0) return null;
    return emitEvent(tx, { projectId, actor, eventType: 'drawing.unfiled', entityType: 'ProjectNode', entityId: nodeIds[0], payload: { unfiled: count }, effectKey: 'drawing.unfiled', dispatch: {} });
  }
}
