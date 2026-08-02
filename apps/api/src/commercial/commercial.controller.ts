import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import {
  defineCostHeadSchema,
  reattributeSchema,
  setBudgetSchema,
  type DefineCostHeadInput,
  type ReattributeInput,
  type SetBudgetInput,
} from '../contracts';
import { CommercialService } from './commercial.service';
import { CommercialBudgetService } from './commercial-budget.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';

/**
 * Phase 5 Task 1 — the COMMERCIAL module controller (plan §C/§I).
 *
 * Every route is project-scoped and capability-gated (the service asserts the `commercial`
 * capability, 404 off-pilot — §D). Defining a cost head and re-attributing a commitment are pmc
 * authority; the register reads mirror `procurement.read`. Mutations carry an Idempotency-Key
 * through the command ledger.
 *
 * There is deliberately no "attribute" route: §C requires the INITIAL attribution to be written
 * inside the transaction that makes a PO version live, through `CommercialParticipant`. A
 * standalone create would leave every newly issued order a live unattributed obligation until
 * someone ran it.
 */
@Controller('projects/:projectId')
@UseGuards(JwtGuard, RolesGuard)
export class CommercialController {
  constructor(
    private readonly commercial: CommercialService,
    private readonly budget: CommercialBudgetService,
  ) {}

  /** §B — set or REVISE the live budget for one cost head. One command for both: v1 and a
   *  revision are the same act on a versioned immutable chain. */
  @Post('commercial/budget')
  @RolesFor('commercial.budget.manage')
  setBudget(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(setBudgetSchema)) body: SetBudgetInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.budget.setBudget(projectId, body, user, idempotencyKey);
  }

  @Post('commercial/cost-heads')
  @RolesFor('commercial.manage')
  defineCostHead(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(defineCostHeadSchema)) body: DefineCostHeadInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.commercial.defineCostHead(projectId, body, user, idempotencyKey);
  }

  @Post('commercial/attributions')
  @RolesFor('commercial.attribute')
  reattribute(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(reattributeSchema)) body: ReattributeInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.commercial.reattribute(projectId, body, user, idempotencyKey);
  }

  @Get('commercial/cost-heads')
  @RolesFor('commercial.read')
  listCostHeads(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.commercial.listCostHeads(projectId, user);
  }

  @Get('commercial/attributions')
  @RolesFor('commercial.read')
  listAttributions(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.commercial.listAttributions(projectId, user);
  }
}
