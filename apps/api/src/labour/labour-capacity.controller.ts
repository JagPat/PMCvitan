import { Body, Controller, Get, Headers, Param, Post, Query, UseGuards } from '@nestjs/common';
import { LabourCapacityService } from './labour-capacity.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  allocateLabourSchema, releaseLabourAllocationSchema, recordAttendanceSchema, revokeAttendanceSchema,
  recordLabourWorkSchema, approveSkillSubstitutionSchema, revokeSkillSubstitutionSchema,
  recordLabourMismatchSchema, resolveLabourMismatchSchema,
  type AllocateLabourInput, type ReleaseLabourAllocationInput, type RecordAttendanceInput,
  type RevokeAttendanceInput, type RecordLabourWorkInput, type ApproveSkillSubstitutionInput,
  type RevokeSkillSubstitutionInput,
  type RecordLabourMismatchInput, type ResolveLabourMismatchInput,
} from '../contracts';

/**
 * Phase 4 Task 3 — the §C TIME-CAPACITY fact routes (plan §H matrix). Allocation is pmc/engineer
 * planning work, the muster is pmc/engineer/contractor (plus the worker's own bound device),
 * revoking presence is a pmc CORRECTION, effort mirrors the muster, and widening §B satisfaction
 * with a skill substitution is pmc authority — the same authority that approves a MATERIAL
 * substitution. Every route is project-scoped + capability-gated (404 off-pilot) and carries an
 * Idempotency-Key through the command ledger.
 */
@Controller('projects/:projectId')
@UseGuards(JwtGuard, RolesGuard)
export class LabourCapacityController {
  constructor(private readonly capacity: LabourCapacityService) {}

  @Post('labour/allocations')
  @RolesFor('allocation.manage')
  allocate(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(allocateLabourSchema)) body: AllocateLabourInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.capacity.allocate(projectId, body, user, idempotencyKey);
  }

  @Post('labour/allocations/:allocationId/release')
  @RolesFor('allocation.manage')
  release(
    @Param('projectId') projectId: string,
    @Param('allocationId') allocationId: string,
    @Body(new ZodPipe(releaseLabourAllocationSchema)) body: ReleaseLabourAllocationInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.capacity.release(projectId, allocationId, body, user, idempotencyKey);
  }

  @Post('labour/attendance')
  @RolesFor('attendance.record')
  recordAttendance(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(recordAttendanceSchema)) body: RecordAttendanceInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.capacity.recordAttendance(projectId, body, user, idempotencyKey);
  }

  @Post('labour/attendance/:attendanceId/revoke')
  @RolesFor('attendance.revoke')
  revokeAttendance(
    @Param('projectId') projectId: string,
    @Param('attendanceId') attendanceId: string,
    @Body(new ZodPipe(revokeAttendanceSchema)) body: RevokeAttendanceInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.capacity.revokeAttendance(projectId, attendanceId, body, user, idempotencyKey);
  }

  @Post('labour/work')
  @RolesFor('labour.work.record')
  recordWork(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(recordLabourWorkSchema)) body: RecordLabourWorkInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.capacity.recordWork(projectId, body, user, idempotencyKey);
  }

  @Post('labour/skill-substitutions')
  @RolesFor('labour.override')
  approveSkillSubstitution(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(approveSkillSubstitutionSchema)) body: ApproveSkillSubstitutionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.capacity.approveSkillSubstitution(projectId, body, user, idempotencyKey);
  }

  @Post('labour/skill-substitutions/:substitutionId/revoke')
  @RolesFor('labour.override')
  revokeSkillSubstitution(
    @Param('projectId') projectId: string,
    @Param('substitutionId') substitutionId: string,
    @Body(new ZodPipe(revokeSkillSubstitutionSchema)) body: RevokeSkillSubstitutionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.capacity.revokeSkillSubstitution(projectId, substitutionId, body, user, idempotencyKey);
  }

  @Get('labour/capacity')
  @RolesFor('labour.read')
  capacityRegister(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.capacity.capacity(projectId, user, from, to);
  }

  @Get('labour/readiness')
  @RolesFor('labour.read')
  readiness(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.capacity.readiness(projectId, user);
  }

  // Phase 4 Task 5 — §E reconciliation: observe (pmc/engineer), resolve (pmc), and the per-worker
  // Daily-Log presence read (labour.read). All pilot-gated (404 off-pilot).
  @Post('labour/mismatches')
  @RolesFor('labour.mismatch.record')
  recordMismatch(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(recordLabourMismatchSchema)) body: RecordLabourMismatchInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.capacity.recordMismatch(projectId, body, user, idempotencyKey);
  }

  @Post('labour/mismatches/:mismatchId/resolve')
  @RolesFor('labour.mismatch.resolve')
  resolveMismatch(
    @Param('projectId') projectId: string,
    @Param('mismatchId') mismatchId: string,
    @Body(new ZodPipe(resolveLabourMismatchSchema)) body: ResolveLabourMismatchInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.capacity.resolveMismatch(projectId, mismatchId, body, user, idempotencyKey);
  }

  @Get('labour/presence')
  @RolesFor('labour.read')
  presence(
    @Param('projectId') projectId: string,
    @Query('civilDate') civilDate: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.capacity.presence(projectId, civilDate, user);
  }
}
