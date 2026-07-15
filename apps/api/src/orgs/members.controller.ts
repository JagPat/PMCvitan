import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { MembersService } from './members.service';
import { ZodPipe } from '../common/zod.pipe';
import { addMemberSchema, updateMemberSchema, type AddMemberInput, type UpdateMemberInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { AllowAnyRole, RolesFor, RolesGuard } from '../common/roles';

const MEMBERS_AUTHZ = 'MembersService.canManage() enforces project-PMC / org owner-admin authority';

/** Project team management. All routes are project-scoped, so the JwtGuard tenancy
 *  check already limits the caller to the project their token belongs to. RolesGuard is
 *  in the chain so read routes can name their allowed roles (mutations use @AllowAnyRole,
 *  which RolesGuard passes through to the service's own authority check). */
@Controller('projects/:projectId/members')
@UseGuards(JwtGuard, RolesGuard)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  /** Roster with contact PII — interactive session roles only. Excludes the
   *  anonymously-minted `worker` device token, which must never read team PII (P1-2). */
  @Get()
  @RolesFor('members.read')
  list(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.members.list(projectId, user);
  }

  @Post()
  @AllowAnyRole(MEMBERS_AUTHZ)
  add(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser, @Body(new ZodPipe(addMemberSchema)) body: AddMemberInput) {
    return this.members.add(projectId, user, body);
  }

  @Patch(':userId')
  @AllowAnyRole(MEMBERS_AUTHZ)
  updateRole(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(updateMemberSchema)) body: UpdateMemberInput,
  ) {
    return this.members.updateRole(projectId, user, userId, body);
  }

  @Delete(':userId')
  @AllowAnyRole(MEMBERS_AUTHZ)
  remove(@Param('projectId') projectId: string, @Param('userId') userId: string, @CurrentUser() user: AuthUser) {
    return this.members.remove(projectId, user, userId);
  }
}
