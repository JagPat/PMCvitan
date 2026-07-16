import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { ExternalEffectDispatcher } from '../platform/outbox/external-effect-dispatcher';
import { addCivilDays, diffCivilDays, fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import type { AuthUser } from '../common/auth';
import type { CreatePhaseInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';
import { recordAudit } from '../platform/audit';
import { emitEvent } from '../platform/events';
import { resolveActor } from '../common/actor';

@Injectable()
export class PhasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    // PR C Task 2 — the single external-effect sender (replaces the in-request RealtimeGateway).
    private readonly dispatcher: ExternalEffectDispatcher,
  ) {}

  /** PMC adds a phase to group schedule activities under. Real civil dates are
   *  canonical (Codex gate finding 5): explicit ISO input wins, else the window
   *  derives from the project's schedule anchor + the legacy offsets — and the
   *  legacy ints stay coherent when ISO drove the write. */
  async create(projectId: string, input: CreatePhaseInput, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { scheduleStartDate: true } });
    const anchor = toIsoCivilDate(project.scheduleStartDate);
    const startIso = input.plannedStartDate ?? (anchor ? addCivilDays(anchor, input.plannedStart) : null);
    const endIso = input.plannedEndDate ?? (anchor ? addCivilDays(anchor, input.plannedEnd) : null);
    // the MERGED window (ISO input over anchor-derived offsets) must be ordered —
    // ISO civil dates compare lexicographically = chronologically (Codex round 2)
    if (startIso && endIso && startIso > endIso) {
      throw new BadRequestException('The planned window is reversed: the resolved end date is before the start date');
    }
    const maxOrder = await this.prisma.phase.aggregate({ where: { projectId }, _max: { order: true } });
    const ev = await this.prisma.$transaction(async (tx) => {
      await tx.phase.create({
        data: {
          projectId,
          name: input.name,
          plannedStart: input.plannedStartDate && anchor ? diffCivilDays(anchor, input.plannedStartDate) : input.plannedStart,
          plannedEnd: input.plannedEndDate && anchor ? diffCivilDays(anchor, input.plannedEndDate) : input.plannedEnd,
          plannedStartDate: fromIsoCivilDate(startIso),
          plannedEndDate: fromIsoCivilDate(endIso),
          order: (maxOrder._max.order ?? 0) + 1,
        },
      });
      await recordAudit(tx, { projectId, actor, action: 'phase.create', entity: 'Phase', entityId: input.name });
      return emitEvent(tx, { projectId, actor, eventType: 'phase.created', entityType: 'Phase', entityId: input.name, payload: { name: input.name }, effectKey: 'phase.created', dispatch: {} });
    });
    await this.dispatcher.dispatchCommitted([ev]);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC removes a phase; its activities are detached (they render in the flat list). */
  async remove(projectId: string, phaseId: string, user: AuthUser): Promise<SnapshotDto> {
    const actor = await resolveActor(this.prisma, user);
    const p = await this.prisma.phase.findUnique({ where: { id: phaseId } });
    if (!p || p.projectId !== projectId) throw new NotFoundException('Phase not found');
    const ev = await this.prisma.$transaction(async (tx) => {
      // Edge 6 (Task 7): the Activity(projectId, phaseId) FK is now ON DELETE SET NULL
      // (phaseId), so deleting the phase detaches its activities in the database — no
      // cross-module write here (they render in the flat list once unfiled).
      await tx.phase.delete({ where: { id: phaseId } });
      await recordAudit(tx, { projectId, actor, action: 'phase.delete', entity: 'Phase', entityId: phaseId });
      return emitEvent(tx, { projectId, actor, eventType: 'phase.removed', entityType: 'Phase', entityId: phaseId, effectKey: 'phase.removed', dispatch: {} });
    });
    await this.dispatcher.dispatchCommitted([ev]);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
