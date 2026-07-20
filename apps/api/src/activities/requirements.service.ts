import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { computeSpecFingerprint, isBaseUom, normalizeSpecText, parseQuantity } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../platform/capabilities.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { lockProjectReadiness } from '../common/readiness-lock';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type { CreateRequirementInput, ReviseRequirementInput, CancelRequirementInput } from '../contracts';
import { randomUUID } from 'node:crypto';

/**
 * Phase 3 Task 1 — the ActivityRequirement demand contract (plan §§B/D/F/G).
 *
 * APPEND-ONLY REVISIONS: a requirement is never updated — `revise`/`cancel` INSERT a new row
 * with the same `requirementId` and `revision + 1` under a CAS on the caller's
 * `expectedRevision`, with the current head row locked FOR UPDATE so two concurrent revisions
 * serialize and the loser conflicts. The current state of a requirement is its highest
 * revision; every prior revision is retained byte-identical (Task-1 immutability probes).
 *
 * IDENTITY vs PROVENANCE (§B): the stored `specFingerprint` hashes ONLY the normalized
 * technical identity through the ONE shared `computeSpecFingerprint`; the decision reference
 * (validated through the decisions module's query contract — never a direct foreign read) is
 * carried as un-hashed provenance.
 *
 * CAPABILITY GATE (§D): every entry point asserts the project's `materials` capability FIRST
 * and refuses with 404 — to a non-pilot project this module surface does not exist, no event
 * is emitted, and behavior is byte-identical to a pre-Phase-3 deployment.
 *
 * LOCK PROTOCOL (§A): requirement create/revise/cancel are coverage-affecting writes, so each
 * takes `lockProjectReadiness` inside its command transaction — the same per-project advisory
 * lock every readiness-affecting write has taken since Phase 1.
 */

export interface RequirementDto {
  id: string;
  requirementId: string;
  revision: number;
  activityId: string;
  type: string;
  materialCategory: string;
  make: string;
  grade: string;
  normalizedAttributes: string;
  baseUom: string;
  specFingerprint: string;
  decisionId: string | null;
  decisionVersion: number | null;
  optionKey: string | null;
  qty: string;
  requiredBy: string;
  responsibleId: string | null;
  criticality: string;
  tolerance: string | null;
  status: string;
  createdAt: string;
  createdById: string;
}

type Row = Prisma.ActivityRequirementGetPayload<Record<string, never>>;

function serializeRequirement(r: Row): RequirementDto {
  return {
    id: r.id,
    requirementId: r.requirementId,
    revision: r.revision,
    activityId: r.activityId,
    type: r.type,
    materialCategory: r.materialCategory,
    make: r.make,
    grade: r.grade,
    normalizedAttributes: r.normalizedAttributes,
    baseUom: r.baseUom,
    specFingerprint: r.specFingerprint,
    decisionId: r.decisionId,
    decisionVersion: r.decisionVersion,
    optionKey: r.optionKey,
    qty: r.requiredQty.toString(),
    requiredBy: r.requiredBy.toISOString().slice(0, 10),
    responsibleId: r.responsibleId,
    criticality: r.criticality,
    tolerance: r.tolerance ? r.tolerance.toString() : null,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    createdById: r.createdById,
  };
}

