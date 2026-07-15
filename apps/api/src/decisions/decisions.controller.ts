import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { DecisionsService } from './decisions.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import { approveSchema, changeSchema, createDecisionSchema, type ApproveInput, type ChangeInput, type CreateDecisionInput } from '../contracts';

@Controller('projects/:projectId/decisions')
@UseGuards(JwtGuard, RolesGuard)
export class DecisionsController {
  constructor(private readonly decisions: DecisionsService) {}

  /** Issue a new decision (title/room + options) — the PMC/architect's authority. */
  @Post()
  @RolesFor('decision.create')
  create(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createDecisionSchema)) body: CreateDecisionInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.decisions.create(projectId, body, user);
  }

  /** Publish a private draft decision → issue it to the client (PMC/architect authority). */
  @Post(':decisionId/publish')
  @RolesFor('decision.publish')
  publish(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.decisions.publish(projectId, decisionId, user);
  }

  /** Approve/lock a decision — the client's choice, or the PMC/architect on their behalf. */
  @Post(':decisionId/approve')
  @RolesFor('decision.approve')
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
  @Post(':decisionId/change')
  @RolesFor('decision.change')
  change(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(changeSchema)) body: ChangeInput,
    @CurrentUser() user: AuthUser,
  ) {
    return this.decisions.requestChange(projectId, decisionId, body, user);
  }

  /** Withdraw the open change request — same roles that may raise one; the service
   *  narrows the authority to the actual REQUESTER or the PMC (Phase 1 Task 2). */
  @Post(':decisionId/change/withdraw')
  @RolesFor('decision.withdrawChange')
  withdrawChange(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.decisions.withdrawChange(projectId, decisionId, user);
  }
}
