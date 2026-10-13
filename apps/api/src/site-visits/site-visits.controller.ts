import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  closeSiteVisitSchema, endSiteVisitSchema, startSiteVisitSchema,
  type CloseSiteVisitInput, type EndSiteVisitInput, type StartSiteVisitInput,
} from '../contracts';
import { SiteVisitsService } from './site-visits.service';
import { SiteVisitsQueryService } from './site-visits.query';

/** Site Visits SV1-b (#792). Each write takes an optional `Idempotency-Key` so a retried or replayed act lands once. */
@Controller('projects/:projectId/site-visits')
@UseGuards(JwtGuard, RolesGuard)
export class SiteVisitsController {
  constructor(
    private readonly visits: SiteVisitsService,
    private readonly visitsQuery: SiteVisitsQueryService,
  ) {}

  /** The project's latest visits; every member reads them (D1). */
  @Get()
  @RolesFor('project.read')
  list(@Param('projectId') projectId: string) {
    return this.visitsQuery.list(projectId);
  }

  @Post()
  @RolesFor('siteVisit.start')
  start(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(startSiteVisitSchema)) body: StartSiteVisitInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.visits.start(projectId, body, user, idempotencyKey);
  }

  @Post(':visitId/end')
  @RolesFor('siteVisit.end')
  end(
    @Param('projectId') projectId: string,
    @Param('visitId') visitId: string,
    @Body(new ZodPipe(endSiteVisitSchema)) body: EndSiteVisitInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.visits.end(projectId, visitId, body, user, idempotencyKey);
  }

  @Post(':visitId/close')
  @RolesFor('siteVisit.close')
  close(
    @Param('projectId') projectId: string,
    @Param('visitId') visitId: string,
    @Body(new ZodPipe(closeSiteVisitSchema)) body: CloseSiteVisitInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.visits.close(projectId, visitId, body, user, idempotencyKey);
  }
}
