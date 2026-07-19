import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { emitEvent } from '../platform/events';
import type { Actor } from '../common/actor';
import type { EmittedEventMeta } from '../platform/outbox/registry';

/**
 * Phase 2 Task 10 (Module 4) correction — the daily-log module's transaction-bound WORKFLOW
 * PARTICIPANT.
 *
 * The daily-log.inbox projection serializes the staging place of every site material
 * (`SiteMaterial.nodeId`), which before this correction mutated ONLY through the database
 * `ON DELETE SET NULL` FK action when the filed ProjectNode was deleted — the deleting command's
 * `node.removed` event is a NOOP for the daily-log consumer, so the ordered cursor advanced past the
 * change and the generation served a silently-stale place. This participant performs the EXPLICIT
 * `updateMany` on the node-remove transaction BEFORE the node delete (the SET NULL FK stays as the
 * database backstop) and appends `material.unfiled` ONLY when rows actually changed, so the
 * daily-log.inbox cursor observes the base change. Signal-only (invalidate, never push). A leaf
 * provider (no injected dependencies), so it creates no DI cycle with the services that call it.
 */
@Injectable()
export class DailyLogParticipant {
  /**
   * Clear the staging place of every site material filed on a node being deleted (unfile) and append
   * `material.unfiled` when any row changed. Returns the event meta (dispatched by the caller
   * post-commit), or `null` when no filed material was affected.
   */
  async unfileMaterialsForDeletedNodes(
    tx: Prisma.TransactionClient,
    params: { projectId: string; actor: Actor; nodeIds: readonly string[] },
  ): Promise<EmittedEventMeta | null> {
    const { projectId, actor, nodeIds } = params;
    if (nodeIds.length === 0) return null;
    const { count } = await tx.siteMaterial.updateMany({
      where: { projectId, nodeId: { in: [...nodeIds] } },
      data: { nodeId: null },
    });
    if (count === 0) return null;
    return emitEvent(tx, { projectId, actor, eventType: 'material.unfiled', entityType: 'ProjectNode', entityId: nodeIds[0], payload: { unfiled: count }, effectKey: 'material.unfiled', dispatch: {} });
  }
}