@Injectable()
export class RequirementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly decisionsQuery: DecisionsQueryService,
    // the single external-effect sender (PR C Task 2) — snapshot invalidations ride it post-commit
    private readonly dispatcher: ExternalEffectDispatcher,
  ) {}

  /** Validate + normalize the spec/quantity inputs into the columns a revision row stores. */
  private async specColumns(projectId: string, input: CreateRequirementInput) {
    if (!isBaseUom(input.baseUom)) throw new BadRequestException(`baseUom must be one of the supported base units`);
    const qty = parseQuantity(input.qty);
    if (!qty) throw new BadRequestException('qty must be a positive decimal with at most 6 fractional digits');
    const tolerance = input.tolerance == null ? null : parseQuantity(input.tolerance);
    if (input.tolerance != null && !tolerance) throw new BadRequestException('tolerance must be a positive decimal with at most 6 fractional digits');
    // decision PROVENANCE is validated through the decisions module's query contract (§G edge)
    const decisionId = await this.decisionsQuery.resolveRefInProject(projectId, input.decisionId ?? null);
    const identity = {
      materialCategory: normalizeSpecText(input.materialCategory),
      make: normalizeSpecText(input.make),
      grade: normalizeSpecText(input.grade),
      normalizedAttributes: normalizeSpecText(input.attributes ?? ''),
      baseUom: input.baseUom,
    };
    const specFingerprint = await computeSpecFingerprint(identity);
    return {
      ...identity,
      specFingerprint,
      decisionId,
      decisionVersion: decisionId ? (input.decisionVersion ?? null) : null,
      optionKey: decisionId ? (input.optionKey ?? null) : null,
      requiredQty: new Prisma.Decimal(qty),
      requiredBy: new Date(`${input.requiredBy}T00:00:00.000Z`),
      responsibleId: input.responsibleId ?? null,
      criticality: input.criticality,
      tolerance: tolerance ? new Prisma.Decimal(tolerance) : null,
    };
  }

  /** Lock + read the CURRENT head revision of a requirement inside the command transaction. */
  private async lockHead(tx: Prisma.TransactionClient, projectId: string, requirementId: string): Promise<Row> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ActivityRequirement"
      WHERE "projectId" = ${projectId} AND "requirementId" = ${requirementId}
      ORDER BY "revision" DESC LIMIT 1 FOR UPDATE`;
    if (!rows[0]) throw new NotFoundException('Requirement not found');
    return tx.activityRequirement.findUniqueOrThrow({ where: { id: rows[0].id } });
  }

  async create(projectId: string, input: CreateRequirementInput, user: AuthUser, idempotencyKey?: string): Promise<RequirementDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest(input);
    const activity = await this.prisma.activity.findFirst({ where: { id: input.activityId, projectId }, select: { id: true } });
    if (!activity) throw new BadRequestException('activityId does not belong to this project');
    const cols = await this.specColumns(projectId, input);
    const requirementId = randomUUID();
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'requirements.create', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const created = await tx.activityRequirement.create({
          data: { projectId, requirementId, revision: 1, activityId: input.activityId, type: 'material', createdById: actor.actorId, ...cols },
        });
        await recordAudit(tx, { projectId, actor, action: 'requirement.create', entity: 'ActivityRequirement', entityId: requirementId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requirement.created', entityType: 'ActivityRequirement', entityId: requirementId,
          payload: { requirementId, revision: 1, activityId: input.activityId, specFingerprint: cols.specFingerprint, baseUom: cols.baseUom, qty: cols.requiredQty.toString() },
          effectKey: 'requirement.created', dispatch: {},
        });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.activityRequirement.findFirstOrThrow({ where: { projectId, id: outcome.resultRef } });
    return serializeRequirement(row);
  }

  async revise(projectId: string, requirementId: string, input: ReviseRequirementInput, user: AuthUser, idempotencyKey?: string): Promise<RequirementDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ requirementId, ...input });
    const activity = await this.prisma.activity.findFirst({ where: { id: input.activityId, projectId }, select: { id: true } });
    if (!activity) throw new BadRequestException('activityId does not belong to this project');
    const cols = await this.specColumns(projectId, input);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'requirements.revise', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const head = await this.lockHead(tx, projectId, requirementId);
        // CAS — two concurrent revisions serialize on the head lock; the loser conflicts
        if (head.revision !== input.expectedRevision) throw new ConflictException(`Requirement is at revision ${head.revision}, not ${input.expectedRevision}`);
        if (head.status === 'cancelled') throw new BadRequestException('A cancelled requirement cannot be revised');
        const created = await tx.activityRequirement.create({
          data: { projectId, requirementId, revision: head.revision + 1, activityId: input.activityId, type: 'material', createdById: actor.actorId, ...cols },
        });
        await recordAudit(tx, { projectId, actor, action: 'requirement.revise', entity: 'ActivityRequirement', entityId: requirementId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requirement.revised', entityType: 'ActivityRequirement', entityId: requirementId,
          payload: { requirementId, revision: head.revision + 1, activityId: input.activityId, specFingerprint: cols.specFingerprint, baseUom: cols.baseUom, qty: cols.requiredQty.toString() },
          effectKey: 'requirement.revised', dispatch: {},
        });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.activityRequirement.findFirstOrThrow({ where: { projectId, id: outcome.resultRef } });
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
        const head = await this.lockHead(tx, projectId, requirementId);
        if (head.revision !== input.expectedRevision) throw new ConflictException(`Requirement is at revision ${head.revision}, not ${input.expectedRevision}`);
        if (head.status === 'cancelled') throw new BadRequestException('Requirement is already cancelled');
        // a cancel APPENDS a revision copying the head's specification — nothing is edited
        const created = await tx.activityRequirement.create({
          data: {
            projectId, requirementId, revision: head.revision + 1, activityId: head.activityId, type: head.type,
            materialCategory: head.materialCategory, make: head.make, grade: head.grade,
            normalizedAttributes: head.normalizedAttributes, baseUom: head.baseUom, specFingerprint: head.specFingerprint,
            decisionId: head.decisionId, decisionVersion: head.decisionVersion, optionKey: head.optionKey,
            requiredQty: head.requiredQty, requiredBy: head.requiredBy, responsibleId: head.responsibleId,
            criticality: head.criticality, tolerance: head.tolerance, status: 'cancelled', createdById: actor.actorId,
          },
        });
        await recordAudit(tx, { projectId, actor, action: 'requirement.cancel', entity: 'ActivityRequirement', entityId: requirementId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requirement.cancelled', entityType: 'ActivityRequirement', entityId: requirementId,
          payload: { requirementId, revision: head.revision + 1, activityId: head.activityId, reason: input.reason },
          effectKey: 'requirement.cancelled', dispatch: {},
        });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.activityRequirement.findFirstOrThrow({ where: { projectId, id: outcome.resultRef } });
    return serializeRequirement(row);
  }

  /** The module-owned read: every requirement's CURRENT head revision (+ how many revisions exist). */
  async list(projectId: string, _user: AuthUser): Promise<{ requirements: Array<RequirementDto & { revisions: number }> }> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const rows = await this.prisma.activityRequirement.findMany({ where: { projectId }, orderBy: [{ requirementId: 'asc' }, { revision: 'asc' }] });
    const byId = new Map<string, { head: Row; revisions: number }>();
    for (const r of rows) {
      const cur = byId.get(r.requirementId);
      if (!cur || r.revision > cur.head.revision) byId.set(r.requirementId, { head: r, revisions: (cur?.revisions ?? 0) + 1 });
      else cur.revisions += 1;
    }
    return { requirements: [...byId.values()].map(({ head, revisions }) => ({ ...serializeRequirement(head), revisions })) };
  }
}
