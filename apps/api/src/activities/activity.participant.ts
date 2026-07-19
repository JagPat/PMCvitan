import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { emitEvent } from '../platform/events';
import type { Actor } from '../common/actor';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import type { GateState } from '../domain/transitions';

/**
 * Phase 2 Task 7 / Task 10 (Module 4) — the activity module's transaction-bound WORKFLOW PARTICIPANT.
 *
 * The atomic cross-module edges that write an Activity from ANOTHER module (the closing
 * sign-off from inspections — edges 2/3; the material-mismatch block from daily-log —
 * edge 4; the location unfile from nodes; project initialization — edge 8) route their
 * Activity write THROUGH this participant, so the write physically lives in the
 * activities module (its owner) even though the workflow is orchestrated by the caller.
 * Each method operates on the caller's transaction client, so the whole edge stays ONE
 * unit of work with the caller's own writes — no half-applied sign-off, no half-applied
 * block.
 *
 * Module 4 (the Module-3 owner-aligned invariant, applied up front): every foreign
 * mutation of an ACTIVITY-OWNED serialized fact also appends an activity-owned domain
 * event on the SAME transaction, so the `activities.schedule` projection's ordered
 * cursor observes every base change. The sign-off edges need no event here — the
 * inspections decide already emits `activity.signed_off`/`activity.signoff_rejected` on
 * its own transaction; instead they RETURN the tx-current activity name so the caller
 * never reads `prisma.activity` directly (and never stamps a stale pre-transaction
 * name). This is a leaf provider (no injected dependencies — `emitEvent` is a pure
 * platform function), so it creates no DI cycle with the services that use it.
 */
@Injectable()
export class ActivityParticipant {
  /**
   * The sign-off TARGET a closing-inspection decide reads before its command runs: the linked
   * activity's identity, display name (fast pre-validation only — the in-transaction methods below
   * return the authoritative tx-current name) and recorded completion claimant (the default
   * corrective assignee on rejection). Lives HERE so the inspections module never reads
   * `prisma.activity` itself (activities is DOWNSTREAM of inspections in dependsOn — the workflow
   * participant is the cycle-exempt channel).
   */
  async signOffTarget(
    db: Prisma.TransactionClient,
    params: { projectId: string; activityId: string },
  ): Promise<{ id: string; name: string; completionRequestedById: string | null } | null> {
    const { projectId, activityId } = params;
    return db.activity.findFirst({
      where: { id: activityId, projectId },
      select: { id: true, name: true, completionRequestedById: true },
    });
  }

  /**
   * Approve-the-closing-inspection half of the sign-off workflow (edge 2): the linked
   * activity moves `awaiting_signoff -> done`, stamping the sign-off civil day. CAS — a
   * concurrent reject cannot half-win. The one legitimate non-awaiting state is a LEGACY
   * activity already `done` before sign-off control existed: record `doneAt` (never
   * re-transition), else 409. Returns the TX-CURRENT activity name (read after the CAS
   * row lock) for the caller's notification/event/push bodies.
   */
  async applySignOff(tx: Prisma.TransactionClient, params: { projectId: string; activityId: string; doneOn: Date | null }): Promise<{ name: string }> {
    const { projectId, activityId, doneOn } = params;
    const done = await tx.activity.updateMany({
      where: { id: activityId, projectId, status: 'awaiting_signoff' },
      data: { status: 'done', doneAt: doneOn },
    });
    if (done.count === 0) {
      const row = await tx.activity.findUnique({ where: { id: activityId }, select: { status: true, doneAt: true } });
      if (row?.status !== 'done') throw new ConflictException('The activity changed while signing off — reload and retry');
      if (!row.doneAt) await tx.activity.update({ where: { id: activityId }, data: { doneAt: doneOn } });
    }
    const fresh = await tx.activity.findUniqueOrThrow({ where: { id: activityId }, select: { name: true } });
    return { name: fresh.name };
  }

  /**
   * Reject-the-closing-inspection half of the sign-off workflow (edge 3): the activity
   * returns to EXECUTION. `done` is included for legacy closings — reopening a pre-Task-5
   * done activity here is the PMC's attributable decision. CAS — 409 on a raced change.
   * Returns the TX-CURRENT activity name (read after the CAS row lock).
   */
  async revertSignOff(tx: Prisma.TransactionClient, params: { projectId: string; activityId: string }): Promise<{ name: string }> {
    const { projectId, activityId } = params;
    const revert = await tx.activity.updateMany({
      where: { id: activityId, projectId, status: { in: ['awaiting_signoff', 'done'] } },
      data: { status: 'in_progress', doneAt: null },
    });
    if (revert.count === 0) throw new ConflictException('The activity changed while rejecting the sign-off — reload and retry');
    const fresh = await tx.activity.findUniqueOrThrow({ where: { id: activityId }, select: { name: true } });
    return { name: fresh.name };
  }

