import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  computeSpecFingerprint, isBaseUom, normalizeSpecText, parseQuantity,
  computeLabourSpecFingerprint,
  type RequirementDto, type RequirementEventPayload, type RequirementListItem, type RequirementSpecRef, type LabourSpecRef, ROLE_POLICY,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { ProcurementParticipant } from '../procurement/procurement.participant';
import { LabourRequirementParticipant } from '../labour/labour.participant';
import { LabourRequirementQuery, labourDetailKey } from '../labour/labour.query';
import { CapabilitiesService, MATERIALS_CAPABILITY, LABOUR_CAPABILITY } from '../platform/capabilities.service';
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
 * Phase 3 Task 1 (correction) / Phase 4 Task 1 — the TYPE-ROUTED ActivityRequirement demand
 * contract (plan §§B/D/F/G).
 *
 * ROOT + IMMUTABLE REVISIONS (finding 2): a requirement is a project-contained
 * `ActivityRequirementRoot`; every revision row carries a composite FK to
 * `(projectId, rootId)`, so lineage crossing projects is unrepresentable, and a database
 * BEFORE UPDATE OR DELETE trigger makes revision rows (and their material/labour specs)
 * append-only — `revise`/`cancel` INSERT `revision + 1` under a CAS on the caller's
 * `expectedRevision`, with the ROOT row locked FOR UPDATE so two concurrent revisions
 * serialize and the loser conflicts. Downstream phases FK onto the unique
 * `(projectId, requirementId, revision)` triple.
 *
 * TYPE ROUTING (Phase 4 Task 1, plan §B): the revision row carries only the §11 common fields
 * (quantity + unit + civil-DATE needed-by + parties + criticality/tolerance/status); the
 * type-specific detail hangs off the same `(projectId, requirementId, revision)` triple. A
 * `type='material'` revision asserts the `materials` capability and writes the material detail
 * inline; a `type='labour'` revision asserts the `labour` capability and writes the Labour-owned
 * `LabourRequirementSpec` + its explicit `(civilDate, personShiftQty)` demand slices THROUGH the
 * cycle-exempt `LabourRequirementParticipant` (Activities → Labour is a workflow-participant
 * edge). The root `type` is IMMUTABLE (a DB trigger rejects a revision that changes it), and the
 * DB type↔detail correspondence trigger enforces exactly-one-detail-per-revision at commit.
 *
 * AUTHORITATIVE PROVENANCE (finding 1; round-2 finding 2): a spec referencing a decision pins
 * the SERVER-resolved `decisions.approvedRef` — the head row of the decision's IMMUTABLE
 * `DecisionApprovalRevision` register, resolved inside the command transaction through the
 * decisions query contract (Activities depends on decisions; Labour does NOT — the resolved
 * provenance is passed into the labour participant). Provenance is all-or-none (database CHECK)
 * and the triple FKs onto the register itself, so a forged reference is unrepresentable.
 *
 * CAPABILITY GATE (§D) and LOCK PROTOCOL (§A): every entry point asserts the type's capability
 * first (404 on non-pilot projects) and every command takes `lockProjectReadiness` in its tx.
 */

const LABOUR_BASE_UOM = 'person-shift';

// F1 (read encapsulation): the requirement row includes only its OWN material spec. The Labour-owned
// detail (LabourRequirementSpec + LabourDemandSlice) is NEVER hydrated through a Prisma relation
// include here — it is fetched through the Labour read contract (`LabourRequirementQuery`).
const REQUIREMENT_INCLUDE = { materialSpec: true } as const;

type SpecRow = Prisma.MaterialRequirementSpecGetPayload<Record<string, never>>;
type Row = Prisma.ActivityRequirementGetPayload<{ include: typeof REQUIREMENT_INCLUDE }>;

// A requirement command input (create or revise) — a discriminated union over `type`.
type RequirementInput = CreateRequirementInput | ReviseRequirementInput;
type MaterialInput = Extract<RequirementInput, { type: 'material' }>;
type LabourInput = Extract<RequirementInput, { type: 'labour' }>;

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

