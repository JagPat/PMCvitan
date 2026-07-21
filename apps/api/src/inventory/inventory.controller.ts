import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { RolesFor, RolesGuard } from '../common/roles';
import {
  recordReceiptSchema, acceptStockSchema, rejectStockSchema, vendorReturnSchema, adjustStockSchema, reverseStockSchema,
  reserveStockSchema, releaseReservationSchema, issueStockSchema, consumeStockSchema, siteReturnSchema, wastageSchema, transferStockSchema,
  type RecordReceiptInput, type AcceptStockInput, type RejectStockInput, type VendorReturnInput,
  type AdjustStockInput, type ReverseStockInput,
  type ReserveStockInput, type ReleaseReservationInput, type IssueStockInput, type ConsumeStockInput,
  type SiteReturnInput, type WastageInput, type TransferStockInput,
} from '../contracts';

/**
 * Phase 3 Task 4 — the inventory store surface (plan §§C/H). Every handler is
 * CAPABILITY-GATED in the service (§D — 404 off-pilot). Authority per the §H matrix:
 * receipt recording and the quality decisions (accept/reject/vendor-return) are
 * pmc/engineer store work; the free-form adjustment and the reversal correction are pmc;
 * the store read is pmc/engineer.
 *
 * Task 5 — store-to-site flows (§C): reserve/release/issue/consume/site-return/transfer are
 * pmc/engineer store work (`stock.record`); WASTAGE is a pmc call (`stock.adjust` — a loss
 * write-off with reason + evidence). The `stock/issues` read serves the §E Daily-Log screen.
 */
@Controller('projects/:projectId')
@UseGuards(JwtGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('stock/receipts')
  @RolesFor('stock.record')
  recordReceipt(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(recordReceiptSchema)) body: RecordReceiptInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.recordReceipt(projectId, body, user, idempotencyKey);
  }

  @Post('stock/accept')
  @RolesFor('stock.record')
  accept(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(acceptStockSchema)) body: AcceptStockInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.accept(projectId, body, user, idempotencyKey);
  }

  @Post('stock/reject')
  @RolesFor('stock.record')
  reject(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(rejectStockSchema)) body: RejectStockInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.reject(projectId, body, user, idempotencyKey);
  }

  @Post('stock/vendor-return')
  @RolesFor('stock.record')
  vendorReturn(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(vendorReturnSchema)) body: VendorReturnInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.vendorReturn(projectId, body, user, idempotencyKey);
  }

  @Post('stock/adjust')
  @RolesFor('stock.adjust')
  adjust(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(adjustStockSchema)) body: AdjustStockInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.adjust(projectId, body, user, idempotencyKey);
  }

  @Post('stock/reverse')
  @RolesFor('stock.adjust')
  reverse(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(reverseStockSchema)) body: ReverseStockInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.reverse(projectId, body, user, idempotencyKey);
  }

  @Post('stock/reserve')
  @RolesFor('stock.record')
  reserve(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(reserveStockSchema)) body: ReserveStockInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.reserve(projectId, body, user, idempotencyKey);
  }

  @Post('stock/release')
  @RolesFor('stock.record')
  release(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(releaseReservationSchema)) body: ReleaseReservationInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.release(projectId, body, user, idempotencyKey);
  }

  @Post('stock/issue')
  @RolesFor('stock.record')
  issue(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(issueStockSchema)) body: IssueStockInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.issue(projectId, body, user, idempotencyKey);
  }

  @Post('stock/consume')
  @RolesFor('stock.record')
  consume(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(consumeStockSchema)) body: ConsumeStockInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.consume(projectId, body, user, idempotencyKey);
  }

  @Post('stock/site-return')
  @RolesFor('stock.record')
  siteReturn(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(siteReturnSchema)) body: SiteReturnInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.siteReturn(projectId, body, user, idempotencyKey);
  }

  @Post('stock/wastage')
  @RolesFor('stock.adjust')
  wastage(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(wastageSchema)) body: WastageInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.wastage(projectId, body, user, idempotencyKey);
  }

  @Post('stock/transfer')
  @RolesFor('stock.record')
  transfer(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(transferStockSchema)) body: TransferStockInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.inventory.transfer(projectId, body, user, idempotencyKey);
  }

  @Get('stock')
  @RolesFor('stock.read')
  store(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.inventory.store(projectId, user);
  }

  @Get('stock/issues')
  @RolesFor('stock.read')
  issues(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.inventory.issues(projectId, user);
  }
}
