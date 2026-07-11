import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { NodesService } from './nodes.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Roles, RolesGuard } from '../common/roles';
import { createNodeSchema, moveNodeSchema, renameNodeSchema, type CreateNodeInput, type MoveNodeInput, type RenameNodeInput } from '../contracts';

/** The project location tree (zones → rooms → elements). PMC authors it — the same
 *  authority that issues decisions and controls the drawing register. */
@Controller('projects/:projectId/nodes')
@UseGuards(JwtGuard, RolesGuard)
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Post()
  @Roles('pmc')
  create(@Param('projectId') projectId: string, @Body(new ZodPipe(createNodeSchema)) body: CreateNodeInput, @CurrentUser() user: AuthUser) {
    return this.nodes.create(projectId, body, user);
  }

  @Patch(':nodeId')
  @Roles('pmc')
  rename(@Param('projectId') projectId: string, @Param('nodeId') nodeId: string, @Body(new ZodPipe(renameNodeSchema)) body: RenameNodeInput, @CurrentUser() user: AuthUser) {
    return this.nodes.rename(projectId, nodeId, body, user);
  }

  @Post(':nodeId/move')
  @Roles('pmc')
  move(@Param('projectId') projectId: string, @Param('nodeId') nodeId: string, @Body(new ZodPipe(moveNodeSchema)) body: MoveNodeInput, @CurrentUser() user: AuthUser) {
    return this.nodes.move(projectId, nodeId, body, user);
  }

  @Delete(':nodeId')
  @Roles('pmc')
  remove(@Param('projectId') projectId: string, @Param('nodeId') nodeId: string, @CurrentUser() user: AuthUser) {
    return this.nodes.remove(projectId, nodeId, user);
  }
}
