import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { DecisionsService } from './decisions.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { Roles, RolesGuard } from '../common/roles';
import { approveSchema, changeSchema, type ApproveInput, type ChangeInput } from '../contracts';

@Controller('projects/:projectId/decisions/:decisionId')
@UseGuards(JwtGuard, RolesGuard)
export class DecisionsController {
  constructor(private readonly decisions: DecisionsService) {}

  /** Approve/lock a decision — the client's choice, or the PMC/architect on their behalf. */
  @Post('approve')
  @Roles('client', 'pmc')
  approve(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(approveSchema)) body: ApproveInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.decisions.approve(projectId, decisionId, body, user);
  }

  /** Raise a change request against a decision — PMC, client, contractor, or the site
   *  engineer (the engineer's Decision Log UI exposes this, and the service records
   *  `actor: user.role`, so all four are legitimate change requesters). */
  @Post('change')
  @Roles('pmc', 'client', 'contractor', 'engineer')
  change(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(changeSchema)) body: ChangeInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.decisions.requestChange(projectId, decisionId, body, user);
  }
}