  /**
   * Material-mismatch → readiness block (edge 4): every activity linked to the mismatched
   * decision has its material gate failed and (unless already `done`) is blocked. Runs
   * under the caller's per-project readiness lock, in the SAME transaction as the
   * SiteMaterial write. Appends ONE `activity.material_blocked` event when any activity
   * changed — the gate/status/block writes are ACTIVITY-OWNED serialized facts, so the
   * `activities.schedule` projection must observe the mutation. Returns the event meta
   * (dispatched by the caller post-commit), or `null` when no linked activity existed.
   */
  async blockForMaterialMismatch(
    tx: Prisma.TransactionClient,
    params: { projectId: string; decisionId: string; actor: Actor },
  ): Promise<EmittedEventMeta | null> {
    const { projectId, decisionId, actor } = params;
    const activities = await tx.activity.findMany({ where: { projectId, decisionId } });
    for (const a of activities) {
      await tx.activity.update({
        where: { id: a.id },
        data: { gateMaterial: 'fail' as GateState, status: a.status === 'done' ? a.status : 'blocked', block: 'Material ≠ approved' },
      });
    }
    if (activities.length === 0) return null;
    return emitEvent(tx, { projectId, actor, eventType: 'activity.material_blocked', entityType: 'Activity', entityId: activities[0].id, payload: { decisionId, blocked: activities.length }, effectKey: 'activity.material_blocked', dispatch: {} });
  }

  /**
   * Clear the location of every activity filed on a node being deleted (unfile) and append
   * `activity.unfiled` when any row changed — invoked on the node-remove transaction BEFORE the node
   * is deleted, so the projection observes the location change instead of relying on the FK's silent
   * `SET NULL` (the FK stays as a database backstop). Returns the event meta, or `null` when no filed
   * activity was affected.
   */
  async unfileForDeletedNodes(
    tx: Prisma.TransactionClient,
    params: { projectId: string; actor: Actor; nodeIds: readonly string[] },
  ): Promise<EmittedEventMeta | null> {
    const { projectId, actor, nodeIds } = params;
    if (nodeIds.length === 0) return null;
    const { count } = await tx.activity.updateMany({
      where: { projectId, nodeId: { in: [...nodeIds] } },
      data: { nodeId: null },
    });
    if (count === 0) return null;
    return emitEvent(tx, { projectId, actor, eventType: 'activity.unfiled', entityType: 'ProjectNode', entityId: nodeIds[0], payload: { unfiled: count }, effectKey: 'activity.unfiled', dispatch: {} });
  }

  /**
   * Project-initialization participant (edge 8): create one Activity while instantiating a
   * new project's starting structure, on the caller's transaction, AND append `activity.created` so
   * the activities.schedule projection MATERIALIZES from init events instead of relying indefinitely
   * on the live fallback. Signal-only (no push at init — the catalog's `activity.created` push roles
   * apply to the command path; init's `{init: true}` dispatch stays empty).
   */
  async createForInit(
    tx: Prisma.TransactionClient,
    args: Prisma.ActivityCreateArgs,
    emitCtx: { projectId: string; actor: Actor },
  ): Promise<{ id: string }> {
    const created = await tx.activity.create(args);
    await emitEvent(tx, { projectId: emitCtx.projectId, actor: emitCtx.actor, eventType: 'activity.created', entityType: 'Activity', entityId: created.id, payload: { init: true }, effectKey: 'activity.created', dispatch: {} });
    return created;
  }

  /**
   * Project-initialization participant (edge 8): create one Phase (owned by the activity
   * module) on the caller's transaction, AND append `phase.created` (same materialization
   * rationale as {@link createForInit}).
   */
  async createPhaseForInit(
    tx: Prisma.TransactionClient,
    args: Prisma.PhaseCreateArgs,
    emitCtx: { projectId: string; actor: Actor },
  ): Promise<{ id: string }> {
    const created = await tx.phase.create(args);
    await emitEvent(tx, { projectId: emitCtx.projectId, actor: emitCtx.actor, eventType: 'phase.created', entityType: 'Phase', entityId: created.id, payload: { init: true }, effectKey: 'phase.created', dispatch: {} });
    return created;
  }
}
