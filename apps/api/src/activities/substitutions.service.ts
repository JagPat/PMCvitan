import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { computeSpecFingerprint, isBaseUom, normalizeSpecText } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../platform/capabilities.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { lockProjectReadiness } from '../common/readiness-lock';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type { ApproveSubstitutionInput, RevokeSubstitutionInput } from '../contracts';

/**
 * Phase 3 Task 6 — approved material substitutions (plan §B satisfaction rule; §A lock table).
 *
 * A substitution lets accepted stock of ONE specification satisfy a requirement pinned to a
 * DIFFERENT specification. It is pmc authority (§H), per requirement ROOT, audited and
 * event-bearing. The alternative material is DESCRIBED by the caller; the server computes its
 * `toFingerprint` through the ONE shared fingerprint function (never caller-authored — the
 * Task-1 provenance discipline), and resolves the requirement's own `fromFingerprint` from its
 * head revision's material spec. Revocation NEVER deletes the row — it stamps
 * `revoked{At,ById,Reason}` (the DB trigger enforces that the stamp is complete and terminal),
 * and coverage re-derives WITHOUT the substitution from that point on.
 *
 * Both commands take `lockProjectReadiness` inside their transaction (§A): they change what
 * `coverageFor` returns, so they serialize against `activities.start` and every other
 * readiness-affecting write on the same per-project advisory lock.
 */

type SubRow = Prisma.ApprovedSubstitutionGetPayload<Record<string, never>>;

export interface SubstitutionDto {
  id: string;
  requirementId: string;
  fromFingerprint: string;
  toFingerprint: string;
  reason: string;
  approvedById: string;
  at: string;
  revokedAt: string | null;
  revokedById: string | null;
  revokeReason: string | null;
}

function serialize(s: SubRow): SubstitutionDto {
  return {
    id: s.id,
    requirementId: s.requirementId,
    fromFingerprint: s.fromFingerprint,
    toFingerprint: s.toFingerprint,
    reason: s.reason,
    approvedById: s.approvedById,
    at: s.at.toISOString(),
    revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
    revokedById: s.revokedById,
    revokeReason: s.revokeReason,
  };
}

@Injectable()
export class SubstitutionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly dispatcher: ExternalEffectDispatcher,
  ) {}

  /**
   * The ACTIVE substitution targets per requirement — used by the coverage requirement loader
   * to build `acceptableFingerprints`. Read INSIDE the caller's readiness transaction so the
   * coverage answer reflects approvals/revocations committed before it. Returns
   * `requirementId → [toFingerprint, …]` for substitutions with `revokedAt IS NULL`.
   */
  async activeTargets(
    tx: Prisma.TransactionClient,
    projectId: string,
    requirementIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    if (requirementIds.length === 0) return map;
    const rows = await tx.approvedSubstitution.findMany({
      where: { projectId, requirementId: { in: [...requirementIds] }, revokedAt: null },
      select: { requirementId: true, toFingerprint: true },
    });
    for (const r of rows) {
      const list = map.get(r.requirementId) ?? [];
      list.push(r.toFingerprint);
      map.set(r.requirementId, list);
    }
    return map;
  }

  async approve(projectId: string, requirementId: string, input: ApproveSubstitutionInput, user: AuthUser, idempotencyKey?: string): Promise<SubstitutionDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    if (!isBaseUom(input.baseUom)) throw new BadRequestException('baseUom must be one of the supported base units');
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ requirementId, ...input });
    const toFingerprint = await computeSpecFingerprint({
      materialCategory: normalizeSpecText(input.materialCategory),
      make: normalizeSpecText(input.make),
      grade: normalizeSpecText(input.grade),
      normalizedAttributes: normalizeSpecText(input.attributes ?? ''),
      baseUom: input.baseUom,
    });
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'substitutions.approve', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        // the requirement head revision anchors the `fromFingerprint` (server-resolved, never
        // caller-authored) and proves the requirement is a material requirement in this project
        const head = await tx.activityRequirement.findFirst({
          where: { projectId, requirementId },
          orderBy: { revision: 'desc' },
          select: { type: true, baseUom: true, status: true, materialSpec: { select: { specFingerprint: true } } },
        });
        if (!head) throw new NotFoundException('Requirement not found in this project');
        if (head.type !== 'material' || !head.materialSpec) throw new BadRequestException('Only a material requirement can carry a substitution');
        if (head.status === 'cancelled') throw new BadRequestException('A cancelled requirement cannot take a substitution');
        if (head.baseUom !== input.baseUom) throw new BadRequestException('The substitute material must share the requirement base UOM (coverage arithmetic runs in base UOM only)');
        const fromFingerprint = head.materialSpec.specFingerprint;
        if (toFingerprint === fromFingerprint) throw new BadRequestException('The substitute material is identical to the requirement — no substitution needed');
        const created = await tx.approvedSubstitution.create({
          data: { projectId, requirementId, fromFingerprint, toFingerprint, reason: input.reason, approvedById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'substitution.approve', entity: 'ApprovedSubstitution', entityId: created.id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'substitution.approved', entityType: 'ApprovedSubstitution', entityId: created.id,
          payload: { requirementId, fromFingerprint, toFingerprint, reason: input.reason } as Prisma.InputJsonValue,
          effectKey: 'substitution.approved', dispatch: {},
        });
        return { resultRef: created.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.approvedSubstitution.findUniqueOrThrow({ where: { id: outcome.resultRef } });
    return serialize(row);
  }

  async revoke(projectId: string, substitutionId: string, input: RevokeSubstitutionInput, user: AuthUser, idempotencyKey?: string): Promise<SubstitutionDto> {
    await this.capabilities.assertEnabled(projectId, MATERIALS_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const requestHash = hashRequest({ substitutionId, ...input });
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'substitutions.revoke', idempotencyKey, requestHash,
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        // lock the row FOR UPDATE so a concurrent revoke serializes (the DB trigger also refuses
        // a second stamp — belt and suspenders)
        const rows = await tx.$queryRaw<Array<{ id: string; revokedAt: Date | null; requirementId: string; fromFingerprint: string; toFingerprint: string }>>`
          SELECT "id", "revokedAt", "requirementId", "fromFingerprint", "toFingerprint"
          FROM "ApprovedSubstitution"
          WHERE "projectId" = ${projectId} AND "id" = ${substitutionId} FOR UPDATE`;
        const sub = rows[0];
        if (!sub) throw new NotFoundException('Substitution not found in this project');
        if (sub.revokedAt) throw new ConflictException('Substitution is already revoked');
        await tx.approvedSubstitution.update({
          where: { id: substitutionId },
          data: { revokedAt: new Date(), revokedById: actor.actorId, revokeReason: input.reason },
        });
        await recordAudit(tx, { projectId, actor, action: 'substitution.revoke', entity: 'ApprovedSubstitution', entityId: substitutionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'substitution.revoked', entityType: 'ApprovedSubstitution', entityId: substitutionId,
          payload: { requirementId: sub.requirementId, fromFingerprint: sub.fromFingerprint, toFingerprint: sub.toFingerprint, reason: input.reason } as Prisma.InputJsonValue,
          effectKey: 'substitution.revoked', dispatch: {},
        });
        return { resultRef: substitutionId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.approvedSubstitution.findUniqueOrThrow({ where: { id: outcome.resultRef } });
    return serialize(row);
  }
}
