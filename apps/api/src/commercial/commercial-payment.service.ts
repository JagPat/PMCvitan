import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ROLE_POLICY,
  type BillPaymentLedgerDto,
  type PaymentApprovalDto,
  type PaymentDto,
  type VendorBillStatus,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import { recordAudit } from '../platform/audit';
import { lockProjectReadiness } from '../common/readiness-lock';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { CommercialDeductionQuery } from './commercial-deduction.query';
import { OrgsParticipant } from '../orgs/orgs.participant';
import type { ApprovePaymentInput, RecordPaymentInput } from '../contracts';

const ZERO = new Prisma.Decimal(0);

/**
 * Phase 5 Task 6A (§F/§G/§I) — PAYMENT AUTHORITY.
 *
 * Certification says what a vendor is OWED. An approval is the separate authority saying it may be
 * PAID, and a payment says it was. The three are kept apart deliberately, because §I's rule needs
 * them apart to be stateable at all: **the actor who certified may not approve.** One combined act
 * would make that rule unenforceable — there would be no second actor to compare against.
 *
 * Two bounds, both re-derived HERE under the bill lock and both sealed at PostgreSQL for whatever
 * bypasses this service:
 *
 * 1. **§G bound 4 — `APPROVED(bill)` ≤ `NET_PAYABLE(bill)`, and NET is not gross.** Capping
 *    approval at the gross certificate would let a ₹100 certification carrying a ₹10 retention
 *    approve and pay the full ₹100, which makes the §H ledger decorative: it would record a
 *    withholding that never withheld anything.
 * 2. **§G bound 5 — `PAID(bill)` ≤ `APPROVED(bill)`.** Money may only leave against an authority
 *    that covers it.
 *
 * **Approval limits are CUMULATIVE, not per row.** §I is explicit and the reason is a defeat: a
 * per-row check lets a ₹50-limit approver authorise a ₹100 payable as two ₹50 rows — each within
 * limit, bound 4 satisfied, the ceiling defeated. The guard folds what is already approved and
 * compares the actor's limit to the resulting TOTAL.
 *
 * **What this service deliberately does NOT do: derive the §F payment status.** Task 5C deferred
 * that because §F reads three folds and two of them did not exist. This task creates those two;
 * the derivation lands in 6B beside the reversal rows that make it correct. Until then the stored
 * status stays `certified`, which is strictly stricter than the finished rule — there is no
 * transition to be wrong about, and no bill can be stranded in a state no legal row can leave.
 */
