import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Roles, RolesGuard } from '../common/roles';

@Controller('projects/:projectId/activities/:activityId')
@UseGuards(JwtGuard, RolesGuard)
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  /** Start an activity — the site engineer (or PMC) once its readiness gates pass. */
  @Post('start')
  @Roles('engineer', 'pmc')
  start(@Param('projectId') projectId: string, @Param('activityId') activityId: string, @CurrentUser() user: AuthUser) {
    return this.activities.start(projectId, activityId, user);
  }

  /** Mark an activity complete — the site engineer (or PMC). */
  @Post('complete')
  @Roles('engineer', 'pmc')
  complete(@Param('projectId') projectId: string, @Param('activityId') activityId: string, @CurrentUser() user: AuthUser) {
    return this.activities.complete(projectId, activityId, user);
  }
}
