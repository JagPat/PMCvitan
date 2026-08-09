import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ROLE_POLICY,
  SOD_RULES,
  type BillPaymentLedgerDto,
  type PaymentApprovalDto,
  type PaymentDto,
  type PaymentReversalDto,
  type SodExceptionDto,
  type VendorBillStatus,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { hashRequest, type CommandScope } from '../platform/commands';
import { CommercialCommandRunner } from './commercial-command.runner';
import { resolveActor } from '../common/actor';
import { recordAudit } from '../platform/audit';
import { lockProjectReadiness } from '../common/readiness-lock';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { CommercialDeductionQuery } from './commercial-deduction.query';
import { CommercialStatusService } from './commercial-status.service';
import { announceMoneyMoved } from './cash-forecast.projection';
import { CommercialBillService } from './commercial-bill.service';
import { OrgsParticipant } from '../orgs/orgs.participant';
import { resolveSodGrant as resolveGrantForRule } from './commercial-sod';
import type { ApprovePaymentInput, RecordPaymentInput, ReversePaymentInput } from '../contracts';

const ZERO = new Prisma.Decimal(0);

/** Every read of a payment carries its reversals: the DTO's `reversed` fold and the ledger's own
 *  `paid` are both derived from them, so a read path that forgot the include would report a payment
 *  as fully standing while `PAID(bill)` had already fallen. Declared once for that reason. */
const PAYMENT_REVERSALS = { reversals: { orderBy: { reversedAt: 'asc' } } } as const;

/** What one payment actually left the practice with — its amount less what has come back. */
const netOf = (p: { amount: Prisma.Decimal; reversals: Array<{ amount: Prisma.Decimal }> }): Prisma.Decimal =>
  p.reversals.reduce((t, r) => t.sub(r.amount), p.amount);

/** The rule THIS half of §I defines. Named once, in the shared contract, so a grant issued for the
 *  certification rule can never be spent here. */
const SOD_RULE = SOD_RULES.certifierMayNotApprove;

/** The persisted shape each read maps from — declared once so the two read paths cannot drift. */
interface PaymentReversalRow {
  id: string; paymentId: string; billId: string; amount: Prisma.Decimal;
  reason: string; reversedAt: Date; reversedById: string;
}
interface PaymentRow {
  id: string; approvalId: string; billId: string; amount: Prisma.Decimal;
  method: string; reference: string | null; paidAt: Date; paidById: string;
  reversals: PaymentReversalRow[];
}
interface SodExceptionRow {
  rule: string; actorId: string; approverId: string; reason: string;
  recordedAt: Date; grantId: string | null;
}
interface ApprovalRow {
  id: string; billId: string; certificateId: string; amount: Prisma.Decimal;
  approvedAt: Date; approvedById: string;
  payments: PaymentRow[];
  sodExceptions: SodExceptionRow[];
}

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
 * **Task 6B closes the loop this class opened.** 6A shipped with the stored status pinned at
 * `certified` and said why: §F reads three folds and two of them did not exist yet. 6B-i made the
 * status a FUNCTION of all three, and 6B-ii adds the THIRD act — `reverse` — so `PAID` can fall and
 * the derivation can run backwards. That is not a convenience: §0's correction ordering requires a
 * certificate carrying cash to be emptied BEFORE it is superseded, and until this command existed
 * such a bill was correct and permanently uncorrectable.
 */
