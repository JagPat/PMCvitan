import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import {
  amendVendorBillSchema,
  certifyBillSchema,
  recordDeductionSchema,
  releaseDeductionSchema,
  approvePaymentSchema,
  recordPaymentSchema,
  reversePaymentSchema,
  payAdvanceSchema,
  grantSodExceptionSchema,
  correctMeasurementSchema,
  defineCostHeadSchema,
  reattributeSchema,
  recordVendorBillSchema,
  rejectVendorBillSchema,
  setBudgetSchema,
  supersedeCertificateSchema,
  takeMeasurementSchema,
  vendorBillStepSchema,
  type AmendVendorBillInput,
  type CertifyBillInput,
  type RecordDeductionInput,
  type ReleaseDeductionInput,
  type ApprovePaymentInput,
  type RecordPaymentInput,
  type ReversePaymentInput,
  type PayAdvanceInput,
  type GrantSodExceptionInput,
  type CorrectMeasurementInput,
  type DefineCostHeadInput,
  type ReattributeInput,
  type RecordVendorBillInput,
  type RejectVendorBillInput,
  type SetBudgetInput,
  type SupersedeCertificateInput,
  type TakeMeasurementInput,
  type VendorBillStepInput,
} from '../contracts';
import { CommercialService } from './commercial.service';
import { CommercialDeductionService } from './commercial-deduction.service';
import { CommercialPaymentService } from './commercial-payment.service';
import { CommercialBudgetService } from './commercial-budget.service';
import { CommercialMeasurementService } from './commercial-measurement.service';
import { CommercialBillService } from './commercial-bill.service';
import { CommercialVerificationService } from './commercial-verification.service';
import { CommercialCertificationService } from './commercial-certification.service';
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
    private readonly bills: CommercialBillService,
    private readonly verification: CommercialVerificationService,
    private readonly certification: CommercialCertificationService,
    private readonly deductions: CommercialDeductionService,
    private readonly payments: CommercialPaymentService,
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

  // ── Phase 5 Task 4 (§F/§G) — the vendor claim ────────────────────────────────────────────────
  //
  // Five commands, because §F's arrows carry different authority questions. Recording, amending
  // and rejecting a claim are the `commercial.bill` data-entry surface; opening verification is
  // `commercial.verify`. There is deliberately NO `dispute` route: a dispute is never a decision
  // somebody makes ABOUT a claim, it is what happens when the EVIDENCE under one moves, so it is
  // written from the withdrawal guards inside the transaction that withdrew it.

  /** §F — record what the vendor claims. It lands at `draft`; nothing is bounded until submit. */
  @Post('commercial/bills')
  @RolesFor('commercial.bill')
  recordBill(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(recordVendorBillSchema)) body: RecordVendorBillInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.bills.record(projectId, body, user, idempotencyKey);
  }

  /** §G — submit it. This is where bounds 1–2 are evaluated under the ordered line's own lock. */
  @Post('commercial/bills/submit')
  @RolesFor('commercial.bill')
  submitBill(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(vendorBillStepSchema)) body: VendorBillStepInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.bills.submit(projectId, body, user, idempotencyKey);
  }

  /** §F — open the §E three-way check. The VERDICT is Task 5's; this is only the transition in. */
  @Post('commercial/bills/begin-verification')
  @RolesFor('commercial.verify')
  beginVerification(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(vendorBillStepSchema)) body: VendorBillStepInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.bills.beginVerification(projectId, body, user, idempotencyKey);
  }

  /**
   * §E (Task 5A) — the three-way VERDICT. A matched claim moves `under-verification -> verified`;
   * an exception moves it to `disputed`, naming the exception. It never auto-rejects: §E is
   * explicit that an exception "requires a responsible review with an attributable reason to
   * proceed" (spec §16), and the claim's own record is the evidence that review is about.
   */
  @Post('commercial/bills/verify')
  @RolesFor('commercial.verify')
  verifyBill(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(vendorBillStepSchema)) body: VendorBillStepInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.verification.verify(projectId, body, user, idempotencyKey);
  }

  /** §E — the triple as a READ, so a reviewer can see the verdict without moving the claim. */
  @Get('commercial/bills/:billId/verification')
  @RolesFor('commercial.read')
  readVerification(
    @Param('projectId') projectId: string,
    @Param('billId') billId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.verification.readVerification(projectId, billId, user);
  }

  /**
   * §E/§F/§I (Task 5B) — CERTIFY a verified claim. `verified -> certified`, with the certificate
   * as the fact and the status as its projection.
   *
   * `commercial.certify` rather than `commercial.verify`: certification creates money someone may
   * approve, and collapsing the two would mean a later widening of the verification surface
   * silently widened the payment authority too.
   */
  @Post('commercial/bills/certify')
  @RolesFor('commercial.certify')
  certifyBill(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(certifyBillSchema)) body: CertifyBillInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.certification.certify(projectId, body, user, idempotencyKey);
  }

  /**
   * §I — the APPROVER authorises one otherwise-forbidden certification. Its own route and its own
   * permission because it is a different person doing a different thing; the authenticated actor
   * IS the authority, so there is no `approverId` field to fill in with somebody else's name.
   */
  @Post('commercial/bills/sod-grant')
  @RolesFor('commercial.sod.grant')
  grantSodException(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(grantSodExceptionSchema)) body: GrantSodExceptionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.certification.grantSodException(projectId, body, user, idempotencyKey);
  }

  /** §F — past certification the correction path is a SUPERSEDING certificate, never an edit. */
  @Post('commercial/certificates/supersede')
  @RolesFor('commercial.certify')
  supersedeCertificate(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(supersedeCertificateSchema)) body: SupersedeCertificateInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.certification.supersede(projectId, body, user, idempotencyKey);
  }

  /**
   * §H (Task 5C) — WITHHOLD money from a certified payable: retention, a penalty, or `other`.
   *
   * Its own permission rather than `commercial.certify`: certifying decides what is OWED and
   * withholding decides what is PAID OF IT, and a practice may well want different people doing
   * the two.
   */
  @Post('commercial/deductions/record')
  @RolesFor('commercial.deduct')
  recordDeduction(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(recordDeductionSchema)) body: RecordDeductionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.deductions.record(projectId, body, user, idempotencyKey);
  }

  /** §H — give back part of a withholding, as its own attributable row. Never an edit. */
  @Post('commercial/deductions/release')
  @RolesFor('commercial.deduct.release')
  releaseDeduction(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(releaseDeductionSchema)) body: ReleaseDeductionInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.deductions.release(projectId, body, user, idempotencyKey);
  }

  /** §H — one claim's withholding ledger and the `NET_PAYABLE` it produces. Every figure a fold. */
  @Get('commercial/bills/:billId/deductions')
  @RolesFor('commercial.read')
  readDeductions(
    @Param('projectId') projectId: string,
    @Param('billId') billId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.deductions.readLedger(projectId, billId, user);
  }

  /**
   * §F/§G/§I — AUTHORISE a certified payable for payment.
   *
   * A separate authority from certification, and a separate route, because §I's rule needs two
   * actors to compare: the person who certified may not approve. The certificate is resolved
   * server-side from what is LIVE — a caller-supplied id could name a superseded certificate that
   * §G bounds 3–5 deliberately exclude.
   */
  @Post('commercial/payments/approve')
  @RolesFor('commercial.approve-payment')
  approvePayment(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(approvePaymentSchema)) body: ApprovePaymentInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.payments.approve(projectId, body, user, idempotencyKey);
  }

  /** §G — record money LEAVING against an approval that covers it (bound 5). */
  @Post('commercial/payments/record')
  @RolesFor('commercial.record-payment')
  recordPayment(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(recordPaymentSchema)) body: RecordPaymentInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.payments.record(projectId, body, user, idempotencyKey);
  }

  /**
   * §0/§H — RECOVER money already paid, against the payment that moved it.
   *
   * Its own route and its own permission, not a signed `record`: §H makes every append-only money
   * row strictly positive with the row TYPE carrying direction, and a practice may legitimately
   * want the person who can send money to be unable to claw it back.
   */
  @Post('commercial/payments/reverse')
  @RolesFor('commercial.reverse-payment')
  reversePayment(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(reversePaymentSchema)) body: ReversePaymentInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.payments.reverse(projectId, body, user, idempotencyKey);
  }

  /**
   * §H — PAY a counterparty ahead of any certified claim.
   *
   * On the deduction service rather than the payment one, because the fact it creates is a ceiling
   * for a DEDUCTION: an advance is recovered by an `advance-recovery` withholding, never by a
   * payment. Its own permission — an advance commits cash with no certificate behind it, which is a
   * different risk from paying a claim that was certified, approved and bounded.
   */
  @Post('commercial/advances')
  @RolesFor('commercial.pay-advance')
  payAdvance(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(payAdvanceSchema)) body: PayAdvanceInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.deductions.payAdvance(projectId, body, user, idempotencyKey);
  }

  /** §G — one claim's approvals and payments, with the folds bounds 4–5 are measured against. */
  @Get('commercial/bills/:billId/payments')
  @RolesFor('commercial.read')
  readPayments(
    @Param('projectId') projectId: string,
    @Param('billId') billId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payments.ledger(projectId, billId, user);
  }

  /** §E — the LIVE certificate on a claim, with the evidence it froze. 404 when none stands. */
  @Get('commercial/bills/:billId/certificate')
  @RolesFor('commercial.read')
  readCertificate(
    @Param('projectId') projectId: string,
    @Param('billId') billId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.certification.readCertificate(projectId, billId, user);
  }

  /** §F — amend into a NEW version retaining the prior verbatim; also RESOLVES a dispute. */
  @Post('commercial/bills/amend')
  @RolesFor('commercial.bill')
  amendBill(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(amendVendorBillSchema)) body: AmendVendorBillInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.bills.amend(projectId, body, user, idempotencyKey);
  }

  /** §F — a JUDGEMENT that the claim is not owed, with an attributable reason. */
  @Post('commercial/bills/reject')
  @RolesFor('commercial.bill')
  rejectBill(
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(rejectVendorBillSchema)) body: RejectVendorBillInput,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.bills.reject(projectId, body, user, idempotencyKey);
  }

  @Get('commercial/bills')
  @RolesFor('commercial.read')
  listBills(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    return this.bills.list(projectId, user);
  }

  @Get('commercial/bills/:billId')
  @RolesFor('commercial.read')
  readBill(
    @Param('projectId') projectId: string,
    @Param('billId') billId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.bills.readOne(projectId, billId, user);
  }
}
