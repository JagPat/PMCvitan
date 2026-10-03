import { Inject, Injectable } from '@nestjs/common';
import type { PmcBriefProject, PmcBriefResult } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { CLOCK, type Clock } from '../common/clock';
import { addCivilDays, civilDayStartInstant } from '../common/civil-date';
import { DailyLogQueryService } from '../daily-log/daily-log.query';
import { DecisionsQueryService } from '../decisions/decisions.query';
import { InspectionsQueryService } from '../inspections/inspections.query';
import { MediaQueryService } from '../media/media.query';
import { projectsInReach } from './project-reach';

/**
 * U3a — the PMC's daily brief across every project they run (`GET /me/brief`). Read-only.
 *
 * WHO: the shared reach of `/me/portfolio` (`projectsInReach`: active memberships and org owner/admin
 * reach, archived projects dropped, no legacy home-field fallback), narrowed to the projects where the
 * caller holds the PMC role. The route is identity-scoped, so this reach IS the access check: nothing
 * from a project outside it is read.
 *
 * WHAT: each project's figures come from its owning module's query contract (daily-log, inspections,
 * decisions, media), never their tables, on that project's own civil calendar (`Project.timeZone`).
 */
@Injectable()
export class BriefService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly dailyLog: DailyLogQueryService,
    private readonly decisions: DecisionsQueryService,
    private readonly inspections: InspectionsQueryService,
    private readonly media: MediaQueryService,
  ) {}

  async brief(userId: string): Promise<PmcBriefResult> {
    const reach = (await projectsInReach(this.prisma, userId)).filter((r) => r.role === 'pmc');
    const projects = await Promise.all(reach.map(({ project }) => this.projectBrief(project)));
    return { projects: projects.sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId)) };
  }

  private async projectBrief(project: { id: string; name: string; short: string; timeZone: string; org: { name: string } | null }): Promise<PmcBriefProject> {
    const today = this.clock.today(project.timeZone);
    const since = civilDayStartInstant(addCivilDays(today, -1), project.timeZone);
    const [logToday, reviewsWaiting, waiting, approvals, photos, rejectedInspections] = await Promise.all([
      this.dailyLog.logStatusOn(project.id, today),
      this.inspections.openInspectionCount(project.id),
      this.decisions.waitingOnClient(project.id),
      this.decisions.clientApprovalsSince(project.id, since),
      this.media.progressPhotoCountSince(project.id, since),
      this.inspections.rejectedSince(project.id, since),
    ]);
    return {
      projectId: project.id,
      name: project.name,
      short: project.short,
      orgName: project.org?.name ?? null,
      today,
      logToday,
      reviewsWaiting,
      waitingOnClient: waiting.count,
      oldestWaitingSince: waiting.oldestPublishedAt?.toISOString() ?? null,
      sinceYesterday: { approvals, photos, rejectedInspections },
    };
  }
}
