import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { DailyLogService } from './daily-log.service';
import { DailyLogQueryService } from './daily-log.query';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import { addMaterialSchema, flagMismatchSchema, submitDailyLogSchema, type AddMaterialInput, type FlagMismatchInput, type SubmitDailyLogInput } from '../contracts';

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

  /** Start a fresh day's log (previous one must be submitted) — engineer (or PMC). */
  @Post('start')
  @RolesFor('dailyLog.start')
  start(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.dailyLog.start(projectId, user);
  }

  /** Record a material delivery on the open log — engineer (or PMC). */
  @Post('materials')
  @RolesFor('dailyLog.addMaterial')
  addMaterial(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(addMaterialSchema)) body: AddMaterialInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.dailyLog.addMaterial(projectId, body, user);
  }

  /** Flag a material mismatch against the plan — the site engineer (or PMC). */
  @Post('flag-mismatch')
  @RolesFor('dailyLog.flagMismatch')
  flag(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(flagMismatchSchema)) body: FlagMismatchInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.dailyLog.flagMismatch(projectId, body, user);
  }

  /** Submit the daily site log (attendance, crew, materials, photos) — the site engineer (or PMC). */
  @Post('submit')
  @RolesFor('dailyLog.submit')
  submit(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(submitDailyLogSchema)) body: SubmitDailyLogInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.dailyLog.submit(projectId, body, user);
  }
}
