import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { MembersService } from './members.service';
import { ZodPipe } from '../common/zod.pipe';
import { addMemberSchema, updateMemberSchema, type AddMemberInput, type UpdateMemberInput } from '../contracts';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';

/** Project team management. All routes are project-scoped, so the JwtGuard tenancy
 *  check already limits the caller to the project their token belongs to. */
@Controller('projects/:projectId/members')
@UseGuards(JwtGuard)
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  list(@Param('projectId') projectId: string) {
    return this.members.list(projectId);
  }

  @Post()
  add(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser, @Body(new ZodPipe(addMemberSchema)) body: AddMemberInput) {
    return this.members.add(projectId, user, body);
  }

  @Patch(':userId')
  updateRole(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthUser,
    @Body(new ZodPipe(updateMemberSchema)) body: UpdateMemberInput,
  ) {
    return this.members.updateRole(projectId, user, userId, body);
  }

  @Delete(':userId')
  remove(@Param('projectId') projectId: string, @Param('userId') userId: string, @CurrentUser() user: AuthUser) {
    return this.members.remove(projectId, user, userId);
  }
}
