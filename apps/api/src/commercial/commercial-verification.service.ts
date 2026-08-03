import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ROLE_POLICY,
  type VerificationDto, type VerificationExceptionKind, type VerificationLineDto,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import { recordAudit } from '../platform/audit';
import { lockProjectReadiness } from '../common/readiness-lock';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { ProcurementParticipant } from '../procurement/procurement.participant';
import { LabourRequirementParticipant } from '../labour/labour.participant';
import { InventoryQuery } from '../inventory/inventory.query';
import { CommercialBillQuery } from './commercial-bill.query';
import { CommercialBillService } from './commercial-bill.service';
import { CommercialMeasurementQuery } from './commercial-measurement.query';
import type { VendorBillStepInput } from '../contracts';

const ZERO = new Prisma.Decimal(0);

/** One claim line resolved against its ordered snapshot — the row §E's triple is computed over. */
type LineTriple = {
  billLineId: string;
  kind: 'material' | 'labour';
  poLineId: string;
  claimedQty: Prisma.Decimal;
  claimedRate: Prisma.Decimal;
  claimedTax: Prisma.Decimal;
  claimedFreight: Prisma.Decimal;
};

/**
 * Phase 5 Task 5A (§E) — THREE-WAY VERIFICATION.
 *
 * §E's opening sentence is the design: the triple is **derived, never stored**. A stored verdict is
 * a stale verdict the moment a receipt is reversed, so it is recomputed at every transition that
 * depends on it — submission (Task 4's bounds) and verification here, certification in 5B.
 *
 * **This increment ships the verdict and the ONE arrow the verdict makes safe.** Task 4 stopped the
 * §F graph at `under-verification` because `verified` is the state whose safety IS the §E verdict;
 * that verdict now exists, so the arrow opens — and not one step further. Certification is 5B's,
 * because a certificate needs evidence of its own (which rows it consumed, and how much of each)
 * that this increment deliberately does not invent.
 */
