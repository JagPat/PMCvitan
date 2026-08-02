import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { LabourProcurementService } from './labour-procurement.service';
import { ZodPipe } from '../common/zod.pipe';
import { CurrentUser, JwtGuard, type AuthUser } from '../common/auth';
import { AllowAnyRole, RolesFor, RolesGuard } from '../common/roles';
import {
  setVendorLabourProfileSchema, createLabourRequisitionSchema, rejectLabourRequisitionSchema,
  createLabourRfqSchema, recordLabourQuoteSchema, approveLabourComparisonSchema,
  createLabourPoSchema, issueLabourPoSchema, amendLabourPoSchema, cancelLabourPoSchema, closeShortLabourPoSchema,
  commitCapacitySchema, reviseCapacitySchema,
  type SetVendorLabourProfileInput, type CreateLabourRequisitionInput, type RejectLabourRequisitionInput,
  type CreateLabourRfqInput, type RecordLabourQuoteInput, type ApproveLabourComparisonInput,
  type CreateLabourPoInput, type IssueLabourPoInput, type AmendLabourPoInput, type CancelLabourPoInput, type CloseShortLabourPoInput,
  type CommitCapacityInput, type ReviseCapacityInput,
} from '../contracts';

// The VendorLabourProfile surface is ORG-admin (org membership owner/admin — the service enforces
// it), like vendor CRUD; a project role grants nothing here. The JWT still gates the routes.
const LABOUR_PROFILE_ORG_AUTHZ = 'LabourProcurementService enforces org owner/admin authority for a vendor’s labour profile (§F/F7 — org-level, not a project role)';

/**
 * Phase 4 Task 2 — the LABOUR COMMERCIAL chain controller (plan §F/§H). The ORG vendor-profile
 * surface is org-admin; every project route is capability-gated (`labour`, 404 off-pilot in the
 * service) and role-gated: requisition drafting is pmc/engineer (`labour.requisition.request`),
 * the requisition sign-off + the RFQ/quote/comparison/PO machine is pmc (`labour.requisition.approve`),
 * the CapacityCommitment lifecycle is pmc (`labour.commit.manage`), and the reads mirror `labour.read`.
 * Every mutation carries an Idempotency-Key through the command ledger.
 */
@Controller()
@UseGuards(JwtGuard, RolesGuard)
export class LabourProcurementController {
  constructor(private readonly labour: LabourProcurementService) {}

  // ── VendorLabourProfile (org-admin) ──────────────────────────────────────────────────────────
  @Post('orgs/:orgId/labour/vendor-profiles')
  @AllowAnyRole(LABOUR_PROFILE_ORG_AUTHZ)
  setVendorProfile(
    @Param('orgId') orgId: string,
    @Body(new ZodPipe(setVendorLabourProfileSchema)) body: SetVendorLabourProfileInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.setVendorProfile(orgId, body, user, idempotencyKey);
  }

  @Get('orgs/:orgId/labour/vendor-profiles')
  @AllowAnyRole(LABOUR_PROFILE_ORG_AUTHZ)
  listVendorProfiles(@Param('orgId') orgId: string, @CurrentUser() user: AuthUser) {
    return this.labour.listVendorProfiles(orgId, user);
  }

