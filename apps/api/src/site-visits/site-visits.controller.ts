import { Body, Controller, Delete, Get, Headers, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  addSiteVisitAttendeeSchema, addSiteVisitPlaceSchema, closeSiteVisitSchema, endSiteVisitFileLinkSchema, endSiteVisitSchema,
  listSiteVisitsSchema, setSiteVisitFileLinkSchema, siteVisitLinkPathSchema, startSiteVisitSchema,
  type AddSiteVisitAttendeeInput, type AddSiteVisitPlaceInput, type CloseSiteVisitInput, type EndSiteVisitFileLinkInput,
  type EndSiteVisitInput, type ListSiteVisitsInput, type SetSiteVisitFileLinkInput, type SiteVisitLinkPath, type StartSiteVisitInput,
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

  /** The project's visits, newest first, a page at a time (`before` = the previous page's last id); every member reads them (D1). */
  @Get()
  @RolesFor('project.read')
  list(@Param('projectId') projectId: string, @Query(new ZodPipe(listSiteVisitsSchema)) query: ListSiteVisitsInput, @CurrentUser() user: AuthUser) {
    return this.visitsQuery.list(projectId, query, user.sub, user.role);
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
    return this.visits.end(projectId, visitId.toLowerCase(), body, user, idempotencyKey);
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
    return this.visits.close(projectId, visitId.toLowerCase(), body, user, idempotencyKey);
  }

  // ── the visitor's edits (SV1-b unit 2): places walked and people present, added or retired ──

  @Post(':visitId/places')
  @RolesFor('siteVisit.edit')
  addPlace(
    @Param('projectId') projectId: string,
    @Param('visitId') visitId: string,
    @Body(new ZodPipe(addSiteVisitPlaceSchema)) body: AddSiteVisitPlaceInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.visits.addPlace(projectId, visitId.toLowerCase(), body, user, idempotencyKey);
  }

  @Post(':visitId/places/:placeId/retire')
  @RolesFor('siteVisit.edit')
  retirePlace(
    @Param('projectId') projectId: string,
    @Param('visitId') visitId: string,
    @Param('placeId') placeId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.visits.retirePlace(projectId, visitId.toLowerCase(), placeId.toLowerCase(), user, idempotencyKey);
  }

  @Post(':visitId/attendees')
  @RolesFor('siteVisit.edit')
  addAttendee(
    @Param('projectId') projectId: string,
    @Param('visitId') visitId: string,
    @Body(new ZodPipe(addSiteVisitAttendeeSchema)) body: AddSiteVisitAttendeeInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.visits.addAttendee(projectId, visitId.toLowerCase(), body, user, idempotencyKey);
  }

  @Post(':visitId/attendees/:attendeeId/retire')
  @RolesFor('siteVisit.edit')
  retireAttendee(
    @Param('projectId') projectId: string,
    @Param('visitId') visitId: string,
    @Param('attendeeId') attendeeId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.visits.retireAttendee(projectId, visitId.toLowerCase(), attendeeId.toLowerCase(), user, idempotencyKey);
  }

  // ── a video clip's full-video link (Video V2g-1, #995): every member who may add a file reaches it; the service
  //    narrows it to the clip's adder, the people on the visit and the PMC ──

  @Put(':visitId/files/:mediaId/link')
  @RolesFor('media.upload')
  setFileLink(
    @Param('projectId') projectId: string,
    @Param(new ZodPipe(siteVisitLinkPathSchema)) path: SiteVisitLinkPath,
    @Body(new ZodPipe(setSiteVisitFileLinkSchema)) body: SetSiteVisitFileLinkInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.visits.setFileLink(projectId, path.visitId, path.mediaId, body, user, idempotencyKey);
  }

  @Delete(':visitId/files/:mediaId/link')
  @RolesFor('media.upload')
  endFileLink(
    @Param('projectId') projectId: string,
    @Param(new ZodPipe(siteVisitLinkPathSchema)) path: SiteVisitLinkPath,
    @Body(new ZodPipe(endSiteVisitFileLinkSchema)) body: EndSiteVisitFileLinkInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.visits.endFileLink(projectId, path.visitId, path.mediaId, body, user, idempotencyKey);
  }
}
