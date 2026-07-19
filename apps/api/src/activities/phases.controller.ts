import { Body, Controller, Delete, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { PhasesService } from './phases.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import { createPhaseSchema, type CreatePhaseInput } from '../contracts';

/** Project phases (schedule grouping) — authored by the PMC. */
@Controller('projects/:projectId/phases')
@UseGuards(JwtGuard, RolesGuard)
export class PhasesController {
  constructor(private readonly phases: PhasesService) {}

  @Post()
  @RolesFor('phase.manage')
  create(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createPhaseSchema)) body: CreatePhaseInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.phases.create(projectId, body, user, idempotencyKey);
  }

  /** Remove a phase — its activities become unphased (flat list), nothing is lost. */
  @Delete(':phaseId')
  @RolesFor('phase.manage')
  remove(
    @Param('projectId') projectId: string,
    @Param('phaseId') phaseId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.phases.remove(projectId, phaseId, user, idempotencyKey);
  }
}
