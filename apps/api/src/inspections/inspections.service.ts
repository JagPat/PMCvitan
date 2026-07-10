import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SnapshotService } from '../snapshot/snapshot.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { checklistSubmitError, reinspectionCount } from '../domain/transitions';
import { ddMmmYyyy } from '../domain/dates';
import { nextSeqId } from '../domain/ids';
import type { AuthUser } from '../common/auth';
import type { CreateInspectionInput, DecideReviewInput, SubmitInspectionInput } from '../contracts';
import type { SnapshotDto } from '../snapshot/types';

@Injectable()
export class InspectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: SnapshotService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** PMC issues a stage checklist — becomes the engineer's current field checklist. */
  async create(projectId: string, input: CreateInspectionInput, user: AuthUser): Promise<SnapshotDto> {
    // DATA-01: ids are globally unique — scan every project, not just this one (see decisions.service).
    const existing = await this.prisma.inspection.findMany({ select: { id: true } });
    const id = nextSeqId('INSP-', existing.map((i) => i.id));
    await this.prisma.$transaction([
      this.prisma.inspection.create({
        data: { id, projectId, kind: 'checklist', title: input.title, zone: input.zone, date: ddMmmYyyy(new Date()), submitted: false, decided: false },
      }),
      ...input.items.map((name, i) =>
        this.prisma.inspectionItem.create({ data: { inspectionId: id, name, order: i, photos: 0, note: '' } }),
      ),
      this.prisma.notification.create({ data: { projectId, text: `New checklist issued: ${input.title} — ${input.zone}`, color: '#C08A2D', time: 'just now' } }),
      this.prisma.auditLog.create({ data: { projectId, actor: user.role, action: 'inspection.create', entity: 'Inspection', entityId: id } }),
    ]);
    // the engineer fills it in the field
    this.realtime.notifyChanged(projectId, `New checklist: ${input.title} — ${input.zone}`, ['engineer']);
    return this.snapshot.build(projectId, user.role, user.sub);
  }

  /** Engineer submits the checklist (guarded: all marked, failed items need a photo). */
  async submit(projectId: string, inspectionId: string, input: SubmitInspectionInput, user: AuthUser): Promise<SnapshotDto> {
    const insp = await this.prisma.inspection.findUnique({ where: { id: inspectionId }, include: { items: true } });
    if (!insp || insp.projectId !== projectId) throw new NotFoundException(`Inspection ${inspectionId} not found`);

    // P2-3: guard the state machine. A submitted inspection is in the PMC's review
    // queue (or already decided) — resubmitting would silently rewrite what's under
    // review, so refuse. And validate against the ISSUED checklist, not just whatever
    // items the request carries: an engineer can't slip through an empty or short
    // payload to mark it submitted while items go unverified.
    if (insp.decided) throw new BadRequestException('This inspection has already been decided.');
    if (insp.submitted) throw new BadRequestException('This checklist has already been submitted and is awaiting review.');
    if (insp.items.length === 0) throw new BadRequestException('This inspection has no checklist items to submit.');

    const submitted = new Map(input.items.map((it) => [it.name, it]));
    const merged = insp.items.map((dbIt) => {
      const s = submitted.get(dbIt.name);
      return { state: s?.state ?? null, photos: s?.photos ?? 0 };
    });
    const err = checklistSubmitError(merged);
    if (err) throw new BadRequestException(err);

    await this.prisma.$transaction([
      // only write items that belong to this inspection (updateMany by inspectionId+name)
      ...insp.items.map((dbIt) => {
        const s = submitted.get(dbIt.name)!;
        return this.prisma.inspectionItem.updateMany({ where: { inspectionId, name: dbIt.name }, data: { state: s.state, photos: s.photos, note: s.note } });
      }),
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
    // P2-3: a decision is terminal — don't let it be re-decided (which would re-notify
    // and re-create re-inspection tasks). It must have been submitted first.
    if (!insp.submitted) throw new BadRequestException('This inspection has not been submitted yet.');
    if (insp.decided) throw new BadRequestException('This inspection has already been decided.');

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
