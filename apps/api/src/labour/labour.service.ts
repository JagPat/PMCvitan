import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLE_POLICY, type LabourWorkforceDto, type LabourCatalogDto, type WorkerDto, type CrewDto } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../platform/capabilities.service';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { recordAudit } from '../platform/audit';
import { resolveActor } from '../common/actor';
import { fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import type { AuthUser } from '../common/auth';
import type {
  UpsertLabourTradeInput, UpsertLabourSkillInput, OnboardWorkerInput, RevokeWorkerInput,
  FormCrewInput, AddCrewMemberInput, RemoveCrewMemberInput,
} from '../contracts';

type WorkerRow = Prisma.WorkerGetPayload<{ include: { devices: true } }>;
type CrewRow = Prisma.CrewGetPayload<{ include: { members: true } }>;

function serializeWorker(w: WorkerRow): WorkerDto {
  return {
    id: w.id,
    name: w.name,
    tradeCode: w.tradeCode,
    skillCodes: w.skillCodes,
    activeFrom: toIsoCivilDate(w.activeFrom) ?? '',
    activeTo: w.activeTo ? (toIsoCivilDate(w.activeTo) ?? null) : null,
    revokedAt: w.revokedAt ? w.revokedAt.toISOString() : null,
    revokedById: w.revokedById,
    createdAt: w.createdAt.toISOString(),
    createdById: w.createdById,
    devices: [...w.devices]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((d) => ({ id: d.id, name: d.name, trade: d.trade, boundAt: d.createdAt.toISOString() })),
  };
}

function serializeCrew(c: CrewRow): CrewDto {
  return {
    id: c.id,
    name: c.name,
    inchargeWorkerId: c.inchargeWorkerId,
    activeFrom: toIsoCivilDate(c.activeFrom) ?? '',
    activeTo: c.activeTo ? (toIsoCivilDate(c.activeTo) ?? null) : null,
    revokedAt: c.revokedAt ? c.revokedAt.toISOString() : null,
    members: [...c.members]
      .sort((a, b) => a.addedAt.getTime() - b.addedAt.getTime())
      .map((m) => ({ workerId: m.workerId, addedAt: m.addedAt.toISOString(), removedAt: m.removedAt ? m.removedAt.toISOString() : null })),
  };
}

/**
 * Phase 4 Task 1 — the labour LEAF module's trusted-identity onboarding (plan §H).
 *
 * Writes ONLY labour-owned tables (LabourTrade/Skill, Worker, Crew, CrewMembership). Every row
 * is project-contained; a cross-project reference is unrepresentable in PostgreSQL (same-project
 * composite FKs proven by the forgery probe). Onboarding is `pmc` authority (`labour.manage`),
 * capability-gated (§D — 404 off-pilot). It is a ROSTER surface: attributable via `recordAudit`,
 * idempotent via the command ledger, but it emits NO domain event (labour capacity facts —
 * allocation/attendance/work — arrive in Tasks 3–5 with their own event family). So this service
 * dispatches nothing (the acyclic leaf reaches no other module here).
 */
@Injectable()
export class LabourService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
  ) {}

  /** `labour.manage` is pmc authority (§H). The route guard enforces it too; this is the
   *  service-level backstop so a direct caller cannot bypass the allowlist. */
  private assertManage(user: AuthUser): void {
    if (!(ROLE_POLICY['labour.manage'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Labour workforce management is a pmc surface');
    }
  }

  /** `labour.read` is a pmc/engineer surface (§H). Route-guarded too; this is the backstop. */
  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['labour.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The labour workforce register is a pmc/engineer surface');
    }
  }

  private scope(projectId: string): CommandScope {
    return { scopeKind: 'project', projectId };
  }

  async upsertTrade(projectId: string, input: UpsertLabourTradeInput, user: AuthUser, idempotencyKey?: string): Promise<{ code: string; name: string }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertManage(user);
    const actor = await resolveActor(this.prisma, user);
    await executeCommand(this.prisma, {
      scope: this.scope(projectId), actor, commandType: 'labour.trade.define', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        await tx.labourTrade.upsert({
          where: { projectId_code: { projectId, code: input.code } },
          create: { projectId, code: input.code, name: input.name, createdById: actor.actorId },
          update: { name: input.name },
        });
        await recordAudit(tx, { projectId, actor, action: 'labour.trade.define', entity: 'LabourTrade', entityId: `${projectId}:${input.code}` });
        return { resultRef: `${projectId}:${input.code}`, events: [] };
      },
    });
    return { code: input.code, name: input.name };
  }

  async upsertSkill(projectId: string, input: UpsertLabourSkillInput, user: AuthUser, idempotencyKey?: string): Promise<{ code: string; name: string }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertManage(user);
    const actor = await resolveActor(this.prisma, user);
    await executeCommand(this.prisma, {
      scope: this.scope(projectId), actor, commandType: 'labour.skill.define', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        await tx.labourSkill.upsert({
          where: { projectId_code: { projectId, code: input.code } },
          create: { projectId, code: input.code, name: input.name, createdById: actor.actorId },
          update: { name: input.name },
        });
        await recordAudit(tx, { projectId, actor, action: 'labour.skill.define', entity: 'LabourSkill', entityId: `${projectId}:${input.code}` });
        return { resultRef: `${projectId}:${input.code}`, events: [] };
      },
    });
    return { code: input.code, name: input.name };
  }

  /** Onboard a trusted, project-contained Worker (§H). The trade is a same-project catalog entry
   *  (FK backstop); the skill codes are validated against the same-project skill catalog. */
  async onboardWorker(projectId: string, input: OnboardWorkerInput, user: AuthUser, idempotencyKey?: string): Promise<{ id: string }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertManage(user);
    const actor = await resolveActor(this.prisma, user);
    const activeFrom = fromIsoCivilDate(input.activeFrom);
    if (!activeFrom) throw new BadRequestException('activeFrom must be an ISO civil date');
    const activeTo = input.activeTo == null ? null : fromIsoCivilDate(input.activeTo);
    if (input.activeTo != null && !activeTo) throw new BadRequestException('activeTo must be an ISO civil date');
    if (activeTo && activeTo < activeFrom) throw new BadRequestException('activeTo must not be before activeFrom');
    const skillCodes = [...new Set(input.skillCodes)];
    const outcome = await executeCommand(this.prisma, {
      scope: this.scope(projectId), actor, commandType: 'labour.worker.onboard', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        const trade = await tx.labourTrade.findUnique({ where: { projectId_code: { projectId, code: input.tradeCode } }, select: { code: true } });
        if (!trade) throw new BadRequestException(`tradeCode "${input.tradeCode}" is not a trade in this project's catalog`);
        for (const code of skillCodes) {
          const skill = await tx.labourSkill.findUnique({ where: { projectId_code: { projectId, code } }, select: { code: true } });
          if (!skill) throw new BadRequestException(`skillCode "${code}" is not a skill in this project's catalog`);
        }
        const created = await tx.worker.create({
          data: { projectId, name: input.name, tradeCode: input.tradeCode, skillCodes, activeFrom, activeTo, createdById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'labour.worker.onboard', entity: 'Worker', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    return { id: outcome.resultRef };
  }

  async revokeWorker(projectId: string, workerId: string, input: RevokeWorkerInput, user: AuthUser, idempotencyKey?: string): Promise<{ id: string }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertManage(user);
    const actor = await resolveActor(this.prisma, user);
    const outcome = await executeCommand(this.prisma, {
      scope: this.scope(projectId), actor, commandType: 'labour.worker.revoke', idempotencyKey, requestHash: hashRequest({ workerId, ...input }),
      run: async (tx) => {
        const worker = await tx.worker.findFirst({ where: { id: workerId, projectId }, select: { id: true, revokedAt: true } });
        if (!worker) throw new NotFoundException('Worker not found');
        if (worker.revokedAt) throw new BadRequestException('Worker is already revoked');
        await tx.worker.update({ where: { id: workerId }, data: { revokedAt: new Date(), revokedById: actor.actorId } });
        await recordAudit(tx, { projectId, actor, action: 'labour.worker.revoke', entity: 'Worker', entityId: workerId });
        return { resultRef: workerId, events: [] };
      },
    });
    return { id: outcome.resultRef };
  }

  async formCrew(projectId: string, input: FormCrewInput, user: AuthUser, idempotencyKey?: string): Promise<{ id: string }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertManage(user);
    const actor = await resolveActor(this.prisma, user);
    const activeFrom = fromIsoCivilDate(input.activeFrom);
    if (!activeFrom) throw new BadRequestException('activeFrom must be an ISO civil date');
    const activeTo = input.activeTo == null ? null : fromIsoCivilDate(input.activeTo);
    if (input.activeTo != null && !activeTo) throw new BadRequestException('activeTo must be an ISO civil date');
    if (activeTo && activeTo < activeFrom) throw new BadRequestException('activeTo must not be before activeFrom');
    const outcome = await executeCommand(this.prisma, {
      scope: this.scope(projectId), actor, commandType: 'labour.crew.form', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        if (input.inchargeWorkerId) {
          const incharge = await tx.worker.findFirst({ where: { id: input.inchargeWorkerId, projectId }, select: { id: true } });
          if (!incharge) throw new BadRequestException('inchargeWorkerId does not name a worker in this project');
        }
        const created = await tx.crew.create({
          data: { projectId, name: input.name, inchargeWorkerId: input.inchargeWorkerId ?? null, activeFrom, activeTo, createdById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'labour.crew.form', entity: 'Crew', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    return { id: outcome.resultRef };
  }

  async addCrewMember(projectId: string, crewId: string, input: AddCrewMemberInput, user: AuthUser, idempotencyKey?: string): Promise<{ id: string }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertManage(user);
    const actor = await resolveActor(this.prisma, user);
    const outcome = await executeCommand(this.prisma, {
      scope: this.scope(projectId), actor, commandType: 'labour.crew.addMember', idempotencyKey, requestHash: hashRequest({ crewId, ...input }),
      run: async (tx) => {
        const crew = await tx.crew.findFirst({ where: { id: crewId, projectId }, select: { id: true } });
        if (!crew) throw new NotFoundException('Crew not found');
        const worker = await tx.worker.findFirst({ where: { id: input.workerId, projectId }, select: { id: true } });
        if (!worker) throw new BadRequestException('workerId does not name a worker in this project');
        // the partial-unique index enforces one ACTIVE membership per (crew, worker); a friendlier
        // pre-check gives a clear 400 (the DB is the backstop under a race)
        const existing = await tx.crewMembership.findFirst({ where: { projectId, crewId, workerId: input.workerId, removedAt: null }, select: { id: true } });
        if (existing) throw new BadRequestException('Worker is already an active member of this crew');
        const created = await tx.crewMembership.create({
          data: { projectId, crewId, workerId: input.workerId, addedById: actor.actorId },
        });
        await recordAudit(tx, { projectId, actor, action: 'labour.crew.addMember', entity: 'CrewMembership', entityId: created.id });
        return { resultRef: created.id, events: [] };
      },
    });
    return { id: outcome.resultRef };
  }

  async removeCrewMember(projectId: string, crewId: string, workerId: string, input: RemoveCrewMemberInput, user: AuthUser, idempotencyKey?: string): Promise<{ id: string }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertManage(user);
    const actor = await resolveActor(this.prisma, user);
    const outcome = await executeCommand(this.prisma, {
      scope: this.scope(projectId), actor, commandType: 'labour.crew.removeMember', idempotencyKey, requestHash: hashRequest({ crewId, workerId, ...input }),
      run: async (tx) => {
        const membership = await tx.crewMembership.findFirst({ where: { projectId, crewId, workerId, removedAt: null }, select: { id: true } });
        if (!membership) throw new NotFoundException('No active membership for this worker in this crew');
        await tx.crewMembership.update({ where: { id: membership.id }, data: { removedAt: new Date(), removedById: actor.actorId } });
        await recordAudit(tx, { projectId, actor, action: 'labour.crew.removeMember', entity: 'CrewMembership', entityId: membership.id });
        return { resultRef: membership.id, events: [] };
      },
    });
    return { id: outcome.resultRef };
  }

  // ── Queries (labour.workforce / labour.catalog) ─────────────────────────────────────────────
  // Capability-gated (§D — 404 off-pilot) + pmc/engineer read authority (§H). Reads labour-owned
  // tables only; a non-pilot project has no labour rows and the gate 404s before any read runs.

  /** `labour.workforce` — the project's trusted workforce register (workers + crews). */
  async workforce(projectId: string, user: AuthUser): Promise<LabourWorkforceDto> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    const [workers, crews] = await Promise.all([
      this.prisma.worker.findMany({ where: { projectId }, include: { devices: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.prisma.crew.findMany({ where: { projectId }, include: { members: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    ]);
    return { workers: workers.map(serializeWorker), crews: crews.map(serializeCrew) };
  }

  /** `labour.catalog` — the project's trade/skill catalog. */
  async catalog(projectId: string, user: AuthUser): Promise<LabourCatalogDto> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    const [trades, skills] = await Promise.all([
      this.prisma.labourTrade.findMany({ where: { projectId }, orderBy: { code: 'asc' } }),
      this.prisma.labourSkill.findMany({ where: { projectId }, orderBy: { code: 'asc' } }),
    ]);
    return {
      trades: trades.map((t) => ({ code: t.code, name: t.name })),
      skills: skills.map((s) => ({ code: s.code, name: s.name })),
    };
  }
}
