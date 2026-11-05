import { Body, Controller, Get, Headers, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, IdentityScoped, JwtGuard, type AuthUser } from '../../common/auth';
import { AllowAnyRole, RolesGuard } from '../../common/roles';
import { ZodPipe } from '../../common/zod.pipe';
import { hubLinkSchema, type HubLinkInput } from '../../contracts';
import { HubLinkService } from './hub-link.service';

/** Company owner/admin authority is checked inside HubLinkService (an org role, not a project role). */
const HUB_LINK_AUTHZ = 'HubLinkService enforces company owner/admin authority for this route';

/**
 * #1118 U7a L1 — a project's Hub link, for a company owner or admin. Like the org admin routes, the project is `:pid`
 * (not `:projectId`) and the routes are identity-scoped: an owner or admin links any project of the company, not only
 * the one their sign-in points at. While Hub is not connected, or for another company, every route answers 404.
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

  /** Link the project to a Hub project, in Hub and then in PMC. */
  @Post('orgs/:orgId/projects/:pid/hub/link')
  @HttpCode(200)
  @AllowAnyRole(HUB_LINK_AUTHZ)
  link(
    @Param('orgId') orgId: string,
    @Param('pid') pid: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(hubLinkSchema)) body: HubLinkInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.hubLink.link(orgId, user, pid, body.hubProjectId, idempotencyKey);
  }

  /** Unlink the project: PMC's link ends; the answer says whether Hub's link is gone too. */
  @Post('orgs/:orgId/projects/:pid/hub/unlink')
  @HttpCode(200)
  @AllowAnyRole(HUB_LINK_AUTHZ)
  unlink(
    @Param('orgId') orgId: string,
    @Param('pid') pid: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.hubLink.unlink(orgId, user, pid, idempotencyKey);
  }
}