@Injectable()
export class CommercialVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly procurement: ProcurementParticipant,
    private readonly labour: LabourRequirementParticipant,
    private readonly inventory: InventoryQuery,
    private readonly bills: CommercialBillQuery,
    // §B — the bill service owns the fold's closure rule; this service moves the claim between the
    // live and non-live sets, so it discharges that obligation through the owner rather than
    // growing its own copy. No cycle: the bill service does not know this one exists.
    private readonly billService: CommercialBillService,
    private readonly measured: CommercialMeasurementQuery,
  ) {}

  private assertVerify(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.verify'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Verifying a vendor claim is a pmc surface');
    }
  }

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The commercial register is a pmc/engineer surface');
    }
  }

  // ── §E — the triple ──────────────────────────────────────────────────────────────────────────

  /**
   * Read the LIVE version's lines of a bill, resolved to the shape the triple is computed over.
   * Throws when the bill has no live version, which the Task-4 seal already makes unrepresentable —
   * this is the service saying so in a sentence rather than letting a `findFirstOrThrow` surface.
   */
  private async claimLines(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<{ versionId: string; lines: LineTriple[] }> {
    const version = await tx.vendorBillVersion.findFirst({
      where: { projectId, billId, supersededAt: null },
      include: { lines: true },
    });
    if (!version) throw new NotFoundException(`Vendor bill ${billId} has no live claim version`);
    return {
      versionId: version.id,
      lines: version.lines.map((l) => ({
        billLineId: l.id,
        kind: l.type as 'material' | 'labour',
        poLineId: (l.poLineId ?? l.labourPoLineId)!,
        claimedQty: l.quantity,
        claimedRate: l.rate,
        claimedTax: l.taxAmount,
        claimedFreight: l.freightAmount,
      })),
    };
  }

  /**
   * §E — compute the triple for every line of a bill's live claim.
   *
   * Every side is a §0 set BY NAME. Not one filter is restated here, and that is not tidiness:
   * §E says in as many words that restating them "is exactly the drift that produced two rounds of
   * findings". `BILLED_QTY`/`BILLED_AMOUNT`/`BILLED_TAX`/`BILLED_FREIGHT` come from
   * `CommercialBillQuery`, `ACCEPTED` from `InventoryQuery`, `MEASURED` from
   * `CommercialMeasurementQuery`, and the ordered side from each line's OWNING module.
   *
   * The PO lines are locked FIRST, in ONE ascending order over the whole bill, before any per-line
   * work. Not "the PO line" per bill line: a multi-line bill visited in bill-line order lets
   * certification A hold line X and wait for Y while B holds Y and waits for X. This is the
   * Phase-4 Task-3 crew-allocation guardrail — stable ascending lock order — applied to money.
   */
  private async computeTriple(
    tx: Prisma.TransactionClient,
    projectId: string,
    billId: string,
    vendorId: string,
  ): Promise<VerificationDto> {
    const { versionId, lines } = await this.claimLines(tx, projectId, billId);

    // ONE total order over every PO line the bill touches — material and labour together
    const targets = [...new Set(lines.map((l) => `${l.kind} ${l.poLineId}`))].sort();
    const ordered = new Map<string, {
      ordered: Prisma.Decimal; live: boolean; rate: Prisma.Decimal;
      tax: Prisma.Decimal; freight: Prisma.Decimal; orderedQty: Prisma.Decimal;
    }>();
    for (const target of targets) {
      const [kind, poLineId] = target.split(' ') as ['material' | 'labour', string];
      if (kind === 'material') {
        const o = await this.procurement.lockOrderedLineForClaim(tx, projectId, poLineId);
        if (!o) throw new NotFoundException(`Purchase-order line ${poLineId} not found in this project`);
        ordered.set(target, {
          ordered: o.ordered, live: o.live, rate: o.rate,
          tax: o.taxAmount, freight: o.freightAmount, orderedQty: o.orderedQty,
        });
      } else {
        const o = await this.labour.lockOrderedLineForClaim(tx, projectId, poLineId);
        if (!o) throw new NotFoundException(`Labour purchase-order line ${poLineId} not found in this project`);
        // a labour line freezes no tax or freight, which is why a labour claim's are pinned to zero
        ordered.set(target, {
          ordered: o.ordered, live: o.live, rate: o.rate,
          tax: ZERO, freight: ZERO, orderedQty: o.ordered,
        });
      }
    }

    const out: VerificationLineDto[] = [];
    for (const l of lines) {
      const key = `${l.kind} ${l.poLineId}`;
      const o = ordered.get(key)!;
      const exceptions: VerificationExceptionKind[] = [];

      const billedQty = (await this.bills.billedQtyFor(tx, projectId, l.kind, [l.poLineId])).get(l.poLineId) ?? ZERO;
      const billedAmount = (await this.bills.billedAmountFor(tx, projectId, l.kind, [l.poLineId])).get(l.poLineId) ?? ZERO;
      const evidence = l.kind === 'material'
        ? (await this.inventory.acceptedFor(tx, projectId, [l.poLineId])).get(l.poLineId) ?? ZERO
        : (await this.measured.measuredForPoLines(tx, projectId, [l.poLineId])).get(l.poLineId) ?? ZERO;

      // an order that is no longer live authorises nothing, so every quantity on it is over-ordered
      const orderedAuthority = o.live ? o.ordered : ZERO;
      if (billedQty.greaterThan(orderedAuthority)) exceptions.push('qty-over-ordered');
      if (billedQty.greaterThan(evidence)) exceptions.push('qty-over-accepted');
      // §E — freight is COMPARED, not merely carried: a claim matching on quantity, rate and tax
      // while inflating freight would otherwise reach certification unexamined.
      if (!l.claimedRate.equals(o.rate)) exceptions.push('rate-mismatch');

      // §E — tax and freight are PRORATED, never compared whole. The PO freezes a LINE-level
      // amount for the FULL ordered quantity, so a 50-unit bill against a 100-unit PO carrying
      // ₹1,800 tax legitimately claims ₹900. Comparing against the whole figure disputes an honest
      // partial bill; comparing neither lets two 50-unit bills each claim the whole ₹1,800.
      //
      // The `min` is load-bearing. §G lets material billing reach `qty + approvedOverage`, and
      // scaling by raw `BILLED_QTY / qty` on a 100-unit / ₹1,800-tax line with 10 overage units
      // gives a ₹1,980 cap — ₹180 of tax authority nobody ever froze. Overage is approved as
      // QUANTITY and snapshots no extra landed amounts, so the cap stops at the frozen figure and
      // tax on overage units is an EXPLICIT charge until an amendment freezes its own.
      const scale = o.orderedQty.greaterThan(0)
        ? Prisma.Decimal.min(billedQty, o.orderedQty).div(o.orderedQty)
        : ZERO;
      const taxCap = o.tax.mul(scale).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const freightCap = o.freight.mul(scale).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      const claimed = await this.bills.billedTaxAndFreightFor(tx, projectId, l.kind, l.poLineId);
      if (claimed.tax.greaterThan(taxCap)) exceptions.push('tax-mismatch');
      if (claimed.freight.greaterThan(freightCap)) exceptions.push('freight-mismatch');

      // §E — the SERVICE-side half of `duplicate-claim`: the cases the live-document index cannot
      // see. §E names TWO of them, and the first head implemented only one.
      //
      //  (a) the same units claimed twice under DIFFERENT vendor document numbers, which the index
      //      permits and the accepted-quantity bound only catches once the second claim exceeds
      //      what actually arrived; and
      //  (b) **a resubmission after REJECTION that is genuinely the same claim rather than a
      //      correction** (Codex round-1 F4). A rejected bill is out of the live-document index,
      //      out of every live billed fold, and — as first written — out of this scan too, so a
      //      vendor could bypass a rejection by replaying the identical quantity and rate instead
      //      of correcting it, and the replay would verify as `matched`.
      //
      // So the scan spans REJECTED predecessors as well as live ones. `disputed` and `resolved` are
      // deliberately still excluded: a dispute is the system asking for a correction, and the
      // corrected claim SHOULD look different — flagging its predecessor as a duplicate of it would
      // punish the vendor for doing exactly what the dispute asked.
      const twin = await tx.vendorBillLine.count({
        where: {
          projectId,
          ...(l.kind === 'material' ? { poLineId: l.poLineId } : { labourPoLineId: l.poLineId }),
          quantity: l.claimedQty,
          rate: l.claimedRate,
          id: { not: l.billLineId },
          version: {
            is: {
              supersededAt: null,
              billId: { not: billId },
              bill: { is: { vendorId, status: { notIn: ['draft', 'disputed', 'resolved'] } } },
            },
          },
        },
      });
      if (twin > 0) exceptions.push('duplicate-claim');

      out.push({
        billLineId: l.billLineId,
        kind: l.kind,
        poLineId: l.poLineId,
        orderedQty: o.ordered.toString(),
        orderedRate: o.rate.toString(),
        orderedTax: o.tax.toString(),
        orderedFreight: o.freight.toString(),
        evidenceQty: evidence.toString(),
        billedQty: billedQty.toString(),
        billedAmount: billedAmount.toString(),
        taxCap: taxCap.toString(),
        freightCap: freightCap.toString(),
        exceptions,
      });
    }

    const all = [...new Set(out.flatMap((l) => l.exceptions))];
    return {
      billId, versionId,
      verdict: all.length === 0 ? 'matched' : 'exception',
      lines: out,
      exceptions: all,
    };
  }

  // ── the commands ─────────────────────────────────────────────────────────────────────────────

  /**
   * §E/§F — VERIFY. A matched claim moves `under-verification → verified`; an exception moves it to
   * `disputed`, naming the exception.
   *
   * §E's closing sentence is why this is not an auto-reject: "An exception does not auto-reject. It
   * moves the bill to `disputed` and requires a responsible review with an attributable reason to
   * proceed" — spec §16. The claim's record survives, which is the evidence the dispute is about.
   */
  async verify(projectId: string, input: VendorBillStepInput, user: AuthUser, idempotencyKey?: string): Promise<VerificationDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertVerify(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    let verdict: VerificationDto | null = null;

    await executeCommand(this.prisma, {
      scope, actor, commandType: 'commercial.bill.verify', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const bill = await this.lockBill(tx, projectId, input.billId);
        if (bill.status !== 'under-verification') {
          throw new ConflictException(
            `A ${bill.status} claim cannot be verified — verification applies to a claim under verification`,
          );
        }
        verdict = await this.computeTriple(tx, projectId, input.billId, bill.vendorId);

        // Codex round-1 F2/F5 — RECORD the verdict before the transition it justifies. It is what
        // the database checks before accepting `verified`, and what a replay returns instead of
        // recomputing: refolding after the first call disputed the bill excludes it from the live
        // set, so the retry would answer `matched` and contradict the dispute that happened.
        await tx.billVerification.create({
          data: {
            projectId, billId: input.billId, versionId: verdict.versionId,
            verdict: verdict.verdict, exceptions: verdict.exceptions,
            verifiedById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });

        if (verdict.verdict === 'matched') {
          await this.cas(tx, projectId, input.billId, 'under-verification', 'verified', null);
        } else {
          await this.cas(
            tx, projectId, input.billId, 'under-verification', 'disputed',
            `verification-exception: ${verdict.exceptions.join(', ')}`,
          );
        }
        // §B (Codex round-1 F1) — a verdict MOVES the claim between the live and non-live billed
        // sets, so it is a headroom mover like every other bill transition. `disputed` leaves the
        // live fold, and leaving the register unevaluated lets the budget READ drop the exposure
        // while the exception stays open — two surfaces built from the same fold disagreeing.
        await this.billService.evaluateHeadsForBill(tx, projectId, { actorId: actor.actorId, role: user.role }, input.billId);
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.bill.verify', entity: 'VendorBill', entityId: input.billId,
        });
        return { resultRef: input.billId, events: [] };
      },
    });
    // Codex round-1 F5 — a REPLAY skips the closure, so `verdict` is null. Return what the original
    // call CONCLUDED, from the durable record, rather than recomputing: the first call has already
    // moved the bill, and §0's live rule means the refold no longer sees the claim it judged.
    if (!verdict) verdict = await this.replayVerdict(projectId, input.billId);
    return verdict;
  }

  /**
   * The stored verdict for a bill's CURRENT claim version, shaped as the caller expects.
   *
   * The line-level triple is NOT reconstructed: §E derives it, and a derivation taken now would be
   * about a different world than the one the verdict was reached in. What a replay owes the caller
   * is what the original call concluded — the verdict and its exceptions — which is exactly what
   * was recorded.
   */
  private async replayVerdict(projectId: string, billId: string): Promise<VerificationDto> {
    const version = await this.prisma.vendorBillVersion.findFirst({
      where: { projectId, billId, supersededAt: null }, select: { id: true },
    });
    const recorded = await this.prisma.billVerification.findFirst({
      where: { projectId, billId, ...(version ? { versionId: version.id } : {}) },
      orderBy: [{ verifiedAt: 'desc' }, { id: 'desc' }],
    });
    if (!recorded) throw new NotFoundException(`Vendor bill ${billId} has no recorded verification`);
    return {
      billId, versionId: recorded.versionId,
      verdict: recorded.verdict as VerificationDto['verdict'],
      lines: [],
      exceptions: recorded.exceptions as VerificationExceptionKind[],
    };
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────

  async readVerification(projectId: string, billId: string, user: AuthUser): Promise<VerificationDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);
    return this.prisma.$transaction(async (tx) => {
      const bill = await tx.vendorBill.findFirst({ where: { projectId, id: billId }, select: { vendorId: true } });
      if (!bill) throw new NotFoundException('Vendor bill not found in this project');
      return this.computeTriple(tx, projectId, billId, bill.vendorId);
    });
  }

  // ── shared machinery ─────────────────────────────────────────────────────────────────────────

  private async cas(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
    from: string, to: string, reason: string | null,
  ): Promise<void> {
    const { count } = await tx.vendorBill.updateMany({
      where: { id: billId, projectId, status: from },
      data: { status: to, statusChangedAt: new Date(), ...(reason !== null ? { statusReason: reason } : {}) },
    });
    if (count === 0) throw new ConflictException('This claim moved concurrently — reload and retry');
  }

  /** §0b — the BILL is taken FIRST, before any foreign row, so the lock order stays total. */
  private async lockBill(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
  ): Promise<{ id: string; status: string; vendorId: string }> {
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; vendorId: string }>>`
      SELECT "id", "status", "vendorId" FROM "VendorBill"
       WHERE "projectId" = ${projectId} AND "id" = ${billId} FOR UPDATE`;
    const bill = rows[0];
    if (!bill) throw new NotFoundException('Vendor bill not found in this project');
    return bill;
  }
}
