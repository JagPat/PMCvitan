import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { OrgsService } from './orgs.service';
import { AuthService } from '../auth/auth.service';
import { ZodPipe } from '../common/zod.pipe';
import { createOrgSchema, createProjectSchema, type CreateOrgInput, type CreateProjectInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';

@Controller()
@UseGuards(JwtGuard)
export class OrgsController {
  constructor(
    private readonly orgs: OrgsService,
    private readonly auth: AuthService,
  ) {}

  /** Projects the current user can access (their memberships) — drives the project switcher. */
  @Get('me/memberships')
  memberships(@CurrentUser() user: AuthUser) {
    return this.auth.listMemberships(user.sub);
  }

  /** Orgs the current user administers or belongs to. */
  @Get('me/orgs')
  myOrgs(@CurrentUser() user: AuthUser) {
    return this.orgs.myOrgs(user.sub);
  }

  /** Create a new org (the caller becomes its owner). */
  @Post('orgs')
  createOrg(@CurrentUser() user: AuthUser, @Body(new ZodPipe(createOrgSchema)) body: CreateOrgInput) {
    return this.orgs.createOrg(user.sub, body);
  }

  /** Projects in an org. */
  @Get('orgs/:orgId/projects')
  listProjects(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser) {
    return this.orgs.listProjects(orgId, user.sub);
  }

  /** Create a project under an org (owner/admin only). */
  @Post('orgs/:orgId/projects')
  createProject(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(createProjectSchema)) body: CreateProjectInput,
  ) {
    return this.orgs.createProject(orgId, user.sub, body);
  }
}
