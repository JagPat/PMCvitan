import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import {
  correctMeasurementSchema,
  defineCostHeadSchema,
  reattributeSchema,
  setBudgetSchema,
  takeMeasurementSchema,
  type CorrectMeasurementInput,
  type DefineCostHeadInput,
  type ReattributeInput,
  type SetBudgetInput,
  type TakeMeasurementInput,
} from '../contracts';
import { CommercialService } from './commercial.service';
import { CommercialBudgetService } from './commercial-budget.service';
import { CommercialMeasurementService } from './commercial-measurement.service';
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
    private readonly measurement: CommercialMeasurementService,
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

  /** §D — take a measurement against a signed-off activity's labour PO line. */
  @Post('commercial/measurements')
  @RolesFor('commercial.measure')
  takeMeasurement(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(takeMeasurementSchema)) body: TakeMeasurementInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.measurement.take(projectId, body, user, idempotencyKey);
  }

  /** §D — CORRECT one with a signed delta. There is deliberately no edit route: a measurement is
   *  immutable at PostgreSQL, and the correction is what leaves the reasoning behind the change. */
  @Post('commercial/measurements/corrections')
  @RolesFor('commercial.measure')
  correctMeasurement(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(correctMeasurementSchema)) body: CorrectMeasurementInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.measurement.correct(projectId, body, user, idempotencyKey);
  }

  /** §D — the measurement register for one labour PO line, with MEASURED, EFFORT and the order. */
  @Get('commercial/labour-po-lines/:labourPoLineId/measurements')
  @RolesFor('commercial.read')
  readMeasurements(
    @Param('projectId') projectId: string,
    @Param('labourPoLineId') labourPoLineId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.measurement.read(projectId, labourPoLineId, user);
  }

  /** §B/§J — BUDGET, outstanding COMMITTED, received-not-billed and headroom per head, with any
   *  OPEN exception. A read, not a gate: nothing here can refuse a purchase order. */
  @Get('commercial/budget')
  @RolesFor('commercial.read')
  readBudget(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.budget.readBudget(projectId, user);
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
