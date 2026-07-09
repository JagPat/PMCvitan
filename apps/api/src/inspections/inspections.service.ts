import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { checklistSubmitError, reinspectionCount } from '../domain/transitions';
import type { AuthUser } from '../common/auth';
import type { DecideReviewInput, SubmitInspectionInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';

@Injectable()
export class InspectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Engineer submits the checklist (guarded: all marked, failed items need a photo). */
  async submit(projectId: string, inspectionId: string, input: SubmitInspectionInput, user: AuthUser): Promise<SnapshotDto> {
    const insp = await this.prisma.inspection.findUnique({ where: { id: inspectionId } });
    if (!insp || insp.projectId !== projectId) throw new NotFoundException(`Inspection ${inspectionId} not found`);

    const err = checklistSubmitError(input.items);
    if (err) throw new BadRequestException(err);

    await this.prisma.$transaction([
      ...input.items.map((it) =>
        this.prisma.inspectionItem.updateMany({ where: { inspectionId, name: it.name }, data: { state: it.state, photos: it.photos, note: it.note } }),
      ),
      this.prisma.inspection.update({ where: { id: inspectionId }, data: { submitted: true } }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'inspection.submit', entity: 'Inspection', entityId: inspectionId } }),
    ]);
    this.realtime.notifyChanged(projectId);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** PMC approves the inspection, or sends rejections (creating re-inspection tasks). */
  async decide(projectId: string, inspectionId: string, input: DecideReviewInput, user: AuthUser): Promise<SnapshotDto> {
    const insp = await this.prisma.inspection.findUnique({ where: { id: inspectionId }, include: { items: true } });
    if (!insp || insp.projectId !== projectId) throw new NotFoundException(`Inspection ${inspectionId} not found`);

    let pushBody: string;
    let pushRoles: string[];
    if (input.approve) {
      pushBody = 'Inspection approved. Contractor and client notified.';
      pushRoles = ['contractor', 'client'];
      await this.prisma.$transaction([
        this.prisma.inspection.update({ where: { id: inspectionId }, data: { decided: true } }),
        this.prisma.notification.create({ data: { projectId, text: pushBody, color: '#3F7A54', time: 'just now' } }),
        this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'inspection.approve', entity: 'Inspection', entityId: inspectionId } }),
      ]);
    } else {
      const projected = insp.items.map((it) => ({ rejected: input.rejectedItemNames.includes(it.name) || it.rejected, result: it.result }));
      const n = reinspectionCount(projected);
      if (n === 0) throw new BadRequestException('No items rejected. Use approve instead.');
      pushBody = `${n} re-inspection task(s) created with due dates.`;
      pushRoles = ['engineer']; // the engineer performs the re-inspection
      await this.prisma.$transaction([
        ...input.rejectedItemNames.map((name) => this.prisma.inspectionItem.updateMany({ where: { inspectionId, name }, data: { rejected: true } })),
        this.prisma.inspection.update({ where: { id: inspectionId }, data: { decided: true } }),
        this.prisma.notification.create({ data: { projectId, text: pushBody, color: '#B23A34', time: 'just now' } }),
        this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'inspection.reinspect', entity: 'Inspection', entityId: inspectionId } }),
      ]);
    }
    this.realtime.notifyChanged(projectId, pushBody, pushRoles);
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
