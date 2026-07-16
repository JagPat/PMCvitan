import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { deriveReadiness, type ReadinessOverride } from '../domain/transitions';
import { toIsoCivilDate } from '../common/civil-date';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { SignedUrlService } from '../media/signed-url.service';
import { isPendingDecisionNotice } from '../domain/notifications';
import { ddMmmYyyy } from '../domain/dates';
import type { Role } from '../common/auth';
import type { ActivityDto, PhaseDto, SnapshotDto } from './types';

const ACTIVITY_STATUS_OUT: Record<string, ActivityDto['status']> = {
  not_started: 'not-started',
  in_progress: 'in-progress',
  // a completion CLAIM awaiting the PMC's closing sign-off (Phase 1 Task 5)
  awaiting_signoff: 'awaiting-signoff',
  done: 'done',
  blocked: 'blocked',
};

@Injectable()
export class SnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signed: SignedUrlService,
    // Task 8 — decisions are read through their module's query, never `prisma.decision` here.
    private readonly decisionsQuery: DecisionsQueryService,
  ) {}

  /** Build the full project snapshot the frontend hydrates its store from.
   *  Permission-filtered: only PMC & client see pending decisions; every other
   *  role (contractor, engineer, worker) is restricted to decided ones. */
  async build(projectId: string, role: Role, userId?: string): Promise<SnapshotDto> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);

    const [decisionSlice, activities, inspections, dailyLog, notifications, siteMedia, drawings, phases, companies, nodes, allMaterials, activeMembers, gateOverrides] = await Promise.all([
      // Task 8 — the decisions slice comes from the module's query (role-filtered DTOs + an
      // id→status map for readiness), not a direct `prisma.decision` read.
      this.decisionsQuery.snapshotSlice(projectId, role, userId),
      this.prisma.activity.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
      this.prisma.inspection.findMany({
        where: { projectId },
        include: {
          items: { orderBy: { order: 'asc' } },
          // linked evidence rows (Task 4) — serialized as signed serve paths per item
          media: { select: { id: true, inspectionItemId: true }, orderBy: { createdAt: 'asc' } },
          // the activity a CLOSING inspection signs off (Task 5) — labels the review queue
          activity: { select: { name: true } },
        },
      }),
      this.prisma.dailyLog.findFirst({
        where: { projectId },
        include: { crew: { orderBy: { order: 'asc' } }, materials: { orderBy: { order: 'asc' } } },
        // real civil day first (Task 6); creation instant is only the tie-breaker
        orderBy: [{ logDate: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.notification.findMany({ where: { projectId }, orderBy: { at: 'desc' } }),
      // Site-reality photos for the daily-log gallery AND the Place view. One query,
      // capped, newest first; carries nodeId so a photo can be shown at its location.
      this.prisma.media.findMany({
        where: { projectId, kind: { in: ['progress', 'inspection', 'material'] } },
        orderBy: { createdAt: 'desc' },
        take: 300,
        select: { id: true, kind: true, url: true, takenAt: true, nodeId: true },
      }),
      this.prisma.drawing.findMany({
        where: { projectId },
        include: {
          revisions: {
            orderBy: { createdAt: 'desc' },
            include: {
              acks: { orderBy: { at: 'asc' } },
              // the frozen distribution (Phase 1 Task 3) + each recipient's display name
              recipients: { include: { membership: { include: { user: { select: { name: true } } } } } },
            },
          },
        },
        orderBy: [{ discipline: 'asc' }, { number: 'asc' }],
      }),
      this.prisma.phase.findMany({ where: { projectId }, orderBy: { order: 'asc' } }),
      this.prisma.projectCompany.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.projectNode.findMany({ where: { projectId }, orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }),
      // All materials across the project's daily logs (for the Site Map's "materials here"),
      // not just the current day. Same visibility as the daily-log materials.
      this.prisma.siteMaterial.findMany({ where: { dailyLog: { projectId } }, orderBy: { order: 'asc' } }),
      // Readiness inputs (Task 6): who is CURRENTLY active (drawing-gate active(P))
      // and every manual override (oldest first — the latest unexpired wins its gate)
      this.prisma.membership.findMany({ where: { projectId, status: 'active' }, select: { userId: true } }),
      this.prisma.gateOverride.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } }),
    ]);

    // Private delivery: a short-lived signed serve path (never a public bucket URL). Only
    // a caller authorized to see this snapshot gets a token, and it expires quickly.
    // The daily-log gallery keeps the newest 12 progress photos, unchanged.
    const progressPhotos = siteMedia
      .filter((m) => m.kind === 'progress')
      .slice(0, 12)
      .map((m) => ({ id: m.id, url: this.signed.mediaPath(m.id), takenAt: m.takenAt ?? undefined }));
    // The location spine's "reality" layer: every site photo with its place tag, so the
    // Place view can show a location's photos beside its drawings and decisions.
    const photoDtos = siteMedia.map((m) => ({
      id: m.id,
      url: this.signed.mediaPath(m.id),
      takenAt: m.takenAt ?? undefined,
      nodeId: m.nodeId ?? undefined,
      kind: m.kind,
    }));

    // Task 8 — the role-filtered decision DTOs + the unfiltered id→status map both come from the
    // decisions query (the serialization moved there verbatim, so this slice is byte-identical).
    const decisionDtos = decisionSlice.decisions;
    const decisionStatuses = decisionSlice.statuses;
    // pmc/client see pending decisions; every other role has them hidden — the same predicate also
    // drops the pending-decision notice from the bell for those roles (AUTH-02, below).
    const hidePending = role !== 'pmc' && role !== 'client';

    // Readiness (Task 6): a gate dot is a CONCLUSION from explicit recorded
    // relationships — derived per activity from the rows already loaded above,
    // never from a stored flag (material/team excepted and labeled 'stored').
    const now = new Date();
    const activeMemberIds = activeMembers.map((m) => m.userId);
    const readinessInspections = inspections.map((i) => ({
      id: i.id, activityId: i.activityId, closing: i.closing, submitted: i.submitted, decided: i.decided, reinspectionOfId: i.reinspectionOfId,
      items: i.items.map((it) => ({ rejected: it.rejected, result: it.result })),
    }));
    const readinessDrawings = drawings.map((d) => ({
      number: d.number, activityId: d.activityId, draft: d.publishedAt === null,
      revisions: d.revisions.map((r) => ({ status: r.status, recipientsFrozenAt: r.recipientsFrozenAt, recipientIds: r.recipients.map((x) => x.userId), ackedIds: r.acks.map((x) => x.userId) })),
    }));
    const overridesByActivity = new Map<string, typeof gateOverrides>();
    for (const o of gateOverrides) {
      const list = overridesByActivity.get(o.activityId) ?? [];
      list.push(o);
      overridesByActivity.set(o.activityId, list);
    }

    const activityDtos: ActivityDto[] = activities.map((a) => ({
      id: a.id,
      name: a.name,
      zone: a.zone,
      decisionId: a.decisionId,
      phaseId: a.phaseId,
      nodeId: a.nodeId ?? undefined, // location spine: where this work happens

      ps: a.plannedStart,
      pe: a.plannedEnd,
      as: a.actualStart,
      ae: a.actualEnd,
      // Task 6: real civil dates (canonical); the ints above are the legacy compat timeline
      plannedStartDate: toIsoCivilDate(a.plannedStartDate),
      plannedEndDate: toIsoCivilDate(a.plannedEndDate),
      actualStartDate: toIsoCivilDate(a.actualStartDate),
      actualEndDate: toIsoCivilDate(a.actualEndDate),
      status: ACTIVITY_STATUS_OUT[a.status],
      // legacy stored flags (deprecated display fields; `readiness` is the truth)
      gm: a.gateMaterial,
      gt: a.gateTeam,
      gi: a.gateInspection,
      block: a.block ?? undefined,
      readiness: deriveReadiness(a.id, {
        decisionStatus: a.decisionId ? (decisionStatuses.get(a.decisionId) ?? null) : null,
        gateMaterial: a.gateMaterial,
        gateTeam: a.gateTeam,
        inspections: readinessInspections,
        drawings: readinessDrawings,
        activeMemberIds,
        overrides: (overridesByActivity.get(a.id) ?? []).map((o) => ({ gate: o.gate as ReadinessOverride['gate'], state: o.state, reason: o.reason, expiresAt: o.expiresAt, actorName: o.actorName })),
        now,
      }),
      // the ACTIVE manual exceptions, surfaced for the override UI (revoke + expiry)
      overrides: (overridesByActivity.get(a.id) ?? [])
        .filter((o) => o.expiresAt.getTime() > now.getTime())
        .map((o) => ({ id: o.id, gate: o.gate as ReadinessOverride['gate'], state: o.state, reason: o.reason, actorName: o.actorName, expiresAt: o.expiresAt.toISOString(), evidenceMediaId: o.evidenceMediaId ?? undefined })),
    }));

    // The engineer keeps seeing their checklist (as "submitted ✓") after they send
    // it; it ALSO enters the PMC review queue below — two role-views of one inspection.
    // The engineer's CURRENT checklist: prefer an open (unsubmitted) one — a freshly
    // issued checklist supersedes an already-submitted earlier one in the field view.
    const checklistRow = inspections.find((i) => i.kind === 'checklist' && !i.submitted) ?? inspections.find((i) => i.kind === 'checklist');
    // The review queue: any submitted-but-undecided inspection, whatever its kind
    // (a submitted checklist, the seeded review, an auto-created closing inspection).
    // A checklist item's pass/fail/na `state` maps to a review PASS/FAIL result.
    // AUTH-02: the queue is the PMC's internal sign-off surface — it is serialized
    // ONLY for the pmc role; clients/contractors/engineers get an empty list, so
    // hiding the screen in the UI is backed by the API response itself.
    const isPmc = role === 'pmc';
    const reviews = inspections
      .filter((i) => i.submitted && !i.decided)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => ({
        id: i.id,
        title: i.title,
        zone: i.zone,
        nodeId: i.nodeId ?? undefined, // location spine: where this check happens
        by: i.by ?? '',
        date: i.date,
        decided: i.decided,
        // Task 4: a reinspection is labeled by its predecessor in the review queue
        reinspectionOfId: i.reinspectionOfId ?? undefined,
        // Task 5: a CLOSING inspection is labeled with the activity it signs off —
        // approving it is what completes that activity
        ...(i.closing ? { closing: true, activityId: i.activityId ?? undefined, activityName: i.activity?.name } : {}),
        items: i.items.map((it) => ({
          id: it.id, // gate finding 3: rejection addresses THIS row, labels are not unique
          name: it.name,
          result: (it.result ?? (it.state === 'fail' ? 'FAIL' : 'PASS')) as 'PASS' | 'FAIL',
          swatch: it.swatch ?? 'concrete',
          note: it.note,
          rejected: it.rejected,
          // the ACTUAL evidence photos for this item (signed serve paths, Task 4)
          evidence: i.media.filter((m) => m.inspectionItemId === it.id).map((m) => this.signed.mediaPath(m.id)),
        })),
      }));
    // any inspection already decided with a rejected/failed item ⇒ re-inspection exists
    const reinspectionCreated = inspections.some(
      (i) => i.decided && i.items.some((it) => it.rejected || it.result === 'FAIL'),
    );

    // Location spine: every inspection with its place, for the Site Map's "inspections here".
    // AUTH-02: inspections are an internal sign-off surface — serialized ONLY for the roles
    // that run them (pmc/engineer); client/contractor/consultant get an empty list, so the
    // Place view can't surface an inspection to them even though it shares the location tree.
    const canSeeInspections = role === 'pmc' || role === 'engineer';
    const placedInspections = canSeeInspections
      ? inspections.map((i) => ({
          id: i.id,
          title: i.title,
          zone: i.zone,
          nodeId: i.nodeId ?? undefined,
          kind: i.kind,
          submitted: i.submitted,
          decided: i.decided,
          failedItems: i.items.filter((it) => it.rejected || it.result === 'FAIL').length,
        }))
      : [];

    // Drawings register: each entry with its full revision history (newest first)
    // and the GOVERNING revision the field builds from — the latest non-superseded
    // for_construction, or null (a drawing whose only revisions are review copies
    // never governs; the register labels it "In review — not for construction").
    // Draft → Publish: an unpublished drawing is author-private — delivered ONLY to its
    // creator, never to the build team or anyone else (server-enforced, like decisions).
    const drawingDtos = drawings
      .filter((d) => d.publishedAt !== null || (Boolean(userId) && d.authorId === userId))
      .map((d) => {
      const revs = d.revisions.map((r) => ({
        id: r.id,
        rev: r.rev,
        status: r.status,
        mime: r.mime,
        // private delivery: short-lived signed serve path (never a public bucket URL)
        url: this.signed.drawingPath(r.id),
        sizeBytes: r.sizeBytes,
        note: r.note,
        issuedBy: r.issuedBy,
        issuedAt: r.issuedAt,
        acks: r.acks.map((a) => ({ userName: a.userName, role: a.role, at: ddMmmYyyy(a.at) })),
        // the frozen distribution: WHO this revision was issued to + whether they acked.
        // null recipientsFrozenAt = legacy (predates snapshots), [] = frozen empty.
        recipientsFrozenAt: r.recipientsFrozenAt ? r.recipientsFrozenAt.toISOString() : null,
        recipients: r.recipients.map((rc) => ({
          userName: rc.membership.user.name,
          role: rc.roleAtIssue,
          acked: r.acks.some((a) => a.userId === rc.userId),
        })),
      }));
      const current = revs.find((r) => r.status === 'for_construction') ?? null;
      const currentRow = current ? d.revisions.find((r) => r.id === current.id) : undefined;
      return {
        id: d.id,
        number: d.number,
        title: d.title,
        discipline: d.discipline,
        zone: d.zone,
        activityId: d.activityId,
        decisionId: d.decisionId,
        nodeId: d.nodeId ?? undefined, // location spine: the place this drawing governs
        draft: d.publishedAt === null, // private, unpublished — only in its author's snapshot
        current,
        ackedByMe: Boolean(userId) && (currentRow?.acks ?? []).some((a) => a.userId === userId),
        // Is the VIEWER on the governing revision's frozen distribution? Emitted ONLY
        // when a snapshot actually ran (recipientsFrozenAt set) — a LEGACY revision
        // (null) OMITS the field entirely so the client's everyone-builds fallback
        // engages, and Task 6's truth table keeps its legacy discriminator (finding 4).
        ...(currentRow && currentRow.recipientsFrozenAt !== null
          ? { recipientOfCurrent: Boolean(userId) && currentRow.recipients.some((rc) => rc.userId === userId) }
          : {}),
        revisions: revs,
      };
    });

    // Phase rollups: each phase's activities counted by status so the schedule
    // and portfolio can show phase-level progress (done/total → donePct).
    const phaseDtos: PhaseDto[] = phases.map((p) => {
      const acts = activityDtos.filter((a) => a.phaseId === p.id);
      const done = acts.filter((a) => a.status === 'done').length;
      const inProgress = acts.filter((a) => a.status === 'in-progress').length;
      const blocked = acts.filter((a) => a.status === 'blocked').length;
      const notStarted = acts.filter((a) => a.status === 'not-started').length;
      return {
        id: p.id,
        name: p.name,
        order: p.order,
        plannedStart: p.plannedStart,
        plannedEnd: p.plannedEnd,
        plannedStartDate: toIsoCivilDate(p.plannedStartDate),
        plannedEndDate: toIsoCivilDate(p.plannedEndDate),
        activityTotal: acts.length,
        done,
        inProgress,
        blocked,
        notStarted,
        donePct: acts.length ? Math.round((done / acts.length) * 100) : 0,
      };
    });

    return {
      project: {
        id: project.id,
        name: project.name,
        short: project.short,
        descriptor: project.descriptor,
        stage: project.stage,
        siteCode: project.siteCode,
        location: project.location,
        projStart: project.projStart,
        projEnd: project.projEnd,
        scheduleStartDate: toIsoCivilDate(project.scheduleStartDate),
        scheduleEndDate: toIsoCivilDate(project.scheduleEndDate),
        timeZone: project.timeZone,
        elapsedPct: project.elapsedPct,
        todayDay: project.todayDay,
        milestonePct: project.milestonePct,
      },
      decisions: decisionDtos,
      activities: activityDtos,
      placedInspections,
      reviews: isPmc ? reviews : [],
      review: isPmc ? (reviews[0] ?? null) : null, // deprecated single (first pending) — back-compat
      reinspectionCreated: isPmc ? reinspectionCreated : false,
      checklist: checklistRow
        ? {
            id: checklistRow.id,
            title: checklistRow.title,
            zone: checklistRow.zone,
            nodeId: checklistRow.nodeId ?? undefined, // location spine
            date: checklistRow.date,
            submitted: checklistRow.submitted,
            items: checklistRow.items.map((it) => ({
              id: it.id, // the capture flow links evidence uploads to THIS item (Task 4)
              name: it.name,
              state: it.state,
              photos: it.photos,
              note: it.note,
              evidence: checklistRow.media.filter((m) => m.inspectionItemId === it.id).map((m) => this.signed.mediaPath(m.id)),
            })),
          }
        : null,
      drawings: drawingDtos,
      phases: phaseDtos,
      dailyLog: dailyLog
        ? {
            date: dailyLog.date,
            logDate: toIsoCivilDate(dailyLog.logDate),
            checkedIn: dailyLog.checkedIn,
            checkinTime: dailyLog.checkinTime,
            submitted: dailyLog.submitted,
            progress: dailyLog.progress,
            crew: dailyLog.crew.map((c) => ({ trade: c.trade, count: c.count })),
            materials: dailyLog.materials.map((m) => ({
              name: m.name,
              decisionId: m.decisionId ?? '',
              qty: m.qty,
              zone: m.zone,
              matched: m.matched,
              swatch: m.swatch,
              photo: m.photo,
            })),
            photos: progressPhotos,
          }
        : null,
      // AUTH-02: a pending-decision notice ("Decision awaiting approval: …") is
      // pmc/client-only — drop it from the feed for roles that have pending decisions
      // hidden, so a decision's title can't leak through the bell.
      notifications: notifications
        .filter((n) => !(hidePending && isPendingDecisionNotice(n.text)))
        .map((n) => ({ text: n.text, time: n.time, color: n.color })),
      companies: companies.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        contactName: c.contactName ?? '',
        contactEmail: c.contactEmail ?? '',
        contactPhone: c.contactPhone ?? '',
        notes: c.notes ?? '',
      })),
      // The project location tree (zones → rooms → elements) the register groups by.
      // Draft → Publish: an unpublished location is author-private — delivered only to its
      // creator, hidden from the team's Site Map and the filing pickers until published.
      nodes: nodes
        .filter((n) => n.publishedAt !== null || (Boolean(userId) && n.authorId === userId))
        .map((n) => ({ id: n.id, parentId: n.parentId ?? null, name: n.name, kind: n.kind as 'zone' | 'room' | 'element', order: n.order, draft: n.publishedAt === null })),
      // The location spine's reality layer: placed (and unplaced) site photos for the Place view.
      photos: photoDtos,
      // All materials delivered across the project, with their place — the Site Map's "materials here".
      materials: allMaterials.map((m) => ({
        id: m.id,
        name: m.name,
        qty: m.qty,
        zone: m.zone,
        matched: m.matched,
        swatch: m.swatch,
        decisionId: m.decisionId ?? undefined,
        nodeId: m.nodeId ?? undefined,
      })),
    };
  }
}
