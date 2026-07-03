import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { DailyLogService } from './daily-log.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { flagMismatchSchema, submitDailyLogSchema, type FlagMismatchInput, type SubmitDailyLogInput } from '../contracts';

@Controller('projects/:projectId/daily-log')
@UseGuards(JwtGuard)
export class DailyLogController {
  constructor(private readonly dailyLog: DailyLogService) {}

  @Post('flag-mismatch')
  flag(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(flagMismatchSchema)) body: FlagMismatchInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.dailyLog.flagMismatch(projectId, body, user);
  }

  @Post('submit')
  submit(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(submitDailyLogSchema)) body: SubmitDailyLogInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.dailyLog.submit(projectId, body, user);
  }
}
