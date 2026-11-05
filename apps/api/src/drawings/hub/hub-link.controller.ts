import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { CurrentUser, IdentityScoped, JwtGuard, type AuthUser } from '../../common/auth';
import { AllowAnyRole, RolesGuard } from '../../common/roles';
import { HubLinkService } from './hub-link.service';

/** Company owner/admin authority is checked inside HubLinkService (an org role, not a project role). */
const HUB_LINK_AUTHZ = 'HubLinkService enforces company owner/admin authority for this route';

/**
 * #1118 U7a L1a — a project's Hub link screen, for a company owner or admin. Like the org admin routes, the project is `:pid`
 * (not `:projectId`) and the route is identity-scoped: an owner or admin works on any project of the company, not only the
 * one their sign-in points at. While Hub is not connected, or for another company, it answers 404. The link and unlink
 * commands come in L1b.
 */
@Controller()
@IdentityScoped()
@UseGuards(JwtGuard, RolesGuard)
export class HubLinkController {
  constructor(private readonly hubLink: HubLinkService) {}

  /** The Hub projects PMC can link this project to, each marked when a PMC project holds it. */
  @Get('orgs/:orgId/projects/:pid/hub/projects')
  @AllowAnyRole(HUB_LINK_AUTHZ)
  projects(@Param('orgId') orgId: string, @Param('pid') pid: string, @CurrentUser() user: AuthUser) {
    return this.hubLink.listProjects(orgId, user, pid);
  }
}
