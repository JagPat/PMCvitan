import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { DailyLogService } from './daily-log.service';
import { DailyLogQueryService } from './daily-log.query';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  addMaterialSchema, flagMismatchSchema, resolveMismatchSchema, submitDailyLogSchema,
  type AddMaterialInput, type FlagMismatchInput, type ResolveMismatchInput, type SubmitDailyLogInput,
} from '../contracts';

@Controller('projects/:projectId/daily-log')
@UseGuards(JwtGuard, RolesGuard)
export class DailyLogController {
  constructor(
    private readonly dailyLog: DailyLogService,
    // Task 10 — the module-owned daily-log READ (served from the rebuildable projection, live fallback).
    private readonly dailyLogQuery: DailyLogQueryService,
  ) {}

  /** Phase 2 Task 10 — the MODULE-OWNED daily-log read: the project's daily-log slice (latest log core
   *  + every project material) served from the daily-log projection (with a live fallback while the
   *  projection warms up). This is the read the web app fetches once the daily-log module is switched
   *  off the full-snapshot slice (XOR read-ownership). Role-invariant; interactive session roles only. */
  @Get()
  @RolesFor('project.read')
  read(@Param('projectId') projectId: string) {
    return this.dailyLogQuery.moduleDailyLog(projectId);
  }

  /** Start a fresh day's log (previous one must be submitted) — engineer (or PMC). The optional
   *  `Idempotency-Key` header makes a retried/replayed start create the day's log exactly once. */
  @Post('start')
  @RolesFor('dailyLog.start')
  start(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.dailyLog.start(projectId, user, idempotencyKey);
  }

  /** Record a material delivery on the open log — engineer (or PMC). A retry with the same
   *  `Idempotency-Key` records the material exactly once. */
  @Post('materials')
  @RolesFor('dailyLog.addMaterial')
  addMaterial(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(addMaterialSchema)) body: AddMaterialInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.dailyLog.addMaterial(projectId, body, user, idempotencyKey);
  }

  /** Flag a material mismatch against the plan — the site engineer (or PMC). Keyed for replay-safety. */
  @Post('flag-mismatch')
  @RolesFor('dailyLog.flagMismatch')
  flag(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(flagMismatchSchema)) body: FlagMismatchInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.dailyLog.flagMismatch(projectId, body, user, idempotencyKey);
  }

  /** Phase 3 Task 5 (§E) — close ONE mismatch observation with an explicit disposition + reason; the
   *  activity block clears only when no unresolved mismatch remains. Pilot-gated in the service (§D);
   *  pmc-only. Keyed for replay-safety. */
  @Post('resolve-mismatch')
  @RolesFor('dailyLog.resolveMismatch')
  resolveMismatch(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(resolveMismatchSchema)) body: ResolveMismatchInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.dailyLog.resolveMismatch(projectId, body, user, idempotencyKey);
  }

  /** Submit the daily site log (attendance, crew, materials, photos) — the site engineer (or PMC). A
   *  retry with the same `Idempotency-Key` applies the submission exactly once. */
  @Post('submit')
  @RolesFor('dailyLog.submit')
  submit(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(submitDailyLogSchema)) body: SubmitDailyLogInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.dailyLog.submit(projectId, body, user, idempotencyKey);
  }
}