@Injectable()
export class CommercialPaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commands: CommercialCommandRunner,
    private readonly capabilities: CapabilitiesService,
    // §H's fold decides what is payable at all. Own module, one owner: bound 4 asks the same
    // question the deduction ledger answers, rather than growing a second copy of it here.
    private readonly deductions: CommercialDeductionQuery,
    // §I's ceiling is authority/standing data and `Membership` is ORGS-owned. Reading it here
    // directly would bypass the owner boundary: an orgs-side change to how active membership or a
    // downgrade is interpreted would leave payment approval and project access disagreeing about
    // the same actor. `commercial.workflowParticipants` already declares this edge.
    private readonly orgs: OrgsParticipant,
    // §B — an approval MOVES §J `certified-payable`, so it is a headroom mover and must raise or
    // clear the over-budget exception in its OWN transaction. Same evaluator every other mover
    // uses; a second copy of the raise-or-clear rule is how the label drifts from what moved.
    private readonly bills: CommercialBillService,
    private readonly status: CommercialStatusService,
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

  private assertReverse(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.reverse-payment'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Reversing a payment is a pmc surface — it recovers money that already left');
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

    const outcome = await this.commands.run({
      scope, actor, commandType: 'commercial.payment.approve', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const bill = await this.lockBill(tx, projectId, input.billId);

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
          select: { certifiedById: true, versionId: true },
        });
        // …and when it IS the certifier, the override is CONSUMED, never asserted. Resolved before
        // the row is written so a refusal costs nothing; the grant is spent afterwards, against the
        // approval id it authorises.
        const override = certificate.certifiedById === actor.actorId
          ? await this.resolveSodGrant(tx, projectId, input.billId, certificate.versionId, actor.actorId,
            { status: bill.status, lifecycleVersion: bill.lifecycleVersion })
          : null;

        // §G BOUND 4, re-derived under the lock and stated as the REMAINING headroom, because a
        // refusal that only says "too much" leaves the practice guessing at the number.
        const approvedSoFar = await this.deductions.approvedFor(tx, projectId, input.billId);
        const netPayable = new Prisma.Decimal(position.netPayable);
        const remaining = netPayable.sub(approvedSoFar);
        if (amount.greaterThan(remaining)) {
          throw new ConflictException(
            `Approving ${amount.toFixed(2)} would take the approved total past the ${netPayable.toFixed(2)} payable on this claim — ${approvedSoFar.toFixed(2)} is already approved, so ${remaining.toFixed(2)} remains. A certification carrying unreleased withholdings cannot authorise more than it leaves payable`,
          );
        }

        // §I — STANDING and the APPROVAL LIMIT, one locked decision through the owner. The limit is
        // applied to the CUMULATIVE total rather than to this row: a per-row check lets a ₹50-limit
        // approver authorise ₹100 as two ₹50 rows, each within limit, bound 4 satisfied, the
        // ceiling defeated. Crossing it escalates and never silently succeeds.
        await this.assertApprovalAuthority(tx, projectId, actor.actorId, approvedSoFar.add(amount));

        const approval = await tx.paymentApproval.create({
          data: {
            projectId, billId: input.billId, certificateId: position.certificateId,
            // the claim REVISION this authorisation was made against, read under the bill lock —
            // the §I consume seal matches it against the grant's, so an authority and the act it
            // excuses cannot name two different passages of the same claim
            reviewedLifecycleVersion: bill.lifecycleVersion,
            amount, approvedById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });

        if (override) {
          // the grant is spent with a CAS on the still-unconsumed row, so two concurrent approvals
          // cannot both claim one authority — `updateMany` returning 0 is that race losing
          const { count } = await tx.sodGrant.updateMany({
            where: { id: override.grantId, projectId, consumedAt: null },
            data: { consumedAt: new Date(), consumedByApprovalId: approval.id },
          });
          if (count === 0) {
            throw new ConflictException('That authorisation was consumed concurrently — reload and retry');
          }
          await tx.sodException.create({
            data: {
              projectId, approvalId: approval.id, grantId: override.grantId, rule: SOD_RULE,
              actorId: actor.actorId, approverId: override.approverId, reason: override.reason,
              // the exception is produced by the SAME command as the act it excuses — the seal
              // checks exactly this, because an override citing a different act is not this act's
              sourceCommandId: ctx.commandId!,
            },
          });
        }

        // §B — an approval lowers §J `certified-payable`, so it can CLEAR an open over-budget
        // exception on the heads this claim touches. Codex round 2 (P2): the fold was taught to
        // subtract `APPROVED` and the write was not made a mover, so a head whose exposure this
        // approval had already healed kept reporting a breach nobody could clear.
        await this.bills.evaluateHeadsForBill(tx, projectId, actor, input.billId, 'payment_approval');

        // §F — an approval MOVES `APPROVED`, so the derived status is re-read from the folds in
        // this same transaction, under the bill lock taken above. One derivation, every mover.
        await this.status.reDerive(tx, projectId, input.billId, bill.status as VendorBillStatus);

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

    const outcome = await this.commands.run({
      scope, actor, commandType: 'commercial.payment.record', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);

        const approval = await tx.paymentApproval.findFirst({
          where: { projectId, id: input.approvalId },
          select: { id: true, billId: true, amount: true, certificateId: true },
        });
        if (!approval) throw new NotFoundException('Payment approval not found in this project');

        // The BILL is what scopes both folds this command decides on, so it is locked before any of
        // them is read. `PaymentApproval` is append-only and its `certificateId` is frozen, so
        // resolving WHICH bill to lock above is safe; nothing decided is read before the lock.
        const bill = await this.lockBill(tx, projectId, approval.billId);

        // The approval must still be LIVE authority. `APPROVED(bill)` counts only approvals on the
        // live certificate, so paying against one whose certificate has been superseded attaches
        // append-only cash evidence to an authority that no longer participates in the bound at
        // all: approve 40 on C1, supersede C1, certify C2 and approve 40 there, and the bill-level
        // headroom check alone would let the C1 approval pay. Money leaves against the authority
        // that covered it, or it does not leave.
        //
        // Codex round 2 (P1) — and it is read UNDER the bill lock, not before it. `supersededAt` is
        // mutable: read ahead of the lock, this transaction can see `null`, a supersession can
        // commit, and by the time the folds are taken the guard has already passed on a fact that
        // is no longer true. A guard is only authoritative under the lock that serializes what it
        // guards against. (`lockProjectReadiness` above happens to serialize supersession today,
        // which is why no probe caught it — but a guard whose correctness rests on a coarser lock
        // being taken somewhere else is not a guard, it is a coincidence.)
        const cert = await tx.billCertificate.findFirstOrThrow({
          where: { projectId, id: approval.certificateId },
          select: { supersededAt: true },
        });
        if (cert.supersededAt !== null) {
          throw new ConflictException(
            'That approval rests on a certification that has since been superseded, so it is no longer the authority this claim is paid against — approve against the certificate that stands, and pay against that approval',
          );
        }

        // §G BOUND 5, re-derived under the lock — and it is TWO questions, not one.
        //
        // The bill-scoped bound (`PAID(bill)` ≤ `APPROVED(bill)`) is what §G states, and it is
        // right for what it measures: a second approval genuinely raises the ceiling. But it is
        // not the whole rule, because a `Payment` is nested UNDER one approval. Codex round 3
        // (P2): approve A1=40 and A2=40, pay 40 against A1, then pay 40 against A1 again — the
        // bill fold sees 80 approved and 40 paid and lets it through, and the ledger then reports
        // A1 as `paid: 80.00` against an authority of 40 while A2 sits unused. The bill-level
        // total is conserved and the attribution is a lie, which is the shape §C exists to
        // forbid: every unit of money answers to exactly one authority.
        const approvedTotal = await this.deductions.approvedFor(tx, projectId, approval.billId);
        const paidTotal = await this.deductions.paidFor(tx, projectId, approval.billId);
        const remaining = approvedTotal.sub(paidTotal);
        if (amount.greaterThan(remaining)) {
          throw new ConflictException(
            `Paying ${amount.toFixed(2)} would take the paid total past the ${approvedTotal.toFixed(2)} approved on this claim — ${paidTotal.toFixed(2)} is already paid, so ${remaining.toFixed(2)} remains. Money may only leave against an authority that covers it`,
          );
        }

        // …and the APPROVAL-scoped bound. Reported separately rather than folded into the message
        // above, because the two refusals send the practice to different places: the bill bound
        // says "get more approved", this one says "pay against the approval that covers it".
        const paidHere = await this.paidForApproval(tx, projectId, approval.id);
        const remainingHere = new Prisma.Decimal(approval.amount).sub(paidHere);
        if (amount.greaterThan(remainingHere)) {
          throw new ConflictException(
            `Paying ${amount.toFixed(2)} against this authorisation would take what it has paid to ${paidHere.add(amount).toFixed(2)}, above the ${new Prisma.Decimal(approval.amount).toFixed(2)} it authorises — ${remainingHere.toFixed(2)} remains on it. Another approval on this claim raises the claim's ceiling, not this one's; pay against the approval that covers the money`,
          );
        }

        const payment = await tx.payment.create({
          data: {
            projectId, approvalId: approval.id, billId: approval.billId,
            amount, method: input.method, reference: input.reference ?? null,
            paidById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });

        // §F — a payment MOVES `PAID`. `certified → approved-for-payment → part-paid → paid` are
        // all derived here rather than written by hand at four sites.
        await this.status.reDerive(tx, projectId, approval.billId, bill.status as VendorBillStatus);

        // §J (Task 7A) — the §J ANNOUNCEMENT is a SEPARATE obligation from §B's raise-or-clear, and
        // this is the one place the two come apart.
        //
        // Paying moves no HEADROOM (the identity above), so `FOLD_INPUTS` exempts it from the
        // evaluator and there is deliberately no `evaluateHeadsForBill` here. But it very much
        // moves a §J BUCKET — `approved` falls and `paid` rises — and the cash-forecast projection
        // stores those buckets. Task 7A hung the announcement off `evaluate`, which is right for
        // every mover that can breach a budget and WRONG for exactly the partition-only ones:
        // without this call the stored forecast keeps reporting money as authorised-and-unpaid
        // forever after it left the bank.
        //
        // The pin in `commercial.contract.test.ts` reads: every `FOLD_INPUTS` writer announces,
        // through an evaluator or directly. A partition-only row is exempt from §B, never from §J.
        await announceMoneyMoved(tx, projectId, actor, {
          costHeadCodes: await this.bills.headsForBill(tx, projectId, approval.billId), reason: 'payment',
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

  // ── §0/§F/§H — reverse ───────────────────────────────────────────────────────────────────────

  /**
   * Recover money already paid, against the payment that moved it.
   *
   * A distinct COMMAND rather than a signed `record`, because §H makes every append-only money row
   * strictly positive with the row TYPE carrying direction. A positive ₹50 "reversing payment"
   * reads ₹150 paid on a ₹100 bill; a negative one is refused by PostgreSQL. Neither is a reversal.
   *
   * **It does not need the certificate to move, and that is the whole point.** §0's correction
   * ordering is a SEQUENCE and cash goes first: `PAID(bill)` must be 0 before a certificate carrying
   * payments may be superseded, because supersession takes `APPROVED` to 0 and a residual paid
   * amount would be cash standing against an amount nobody has certified. The obvious alternative —
   * "refuse a supersession that would leave `PAID > APPROVED`" — makes the intended correction
   * impossible: reverse ₹50 of ₹100, supersede to ₹50, and `APPROVED` is 0 while `PAID` is ₹50, so
   * the guard refuses the very correction it exists to permit. Full reversal first, then the
   * document. So this command asks nothing about the certificate's state, deliberately.
   *
   * The bound is per PAYMENT (`Σ reversals ≤ that payment's amount`), and §0's bill-scoped statement
   * follows by summation. Per-payment is the stronger question for the reason 6A round 3 found: a
   * bill-level total can be conserved while the attribution is a lie.
   */
  async reverse(
    projectId: string, input: ReversePaymentInput, user: AuthUser, idempotencyKey?: string,
  ): Promise<PaymentDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertReverse(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const amount = this.parseAmount(input.amount);

    const outcome = await this.commands.run({
      scope, actor, commandType: 'commercial.payment.reverse', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);

        const payment = await tx.payment.findFirst({
          where: { projectId, id: input.paymentId },
          select: { id: true, billId: true, amount: true },
        });
        if (!payment) throw new NotFoundException('Payment not found in this project');

        // §0b — the BILL first, before the payment's own fold is read. `reDerive` below requires it,
        // and so does every other mover; taking it here keeps the order total (bill → payment) and
        // is what lets the derivation seal re-acquire it `NOWAIT` at commit without waiting.
        const bill = await this.lockBill(tx, projectId, payment.billId);

        // the bound, re-derived under the lock. A reversal returns money that actually left, so it
        // is capped by what its OWN payment carried — cumulatively, or two part-reversals would
        // each pass and together exceed it.
        const already = await this.deductions.reversedFor(tx, projectId, payment.id);
        const reversible = new Prisma.Decimal(payment.amount).sub(already);
        if (amount.greaterThan(reversible)) {
          throw new ConflictException(
            `Reversing ${amount.toFixed(2)} would return more than payment ${payment.id} moved — it paid ${new Prisma.Decimal(payment.amount).toFixed(2)}, ${already.toFixed(2)} has already come back, so ${reversible.toFixed(2)} remains reversible. Money can only be recovered from the payment that sent it`,
          );
        }

        const reversal = await tx.paymentReversal.create({
          data: {
            projectId, paymentId: payment.id, billId: payment.billId,
            amount, reason: input.reason,
            reversedById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });

        // §B — deliberately NOT a headroom mover, which is why there is no `evaluateHeadsForBill`
        // call here beside `approve`'s. §J's `certified-payable` is `NET_PAYABLE − APPROVED`, and a
        // reversal moves neither: it shifts money from the `paid` bucket back into `approved`, and
        // the two sum to the same exposure. `payment.record` is silent here for the same reason.
        // Calling the evaluator anyway would append a "cleared" or "raised" observation labelled
        // against a write that moved no headroom, which is the label drift §B's round 4 removed.
        //
        // That reasoning is about §B ONLY. The §J projection refresh below is a different
        // obligation and this write does owe it — see the note there.
        //
        // §F — a reversal LOWERS `PAID`, so the derivation runs BACKWARDS here: `paid` becomes
        // `approved-for-payment` on a full reversal and `part-paid` on a partial one. The same
        // function every other mover calls, which is what makes live == stored by construction
        // rather than by six services agreeing.
        await this.status.reDerive(tx, projectId, payment.billId, bill.status as VendorBillStatus);

        // §J (Task 7A) — the §J ANNOUNCEMENT is a SEPARATE obligation from §B's raise-or-clear, and
        // this is the one place the two come apart.
        //
        // Paying moves no HEADROOM (the identity above), so `FOLD_INPUTS` exempts it from the
        // evaluator and there is deliberately no `evaluateHeadsForBill` here. But it very much
        // moves a §J BUCKET — `approved` falls and `paid` rises — and the cash-forecast projection
        // stores those buckets. Task 7A hung the announcement off `evaluate`, which is right for
        // every mover that can breach a budget and WRONG for exactly the partition-only ones:
        // without this call the stored forecast keeps reporting money as authorised-and-unpaid
        // forever after it left the bank.
        //
        // The pin in `commercial.contract.test.ts` reads: every `FOLD_INPUTS` writer announces,
        // through an evaluator or directly. A partition-only row is exempt from §B, never from §J.
        await announceMoneyMoved(tx, projectId, actor, {
          costHeadCodes: await this.bills.headsForBill(tx, projectId, payment.billId), reason: 'payment_reversal',
        });

        await recordAudit(tx, {
          projectId, actor, action: 'commercial.payment.reverse',
          entity: 'PaymentReversal', entityId: reversal.id,
        });

        return { resultRef: reversal.id, events: [] };
      },
    });

    // the PAYMENT, reloaded — the reversal's meaning is the position it leaves its payment in, and
    // returning the row alone would make the caller ask a second question to learn what it did
    const created = await this.prisma.paymentReversal.findFirstOrThrow({
      where: { projectId, id: outcome.resultRef! }, select: { paymentId: true },
    });
    return this.paymentById(projectId, created.paymentId);
  }

  // ── the read ─────────────────────────────────────────────────────────────────────────────────

  /** One claim's approvals and payments, with the folds §G bounds 4–5 are measured against. */
  async ledger(projectId: string, billId: string, user: AuthUser): Promise<BillPaymentLedgerDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);

    // ONE SNAPSHOT for the status and the folds it is derived from (Codex round 1, P2).
    //
    // Before this task the status could not contradict the folds, because it never moved with them
    // — reading them at different instants was harmless. §F changes that: `payment.approve` now
    // moves `VendorBill.status` in the SAME transaction as the approval row, so an unsynchronized
    // read can straddle that commit. Read the bill first and a concurrent approval lands before the
    // approvals query, and this surface answers `approved: 100.00`, `approvable: 0.00`,
    // `billStatus: certified` — three numbers that were each true once and are not true together.
    // A repeatable-read snapshot makes the whole response one instant, which is what the deduction
    // ledger already does for the same reason.
    return this.prisma.$transaction(
      (tx) => this.paymentLedgerIn(tx, projectId, billId),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * The §G ledger ON A GIVEN TRANSACTION — the ONE spelling, so the standalone
   * `commercial.payments` route and the §M claim bundle (Task 7B-ii) cannot drift about which
   * certificate the approved fold counts against or which rows `PAID` nets its reversals from.
   *
   * The ISOLATION stays with the caller for the reason above: this method's contract is that every
   * figure comes from the snapshot it is handed, and the claim bundle's snapshot deliberately spans
   * this ledger AND the deduction ledger — `approvable` is derived from the other's `netPayable`,
   * so two snapshots would let them disagree about the same claim.
   */
  async paymentLedgerIn(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<BillPaymentLedgerDto> {
    const bill = await tx.vendorBill.findFirst({
      where: { projectId, id: billId },
      select: { id: true, status: true },
    });
    if (!bill) throw new NotFoundException('Vendor bill not found in this project');

    const position = await this.deductions.positionFor(tx, projectId, billId);
    const approvals = await tx.paymentApproval.findMany({
      where: { projectId, billId },
      orderBy: { approvedAt: 'asc' },
      include: { payments: { orderBy: { paidAt: 'asc' }, include: PAYMENT_REVERSALS }, sodExceptions: true },
    });

    const rows: PaymentApprovalDto[] = approvals.map((a) => this.toApprovalDto(a));

    // The approved fold counts approvals against the LIVE certificate only — a superseded one is
    // retained history, and summing it would compare an overstated total against the bound.
    const approved = approvals
      .filter((a) => position && a.certificateId === position.certificateId)
      .reduce((t, a) => t.add(a.amount), ZERO);
    // §0's `PAID(bill)` — Σ payments MINUS Σ payment reversals. Folded from the SAME rows the
    // approvals carry so the ledger cannot report a total its own line items contradict.
    const paid = approvals.reduce((t, a) => t.add(a.payments.reduce((s, p) => s.add(netOf(p)), ZERO)), ZERO);

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
   * What ONE authorisation has already paid — the fold the per-approval bound measures, and the
   * same number `PaymentApprovalDto.paid` reports, so the refusal and the read agree.
   *
   * Task 6B-ii: NET of reversals, for the same reason the bill-scoped fold is. Money that came back
   * was not spent against this approval, so leaving it in would keep an authority's headroom
   * permanently consumed by cash the practice recovered — the reversal would lower `PAID(bill)` and
   * unlock the claim while the approval it was drawn on stayed full.
   */
  private async paidForApproval(
    tx: Prisma.TransactionClient, projectId: string, approvalId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
      SELECT COALESCE(SUM(p."amount"), 0)
           - COALESCE((SELECT SUM(r."amount")
                         FROM "PaymentReversal" r
                         JOIN "Payment" p2 ON p2."projectId" = r."projectId" AND p2."id" = r."paymentId"
                        WHERE r."projectId" = ${projectId} AND p2."approvalId" = ${approvalId}), 0) AS total
        FROM "Payment" p
       WHERE p."projectId" = ${projectId} AND p."approvalId" = ${approvalId}`;
    return new Prisma.Decimal(rows[0]?.total ?? 0);
  }

  /**
   * §I — STANDING and the approval ceiling, as ONE locked decision asked of the owner.
   *
   * The `RolesFor` guard authorised the REQUEST; this authorises the WRITE, and the two are not the
   * same moment. Codex round 2 (P1): an earlier spelling asked only for the ceiling, so a token
   * that passed the guard as pmc could still append an approval after a concurrent downgrade to
   * engineer had committed — the lock protected the number and not the authority the number
   * qualifies. `approvalAuthorityFor` decides the same role/standing predicate project access uses,
   * under that lock, and returns the ceiling only when the actor still holds it.
   *
   * A ceiling of `null` is unlimited — the state every existing membership is in, and the state of
   * the org owner/admin arm, which has no project membership row to carry one. A ceiling of zero is
   * a real ceiling and refuses everything, because "cannot approve" is a thing a practice may
   * legitimately want to say about a role.
   */
  private async assertApprovalAuthority(
    tx: Prisma.TransactionClient, projectId: string, actorId: string, cumulative: Prisma.Decimal,
  ): Promise<void> {
    const authority = await this.orgs.approvalAuthorityFor(
      tx, projectId, actorId, ROLE_POLICY['commercial.approve-payment'],
    );
    if (!authority.standing) {
      throw new ForbiddenException(
        'You no longer hold the standing on this project that approving a payment requires — a role change committed while this request was in flight, and money does not leave on authority that has been withdrawn',
      );
    }
    const limit = authority.ceiling;
    if (limit === null) return;
    if (cumulative.greaterThan(limit)) {
      throw new ForbiddenException(
        `This would take the approved total on this claim to ${cumulative.toFixed(2)}, above your approval ceiling of ${new Prisma.Decimal(limit).toFixed(2)} — the limit applies to the claim's cumulative approved total, not to one authorisation, so splitting it into smaller approvals does not clear it. It needs a higher-limit approver`,
      );
    }
  }

  /**
   * §I — the OVERRIDE that lets the certifier approve, CONSUMED rather than asserted.
   *
   * The plan is explicit that silently banning the override is not an option: a two-person practice
   * must still be able to operate. It is equally explicit that the override is only legitimate
   * because it writes a sealed record — so this is the same two-act mechanism certification uses,
   * against the same `SodGrant` table, selected on the PAYMENT rule so an authority issued for
   * certification can never be spent here.
   *
   * The RULE is `commercial-sod.ts` and is shared with the certification half. It used to be thirty
   * lines of near-identical logic here, and Codex found exactly what that costs: 7B-iii-h taught
   * the certification resolver that a grant records the claim STATE its approver reviewed, and this
   * copy never learned it — so an authorisation written over a claim with nothing approved on it
   * could still release money after someone else had approved ₹10 of the same claim. Two
   * implementations of one question, and only the one the unit was named for got fixed. Now there
   * is one, and only the REFUSALS are stated here, because what a non-live state means is a
   * property of the act being refused rather than of the resolution.
   */
  private async resolveSodGrant(
    tx: Prisma.TransactionClient, projectId: string, billId: string, versionId: string, actorId: string,
    asOf: { status: string; lifecycleVersion: number },
  ): Promise<{ grantId: string; approverId: string; reason: string }> {
    const resolved = await resolveGrantForRule(
      tx, this.orgs, projectId, billId, versionId, SOD_RULE, actorId, true, asOf,
    );
    if (resolved.state === 'live') {
      return { grantId: resolved.grant.id, approverId: resolved.grant.approverId, reason: resolved.grant.reason };
    }
    if (resolved.state === 'approver-lost-standing') {
      throw new ForbiddenException(
        'The authorisation to approve this claim was granted by someone who no longer holds pmc standing on this project — a pmc with standing must authorise it again',
      );
    }
    // version-pinned, exactly as certification's grant is: an amendment is a DIFFERENT claim, and
    // permission to release money against the one the approver looked at must not carry over
    if (resolved.state === 'stale-version') {
      throw new ConflictException(
        'The authorisation to approve this claim was granted against an earlier claim version — the claim has been amended since, so it needs authorising again',
      );
    }
    // …and the version is not the whole of what an approver looked at. A claim keeps ONE version id
    // while its payment state moves, so an exception written when nothing was approved would
    // otherwise still stand after somebody approved part of it — a materially different claim,
    // authorised by nobody.
    if (resolved.state === 'stale-review') {
      throw new ConflictException(
        'The authorisation to approve this claim was granted against a claim state that no longer holds — the claim has moved on since it was authorised, so it needs authorising again against what stands now',
      );
    }
    throw new ForbiddenException(
      'The person who certified this claim may not also approve its payment — certification says what is owed and approval releases it, and one person doing both is the separation §I exists to keep. '
      + 'A different approver, or a pmc with standing authorising it with `commercial.sod.grant` naming the `certifier-may-not-approve` rule, is required.',
    );
  }

  private async lockBill(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<{ id: string; status: string; lifecycleVersion: number }> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; lifecycleVersion: number }>>`
      SELECT b."id", b."status",
             COALESCE(r."revision", 0)::int AS "lifecycleVersion"
        FROM "VendorBill" b
        LEFT JOIN "VendorBillRevision" r ON r."projectId" = b."projectId" AND r."billId" = b."id"
       WHERE b."projectId" = ${projectId} AND b."id" = ${billId} FOR UPDATE OF b`;
    const bill = rows[0];
    if (!bill) throw new NotFoundException('Vendor bill not found in this project');
    return bill;
  }

  private toPaymentDto(p: PaymentRow): PaymentDto {
    return {
      id: p.id,
      approvalId: p.approvalId,
      billId: p.billId,
      amount: p.amount.toFixed(2),
      method: p.method,
      reference: p.reference,
      paidAt: p.paidAt.toISOString(),
      paidById: p.paidById,
      // Task 6B-ii — the fold and the rows it is folded from, together. A reversal that lowers
      // `PAID` but never appears on the ledger is money movement nobody can review, and reporting
      // only the total would leave a reviewer unable to see WHY the cash came back.
      reversed: p.reversals.reduce((t, r) => t.add(r.amount), ZERO).toFixed(2),
      reversals: p.reversals.map((r) => this.toReversalDto(r)),
    };
  }

  private toReversalDto(r: PaymentReversalRow): PaymentReversalDto {
    return {
      id: r.id,
      paymentId: r.paymentId,
      billId: r.billId,
      amount: r.amount.toFixed(2),
      reason: r.reason,
      reversedAt: r.reversedAt.toISOString(),
      reversedById: r.reversedById,
    };
  }

  private async approvalById(projectId: string, id: string): Promise<PaymentApprovalDto> {
    const a = await this.prisma.paymentApproval.findFirstOrThrow({
      where: { projectId, id },
      include: { payments: { orderBy: { paidAt: 'asc' }, include: PAYMENT_REVERSALS }, sodExceptions: true },
    });
    return this.toApprovalDto(a);
  }

  /** ONE mapping, so the ledger and the single-approval reload cannot report the same row two ways
   *  — the §I override in particular, which is the field a reviewer looks for. */
  private toApprovalDto(a: ApprovalRow): PaymentApprovalDto {
    const sod = a.sodExceptions[0];
    return {
      id: a.id,
      billId: a.billId,
      certificateId: a.certificateId,
      amount: a.amount.toFixed(2),
      approvedAt: a.approvedAt.toISOString(),
      approvedById: a.approvedById,
      // NET of reversals, so this agrees with `paidForApproval` — the refusal and the read are one
      // number. Money that came back was not spent against this authority.
      paid: a.payments.reduce((t, p) => t.add(netOf(p)), ZERO).toFixed(2),
      payments: a.payments.map((p) => this.toPaymentDto(p)),
      sodException: sod ? this.toSodExceptionDto(sod) : null,
    };
  }

  private toSodExceptionDto(s: SodExceptionRow): SodExceptionDto {
    return {
      rule: s.rule, actorId: s.actorId, approverId: s.approverId, reason: s.reason,
      recordedAt: s.recordedAt.toISOString(), grantId: s.grantId,
    };
  }

  private async paymentById(projectId: string, id: string): Promise<PaymentDto> {
    const p = await this.prisma.payment.findFirstOrThrow({
      where: { projectId, id }, include: PAYMENT_REVERSALS,
    });
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


}
