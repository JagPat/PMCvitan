import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ROLE_POLICY, computeLabourSpecFingerprint, isLabourShift,
  type LabourCapacityDto, type WorkerAllocationDto, type LabourAttendanceDto,
  type LabourWorkFactDto, type ApprovedSkillSubstitutionDto, type LabourReadinessDto,
  type LabourMismatchDto, type LabourPresenceDto,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../platform/capabilities.service';
import { ActivityParticipant } from '../activities/activity.participant';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { lockProjectReadiness } from '../common/readiness-lock';
import { fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import { executeCommand, hashRequest, type CommandScope, type CommandTx } from '../platform/commands';
import { resolveActor, type Actor } from '../common/actor';
import type { AuthUser } from '../common/auth';
import type {
  AllocateLabourInput, ReleaseLabourAllocationInput, RecordAttendanceInput, RevokeAttendanceInput,
  RecordLabourWorkInput, ApproveSkillSubstitutionInput, RevokeSkillSubstitutionInput,
  RecordLabourMismatchInput, ResolveLabourMismatchInput,
} from '../contracts';
import { computeLabourReadinessDto } from './labour-readiness.projection';

/**
 * Phase 4 Task 3 — the §C TIME-CAPACITY facts (plan §C/§F bound 3/§H).
 *
 * Labour is EXPIRING, time-bounded capacity, so this is NOT a stock ledger: there is no
 * current-quantity column, no bucket and no transfer. Four families, each with its OWN unit:
 *
 *   `WorkerAllocation`          1 person-shift    frozen-identity CAS (`active → released`)
 *   `LabourAttendance`          headcount (1)     append-only observation, revocable correction
 *   `LabourWorkFact`            worked-minutes    append-only observation, bounded cumulatively
 *   `ApprovedSkillSubstitution` (authorization)   pmc-authored §B widening, revocable
 *
 * CONSERVATION IS AT THE `Worker` (round-2 finding 1). A `Crew` is organizational only: allocating
 * one EXPANDS transactionally into one `WorkerAllocation` per ACTIVE member, so a worker booked
 * twice directly, via two crews, or directly-and-via-crew all collide on the ONE partial unique
 * `(projectId, workerId, civilDate, shift) WHERE status='active'`. Every allocating transaction
 * takes `lockProjectReadiness` and then `SELECT … FOR UPDATE` on each `Worker` in STABLE ASCENDING
 * `workerId` ORDER (round-3 guardrail 1) — two overlapping crews sharing members therefore take
 * the shared locks in the same order and cannot deadlock.
 *
 * LEAF PRESERVATION: this service reads Labour-owned tables only. The activity target is validated
 * through `ActivityParticipant.labourTarget` — the cycle-exempt `labour → activities` workflow
 * participant edge, never a Procurement/Activities read dependency — and the same-project composite
 * FKs are the database backstop. So `labour.dependsOn` stays `[]`.
 *
 * Every fact records its `sourceCommandId` (§C rule ii — a keyed replay appends NOTHING) and emits
 * ONE signal-only event per row.
 */

/** One shift is 12 hours. The per-row CHECK bounds a single record; the CUMULATIVE bound per
 *  `(worker, civilDate, shift)` is re-derived under the worker `FOR UPDATE` (round-3 guardrail 2 —
 *  a per-row CHECK alone cannot stop several rows summing past the shift). */
export const SHIFT_MINUTES = 720;

type MismatchRow = Prisma.LabourMismatchGetPayload<{ include: { resolution: true } }>;
function serializeMismatch(m: MismatchRow): LabourMismatchDto {
  return {
    id: m.id, activityId: m.activityId, civilDate: toIsoCivilDate(m.civilDate) ?? '', shift: m.shift,
    kind: m.kind as LabourMismatchDto['kind'], workerId: m.workerId, note: m.note,
    recordedAt: m.recordedAt.toISOString(), recordedById: m.recordedById,
    resolution: m.resolution
      ? { resolution: m.resolution.resolution, reason: m.resolution.reason, resolvedAt: m.resolution.resolvedAt.toISOString(), resolvedById: m.resolution.resolvedById }
      : null,
  };
}

type AllocationRow = Prisma.WorkerAllocationGetPayload<Record<string, never>>;
type AttendanceRow = Prisma.LabourAttendanceGetPayload<Record<string, never>>;
type WorkFactRow = Prisma.LabourWorkFactGetPayload<Record<string, never>>;
type SubstitutionRow = Prisma.ApprovedSkillSubstitutionGetPayload<Record<string, never>>;

function serializeAllocation(a: AllocationRow): WorkerAllocationDto {
  return {
    id: a.id,
    workerId: a.workerId,
    civilDate: toIsoCivilDate(a.civilDate) ?? '',
    shift: a.shift,
    activityId: a.activityId,
    requirementId: a.requirementId,
    originRevision: a.originRevision,
    labourSpecFingerprint: a.labourSpecFingerprint,
    crewId: a.crewId,
    capacityCommitmentId: a.capacityCommitmentId,
    status: a.status,
    allocatedAt: a.allocatedAt.toISOString(),
    allocatedById: a.allocatedById,
    releasedAt: a.releasedAt ? a.releasedAt.toISOString() : null,
    releasedById: a.releasedById,
    releaseReason: a.releaseReason,
  };
}

function serializeAttendance(a: AttendanceRow): LabourAttendanceDto {
  return {
    id: a.id,
    workerId: a.workerId,
    civilDate: toIsoCivilDate(a.civilDate) ?? '',
    shift: a.shift,
    deviceId: a.deviceId,
    manualReason: a.manualReason,
    evidenceMediaId: a.evidenceMediaId,
    recordedAt: a.recordedAt.toISOString(),
    recordedById: a.recordedById,
    revokedAt: a.revokedAt ? a.revokedAt.toISOString() : null,
    revokedById: a.revokedById,
    revokeReason: a.revokeReason,
  };
}

function serializeWorkFact(w: WorkFactRow): LabourWorkFactDto {
  return {
    id: w.id,
    workerId: w.workerId,
    allocationId: w.allocationId,
    activityId: w.activityId,
    civilDate: toIsoCivilDate(w.civilDate) ?? '',
    shift: w.shift,
    workedMinutes: w.workedMinutes,
    note: w.note,
    recordedAt: w.recordedAt.toISOString(),
    recordedById: w.recordedById,
  };
}

function serializeSubstitution(s: SubstitutionRow): ApprovedSkillSubstitutionDto {
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

/** PostgreSQL unique-violation — the DB seal winning a race, reported as a truthful 409. */
function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

@Injectable()
export class LabourCapacityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly activityParticipant: ActivityParticipant,
    private readonly dispatcher: ExternalEffectDispatcher,
  ) {}

  private async begin(projectId: string, user: AuthUser): Promise<{ actor: Actor; scope: CommandScope }> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    const actor = await resolveActor(this.prisma, user);
    return { actor, scope: { scopeKind: 'project', projectId } };
  }

  /** Service-level backstops for the route guards (§H matrix) — a direct caller cannot bypass them. */
  private assertPolicy(user: AuthUser, action: 'allocation.manage' | 'attendance.record' | 'attendance.revoke' | 'labour.work.record' | 'labour.override' | 'labour.mismatch.record' | 'labour.mismatch.resolve', surface: string): void {
    if (!(ROLE_POLICY[action] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException(surface);
    }
  }

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['labour.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The labour capacity register is a pmc/engineer surface');
    }
  }

  /**
   * The requirement's CURRENT head — the ACTIVITIES-owned revision/activity/status joined with the
   * LABOUR-owned technical identity for that exact revision.
   *
   * Task-3 correction F1 + F4: the head used to be derived from the highest
   * `LabourRequirementSpec` revision alone, which is not Activities' truth. That let an allocation
   * pair a requirement with an activity that does not own it, and let a CANCELLED head keep
   * looking allocatable (a cancel APPENDS a revision that copies the labour spec forward, so the
   * labour-side max revision still resolves). The head now comes from
   * `ActivityParticipant.labourRequirementHead` — the cycle-exempt participant channel, so Labour
   * still reads no Activities table directly — and the labour detail is looked up for THAT
   * revision, not the newest labour row.
   */
  private async requirementHead(tx: CommandTx, projectId: string, requirementId: string) {
    // LOCK ORDER (correction 2 re-review, kept; correction 3 finding 2, relocated): the
    // `ActivityRequirementRoot` row is taken FIRST, before any `CapacityCommitment` lock this
    // command will later need. PostgreSQL fires BEFORE INSERT row triggers in NAME order, so a
    // `WorkerAllocation` insert acquires the project readiness lock
    // (`WorkerAllocation_00_project_lock`), then the root (`WorkerAllocation_head_live`), then the
    // commitment (`WorkerAllocation_within_commitment`). Every path requests the same rows in the
    // same order, so one simply waits: a deadlock is impossible by construction, exactly as the
    // ascending-`workerId` rule below does for crews.
    //
    // THE LOCK LIVES IN THE PARTICIPANT, NOT HERE. Labour used to run the root's `SELECT … FOR
    // UPDATE` itself — a raw synchronous read of an Activities-owned, read-encapsulated table from
    // a LEAF module. `ActivityParticipant.labourRequirementHead` now acquires the lock and reads the
    // head as ONE indivisible operation in this transaction, so Labour holds no knowledge of
    // Activities' tables at all and the two halves can never drift apart.
    const head = await this.activityParticipant.labourRequirementHead(tx, { projectId, requirementId });
    if (!head) throw new NotFoundException('No requirement with that id in this project');
    if (head.status === 'cancelled') {
      throw new ConflictException('This requirement is CANCELLED — its demand is dead and cannot be allocated against');
    }
    const spec = await tx.labourRequirementSpec.findUnique({
      where: { projectId_requirementId_revision: { projectId, requirementId, revision: head.revision } },
      select: { revision: true, tradeCode: true, skillCode: true, shift: true, labourSpecFingerprint: true },
    });
    if (!spec) throw new BadRequestException('That requirement is not a LABOUR requirement');
    return { ...spec, activityId: head.activityId };
  }

  /**
   * Lock the given workers in STABLE ASCENDING id order (round-3 guardrail 1). Two transactions
   * allocating overlapping crews therefore request the shared worker locks in the SAME order, so
   * one simply waits for the other — a lock CYCLE (deadlock) is impossible by construction.
   * Returns the locked rows so the caller can validate the roster inside the lock.
   */
  private async lockWorkersInOrder(tx: CommandTx, projectId: string, workerIds: string[]): Promise<Array<{ id: string; revokedAt: Date | null; activeFrom: Date; activeTo: Date | null }>> {
    const ordered = [...new Set(workerIds)].sort();
    if (ordered.length === 0) return [];
    return tx.$queryRaw<Array<{ id: string; revokedAt: Date | null; activeFrom: Date; activeTo: Date | null }>>`
      SELECT "id", "revokedAt", "activeFrom", "activeTo"
      FROM "Worker"
      WHERE "projectId" = ${projectId} AND "id" IN (${Prisma.join(ordered)})
      ORDER BY "id" ASC
      FOR UPDATE`;
  }

  // ── allocation ───────────────────────────────────────────────────────────────────────────────

  /**
   * Allocate ONE worker — or expand a crew into one allocation per ACTIVE member — onto one
   * `(civilDate, shift)` slice of one requirement. The shift and `labourSpecFingerprint` are
   * SERVER-DERIVED from the requirement's head spec, never caller-authored, and the civil date
   * must be one the head revision actually demands (round-2 finding 2: capacity for one slice
   * can never satisfy another).
   */
  async allocate(projectId: string, input: AllocateLabourInput, user: AuthUser, idempotencyKey?: string): Promise<{ allocations: WorkerAllocationDto[] }> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertPolicy(user, 'allocation.manage', 'Allocating labour is a pmc/engineer surface');
    const civilDate = fromIsoCivilDate(input.civilDate);
    if (!civilDate) throw new BadRequestException('civilDate must be an ISO civil date');

    const outcome = await executeCommand<{ ids: string[] }>(this.prisma, {
      scope, actor, commandType: 'labour.allocation.allocate', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        // F1 + F4 — ONE coherent Activities-owned demand identity: the head revision, the activity
        // that OWNS it, and its live status. A cancelled head throws from here.
        const spec = await this.requirementHead(tx, projectId, input.requirementId);
        if (spec.activityId !== input.activityId) {
          throw new BadRequestException(
            `Requirement ${input.requirementId} belongs to activity ${spec.activityId}, not ${input.activityId} — an allocation must name the activity whose demand it serves`,
          );
        }
        // Task 6 review round 3 (P1) — refuse HEAD DRIFT. The client pins the revision it selected
        // the worker against; if the requirement was revised before this command lands (an
        // offline-queued replay), the worker was chosen for a DIFFERENT trade/skill/shift demand,
        // so the stale allocation is refused as a terminal conflict instead of being silently
        // stamped with the NEW head's fingerprint. An unpinned command keeps today's semantics.
        if (input.originRevision != null && input.originRevision !== spec.revision) {
          throw new ConflictException(
            `Requirement ${input.requirementId} is at revision ${spec.revision}, not the selected revision ${input.originRevision} — the demand changed since this allocation was chosen; reload and re-allocate against the current head`,
          );
        }

        // the demanded slice must exist on the HEAD revision — allocating onto a date the current
        // demand does not ask for is a category error, not a shortfall
        const slice = await tx.labourDemandSlice.findFirst({
          where: { projectId, requirementId: input.requirementId, revision: spec.revision, civilDate },
          select: { personShiftQty: true },
        });
        if (!slice) {
          throw new BadRequestException(`Requirement revision ${spec.revision} demands no capacity on ${input.civilDate} — allocate onto one of its demand slices`);
        }

        const activity = await this.activityParticipant.labourTarget(tx, { projectId, activityId: input.activityId });
        if (!activity) throw new BadRequestException('activityId does not name an activity in this project');

        // resolve the atomic capacity sources: one worker, or a crew's ACTIVE members
        let workerIds: string[];
        if (input.workerId) {
          workerIds = [input.workerId];
        } else {
          const crew = await tx.crew.findFirst({ where: { id: input.crewId!, projectId }, select: { id: true, revokedAt: true } });
          if (!crew) throw new NotFoundException('Crew not found in this project');
          if (crew.revokedAt) throw new BadRequestException('Crew is revoked and cannot be allocated');
          const members = await tx.crewMembership.findMany({
            where: { projectId, crewId: crew.id, removedAt: null },
            select: { workerId: true },
          });
          if (members.length === 0) throw new BadRequestException('Crew has no active members to allocate');
          workerIds = members.map((m) => m.workerId);
        }

        // round-3 guardrail 1 — stable ascending lock order, deadlock-free for overlapping crews
        const locked = await this.lockWorkersInOrder(tx, projectId, workerIds);
        const lockedById = new Map(locked.map((w) => [w.id, w]));
        for (const id of workerIds) {
          const w = lockedById.get(id);
          if (!w) throw new BadRequestException(`workerId "${id}" does not name a worker in this project`);
          if (w.revokedAt) throw new BadRequestException(`worker "${id}" is revoked and cannot be allocated`);
          if (civilDate < w.activeFrom || (w.activeTo && civilDate > w.activeTo)) {
            throw new BadRequestException(`worker "${id}" is not active on ${input.civilDate}`);
          }
        }

        // §F bound 3 — drawing down committed supplier capacity. The commitment row is locked
        // FOR UPDATE, so two transactions competing for the last committed person-shift serialize
        // and exactly one may take it; the DB trigger is the backstop under a direct write.
        if (input.capacityCommitmentId) {
          const commitmentId = input.capacityCommitmentId;
          const rows = await tx.$queryRaw<Array<{ id: string; personShiftQty: number; status: string; labourSpecFingerprint: string; civilDate: Date; shift: string }>>`
            SELECT "id", "personShiftQty", "status", "labourSpecFingerprint", "civilDate", "shift"
            FROM "CapacityCommitment" WHERE "projectId" = ${projectId} AND "id" = ${commitmentId} FOR UPDATE`;
          const commitment = rows[0];
          if (!commitment) throw new NotFoundException('Capacity commitment not found in this project');
          if (commitment.status !== 'committed') {
            throw new ConflictException(`Capacity commitment is ${commitment.status} — only committed capacity can be drawn down`);
          }
          if (
            commitment.labourSpecFingerprint !== spec.labourSpecFingerprint ||
            toIsoCivilDate(commitment.civilDate) !== input.civilDate ||
            commitment.shift !== spec.shift
          ) {
            throw new BadRequestException('Capacity committed for one (fingerprint, civilDate, shift) slice can never be drawn for another');
          }
          const drawn = await tx.workerAllocation.count({ where: { projectId, capacityCommitmentId: commitmentId, status: 'active' } });
          if (drawn + workerIds.length > commitment.personShiftQty) {
            throw new ConflictException(
              `§F bound 3: commitment covers ${commitment.personShiftQty} person-shift(s) for this slice; ${drawn} already allocated, ${workerIds.length} requested`,
            );
          }
        }

        const created: AllocationRow[] = [];
        const events: EmittedEventMeta[] = [];
        for (const workerId of [...workerIds].sort()) {
          let row: AllocationRow;
          try {
            row = await tx.workerAllocation.create({
              data: {
                projectId, workerId, civilDate, shift: spec.shift,
                activityId: input.activityId, requirementId: input.requirementId,
                originRevision: spec.revision, labourSpecFingerprint: spec.labourSpecFingerprint,
                crewId: input.crewId ?? null,
                capacityCommitmentId: input.capacityCommitmentId ?? null,
                allocatedById: actor.actorId,
                sourceCommandId: ctx.commandId!,
              },
            });
          } catch (e) {
            if (isUniqueViolation(e)) {
              throw new ConflictException(`Worker "${workerId}" already holds a live allocation for ${input.civilDate} (${spec.shift}) — release it first`);
            }
            throw e;
          }
          created.push(row);
          events.push(await emitEvent(tx, {
            projectId, actor, eventType: 'allocation.made', entityType: 'WorkerAllocation', entityId: row.id,
            payload: serializeAllocation(row) as unknown as Prisma.InputJsonValue,
            effectKey: 'allocation.made', dispatch: {},
          }));
        }
        await recordAudit(tx, {
          projectId, actor, action: 'labour.allocation.allocate', entity: 'WorkerAllocation',
          entityId: created[0]!.id,
        });
        return { resultRef: created[0]!.id, value: { ids: created.map((c) => c.id) }, events };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const ids = outcome.value?.ids ?? [outcome.resultRef];
    const rows = await this.prisma.workerAllocation.findMany({ where: { projectId, id: { in: ids } }, orderBy: { workerId: 'asc' } });
    return { allocations: rows.map(serializeAllocation) };
  }

  /** CAS `active → released` (frozen identity retained), freeing the worker's slice for re-allocation. */
  async release(projectId: string, allocationId: string, input: ReleaseLabourAllocationInput, user: AuthUser, idempotencyKey?: string): Promise<WorkerAllocationDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertPolicy(user, 'allocation.manage', 'Releasing a labour allocation is a pmc/engineer surface');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.allocation.release', idempotencyKey, requestHash: hashRequest({ allocationId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.workerAllocation.updateMany({
          where: { id: allocationId, projectId, status: 'active' },
          data: { status: 'released', releasedAt: new Date(), releasedById: actor.actorId, releaseReason: input.reason },
        });
        if (count === 0) {
          const existing = await tx.workerAllocation.findFirst({ where: { id: allocationId, projectId }, select: { id: true } });
          if (!existing) throw new NotFoundException('Allocation not found in this project');
          throw new ConflictException('Allocation is already released');
        }
        const row = await tx.workerAllocation.findFirstOrThrow({ where: { projectId, id: allocationId } });
        await recordAudit(tx, { projectId, actor, action: 'labour.allocation.release', entity: 'WorkerAllocation', entityId: allocationId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'allocation.released', entityType: 'WorkerAllocation', entityId: allocationId,
          payload: serializeAllocation(row) as unknown as Prisma.InputJsonValue,
          effectKey: 'allocation.released', dispatch: {},
        });
        return { resultRef: allocationId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.workerAllocation.findFirstOrThrow({ where: { projectId, id: allocationId } });
    return serializeAllocation(row);
  }

  // ── attendance (presence observation — headcount) ────────────────────────────────────────────

  /** One worker PRESENT on one slice. Never consumes or moves an allocation — coverage joins the
   *  two at read time. A cited device must be BOUND to that same worker (§H trusted identity). */
  async recordAttendance(projectId: string, input: RecordAttendanceInput, user: AuthUser, idempotencyKey?: string): Promise<LabourAttendanceDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertPolicy(user, 'attendance.record', 'Recording attendance is a pmc/engineer/contractor surface');
    // F2 — canonical presence must carry TRUSTED evidence. The zod contract guards the HTTP edge;
    // this is the SERVICE backstop, so a direct caller cannot record a bare presence claim either.
    if (!input.deviceId && !input.manualReason) {
      throw new BadRequestException(
        "Attendance needs trusted evidence: either the worker's bound deviceId, or an explicit manualReason recorded as an attributable exception (plan §H)",
      );
    }
    if (input.deviceId && input.manualReason) {
      throw new BadRequestException('A muster is either device-evidenced or a manual exception — never both');
    }
    // A MANUAL muster vouches for presence with no device behind it, so it carries the same
    // authority as any other override: pmc only. The device path stays open to the site roles.
    if (input.manualReason) {
      this.assertPolicy(user, 'labour.override', 'A manual muster (presence with no bound device) is a pmc exception');
    }
    const civilDate = fromIsoCivilDate(input.civilDate);
    if (!civilDate) throw new BadRequestException('civilDate must be an ISO civil date');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.attendance.record', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const [worker] = await this.lockWorkersInOrder(tx, projectId, [input.workerId]);
        if (!worker) throw new BadRequestException('workerId does not name a worker in this project');
        if (worker.revokedAt) throw new BadRequestException('Worker is revoked and cannot be mustered');
        if (civilDate < worker.activeFrom || (worker.activeTo && civilDate > worker.activeTo)) {
          throw new BadRequestException(`Worker is not active on ${input.civilDate}`);
        }
        let row: AttendanceRow;
        try {
          row = await tx.labourAttendance.create({
            data: {
              projectId, workerId: input.workerId, civilDate, shift: input.shift,
              deviceId: input.deviceId ?? null, manualReason: input.manualReason ?? null,
              evidenceMediaId: input.evidenceMediaId ?? null,
              recordedById: actor.actorId, sourceCommandId: ctx.commandId!,
            },
          });
        } catch (e) {
          if (isUniqueViolation(e)) {
            throw new ConflictException(`Attendance for this worker on ${input.civilDate} (${input.shift}) is already recorded — revoke it to correct it`);
          }
          throw e;
        }
        await recordAudit(tx, { projectId, actor, action: 'labour.attendance.record', entity: 'LabourAttendance', entityId: row.id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'attendance.recorded', entityType: 'LabourAttendance', entityId: row.id,
          payload: serializeAttendance(row) as unknown as Prisma.InputJsonValue,
          effectKey: 'attendance.recorded', dispatch: {},
        });
        return { resultRef: row.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.labourAttendance.findFirstOrThrow({ where: { projectId, id: outcome.resultRef } });
    return serializeAttendance(row);
  }

  /** Revoke a presence observation — a CORRECTION, never an edit: the row keeps its identity and
   *  becomes terminal, and the slice is then free for a corrected re-record. */
  async revokeAttendance(projectId: string, attendanceId: string, input: RevokeAttendanceInput, user: AuthUser, idempotencyKey?: string): Promise<LabourAttendanceDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertPolicy(user, 'attendance.revoke', 'Revoking attendance is a pmc surface');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.attendance.revoke', idempotencyKey, requestHash: hashRequest({ attendanceId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.labourAttendance.updateMany({
          where: { id: attendanceId, projectId, revokedAt: null },
          data: { revokedAt: new Date(), revokedById: actor.actorId, revokeReason: input.reason },
        });
        if (count === 0) {
          const existing = await tx.labourAttendance.findFirst({ where: { id: attendanceId, projectId }, select: { id: true } });
          if (!existing) throw new NotFoundException('Attendance not found in this project');
          throw new ConflictException('Attendance is already revoked');
        }
        const row = await tx.labourAttendance.findFirstOrThrow({ where: { projectId, id: attendanceId } });
        await recordAudit(tx, { projectId, actor, action: 'labour.attendance.revoke', entity: 'LabourAttendance', entityId: attendanceId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'attendance.revoked', entityType: 'LabourAttendance', entityId: attendanceId,
          payload: serializeAttendance(row) as unknown as Prisma.InputJsonValue,
          effectKey: 'attendance.revoked', dispatch: {},
        });
        return { resultRef: attendanceId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.labourAttendance.findFirstOrThrow({ where: { projectId, id: attendanceId } });
    return serializeAttendance(row);
  }

  // ── effort (worked-minutes observation) ──────────────────────────────────────────────────────

  /**
   * Record effort performed UNDER an allocation. The worker/activity/slice are COPIED from the
   * allocation (a BEFORE INSERT trigger proves the copy), so effort can never name a different
   * slice than the assignment it was performed under.
   *
   * Round-3 guardrail 2 — the CUMULATIVE bound: `Σ workedMinutes` for the worker's
   * `(civilDate, shift)` is re-derived HERE under the worker `FOR UPDATE`, so two concurrent
   * records cannot each pass a per-row CHECK and together exceed the shift.
   */
  async recordWork(projectId: string, input: RecordLabourWorkInput, user: AuthUser, idempotencyKey?: string): Promise<LabourWorkFactDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertPolicy(user, 'labour.work.record', 'Recording labour effort is a pmc/engineer/contractor surface');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.work.record', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const allocation = await tx.workerAllocation.findFirst({
          where: { projectId, id: input.allocationId },
          select: { id: true, workerId: true, activityId: true, civilDate: true, shift: true, status: true },
        });
        if (!allocation) throw new NotFoundException('Allocation not found in this project');

        // serialize every effort record for this worker (round-3 guardrail 2)
        await this.lockWorkersInOrder(tx, projectId, [allocation.workerId]);
        const prior = await tx.labourWorkFact.aggregate({
          where: { projectId, workerId: allocation.workerId, civilDate: allocation.civilDate, shift: allocation.shift },
          _sum: { workedMinutes: true },
        });
        const already = prior._sum.workedMinutes ?? 0;
        if (already + input.workedMinutes > SHIFT_MINUTES) {
          throw new ConflictException(
            `Cumulative worked minutes for this worker on ${toIsoCivilDate(allocation.civilDate)} (${allocation.shift}) would be ${already + input.workedMinutes}, over the ${SHIFT_MINUTES}-minute shift (${already} already recorded)`,
          );
        }
        const row = await tx.labourWorkFact.create({
          data: {
            projectId, workerId: allocation.workerId, allocationId: allocation.id, activityId: allocation.activityId,
            civilDate: allocation.civilDate, shift: allocation.shift, workedMinutes: input.workedMinutes,
            note: input.note ?? null, recordedById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });
        await recordAudit(tx, { projectId, actor, action: 'labour.work.record', entity: 'LabourWorkFact', entityId: row.id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'labour_work.recorded', entityType: 'LabourWorkFact', entityId: row.id,
          payload: serializeWorkFact(row) as unknown as Prisma.InputJsonValue,
          effectKey: 'labour_work.recorded', dispatch: {},
        });
        return { resultRef: row.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.labourWorkFact.findFirstOrThrow({ where: { projectId, id: outcome.resultRef } });
    return serializeWorkFact(row);
  }

  // ── §B widening: approved skill substitution (pmc authority) ─────────────────────────────────

  /**
   * Approve a substitution for ONE requirement. `fromFingerprint` is the requirement's CURRENT
   * head identity (server-derived — the Phase-3 T6-F2 rule verbatim, so an approval stops applying
   * the moment the requirement is revised to a different identity), and `toFingerprint` is computed
   * from the caller's technical triple. Neither is ever caller-authored.
   */
  async approveSkillSubstitution(projectId: string, input: ApproveSkillSubstitutionInput, user: AuthUser, idempotencyKey?: string): Promise<ApprovedSkillSubstitutionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertPolicy(user, 'labour.override', 'Approving a skill substitution is a pmc surface');
    if (!isLabourShift(input.shift)) throw new BadRequestException('shift must be day or night');
    const toFingerprint = await computeLabourSpecFingerprint({
      tradeCode: input.tradeCode, skillCode: input.skillCode ?? null, shift: input.shift,
    });
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.skillSubstitution.approve', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const spec = await this.requirementHead(tx, projectId, input.requirementId);
        if (spec.labourSpecFingerprint === toFingerprint) {
          throw new BadRequestException('The substitute identity equals the requirement head — that is not a substitution');
        }
        // the substitute must be a real trade/skill in THIS project's catalog (labour-owned)
        const trade = await tx.labourTrade.findUnique({ where: { projectId_code: { projectId, code: input.tradeCode } }, select: { code: true } });
        if (!trade) throw new BadRequestException(`tradeCode "${input.tradeCode}" is not a trade in this project's catalog`);
        if (input.skillCode) {
          const skill = await tx.labourSkill.findUnique({ where: { projectId_code: { projectId, code: input.skillCode } }, select: { code: true } });
          if (!skill) throw new BadRequestException(`skillCode "${input.skillCode}" is not a skill in this project's catalog`);
        }
        let row: SubstitutionRow;
        try {
          row = await tx.approvedSkillSubstitution.create({
            data: {
              projectId, requirementId: input.requirementId,
              fromFingerprint: spec.labourSpecFingerprint, toFingerprint,
              reason: input.reason, approvedById: actor.actorId, sourceCommandId: ctx.commandId!,
            },
          });
        } catch (e) {
          if (isUniqueViolation(e)) throw new ConflictException('An active substitution already authorizes this identity for this requirement');
          throw e;
        }
        await recordAudit(tx, { projectId, actor, action: 'labour.skillSubstitution.approve', entity: 'ApprovedSkillSubstitution', entityId: row.id });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'skill_substitution.approved', entityType: 'ApprovedSkillSubstitution', entityId: row.id,
          payload: serializeSubstitution(row) as unknown as Prisma.InputJsonValue,
          effectKey: 'skill_substitution.approved', dispatch: {},
        });
        return { resultRef: row.id, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.approvedSkillSubstitution.findFirstOrThrow({ where: { projectId, id: outcome.resultRef } });
    return serializeSubstitution(row);
  }

  /** Revoke the authorization. The row survives as history (append-only); only the stamp changes. */
  async revokeSkillSubstitution(projectId: string, substitutionId: string, input: RevokeSkillSubstitutionInput, user: AuthUser, idempotencyKey?: string): Promise<ApprovedSkillSubstitutionDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertPolicy(user, 'labour.override', 'Revoking a skill substitution is a pmc surface');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.skillSubstitution.revoke', idempotencyKey, requestHash: hashRequest({ substitutionId, ...input }),
      run: async (tx) => {
        await lockProjectReadiness(tx, projectId);
        const { count } = await tx.approvedSkillSubstitution.updateMany({
          where: { id: substitutionId, projectId, revokedAt: null },
          data: { revokedAt: new Date(), revokedById: actor.actorId, revokeReason: input.reason },
        });
        if (count === 0) {
          const existing = await tx.approvedSkillSubstitution.findFirst({ where: { id: substitutionId, projectId }, select: { id: true } });
          if (!existing) throw new NotFoundException('Skill substitution not found in this project');
          throw new ConflictException('Skill substitution is already revoked');
        }
        const row = await tx.approvedSkillSubstitution.findFirstOrThrow({ where: { projectId, id: substitutionId } });
        await recordAudit(tx, { projectId, actor, action: 'labour.skillSubstitution.revoke', entity: 'ApprovedSkillSubstitution', entityId: substitutionId });
        const ev = await emitEvent(tx, {
          projectId, actor, eventType: 'skill_substitution.revoked', entityType: 'ApprovedSkillSubstitution', entityId: substitutionId,
          payload: serializeSubstitution(row) as unknown as Prisma.InputJsonValue,
          effectKey: 'skill_substitution.revoked', dispatch: {},
        });
        return { resultRef: substitutionId, events: [ev] };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.approvedSkillSubstitution.findFirstOrThrow({ where: { projectId, id: substitutionId } });
    return serializeSubstitution(row);
  }

  // ── query ────────────────────────────────────────────────────────────────────────────────────

  /** `labour.capacity` — the §C fact register over an optional civil-date window. A READ of the
   *  facts themselves; no aggregate is stored, and the derived Team gate lands with Task 4. */
  async capacity(projectId: string, user: AuthUser, from?: string, to?: string): Promise<LabourCapacityDto> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    const gte = from ? fromIsoCivilDate(from) : null;
    const lte = to ? fromIsoCivilDate(to) : null;
    if (from && !gte) throw new BadRequestException('from must be an ISO civil date');
    if (to && !lte) throw new BadRequestException('to must be an ISO civil date');
    const window = gte || lte ? { civilDate: { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) } } : {};
    const [allocations, attendance, workFacts, skillSubstitutions] = await Promise.all([
      this.prisma.workerAllocation.findMany({ where: { projectId, ...window }, orderBy: [{ civilDate: 'asc' }, { workerId: 'asc' }] }),
      this.prisma.labourAttendance.findMany({ where: { projectId, ...window }, orderBy: [{ civilDate: 'asc' }, { workerId: 'asc' }] }),
      this.prisma.labourWorkFact.findMany({ where: { projectId, ...window }, orderBy: [{ civilDate: 'asc' }, { workerId: 'asc' }] }),
      this.prisma.approvedSkillSubstitution.findMany({ where: { projectId }, orderBy: { at: 'asc' } }),
    ]);
    return {
      allocations: allocations.map(serializeAllocation),
      attendance: attendance.map(serializeAttendance),
      workFacts: workFacts.map(serializeWorkFact),
      skillSubstitutions: skillSubstitutions.map(serializeSubstitution),
    };
  }

  /** `labour.readiness` (Phase 4 Task 4) — the per-activity FORECAST verdicts (§A forecast
   *  table), computed LIVE through the ONE shared `computeLabourReadinessDto` the projection
   *  consumer and the operator rebuild also use — so live == projection == rebuild by
   *  construction. Feeds UI/Inbox/Dashboard ONLY; `activities.start` reads EXECUTION coverage
   *  in-tx, never this read. */
  async readiness(projectId: string, user: AuthUser): Promise<LabourReadinessDto> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    return this.prisma.$transaction(async (tx) => computeLabourReadinessDto(tx, projectId));
  }

  // ── Phase 4 Task 5 — §E labour mismatch (observation + pmc-only resolution) + presence ──────

  /** Record a crew-vs-allocation mismatch OBSERVATION. Runs under the ONE project readiness lock
   *  because an unresolved observation flips the derived Team gate (§A first-match `fail`); the
   *  activity's operational block is applied through the cycle-exempt participant. Append-only —
   *  the correction path is a RESOLUTION, never an edit. */
  async recordMismatch(projectId: string, input: RecordLabourMismatchInput, user: AuthUser, idempotencyKey?: string): Promise<LabourMismatchDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertPolicy(user, 'labour.mismatch.record', 'Recording a labour mismatch is a pmc/engineer surface');
    const civilDate = fromIsoCivilDate(input.civilDate);
    if (!civilDate) throw new BadRequestException('civilDate must be an ISO civil date');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.mismatch.record', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const activity = await this.activityParticipant.labourTarget(tx, { projectId, activityId: input.activityId });
        if (!activity) throw new BadRequestException('activityId does not name an activity in this project');
        if (input.workerId) {
          const worker = await tx.worker.findFirst({ where: { projectId, id: input.workerId }, select: { id: true } });
          if (!worker) throw new BadRequestException('workerId does not name a worker in this project');
        }
        const row = await tx.labourMismatch.create({
          data: {
            projectId, activityId: input.activityId, civilDate, shift: input.shift, kind: input.kind,
            workerId: input.workerId ?? null, note: input.note,
            recordedById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });
        const blockedEv = await this.activityParticipant.blockForLabourMismatch(tx, { projectId, activityId: input.activityId, actor });
        await recordAudit(tx, { projectId, actor, action: 'labour.mismatch.record', entity: 'LabourMismatch', entityId: row.id });
        const events: EmittedEventMeta[] = [];
        events.push(await emitEvent(tx, {
          projectId, actor, eventType: 'labour_mismatch.recorded', entityType: 'LabourMismatch', entityId: row.id,
          payload: { mismatchId: row.id, activityId: row.activityId, civilDate: input.civilDate, shift: row.shift, kind: row.kind } as unknown as Prisma.InputJsonValue,
          effectKey: 'labour_mismatch.recorded', dispatch: {},
        }));
        if (blockedEv) events.push(blockedEv);
        return { resultRef: row.id, events };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.labourMismatch.findFirstOrThrow({ where: { projectId, id: outcome.resultRef }, include: { resolution: true } });
    return serializeMismatch(row);
  }

  /** Close exactly ONE observation with an append-only resolution register row (§E, pmc-only).
   *  The observation is NEVER edited; when no unresolved mismatch remains for the ACTIVITY the
   *  operational block clears through the participant with ONE `activity.labour_unblocked`. */
  async resolveMismatch(projectId: string, mismatchId: string, input: ResolveLabourMismatchInput, user: AuthUser, idempotencyKey?: string): Promise<LabourMismatchDto> {
    const { actor, scope } = await this.begin(projectId, user);
    this.assertPolicy(user, 'labour.mismatch.resolve', 'Resolving a labour mismatch is pmc authority (§E)');
    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'labour.mismatch.resolve', idempotencyKey, requestHash: hashRequest({ mismatchId, ...input }),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const mismatch = await tx.labourMismatch.findFirst({ where: { projectId, id: mismatchId }, include: { resolution: true } });
        if (!mismatch) throw new NotFoundException('Mismatch observation not found in this project');
        if (mismatch.resolution) throw new ConflictException('This observation is already resolved (§E — one resolution per observation)');
        let resolution;
        try {
          resolution = await tx.labourMismatchResolution.create({
            data: { projectId, mismatchId, resolution: input.resolution, reason: input.reason, resolvedById: actor.actorId, sourceCommandId: ctx.commandId! },
          });
        } catch (e) {
          if (isUniqueViolation(e)) throw new ConflictException('This observation is already resolved (§E — one resolution per observation)');
          throw e;
        }
        await recordAudit(tx, { projectId, actor, action: 'labour.mismatch.resolve', entity: 'LabourMismatchResolution', entityId: resolution.id });
        const events: EmittedEventMeta[] = [];
        events.push(await emitEvent(tx, {
          projectId, actor, eventType: 'labour_mismatch.resolved', entityType: 'LabourMismatch', entityId: mismatch.id,
          payload: { mismatchId: mismatch.id, activityId: mismatch.activityId, resolution: input.resolution, authority: actor.actorId } as unknown as Prisma.InputJsonValue,
          effectKey: 'labour_mismatch.resolved', dispatch: {},
        }));
        const remaining = await tx.labourMismatch.count({
          where: { projectId, activityId: mismatch.activityId, id: { not: mismatch.id }, resolution: { is: null } },
        });
        if (remaining === 0) {
          const unblocked = await this.activityParticipant.clearLabourMismatchBlock(tx, { projectId, activityId: mismatch.activityId, actor });
          if (unblocked) events.push(unblocked);
        }
        return { resultRef: resolution.id, events };
      },
    });
    if (!outcome.replayed) await this.dispatcher.dispatchCommitted(outcome.events);
    const row = await this.prisma.labourMismatch.findFirstOrThrow({ where: { projectId, id: mismatchId }, include: { resolution: true } });
    return serializeMismatch(row);
  }

  /** `labour.presence` — the §E Daily-Log read: per-worker musters (worker identity JOINED from
   *  the labour register, copied nowhere) + that date's mismatch observations. A separate,
   *  pilot-gated labour read: the daily-log module is untouched, so the non-pilot daily-log
   *  response stays byte-identical, and the aggregate `CrewRow` steppers remain display-only. */
  async presence(projectId: string, civilDateIso: string, user: AuthUser): Promise<LabourPresenceDto> {
    await this.capabilities.assertEnabled(projectId, LABOUR_CAPABILITY);
    this.assertRead(user);
    const civilDate = fromIsoCivilDate(civilDateIso);
    if (!civilDate) throw new BadRequestException('civilDate must be an ISO civil date');
    const [musters, mismatches] = await Promise.all([
      this.prisma.labourAttendance.findMany({
        where: { projectId, civilDate, revokedAt: null },
        include: { worker: { select: { name: true, tradeCode: true } } },
        orderBy: [{ shift: 'asc' }, { workerId: 'asc' }],
      }),
      this.prisma.labourMismatch.findMany({
        // UNRESOLVED only — the API fails closed: a resolved observation never re-enters the
        // Daily-Log's active mismatch list (history lives on the mismatch register itself).
        where: { projectId, civilDate, resolution: { is: null } },
        include: { resolution: true },
        orderBy: { recordedAt: 'asc' },
      }),
    ]);
    return {
      civilDate: civilDateIso,
      musters: musters.map((m) => ({
        workerId: m.workerId, workerName: m.worker.name, tradeCode: m.worker.tradeCode, shift: m.shift,
        deviceId: m.deviceId, manualReason: m.manualReason, recordedAt: m.recordedAt.toISOString(),
      })),
      mismatches: mismatches.map(serializeMismatch),
    };
  }
}
