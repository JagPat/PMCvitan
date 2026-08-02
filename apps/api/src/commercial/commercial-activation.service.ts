import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLE_POLICY, type CommercialActivationPlan } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { recordAudit } from '../platform/audit';
import { systemActor } from '../common/actor';
import { lockProjectReadiness } from '../common/readiness-lock';
import { LabourRequirementQuery } from '../labour/labour.query';
import { ProcurementQuery } from '../procurement/procurement.query';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { CommercialParticipant, type AttributionActor } from './commercial.participant';

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
    private readonly orgs: OrgsParticipant,
  ) {}

  /**
   * Codex round 1 (P1 + P2) — the operator's authority is resolved from LIVE PROJECT ACCESS, and
   * it is resolved BEFORE any write.
   *
   * Two defects, one fix. The first spelling read `User.role`, a legacy column that is not the
   * authority a request runs under: `ProjectAccessService.authorize` decides from the ACTIVE
   * `Membership` (with the org owner/admin fallback operating a project AS pmc), so a removed
   * member whose stale user row still said `pmc` could activate, while a genuine project PMC whose
   * legacy row differed was refused. The second: the participant's own check early-returns on an
   * EMPTY row list, so a project with no live PO lines skipped authorization entirely while the
   * transaction still created cost heads and the `ProjectCapability` row — an unauthorized caller
   * could turn the pilot on and author its initial catalog.
   *
   * The question is asked through `OrgsParticipant.hasProjectRoleStanding` — the cleared Phase-4
   * T3 precedent. `Membership`/`Project`/`OrgMembership` are orgs-owned, so the OWNER answers the
   * membership question and commercial supplies the policy it is enforcing. Asking one role at a
   * time yields the operator's ACTUAL project role rather than a fabricated one, so the
   * participant's own guard downstream is checking something true.
   */
  private async resolveOperator(
    tx: Prisma.TransactionClient,
    projectId: string,
    operator: string,
  ): Promise<AttributionActor> {
    // Codex round 2 (P2) — identity resolution belongs to the OWNER. `User` is orgs-owned, and
    // merely not being read-encapsulated makes a direct read representable, not legitimate: which
    // column is the identity key, whether email is unique, and whether a disabled account still
    // resolves are orgs' semantics to state, not commercial's to assume. The CLI passes an email
    // and a programmatic caller a user id; both go through the same orgs contract, in this
    // transaction, so identity and standing see one snapshot.
    const user = await this.orgs.resolveUserIdentity(tx, operator);
    if (!user) {
      throw new BadRequestException(
        `Operator "${operator}" is not a user in this deployment — activation attributes rows to a real identity`,
      );
    }
    for (const candidate of ROLE_POLICY['commercial.attribute'] as readonly string[]) {
      if (await this.orgs.hasProjectRoleStanding(tx, projectId, user.id, [candidate])) {
        return { actorId: user.id, role: candidate };
      }
    }
    throw new ForbiddenException(
      `Operator "${operator}" does not hold \`commercial.attribute\` on this project — activation authors the initial attributions and is not a side door`,
    );
  }

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
      // Codex round 3 (P2) — the project must be OPERABLE, not merely present. The first spelling
      // read `Project` directly (an orgs-owned table — the round-2 ownership finding again) and
      // only proved the row existed. `ProjectAccessService.authorize` refuses an ARCHIVED project
      // before it considers membership, so an active PMC left on an archived project could
      // otherwise commit cost heads, attributions and the capability row that no request path
      // could author. The owner states the rule; commercial asks.
      if (!(await this.orgs.isProjectOperable(tx, projectId))) {
        throw new BadRequestException(
          `Project "${projectId}" is archived or does not exist — activation authors rows no request path could`,
        );
      }

      // Codex round 1 (P1) — activation SERIALIZES with the PO lifecycle. Every PO command
      // (`pos.issue`/amend/cancel/close-short, material and labour) takes this same lock, and
      // without it the live-line reads below race them: activation reads zero live lines while a
      // PO is still draft, `pos.issue` then sees commercial inactive and issues WITHOUT an
      // attribution, and activation commits the capability row afterwards — leaving an enabled
      // project holding a live unattributed line, the one state §C forbids. The mirror image is
      // equally real: a line read as live here can be cancelled before this transaction commits.
      // Taking the lock FIRST, before any status read, makes both orderings impossible.
      await lockProjectReadiness(tx, projectId);

      // Authority is resolved from LIVE project access, and BEFORE any write — see resolveOperator.
      const actor = await this.resolveOperator(tx, projectId, operator);

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
        create: { projectId, capability: COMMERCIAL_CAPABILITY, enabledById: actor.actorId },
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
