import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { OrgsService } from './orgs.service';
import { AuthService } from '../auth/auth.service';
import { ZodPipe } from '../common/zod.pipe';
import { addOrgMemberSchema, createOrgSchema, createProjectSchema, updateOrgMemberSchema, updateProjectSchema, type AddOrgMemberInput, type CreateOrgInput, type CreateProjectInput, type UpdateOrgMemberInput, type UpdateProjectInput } from '../contracts';
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

  /** Cross-project monitoring rollup — one row per project the user can access. */
  @Get('me/portfolio')
  portfolio(@CurrentUser() user: AuthUser) {
    return this.orgs.portfolio(user.sub);
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

  /** The org's admin roster (owner/admin only). */
  @Get('orgs/:orgId/members')
  listOrgMembers(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser) {
    return this.orgs.listOrgMembers(orgId, user.sub);
  }

  /** Add someone to the org's admin roster — owner/admin/member (org owner only). */
  @Post('orgs/:orgId/members')
  addOrgMember(
    @Param('orgId') orgId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(addOrgMemberSchema)) body: AddOrgMemberInput,
  ) {
    return this.orgs.addOrgMember(orgId, user.sub, body);
  }

  /** Change an org member's role (org owner only). */
  @Patch('orgs/:orgId/members/:userId')
  updateOrgMember(
    @Param('orgId') orgId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(updateOrgMemberSchema)) body: UpdateOrgMemberInput,
  ) {
    return this.orgs.updateOrgMemberRole(orgId, user.sub, userId, body);
  }

  /** Revoke someone's org membership (org owner only). */
  @Delete('orgs/:orgId/members/:userId')
  removeOrgMember(@Param('orgId') orgId: string, @Param('userId') userId: string, @CurrentUser() user: AuthUser) {
    return this.orgs.removeOrgMember(orgId, user.sub, userId);
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

  // NOTE: these org-scoped admin routes deliberately name the project param `:pid`,
  // NOT `:projectId` — the JwtGuard tenancy check rejects any `:projectId` route that
  // doesn't match the token's project, which would block an admin from deleting a
  // project they aren't currently scoped to. Authorization here is by ORG role instead.

  /** Edit a project's details (project PMC or org owner/admin). */
  @Patch('orgs/:orgId/projects/:pid')
  updateProject(
    @Param('orgId') orgId: string,
    @Param('pid') pid: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(updateProjectSchema)) body: UpdateProjectInput,
  ) {
    return this.orgs.updateProject(orgId, user.sub, pid, body);
  }

  /** Archive (soft-delete) a project — hidden from listings/switcher/portfolio (owner/admin). */
  @Delete('orgs/:orgId/projects/:pid')
  deleteProject(@Param('orgId') orgId: string, @Param('pid') pid: string, @CurrentUser() user: AuthUser) {
    return this.orgs.deleteProject(orgId, user.sub, pid);
  }

  /** Restore a previously archived project (owner/admin). */
  @Post('orgs/:orgId/projects/:pid/restore')
  restoreProject(@Param('orgId') orgId: string, @Param('pid') pid: string, @CurrentUser() user: AuthUser) {
    return this.orgs.restoreProject(orgId, user.sub, pid);
  }
}
