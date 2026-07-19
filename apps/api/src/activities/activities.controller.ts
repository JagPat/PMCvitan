import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { ActivitiesQueryService } from './activities.query';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import { createActivitySchema, overrideGateSchema, updateActivitySchema, type CreateActivityInput, type OverrideGateInput, type UpdateActivityInput } from '../contracts';

@Controller('projects/:projectId/activities')
@UseGuards(JwtGuard, RolesGuard)
export class ActivitiesController {
  constructor(
    private readonly activities: ActivitiesService,
    private readonly activitiesQuery: ActivitiesQueryService,
  ) {}

  /** Phase 2 Task 10 (Module 4) — the MODULE-OWNED activities read (XOR read-ownership): the frontend
   *  fetches the activity spine (`activities` + `phases`) HERE (from the rebuildable projection, else the
   *  live fallback) instead of the snapshot slice when `VITE_ACTIVITIES_READ=moduleQuery`. Readiness is
   *  baked FRESH from the foreign query contracts on both paths, so a projection read is never stale. */
  @Get()
  @RolesFor('project.read')
  read(@Param('projectId') projectId: string) {
    return this.activitiesQuery.moduleActivities(projectId);
  }

  /** Plan a new activity — the PMC authors the schedule. */
  @Post()
  @RolesFor('activity.manage')
  create(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createActivitySchema)) body: CreateActivityInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.activities.create(projectId, body, user, idempotencyKey);
  }

  /** Edit the plan (name/zone/planned window/gates/links) — PMC only. */
  @Patch(':activityId')
  @RolesFor('activity.manage')
  update(
    @Param('projectId') projectId: string,
    @Param('activityId') activityId: string,
    @Body(new ZodPipe(updateActivitySchema)) body: UpdateActivityInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.activities.update(projectId, activityId, body, user, idempotencyKey);
  }

  /** Remove a planned activity — PMC only. */
  @Delete(':activityId')
  @RolesFor('activity.manage')
  remove(
    @Param('projectId') projectId: string,
    @Param('activityId') activityId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.activities.remove(projectId, activityId, user, idempotencyKey);
  }

  /** Start an activity — the site engineer (or PMC) once its readiness gates pass. */
  @Post(':activityId/start')
  @RolesFor('activity.start')
  start(
    @Param('projectId') projectId: string,
    @Param('activityId') activityId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.activities.start(projectId, activityId, user, idempotencyKey);
  }

  /** Mark an activity complete — the site engineer (or PMC). */
  @Post(':activityId/complete')
  @RolesFor('activity.complete')
  complete(
    @Param('projectId') projectId: string,
    @Param('activityId') activityId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.activities.complete(projectId, activityId, user, idempotencyKey);
  }

  /** Record a manual readiness exception — PMC only (attributable, evidenced, expiring). */
  @Post(':activityId/override')
  @RolesFor('activity.manage')
  override(
    @Param('projectId') projectId: string,
    @Param('activityId') activityId: string,
    @Body(new ZodPipe(overrideGateSchema)) body: OverrideGateInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.activities.override(projectId, activityId, body, user, idempotencyKey);
  }

  /** Revoke an override early — PMC only; the derivation rules again. */
  @Delete(':activityId/override/:overrideId')
  @RolesFor('activity.manage')
  revokeOverride(
    @Param('projectId') projectId: string,
    @Param('activityId') activityId: string,
    @Param('overrideId') overrideId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.activities.revokeOverride(projectId, activityId, overrideId, user, idempotencyKey);
  }
}
