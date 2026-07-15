import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { SnapshotService } from './snapshot.service';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';

@Controller('projects/:projectId')
@UseGuards(JwtGuard, RolesGuard)
export class ProjectController {
  constructor(private readonly snapshot: SnapshotService) {}

  /** Full project snapshot the frontend hydrates its store from (RBAC-filtered by role).
   *  Interactive session roles only — an anonymously-minted worker device token gets the
   *  QR job-card flow, not the project's decisions/drawings/inspections (SEC-02). */
  @Get('snapshot')
  @RolesFor('project.read')
  snapshotFor(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.snapshot.build(projectId, user.role, user.sub);
  }
}
