import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ProcurementService } from './procurement.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  createRequisitionSchema, rejectRequisitionSchema, createRfqSchema, recordQuoteSchema, approveComparisonSchema,
  type CreateRequisitionInput, type RejectRequisitionInput, type CreateRfqInput, type RecordQuoteInput, type ApproveComparisonInput,
} from '../contracts';

/**
 * Phase 3 Task 2 — the §F procurement pipeline through comparison approval. Every handler is
 * CAPABILITY-GATED in the service (§D — 404 off-pilot). Authority per the §H matrix:
 * drafting/submitting a requisition is pmc/engineer; approval, rejection, line disposition
 * and everything from RFQs to the comparison is pmc. Reads are pmc/engineer.
 */
@Controller('projects/:projectId')
@UseGuards(JwtGuard, RolesGuard)
export class ProcurementController {
  constructor(private readonly procurement: ProcurementService) {}

  @Post('requisitions')
  @RolesFor('requisition.submit')
  createRequisition(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createRequisitionSchema)) body: CreateRequisitionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.createRequisition(projectId, body, user, idempotencyKey);
  }

  @Get('requisitions')
  @RolesFor('procurement.read')
  listRequisitions(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.procurement.listRequisitions(projectId, user);
  }

  @Post('requisitions/:requisitionId/submit')
  @RolesFor('requisition.submit')
  submit(
    @Param('projectId') projectId: string,
    @Param('requisitionId') requisitionId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.submit(projectId, requisitionId, user, idempotencyKey);
  }

  @Post('requisitions/:requisitionId/approve')
  @RolesFor('requisition.approve')
  approve(
    @Param('projectId') projectId: string,
    @Param('requisitionId') requisitionId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.approve(projectId, requisitionId, user, idempotencyKey);
  }

  @Post('requisitions/:requisitionId/reject')
  @RolesFor('requisition.approve')
  reject(
    @Param('projectId') projectId: string,
    @Param('requisitionId') requisitionId: string,
    @Body(new ZodPipe(rejectRequisitionSchema)) body: RejectRequisitionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.reject(projectId, requisitionId, body, user, idempotencyKey);
  }

  @Post('requisitions/:requisitionId/close')
  @RolesFor('requisition.approve')
  close(
    @Param('projectId') projectId: string,
    @Param('requisitionId') requisitionId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.close(projectId, requisitionId, user, idempotencyKey);
  }

  @Post('requisitions/:requisitionId/lines/:lineId/cancel')
  @RolesFor('requisition.approve')
  cancelLine(
    @Param('projectId') projectId: string,
    @Param('requisitionId') requisitionId: string,
    @Param('lineId') lineId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.cancelLine(projectId, requisitionId, lineId, user, idempotencyKey);
  }

  @Post('rfqs')
  @RolesFor('procurement.manage')
  createRfq(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createRfqSchema)) body: CreateRfqInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.createRfq(projectId, body, user, idempotencyKey);
  }

  @Get('rfqs/:rfqId')
  @RolesFor('procurement.read')
  readRfq(@Param('projectId') projectId: string, @Param('rfqId') rfqId: string, @CurrentUser() user: AuthUser) {
    return this.procurement.readRfq(projectId, rfqId, user);
  }

  @Post('rfqs/:rfqId/close')
  @RolesFor('procurement.manage')
  closeRfq(
    @Param('projectId') projectId: string,
    @Param('rfqId') rfqId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.closeRfq(projectId, rfqId, user, idempotencyKey);
  }

  @Post('rfqs/:rfqId/quotes')
  @RolesFor('procurement.manage')
  recordQuote(
    @Param('projectId') projectId: string,
    @Param('rfqId') rfqId: string,
    @Body(new ZodPipe(recordQuoteSchema)) body: RecordQuoteInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.recordQuote(projectId, rfqId, body, user, idempotencyKey);
  }

  @Post('rfqs/:rfqId/comparison')
  @RolesFor('procurement.manage')
  createComparison(
    @Param('projectId') projectId: string,
    @Param('rfqId') rfqId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.createComparison(projectId, rfqId, user, idempotencyKey);
  }

  @Post('rfqs/:rfqId/comparison/approve')
  @RolesFor('procurement.manage')
  approveComparison(
    @Param('projectId') projectId: string,
    @Param('rfqId') rfqId: string,
    @Body(new ZodPipe(approveComparisonSchema)) body: ApproveComparisonInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.procurement.approveComparison(projectId, rfqId, body, user, idempotencyKey);
  }
}
