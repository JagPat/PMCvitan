import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { ProcurementService } from './procurement.service';
import { PurchaseOrdersService } from './purchase-orders.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  createRequisitionSchema, rejectRequisitionSchema, createRfqSchema, recordQuoteSchema, approveComparisonSchema,
  createPoSchema, issuePoSchema, amendPoSchema, cancelPoSchema, closeShortPoSchema, commitDeliverySchema, reviseDeliverySchema,
  type CreateRequisitionInput, type RejectRequisitionInput, type CreateRfqInput, type RecordQuoteInput, type ApproveComparisonInput,
  type CreatePoInput, type IssuePoInput, type AmendPoInput, type CancelPoInput, type CloseShortPoInput,
  type CommitDeliveryInput, type ReviseDeliveryInput,
} from '../contracts';

/**
 * Phase 3 Tasks 2–3 — the §F procurement pipeline through PO issuance + delivery
 * commitments. Every handler is CAPABILITY-GATED in the service (§D — 404 off-pilot).
 * Authority per the §H matrix: drafting/submitting a requisition is pmc/engineer; approval,
 * rejection, line disposition and everything from RFQs through POs and deliveries is pmc.
 * Reads are pmc/engineer.
 */
@Controller('projects/:projectId')
@UseGuards(JwtGuard, RolesGuard)
export class ProcurementController {
  constructor(
    private readonly procurement: ProcurementService,
    private readonly purchaseOrders: PurchaseOrdersService,
  ) {}

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

  // ── Task 3 — purchase orders (§F versioned machine; pmc authority per §H) ────────────────

  @Post('pos')
  @RolesFor('procurement.manage')
  createPo(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createPoSchema)) body: CreatePoInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.purchaseOrders.create(projectId, body, user, idempotencyKey);
  }

  @Get('pos')
  @RolesFor('procurement.read')
  listPos(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.purchaseOrders.listPos(projectId, user);
  }

  @Get('pos/:poId')
  @RolesFor('procurement.read')
  readPo(@Param('projectId') projectId: string, @Param('poId') poId: string, @CurrentUser() user: AuthUser) {
    return this.purchaseOrders.readPo(projectId, poId, user);
  }

  @Post('pos/:poId/issue')
  @RolesFor('procurement.manage')
  issuePo(
    @Param('projectId') projectId: string,
    @Param('poId') poId: string,
    @Body(new ZodPipe(issuePoSchema)) body: IssuePoInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.purchaseOrders.issue(projectId, poId, body, user, idempotencyKey);
  }

  @Post('pos/:poId/amend')
  @RolesFor('procurement.manage')
  amendPo(
    @Param('projectId') projectId: string,
    @Param('poId') poId: string,
    @Body(new ZodPipe(amendPoSchema)) body: AmendPoInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.purchaseOrders.amend(projectId, poId, body, user, idempotencyKey);
  }

  @Post('pos/:poId/cancel')
  @RolesFor('procurement.manage')
  cancelPo(
    @Param('projectId') projectId: string,
    @Param('poId') poId: string,
    @Body(new ZodPipe(cancelPoSchema)) body: CancelPoInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.purchaseOrders.cancel(projectId, poId, body, user, idempotencyKey);
  }

  @Post('pos/:poId/close-short')
  @RolesFor('procurement.manage')
  closeShortPo(
    @Param('projectId') projectId: string,
    @Param('poId') poId: string,
    @Body(new ZodPipe(closeShortPoSchema)) body: CloseShortPoInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.purchaseOrders.closeShort(projectId, poId, body, user, idempotencyKey);
  }

  // ── Task 3 — delivery commitments (append-only promise history) ──────────────────────────

  @Post('deliveries')
  @RolesFor('procurement.manage')
  commitDelivery(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(commitDeliverySchema)) body: CommitDeliveryInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.purchaseOrders.commitDelivery(projectId, body, user, idempotencyKey);
  }

  @Post('deliveries/:commitmentId/revise')
  @RolesFor('procurement.manage')
  reviseDelivery(
    @Param('projectId') projectId: string,
    @Param('commitmentId') commitmentId: string,
    @Body(new ZodPipe(reviseDeliverySchema)) body: ReviseDeliveryInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.purchaseOrders.reviseDelivery(projectId, commitmentId, body, user, idempotencyKey);
  }

  @Post('deliveries/:commitmentId/fulfill')
  @RolesFor('procurement.manage')
  fulfillDelivery(
    @Param('projectId') projectId: string,
    @Param('commitmentId') commitmentId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.purchaseOrders.fulfillDelivery(projectId, commitmentId, user, idempotencyKey);
  }

  @Post('deliveries/:commitmentId/default')
  @RolesFor('procurement.manage')
  defaultDelivery(
    @Param('projectId') projectId: string,
    @Param('commitmentId') commitmentId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.purchaseOrders.defaultDelivery(projectId, commitmentId, user, idempotencyKey);
  }
}
