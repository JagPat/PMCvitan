import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
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
   * Phase 4 Task 2 (§F disposition) — the labour-owned equivalent of
   * `ProcurementParticipant.assertRequirementDisposable`. Cancelling a LABOUR requirement that
   * still has OPEN/ORDERED downstream labour requisition lines demands an explicit disposition
   * (cancel those lines first). The Activities cancel command invokes this labour-owned method
   * INSIDE its transaction (the cycle-exempt `activities → labour` participant edge), so the check
   * reads Labour's OWN `LabourRequisitionLine` table; the `lockProjectReadiness` both commands hold
   * serializes it against concurrent line creation. Labour stays a LEAF (it reads no Activities row).
   */
  async assertRequirementDisposable(tx: Prisma.TransactionClient, projectId: string, requirementId: string): Promise<void> {
    const open = await tx.labourRequisitionLine.count({
      where: {
        projectId,
        requirementId,
        status: { in: ['open', 'ordered'] },
        requisition: { status: { notIn: ['rejected', 'closed'] } },
      },
    });
    if (open > 0) {
      throw new ConflictException(
        `Requirement has ${open} open labour requisition line(s) — cancel them before cancelling the requirement (explicit disposition, plan §F)`,
      );
    }
    // Task-3 correction F4 — the §C side of the same disposition rule
    await this.assertAllocationsDisposed(tx, projectId, requirementId);
  }

  /**
   * Task-3 correction F2 — a photo cited as PRESENCE evidence can never be deleted. The muster is
   * an append-only observation the Team gate reads as execution truth, so deleting its selfie/QR
   * capture would leave an unfalsifiable claim behind. Invoked by the MEDIA module's delete
   * transaction (the same `assertMediaDisposable` pattern inventory uses for ledger evidence), so
   * Labour never reaches into the media delete path itself.
   *
   * A REVOKED muster still cites its evidence: the observation survives as history precisely so the
   * correction is auditable, and history without its evidence is not history.
   */
  async assertMediaDisposable(tx: Prisma.TransactionClient, projectId: string, mediaId: string): Promise<void> {
    const cited = await tx.labourAttendance.count({ where: { projectId, evidenceMediaId: mediaId } });
    if (cited > 0) {
      throw new ConflictException(
        `This photo is presence evidence on ${cited} attendance observation(s) — a muster is an append-only fact, so its evidence cannot be deleted (plan §C.3/§H)`,
      );
    }
  }

  /**
   * Task-3 correction F4 — cancelling a labour requirement must not STRAND live capacity. An
   * active `WorkerAllocation` is a real worker held on a real date for this demand; cancelling the
   * demand under it would leave the worker booked against something that no longer exists. The
   * disposition is explicit: release the allocations first (an attributable `allocation.released`
   * with a reason), then cancel. Called from the SAME `assertRequirementDisposable` the Activities
   * cancel command already invokes, under the readiness lock both commands hold.
   */
  private async assertAllocationsDisposed(tx: Prisma.TransactionClient, projectId: string, requirementId: string): Promise<void> {
    const live = await tx.workerAllocation.count({ where: { projectId, requirementId, status: 'active' } });
    if (live > 0) {
      throw new ConflictException(
        `Requirement has ${live} ACTIVE worker allocation(s) — release them before cancelling, so no worker is left booked against dead demand (plan §C.2)`,
      );
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

  /**
   * Phase 5 Task 4 (§G bounds 1–2) — the LABOUR twin of
   * `ProcurementParticipant.lockOrderedLineForClaim`, called INSIDE the commercial bill
   * transaction through the declared `commercial → labour` participant edge.
   *
   * It exists separately for the reason §C gives for the whole fold: `LabourPurchaseOrderLine`
   * is LABOUR-owned, so a spelling where procurement is the universal owner would either drop
   * labour claims from the bound entirely or make procurement read labour-owned rows. One rule,
   * two owners, each read — and each LOCKED — through its own contract.
   *
   * A labour line has no `approvedOverage` column, so §G bound 1's ordered authority is
   * `personShiftQty` exactly. That is not an omission: Phase-4 Task 2 pinned
   * `committedQty <= personShiftQty` and bound the commitment to its PO-line slice, so the labour
   * chain's overage headroom is STRUCTURALLY ZERO — adding one here would reopen Task 2.
   */
  async lockOrderedLineForClaim(
    tx: Prisma.TransactionClient,
    projectId: string,
    labourPoLineId: string,
  ): Promise<{
    vendorId: string; ordered: Prisma.Decimal; live: boolean; status: string;
    /** Phase 5 Task 5 (§E) — the frozen labour terms, from the SAME locked read. §E compares a
     *  labour claim against `ratePerPersonShift + shiftPremium` COMBINED, because that is the one
     *  combined figure the ordered side freezes; and there is no tax or freight to return, which
     *  is exactly why a labour claim line's tax and freight are CHECK-pinned to zero. */
    rate: Prisma.Decimal;
  } | null> {
    const rows = await tx.$queryRaw<Array<{
      vendorId: string; personShiftQty: number; poVersionId: string;
      ratePerPersonShift: Prisma.Decimal; shiftPremium: Prisma.Decimal;
    }>>`
      SELECT "vendorId", "personShiftQty", "poVersionId", "ratePerPersonShift", "shiftPremium"
        FROM "LabourPurchaseOrderLine"
       WHERE "projectId" = ${projectId} AND "id" = ${labourPoLineId}
       FOR UPDATE`;
    const line = rows[0];
    if (!line) return null;
    const version = await tx.labourPurchaseOrderVersion.findFirstOrThrow({
      where: { projectId, id: line.poVersionId },
      select: { status: true },
    });
    return {
      vendorId: line.vendorId,
      ordered: new Prisma.Decimal(line.personShiftQty),
      live: ['issued', 'partially_committed', 'completed', 'closed_short'].includes(version.status),
      status: version.status,
      rate: line.ratePerPersonShift.add(line.shiftPremium),
    };
  }
}
