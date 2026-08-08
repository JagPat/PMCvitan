import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ROLE_POLICY, type CommitmentAttributionDto, type CostHeadDto } from '@vitan/shared';
import type { DefineCostHeadInput, ReattributeInput } from '../contracts';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import { recordAudit } from '../platform/audit';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { lockProjectReadiness } from '../common/readiness-lock';
import { CommercialParticipant, type AttributionTarget } from './commercial.participant';
import { serializeAttribution } from './commercial.serialize';
import { announceMoneyMoved } from './cash-forecast.projection';

/**
 * Phase 5 Task 1 — the COMMERCIAL service (plan §C/§L).
 *
 * Writes ONLY commercial-owned tables (`CostHead`, `CommitmentAttribution`), capability-gated
 * (§D — 404 off-pilot). It dispatches nothing and emits no domain event: an attribution is an
 * internal accounting fact with no external effect and no consumer. Attributability is the actor
 * FK plus the reason, sealed append-only at PostgreSQL, and carried onto the project's audit
 * trail by `recordAudit`.
 *
 * The INITIAL attribution is deliberately NOT here — §C requires it inside the transaction that
 * makes a PO version live, through `CommercialParticipant`. What lives here is the catalog write
 * and the standalone RE-ATTRIBUTION, which is the reclassification path: an atomic replacement
 * that supersedes the active row and inserts its successor, never an in-place edit.
 */
