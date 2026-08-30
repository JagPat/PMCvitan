import { Body, Controller, Get, Headers, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { DecisionsService } from './decisions.service';
import { DecisionsQueryService } from './decisions.query';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import { approveSchema, changeSchema, createDecisionSchema, requestConsultationSchema, respondToConsultationSchema, updateDecisionDraftSchema, withdrawDecisionSchema, type ApproveInput, type ChangeInput, type CreateDecisionInput, type RequestConsultationInput, type RespondToConsultationInput, type UpdateDecisionDraftInput, type WithdrawDecisionInput } from '../contracts';
import { DECISIONS_CONTRACT_HEADER } from '../common/recorded-compat.interceptor';

@Controller('projects/:projectId/decisions')
@UseGuards(JwtGuard, RolesGuard)
export class DecisionsController {
  constructor(
    private readonly decisions: DecisionsService,
    // Task 9 — the module-owned decision READ (served from the rebuildable projection, role-filtered).
    private readonly decisionsQuery: DecisionsQueryService,
  ) {}

  /** Phase 2 Task 9 — the MODULE-OWNED decisions read: the project's role-filtered decisions served
   *  from the decisions projection (with a live fallback while the projection warms up). This is the
   *  read the web app fetches once the decisions module is switched off the full-snapshot slice (XOR
   *  read-ownership). Interactive session roles only, same as the snapshot read. */
  @Get()
  @RolesFor('project.read')
  list(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.decisionsQuery.moduleDecisions(projectId, user.role, user.sub);
  }

  /** Issue a new decision (title/room + options) — the PMC/architect's authority. The optional
   *  `Idempotency-Key` header makes a retried/replayed issue create the decision exactly once. */
  @Post()
  @RolesFor('decision.create')
  create(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createDecisionSchema)) body: CreateDecisionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.create(projectId, body, user, idempotencyKey);
  }

  /** Publish a private draft decision → issue it to the client (PMC/architect authority). */
  @Post(':decisionId/publish')
  @RolesFor('decision.publish')
  publish(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.publish(projectId, decisionId, user, idempotencyKey);
  }

  /** Phase 6 task 4b (§A.1/§A.2) — edit an UNPUBLISHED draft: re-point its decider (kind /
   *  named membership), convert to or from a record (`none` ⟺ `recorded`, options replaced as
   *  one coherent pair), or replace its options. The service narrows authority to the draft's
   *  AUTHOR or a pmc; a published decision is refused (409) — publication freezes the holder. */
  @Patch(':decisionId/draft')
  @RolesFor('decision.updateDraft')
  updateDraft(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(updateDecisionDraftSchema)) body: UpdateDecisionDraftInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.updateDraft(projectId, decisionId, body, user, idempotencyKey);
  }

  /** Approve/lock a decision — the client's choice, or the PMC/architect on their behalf. A
   *  retry with the same `Idempotency-Key` replays the same lock instead of racing a 409. */
  @Post(':decisionId/approve')
  @RolesFor('decision.approve')
  approve(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(approveSchema)) body: ApproveInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.approve(projectId, decisionId, body, user, idempotencyKey);
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
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.requestChange(projectId, decisionId, body, user, idempotencyKey);
  }

  /** Withdraw a PUBLISHED, never-approved decision — the PMC takes back a question that
   *  should not have been asked (Phase 6 task 4a). Terminal; the reason is required; a
   *  draft or an approved/reopened decision is refused (409). Distinct from the change-
   *  request withdrawal below, which closes a reopening on an APPROVED decision. */
  @Post(':decisionId/withdraw')
  @RolesFor('decision.withdraw')
  withdraw(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(withdrawDecisionSchema)) body: WithdrawDecisionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.withdraw(projectId, decisionId, body, user, idempotencyKey);
  }

  /** Withdraw the open change request — same roles that may raise one; the service
   *  narrows the authority to the actual REQUESTER or the PMC (Phase 1 Task 2). */
  @Post(':decisionId/change/withdraw')
  @RolesFor('decision.withdrawChange')
  withdrawChange(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.withdrawChange(projectId, decisionId, user, idempotencyKey);
  }

  /** Phase 6 unit 4c-ii (§A) — ask a named ACTIVE member for advice on a published, still-open
   *  decision. Capability-gated (404 off the rollout latch) and CLIENT-CONTRACT-gated: the
   *  declared `x-vitan-decisions-contract` travels to the service, which refuses a bundle that
   *  could not then show the thread it just created. */
  @Post(':decisionId/consultations')
  @RolesFor('decision.consult')
  requestConsultation(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(requestConsultationSchema)) body: RequestConsultationInput,
    @CurrentUser() user: AuthUser,
    @Headers(DECISIONS_CONTRACT_HEADER) contractDeclared?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.requestConsultation(projectId, decisionId, body, user, contractDeclared, idempotencyKey);
  }

  /** Phase 6 unit 4c-ii (§A) — answer one outstanding consultation. The route ceiling is the union
   *  of consultable roles; the SERVICE narrows to the ONE named consultee. */
  @Post(':decisionId/consultations/:consultationId/respond')
  @RolesFor('decision.respondConsult')
  respondToConsultation(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Param('consultationId') consultationId: string,
    @Body(new ZodPipe(respondToConsultationSchema)) body: RespondToConsultationInput,
    @CurrentUser() user: AuthUser,
    @Headers(DECISIONS_CONTRACT_HEADER) contractDeclared?: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.respondToConsultation(projectId, decisionId, consultationId, body, user, contractDeclared, idempotencyKey);
  }
}
