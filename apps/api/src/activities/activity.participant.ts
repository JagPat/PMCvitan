import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { GateState } from '../domain/transitions';

/**
 * Phase 2 Task 7 — the activity module's transaction-bound WORKFLOW PARTICIPANT.
 *
 * The atomic cross-module edges that write an Activity from ANOTHER module (the closing
 * sign-off from inspections — edges 2/3; the material-mismatch block from daily-log —
 * edge 4) route their Activity write THROUGH this participant, so the write physically
 * lives in the activities module (its owner) even though the workflow is orchestrated by
 * the caller. Each method operates on the caller's transaction client, so the whole edge
 * stays ONE unit of work with the caller's own writes — no half-applied sign-off, no
 * half-applied block. This is a leaf provider (no injected dependencies), so it creates
 * no DI cycle with the ActivitiesService/InspectionsService/DailyLogService that use it.
 */
@Injectable()
export class ActivityParticipant {
  /**
   * Approve-the-closing-inspection half of the sign-off workflow (edge 2): the linked
   * activity moves `awaiting_signoff -> done`, stamping the sign-off civil day. CAS — a
   * concurrent reject cannot half-win. The one legitimate non-awaiting state is a LEGACY
   * activity already `done` before sign-off control existed: record `doneAt` (never
   * re-transition), else 409.
   */
  async applySignOff(tx: Prisma.TransactionClient, params: { projectId: string; activityId: string; doneOn: Date | null }): Promise<void> {
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
  }

  /**
   * Reject-the-closing-inspection half of the sign-off workflow (edge 3): the activity
   * returns to EXECUTION. `done` is included for legacy closings — reopening a pre-Task-5
   * done activity here is the PMC's attributable decision. CAS — 409 on a raced change.
   */
  async revertSignOff(tx: Prisma.TransactionClient, params: { projectId: string; activityId: string }): Promise<void> {
    const { projectId, activityId } = params;
    const revert = await tx.activity.updateMany({
      where: { id: activityId, projectId, status: { in: ['awaiting_signoff', 'done'] } },
      data: { status: 'in_progress', doneAt: null },
    });
    if (revert.count === 0) throw new ConflictException('The activity changed while rejecting the sign-off — reload and retry');
  }

  /**
   * Material-mismatch → readiness block (edge 4): every activity linked to the mismatched
   * decision has its material gate failed and (unless already `done`) is blocked. Runs
   * under the caller's per-project readiness lock, in the SAME transaction as the
   * SiteMaterial write.
   */
  async blockForMaterialMismatch(tx: Prisma.TransactionClient, params: { projectId: string; decisionId: string }): Promise<void> {
    const { projectId, decisionId } = params;
    const activities = await tx.activity.findMany({ where: { projectId, decisionId } });
    for (const a of activities) {
      await tx.activity.update({
        where: { id: a.id },
        data: { gateMaterial: 'fail' as GateState, status: a.status === 'done' ? a.status : 'blocked', block: 'Material ≠ approved' },
      });
    }
  }

  /**
   * Project-initialization participant (edge 8): create one Activity while instantiating a
   * new project's starting structure, on the caller's transaction. The caller (orgs)
   * passes the shaped create args; the write lives here, in the owning module.
   */
  createForInit(tx: Prisma.TransactionClient, args: Prisma.ActivityCreateArgs): Promise<{ id: string }> {
    return tx.activity.create(args);
  }

  /**
   * Project-initialization participant (edge 8): create one Phase (owned by the activity
   * module) on the caller's transaction.
   */
  createPhaseForInit(tx: Prisma.TransactionClient, args: Prisma.PhaseCreateArgs): Promise<{ id: string }> {
    return tx.phase.create(args);
  }
}
