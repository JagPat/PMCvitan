import { Body, Controller, Delete, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { NodesService } from './nodes.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import { createNodeSchema, moveNodeSchema, renameNodeSchema, type CreateNodeInput, type MoveNodeInput, type RenameNodeInput } from '../contracts';

/** The project location tree (zones → rooms → elements). PMC authors it — the same
 *  authority that issues decisions and controls the drawing register. */
@Controller('projects/:projectId/nodes')
@UseGuards(JwtGuard, RolesGuard)
export class NodesController {
  constructor(private readonly nodes: NodesService) {}

  @Post()
  @RolesFor('node.manage')
  create(@Param('projectId') projectId: string, @Body(new ZodPipe(createNodeSchema)) body: CreateNodeInput, @CurrentUser() user: AuthUser) {
    return this.nodes.create(projectId, body, user);
  }

  @Patch(':nodeId')
  @RolesFor('node.manage')
  rename(@Param('projectId') projectId: string, @Param('nodeId') nodeId: string, @Body(new ZodPipe(renameNodeSchema)) body: RenameNodeInput, @CurrentUser() user: AuthUser) {
    return this.nodes.rename(projectId, nodeId, body, user);
  }

  @Post(':nodeId/move')
  @RolesFor('node.manage')
  move(@Param('projectId') projectId: string, @Param('nodeId') nodeId: string, @Body(new ZodPipe(moveNodeSchema)) body: MoveNodeInput, @CurrentUser() user: AuthUser) {
    return this.nodes.move(projectId, nodeId, body, user);
  }

  /** Publish a private draft location (its subtree + draft ancestors) to the team. PMC only. */
  @Post(':nodeId/publish')
  @RolesFor('node.manage')
  publish(@Param('projectId') projectId: string, @Param('nodeId') nodeId: string, @CurrentUser() user: AuthUser) {
    return this.nodes.publish(projectId, nodeId, user);
  }

  @Delete(':nodeId')
  @RolesFor('node.manage')
  remove(@Param('projectId') projectId: string, @Param('nodeId') nodeId: string, @CurrentUser() user: AuthUser) {
    return this.nodes.remove(projectId, nodeId, user);
  }
}