@Injectable()
export class CommercialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly participant: CommercialParticipant,
  ) {}

  /** Route-guarded too; this is the service-level backstop against a direct caller. */
  private assertManage(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.manage'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Defining a cost head is a pmc surface');
    }
  }

  private assertAttribute(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.attribute'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException(
        'Attributing a vendor commitment to a cost head requires `commercial.attribute`',
      );
    }
  }

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The commercial register is a pmc/engineer surface');
    }
  }

  private scope(projectId: string): CommandScope {
    return { scopeKind: 'project', projectId };
  }

  async defineCostHead(
    projectId: string,
    input: DefineCostHeadInput,
    user: AuthUser,
    idempotencyKey?: string,
  ): Promise<CostHeadDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertManage(user);
    const actor = await resolveActor(this.prisma, user);
    await executeCommand(this.prisma, {
      scope: this.scope(projectId), actor, commandType: 'commercial.costHead.define',
      idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        // The code is the KEY and is frozen at PostgreSQL (§0b), so a re-run may refresh the
        // display name but can never re-key: reclassification is a NEW head plus an attributable
        // re-attribution, never an in-place rename that moves recorded history silently.
        await tx.costHead.upsert({
          where: { projectId_code: { projectId, code: input.code } },
          create: { projectId, code: input.code, name: input.name, definedById: actor.actorId },
          update: { name: input.name },
        });
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.costHead.define',
          entity: 'CostHead', entityId: `${projectId}:${input.code}`,
        });
        // §J (Task 7A) — the SECOND announcement seam, and the only one that is not
        // `CommercialBudgetService.evaluate`. It exists because this command moves no money and
        // still changes what the forecast says: a new head APPEARS as an all-zero row, and the
        // `update` arm above RENAMES an existing one. Neither is a headroom mover, so §B's
        // evaluation would never fire and the projection would sit one head (or one name) behind
        // the live read until something unrelated moved. CLOSURE C in `commercial.contract.test.ts`
        // derives the compute path's read surface and pins that `CostHead` is covered HERE — so this
        // call cannot be deleted, and a third input model cannot be added without being classified.
        await announceMoneyMoved(tx, projectId, actor, { costHeadCodes: [input.code], reason: 'cost_head' });
        return { resultRef: `${projectId}:${input.code}`, events: [] };
      },
    });
    return this.readCostHead(projectId, input.code);
  }

  /**
   * §C reclassification: an ATOMIC REPLACEMENT in one transaction. There is no "revoke" —
   * revoking Head A as miscoded would drop the live vendor obligation out of every budget and
   * forecast while no other head picked the payable up.
   */
  async reattribute(
    projectId: string,
    input: ReattributeInput,
    user: AuthUser,
    idempotencyKey?: string,
  ): Promise<CommitmentAttributionDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    // AUTHORIZATION PRECEDES STATE INSPECTION. The participant enforces this too — the authority
    // follows the WRITE, not the route (§C, probe 5ar) — but reaching it first would mean an
    // unauthorized caller learns whether a line is attributed from the 409 the precondition below
    // raises. Refusing on authority first keeps the register's state unreadable to them.
    this.assertAttribute(user);
    const actor = await resolveActor(this.prisma, user);
    const target: AttributionTarget = input.poLineId
      ? { poLineId: input.poLineId }
      : { labourPoLineId: input.labourPoLineId! };
    const outcome = await executeCommand(this.prisma, {
      scope: this.scope(projectId), actor, commandType: 'commercial.attribution.reattribute',
      idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        // Codex round 2 (P1) — SERIALIZE WITH THE PO LIFECYCLE, before the active-row check.
        // Round 1 put this lock on activation and stopped there; this is the SAME rule's second
        // site, which is §0b's own failure class. Without it: this command reads active
        // attribution A, a concurrent `pos.cancel`/`pos.amend` (holding the same lock) supersedes
        // A and commits, and the replacement below then inserts a NEW active attribution on a line
        // that is no longer live — commercial reporting a dead obligation, which is exactly what
        // the cancel hook exists to prevent. Taking the lock FIRST makes the precondition below a
        // decision about state that cannot move underneath it.
        await lockProjectReadiness(tx, projectId);

        // Codex round 1 (P2) — RECLASSIFICATION PRESUPPOSES SOMETHING TO RECLASSIFY.
        // `replaceAttribution` deliberately tolerates a missing prior row, because the amend path
        // must still attribute a v2 line when the capability was enabled after v1 was issued. The
        // standalone route must NOT inherit that tolerance: a draft line (never attributed), a
        // cancelled one (released) and a superseded version's line (replaced) all have no active
        // attribution, and creating one here would make the register claim a live obligation the
        // lifecycle hooks had correctly released. One check covers all three states.
        const active = await tx.commitmentAttribution.findFirst({
          where: { projectId, supersededAt: null, ...('poLineId' in target ? { poLineId: target.poLineId } : { labourPoLineId: target.labourPoLineId }) },
          select: { id: true },
        });
        if (!active) {
          throw new ConflictException(
            'This purchase-order line carries no active attribution — only a LIVE attributed commitment can be reclassified',
          );
        }
        // The participant enforces `commercial.attribute` — the SAME check the `pos.issue` path
        // gets, because the authority follows the WRITE, not the route (§C, probe 5ar).
        await this.participant.replaceAttribution(tx, projectId, { actorId: actor.actorId, actorKind: actor.actorKind, role: user.role }, [
          { from: target, to: target, costHeadCode: input.costHeadCode, reason: input.reason },
        // the label is DERIVED: this route names a NEW head for the same line, so the participant
        // sees `active.costHeadCode !== code` and records `reattribution` on both heads. Naming it
        // here would be a second place for the same truth to live — and to go stale.
        ]);
        const replacement = await tx.commitmentAttribution.findFirstOrThrow({
          where: { projectId, supersededAt: null, ...('poLineId' in target ? { poLineId: target.poLineId } : { labourPoLineId: target.labourPoLineId }) },
          select: { id: true },
        });
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.attribution.reattribute',
          entity: 'CommitmentAttribution', entityId: replacement.id,
        });
        return { resultRef: replacement.id, events: [] };
      },
    });
    return this.readAttribution(projectId, outcome.resultRef);
  }

  async listCostHeads(projectId: string, user: AuthUser): Promise<CostHeadDto[]> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);
    const rows = await this.prisma.costHead.findMany({ where: { projectId }, orderBy: { code: 'asc' } });
    return rows.map((r) => ({ code: r.code, name: r.name, definedAt: r.definedAt.toISOString(), definedById: r.definedById }));
  }

  /** The attribution register — active rows AND their superseded history, which is the evidence
   *  that a reclassification happened and who authored it. */
  async listAttributions(projectId: string, user: AuthUser): Promise<CommitmentAttributionDto[]> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);
    const rows = await this.prisma.commitmentAttribution.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(serializeAttribution);
  }

  private async readCostHead(projectId: string, code: string): Promise<CostHeadDto> {
    const row = await this.prisma.costHead.findUnique({ where: { projectId_code: { projectId, code } } });
    if (!row) throw new NotFoundException('Cost head not found in this project');
    return { code: row.code, name: row.name, definedAt: row.definedAt.toISOString(), definedById: row.definedById };
  }

  private async readAttribution(projectId: string, id: string): Promise<CommitmentAttributionDto> {
    const row = await this.prisma.commitmentAttribution.findFirst({ where: { projectId, id } });
    if (!row) throw new NotFoundException('Attribution not found in this project');
    return serializeAttribution(row);
  }
}