function serializeRequirement(r: Row, labourSpec: LabourSpecRef | null): RequirementDto {
  return {
    id: r.id,
    requirementId: r.requirementId,
    revision: r.revision,
    activityId: r.activityId,
    type: r.type,
    spec: serializeSpec(r.materialSpec, r.baseUom),
    labourSpec,
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

/** The complete documented event payload (review finding 4; round-2 finding 5 — a discriminated
 *  `type` + the type detail): identity, revision, activity, the FULL spec reference (material OR
 *  labour), quantity, unit and the civil needed-by date. */
function eventPayload(r: Row, labourSpec: LabourSpecRef | null, reason?: string): RequirementEventPayload {
  return {
    requirementId: r.requirementId,
    revision: r.revision,
    activityId: r.activityId,
    type: r.type,
    specRef: serializeSpec(r.materialSpec, r.baseUom),
    labourSpecRef: labourSpec,
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
    // Phase 4 Task 1 — the labour detail is written through the Labour-owned participant (the
    // cycle-exempt activities → labour edge); Labour never reads Activities persistence.
    private readonly labourParticipant: LabourRequirementParticipant,
    // F1 — the Labour READ contract: the labour detail is hydrated through this query (never a
    // Prisma relation include on the requirement), keeping LabourRequirementSpec/LabourDemandSlice
    // read-encapsulated. Callable in the command tx (serialize what was just written) or standalone.
    private readonly labourQuery: LabourRequirementQuery,
    // the single external-effect sender (PR C Task 2) — snapshot invalidations ride it post-commit
    private readonly dispatcher: ExternalEffectDispatcher,
  ) {}

  /** Type-based capability routing (§D/F3): a material requirement requires `materials`; a labour
   *  requirement requires `labour`. The command asserts the capability matching the row's type. */
  private capabilityForType(type: string): string {
    return type === 'labour' ? LABOUR_CAPABILITY : MATERIALS_CAPABILITY;
  }

  /** Validate + normalize the TYPE-NEUTRAL revision columns (§11 common contract). Pure input
   *  normalization only — the accountable-party check is transactional state and runs INSIDE
   *  the readiness-locked command transaction (`assertResponsibleActive`, round-2 finding 5).
   *  For a LABOUR requirement the neutral quantity/unit/needed-by are DERIVED from the explicit
   *  demand slices (baseUom='person-shift', qty=Σ personShiftQty, requiredBy=max civilDate). */
  private neutralColumns(input: RequirementInput) {
    const responsibleId = input.responsibleId ?? null;
    const criticality = input.criticality;
    const tolerance = input.tolerance == null ? null : parseQuantity(input.tolerance);
    if (input.tolerance != null && !tolerance) throw new BadRequestException('tolerance must be a positive decimal with at most 6 fractional digits');
    const toleranceDec = tolerance ? new Prisma.Decimal(tolerance) : null;
    if (input.type === 'labour') {
      const slices = this.parseLabourSlices(input);
      const total = slices.reduce((sum, s) => sum + s.personShiftQty, 0);
      const requiredBy = slices.reduce((max, s) => (s.civilDate > max ? s.civilDate : max), slices[0].civilDate);
      return { requiredQty: new Prisma.Decimal(total), baseUom: LABOUR_BASE_UOM, requiredBy, responsibleId, criticality, tolerance: toleranceDec };
    }
    if (!isBaseUom(input.baseUom)) throw new BadRequestException('baseUom must be one of the supported base units');
    const qty = parseQuantity(input.qty);
    if (!qty) throw new BadRequestException('qty must be a positive decimal with at most 6 fractional digits');
    const requiredBy = fromIsoCivilDate(input.requiredBy);
    if (!requiredBy) throw new BadRequestException('requiredBy must be an ISO civil date');
    return { requiredQty: new Prisma.Decimal(qty), baseUom: input.baseUom, requiredBy, responsibleId, criticality, tolerance: toleranceDec };
  }

  /** Parse + validate a labour requirement's explicit demand slices: real civil dates, no
   *  duplicate `(civilDate)` (the shift is the spec's, one per requirement — the DB partial
   *  unique is the backstop). */
  private parseLabourSlices(input: LabourInput): Array<{ civilDate: Date; personShiftQty: number }> {
    const seen = new Set<string>();
    return input.demandSlices.map((s) => {
      const civilDate = fromIsoCivilDate(s.civilDate);
      if (!civilDate) throw new BadRequestException(`demand slice civilDate "${s.civilDate}" is not an ISO civil date`);
      if (seen.has(s.civilDate)) throw new BadRequestException(`duplicate demand slice for ${s.civilDate} (one slice per date; the shift is the spec's)`);
      seen.add(s.civilDate);
      return { civilDate, personShiftQty: s.personShiftQty };
    });
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
  private async specColumns(projectId: string, input: MaterialInput, tx: Prisma.TransactionClient) {
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

  /** Write ONE requirement revision's type detail (create/revise). Material writes the spec row
   *  inline; labour computes the `labourSpecFingerprint`, resolves the SAME server decision
   *  provenance, and writes the Labour-owned spec + demand slices through the participant. The
   *  DB type↔detail trigger enforces exactly-one-detail-per-revision at commit. */
  private async writeDetail(tx: Prisma.TransactionClient, projectId: string, requirementId: string, revision: number, input: RequirementInput) {
    if (input.type === 'labour') {
      const provenance = input.decisionId
        ? await this.decisionsQuery.approvedRef(projectId, input.decisionId, tx)
        : { decisionId: null, decisionVersion: null, optionKey: null };
      const labourSpecFingerprint = await computeLabourSpecFingerprint({
        tradeCode: input.tradeCode, skillCode: input.skillCode ?? null, shift: input.shift,
      });
      await this.labourParticipant.writeRequirementSpec(tx, {
        projectId, requirementId, revision,
        tradeCode: input.tradeCode, skillCode: input.skillCode ?? null, shift: input.shift,
        labourSpecFingerprint, ...provenance,
        slices: this.parseLabourSlices(input),
      });
      return;
    }
    const spec = await this.specColumns(projectId, input, tx);
    await tx.materialRequirementSpec.create({ data: { projectId, requirementId, revision, ...spec } });
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
      include: REQUIREMENT_INCLUDE,
    });
  }

  /** Hydrate ONE requirement revision's Labour-owned detail through the read contract (F1). Pass
   *  `tx` to read inside the command transaction (serialize what was just written); omit it for a
   *  post-commit read. Returns null for a material requirement (no labour detail). */
  private async labourRefFor(projectId: string, r: Row, tx?: Prisma.TransactionClient): Promise<LabourSpecRef | null> {
    if (r.type !== 'labour') return null;
    const map = await this.labourQuery.detailsFor(projectId, [{ requirementId: r.requirementId, revision: r.revision }], tx);
    return map.get(labourDetailKey(r.requirementId, r.revision)) ?? null;
  }

  async create(projectId: string, input: CreateRequirementInput, user: AuthUser, idempotencyKey?: string): Promise<RequirementDto> {
    await this.capabilities.assertEnabled(projectId, this.capabilityForType(input.type));
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
        await tx.activityRequirementRoot.create({ data: { id: requirementId, projectId, createdById: actor.actorId } });
        const created = await tx.activityRequirement.create({
          data: { projectId, requirementId, revision: 1, activityId: input.activityId, type: input.type, createdById: actor.actorId, ...neutral },
        });
        await this.writeDetail(tx, projectId, requirementId, 1, input);
        await recordAudit(tx, { projectId, actor, action: 'requirement.create', entity: 'ActivityRequirement', entityId: requirementId });
        const full = await tx.activityRequirement.findUniqueOrThrow({ where: { id: created.id }, include: REQUIREMENT_INCLUDE });
        const labourRef = await this.labourRefFor(projectId, full, tx);
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requirement.created', entityType: 'ActivityRequirement', entityId: requirementId,
          payload: eventPayload(full, labourRef) as unknown as Prisma.InputJsonValue,
          effectKey: 'requirement.created', dispatch: {},
        });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.activityRequirement.findFirstOrThrow({ where: { projectId, id: outcome.resultRef }, include: REQUIREMENT_INCLUDE });
    return serializeRequirement(row, await this.labourRefFor(projectId, row));
  }

  async revise(projectId: string, requirementId: string, input: ReviseRequirementInput, user: AuthUser, idempotencyKey?: string): Promise<RequirementDto> {
    await this.capabilities.assertEnabled(projectId, this.capabilityForType(input.type));
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
        // the root type is immutable (a DB trigger is the backstop) — refuse an explicit type
        // change early. A caller that omits `type` inherits the head's type (the new revision is
        // always written as head.type).
        if (input.type && head.type !== input.type) throw new BadRequestException(`Requirement is type '${head.type}' — its type cannot change on revision`);
        await this.assertResponsibleActive(tx, projectId, neutral.responsibleId);
        const created = await tx.activityRequirement.create({
          data: { projectId, requirementId, revision: head.revision + 1, activityId: input.activityId, type: head.type, createdById: actor.actorId, ...neutral },
        });
        await this.writeDetail(tx, projectId, requirementId, head.revision + 1, input);
        await recordAudit(tx, { projectId, actor, action: 'requirement.revise', entity: 'ActivityRequirement', entityId: requirementId });
        const full = await tx.activityRequirement.findUniqueOrThrow({ where: { id: created.id }, include: REQUIREMENT_INCLUDE });
        const labourRef = await this.labourRefFor(projectId, full, tx);
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requirement.revised', entityType: 'ActivityRequirement', entityId: requirementId,
          payload: eventPayload(full, labourRef) as unknown as Prisma.InputJsonValue,
          effectKey: 'requirement.revised', dispatch: {},
        });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.activityRequirement.findFirstOrThrow({ where: { projectId, id: outcome.resultRef }, include: REQUIREMENT_INCLUDE });
    return serializeRequirement(row, await this.labourRefFor(projectId, row));
  }

  async cancel(projectId: string, requirementId: string, input: CancelRequirementInput, user: AuthUser, idempotencyKey?: string): Promise<RequirementDto> {
    // resolve the capability from the requirement's OWN type (the caller does not restate it)
    const root = await this.prisma.activityRequirement.findFirst({ where: { projectId, requirementId }, select: { type: true } });
    if (!root) throw new NotFoundException('Requirement not found');
    await this.capabilities.assertEnabled(projectId, this.capabilityForType(root.type));
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
        // a cancel APPENDS a revision copying the head's neutral columns + the type detail verbatim
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
        // Phase 4 Task 1 — copy the labour detail (spec + slices) onto the cancellation revision
        // so the type↔detail correspondence holds; a no-op for a material requirement.
        await this.labourParticipant.copyRequirementSpecForCancel(tx, projectId, requirementId, head.revision, head.revision + 1);
        await recordAudit(tx, { projectId, actor, action: 'requirement.cancel', entity: 'ActivityRequirement', entityId: requirementId });
        const full = await tx.activityRequirement.findUniqueOrThrow({ where: { id: created.id }, include: REQUIREMENT_INCLUDE });
        const labourRef = await this.labourRefFor(projectId, full, tx);
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'requirement.cancelled', entityType: 'ActivityRequirement', entityId: requirementId,
          payload: eventPayload(full, labourRef, input.reason) as unknown as Prisma.InputJsonValue,
          effectKey: 'requirement.cancelled', dispatch: {},
        });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.activityRequirement.findFirstOrThrow({ where: { projectId, id: outcome.resultRef }, include: REQUIREMENT_INCLUDE });
    return serializeRequirement(row, await this.labourRefFor(projectId, row));
  }

  /**
   * The module-owned read: every requirement's CURRENT head revision (+ revision count).
   * EXPLICIT READ POLICY (review finding 4, §H): the full register is a pmc/engineer surface —
   * enforced at the route (`@RolesFor('requirement.read')`) AND here, so a service-level caller
   * cannot bypass it. Client-facing readiness summaries are a separate later-task surface.
   *
   * The register spans BOTH capabilities (material + labour requirements). It is available when
   * EITHER `materials` OR `labour` is enabled (F4 — a labour-only pilot must be able to read its
   * own requirements); it 404s only when NEITHER is enabled. Each row's labour detail is hydrated
   * through the Labour read contract (F1), never a Prisma relation include.
   */
  async list(projectId: string, user: AuthUser): Promise<{ requirements: RequirementListItem[] }> {
    // materials OR labour enables the register; if materials is off, fall through to labour, whose
    // assertEnabled raises the canonical 404 when NEITHER capability is on.
    if (!(await this.capabilities.isEnabled(projectId, MATERIALS_CAPABILITY))) {
      await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    }
    if (!(ROLE_POLICY['requirement.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The requirement register is a pmc/engineer surface');
    }
    const rows = await this.prisma.activityRequirement.findMany({
      where: { projectId },
      orderBy: [{ requirementId: 'asc' }, { revision: 'asc' }],
      include: REQUIREMENT_INCLUDE,
    });
    const byId = new Map<string, { head: Row; revisions: number }>();
    for (const r of rows) {
      const cur = byId.get(r.requirementId);
      if (!cur || r.revision > cur.head.revision) byId.set(r.requirementId, { head: r, revisions: (cur?.revisions ?? 0) + 1 });
      else cur.revisions += 1;
    }
    const heads = [...byId.values()];
    const labourRefs = await this.labourQuery.detailsFor(
      projectId,
      heads.filter((h) => h.head.type === 'labour').map((h) => ({ requirementId: h.head.requirementId, revision: h.head.revision })),
    );
    return {
      requirements: heads.map(({ head, revisions }) => ({
        ...serializeRequirement(head, labourRefs.get(labourDetailKey(head.requirementId, head.revision)) ?? null),
        revisions,
      })),
    };
  }
}
