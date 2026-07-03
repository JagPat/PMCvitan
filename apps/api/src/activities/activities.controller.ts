import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ActivitiesService } from './activities.service';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';

@Controller('projects/:projectId/activities/:activityId')
@UseGuards(JwtGuard)
export class ActivitiesController {
  constructor(private readonly activities: ActivitiesService) {}

  @Post('start')
  start(@Param('projectId') projectId: string, @Param('activityId') activityId: string, @CurrentUser() user: AuthUser) {
    return this.activities.start(projectId, activityId, user);
  }

  @Post('complete')
  complete(@Param('projectId') projectId: string, @Param('activityId') activityId: string, @CurrentUser() user: AuthUser) {
    return this.activities.complete(projectId, activityId, user);
  }
}