  // ── Labour requisitions ──────────────────────────────────────────────────────────────────────
  @Post('projects/:projectId/labour/requisitions')
  @RolesFor('labour.requisition.request')
  createRequisition(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createLabourRequisitionSchema)) body: CreateLabourRequisitionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.createRequisition(projectId, body, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/requisitions/:requisitionId/submit')
  @RolesFor('labour.requisition.request')
  submitRequisition(
    @Param('projectId') projectId: string,
    @Param('requisitionId') requisitionId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.submitRequisition(projectId, requisitionId, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/requisitions/:requisitionId/approve')
  @RolesFor('labour.requisition.approve')
  approveRequisition(
    @Param('projectId') projectId: string,
    @Param('requisitionId') requisitionId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.approveRequisition(projectId, requisitionId, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/requisitions/:requisitionId/reject')
  @RolesFor('labour.requisition.approve')
  rejectRequisition(
    @Param('projectId') projectId: string,
    @Param('requisitionId') requisitionId: string,
    @Body(new ZodPipe(rejectLabourRequisitionSchema)) body: RejectLabourRequisitionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.rejectRequisition(projectId, requisitionId, body, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/requisitions/:requisitionId/lines/:lineId/cancel')
  @RolesFor('labour.requisition.request')
  cancelRequisitionLine(
    @Param('projectId') projectId: string,
    @Param('requisitionId') requisitionId: string,
    @Param('lineId') lineId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.cancelRequisitionLine(projectId, requisitionId, lineId, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/requisitions/:requisitionId/close')
  @RolesFor('labour.requisition.approve')
  closeRequisition(
    @Param('projectId') projectId: string,
    @Param('requisitionId') requisitionId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.closeRequisition(projectId, requisitionId, user, idempotencyKey);
  }

  // ── Labour RFQ + quote + comparison ──────────────────────────────────────────────────────────
  @Post('projects/:projectId/labour/rfqs')
  @RolesFor('labour.requisition.approve')
  createRfq(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createLabourRfqSchema)) body: CreateLabourRfqInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.createRfq(projectId, body, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/rfqs/:rfqId/close')
  @RolesFor('labour.requisition.approve')
  closeRfq(
    @Param('projectId') projectId: string,
    @Param('rfqId') rfqId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.closeRfq(projectId, rfqId, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/rfqs/:rfqId/quotes')
  @RolesFor('labour.requisition.approve')
  recordQuote(
    @Param('projectId') projectId: string,
    @Param('rfqId') rfqId: string,
    @Body(new ZodPipe(recordLabourQuoteSchema)) body: RecordLabourQuoteInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.recordQuote(projectId, rfqId, body, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/rfqs/:rfqId/comparison')
  @RolesFor('labour.requisition.approve')
  createComparison(
    @Param('projectId') projectId: string,
    @Param('rfqId') rfqId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.createComparison(projectId, rfqId, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/rfqs/:rfqId/comparison/approve')
  @RolesFor('labour.requisition.approve')
  approveComparison(
    @Param('projectId') projectId: string,
    @Param('rfqId') rfqId: string,
    @Body(new ZodPipe(approveLabourComparisonSchema)) body: ApproveLabourComparisonInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.approveComparison(projectId, rfqId, body, user, idempotencyKey);
  }

  // ── Labour purchase orders ───────────────────────────────────────────────────────────────────
  @Post('projects/:projectId/labour/pos')
  @RolesFor('labour.requisition.approve')
  createPo(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(createLabourPoSchema)) body: CreateLabourPoInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.createPo(projectId, body, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/pos/:poId/issue')
  @RolesFor('labour.requisition.approve')
  issuePo(
    @Param('projectId') projectId: string,
    @Param('poId') poId: string,
    @Body(new ZodPipe(issueLabourPoSchema)) body: IssueLabourPoInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.issuePo(projectId, poId, body, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/pos/:poId/amend')
  @RolesFor('labour.requisition.approve')
  amendPo(
    @Param('projectId') projectId: string,
    @Param('poId') poId: string,
    @Body(new ZodPipe(amendLabourPoSchema)) body: AmendLabourPoInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.amendPo(projectId, poId, body, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/pos/:poId/cancel')
  @RolesFor('labour.requisition.approve')
  cancelPo(
    @Param('projectId') projectId: string,
    @Param('poId') poId: string,
    @Body(new ZodPipe(cancelLabourPoSchema)) body: CancelLabourPoInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.cancelPo(projectId, poId, body, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/pos/:poId/close-short')
  @RolesFor('labour.requisition.approve')
  closeShortPo(
    @Param('projectId') projectId: string,
    @Param('poId') poId: string,
    @Body(new ZodPipe(closeShortLabourPoSchema)) body: CloseShortLabourPoInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.closeShortPo(projectId, poId, body, user, idempotencyKey);
  }

  // ── Capacity commitments ─────────────────────────────────────────────────────────────────────
  @Post('projects/:projectId/labour/commitments')
  @RolesFor('labour.commit.manage')
  commitCapacity(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(commitCapacitySchema)) body: CommitCapacityInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.commitCapacity(projectId, body, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/commitments/:commitmentId/revise')
  @RolesFor('labour.commit.manage')
  reviseCapacity(
    @Param('projectId') projectId: string,
    @Param('commitmentId') commitmentId: string,
    @Body(new ZodPipe(reviseCapacitySchema)) body: ReviseCapacityInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.reviseCapacity(projectId, commitmentId, body, user, idempotencyKey);
  }

  @Post('projects/:projectId/labour/commitments/:commitmentId/default')
  @RolesFor('labour.commit.manage')
  defaultCapacity(
    @Param('projectId') projectId: string,
    @Param('commitmentId') commitmentId: string,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.labour.defaultCapacity(projectId, commitmentId, user, idempotencyKey);
  }

  // ── Reads (labour.read) ──────────────────────────────────────────────────────────────────────
  @Get('projects/:projectId/labour/requisitions')
  @RolesFor('labour.read')
  listRequisitions(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.labour.listRequisitions(projectId, user);
  }

  @Get('projects/:projectId/labour/rfqs/:rfqId')
  @RolesFor('labour.read')
  readRfq(@Param('projectId') projectId: string, @Param('rfqId') rfqId: string, @CurrentUser() user: AuthUser) {
    return this.labour.readRfq(projectId, rfqId, user);
  }

  @Get('projects/:projectId/labour/rfqs')
  @RolesFor('labour.read')
  listRfqs(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.labour.listRfqs(projectId, user);
  }

  @Get('projects/:projectId/labour/pos/:poId')
  @RolesFor('labour.read')
  readPo(@Param('projectId') projectId: string, @Param('poId') poId: string, @CurrentUser() user: AuthUser) {
    return this.labour.readPo(projectId, poId, user);
  }

  @Get('projects/:projectId/labour/pos')
  @RolesFor('labour.read')
  listPos(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.labour.listPos(projectId, user);
  }

  @Get('projects/:projectId/labour/commitments')
  @RolesFor('labour.read')
  listCommitments(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.labour.listCommitments(projectId, user);
  }
}
