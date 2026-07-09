import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { DailyLogService } from './daily-log.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Roles, RolesGuard } from '../common/roles';
import { flagMismatchSchema, submitDailyLogSchema, type FlagMismatchInput, type SubmitDailyLogInput } from '../contracts';

@Controller('projects/:projectId/daily-log')
@UseGuards(JwtGuard, RolesGuard)
export class DailyLogController {
  constructor(private readonly dailyLog: DailyLogService) {}

  /** Flag a material mismatch against the plan — the site engineer (or PMC). */
  @Post('flag-mismatch')
  @Roles('engineer', 'pmc')
  flag(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(flagMismatchSchema)) body: FlagMismatchInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.dailyLog.flagMismatch(projectId, body, user);
  }

  /** Submit the daily site log (attendance, crew, materials, photos) — the site engineer (or PMC). */
  @Post('submit')
  @Roles('engineer', 'pmc')
  submit(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(submitDailyLogSchema)) body: SubmitDailyLogInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.dailyLog.submit(projectId, body, user);
  }
}
