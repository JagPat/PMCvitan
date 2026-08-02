import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ROLE_POLICY,
  type VendorLabourProfileDto,
  type LabourRequisitionDto, type LabourRequisitionLineDto,
  type LabourRfqDto, type SupplierLabourQuoteDto, type SupplierLabourQuoteLineDto, type LabourQuoteComparisonDto,
  type LabourPurchaseOrderDto, type LabourPurchaseOrderVersionDto, type LabourPurchaseOrderLineDto,
  type CapacityCommitmentDto, type CapacityPromiseDto,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../platform/capabilities.service';
import { ProcurementParticipant } from '../procurement/procurement.participant';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { lockProjectReadiness } from '../common/readiness-lock';
import { CLOCK, type Clock } from '../common/clock';
import { fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor, type Actor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type {
  SetVendorLabourProfileInput, CreateLabourRequisitionInput, RejectLabourRequisitionInput,
  CreateLabourRfqInput, RecordLabourQuoteInput, ApproveLabourComparisonInput,
  CreateLabourPoInput, IssueLabourPoInput, AmendLabourPoInput, CancelLabourPoInput, CloseShortLabourPoInput,
  CommitCapacityInput, ReviseCapacityInput,
} from '../contracts';
import { CommercialParticipant } from '../commercial/commercial.participant';

/**
 * Phase 4 Task 2 — the LABOUR COMMERCIAL chain (plan §F). The labour supplier IS the existing
 * procurement-owned `Vendor`/`ProjectVendor` (F7 — no `LabourSupplier`); Phase 4 adds only a
 * labour-specific `VendorLabourProfile` (org-admin authority, like vendor CRUD) and SEPARATE labour
 * commercial documents whose lines carry the SAME explicit per-`(civilDate, shift)` `personShiftQty`
 * demand slices as the requirement — never a bare headcount.
 *
 * LEAF PRESERVATION: the requirement→requisition bound (§F bound 1) reads the Labour-owned
 * `LabourRequirementSpec`/`LabourDemandSlice` (never `ActivityRequirement`); the vendor binding is
 * validated through `ProcurementParticipant.assertVendorBound` (the cycle-exempt
 * `labour → procurement` workflow-participant edge — NOT a Procurement read dependency, and the
 * composite FK on the labour tables is the database backstop). So `labour.dependsOn` stays `[]`.
 *
 * CAS MACHINES (§F): every transition is `updateMany` on `(id, projectId, status)` — one winner,
 * the loser a deterministic 409. ALLOCATION (§F bounds 1–2): a bound is checked on each
 * `(civilDate, shift)` slice under `FOR UPDATE` + the readiness lock, and reported both per slice
 * and in total person-shifts. FROZEN SNAPSHOT: a PO line freezes the rate-per-person-shift from the
 * comparison-approved SELECTED quote; `committedAmountBase = round((rate + premium) × personShiftQty, 2)`
 * (a DB CHECK re-derives it). §F bound 3 (committed/allocated ≤ ordered + overage) and the
 * allocation/attendance/work facts are Task 3 — NOT this service.
 *
 * Only `labour.requisition.submitted|approved`, `labour.comparison.approved`,
 * `labour.po.issued|amended|cancelled|closed_short` and `capacity.committed|revised|defaulted` are
 * domain events (signal-only, `invalidate:true`); every other step is an audited command.
 */

const LIVE_LABOUR_PO_STATUSES = ['draft', 'issued', 'partially_committed', 'completed'] as const;

type ReqLineRow = Prisma.LabourRequisitionLineGetPayload<Record<string, never>>;
type ReqRow = Prisma.LabourRequisitionGetPayload<{ include: { lines: true } }>;
type QuoteLineRow = Prisma.SupplierLabourQuoteLineGetPayload<Record<string, never>>;
type QuoteRow = Prisma.SupplierLabourQuoteGetPayload<{ include: { lines: true } }>;
type ComparisonRow = Prisma.LabourQuoteComparisonGetPayload<Record<string, never>>;
type PoLineRow = Prisma.LabourPurchaseOrderLineGetPayload<Record<string, never>>;
type VersionRow = Prisma.LabourPurchaseOrderVersionGetPayload<{ include: { lines: true } }>;
type PoRow = Prisma.LabourPurchaseOrderGetPayload<{ include: { versions: { include: { lines: true } } } }>;
type PromiseRow = Prisma.CapacityPromiseGetPayload<Record<string, never>>;
type CommitmentRow = Prisma.CapacityCommitmentGetPayload<{ include: { promises: true } }>;
type ProfileRow = Prisma.VendorLabourProfileGetPayload<Record<string, never>>;

function serializeReqLine(l: ReqLineRow): LabourRequisitionLineDto {
  return {
    id: l.id, requirementId: l.requirementId, revision: l.revision,
    civilDate: toIsoCivilDate(l.civilDate) ?? '', shift: l.shift,
    labourSpecFingerprint: l.labourSpecFingerprint, personShiftQty: l.personShiftQty, status: l.status,
  };
}
function serializeRequisition(r: ReqRow): LabourRequisitionDto {
  return {
    id: r.id, title: r.title, notes: r.notes, status: r.status,
    createdAt: r.createdAt.toISOString(), createdById: r.createdById,
    lines: [...r.lines].sort((a, b) => a.id.localeCompare(b.id)).map(serializeReqLine),
  };
}
function serializeQuoteLine(l: QuoteLineRow): SupplierLabourQuoteLineDto {
  return {
    id: l.id, requisitionLineId: l.requisitionLineId,
    ratePerPersonShift: l.ratePerPersonShift.toString(), shiftPremium: l.shiftPremium.toString(),
    landedPerPersonShift: l.landedPerPersonShift.toString(), matchesSpecification: l.matchesSpecification,
  };
}
function serializeQuote(q: QuoteRow): SupplierLabourQuoteDto {
  return {
    id: q.id, vendorId: q.vendorId, status: q.status, validUntil: toIsoCivilDate(q.validUntil) ?? '',
    leadTimeDays: q.leadTimeDays, notes: q.notes,
    recordedAt: q.recordedAt.toISOString(), recordedById: q.recordedById,
    lines: q.lines.map(serializeQuoteLine),
  };
}
function serializeComparison(c: ComparisonRow): LabourQuoteComparisonDto {
  return {
    id: c.id, status: c.status, selectedQuoteId: c.selectedQuoteId, selectedVendorId: c.selectedVendorId,
    reason: c.reason, justification: c.justification,
    approvedById: c.approvedById, approvedAt: c.approvedAt ? c.approvedAt.toISOString() : null,
  };
}
function serializePoLine(l: PoLineRow): LabourPurchaseOrderLineDto {
  return {
    id: l.id, requisitionLineId: l.requisitionLineId, requirementId: l.requirementId, revision: l.revision,
    civilDate: toIsoCivilDate(l.civilDate) ?? '', shift: l.shift, labourSpecFingerprint: l.labourSpecFingerprint,
    personShiftQty: l.personShiftQty, ratePerPersonShift: l.ratePerPersonShift.toString(),
    shiftPremium: l.shiftPremium.toString(), committedAmountBase: l.committedAmountBase.toString(),
    committedQty: l.committedQty,
  };
}
function serializeVersion(v: VersionRow): LabourPurchaseOrderVersionDto {
  return {
    id: v.id, version: v.version, status: v.status, supersedesVersion: v.supersedesVersion,
    lines: [...v.lines].sort((a, b) => a.id.localeCompare(b.id)).map(serializePoLine),
  };
}
function serializePo(po: PoRow): LabourPurchaseOrderDto {
  const versions = [...po.versions].sort((a, b) => a.version - b.version).map(serializeVersion);
  return {
    id: po.id, vendorId: po.vendorId, requisitionId: po.requisitionId, comparisonId: po.comparisonId,
    currentVersion: versions[versions.length - 1]!, versions,
  };
}
function serializePromise(p: PromiseRow): CapacityPromiseDto {
  return {
    seq: p.seq, promisedDate: toIsoCivilDate(p.promisedDate) ?? '', reason: p.reason,
    recordedAt: p.recordedAt.toISOString(), recordedById: p.recordedById,
  };
}
function serializeCommitment(c: CommitmentRow): CapacityCommitmentDto {
  const promises = [...c.promises].sort((a, b) => a.seq - b.seq).map(serializePromise);
  return {
    id: c.id, poLineId: c.poLineId, labourSpecFingerprint: c.labourSpecFingerprint,
    civilDate: toIsoCivilDate(c.civilDate) ?? '', shift: c.shift, personShiftQty: c.personShiftQty,
    status: c.status, latestPromise: promises[promises.length - 1] ?? null, promises,
  };
}
function serializeProfile(p: ProfileRow, vendorName: string): VendorLabourProfileDto {
  return {
    vendorId: p.vendorId, vendorName, trades: p.trades, skills: p.skills,
    createdAt: p.createdAt.toISOString(), createdById: p.createdById,
  };
}

@Injectable()
export class LabourProcurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly procurementParticipant: ProcurementParticipant,
    private readonly dispatcher: ExternalEffectDispatcher,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly commercial: CommercialParticipant,
  ) {}

  /**
   * Phase 5 Task 1 (§C/§0b) — the LABOUR twin of the material lifecycle hooks. §0b's closure row
   * names all four sites for BOTH pipelines, and probe 5aj is RED against an implementation that
   * attributes on issue only: closing a live ₹100 labour order short would otherwise leave the
   * attribution active and `COMMITTED` still reporting ₹100 against an obligation that shrank.
   * Off-pilot every one of these is a no-op.
   */
  private async attributeIssuedLabour(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: Actor,
    user: AuthUser,
    lines: ReadonlyArray<{ id: string }>,
    costHeads: ReadonlyArray<{ labourPoLineId: string; costHeadCode: string }> | undefined,
    reason: string,
  ): Promise<void> {
    if (!(await this.commercial.isActive(tx, projectId))) return;
    const map = new Map((costHeads ?? []).map((c) => [c.labourPoLineId, c.costHeadCode]));
    const unmapped = lines.filter((l) => !map.has(l.id)).map((l) => l.id);
    if (unmapped.length) {
      throw new BadRequestException(
        `Every labour purchase-order line must name the cost head that carries it — unattributed lines: [${unmapped.join(', ')}]`,
      );
    }
    await this.commercial.attribute(
      tx, projectId, { actorId: actor.actorId, role: user.role },
      lines.map((l) => ({ target: { labourPoLineId: l.id }, costHeadCode: map.get(l.id)!, reason })),
    );
  }

  /** §C amendment, labour side. A labour PO line's obligation is identified by its requisition
   *  line exactly as the material one is, so that is the v1↔v2 pairing. */
  private async replaceLabourOnAmend(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: Actor,
    user: AuthUser,
    priorLines: ReadonlyArray<{ id: string; requisitionLineId: string }>,
    nextVersionId: string,
    costHeads: ReadonlyArray<{ requisitionLineId: string; costHeadCode: string }> | undefined,
    reason: string,
  ): Promise<void> {
    if (!(await this.commercial.isActive(tx, projectId))) return;
    const nextLines = await tx.labourPurchaseOrderLine.findMany({
      where: { projectId, poVersionId: nextVersionId },
      select: { id: true, requisitionLineId: true },
      orderBy: { id: 'asc' },
    });
    const priorByRequisitionLine = new Map(priorLines.map((l) => [l.requisitionLineId, l.id]));
    // Codex round 3 (P2): keyed by REQUISITION LINE — the identity the caller supplies. The
    // replacement PO-line ids are generated in THIS transaction, so a caller could never name them.
    const map = new Map((costHeads ?? []).map((c) => [c.requisitionLineId, c.costHeadCode]));
    const identity = { actorId: actor.actorId, role: user.role };

    const carried = new Set<string>();
    const replaced: { from: { labourPoLineId: string }; to: { labourPoLineId: string }; costHeadCode?: string; reason: string }[] = [];
    const fresh: { labourPoLineId: string; costHeadCode: string }[] = [];
    for (const line of nextLines) {
      const prior = priorByRequisitionLine.get(line.requisitionLineId);
      if (prior) {
        carried.add(prior);
        replaced.push({ from: { labourPoLineId: prior }, to: { labourPoLineId: line.id }, costHeadCode: map.get(line.requisitionLineId), reason });
      } else if (map.has(line.requisitionLineId)) {
        fresh.push({ labourPoLineId: line.id, costHeadCode: map.get(line.requisitionLineId)! });
      } else {
        throw new BadRequestException(
          `Amended labour line ${line.id} is new to this purchase order — name the cost head that carries it (keyed by requisitionLineId)`,
        );
      }
    }
    // §B (Codex round-3 P2) — ONE act, THREE mutations, evaluated ONCE at the end over the union
    // of the heads they touch. See the material twin: an intermediate evaluate reads a state that
    // never existed at commit and writes a permanent false clear into an append-only register.
    const touched: string[] = [];
    // the amended obligation is a COMMITMENT that changed size, not a reclassification
    await this.commercial.replaceAttribution(tx, projectId, identity, replaced, 'commitment', touched);
    await this.commercial.attribute(
      tx, projectId, identity,
      fresh.map((f) => ({ target: { labourPoLineId: f.labourPoLineId }, costHeadCode: f.costHeadCode, reason })),
      touched,
    );
    const dropped = priorLines.filter((l) => !carried.has(l.id)).map((l) => ({ labourPoLineId: l.id }));
    await this.commercial.releaseAttribution(tx, projectId, identity, dropped, reason, touched);
    await this.commercial.evaluateDeferred(tx, projectId, identity, touched, 'commitment');
  }

  /**
   * §B (Codex round-3 P2) — the LABOUR capacity headroom movers. The commercial fold prices a
   * closed-short labour line's RELEASED remainder from `personShiftQty - committedQty`, so both
   * commands that write `committedQty` change exposure. Committing capacity on a closed-short line
   * re-instates obligation; DEFAULTING it releases the whole remainder, and without this the open
   * exception would stand forever against a commitment the supplier already reneged on.
   *
   * Derived from the fold's input set, not from a list of sites — see `commercial.contract.test.ts`.
   */
  private async evaluateBudgetForLine(
    tx: Prisma.TransactionClient, projectId: string, actor: Actor, role: string, labourPoLineId: string,
  ): Promise<void> {
    if (!(await this.commercial.isActive(tx, projectId))) return;
    await this.commercial.evaluateForTarget(
      tx, projectId, { actorId: actor.actorId, role }, { labourPoLineId }, 'commitment',
    );
  }

  private async begin(projectId: string, user: AuthUser): Promise<{ actor: Actor; scope: CommandScope }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    return { actor, scope: { scopeKind: 'project', projectId } };
  }

  /** `labour.requisition.request` (pmc/engineer) is the drafting authority. Route-guarded too. */
  private assertRequest(user: AuthUser): void {
    if (!(ROLE_POLICY['labour.requisition.request'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The labour commercial chain is a pmc/engineer surface');
    }
  }

  /** The commercial reads mirror `labour.read` (pmc/engineer). Route-guarded; this is the backstop. */
  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['labour.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The labour commercial pipeline is a pmc/engineer surface');
    }
  }

  // ── VendorLabourProfile (ORG-admin, plan §F/F7) ─────────────────────────────────────────────

  /** Org-admin authority: an ACTIVE org membership with role owner|admin (mirrors vendor CRUD). */
  private async assertOrgAdmin(orgId: string, userId: string): Promise<void> {
    const m = await this.prisma.orgMembership.findUnique({ where: { orgId_userId: { orgId, userId } } });
    if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
      throw new ForbiddenException('Only an org owner or admin can manage a vendor’s labour profile');
    }
  }

  /** Declare (or update) a vendor's LABOUR capabilities — org-admin, idempotent per (orgId, vendorId). */
  async setVendorProfile(orgId: string, input: SetVendorLabourProfileInput, user: AuthUser, idempotencyKey?: string): Promise<VendorLabourProfileDto> {
    await this.assertOrgAdmin(orgId, user.sub);
    const actor = await resolveActor(this.prisma, user);
    // read the procurement-owned Vendor THROUGH the participant (read-encapsulation — Labour is a LEAF)
    const vendor = await this.procurementParticipant.resolveOrgVendor(this.prisma, orgId, input.vendorId);
    if (!vendor) throw new BadRequestException('vendorId does not name a vendor of this org');
    const trades = [...new Set(input.trades)];
    const skills = [...new Set(input.skills)];
    await executeCommand(this.prisma, {
      scope: { scopeKind: 'org', organizationId: orgId }, actor,
      commandType: 'labour.vendorProfile.set', idempotencyKey, requestHash: hashRequest({ orgId, ...input }),
      run: async (tx) => {
        await tx.vendorLabourProfile.upsert({
          where: { orgId_vendorId: { orgId, vendorId: vendor.id } },
          create: { orgId, vendorId: vendor.id, trades, skills, createdById: actor.actorId },
          update: { trades, skills },
        });
        // org-scoped audit (no project); the executeCommand ledger carries the org scope + actor
        await recordAudit(tx, { projectId: null, actor, action: 'labour.vendorProfile.set', entity: 'VendorLabourProfile', entityId: `${orgId}:${vendor.id}` });
        return { resultRef: vendor.id, events: [] };
      },
    });
    const row = await this.prisma.vendorLabourProfile.findUniqueOrThrow({ where: { orgId_vendorId: { orgId, vendorId: vendor.id } } });
    return serializeProfile(row, vendor.name);
  }

  async listVendorProfiles(orgId: string, user: AuthUser): Promise<{ profiles: VendorLabourProfileDto[] }> {
    await this.assertOrgAdmin(orgId, user.sub);
    const rows = await this.prisma.vendorLabourProfile.findMany({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    // vendor names come THROUGH the procurement participant (read-encapsulation — Labour is a LEAF)
    const names = await this.procurementParticipant.orgVendorNames(this.prisma, orgId, rows.map((r) => r.vendorId));
    return { profiles: rows.map((r) => serializeProfile(r, names.get(r.vendorId) ?? '')) };
  }

  // ── §F bound 1: requirement → labour requisition (per slice, labour-owned reads only) ────────

  /**
   * Lock the pinned `LabourRequirementSpec` revision FOR UPDATE (serialising racing allocators on
   * the row), assert it is the requirement's CURRENT labour head, find the `(civilDate)` demand
   * slice, and refuse if `Σ active requisition-line allocations + addQty > the slice's
   * personShiftQty` (§F bound 1, per slice). Reads Labour-owned tables ONLY — never
   * `ActivityRequirement` (Labour stays a LEAF). Returns the spec's shift + fingerprint to FREEZE
   * onto the line (never caller-authored). Runs INSIDE the command tx (which holds the readiness lock).
   */
  private async assertRequisitionLineFits(
    tx: Prisma.TransactionClient, projectId: string, requirementId: string, revision: number, civilDate: Date, addQty: number,
  ): Promise<{ shift: string; labourSpecFingerprint: string }> {
    const specRows = await tx.$queryRaw<Array<{ shift: string; labourSpecFingerprint: string; revision: number }>>`
      SELECT "shift", "labourSpecFingerprint", "revision"
      FROM "LabourRequirementSpec"
      WHERE "projectId" = ${projectId} AND "requirementId" = ${requirementId} AND "revision" = ${revision}
      FOR UPDATE`;
    const spec = specRows[0];
    if (!spec) throw new BadRequestException('Requirement revision carries no labour specification (labour-only pipeline)');
    // head-currency check from Labour-owned data: the pinned revision must be the requirement's
    // CURRENT labour head (a revise/cancel appends a new labour spec revision, so a stale pin fails).
    const head = await tx.labourRequirementSpec.findFirst({
      where: { projectId, requirementId }, orderBy: { revision: 'desc' }, select: { revision: true },
    });
    if (!head || head.revision !== revision) {
      throw new BadRequestException(`Requirement is at labour revision ${head?.revision ?? '?'} — allocate against its current revision`);
    }
    const slice = await tx.labourDemandSlice.findFirst({
      where: { projectId, requirementId, revision, civilDate }, select: { personShiftQty: true },
    });
    if (!slice) {
      throw new BadRequestException(`Requirement revision ${revision} has no demand slice for ${toIsoCivilDate(civilDate)} — a requisition line names an existing demand slice`);
    }
    const allocated = await tx.labourRequisitionLine.aggregate({
      where: {
        projectId, requirementId, revision, civilDate, status: { in: ['open', 'ordered'] },
        requisition: { status: { notIn: ['rejected', 'closed'] } },
      },
      _sum: { personShiftQty: true },
    });
    const already = allocated._sum.personShiftQty ?? 0;
    if (already + addQty > slice.personShiftQty) {
      throw new ConflictException(
        `Allocation exceeds the requirement slice ${toIsoCivilDate(civilDate)}: required ${slice.personShiftQty} person-shifts, already allocated ${already}, requested ${addQty} (§F bound 1 — raise the ceiling with a requirement revision, never an override)`,
      );
    }
    return { shift: spec.shift, labourSpecFingerprint: spec.labourSpecFingerprint };
  }

  async createRequisition(projectId: string, input: CreateLabourRequisitionInput, user: AuthUser, idempotencyKey?: string): Promise<LabourRequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertRequest(user);
    const parsed = input.lines.map((l) => {
      const civilDate = fromIsoCivilDate(l.civilDate);
      if (!civilDate) throw new BadRequestException('line civilDate must be an ISO civil date');
      return { ...l, civilDate };
    });
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.requisition.create', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const created = await tx.labourRequisition.create({
          data: { projectId, title: input.title, notes: input.notes ?? null, createdById: actor.actorId },
        });
        for (const line of parsed) {
          const frozen = await this.assertRequisitionLineFits(tx, projectId, line.requirementId, line.revision, line.civilDate, line.personShiftQty);
          await tx.labourRequisitionLine.create({
            data: {
              projectId, requisitionId: created.id, requirementId: line.requirementId, revision: line.revision,
              civilDate: line.civilDate, shift: frozen.shift, labourSpecFingerprint: frozen.labourSpecFingerprint,
              personShiftQty: line.personShiftQty,
            },
          });
        }
        await recordAudit(tx, { projectId, actor, action: 'labour.requisition.create', entity: 'LabourRequisition', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    return this.readRequisition(projectId, outcome.resultRef);
  }

  async submitRequisition(projectId: string, requisitionId: string, user: AuthUser, idempotencyKey?: string): Promise<LabourRequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertRequest(user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.requisition.submit', idempotencyKey, requestHash: hashRequest({ requisitionId }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.labourRequisition.updateMany({
          where: { id: requisitionId, projectId, status: 'draft' },
          data: { status: 'submitted', submittedById: actor.actorId, submittedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only a draft labour requisition can be submitted — reload and retry');
        const full = await tx.labourRequisition.findFirstOrThrow({ where: { projectId, id: requisitionId }, include: { lines: true } });
        if (!full.lines.some((l) => l.status === 'open')) throw new BadRequestException('A labour requisition needs at least one open line to submit');
        await recordAudit(tx, { projectId, actor, action: 'labour.requisition.submit', entity: 'LabourRequisition', entityId: requisitionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'labour.requisition.submitted', entityType: 'LabourRequisition', entityId: requisitionId,
          payload: this.requisitionPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'labour.requisition.submitted', dispatch: {},
        });
        return { resultRef: requisitionId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readRequisition(projectId, requisitionId);
  }

  async approveRequisition(projectId: string, requisitionId: string, user: AuthUser, idempotencyKey?: string): Promise<LabourRequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.requisition.approve', idempotencyKey, requestHash: hashRequest({ requisitionId }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.labourRequisition.updateMany({
          where: { id: requisitionId, projectId, status: 'submitted' },
          data: { status: 'approved', approvedById: actor.actorId, approvedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only a submitted labour requisition can be approved — reload and retry');
        const full = await tx.labourRequisition.findFirstOrThrow({ where: { projectId, id: requisitionId }, include: { lines: true } });
        await recordAudit(tx, { projectId, actor, action: 'labour.requisition.approve', entity: 'LabourRequisition', entityId: requisitionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'labour.requisition.approved', entityType: 'LabourRequisition', entityId: requisitionId,
          payload: this.requisitionPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'labour.requisition.approved', dispatch: {},
        });
        return { resultRef: requisitionId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readRequisition(projectId, requisitionId);
  }

  /** `labour.requisition.approve` is pmc authority (the requisition sign-off + the RFQ/quote/
   *  comparison/PO chain). Route-guarded too; this is the service-level backstop. */
  private assertApprove(user: AuthUser): void {
    if (!(ROLE_POLICY['labour.requisition.approve'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Approving a labour requisition (and the RFQ/quote/comparison/PO chain) is a pmc surface');
    }
  }

  /** `labour.commit.manage` is pmc authority (the CapacityCommitment lifecycle, plan §H). */
  private assertCommit(user: AuthUser): void {
    if (!(ROLE_POLICY['labour.commit.manage'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Managing labour capacity commitments is a pmc surface');
    }
  }

  async rejectRequisition(projectId: string, requisitionId: string, input: RejectLabourRequisitionInput, user: AuthUser, idempotencyKey?: string): Promise<LabourRequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.requisition.reject', idempotencyKey, requestHash: hashRequest({ requisitionId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.labourRequisition.updateMany({
          where: { id: requisitionId, projectId, status: 'submitted' },
          data: { status: 'rejected', rejectedReason: input.reason },
        });
        if (count === 0) throw new ConflictException('Only a submitted labour requisition can be rejected — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'labour.requisition.reject', entity: 'LabourRequisition', entityId: requisitionId });
        return { resultRef: requisitionId, events: [] };
      },
    });
    return this.readRequisition(projectId, requisitionId);
  }

  /** Cancel ONE open line — frees its slice allocation (the §F disposition unit). */
  async cancelRequisitionLine(projectId: string, requisitionId: string, lineId: string, user: AuthUser, idempotencyKey?: string): Promise<LabourRequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertRequest(user);
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.requisition.cancelLine', idempotencyKey, requestHash: hashRequest({ requisitionId, lineId }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const req = await tx.labourRequisition.findFirst({ where: { id: requisitionId, projectId }, select: { status: true } });
        if (!req) throw new NotFoundException('Labour requisition not found');
        if (req.status === 'rejected' || req.status === 'closed') throw new ConflictException('A rejected or closed requisition has no lines to cancel');
        const { count } = await tx.labourRequisitionLine.updateMany({
          where: { id: lineId, projectId, requisitionId, status: 'open' },
          data: { status: 'cancelled', cancelledAt: new Date(), cancelledById: actor.actorId },
        });
        if (count === 0) throw new ConflictException('Only an open labour requisition line can be cancelled — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'labour.requisition.cancelLine', entity: 'LabourRequisitionLine', entityId: lineId });
        return { resultRef: requisitionId, events: [] };
      },
    });
    return this.readRequisition(projectId, requisitionId);
  }

  /** approved → closed: every line ordered or cancelled. */
  async closeRequisition(projectId: string, requisitionId: string, user: AuthUser, idempotencyKey?: string): Promise<LabourRequisitionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.requisition.close', idempotencyKey, requestHash: hashRequest({ requisitionId }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        // R2 — DERIVE allocation truth rather than trust a possibly-stale status column: every
        // non-cancelled line must be FULLY covered by LIVE PO allocation (an amended/closed-short PO
        // whose commitment defaulted covers nothing, even if the line still reads 'ordered'). Another
        // live PO that still covers the line keeps it satisfied. Reconcile the status as we go.
        const lines = await tx.labourRequisitionLine.findMany({
          where: { projectId, requisitionId, status: { not: 'cancelled' } },
          select: { id: true, civilDate: true, personShiftQty: true },
        });
        for (const l of lines) {
          const allocated = await this.liveAllocation(tx, projectId, l.id);
          if (allocated < l.personShiftQty) {
            throw new ConflictException(
              `Labour requisition line ${toIsoCivilDate(l.civilDate)} is not fully ordered (${allocated}/${l.personShiftQty} person-shifts live) — order or cancel it before closing`,
            );
          }
          await this.refreshOrderedFlag(tx, projectId, l.id);
        }
        const { count } = await tx.labourRequisition.updateMany({
          where: { id: requisitionId, projectId, status: 'approved' },
          data: { status: 'closed', closedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only an approved labour requisition can be closed — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'labour.requisition.close', entity: 'LabourRequisition', entityId: requisitionId });
        return { resultRef: requisitionId, events: [] };
      },
    });
    return this.readRequisition(projectId, requisitionId);
  }

  private requisitionPayload(r: ReqRow): { requisitionId: string; lines: Array<{ requirementId: string; revision: number; civilDate: string; shift: string; personShiftQty: number }> } {
    return {
      requisitionId: r.id,
      lines: r.lines.filter((l) => l.status === 'open').map((l) => ({
        requirementId: l.requirementId, revision: l.revision,
        civilDate: toIsoCivilDate(l.civilDate) ?? '', shift: l.shift, personShiftQty: l.personShiftQty,
      })),
    };
  }

  // ── RFQ + quote + comparison ─────────────────────────────────────────────────────────────────

  async createRfq(projectId: string, input: CreateLabourRfqInput, user: AuthUser, idempotencyKey?: string): Promise<LabourRfqDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.rfq.create', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        const req = await tx.labourRequisition.findFirst({ where: { id: input.requisitionId, projectId }, select: { status: true } });
        if (!req) throw new BadRequestException('requisitionId does not belong to this project');
        if (req.status !== 'approved') throw new ConflictException('A labour RFQ is issued from an APPROVED requisition');
        const created = await tx.labourRfq.create({ data: { projectId, requisitionId: input.requisitionId, issuedById: actor.actorId } });
        await recordAudit(tx, { projectId, actor, action: 'labour.rfq.create', entity: 'LabourRfq', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    return this.readRfq(projectId, outcome.resultRef, user);
  }

  async closeRfq(projectId: string, rfqId: string, user: AuthUser, idempotencyKey?: string): Promise<LabourRfqDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.rfq.close', idempotencyKey, requestHash: hashRequest({ rfqId }),
      run: async (tx) => {
        const { count } = await tx.labourRfq.updateMany({
          where: { id: rfqId, projectId, status: 'issued' }, data: { status: 'closed', closedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only an issued labour RFQ can be closed — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'labour.rfq.close', entity: 'LabourRfq', entityId: rfqId });
        return { resultRef: rfqId, events: [] };
      },
    });
    return this.readRfq(projectId, rfqId, user);
  }

  /** Record a vendor's labour quote; a prior RECORDED quote of the same (rfq, vendor) is SUPERSEDED. */
  async recordQuote(projectId: string, rfqId: string, input: RecordLabourQuoteInput, user: AuthUser, idempotencyKey?: string): Promise<LabourRfqDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    const validUntil = fromIsoCivilDate(input.validUntil);
    if (!validUntil) throw new BadRequestException('validUntil must be an ISO civil date');
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.quote.record', idempotencyKey, requestHash: hashRequest({ rfqId, ...input }),
      run: async (tx) => {
        // Join the readiness lock so two recordings of the same (rfq, vendor) SERIALISE (the second
        // supersedes the first); the partial unique is the database backstop.
        await lockProjectReadiness(tx, projectId);
        const rfq = await tx.labourRfq.findFirst({ where: { id: rfqId, projectId }, select: { status: true, requisitionId: true } });
        if (!rfq) throw new BadRequestException('rfqId does not belong to this project');
        if (rfq.status !== 'issued') throw new ConflictException('Quotes are recorded against an ISSUED labour RFQ');
        // §H/§F — the vendor must be bound to this project (validated through Procurement; FK is the backstop)
        await this.procurementParticipant.assertVendorBound(tx, projectId, input.vendorId);
        await tx.supplierLabourQuote.updateMany({
          where: { projectId, rfqId, vendorId: input.vendorId, status: 'recorded' }, data: { status: 'superseded' },
        });
        const created = await tx.supplierLabourQuote.create({
          data: {
            projectId, rfqId, requisitionId: rfq.requisitionId, vendorId: input.vendorId, validUntil,
            leadTimeDays: input.leadTimeDays ?? null, notes: input.notes ?? null, recordedById: actor.actorId,
          },
        });
        const seen = new Set<string>();
        for (const line of input.lines) {
          if (seen.has(line.requisitionLineId)) throw new BadRequestException('Each requisition line may appear at most once per quote');
          seen.add(line.requisitionLineId);
          const reqLine = await tx.labourRequisitionLine.findFirst({
            where: { id: line.requisitionLineId, projectId, requisitionId: rfq.requisitionId, status: 'open' }, select: { id: true },
          });
          if (!reqLine) throw new BadRequestException('requisitionLineId must be an OPEN line of this RFQ’s requisition');
          await tx.supplierLabourQuoteLine.create({
            data: {
              projectId, quoteId: created.id, requisitionLineId: line.requisitionLineId, requisitionId: rfq.requisitionId,
              ratePerPersonShift: new Prisma.Decimal(line.ratePerPersonShift), shiftPremium: new Prisma.Decimal(line.shiftPremium),
              landedPerPersonShift: new Prisma.Decimal(line.landedPerPersonShift), matchesSpecification: line.matchesSpecification,
            },
          });
        }
        await recordAudit(tx, { projectId, actor, action: 'labour.quote.record', entity: 'SupplierLabourQuote', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    return this.readRfq(projectId, rfqId, user);
  }

  async createComparison(projectId: string, rfqId: string, user: AuthUser, idempotencyKey?: string): Promise<LabourRfqDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.comparison.create', idempotencyKey, requestHash: hashRequest({ rfqId }),
      run: async (tx) => {
        const rfq = await tx.labourRfq.findFirst({ where: { id: rfqId, projectId }, select: { id: true, requisitionId: true } });
        if (!rfq) throw new BadRequestException('rfqId does not belong to this project');
        const existing = await tx.labourQuoteComparison.findUnique({ where: { projectId_rfqId: { projectId, rfqId } } });
        if (existing) throw new ConflictException('A comparison already exists for this labour RFQ');
        const created = await tx.labourQuoteComparison.create({
          data: { projectId, rfqId, requisitionId: rfq.requisitionId, createdById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'labour.comparison.create', entity: 'LabourQuoteComparison', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    return this.readRfq(projectId, rfqId, user);
  }

  /** draft → approved: authority + reason always; NON-LOWEST landed selection demands justification. */
  async approveComparison(projectId: string, rfqId: string, input: ApproveLabourComparisonInput, user: AuthUser, idempotencyKey?: string): Promise<LabourRfqDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.comparison.approve', idempotencyKey, requestHash: hashRequest({ rfqId, ...input }),
      run: async (tx) => {
        const comparison = await tx.labourQuoteComparison.findUnique({ where: { projectId_rfqId: { projectId, rfqId } } });
        if (!comparison) throw new NotFoundException('No comparison exists for this labour RFQ');
        if (comparison.status !== 'draft') throw new ConflictException('The comparison is already approved');
        // validity settled against the PROJECT's civil today (injected clock + Project.timeZone)
        const project = await tx.project.findFirstOrThrow({ where: { id: projectId }, select: { timeZone: true } });
        const today = new Date(this.clock.today(project.timeZone));
        await tx.supplierLabourQuote.updateMany({
          where: { projectId, rfqId, status: 'recorded', validUntil: { lt: today } }, data: { status: 'expired' },
        });
        const live = await tx.supplierLabourQuote.findMany({ where: { projectId, rfqId, status: 'recorded' }, include: { lines: true } });
        if (live.length === 0) throw new ConflictException('No live (recorded, unexpired) quotes to compare');
        // only COMPLETE quotes — covering EVERY open line of the requisition — are eligible
        const openLines = await tx.labourRequisitionLine.findMany({
          where: { projectId, requisitionId: comparison.requisitionId, status: 'open' }, select: { id: true, personShiftQty: true },
        });
        const qtyByLine = new Map(openLines.map((l) => [l.id, l.personShiftQty]));
        const eligible = live.filter((q) => openLines.every((l) => q.lines.some((ql) => ql.requisitionLineId === l.id)));
        if (eligible.length === 0) throw new ConflictException('No COMPLETE live quote covers every open requisition line — partial awards are unsupported');
        const selected = eligible.find((q) => q.id === input.selectedQuoteId);
        if (!selected) throw new BadRequestException('selectedQuoteId must name a LIVE, COMPLETE quote of this RFQ (recorded, unexpired, covering every open line)');
        // an offered supply that does not match the required trade/skill spec cannot be selected
        if (selected.lines.some((l) => !l.matchesSpecification)) {
          throw new BadRequestException('The selected quote offers labour that does NOT match the required trade/skill specification — an approved substitution is required (unsupported in Task 2)');
        }
        // landed total = Σ (landedPerPersonShift × the line's person-shift quantity)
        const totalOf = (q: typeof live[number]): Prisma.Decimal =>
          q.lines.reduce((s, l) => s.add(l.landedPerPersonShift.mul(qtyByLine.get(l.requisitionLineId) ?? 0)), new Prisma.Decimal(0));
        const totals = new Map(eligible.map((q) => [q.id, totalOf(q)]));
        const lowest = [...totals.values()].reduce((a, b) => (b.lessThan(a) ? b : a));
        const selectedTotal = totals.get(selected.id)!;
        if (selectedTotal.greaterThan(lowest) && !input.justification) {
          throw new BadRequestException(
            `Selected landed total ${selectedTotal.toString()} exceeds the lowest ${lowest.toString()} — a non-lowest selection demands an explicit justification (§F)`,
          );
        }
        const { count } = await tx.labourQuoteComparison.updateMany({
          where: { id: comparison.id, projectId, status: 'draft' },
          data: {
            status: 'approved', selectedQuoteId: selected.id, selectedVendorId: selected.vendorId,
            reason: input.reason, justification: input.justification ?? null,
            approvedById: actor.actorId, approvedAt: new Date(),
          },
        });
        if (count === 0) throw new ConflictException('The comparison changed while approving — reload and retry');
        await recordAudit(tx, { projectId, actor, action: 'labour.comparison.approve', entity: 'LabourQuoteComparison', entityId: comparison.id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'labour.comparison.approved', entityType: 'LabourQuoteComparison', entityId: comparison.id,
          payload: { comparisonId: comparison.id, selectedVendorId: selected.vendorId, authority: actor.actorId, reason: input.reason } as unknown as Prisma.InputJsonValue,
          effectKey: 'labour.comparison.approved', dispatch: {},
        });
        return { resultRef: comparison.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readRfq(projectId, rfqId, user);
  }

  // ── §F bound 2: labour requisition → labour PO (per slice) + frozen rate snapshot ────────────

  /**
   * Σ LIVE PO-line allocation against one requisition line. A PO line covers its slice when it is a
   * live order that has NOT been reneged:
   *   - a DEFAULTED commitment (the source reneged) permanently removes the line's coverage — the PO
   *     line can never be re-committed (commit refuses any existing commitment; revise needs a live
   *     one), so its slice must be re-sourced and it contributes 0, even on a still-live version;
   *   - a closed_short version keeps only its committed portion (committedQty);
   *   - any other live version (issued/partially_committed/completed) holds the full ordered qty —
   *     an uncommitted issued line is a real open order that legitimately keeps the slice ordered.
   */
  private async liveAllocation(tx: Prisma.TransactionClient, projectId: string, requisitionLineId: string): Promise<number> {
    const rows = await tx.labourPurchaseOrderLine.findMany({
      where: { projectId, requisitionLineId, poVersion: { status: { in: [...LIVE_LABOUR_PO_STATUSES, 'closed_short'] } } },
      select: { personShiftQty: true, committedQty: true, poVersion: { select: { status: true } }, commitments: { select: { status: true } } },
    });
    return rows.reduce((sum, r) => {
      if (r.commitments.some((c) => c.status === 'defaulted')) return sum;
      return sum + (r.poVersion.status === 'closed_short' ? r.committedQty : r.personShiftQty);
    }, 0);
  }

  /** FOR UPDATE the requisition line; sum live PO allocations; refuse overflow (§F bound 2, per slice). */
  private async lockLineAndAssertOrderFits(
    tx: Prisma.TransactionClient, projectId: string, requisitionLineId: string, addQty: number,
  ): Promise<{ id: string; requirementId: string; revision: number; civilDate: Date; shift: string; labourSpecFingerprint: string; requisitionId: string; personShiftQty: number }> {
    const rows = await tx.$queryRaw<Array<{
      id: string; requirementId: string; revision: number; civilDate: Date; shift: string;
      labourSpecFingerprint: string; personShiftQty: number; status: string; requisitionId: string;
    }>>`
      SELECT "id", "requirementId", "revision", "civilDate", "shift", "labourSpecFingerprint", "personShiftQty", "status", "requisitionId"
      FROM "LabourRequisitionLine"
      WHERE "projectId" = ${projectId} AND "id" = ${requisitionLineId}
      FOR UPDATE`;
    const line = rows[0];
    if (!line) throw new NotFoundException('Labour requisition line not found in this project');
    if (line.status === 'cancelled') throw new ConflictException('A cancelled requisition line cannot be ordered');
    const req = await tx.labourRequisition.findFirstOrThrow({ where: { projectId, id: line.requisitionId }, select: { status: true } });
    if (req.status !== 'approved') throw new ConflictException('Labour purchase orders execute an APPROVED requisition');
    const allocated = await this.liveAllocation(tx, projectId, requisitionLineId);
    if (allocated + addQty > line.personShiftQty) {
      throw new ConflictException(
        `Order exceeds the requisition line ${toIsoCivilDate(line.civilDate)}: line ${line.personShiftQty} person-shifts, already ordered ${allocated}, requested ${addQty} (§F bound 2 — split within the line's remaining qty)`,
      );
    }
    return {
      id: line.id, requirementId: line.requirementId, revision: line.revision, civilDate: line.civilDate,
      shift: line.shift, labourSpecFingerprint: line.labourSpecFingerprint, requisitionId: line.requisitionId,
      personShiftQty: line.personShiftQty,
    };
  }

  /** Recompute a requisition line's ordered/open flag after its live allocation changed. */
  private async refreshOrderedFlag(tx: Prisma.TransactionClient, projectId: string, requisitionLineId: string): Promise<void> {
    const line = await tx.labourRequisitionLine.findFirst({ where: { projectId, id: requisitionLineId }, select: { personShiftQty: true, status: true } });
    if (!line || line.status === 'cancelled') return;
    const allocated = await this.liveAllocation(tx, projectId, requisitionLineId);
    const want = allocated >= line.personShiftQty ? 'ordered' : 'open';
    if (line.status !== want) {
      await tx.labourRequisitionLine.updateMany({ where: { projectId, id: requisitionLineId, status: line.status }, data: { status: want } });
    }
  }

  /**
   * R3 — keep the requisition's TERMINAL STATE coherent after a default. `closeRequisition` only closes
   * a requisition whose every non-cancelled line is fully covered by live allocation, but a default can
   * land AFTER closure and remove that coverage. When it does, a CLOSED requisition would contain an
   * OPEN (uncovered) line — incoherent — so we atomically reopen it (closed → approved, closedAt
   * cleared) under the same readiness lock, via a CAS so a concurrent transition never double-applies.
   * A requisition still fully covered (another live PO holds the slice) is left closed.
   */
  private async reopenRequisitionIfUncovered(
    tx: Prisma.TransactionClient, projectId: string, requisitionId: string, actor: Actor,
  ): Promise<void> {
    const req = await tx.labourRequisition.findFirst({ where: { projectId, id: requisitionId }, select: { status: true } });
    if (!req || req.status !== 'closed') return; // only a CLOSED parent can become incoherent
    const lines = await tx.labourRequisitionLine.findMany({
      where: { projectId, requisitionId, status: { not: 'cancelled' } },
      select: { id: true, personShiftQty: true },
    });
    let uncovered = false;
    for (const l of lines) {
      if ((await this.liveAllocation(tx, projectId, l.id)) < l.personShiftQty) { uncovered = true; break; }
    }
    if (!uncovered) return; // every line is still fully covered — the closure stays coherent
    const { count } = await tx.labourRequisition.updateMany({
      where: { id: requisitionId, projectId, status: 'closed' }, data: { status: 'approved', closedAt: null },
    });
    if (count === 0) return; // a concurrent transition already reopened it — never double-stamp
    await recordAudit(tx, { projectId, actor, action: 'labour.requisition.reopen', entity: 'LabourRequisition', entityId: requisitionId });
  }

  private async currentVersion(tx: Prisma.TransactionClient, projectId: string, poId: string): Promise<VersionRow> {
    const version = await tx.labourPurchaseOrderVersion.findFirst({
      where: { projectId, poId }, orderBy: { version: 'desc' }, include: { lines: true },
    });
    if (!version) throw new NotFoundException('Labour purchase order not found in this project');
    return version;
  }

  /**
   * Freeze the version-N line set from the comparison's SELECTED quote (rate per person-shift). Each
   * line records its selected-quote-line PROVENANCE (F4): `comparisonId`/`selectedQuoteId`/
   * `selectedQuoteLineId` — a composite-FK chain proves the frozen rate/premium ARE the comparison-
   * selected quote line's, so a PO line whose terms came from nowhere is unrepresentable.
   */
  private async freezeLines(
    tx: Prisma.TransactionClient, projectId: string, poVersionId: string,
    requisitionId: string, comparisonId: string, selectedQuoteId: string, lines: CreateLabourPoInput['lines'],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const input of lines) {
      if (seen.has(input.requisitionLineId)) throw new BadRequestException('Each requisition line may appear at most once per PO version');
      seen.add(input.requisitionLineId);
      const line = await this.lockLineAndAssertOrderFits(tx, projectId, input.requisitionLineId, input.personShiftQty);
      if (line.requisitionId !== requisitionId) throw new BadRequestException('requisitionLineId must belong to the comparison’s requisition');
      const quoteLine = await tx.supplierLabourQuoteLine.findFirst({ where: { projectId, quoteId: selectedQuoteId, requisitionLineId: line.id } });
      if (!quoteLine) throw new BadRequestException('The selected quote does not quote this requisition line — a PO freezes quoted terms only');
      if (!quoteLine.matchesSpecification) throw new BadRequestException('The quoted labour does NOT match the required specification — it cannot be ordered without an approved substitution');
      // dimensionally exact commitment: committedAmountBase = round((rate + premium) × personShiftQty, 2) (DB CHECK re-derives)
      const committedAmountBase = quoteLine.ratePerPersonShift.add(quoteLine.shiftPremium).mul(input.personShiftQty).toDecimalPlaces(2);
      await tx.labourPurchaseOrderLine.create({
        data: {
          projectId, poVersionId, requisitionLineId: line.id, requisitionId: line.requisitionId,
          requirementId: line.requirementId, revision: line.revision, civilDate: line.civilDate, shift: line.shift,
          labourSpecFingerprint: line.labourSpecFingerprint, personShiftQty: input.personShiftQty,
          ratePerPersonShift: quoteLine.ratePerPersonShift, shiftPremium: quoteLine.shiftPremium, committedAmountBase,
          comparisonId, selectedQuoteId, selectedQuoteLineId: quoteLine.id,
        },
      });
      await this.refreshOrderedFlag(tx, projectId, line.id);
    }
  }

  /**
   * Recompute a PO version's status from its lines' LIVE committed quantity (F1 — the single
   * transactional lifecycle). Only issued|partially_committed|completed versions are recomputed
   * (terminal states — amended/cancelled/closed_short — are never re-opened here):
   *   Σcommitted = 0 → issued · 0 < Σcommitted < Σordered → partially_committed · = → completed.
   */
  private async recomputeVersionStatus(tx: Prisma.TransactionClient, projectId: string, poVersionId: string): Promise<void> {
    const version = await tx.labourPurchaseOrderVersion.findFirstOrThrow({ where: { projectId, id: poVersionId }, select: { status: true } });
    if (!['issued', 'partially_committed', 'completed'].includes(version.status)) return;
    const lines = await tx.labourPurchaseOrderLine.findMany({ where: { projectId, poVersionId }, select: { personShiftQty: true, committedQty: true } });
    const ordered = lines.reduce((s, l) => s + l.personShiftQty, 0);
    const committed = lines.reduce((s, l) => s + l.committedQty, 0);
    const want = committed === 0 ? 'issued' : committed >= ordered ? 'completed' : 'partially_committed';
    if (want !== version.status) {
      await tx.labourPurchaseOrderVersion.updateMany({ where: { projectId, id: poVersionId, status: version.status }, data: { status: want } });
    }
  }

  /** Create a DRAFT PO (version 1) from an APPROVED comparison — allocation reserved under §F bound 2. */
  async createPo(projectId: string, input: CreateLabourPoInput, user: AuthUser, idempotencyKey?: string): Promise<LabourPurchaseOrderDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.po.create', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const comparison = await tx.labourQuoteComparison.findFirst({ where: { projectId, id: input.comparisonId } });
        if (!comparison) throw new BadRequestException('comparisonId does not belong to this project');
        if (comparison.status !== 'approved' || !comparison.selectedQuoteId || !comparison.selectedVendorId) {
          throw new ConflictException('A labour purchase order executes an APPROVED comparison');
        }
        await this.procurementParticipant.assertVendorBound(tx, projectId, comparison.selectedVendorId);
        const po = await tx.labourPurchaseOrder.create({
          data: {
            projectId, vendorId: comparison.selectedVendorId, requisitionId: comparison.requisitionId,
            comparisonId: comparison.id, createdById: actor.actorId,
          },
        });
        const version = await tx.labourPurchaseOrderVersion.create({
          data: { projectId, poId: po.id, requisitionId: po.requisitionId, comparisonId: comparison.id, version: 1, createdById: actor.actorId },
        });
        await this.freezeLines(tx, projectId, version.id, comparison.requisitionId, comparison.id, comparison.selectedQuoteId, input.lines);
        await recordAudit(tx, { projectId, actor, action: 'labour.po.create', entity: 'LabourPurchaseOrder', entityId: po.id });
        return { resultRef: po.id, events: [] };
      },
    });
    return this.readPo(projectId, outcome.resultRef, user);
  }

  /** draft → issued. */
  async issuePo(projectId: string, poId: string, input: IssueLabourPoInput, user: AuthUser, idempotencyKey?: string): Promise<LabourPurchaseOrderDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.po.issue', idempotencyKey, requestHash: hashRequest({ poId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const current = await this.currentVersion(tx, projectId, poId);
        const { count } = await tx.labourPurchaseOrderVersion.updateMany({
          where: { id: current.id, projectId, status: 'draft' },
          data: { status: 'issued', issuedById: actor.actorId, issuedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only a draft labour purchase order can be issued — reload and retry');
        // §C — the initial attribution, in the transaction that makes the version LIVE.
        await this.attributeIssuedLabour(tx, projectId, actor, user, current.lines, input.costHeads, 'Labour purchase order issued');
        const issued = await this.currentVersion(tx, projectId, poId);
        await recordAudit(tx, { projectId, actor, action: 'labour.po.issue', entity: 'LabourPurchaseOrderVersion', entityId: current.id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'labour.po.issued', entityType: 'LabourPurchaseOrder', entityId: poId,
          payload: this.poPayload(poId, issued) as unknown as Prisma.InputJsonValue,
          effectKey: 'labour.po.issued', dispatch: {},
        });
        return { resultRef: poId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readPo(projectId, poId, user);
  }

  /** issued → amended: the current version is CAS'd to 'amended' (frozen verbatim) and a NEW version issued. */
  async amendPo(projectId: string, poId: string, input: AmendLabourPoInput, user: AuthUser, idempotencyKey?: string): Promise<LabourPurchaseOrderDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.po.amend', idempotencyKey, requestHash: hashRequest({ poId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const po = await tx.labourPurchaseOrder.findFirst({ where: { projectId, id: poId }, select: { requisitionId: true, comparisonId: true } });
        if (!po) throw new NotFoundException('Labour purchase order not found in this project');
        const current = await this.currentVersion(tx, projectId, poId);
        // F1 — a live capacity commitment is NEVER orphaned by an amend: default or close it short first.
        const liveCommitments = await tx.capacityCommitment.count({
          where: { projectId, poLineId: { in: current.lines.map((l) => l.id) }, status: { in: ['committed', 'revised'] } },
        });
        if (liveCommitments > 0) throw new ConflictException('This labour purchase order has live capacity commitments — default or close it short before amending (a live commitment is never orphaned)');
        const { count } = await tx.labourPurchaseOrderVersion.updateMany({
          where: { id: current.id, projectId, status: 'issued' },
          data: { status: 'amended', amendReason: input.reason, amendedAt: new Date(), issuedById: current.issuedById ?? actor.actorId, issuedAt: current.issuedAt ?? new Date() },
        });
        if (count === 0) throw new ConflictException('Only an ISSUED labour purchase order can be amended — reload and retry');
        for (const l of current.lines) await this.refreshOrderedFlag(tx, projectId, l.requisitionLineId);
        const comparison = await tx.labourQuoteComparison.findFirstOrThrow({ where: { projectId, id: po.comparisonId }, select: { selectedQuoteId: true } });
        const next = await tx.labourPurchaseOrderVersion.create({
          data: {
            projectId, poId, requisitionId: po.requisitionId, comparisonId: po.comparisonId, version: current.version + 1, status: 'issued',
            supersedesVersion: current.version, issuedById: actor.actorId, issuedAt: new Date(), createdById: actor.actorId,
          },
        });
        await this.freezeLines(tx, projectId, next.id, po.requisitionId, po.comparisonId, comparison.selectedQuoteId!, input.lines);
        // §C — the ATOMIC REPLACEMENT, in the SAME transaction that issues the new version.
        await this.replaceLabourOnAmend(tx, projectId, actor, user, current.lines, next.id, input.costHeads, input.reason);
        const issued = await this.currentVersion(tx, projectId, poId);
        await recordAudit(tx, { projectId, actor, action: 'labour.po.amend', entity: 'LabourPurchaseOrderVersion', entityId: next.id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'labour.po.amended', entityType: 'LabourPurchaseOrder', entityId: poId,
          payload: this.poPayload(poId, issued) as unknown as Prisma.InputJsonValue,
          effectKey: 'labour.po.amended', dispatch: {},
        });
        return { resultRef: poId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readPo(projectId, poId, user);
  }

  /** draft|issued → cancelled — ONLY with zero capacity commitments; otherwise close-short (§F). */
  async cancelPo(projectId: string, poId: string, input: CancelLabourPoInput, user: AuthUser, idempotencyKey?: string): Promise<LabourPurchaseOrderDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.po.cancel', idempotencyKey, requestHash: hashRequest({ poId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const current = await this.currentVersion(tx, projectId, poId);
        const committed = await tx.capacityCommitment.count({
          where: { projectId, poLineId: { in: current.lines.map((l) => l.id) }, status: { in: ['committed', 'revised'] } },
        });
        if (committed > 0) throw new ConflictException('This labour purchase order has live capacity commitments — close it SHORT with a reason instead of cancelling (§F)');
        const wasIssued = current.status === 'issued';
        const { count } = await tx.labourPurchaseOrderVersion.updateMany({
          where: { id: current.id, projectId, status: { in: ['draft', 'issued'] } },
          data: { status: 'cancelled', cancelReason: input.reason, cancelledAt: new Date(), issuedById: current.issuedById ?? (wasIssued ? actor.actorId : null), issuedAt: current.issuedAt ?? (wasIssued ? new Date() : null) },
        });
        if (count === 0) throw new ConflictException('Only a draft or issued labour purchase order can be cancelled — reload and retry');
        for (const l of current.lines) await this.refreshOrderedFlag(tx, projectId, l.requisitionLineId);
        // §C — a cancelled version is no longer live, so its attributions are released.
        if (await this.commercial.isActive(tx, projectId)) {
          await this.commercial.releaseAttribution(
            tx, projectId, { actorId: actor.actorId, role: user.role },
            current.lines.map((l) => ({ labourPoLineId: l.id })), input.reason,
          );
        }
        await recordAudit(tx, { projectId, actor, action: 'labour.po.cancel', entity: 'LabourPurchaseOrderVersion', entityId: current.id });
        if (wasIssued) {
          const cancelled = await this.currentVersion(tx, projectId, poId);
          const ev = await emitEvent(tx, {
            projectId, actor, eventType: 'labour.po.cancelled', entityType: 'LabourPurchaseOrder', entityId: poId,
            payload: this.poPayload(poId, cancelled) as unknown as Prisma.InputJsonValue,
            effectKey: 'labour.po.cancelled', dispatch: {},
          });
          return { resultRef: poId, events: [ev] };
        }
        return { resultRef: poId, events: [] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readPo(projectId, poId, user);
  }

  /** issued|partially_committed → closed_short with reason: the un-committed remainder is released. */
  async closeShortPo(projectId: string, poId: string, input: CloseShortLabourPoInput, user: AuthUser, idempotencyKey?: string): Promise<LabourPurchaseOrderDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertApprove(user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.po.closeShort', idempotencyKey, requestHash: hashRequest({ poId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const current = await this.currentVersion(tx, projectId, poId);
        const { count } = await tx.labourPurchaseOrderVersion.updateMany({
          where: { id: current.id, projectId, status: { in: ['issued', 'partially_committed'] } },
          data: { status: 'closed_short', closeShortReason: input.reason, closedShortAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only an issued or partially committed labour purchase order can be closed short — reload and retry');
        for (const l of current.lines) await this.refreshOrderedFlag(tx, projectId, l.requisitionLineId);
        // §C — the obligation changed size: supersede and re-attribute on the SAME line, so
        // `COMMITTED` re-reads the reduced obligation with attributable evidence behind the change.
        if (await this.commercial.isActive(tx, projectId)) {
          await this.commercial.replaceAttribution(
            tx, projectId, { actorId: actor.actorId, role: user.role },
            current.lines.map((l) => ({ from: { labourPoLineId: l.id }, to: { labourPoLineId: l.id }, reason: input.reason })),
            'commitment',
          );
        }
        await recordAudit(tx, { projectId, actor, action: 'labour.po.closeShort', entity: 'LabourPurchaseOrderVersion', entityId: current.id });
        const closed = await this.currentVersion(tx, projectId, poId);
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'labour.po.closed_short', entityType: 'LabourPurchaseOrder', entityId: poId,
          payload: this.poPayload(poId, closed) as unknown as Prisma.InputJsonValue,
          effectKey: 'labour.po.closed_short', dispatch: {},
        });
        return { resultRef: poId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readPo(projectId, poId, user);
  }

  private poPayload(poId: string, version: VersionRow): { poId: string; version: number; lines: Array<{ poLineId: string; requisitionLineId: string; requirementId: string; revision: number; civilDate: string; shift: string; personShiftQty: number; committedAmountBase: string; labourSpecFingerprint: string }> } {
    return {
      poId, version: version.version,
      lines: version.lines.map((l) => ({
        poLineId: l.id, requisitionLineId: l.requisitionLineId, requirementId: l.requirementId, revision: l.revision,
        civilDate: toIsoCivilDate(l.civilDate) ?? '', shift: l.shift, personShiftQty: l.personShiftQty,
        committedAmountBase: l.committedAmountBase.toString(), labourSpecFingerprint: l.labourSpecFingerprint,
      })),
    };
  }

  // ── CapacityCommitment (inbound forecast) + append-only promises ─────────────────────────────

  /** Commit inbound capacity for ONE issued PO line — the first dated promise (one commitment per line). */
  async commitCapacity(projectId: string, input: CommitCapacityInput, user: AuthUser, idempotencyKey?: string): Promise<CapacityCommitmentDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertCommit(user);
    const promised = fromIsoCivilDate(input.promisedDate);
    if (!promised) throw new BadRequestException('promisedDate must be an ISO civil date');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.commitment.commit', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const line = await tx.labourPurchaseOrderLine.findFirst({
          where: { projectId, id: input.poLineId },
          select: {
            id: true, poVersionId: true, labourSpecFingerprint: true, civilDate: true, shift: true, personShiftQty: true,
            poVersion: { select: { status: true } },
          },
        });
        if (!line) throw new NotFoundException('Labour purchase order line not found in this project');
        if (line.poVersion.status !== 'issued' && line.poVersion.status !== 'partially_committed') {
          throw new ConflictException('Capacity is committed against a line of an ISSUED labour purchase order version');
        }
        // EXACTLY ONE commitment per PO line (the partial unique is the backstop)
        const existing = await tx.capacityCommitment.findFirst({ where: { projectId, poLineId: line.id }, select: { id: true } });
        if (existing) throw new ConflictException('This PO line already has its capacity commitment — REVISE it instead of committing a second one');
        const commitment = await tx.capacityCommitment.create({
          data: {
            projectId, poLineId: line.id, labourSpecFingerprint: line.labourSpecFingerprint,
            civilDate: line.civilDate, shift: line.shift, personShiftQty: line.personShiftQty, createdById: actor.actorId,
          },
        });
        await tx.capacityPromise.create({
          data: { projectId, commitmentId: commitment.id, seq: 1, promisedDate: promised, recordedById: actor.actorId },
        });
        // F1 — the SINGLE transactional lifecycle: the line's committed progress + the version status
        // move together, so the committed slice stays allocated (§F bound 2) across the PO lifecycle.
        await tx.labourPurchaseOrderLine.updateMany({ where: { projectId, id: line.id }, data: { committedQty: line.personShiftQty } });
        await this.recomputeVersionStatus(tx, projectId, line.poVersionId);
        await this.evaluateBudgetForLine(tx, projectId, actor, user.role, line.id);
        await recordAudit(tx, { projectId, actor, action: 'labour.commitment.commit', entity: 'CapacityCommitment', entityId: commitment.id });
        const full = await tx.capacityCommitment.findFirstOrThrow({ where: { projectId, id: commitment.id }, include: { promises: true } });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'capacity.committed', entityType: 'CapacityCommitment', entityId: commitment.id,
          payload: this.capacityPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'capacity.committed', dispatch: {},
        });
        return { resultRef: commitment.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readCommitment(projectId, outcome.resultRef);
  }

  /** committed|revised → revised: APPENDS the next dated promise (reason required). */
  async reviseCapacity(projectId: string, commitmentId: string, input: ReviseCapacityInput, user: AuthUser, idempotencyKey?: string): Promise<CapacityCommitmentDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertCommit(user);
    const promised = fromIsoCivilDate(input.promisedDate);
    if (!promised) throw new BadRequestException('promisedDate must be an ISO civil date');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.commitment.revise', idempotencyKey, requestHash: hashRequest({ commitmentId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.capacityCommitment.updateMany({
          where: { id: commitmentId, projectId, status: { in: ['committed', 'revised'] } }, data: { status: 'revised' },
        });
        if (count === 0) throw new ConflictException('Only a live (committed/revised) capacity commitment can be revised — reload and retry');
        const head = await tx.capacityPromise.findFirstOrThrow({ where: { projectId, commitmentId }, orderBy: { seq: 'desc' }, select: { seq: true } });
        await tx.capacityPromise.create({
          data: { projectId, commitmentId, seq: head.seq + 1, promisedDate: promised, reason: input.reason, recordedById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'labour.commitment.revise', entity: 'CapacityCommitment', entityId: commitmentId });
        const full = await tx.capacityCommitment.findFirstOrThrow({ where: { projectId, id: commitmentId }, include: { promises: true } });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'capacity.revised', entityType: 'CapacityCommitment', entityId: commitmentId,
          payload: this.capacityPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'capacity.revised', dispatch: {},
        });
        return { resultRef: commitmentId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readCommitment(projectId, commitmentId);
  }

  /** committed|revised → defaulted: the source missed the latest promise (drives §A at-risk). */
  async defaultCapacity(projectId: string, commitmentId: string, user: AuthUser, idempotencyKey?: string): Promise<CapacityCommitmentDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertCommit(user);
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.commitment.default', idempotencyKey, requestHash: hashRequest({ commitmentId }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.capacityCommitment.updateMany({
          where: { id: commitmentId, projectId, status: { in: ['committed', 'revised'] } },
          data: { status: 'defaulted', defaultedAt: new Date() },
        });
        if (count === 0) throw new ConflictException('Only a live (committed/revised) capacity commitment can be defaulted — reload and retry');
        // F1 — a defaulted commitment RELEASES its line's committed progress; the version status is
        // recomputed so the freed slice can be re-procured (a terminal PO version is left untouched).
        const defaulted = await tx.capacityCommitment.findFirstOrThrow({ where: { projectId, id: commitmentId }, select: { poLineId: true, poLine: { select: { poVersionId: true, requisitionLineId: true, requisitionId: true } } } });
        await tx.labourPurchaseOrderLine.updateMany({ where: { projectId, id: defaulted.poLineId }, data: { committedQty: 0 } });
        await this.recomputeVersionStatus(tx, projectId, defaulted.poLine.poVersionId);
        await this.evaluateBudgetForLine(tx, projectId, actor, user.role, defaulted.poLineId);
        // R2 — the freed slice's requisition line must reflect its now-ZERO live allocation: a
        // defaulted PO line covers nothing (it can never be re-committed), so the line reopens to
        // 'open' whether the version returned to issued/partially_committed or was closed short —
        // UNLESS another live PO still covers the slice. refreshOrderedFlag re-derives it from truth.
        await this.refreshOrderedFlag(tx, projectId, defaulted.poLine.requisitionLineId);
        // R3 — the default may land AFTER the requisition was closed. If it removes required coverage,
        // the terminal state would be a CLOSED parent containing an OPEN (uncovered) child — incoherent.
        // Atomically reopen the requisition (closed → approved, clear closedAt) so its state stays
        // coherent; the freed line stays 'open' to be re-sourced. Same readiness lock + a CAS transition.
        await this.reopenRequisitionIfUncovered(tx, projectId, defaulted.poLine.requisitionId, actor);
        await recordAudit(tx, { projectId, actor, action: 'labour.commitment.default', entity: 'CapacityCommitment', entityId: commitmentId });
        const full = await tx.capacityCommitment.findFirstOrThrow({ where: { projectId, id: commitmentId }, include: { promises: true } });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'capacity.defaulted', entityType: 'CapacityCommitment', entityId: commitmentId,
          payload: this.capacityPayload(full) as unknown as Prisma.InputJsonValue,
          effectKey: 'capacity.defaulted', dispatch: {},
        });
        return { resultRef: commitmentId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    return this.readCommitment(projectId, commitmentId);
  }

  private capacityPayload(c: CommitmentRow): { commitmentId: string; poLineId: string; labourSpecFingerprint: string; civilDate: string; shift: string; personShiftQty: number; promisedDate: string } {
    const history = [...c.promises].sort((a, b) => a.seq - b.seq);
    const latest = history[history.length - 1]!;
    return {
      commitmentId: c.id, poLineId: c.poLineId, labourSpecFingerprint: c.labourSpecFingerprint,
      civilDate: toIsoCivilDate(c.civilDate) ?? '', shift: c.shift, personShiftQty: c.personShiftQty,
      promisedDate: toIsoCivilDate(latest.promisedDate) ?? '',
    };
  }

  // ── reads (route AND service enforce labour.read) ────────────────────────────────────────────

  private async readRequisition(projectId: string, requisitionId: string): Promise<LabourRequisitionDto> {
    const row = await this.prisma.labourRequisition.findFirstOrThrow({ where: { projectId, id: requisitionId }, include: { lines: true } });
    return serializeRequisition(row);
  }

  async listRequisitions(projectId: string, user: AuthUser): Promise<{ requisitions: LabourRequisitionDto[] }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    const rows = await this.prisma.labourRequisition.findMany({ where: { projectId }, include: { lines: true }, orderBy: { createdAt: 'asc' } });
    return { requisitions: rows.map(serializeRequisition) };
  }

  async readRfq(projectId: string, rfqId: string, user: AuthUser): Promise<LabourRfqDto> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    const rfq = await this.prisma.labourRfq.findFirst({
      where: { id: rfqId, projectId },
      include: { quotes: { include: { lines: true }, orderBy: { recordedAt: 'asc' } }, comparison: true },
    });
    if (!rfq) throw new NotFoundException('Labour RFQ not found');
    return {
      id: rfq.id, requisitionId: rfq.requisitionId, status: rfq.status,
      issuedAt: rfq.issuedAt.toISOString(), issuedById: rfq.issuedById,
      quotes: rfq.quotes.map(serializeQuote),
      comparison: rfq.comparison ? serializeComparison(rfq.comparison) : null,
    };
  }

  async listRfqs(projectId: string, user: AuthUser): Promise<{ rfqs: LabourRfqDto[] }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    const rows = await this.prisma.labourRfq.findMany({
      where: { projectId },
      include: { quotes: { include: { lines: true }, orderBy: { recordedAt: 'asc' } }, comparison: true },
      orderBy: { issuedAt: 'asc' },
    });
    return {
      rfqs: rows.map((rfq) => ({
        id: rfq.id, requisitionId: rfq.requisitionId, status: rfq.status,
        issuedAt: rfq.issuedAt.toISOString(), issuedById: rfq.issuedById,
        quotes: rfq.quotes.map(serializeQuote),
        comparison: rfq.comparison ? serializeComparison(rfq.comparison) : null,
      })),
    };
  }

  async readPo(projectId: string, poId: string, user: AuthUser): Promise<LabourPurchaseOrderDto> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    const row = await this.prisma.labourPurchaseOrder.findFirst({ where: { projectId, id: poId }, include: { versions: { include: { lines: true } } } });
    if (!row) throw new NotFoundException('Labour purchase order not found');
    return serializePo(row);
  }

  async listPos(projectId: string, user: AuthUser): Promise<{ purchaseOrders: LabourPurchaseOrderDto[] }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    const rows = await this.prisma.labourPurchaseOrder.findMany({ where: { projectId }, include: { versions: { include: { lines: true } } }, orderBy: { createdAt: 'asc' } });
    return { purchaseOrders: rows.map(serializePo) };
  }

  private async readCommitment(projectId: string, commitmentId: string): Promise<CapacityCommitmentDto> {
    const row = await this.prisma.capacityCommitment.findFirstOrThrow({ where: { projectId, id: commitmentId }, include: { promises: true } });
    return serializeCommitment(row);
  }

  async listCommitments(projectId: string, user: AuthUser): Promise<{ commitments: CapacityCommitmentDto[] }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    const rows = await this.prisma.capacityCommitment.findMany({ where: { projectId }, include: { promises: true }, orderBy: { createdAt: 'asc' } });
    return { commitments: rows.map(serializeCommitment) };
  }
}
