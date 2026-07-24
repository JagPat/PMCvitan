import { Body, Controller, Delete, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { LabourService } from './labour.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  upsertLabourTradeSchema, upsertLabourSkillSchema, onboardWorkerSchema, revokeWorkerSchema,
  formCrewSchema, addCrewMemberSchema,
  type UpsertLabourTradeInput, type UpsertLabourSkillInput, type OnboardWorkerInput, type RevokeWorkerInput,
  type FormCrewInput, type AddCrewMemberInput,
} from '../contracts';

/**
 * Phase 4 Task 1 — the LABOUR module controller (plan §H). Trusted-workforce onboarding is `pmc`
 * authority (`labour.manage`); the workforce/catalog register reads are a pmc/engineer surface
 * (`labour.read`). Every route is project-scoped + capability-gated (the service asserts the
 * `labour` capability, 404 off-pilot). Mutations carry an Idempotency-Key through the command
 * ledger. The labour requirement DEMAND is authored through the Activities requirement command
 * (type-routed) — it is NOT a labour route.
 */
@Controller('projects/:projectId')
@UseGuards(JwtGuard, RolesGuard)
export class LabourController {
  constructor(private readonly labour: LabourService) {}

  @Post('labour/trades')
  @RolesFor('labour.manage')
  upsertTrade(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(upsertLabourTradeSchema)) body: UpsertLabourTradeInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.upsertTrade(projectId, body, user, idempotencyKey);
  }

  @Post('labour/skills')
  @RolesFor('labour.manage')
  upsertSkill(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(upsertLabourSkillSchema)) body: UpsertLabourSkillInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.upsertSkill(projectId, body, user, idempotencyKey);
  }

  @Post('labour/workers')
  @RolesFor('labour.manage')
  onboardWorker(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(onboardWorkerSchema)) body: OnboardWorkerInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.onboardWorker(projectId, body, user, idempotencyKey);
  }

  @Post('labour/workers/:workerId/revoke')
  @RolesFor('labour.manage')
  revokeWorker(
    @Param('projectId') projectId: string,
    @Param('workerId') workerId: string,
    @Body(new ZodPipe(revokeWorkerSchema)) body: RevokeWorkerInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.revokeWorker(projectId, workerId, body, user, idempotencyKey);
  }

  @Post('labour/crews')
  @RolesFor('labour.manage')
  formCrew(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(formCrewSchema)) body: FormCrewInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.formCrew(projectId, body, user, idempotencyKey);
  }

  @Post('labour/crews/:crewId/members')
  @RolesFor('labour.manage')
  addCrewMember(
    @Param('projectId') projectId: string,
    @Param('crewId') crewId: string,
    @Body(new ZodPipe(addCrewMemberSchema)) body: AddCrewMemberInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.addCrewMember(projectId, crewId, body, user, idempotencyKey);
  }

  @Delete('labour/crews/:crewId/members/:workerId')
  @RolesFor('labour.manage')
  removeCrewMember(
    @Param('projectId') projectId: string,
    @Param('crewId') crewId: string,
    @Param('workerId') workerId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // no body: removal is identified entirely by the (crew, worker) path params
    return this.labour.removeCrewMember(projectId, crewId, workerId, {}, user, idempotencyKey);
  }

  @Get('labour/workforce')
  @RolesFor('labour.read')
  workforce(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.labour.workforce(projectId, user);
  }

  @Get('labour/catalog')
  @RolesFor('labour.read')
  catalog(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.labour.catalog(projectId, user);
  }
}
