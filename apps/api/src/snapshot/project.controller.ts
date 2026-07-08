import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';

@Controller('projects/:projectId')
@UseGuards(JwtGuard)
export class ProjectController {
  constructor(private readonly snapshot: SnapshotService) {}

  /** Full project snapshot the frontend hydrates its store from (RBAC-filtered by role). */
  @Get('snapshot')
  snapshotFor(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
