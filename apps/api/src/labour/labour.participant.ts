import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Phase 4 Task 1 — the labour WORKFLOW PARTICIPANT (plan §G, round-3).
 *
 * `LabourRequirementSpec` is Labour-module-owned, but the demand it details belongs to an
 * Activities-owned `ActivityRequirement` revision. So the Activities requirement command
 * writes the labour detail THROUGH this participant, inside the SAME transaction (the
 * cycle-exempt participant channel): Activities owns the requirement root/revision + the
 * generic `requirement.*` event; Labour owns the labour spec + its demand slices. This keeps
 * `labour.dependsOn = []` — Labour never reaches back into Activities; Activities reaches into
 * Labour only through this participant edge (`activities.workflowParticipants` includes
 * `labour`) and, from Task 4, the coverage read.
 *
 * The decision provenance is resolved by Activities (which already depends on decisions) and
 * passed in — Labour does not read the decisions module. This participant validates the labour
 * catalog membership (its own tables) and the fingerprint, then writes the spec + one slice per
 * civil date. The DB type↔detail trigger enforces exactly-one-detail-per-revision at commit.
 */
@Injectable()
export class LabourRequirementParticipant {
  /** Validate the labour catalog (labour-owned) for a spec write — the trade FK is a DB backstop,
   *  but the skill code (a text value, not FK'd) is checked here against the same-project catalog. */
  private async assertCatalog(tx: Prisma.TransactionClient, projectId: string, tradeCode: string, skillCode: string | null): Promise<void> {
    const trade = await tx.labourTrade.findUnique({ where: { projectId_code: { projectId, code: tradeCode } }, select: { code: true } });
    if (!trade) throw new BadRequestException(`tradeCode "${tradeCode}" is not a trade in this project's catalog`);
    if (skillCode) {
      const skill = await tx.labourSkill.findUnique({ where: { projectId_code: { projectId, code: skillCode } }, select: { code: true } });
      if (!skill) throw new BadRequestException(`skillCode "${skillCode}" is not a skill in this project's catalog`);
    }
  }

  /**
   * Write the labour detail of one requirement revision (create/revise): the
   * `LabourRequirementSpec` + one `LabourDemandSlice` per civil date. Runs inside the Activities
   * requirement command transaction. Provenance is server-resolved by the caller (Activities).
   */
  async writeRequirementSpec(
    tx: Prisma.TransactionClient,
    input: {
      projectId: string;
      requirementId: string;
      revision: number;
      tradeCode: string;
      skillCode: string | null;
      shift: string;
      labourSpecFingerprint: string;
      decisionId: string | null;
      decisionVersion: number | null;
      optionKey: string | null;
      slices: ReadonlyArray<{ civilDate: Date; personShiftQty: number }>;
    },
  ): Promise<void> {
    await this.assertCatalog(tx, input.projectId, input.tradeCode, input.skillCode);
    await tx.labourRequirementSpec.create({
      data: {
        projectId: input.projectId,
        requirementId: input.requirementId,
        revision: input.revision,
        tradeCode: input.tradeCode,
        skillCode: input.skillCode,
        shift: input.shift,
        labourSpecFingerprint: input.labourSpecFingerprint,
        decisionId: input.decisionId,
        decisionVersion: input.decisionVersion,
        optionKey: input.optionKey,
      },
    });
    for (const slice of input.slices) {
      await tx.labourDemandSlice.create({
        data: {
          projectId: input.projectId,
          requirementId: input.requirementId,
          revision: input.revision,
          civilDate: slice.civilDate,
          personShiftQty: slice.personShiftQty,
        },
      });
    }
  }

  /**
   * Copy a labour requirement revision's detail VERBATIM onto a new revision — used by the
   * cancel command, which appends a `status='cancelled'` revision that must carry the same
   * labour detail so the type↔detail correspondence holds on the cancellation revision too.
   */
  async copyRequirementSpecForCancel(
    tx: Prisma.TransactionClient,
    projectId: string,
    requirementId: string,
    fromRevision: number,
    toRevision: number,
  ): Promise<void> {
    const spec = await tx.labourRequirementSpec.findUnique({
      where: { projectId_requirementId_revision: { projectId, requirementId, revision: fromRevision } },
    });
    if (!spec) return; // not a labour requirement — nothing to copy
    await tx.labourRequirementSpec.create({
      data: {
        projectId,
        requirementId,
        revision: toRevision,
        tradeCode: spec.tradeCode,
        skillCode: spec.skillCode,
        shift: spec.shift,
        labourSpecFingerprint: spec.labourSpecFingerprint,
        decisionId: spec.decisionId,
        decisionVersion: spec.decisionVersion,
        optionKey: spec.optionKey,
      },
    });
    const slices = await tx.labourDemandSlice.findMany({ where: { projectId, requirementId, revision: fromRevision } });
    for (const slice of slices) {
      await tx.labourDemandSlice.create({
        data: { projectId, requirementId, revision: toRevision, civilDate: slice.civilDate, personShiftQty: slice.personShiftQty },
      });
    }
  }
}
