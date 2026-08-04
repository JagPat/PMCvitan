import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ROLE_POLICY, isLiveBillStatus,
  type VendorBillStatus, type VerificationDto, type VerificationExceptionKind, type VerificationLineDto,
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

/**
 * The totals ONE claim states against ONE purchase-order line. §E's duplicate rule compares claims
 * in this unit rather than line by line: what a vendor claims against an order is the total they
 * claim, and how many lines they split it across is presentation (Codex round-3).
 */
function totalsFor(
  lines: readonly LineTriple[], kind: 'material' | 'labour', poLineId: string,
): { quantity: Prisma.Decimal; amount: Prisma.Decimal; tax: Prisma.Decimal; freight: Prisma.Decimal } {
  const mine = lines.filter((l) => l.kind === kind && l.poLineId === poLineId);
  return {
    quantity: mine.reduce((a, l) => a.add(l.claimedQty), new Prisma.Decimal(0)),
    amount: mine.reduce((a, l) => a.add(l.claimedAmount), new Prisma.Decimal(0)),
    tax: mine.reduce((a, l) => a.add(l.claimedTax), new Prisma.Decimal(0)),
    freight: mine.reduce((a, l) => a.add(l.claimedFreight), new Prisma.Decimal(0)),
  };
}

/** One claim line resolved against its ordered snapshot — the row §E's triple is computed over. */
type LineTriple = {
  billLineId: string;
  kind: 'material' | 'labour';
  poLineId: string;
  claimedQty: Prisma.Decimal;
  claimedRate: Prisma.Decimal;
  claimedTax: Prisma.Decimal;
  claimedFreight: Prisma.Decimal;
  claimedAmount: Prisma.Decimal;
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
   *
   * PUBLIC because §E names THREE sites that recompute the triple — "submission, verification and
   * certification" — and Task 5B's certification is the third. One function at three sites rather
   * than a copy per site: a second implementation is the drift §0 exists to name, and it would
   * disagree the first time either changed.
   * Throws when the bill has no live version, which the Task-4 seal already makes unrepresentable —
   * this is the service saying so in a sentence rather than letting a `findFirstOrThrow` surface.
   */
  async claimLines(
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
        claimedAmount: l.amount,
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
  async computeTriple(
    tx: Prisma.TransactionClient,
    projectId: string,
    billId: string,
    vendorId: string,
    billStatus: VendorBillStatus,
  ): Promise<VerificationDto> {
    const { versionId, lines } = await this.claimLines(tx, projectId, billId);

    // Codex round-4 — COUNT THE CLAIM BEING JUDGED. Every billed side here is a §0 set, and §0
    // excludes a `draft`, `disputed`, `rejected` or `resolved` bill from all of them — so for a
    // claim in any of those states the fold does not contain the very lines being verified, and
    // the triple is computed against everything EXCEPT the subject. The result is a vacuous
    // `matched`: a 200-unit draft against 100 accepted reads 0 billed, and a claim disputed at
    // submission for exceeding its evidence reads as matching the moment the dispute removes it.
    //
    // `CommercialBillService.evaluateBounds` already carries this exact parameter (`countLinesAsLive`,
    // added for the resolving amendment, which is disputed while its replacement is written). Two
    // computations over the same fold need the same rule, so this is that rule at its second site
    // rather than a second rule: when §0 does not count the subject, the subject is added back.
    const subjectFolded = isLiveBillStatus(billStatus);

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

      // the subject claim's own totals on THIS purchase-order line, added back when §0's live rule
      // leaves them out of the fold (see `subjectFolded` above)
      const subject = subjectFolded ? null : totalsFor(lines, l.kind, l.poLineId);
      const billedQty = ((await this.bills.billedQtyFor(tx, projectId, l.kind, [l.poLineId])).get(l.poLineId) ?? ZERO)
        .add(subject?.quantity ?? ZERO);
      const billedAmount = ((await this.bills.billedAmountFor(tx, projectId, l.kind, [l.poLineId])).get(l.poLineId) ?? ZERO)
        .add(subject?.amount ?? ZERO);
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
      const folded = await this.bills.billedTaxAndFreightFor(tx, projectId, l.kind, l.poLineId);
      const claimed = {
        tax: folded.tax.add(subject?.tax ?? ZERO),
        freight: folded.freight.add(subject?.freight ?? ZERO),
      };
      if (claimed.tax.greaterThan(taxCap)) exceptions.push('tax-mismatch');
      if (claimed.freight.greaterThan(freightCap)) exceptions.push('freight-mismatch');

      // §E — the SERVICE-side half of `duplicate-claim`: the cases the live-document index cannot
      // see. §E names two of them — the same units under DIFFERENT vendor document numbers, and a
      // resubmission after REJECTION that is genuinely the same claim rather than a correction.
      //
      // Codex round-3 — the comparison is per (BILL, PO LINE) AGGREGATE, not per line. Comparing
      // lines individually let a duplicate hide behind nothing more than a different partitioning:
      // with 200 accepted, `INV-A` split as 60 + 40 and `INV-B` as a single 100 keeps the aggregate
      // inside the evidence, and no per-line predicate ever finds an exact twin — so the same 100
      // units verify twice under two document numbers. What a vendor claims against an order is the
      // TOTAL they claim, and the line breakdown is presentation.
      //
      // `disputed` and `resolved` stay excluded: a dispute ASKS for a correction, and the corrected
      // claim should look different — flagging its predecessor as its twin would punish the vendor
      // for doing exactly what the dispute asked.
      const mine = totalsFor(lines, l.kind, l.poLineId);
      const others = await tx.$queryRaw<Array<{ billId: string }>>`
        SELECT v."billId"                      AS "billId",
               SUM(bl."quantity")              AS "quantity",
               SUM(bl."amount")                AS "amount",
               SUM(bl."taxAmount")             AS "taxAmount",
               SUM(bl."freightAmount")         AS "freightAmount"
          FROM "VendorBillLine" bl
          JOIN "VendorBillVersion" v ON v."projectId" = bl."projectId" AND v."id" = bl."versionId"
          JOIN "VendorBill"        b ON b."projectId" = v."projectId" AND b."id" = v."billId"
         WHERE bl."projectId" = ${projectId}
           AND ${l.kind === 'material' ? Prisma.sql`bl."poLineId" = ${l.poLineId}` : Prisma.sql`bl."labourPoLineId" = ${l.poLineId}`}
           AND v."supersededAt" IS NULL
           AND v."billId" <> ${billId}
           AND b."vendorId" = ${vendorId}
           AND b."status" NOT IN ('draft', 'disputed', 'resolved')
         GROUP BY v."billId"
        HAVING SUM(bl."quantity") = ${mine.quantity}
           AND SUM(bl."amount") = ${mine.amount}
           AND SUM(bl."taxAmount") = ${mine.tax}
           AND SUM(bl."freightAmount") = ${mine.freight}`;
      const twin = others.length;
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
      billStatus,
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

    const outcome = await executeCommand(this.prisma, {
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
        const triple = await this.computeTriple(
          tx, projectId, input.billId, bill.vendorId, bill.status as VendorBillStatus,
        );

        // Codex round-1 F2/F5 — RECORD the verdict before the transition it justifies. It is what
        // the database checks before accepting `verified`, and what a replay returns instead of
        // recomputing: refolding after the first call disputed the bill excludes it from the live
        // set, so the retry would answer `matched` and contradict the dispute that happened.
        const recorded = await tx.billVerification.create({
          data: {
            projectId, billId: input.billId, versionId: triple.versionId,
            verdict: triple.verdict, exceptions: triple.exceptions,
            verifiedById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });

        const moved: VendorBillStatus = triple.verdict === 'matched' ? 'verified' : 'disputed';
        if (triple.verdict === 'matched') {
          await this.cas(tx, projectId, input.billId, 'under-verification', 'verified', null);
        } else {
          await this.cas(
            tx, projectId, input.billId, 'under-verification', 'disputed',
            `verification-exception: ${triple.exceptions.join(', ')}`,
          );
        }
        // the claim's state as this call LEAVES it — the triple was computed while it was still
        // `under-verification`, and reporting that would describe a bill that no longer exists
        verdict = { ...triple, billStatus: moved };
        // §B (Codex round-1 F1) — a verdict MOVES the claim between the live and non-live billed
        // sets, so it is a headroom mover like every other bill transition. `disputed` leaves the
        // live fold, and leaving the register unevaluated lets the budget READ drop the exposure
        // while the exception stays open — two surfaces built from the same fold disagreeing.
        await this.billService.evaluateHeadsForBill(tx, projectId, { actorId: actor.actorId, role: user.role }, input.billId);
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.bill.verify', entity: 'VendorBill', entityId: input.billId,
        });
        // the VERDICT is this command's result, not the bill. `executeCommand` replays `resultRef`
        // verbatim, so a retry can find the exact verdict this execution reached — see the replay
        // below for why the bill is not enough.
        return { resultRef: recorded.id, events: [] };
      },
    });
    // Codex round-1 F5 — a REPLAY skips the closure, so `verdict` is null. Return what the original
    // call CONCLUDED, from the durable record, rather than recomputing: the first call has already
    // moved the bill, and §0's live rule means the refold no longer sees the claim it judged.
    //
    // Codex round-2 — and it is found by the ORIGINAL COMMAND'S result, not by the bill's current
    // version. Scoping to the current version was round-1's fix one level short: verify v1, lose
    // the response, amend to v2, then retry the same key — the lookup would 404 because v2 has no
    // verdict, or worse, return a LATER v2 verdict as though it were the answer to a call made
    // about v1. A replay owes the caller what THAT call concluded.
    if (!verdict) verdict = await this.replayVerdict(projectId, outcome.resultRef!);
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
  private async replayVerdict(projectId: string, verificationId: string): Promise<VerificationDto> {
    const recorded = await this.prisma.billVerification.findFirst({
      where: { projectId, id: verificationId },
    });
    if (!recorded) throw new NotFoundException(`Verification ${verificationId} not found in this project`);
    // the VERDICT is what that call concluded and is replayed verbatim; the STATUS is a fact about
    // now, and a retry after a lost response is exactly when a caller needs to know where the
    // claim actually ended up
    const bill = await this.prisma.vendorBill.findFirst({
      where: { projectId, id: recorded.billId }, select: { status: true },
    });
    return {
      billId: recorded.billId, versionId: recorded.versionId,
      verdict: recorded.verdict as VerificationDto['verdict'],
      lines: [],
      exceptions: recorded.exceptions as VerificationExceptionKind[],
      billStatus: bill!.status as VendorBillStatus,
    };
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────

  /**
   * The §E triple for a claim, DERIVED — which is §E's own opening sentence, and after five
   * rounds it is once again the whole implementation.
   *
   * The history is worth keeping because it is the argument for the code that is now here. Round 3
   * found the read refolding without the claim it was reporting on — §0 excludes a disputed bill
   * from every billed fold, so recomputing read its own tax as ₹0 against a ₹0 cap and answered
   * `matched` over a dispute. The fix was to prefer the RECORDED verdict, which was right about the
   * symptom and wrong about the cause: the defect was that recomputation was broken, not that
   * recomputation was the wrong idea.
   *
   * Round 4 fixed the cause — `computeTriple` now counts the subject claim whenever §0's live rule
   * excludes it — and round 5 found what that left behind: a stored verdict answering for a fold it
   * no longer describes, in the opposite direction. A claim disputed for claiming the whole ₹1,800
   * tax on 50 of 100 units still read `tax-mismatch` after a second live 50-unit claim brought the
   * aggregate inside the pro-rata cap, because the record could only ever be neutralised by a
   * status change.
   *
   * So the branch is REMOVED rather than made two-sided. It existed only to work around the broken
   * recomputation that round 4 repaired, and the alternative — a predicate listing every way a
   * record can go stale — is a set to maintain, which is the root this PR's convergence audit
   * names. Nothing is lost: the recorded verdict is still what the REPLAY returns (a replay owes
   * the caller what THAT call concluded, which is a different question), it is still history in
   * `BillVerification`, and the reason it produced is still on the bill as `disputeReason`.
   */
  async readVerification(projectId: string, billId: string, user: AuthUser): Promise<VerificationDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);
    return this.prisma.$transaction(async (tx) => {
      const bill = await tx.vendorBill.findFirst({
        where: { projectId, id: billId }, select: { vendorId: true, status: true },
      });
      if (!bill) throw new NotFoundException('Vendor bill not found in this project');
      return this.computeTriple(tx, projectId, billId, bill.vendorId, bill.status as VendorBillStatus);
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