@Injectable()
export class CommercialPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    // §H's fold decides what is payable at all. Own module, one owner: bound 4 asks the same
    // question the deduction ledger answers, rather than growing a second copy of it here.
    private readonly deductions: CommercialDeductionQuery,
    // §I's ceiling is authority/standing data and `Membership` is ORGS-owned. Reading it here
    // directly would bypass the owner boundary: an orgs-side change to how active membership or a
    // downgrade is interpreted would leave payment approval and project access disagreeing about
    // the same actor. `commercial.workflowParticipants` already declares this edge.
    private readonly orgs: OrgsParticipant,
  ) {}

  private assertApprove(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.approve-payment'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Approving a payment is a pmc surface — it authorises money to leave');
    }
  }

  private assertRecord(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.record-payment'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Recording a payment is a pmc surface');
    }
  }

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The commercial register is a pmc/engineer surface');
    }
  }

  // ── §F/§G/§I — approve ───────────────────────────────────────────────────────────────────────

  /**
   * Authorise part or all of a certified payable for payment.
   *
   * The certificate is resolved SERVER-SIDE from what is live, never taken from the caller: a
   * supplied id could name a superseded certificate, which §G bounds 3–5 exclude as retained
   * history, and the bound would then measure against a certification that no longer stands.
   */
  async approve(
    projectId: string, input: ApprovePaymentInput, user: AuthUser, idempotencyKey?: string,
  ): Promise<PaymentApprovalDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertApprove(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const amount = this.parseAmount(input.amount);

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'commercial.payment.approve', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        await this.lockBill(tx, projectId, input.billId);

        // §H's own fold, under the lock. It answers both "is anything payable" and "how much".
        const position = await this.deductions.positionFor(tx, projectId, input.billId);
        if (!position) {
          throw new ConflictException('This claim has no live certification — an approval authorises payment of a payable, and an uncertified claim is not one yet');
        }

        // §I — the actor who CERTIFIED may not approve. The rule is evaluated server-side against
        // the certificate this approval draws on, and it is the payment half of the same rule that
        // already keeps the measurer or acceptor away from certification.
        const certificate = await tx.billCertificate.findFirstOrThrow({
          where: { projectId, id: position.certificateId },
          select: { certifiedById: true },
        });
        if (certificate.certifiedById === actor.actorId) {
          throw new ForbiddenException(
            'The person who certified this claim may not also approve its payment — certification says what is owed and approval releases it, and one person doing both is the separation §I exists to keep. A different approver, or an attributable exception from an org admin, is required',
          );
        }

        // §G BOUND 4, re-derived under the lock and stated as the REMAINING headroom, because a
        // refusal that only says "too much" leaves the practice guessing at the number.
        const approvedSoFar = await this.approvedTotal(tx, projectId, input.billId);
        const netPayable = new Prisma.Decimal(position.netPayable);
        const remaining = netPayable.sub(approvedSoFar);
        if (amount.greaterThan(remaining)) {
          throw new ConflictException(
            `Approving ${amount.toFixed(2)} would take the approved total past the ${netPayable.toFixed(2)} payable on this claim — ${approvedSoFar.toFixed(2)} is already approved, so ${remaining.toFixed(2)} remains. A certification carrying unreleased withholdings cannot authorise more than it leaves payable`,
          );
        }

        // §I — APPROVAL LIMITS, applied to the CUMULATIVE total rather than to this row. A per-row
        // check lets a ₹50-limit approver authorise ₹100 as two ₹50 rows: each within limit, bound
        // 4 satisfied, the ceiling defeated. Crossing it escalates and never silently succeeds.
        await this.assertWithinLimit(tx, projectId, actor.actorId, approvedSoFar.add(amount));

        const approval = await tx.paymentApproval.create({
          data: {
            projectId, billId: input.billId, certificateId: position.certificateId,
            amount, approvedById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });

        await recordAudit(tx, {
          projectId, actor, action: 'commercial.payment.approve',
          entity: 'PaymentApproval', entityId: approval.id,
        });

        return { resultRef: approval.id, events: [] };
      },
    });

    return this.approvalById(projectId, outcome.resultRef!);
  }

  // ── §G — record a payment ────────────────────────────────────────────────────────────────────

  /** Record money leaving against an approval that covers it. */
  async record(
    projectId: string, input: RecordPaymentInput, user: AuthUser, idempotencyKey?: string,
  ): Promise<PaymentDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRecord(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const amount = this.parseAmount(input.amount);

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'commercial.payment.record', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);

        const approval = await tx.paymentApproval.findFirst({
          where: { projectId, id: input.approvalId },
          select: { id: true, billId: true, amount: true, certificateId: true },
        });
        if (!approval) throw new NotFoundException('Payment approval not found in this project');

        // The approval must still be LIVE authority. `APPROVED(bill)` counts only approvals on the
        // live certificate, so paying against one whose certificate has been superseded attaches
        // append-only cash evidence to an authority that no longer participates in the bound at
        // all: approve 40 on C1, supersede C1, certify C2 and approve 40 there, and the bill-level
        // headroom check alone would let the C1 approval pay. Money leaves against the authority
        // that covered it, or it does not leave.
        const cert = await tx.billCertificate.findFirstOrThrow({
          where: { projectId, id: approval.certificateId },
          select: { supersededAt: true },
        });
        if (cert.supersededAt !== null) {
          throw new ConflictException(
            'That approval rests on a certification that has since been superseded, so it is no longer the authority this claim is paid against — approve against the certificate that stands, and pay against that approval',
          );
        }

        await this.lockBill(tx, projectId, approval.billId);

        // §G BOUND 5, re-derived under the lock. The bound is bill-scoped — `PAID(bill)` ≤
        // `APPROVED(bill)` — so a second approval genuinely raises the ceiling, but the headroom is
        // reported against the whole bill rather than this one approval, which is the number the
        // practice can act on.
        const approvedTotal = await this.approvedTotal(tx, projectId, approval.billId);
        const paidTotal = await this.paidTotal(tx, projectId, approval.billId);
        const remaining = approvedTotal.sub(paidTotal);
        if (amount.greaterThan(remaining)) {
          throw new ConflictException(
            `Paying ${amount.toFixed(2)} would take the paid total past the ${approvedTotal.toFixed(2)} approved on this claim — ${paidTotal.toFixed(2)} is already paid, so ${remaining.toFixed(2)} remains. Money may only leave against an authority that covers it`,
          );
        }

        const payment = await tx.payment.create({
          data: {
            projectId, approvalId: approval.id, billId: approval.billId,
            amount, method: input.method, reference: input.reference ?? null,
            paidById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });

        await recordAudit(tx, {
          projectId, actor, action: 'commercial.payment.record',
          entity: 'Payment', entityId: payment.id,
        });

        return { resultRef: payment.id, events: [] };
      },
    });

    return this.paymentById(projectId, outcome.resultRef!);
  }

  // ── the read ─────────────────────────────────────────────────────────────────────────────────

  /** One claim's approvals and payments, with the folds §G bounds 4–5 are measured against. */
  async ledger(projectId: string, billId: string, user: AuthUser): Promise<BillPaymentLedgerDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);

    const bill = await this.prisma.vendorBill.findFirst({
      where: { projectId, id: billId },
      select: { id: true, status: true },
    });
    if (!bill) throw new NotFoundException('Vendor bill not found in this project');

    const position = await this.deductions.positionFor(this.prisma, projectId, billId);
    const approvals = await this.prisma.paymentApproval.findMany({
      where: { projectId, billId },
      orderBy: { approvedAt: 'asc' },
      include: { payments: { orderBy: { paidAt: 'asc' } } },
    });

    const rows: PaymentApprovalDto[] = approvals.map((a) => ({
      id: a.id,
      billId: a.billId,
      certificateId: a.certificateId,
      amount: a.amount.toFixed(2),
      approvedAt: a.approvedAt.toISOString(),
      approvedById: a.approvedById,
      paid: a.payments.reduce((t, p) => t.add(p.amount), ZERO).toFixed(2),
      payments: a.payments.map((p) => this.toPaymentDto(p)),
    }));

    // The approved fold counts approvals against the LIVE certificate only — a superseded one is
    // retained history, and summing it would compare an overstated total against the bound.
    const approved = approvals
      .filter((a) => position && a.certificateId === position.certificateId)
      .reduce((t, a) => t.add(a.amount), ZERO);
    const paid = approvals.reduce((t, a) => t.add(a.payments.reduce((s, p) => s.add(p.amount), ZERO)), ZERO);

    return {
      billId,
      certificateId: position?.certificateId ?? null,
      approvals: rows,
      approved: approved.toFixed(2),
      paid: paid.toFixed(2),
      approvable: position ? new Prisma.Decimal(position.netPayable).sub(approved).toFixed(2) : null,
      billStatus: bill.status as VendorBillStatus,
    };
  }

  // ── folds and helpers ────────────────────────────────────────────────────────────────────────

  /**
   * §G bound 4's left side. Approvals against the LIVE certificate only: a superseded certificate's
   * approvals must not count, or the bound compares an overstated total against a payable that no
   * longer exists.
   */
  private async approvedTotal(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
      SELECT COALESCE(SUM(a."amount"), 0) AS total
        FROM "PaymentApproval" a
        JOIN "BillCertificate" c ON c."projectId" = a."projectId" AND c."id" = a."certificateId"
       WHERE a."projectId" = ${projectId} AND a."billId" = ${billId}
         AND c."supersededAt" IS NULL`;
    return new Prisma.Decimal(rows[0]?.total ?? 0);
  }

  /** §G bound 5's left side. */
  private async paidTotal(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
      SELECT COALESCE(SUM(p."amount"), 0) AS total
        FROM "Payment" p
       WHERE p."projectId" = ${projectId} AND p."billId" = ${billId}`;
    return new Prisma.Decimal(rows[0]?.total ?? 0);
  }

  /**
   * §I — approval limits, against the CUMULATIVE total. A membership with no ceiling recorded is
   * unlimited, which is the existing behaviour for every project that has never set one; a ceiling
   * of zero is a real ceiling and refuses everything, because "cannot approve" is a thing a
   * practice may legitimately want to say about a role.
   */
  private async assertWithinLimit(
    tx: Prisma.TransactionClient, projectId: string, actorId: string, cumulative: Prisma.Decimal,
  ): Promise<void> {
    const limit = await this.orgs.approvalCeilingFor(tx, projectId, actorId);
    if (limit === null) return;
    if (cumulative.greaterThan(limit)) {
      throw new ForbiddenException(
        `This would take the approved total on this claim to ${cumulative.toFixed(2)}, above your approval ceiling of ${new Prisma.Decimal(limit).toFixed(2)} — the limit applies to the claim's cumulative approved total, not to one authorisation, so splitting it into smaller approvals does not clear it. It needs a higher-limit approver`,
      );
    }
  }

  private async lockBill(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<{ id: string; status: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
      SELECT "id", "status" FROM "VendorBill"
       WHERE "projectId" = ${projectId} AND "id" = ${billId} FOR UPDATE`;
    const bill = rows[0];
    if (!bill) throw new NotFoundException('Vendor bill not found in this project');
    return bill;
  }

  private toPaymentDto(p: {
    id: string; approvalId: string; billId: string; amount: Prisma.Decimal;
    method: string; reference: string | null; paidAt: Date; paidById: string;
  }): PaymentDto {
    return {
      id: p.id,
      approvalId: p.approvalId,
      billId: p.billId,
      amount: p.amount.toFixed(2),
      method: p.method,
      reference: p.reference,
      paidAt: p.paidAt.toISOString(),
      paidById: p.paidById,
    };
  }

  private async approvalById(projectId: string, id: string): Promise<PaymentApprovalDto> {
    const a = await this.prisma.paymentApproval.findFirstOrThrow({
      where: { projectId, id },
      include: { payments: { orderBy: { paidAt: 'asc' } } },
    });
    return {
      id: a.id,
      billId: a.billId,
      certificateId: a.certificateId,
      amount: a.amount.toFixed(2),
      approvedAt: a.approvedAt.toISOString(),
      approvedById: a.approvedById,
      paid: a.payments.reduce((t, p) => t.add(p.amount), ZERO).toFixed(2),
      payments: a.payments.map((p) => this.toPaymentDto(p)),
    };
  }

  private async paymentById(projectId: string, id: string): Promise<PaymentDto> {
    const p = await this.prisma.payment.findFirstOrThrow({ where: { projectId, id } });
    return this.toPaymentDto(p);
  }

  /**
   * §A — money arrives as a decimal STRING and is parsed EXACTLY, by the same rules the deduction
   * ledger uses. Sub-paisa is refused HERE rather than left to the column: `0.005` passes every
   * comparison in this service and is then coerced by `DECIMAL(18,2)` to `0.01`, so an append-only
   * row would record an amount the command never asked for and no correction is possible.
   */
  private parseAmount(raw: string): Prisma.Decimal {
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(raw);
    } catch {
      throw new BadRequestException(`"${raw}" is not an amount`);
    }
    if (!amount.isFinite()) throw new BadRequestException(`"${raw}" is not an amount`);
    if (amount.lessThanOrEqualTo(ZERO)) {
      throw new BadRequestException('An amount is strictly positive — the row KIND carries direction, and a negative would encode it twice');
    }
    if (amount.decimalPlaces() > 2) {
      throw new BadRequestException(`${raw} is finer than the paisa this ledger records`);
    }
    return amount;
  }


  /**
   * §J — the APPROVED term, per PO line, so `certified-payable` can be what the shared contract
   * says it is: `NET_PAYABLE − APPROVED`.
   *
   * Codex round 1 (P2): without this a fully approved ₹100 bill still reported ₹100 awaiting
   * approval, because the budget fold subtracted only withholdings. Money that has been authorised
   * has left the "awaiting approval" bucket whether or not it has been paid, and a forecast that
   * says otherwise shows a practice money it has already committed.
   *
   * Attributed by the SAME rule as the withheld term and through the SAME function — an approval is
   * bill-scoped while the buckets are per cost head, and two copies of that attribution would
   * disagree the first time either changed. Live certificates only, for the same reason: a
   * superseded certificate's approvals are not in `APPROVED(bill)` either.
   */
  async approvedAmountFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: 'material' | 'labour',
    poLineIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    return this.deductions.attributeCertificateScopedTotal(
      tx, projectId, kind, poLineIds,
      async (certificateIds) => {
        const rows = await tx.paymentApproval.groupBy({
          by: ['certificateId'],
          where: { projectId, certificateId: { in: certificateIds } },
          _sum: { amount: true },
        });
        return new Map(rows.map((r) => [r.certificateId, r._sum.amount ?? ZERO]));
      },
    );
  }

}
