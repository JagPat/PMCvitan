import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { RequirementsService } from './requirements.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  createRequirementSchema, reviseRequirementSchema, cancelRequirementSchema,
  type CreateRequirementInput, type ReviseRequirementInput, type CancelRequirementInput,
} from '../contracts';

/**
 * Phase 3 Task 1 — the ActivityRequirement demand contract (pmc authority, plan §H matrix).
 * Every handler is CAPABILITY-GATED in the service (§D): a non-pilot project gets 404 — the
 * surface does not exist for it. Revisions are append-only; there is no PATCH/DELETE.
 */
@Controller('projects/:projectId/requirements')
@UseGuards(JwtGuard, RolesGuard)
export class RequirementsController {
  constructor(private readonly requirements: RequirementsService) {}

  @Get()
  list(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.requirements.list(projectId, user);
  }

  @Post()
  @RolesFor('requirement.manage')
  create(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createRequirementSchema)) body: CreateRequirementInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.requirements.create(projectId, body, user, idempotencyKey);
  }

  @Post(':requirementId/revise')
  @RolesFor('requirement.manage')
  revise(
    @Param('projectId') projectId: string,
    @Param('requirementId') requirementId: string,
    @Body(new ZodPipe(reviseRequirementSchema)) body: ReviseRequirementInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.requirements.revise(projectId, requirementId, body, user, idempotencyKey);
  }

  @Post(':requirementId/cancel')
  @RolesFor('requirement.manage')
  cancel(
    @Param('projectId') projectId: string,
    @Param('requirementId') requirementId: string,
    @Body(new ZodPipe(cancelRequirementSchema)) body: CancelRequirementInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.requirements.cancel(projectId, requirementId, body, user, idempotencyKey);
  }
}
