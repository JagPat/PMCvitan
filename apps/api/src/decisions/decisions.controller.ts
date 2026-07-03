import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { DecisionsService } from './decisions.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { approveSchema, changeSchema, type ApproveInput, type ChangeInput } from '../contracts';

@Controller('projects/:projectId/decisions/:decisionId')
@UseGuards(JwtGuard)
export class DecisionsController {
  constructor(private readonly decisions: DecisionsService) {}

  @Post('approve')
  approve(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(approveSchema)) body: ApproveInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.decisions.approve(projectId, decisionId, body, user);
  }

  @Post('change')
  change(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(changeSchema)) body: ChangeInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.decisions.requestChange(projectId, decisionId, body, user);
  }
}
