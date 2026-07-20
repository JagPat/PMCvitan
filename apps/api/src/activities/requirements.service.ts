import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  computeSpecFingerprint, isBaseUom, normalizeSpecText, parseQuantity,
  type RequirementDto, type RequirementEventPayload, type RequirementListItem, type RequirementSpecRef, ROLE_POLICY,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { ProcurementParticipant } from '../procurement/procurement.participant';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../platform/capabilities.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { lockProjectReadiness } from '../common/readiness-lock';
import { fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type { CreateRequirementInput, ReviseRequirementInput, CancelRequirementInput } from '../contracts';
import { randomUUID } from 'node:crypto';

/**
 * Phase 3 Task 1 (correction) — the ActivityRequirement demand contract (plan §§B/D/F/G;
 * review findings 1–4).
 *
 * ROOT + IMMUTABLE REVISIONS (finding 2): a requirement is a project-contained
 * `ActivityRequirementRoot`; every revision row carries a composite FK to
 * `(projectId, rootId)`, so lineage crossing projects is unrepresentable, and a database
 * BEFORE UPDATE OR DELETE trigger makes revision rows (and their material specs) append-only —
 * `revise`/`cancel` INSERT `revision + 1` under a CAS on the caller's `expectedRevision`, with
 * the ROOT row locked FOR UPDATE so two concurrent revisions serialize and the loser conflicts.
 * Downstream phases FK onto the unique `(projectId, requirementId, revision)` triple.
 *
 * TYPE-NEUTRAL CONTRACT (finding 3): the revision row carries only the §11 common fields
 * (quantity + unit + civil-DATE needed-by + parties + criticality/tolerance/status); the
 * material-only specification lives in the revision-owned `MaterialRequirementSpec`. A future
 * labour/equipment type is a revision row with no material spec — no fake material values.
 *
 * AUTHORITATIVE PROVENANCE (finding 1; round-2 finding 2): a material spec referencing a
 * decision pins the SERVER-resolved `decisions.approvedRef` — the head row of the decision's
 * IMMUTABLE `DecisionApprovalRevision` register, resolved inside the command transaction
 * through the decisions query contract. Pending/draft/reopened decisions refuse; approved
 * decisions with no register row (unrepaired ambiguous legacy) refuse; caller-authored
 * version/option inputs do not exist (the request schema is strict). Provenance is all-or-none
 * (database CHECK) and the triple FKs onto the register itself, so a forged reference is
 * unrepresentable.
 *
 * CAPABILITY GATE (§D) and LOCK PROTOCOL (§A) as shipped in Task 1: every entry point asserts
 * the `materials` capability first (404 on non-pilot projects) and every command takes
 * `lockProjectReadiness` inside its transaction.
 */

type SpecRow = Prisma.MaterialRequirementSpecGetPayload<Record<string, never>>;
type Row = Prisma.ActivityRequirementGetPayload<{ include: { materialSpec: true } }>;

/** Round-2 finding 4: the unit of measure lives ONCE, on the revision row — the served spec
 *  reference carries the revision's unit, so the two can never disagree. */
function serializeSpec(s: SpecRow | null, revisionBaseUom: string): RequirementSpecRef | null {
  if (!s) return null;
  return {
    materialCategory: s.materialCategory,
    make: s.make,
    grade: s.grade,
    normalizedAttributes: s.normalizedAttributes,
    baseUom: revisionBaseUom,
    specFingerprint: s.specFingerprint,
    decisionId: s.decisionId,
    decisionVersion: s.decisionVersion,
    optionKey: s.optionKey,
  };
}

function serializeRequirement(r: Row): RequirementDto {
  return {
    id: r.id,
    requirementId: r.requirementId,
    revision: r.revision,
    activityId: r.activityId,
    type: r.type,
    spec: serializeSpec(r.materialSpec, r.baseUom),
    qty: r.requiredQty.toString(),
    baseUom: r.baseUom,
    requiredBy: toIsoCivilDate(r.requiredBy) ?? '',
    responsibleId: r.responsibleId,
    criticality: r.criticality,
    tolerance: r.tolerance ? r.tolerance.toString() : null,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    createdById: r.createdById,
  };
}

/** The complete documented event payload (review finding 4): identity, revision, activity,
 *  the FULL spec reference, quantity, unit and the civil needed-by date. */
function eventPayload(r: Row, reason?: string): RequirementEventPayload {
  return {
    requirementId: r.requirementId,
    revision: r.revision,
    activityId: r.activityId,
    specRef: serializeSpec(r.materialSpec, r.baseUom),
    qty: r.requiredQty.toString(),
    baseUom: r.baseUom,
    requiredBy: toIsoCivilDate(r.requiredBy) ?? '',
    status: r.status,
    ...(reason ? { reason } : {}),
  };
}

@Injectable()
export class RequirementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly decisionsQuery: DecisionsQueryService,
    // Phase 3 Task 2 — the §F disposition guard: cancel refuses while open requisition lines
    // reference this requirement (the procurement-owned participant runs inside our tx)
    private readonly procurementParticipant: ProcurementParticipant,
    // the single external-effect sender (PR C Task 2) — snapshot invalidations ride it post-commit
    private readonly dispatcher: ExternalEffectDispatcher,
  ) {}

  /** Validate + normalize the TYPE-NEUTRAL revision columns (§11 common contract). Pure input
   *  normalization only — the accountable-party check is transactional state and runs INSIDE
   *  the readiness-locked command transaction (`assertResponsibleActive`, round-2 finding 5). */
  private neutralColumns(input: CreateRequirementInput) {
    if (!isBaseUom(input.baseUom)) throw new BadRequestException('baseUom must be one of the supported base units');
    const qty = parseQuantity(input.qty);
    if (!qty) throw new BadRequestException('qty must be a positive decimal with at most 6 fractional digits');
    const tolerance = input.tolerance == null ? null : parseQuantity(input.tolerance);
    if (input.tolerance != null && !tolerance) throw new BadRequestException('tolerance must be a positive decimal with at most 6 fractional digits');
    const requiredBy = fromIsoCivilDate(input.requiredBy);
    if (!requiredBy) throw new BadRequestException('requiredBy must be an ISO civil date');
    return {
      requiredQty: new Prisma.Decimal(qty),
      baseUom: input.baseUom,
      requiredBy,
      responsibleId: input.responsibleId ?? null,
      criticality: input.criticality,
      tolerance: tolerance ? new Prisma.Decimal(tolerance) : null,
    };
  }

  /** Round-2 finding 5: the accountable party must be an ACTIVE same-project membership in an
   *  eligible role (§H matrix), validated INSIDE the readiness-locked command transaction with
   *  the membership row locked FOR UPDATE — a concurrent removal serializes against this
   *  command: removal-then-create REFUSES; create-then-removal commits first and the removed
   *  membership row (removals are status flips, never row deletes — and the composite FK
   *  blocks a hard delete) keeps the requirement historically attributable. */
  private async assertResponsibleActive(tx: Prisma.TransactionClient, projectId: string, responsibleId: string | null) {
    if (!responsibleId) return;
    const rows = await tx.$queryRaw<Array<{ status: string; role: string }>>`
      SELECT "status", "role" FROM "Membership"
      WHERE "projectId" = ${projectId} AND "userId" = ${responsibleId} FOR UPDATE`;
    const m = rows[0];
    if (!m || m.status !== 'active' || !(ROLE_POLICY['requirement.read'] as readonly string[]).includes(m.role)) {
      throw new BadRequestException('responsibleId must be an active pmc/engineer member of this project');
    }
  }

  /** Build the material spec columns: fingerprinted technical identity + AUTHORITATIVE
   *  server-resolved decision provenance (never caller-authored — finding 1). */
  private async specColumns(projectId: string, input: CreateRequirementInput, tx: Prisma.TransactionClient) {
    const identity = {
      materialCategory: normalizeSpecText(input.materialCategory),
      make: normalizeSpecText(input.make),
      grade: normalizeSpecText(input.grade),
      normalizedAttributes: normalizeSpecText(input.attributes ?? ''),
      baseUom: input.baseUom,
    };
    const specFingerprint = await computeSpecFingerprint(identity);
    const provenance = input.decisionId
      ? await this.decisionsQuery.approvedRef(projectId, input.decisionId, tx)
      : { decisionId: null, decisionVersion: null, optionKey: null };
    // the unit stays part of the fingerprinted §B identity but is stored ONCE, on the revision
    // row — the spec record has no baseUom column to disagree with (round-2 finding 4)
    const { baseUom: _uomOnRevisionRow, ...columns } = identity;
    return { ...columns, specFingerprint, ...provenance };
  }

  /** Lock the requirement ROOT (the revision-lineage serialization point) and return the head. */
  private async lockRootHead(tx: Prisma.TransactionClient, projectId: string, requirementId: string): Promise<Row> {
    const roots = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ActivityRequirementRoot"
      WHERE "projectId" = ${projectId} AND "id" = ${requirementId} FOR UPDATE`;
    if (!roots[0]) throw new NotFoundException('Requirement not found');
    return tx.activityRequirement.findFirstOrThrow({
      where: { projectId, requirementId },
      orderBy: { revision: 'desc' },
      include: { materialSpec: true },
    });
  }

  async create(projectId: string, input: CreateRequirementInput, user: AuthUser, idempotencyKey?: string): Promise<RequirementDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest(input);
    const activity = await this.prisma.activity.findFirst({ where: { id: input.activityId, projectId }, select: { id: true } });
    if (!activity) throw new BadRequestException('activityId does not belong to this project');
    const neutral = this.neutralColumns(input);
    const requirementId = randomUUID();
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'requirements.create', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        // the accountable party and the provenance both resolve INSIDE the locked transaction —
        // the membership and the approval this row pins are transactionally real (finding 5)
        await this.assertResponsibleActive(tx, projectId, neutral.responsibleId);
        const spec = await this.specColumns(projectId, input, tx);
        await tx.activityRequirementRoot.create({ data: { id: requirementId, projectId, createdById: actor.actorId } });
        const created = await tx.activityRequirement.create({
          data: { projectId, requirementId, revision: 1, activityId: input.activityId, type: 'material', createdById: actor.actorId, ...neutral },
        });
        await tx.materialRequirementSpec.create({ data: { projectId, requirementId, revision: 1, ...spec } });
        await recordAudit(tx, { projectId, actor, action: 'requirement.create', entity: 'ActivityRequirement', entityId: requirementId });
        const full = await tx.activityRequirement.findUniqueOrThrow({ where: { id: created.id }, include: { materialSpec: true } });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requirement.created', entityType: 'ActivityRequirement', entityId: requirementId,
          payload: eventPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'requirement.created', dispatch: {},
        });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.activityRequirement.findFirstOrThrow({ where: { projectId, id: outcome.resultRef }, include: { materialSpec: true } });
    return serializeRequirement(row);
  }

  async revise(projectId: string, requirementId: string, input: ReviseRequirementInput, user: AuthUser, idempotencyKey?: string): Promise<RequirementDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ requirementId, ...input });
    const activity = await this.prisma.activity.findFirst({ where: { id: input.activityId, projectId }, select: { id: true } });
    if (!activity) throw new BadRequestException('activityId does not belong to this project');
    const neutral = this.neutralColumns(input);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'requirements.revise', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const head = await this.lockRootHead(tx, projectId, requirementId);
        // CAS — two concurrent revisions serialize on the root lock; the loser conflicts
        if (head.revision !== input.expectedRevision) throw new ConflictException(`Requirement is at revision ${head.revision}, not ${input.expectedRevision}`);
        if (head.status === 'cancelled') throw new BadRequestException('A cancelled requirement cannot be revised');
        await this.assertResponsibleActive(tx, projectId, neutral.responsibleId);
        const spec = await this.specColumns(projectId, input, tx);
        const created = await tx.activityRequirement.create({
          data: { projectId, requirementId, revision: head.revision + 1, activityId: input.activityId, type: 'material', createdById: actor.actorId, ...neutral },
        });
        await tx.materialRequirementSpec.create({ data: { projectId, requirementId, revision: head.revision + 1, ...spec } });
        await recordAudit(tx, { projectId, actor, action: 'requirement.revise', entity: 'ActivityRequirement', entityId: requirementId });
        const full = await tx.activityRequirement.findUniqueOrThrow({ where: { id: created.id }, include: { materialSpec: true } });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requirement.revised', entityType: 'ActivityRequirement', entityId: requirementId,
          payload: eventPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'requirement.revised', dispatch: {},
        });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.activityRequirement.findFirstOrThrow({ where: { projectId, id: outcome.resultRef }, include: { materialSpec: true } });
    return serializeRequirement(row);
  }

  async cancel(projectId: string, requirementId: string, input: CancelRequirementInput, user: AuthUser, idempotencyKey?: string): Promise<RequirementDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ requirementId, ...input });
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'requirements.cancel', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const head = await this.lockRootHead(tx, projectId, requirementId);
        if (head.revision !== input.expectedRevision) throw new ConflictException(`Requirement is at revision ${head.revision}, not ${input.expectedRevision}`);
        if (head.status === 'cancelled') throw new BadRequestException('Requirement is already cancelled');
        // §F disposition (Task 2): open downstream requisition lines block the cancel — the
        // readiness lock we hold serializes this check against concurrent line creation
        await this.procurementParticipant.assertRequirementDisposable(tx, projectId, requirementId);
        // a cancel APPENDS a revision copying the head's neutral columns + material spec verbatim
        const created = await tx.activityRequirement.create({
          data: {
            projectId, requirementId, revision: head.revision + 1, activityId: head.activityId, type: head.type,
            requiredQty: head.requiredQty, baseUom: head.baseUom, requiredBy: head.requiredBy,
            responsibleId: head.responsibleId, criticality: head.criticality, tolerance: head.tolerance,
            status: 'cancelled', createdById: actor.actorId,
          },
        });
        if (head.materialSpec) {
          const s = head.materialSpec;
          await tx.materialRequirementSpec.create({
            data: {
              projectId, requirementId, revision: head.revision + 1,
              materialCategory: s.materialCategory, make: s.make, grade: s.grade,
              normalizedAttributes: s.normalizedAttributes, specFingerprint: s.specFingerprint,
              decisionId: s.decisionId, decisionVersion: s.decisionVersion, optionKey: s.optionKey,
            },
          });
        }
        await recordAudit(tx, { projectId, actor, action: 'requirement.cancel', entity: 'ActivityRequirement', entityId: requirementId });
        const full = await tx.activityRequirement.findUniqueOrThrow({ where: { id: created.id }, include: { materialSpec: true } });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requirement.cancelled', entityType: 'ActivityRequirement', entityId: requirementId,
          payload: eventPayload(full, input.reason) as unknown as Prisma.InputJsonValue,
          effectKey: 'requirement.cancelled', dispatch: {},
        });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.activityRequirement.findFirstOrThrow({ where: { projectId, id: outcome.resultRef }, include: { materialSpec: true } });
    return serializeRequirement(row);
  }

  /**
   * The module-owned read: every requirement's CURRENT head revision (+ revision count).
   * EXPLICIT READ POLICY (review finding 4, §H): the full register is a pmc/engineer surface —
   * enforced at the route (`@RolesFor('requirement.read')`) AND here, so a service-level caller
   * cannot bypass it. Client-facing readiness summaries are a separate later-task surface.
   */
  async list(projectId: string, user: AuthUser): Promise<{ requirements: RequirementListItem[] }> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    if (!(ROLE_POLICY['requirement.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The requirement register is a pmc/engineer surface');
    }
    const rows = await this.prisma.activityRequirement.findMany({
      where: { projectId },
      orderBy: [{ requirementId: 'asc' }, { revision: 'asc' }],
      include: { materialSpec: true },
    });
    const byId = new Map<string, { head: Row; revisions: number }>();
    for (const r of rows) {
      const cur = byId.get(r.requirementId);
      if (!cur || r.revision > cur.head.revision) byId.set(r.requirementId, { head: r, revisions: (cur?.revisions ?? 0) + 1 });
      else cur.revisions += 1;
    }
    return { requirements: [...byId.values()].map(({ head, revisions }) => ({ ...serializeRequirement(head), revisions })) };
  }
}
