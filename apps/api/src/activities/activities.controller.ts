import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Roles, RolesGuard } from '../common/roles';
import { createActivitySchema, overrideGateSchema, updateActivitySchema, type CreateActivityInput, type OverrideGateInput, type UpdateActivityInput } from '../contracts';

@Controller('projects/:projectId/activities')
@UseGuards(JwtGuard, RolesGuard)
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  /** Plan a new activity — the PMC authors the schedule. */
  @Post()
  @Roles('pmc')
  create(@Param('projectId') projectId: string, @Body(new ZodPipe(createActivitySchema)) body: CreateActivityInput, @CurrentUser() user: AuthUser) {
    return this.activities.create(projectId, body, user);
  }

  /** Edit the plan (name/zone/planned window/gates/links) — PMC only. */
  @Patch(':activityId')
  @Roles('pmc')
  update(
    @Param('projectId') projectId: string,
    @Param('activityId') activityId: string,
    @Body(new ZodPipe(updateActivitySchema)) body: UpdateActivityInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.activities.update(projectId, activityId, body, user);
  }

  /** Remove a planned activity — PMC only. */
  @Delete(':activityId')
  @Roles('pmc')
  remove(@Param('projectId') projectId: string, @Param('activityId') activityId: string, @CurrentUser() user: AuthUser) {
    return this.activities.remove(projectId, activityId, user);
  }

  /** Start an activity — the site engineer (or PMC) once its readiness gates pass. */
  @Post(':activityId/start')
  @Roles('engineer', 'pmc')
  start(@Param('projectId') projectId: string, @Param('activityId') activityId: string, @CurrentUser() user: AuthUser) {
    return this.activities.start(projectId, activityId, user);
  }

  /** Mark an activity complete — the site engineer (or PMC). */
  @Post(':activityId/complete')
  @Roles('engineer', 'pmc')
  complete(@Param('projectId') projectId: string, @Param('activityId') activityId: string, @CurrentUser() user: AuthUser) {
    return this.activities.complete(projectId, activityId, user);
  }

  /** Record a manual readiness exception — PMC only (attributable, evidenced, expiring). */
  @Post(':activityId/override')
  @Roles('pmc')
  override(
    @Param('projectId') projectId: string,
    @Param('activityId') activityId: string,
    @Body(new ZodPipe(overrideGateSchema)) body: OverrideGateInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.activities.override(projectId, activityId, body, user);
  }

  /** Revoke an override early — PMC only; the derivation rules again. */
  @Delete(':activityId/override/:overrideId')
  @Roles('pmc')
  revokeOverride(
    @Param('projectId') projectId: string,
    @Param('activityId') activityId: string,
    @Param('overrideId') overrideId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.activities.revokeOverride(projectId, activityId, overrideId, user);
  }
}
