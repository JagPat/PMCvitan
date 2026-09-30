import { Body, Controller, Get, Headers, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { DecisionsService } from './decisions.service';
import { DecisionsQueryService } from './decisions.query';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import { approveSchema, changeSchema, createDecisionSchema, forwardDecisionSchema, disagreeDecisionSchema, resolveStrandedCountersignSchema, requestConsultationSchema, respondToConsultationSchema, updateDecisionDraftSchema, withdrawDecisionSchema, type ApproveInput, type ChangeInput, type CreateDecisionInput, type ForwardDecisionInput, type DisagreeDecisionInput, type ResolveStrandedCountersignInput, type RequestConsultationInput, type RespondToConsultationInput, type UpdateDecisionDraftInput, type WithdrawDecisionInput } from '../contracts';

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

  /** Phase 6 task 4d (4d-ii-a / A8a, §A.2) — FORWARD an open, published decision to another
   *  designation. The route ceiling is every holder-capable role; the service narrows to the
   *  decision's current holder, the PMC or an architect, and refuses 409 while 4d-i's reservation
   *  stands. A retry with the same `Idempotency-Key` replays the same hand-off. */
  @Post(':decisionId/forward')
  @RolesFor('decision.forward')
  forward(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(forwardDecisionSchema)) body: ForwardDecisionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.forward(projectId, decisionId, body, user, idempotencyKey);
  }

  /** Phase 6 task 4d (4d-ii-a / A8b, §A.2) — the ARCHITECT countersigns a provisional approval: the
   *  `DecisionCountersign` fact naming the exact head revision, its finality flip and
   *  `awaiting_countersign → approved` commit together, announced by the finalizing event the revision's
   *  recorded `approvedFrom` chooses. Refused 409 unless the decision awaits its countersign. */
  @Post(':decisionId/countersign')
  @RolesFor('decision.countersign')
  countersign(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.countersign(projectId, decisionId, user, idempotencyKey);
  }

  /** Phase 6 task 4d (4d-ii-a / A8b, §A.2 "Disagreement") — the ARCHITECT rejects a provisional approval
   *  back to its decider (`reject_back`) or hands it on to a named designation (`forward_on`, through the
   *  one forward door): the decision lands `change` with an open `countersign_rejection` request. */
  @Post(':decisionId/disagree')
  @RolesFor('decision.disagree')
  disagree(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(disagreeDecisionSchema)) body: DisagreeDecisionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.disagree(projectId, decisionId, body, user, idempotencyKey);
  }

  /** Phase 6 task 4d (4d-ii-a / A8b, §A.2 "the stranded decision") — the PMC resolves a decision left
   *  awaiting its countersign with NO active architect: `completed` finalizes it under the no-chain rule,
   *  `returned` sends it back to its decider with the rejection request (re-homing an emptied designation
   *  with a same-bundle forward). Refused 409 while an architect is active. */
  @Post(':decisionId/stranded')
  @RolesFor('decision.resolveStrandedCountersign')
  resolveStranded(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(resolveStrandedCountersignSchema)) body: ResolveStrandedCountersignInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.resolveStrandedCountersign(projectId, decisionId, body, user, idempotencyKey);
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

  /**
   * Phase 6 unit 4c-ii (§A) — ASK a named member for advice on an open decision.
   *
   * The route ceiling is the REQUESTING set (`pmc` in 4c; `architect` joins in 4d with the role).
   * Since 4c-iv there is no per-project gate on this route: consultation is a core decision
   * workflow, and the rollout latch 4c-ii/4c-iii used has retired.
   */
  @Post(':decisionId/consultations')
  @RolesFor('consultation.request')
  requestConsultation(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(requestConsultationSchema)) body: RequestConsultationInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.requestConsultation(projectId, decisionId, body, user, idempotencyKey);
  }

  /**
   * Phase 6 unit 4c-ii (§A) — the NAMED consultee answers.
   *
   * The ceiling admits EVERY role a consultee can hold, and the SERVICE narrows to the one named
   * consultee. That is the delivered 4b widen-ceiling-narrow-in-service rule, and it is
   * load-bearing here: a ceiling tighter than the eligible set would make `RolesGuard` reject a
   * legitimately named consultee — say, a contractor — before the service's own check could admit
   * them, and the shipped app would lock out exactly the person being asked.
   */
  @Post(':decisionId/consultations/respond')
  @RolesFor('consultation.respond')
  respondToConsultation(
    @Param('projectId') projectId: string,
    @Param('decisionId') decisionId: string,
    @Body(new ZodPipe(respondToConsultationSchema)) body: RespondToConsultationInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.decisions.respondToConsultation(projectId, decisionId, body, user, idempotencyKey);
  }
}
