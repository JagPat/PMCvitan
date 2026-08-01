import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CommercialActivationPlan } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { recordAudit } from '../platform/audit';
import { systemActor } from '../common/actor';
import { LabourRequirementQuery } from '../labour/labour.query';
import { ProcurementQuery } from '../procurement/procurement.query';
import { COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { CommercialParticipant } from './commercial.participant';

/**
 * Phase 5 Task 1 — commercial pilot ACTIVATION (plan §L).
 *
 * Enabling `commercial` is not a no-op, and that is the whole point of this service. A pilot
 * project can already hold live material and labour POs, and §C only writes the initial
 * attribution during FUTURE issuance — so flipping the capability on would leave those
 * obligations unattributed, `COMMITTED(costHead)` reading ₹0 and the budget-vs-committed
 * exception silently missing every existing vendor commitment. That is the "observational not
 * operational" defect Phase 3 Task 7 was blocked for, entered backwards.
 *
 * And the enable path must be able to SUCCEED, not only refuse. "The operator picks" has a
 * bootstrap hole: while the capability is off there are no commercial rows and no commercial
 * routes, so an operator told to go and choose a cost head has no surface on which to choose.
 * The mapping is therefore INPUT — the `CostHead` rows to create AND a `{line → costHeadCode}`
 * attribution for every live line — created and attributed in the SAME transaction as the
 * capability row. Activation refuses ONLY when the supplied mapping leaves a live line unmapped,
 * and it NAMES those lines so the operator can re-run with them covered. It never invents a cost
 * head.
 */
@Injectable()
export class CommercialActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly participant: CommercialParticipant,
    private readonly procurement: ProcurementQuery,
    private readonly labour: LabourRequirementQuery,
  ) {}

  /**
   * Enable `commercial` for ONE project, attributing every live PO line in the same transaction.
   * Idempotent: re-running against an already-enabled project re-asserts the plan and leaves the
   * existing attributions alone (the participant's replay rule), so a re-run after a partial
   * operator error is safe.
   */
  async activate(projectId: string, operator: string, plan: CommercialActivationPlan): Promise<{
    costHeads: number;
    materialLines: number;
    labourLines: number;
  }> {
    const reason = plan.reason?.trim();
    if (!reason) throw new BadRequestException('Activation must carry an attributable reason');

    return this.prisma.$transaction(async (tx) => {
      await tx.project.findUniqueOrThrow({ where: { id: projectId }, select: { id: true } });

      // The operator identity is a real User row: every attribution is attributable to a person,
      // and the FK makes an invented operator string unrepresentable rather than merely unusual.
      const actorUser = await tx.user.findUnique({ where: { email: operator }, select: { id: true, role: true } });
      if (!actorUser) {
        throw new BadRequestException(
          `Operator "${operator}" is not a user in this deployment — activation attributes rows to a real identity`,
        );
      }
      const actor = { actorId: actorUser.id, role: actorUser.role };

      for (const head of plan.costHeads) {
        await tx.costHead.upsert({
          where: { projectId_code: { projectId, code: head.code } },
          create: { projectId, code: head.code, name: head.name, definedById: actor.actorId },
          update: {}, // the code is the key and is frozen; a re-run never re-keys or re-labels
        });
      }

      const liveMaterial = await this.procurement.liveOrderedLineIds(projectId, tx);
      const liveLabour = await this.labour.liveOrderedLineIds(projectId, tx);
      const materialMap = new Map(plan.materialLines.map((l) => [l.poLineId, l.costHeadCode]));
      const labourMap = new Map(plan.labourLines.map((l) => [l.labourPoLineId, l.costHeadCode]));

      // §L: refuse — NAMING the lines — rather than invent a cost head for them.
      const unmappedMaterial = liveMaterial.filter((id) => !materialMap.has(id));
      const unmappedLabour = liveLabour.filter((id) => !labourMap.has(id));
      if (unmappedMaterial.length || unmappedLabour.length) {
        throw new BadRequestException(
          'Activation refused: every LIVE purchase-order line must be attributed to a cost head. ' +
            `Unmapped material lines: [${unmappedMaterial.join(', ')}]. ` +
            `Unmapped labour lines: [${unmappedLabour.join(', ')}]. ` +
            'Re-run with these lines covered.',
        );
      }

      // The participant is the ONE write path (§C), so the backfill obeys the same authority,
      // the same cost-head validation and the same seals as every forward hook.
      await this.participant.attribute(
        tx,
        projectId,
        actor,
        liveMaterial.map((id) => ({ target: { poLineId: id }, costHeadCode: materialMap.get(id)!, reason })),
      );
      await this.participant.attribute(
        tx,
        projectId,
        actor,
        liveLabour.map((id) => ({ target: { labourPoLineId: id }, costHeadCode: labourMap.get(id)!, reason })),
      );

      await tx.projectCapability.upsert({
        where: { projectId_capability: { projectId, capability: COMMERCIAL_CAPABILITY } },
        create: { projectId, capability: COMMERCIAL_CAPABILITY, enabledById: operator },
        update: {},
      });
      await recordAudit(tx, {
        projectId,
        actor: systemActor(operator, operator, 'operator'),
        action: 'capability.enable',
        entity: 'ProjectCapability',
        entityId: `${projectId}:${COMMERCIAL_CAPABILITY}`,
      });

      return { costHeads: plan.costHeads.length, materialLines: liveMaterial.length, labourLines: liveLabour.length };
    });
  }
}
