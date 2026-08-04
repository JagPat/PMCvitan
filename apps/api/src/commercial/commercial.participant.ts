import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLE_POLICY } from '@vitan/shared';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { InventoryQuery } from '../inventory/inventory.query';
import { CommercialBudgetService, type HeadroomMover } from './commercial-budget.service';
import { CommercialBillService } from './commercial-bill.service';
import { CommercialMeasurementQuery } from './commercial-measurement.query';

/** The acting identity a lifecycle site passes in; the participant never re-derives it. */
export interface AttributionActor {
  readonly actorId: string;
  readonly role: string;
}

/** ONE attribution target. The XOR is a PG CHECK; this type makes it unrepresentable in TS too. */
export type AttributionTarget = { poLineId: string } | { labourPoLineId: string };

/**
 * One head a deferred act touched, WITH the label describing what actually moved it.
 *
 * The label travels with the head rather than being supplied once per act (Codex round-4 P2). A PO
 * amendment can re-size some lines and RECLASSIFY others in the same call, so a single act-level
 * label would necessarily be wrong for one of them — and `raisedBy` is the durable explanation a
 * human reads months later, not a debug tag.
 */
export interface HeadroomTouch {
  readonly code: string;
  readonly raisedBy: HeadroomMover;
}

/**
 * Phase 5 Task 1 — the COMMERCIAL workflow participant (plan §C/§K).
 *
 * §C: "a live PO line can never be unattributed", and that has to hold from the FIRST INSTANT
 * the line is live. A PO version becomes live at `pos.issue` (and at labour PO issue), so if
 * the first attribution were a separate commercial command, every newly issued order would be a
 * live unattributed obligation until someone ran it — `COMMITTED(costHead)` reading ₹0 for a
 * real ₹100 order, the budget exception never firing and the cash forecast short by the whole
 * amount. So the initial attribution is written HERE, inside the issuing transaction, and all
 * four lifecycle sites (issue · amend · cancel · close-short) — material AND labour, eight sites
 * in total — go through this one channel. §0b's closure row is the acceptance criterion.
 *
 * Procurement and Labour therefore declare `commercial` in their `workflowParticipants`. Neither
 * is a `dependsOn` edge: nobody READS commercial, which is what makes it a SINK, and participant
 * channels are cycle-exempt (the cleared `activities → labour`, `media → inventory` precedent).
 *
 * AUTHORITY FOLLOWS THE WRITE, NOT THE ROUTE (§C, probe 5ar). This participant enforces
 * `commercial.attribute` on the ACTING actor exactly as the standalone re-attribution route
 * does — otherwise a user holding PO-issue authority but not `commercial.attribute` chooses the
 * cost head during `pos.issue` and mutates budget evidence through a side door.
 */
@Injectable()
export class CommercialParticipant {
  constructor(
    private readonly capabilities: CapabilitiesService,
    private readonly budget: CommercialBudgetService,
    private readonly inventory: InventoryQuery,
    private readonly bills: CommercialBillService,
    // Phase 5 Task 5B — the §D/§E row-level floor needs `netOf`, the ONE fold that says what a
    // measurement row still contributes. Injecting the QUERY rather than the write service keeps
    // this participant off the measurement service's participant graph, which would be a cycle.
    private readonly measured: CommercialMeasurementQuery,
  ) {}

  /**
   * §B — every attribution write MOVES HEADROOM, so every one of them re-evaluates the affected
   * head(s) and raises or clears the exception in the SAME transaction. This is the one place
   * that has to be right for all eight PO lifecycle sites at once: they all reach the register
   * through this participant, so evaluating here closes the rule for every site rather than at
   * whichever one a reviewer happens to name.
   *
   * A re-attribution passes BOTH heads — the source can now afford what it could not, and the
   * target may not be able to absorb what it just received.
   *
   * `raisedBy` must describe what ACTUALLY moved. Round 2 found the first half of this — stamping
   * every replacement `'reattribution'` sends a PMC looking for a reclassification that never
   * happened, since amending a ₹90 CIVIL order to ₹120 is a COMMITMENT that grew — and the fix
   * then was to let the CALLER name it. Round 4 found the other half: the caller cannot know
   * either, because one amend can re-size some lines and reclassify others. So the label is DERIVED
   * per row, from whether that row's head actually changed.
   */
  private async evaluateHeads(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    heads: readonly string[],
    raisedBy: HeadroomMover,
  ): Promise<void> {
    await this.budget.evaluate(tx, projectId, actor.actorId, heads, raisedBy);
  }

  /**
   * DEFERRAL (Codex round-3 P2). A single lifecycle act sometimes needs SEVERAL of the mutations
   * above, and evaluating after each one reads a state that never existed at commit.
   *
   * The amend is the case that proves it. `replaceOnAmend` carries lines forward, attributes the
   * fresh ones, then releases the dropped ones. Evaluating after the first step sees only the
   * carried lines — the old version is already non-live and the new lines are not attributed yet —
   * so a ₹120 two-line breach amended to a different ₹120 two-line order momentarily reads ₹60,
   * CLEARS the exception, and the next step re-raises it. The register is APPEND-ONLY, so that
   * clear/re-raise pair is permanent evidence of a headroom recovery that never happened.
   *
   * When a caller passes a sink, the touched heads accumulate into it and NOTHING is evaluated;
   * the caller evaluates once, over the union, when every mutation of that act is applied. Passing
   * no sink evaluates immediately, which is right for a single-mutation act — so the default stays
   * the safe one and only a multi-step caller has to opt in.
   */
  private async evaluate(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    touches: readonly HeadroomTouch[],
    defer?: HeadroomTouch[],
  ): Promise<void> {
    if (defer) {
      defer.push(...touches);
      return;
    }
    await this.settle(tx, projectId, actor, touches);
  }

  /** Settle a deferred act: evaluate the union of every head its mutations touched, ONCE. */
  async evaluateDeferred(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    touches: readonly HeadroomTouch[],
  ): Promise<void> {
    await this.settle(tx, projectId, actor, touches);
  }

  /**
   * Evaluate each touched head ONCE, under the label that best explains why it moved.
   *
   * A head can be touched twice in one act — re-sized on one line and reclassified on another — and
   * only one row can be raised for it (one OPEN exception per head is a partial unique). Where the
   * two disagree, `reattribution` wins: it is the more specific claim, and it is the one a PMC
   * cannot reconstruct from the PO alone. A wrong-but-plausible label is worse than a vague one,
   * because the register is append-only and nobody can correct it later.
   */
  private async settle(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    touches: readonly HeadroomTouch[],
  ): Promise<void> {
    const labelOf = new Map<string, HeadroomMover>();
    for (const touch of touches) {
      const existing = labelOf.get(touch.code);
      if (existing === 'reattribution') continue;
      labelOf.set(touch.code, touch.raisedBy);
    }
    const byLabel = new Map<HeadroomMover, string[]>();
    for (const [code, raisedBy] of labelOf) {
      const bucket = byLabel.get(raisedBy);
      if (bucket) bucket.push(code);
      else byLabel.set(raisedBy, [code]);
    }
    for (const [raisedBy, codes] of byLabel) {
      await this.evaluateHeads(tx, projectId, actor, codes, raisedBy);
    }
  }

  /**
   * §B — RE-EVALUATE the head carrying one PO line (material OR labour), because writes OUTSIDE
   * the attribution lifecycle can move headroom too.
   *
   * Which ones is not a judgement call: it is derivable from what the fold READS. `positionsFor`
   * consumes `receivedQty` and `ACCEPTED` on the material side and `committedQty` on the labour
   * side, so every write that changes one of those changes exposure. Codex round 2 found the
   * acceptance case, round 3 found the other three (receipt progress, receipt reversal, labour
   * capacity default) — the same root each time, which is why the closure is now derived from the
   * fold's input set rather than from a hand-kept list of sites. See
   * `commercial.contract.test.ts` and `docs/reviews/pr-270-convergence.md`.
   *
   * Up to the ordered quantity, acceptance is exposure-NEUTRAL, and the arithmetic says why:
   * `committedAmountBase = rate × qty + tax + freight`, so the consumed part subtracted from
   * `COMMITTED` is exactly the value added to received-not-billed. The buckets hand the money to
   * each other and the total does not move. OVERAGE breaks that symmetry, legitimately: §G
   * authorises accepting more than `qty`, the extra units are valued at the frozen rate, and
   * nothing releases a matching commitment. A closed-short line moves for a different reason —
   * its released remainder is a function of `receivedQty` (material) or `committedQty` (labour),
   * so a later receipt reversal or capacity default silently changes the released amount.
   *
   * The head is resolved from commercial's OWN attribution register: the calling module knows the
   * PO line, never the cost head, so nothing outside this module has to learn the mapping.
   */
  async evaluateForTarget(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    target: AttributionTarget,
    raisedBy: HeadroomMover,
  ): Promise<void> {
    const active = await this.activeFor(tx, projectId, target);
    // an UNATTRIBUTED line carries no head to evaluate — nothing moved that a budget can measure
    if (!active) return;
    await this.evaluateHeads(tx, projectId, actor, [active.costHeadCode], raisedBy);
  }

  /**
   * Phase 5 Task 3 (§D/§E) — WITHDRAWAL GUARD, activities side. `revertSignOff` asks this BEFORE
   * moving a signed-off activity back to `in_progress`.
   *
   * A measurement is immutable and rests on a closing sign-off. If a rejected closing inspection
   * could withdraw that sign-off freely, the measurement would stand against work the practice no
   * longer says is complete — and from Task 4 a bill rests on it, from Task 5 an append-only
   * certificate. §K assigns this guard to §E, but §D is where the fact it guards first EXISTS, so
   * it ships here: the alternative is two tasks in which a rejection silently strands a live
   * measurement with nothing to adjudicate it.
   *
   * The ordering it enforces is the same one §E requires for accepted material: withdraw the
   * evidence by CORRECTING the measurement to zero first (an attributable signed delta), then
   * revert the sign-off. Refusing is not obstruction — it is insisting the evidence trail be
   * unwound in the order it was built.
   *
   * Off-pilot this is a no-op, so a non-commercial project's closing-inspection rejection behaves
   * byte-for-byte as it did before Phase 5.
   */
  async assertWorkEvidenceRevisable(
    tx: Prisma.TransactionClient,
    projectId: string,
    activityId: string,
  ): Promise<void> {
    if (!(await this.isActive(tx, projectId))) return;
    // Phase 5 Task 5B (§E) — the CERTIFICATE arm, ahead of the measurement arm. The two refuse for
    // different reasons and the certificate's is stronger: a live certificate is money someone may
    // approve, and §E's operator path is to supersede it FIRST. Reporting "correct the measurements
    // to zero" while a certificate rests on them would send an operator down a route the
    // measurement floor below then refuses — a true message that is the wrong instruction.
    const onActivity = await tx.measurement.findMany({
      where: { projectId, activityId }, select: { id: true },
    });
    if (onActivity.length > 0) {
      const certified = await tx.certifiedMeasurementConsumption.findMany({
        where: {
          projectId,
          measurementId: { in: onActivity.map((m) => m.id) },
          certificate: { is: { supersededAt: null } },
        },
        select: { certificateId: true },
      });
      if (certified.length > 0) {
        const names = [...new Set(certified.map((c) => c.certificateId))].sort().join(', ');
        throw new ConflictException(
          `This activity's sign-off carries measured work frozen under live certificate(s) ${names} — `
          + 'supersede the certification first, then withdraw the sign-off: a certificate cannot be left '
          + 'payable against work whose sign-off no longer stands',
        );
      }
    }
    // MEASURED per line, folded from the signed rows — a line corrected back to zero no longer
    // rests on this sign-off and must not block the revert.
    const rows = await tx.measurement.findMany({
      where: { projectId, activityId },
      select: { labourPoLineId: true, quantity: true },
    });
    if (rows.length === 0) return;
    const byLine = new Map<string, Prisma.Decimal>();
    for (const r of rows) {
      byLine.set(r.labourPoLineId, (byLine.get(r.labourPoLineId) ?? new Prisma.Decimal(0)).add(r.quantity));
    }
    const live = [...byLine.entries()].filter(([, total]) => total.greaterThan(0));
    if (live.length === 0) return;
    const named = live.map(([lineId, total]) => `${lineId} (${total.toString()} person-shifts)`).join(', ');
    throw new ConflictException(
      `This activity's sign-off carries live measurements — ${named}. Correct them to zero first, ` +
      'then withdraw the sign-off: measured work may not be left resting on evidence that no longer stands',
    );
  }

  /**
   * Phase 5 Task 3 (§D/§G) — WITHDRAWAL GUARD, labour side. The labour close-short and amend paths
   * ask this before REDUCING a line's ordered person-shifts.
   *
   * §D lets Task 3 record immutable measurements that consume ordered authority before any bill
   * exists. Measure 100 shifts on a 100-shift labour PO, then close short to 40, and the ordered
   * cap moves underneath measurements that were valid when taken — Task 4 would then dispute the
   * vendor's honest 100-shift claim against an authority reduced after the work was measured.
   *
   * The certification lock cannot cover this: it serializes a BILL against the ordered line, and
   * here there is no bill yet. So the floor is the measured quantity itself, named in the refusal,
   * and closing short TO the measured quantity or above is permitted — the practice may still end
   * an obligation, just not below work it has already agreed happened.
   */
  async assertOrderedNotBelowMeasured(
    tx: Prisma.TransactionClient,
    projectId: string,
    lines: ReadonlyArray<{ labourPoLineId: string; orderedPersonShiftQty: number }>,
  ): Promise<void> {
    if (lines.length === 0) return;
    if (!(await this.isActive(tx, projectId))) return;
    const rows = await tx.measurement.findMany({
      where: { projectId, labourPoLineId: { in: lines.map((l) => l.labourPoLineId) } },
      select: { labourPoLineId: true, quantity: true },
    });
    if (rows.length === 0) return;
    const measured = new Map<string, Prisma.Decimal>();
    for (const r of rows) {
      measured.set(r.labourPoLineId, (measured.get(r.labourPoLineId) ?? new Prisma.Decimal(0)).add(r.quantity));
    }
    for (const line of lines) {
      const total = measured.get(line.labourPoLineId);
      if (!total) continue;
      if (new Prisma.Decimal(line.orderedPersonShiftQty).lessThan(total)) {
        throw new ConflictException(
          `Line ${line.labourPoLineId} already carries ${total.toString()} measured person-shifts — ` +
          `the ordered quantity cannot be reduced to ${line.orderedPersonShiftQty}. Close short to ` +
          'the measured quantity or above, or correct the measurement first',
        );
      }
    }
  }

  /**
   * Phase 5 Task 4 (§E/§G/§K) — WITHDRAWAL GUARD, INVENTORY side. `stock.reverse` asks this when
   * it withdraws ACCEPTED material, so a live claim can never be left standing above the evidence
   * behind it.
   *
   * §K assigns this guard to §E, and it ships HERE for the reason the plan's own task table
   * gives: Task 4 is the task that first creates a LIVE bill, so it is the first tree in which
   * accept 100 → bill 100 → reverse the acceptance can leave `BILLED_QTY = 100 > ACCEPTED = 0`.
   * A guard that arrived with §E would leave a whole task in which that state is reachable.
   *
   * The disposition is a DISPUTE, not a refusal, and the difference is the whole design. §E
   * refuses only against a live CERTIFICATE — money someone has already authorised — while an
   * uncertified claim is disputed and returned for correction. Refusing every reversal under any
   * live claim would block the store from correcting its own record on the strength of a bill
   * nobody has verified.
   *
   * **At the Task-4 tree there is no certificate, so no refusal arm can be written yet** — the
   * `certified` status is unreachable until Task 5 ships the §E verdict and the certificate it
   * produces. What ships here is the half that is real now: the aggregate dispute. Task 5 adds
   * the refusal in front of it, against the certificate table it introduces.
   *
   * Off-pilot this is a no-op, so a non-commercial project's reversal behaves byte-for-byte as it
   * did before Phase 5.
   */
  async assertAcceptanceReversible(
    tx: Prisma.TransactionClient,
    projectId: string,
    poLineId: string,
    actor: AttributionActor,
  ): Promise<void> {
    if (!(await this.isActive(tx, projectId))) return;
    // Phase 5 Task 5B (§E) — the REFUSAL arm, AHEAD of the dispute. Task 4 shipped only the
    // dispute because `certified` was unreachable; the certificate now exists, so the two-sided
    // rule §E states is complete: REFUSE when money is committed, DISPUTE when only a claim is.
    //
    // It fires FIRST and the order is load-bearing. Running the dispute first would move live
    // uncertified claims out of the fold — attributable, append-only transitions — and only then
    // discover the reversal is refused, leaving vendors disputed by a call that did not happen.
    await this.assertNoCertifiedAcceptance(tx, projectId, poLineId);
    // read the evidence AFTER the reversal row is appended — the guard is about the state the
    // transaction is about to commit, not the one it started from
    const accepted = (await this.inventory.acceptedFor(tx, projectId, [poLineId])).get(poLineId) ?? new Prisma.Decimal(0);
    await this.bills.disputeClaimsBeyondEvidence(
      tx, projectId, 'material', poLineId, accepted,
      `qty-over-accepted: an acceptance on purchase-order line ${poLineId} was reversed, leaving ${accepted.toString()} base units of accepted evidence`,
      actor,
    );
  }

  /**
   * Phase 5 Task 5B (§E) — the REFUSAL half of the acceptance guard: an acceptance row may not be
   * taken below what a LIVE certificate has frozen as its consumed quantity.
   *
   * Row-level, not aggregate, and §E is explicit about why both halves of the pair are needed.
   * Aggregate-only lets the evidence be SWAPPED: certify 100 against acceptance A recorded by
   * store user X, accept another 100 as row B by user Y, then reverse A — the total is still 100
   * so an aggregate check passes, and the payable certificate now rests on different rows, by a
   * different actor, than the §E triple and the §I SoD rule ever evaluated. Identity-only is the
   * opposite failure: it would refuse a legitimate reversal of the unused 20 on a 100-unit row an
   * 80-unit certificate rests on, even though `ACCEPTED` would stay at 80 and the certificate
   * would be intact.
   *
   * The operator path is in the refusal: supersede the certificate first (and, from Task 6,
   * reverse the payment where money moved), then reverse the acceptance. This is
   * `assertMediaDisposable` applied to money — evidence a payable fact rests on cannot be
   * withdrawn while that fact stands.
   */
  private async assertNoCertifiedAcceptance(
    tx: Prisma.TransactionClient,
    projectId: string,
    poLineId: string,
  ): Promise<void> {
    // the state the transaction is ABOUT TO COMMIT: the reversal row is already appended, so a
    // row that still covers its consumed quantity here is one this reversal did not break
    const available = new Map(
      (await this.inventory.acceptedPerRow(tx, projectId, poLineId)).map((r) => [r.id, r.available]),
    );
    if (available.size === 0) return;
    const consumed = await tx.certifiedAcceptanceConsumption.findMany({
      where: {
        projectId,
        stockTransactionId: { in: [...available.keys()] },
        certificate: { is: { supersededAt: null } },
      },
      select: { stockTransactionId: true, consumedQty: true, certificateId: true },
    });
    if (consumed.length === 0) return;
    const byRow = new Map<string, { total: Prisma.Decimal; certificateId: string }>();
    for (const c of consumed) {
      const seen = byRow.get(c.stockTransactionId);
      byRow.set(c.stockTransactionId, {
        total: (seen?.total ?? new Prisma.Decimal(0)).add(c.consumedQty),
        certificateId: seen?.certificateId ?? c.certificateId,
      });
    }
    for (const [rowId, { total, certificateId }] of [...byRow.entries()].sort()) {
      const left = available.get(rowId) ?? new Prisma.Decimal(0);
      if (left.greaterThanOrEqualTo(total)) continue;
      throw new ConflictException(
        `Acceptance ${rowId} carries ${total.toString()} base units frozen under live certificate ${certificateId}, `
        + `and this reversal would leave ${left.toString()}. Supersede that certificate first, then reverse the acceptance: `
        + 'evidence a payable fact rests on cannot be withdrawn while that fact stands',
      );
    }
  }

  /**
   * Phase 5 Task 4 (§D/§G) — WITHDRAWAL GUARD, MEASUREMENT side. The measurement correction path
   * asks this after appending a REDUCING delta.
   *
   * The task table is explicit about why it belongs here rather than with the measurement:
   * "Task 3 ships the signed-delta correction route while no `BILLED_QTY` row can exist, so its
   * guard has only the zero floor; the §D live-claim floor has to ship HERE or measure 100 → bill
   * 100 live → correct −50 leaves `BILLED_QTY = 100 > MEASURED = 50`." Same rule, both sites
   * (§0b) — this is the exact twin of the acceptance guard above, in person-shifts.
   */
  async assertMeasurementWithdrawable(
    tx: Prisma.TransactionClient,
    projectId: string,
    labourPoLineId: string,
    measured: Prisma.Decimal,
    actor: AttributionActor,
    /** Phase 5 Task 5B — the ORIGINAL row this correction walks back, for the row-level floor. */
    correctsId?: string,
  ): Promise<void> {
    if (!(await this.isActive(tx, projectId))) return;
    // Phase 5 Task 5B (§D/§E) — the ROW-LEVEL certificate floor, which `certifiedBilledQtyFor`'s
    // own docblock named as Task 5's remaining half and which the aggregate cannot express.
    //
    // §E: "measure 100 by actor A, certify, add a second 100 by actor B, then correct −100, and
    // the fold still covers the bill while the certificate now rests on different rows, by a
    // different actor, than the §E triple and the §I SoD rule ever evaluated." The aggregate is
    // 100 either way; only the frozen `(measurementId, consumedQty)` pair sees the swap.
    if (correctsId) await this.assertNoCertifiedMeasurement(tx, projectId, correctsId);
    await this.bills.disputeClaimsBeyondEvidence(
      tx, projectId, 'labour', labourPoLineId, measured,
      `qty-over-accepted: measured work on labour purchase-order line ${labourPoLineId} was corrected down to ${measured.toString()} person-shifts`,
      actor,
    );
  }

  /**
   * Phase 5 Task 5B (§D/§E) — the labour twin of `assertNoCertifiedAcceptance`: an original
   * measurement row may not be taken below what a LIVE certificate has frozen against it.
   *
   * Asked with the correction already appended, so `netOf` is the post-correction quantity — the
   * state this transaction is committing, exactly as the acceptance arm reads the post-reversal
   * available. The correction is refused; the certificate is what has to move first.
   */
  private async assertNoCertifiedMeasurement(
    tx: Prisma.TransactionClient,
    projectId: string,
    measurementId: string,
  ): Promise<void> {
    const frozen = await tx.certifiedMeasurementConsumption.findMany({
      where: { projectId, measurementId, certificate: { is: { supersededAt: null } } },
      select: { consumedQty: true, certificateId: true },
      orderBy: { certificateId: 'asc' },
    });
    if (frozen.length === 0) return;
    const consumed = frozen.reduce((a, r) => a.add(r.consumedQty), new Prisma.Decimal(0));
    const net = await this.measured.netOf(tx, projectId, measurementId);
    if (net.greaterThanOrEqualTo(consumed)) return;
    throw new ConflictException(
      `Measurement ${measurementId} carries ${consumed.toString()} person-shifts frozen under live certificate `
      + `${frozen[0].certificateId}, and this correction would leave ${net.toString()}. Supersede that certificate `
      + 'first, then correct the measurement: evidence a payable fact rests on cannot be withdrawn while that fact stands',
    );
  }

  /**
   * Phase 5 Task 4, Codex round-1 F1 (§G) — WITHDRAWAL GUARD, ORDERED side.
   *
   * §0b's closure row names three withdrawal paths: acceptance reversal, sign-off revert and
   * measurement correction. It does not name PO amend/cancel, and the first head read that list as
   * exhaustive — but cancelling or amending a purchase order withdraws the ORDERED side of bound 1
   * exactly as a reversal withdraws the accepted side of bound 2. The service disputes
   * `order-not-live` at SUBMISSION; nothing re-evaluated a claim submitted BEFORE the cancel, so a
   * live claim stood against an order nobody owes.
   *
   * A dead line authorises NOTHING, so the whole live claim on it goes — `evidence = 0` disputes
   * every one. This runs from `replaceAttribution` and `releaseAttribution`, which is the ONE
   * channel all eight material and labour lifecycle sites already reach, so closing it here closes
   * it for every site at once rather than at whichever one a reviewer happens to name (§0b).
   *
   * It is not optional politeness: the deferred DB seal now re-checks bound 1 when a PO version
   * leaves its live set, so an amend or cancel that failed to dispose of its claims would abort at
   * commit. Guard and seal are the same rule at two levels, as everywhere else in this task.
   */
  private async withdrawOrderedAuthority(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    target: AttributionTarget,
    reason: string,
  ): Promise<void> {
    if (!(await this.isActive(tx, projectId))) return;
    const kind = 'poLineId' in target ? 'material' : 'labour';
    const poLineId = 'poLineId' in target ? target.poLineId : target.labourPoLineId;
    await this.bills.disputeClaimsBeyondEvidence(
      tx, projectId, kind, poLineId, new Prisma.Decimal(0),
      `order-not-live: purchase-order line ${poLineId} is no longer ordered — ${reason}`,
      actor,
    );
  }

  /** Off-pilot this whole surface does not exist: the caller's transaction is untouched (§D). */
  async isActive(tx: Prisma.TransactionClient, projectId: string): Promise<boolean> {
    return this.capabilities.isEnabled(projectId, COMMERCIAL_CAPABILITY, tx);
  }

  /** §C/§I — the WRITE carries the authority, whichever route reached it. */
  private assertAttributeAuthority(actor: AttributionActor): void {
    if (!(ROLE_POLICY['commercial.attribute'] as readonly string[]).includes(actor.role)) {
      throw new ForbiddenException(
        'Attributing a vendor commitment to a cost head requires `commercial.attribute` — issuing a purchase order does not confer it',
      );
    }
  }

  private where(projectId: string, target: AttributionTarget): Prisma.CommitmentAttributionWhereInput {
    return 'poLineId' in target
      ? { projectId, poLineId: target.poLineId, supersededAt: null }
      : { projectId, labourPoLineId: target.labourPoLineId, supersededAt: null };
  }

  private async activeFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    target: AttributionTarget,
  ): Promise<{ id: string; costHeadCode: string } | null> {
    return tx.commitmentAttribution.findFirst({
      where: this.where(projectId, target),
      select: { id: true, costHeadCode: true },
    });
  }

  private async assertCostHead(tx: Prisma.TransactionClient, projectId: string, code: string): Promise<void> {
    const head = await tx.costHead.findUnique({ where: { projectId_code: { projectId, code } }, select: { code: true } });
    if (!head) {
      throw new ConflictException(
        `Cost head "${code}" is not defined in this project — define it before attributing a commitment to it`,
      );
    }
  }

  /**
   * ISSUE — write the initial active attribution for each line of a version that is becoming
   * live, in the issuing transaction. Idempotent under command replay: a line that already
   * carries an ACTIVE attribution to the SAME head is left alone (the partial unique would
   * otherwise turn a replay into a 500), while a different head is a caller error, not a silent
   * re-attribution — reclassification is `reattribute`, which leaves evidence.
   */
  async attribute(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    rows: ReadonlyArray<{ target: AttributionTarget; costHeadCode: string; reason: string }>,
    defer?: HeadroomTouch[],
  ): Promise<void> {
    if (rows.length === 0) return;
    this.assertAttributeAuthority(actor);
    for (const row of rows) {
      await this.assertCostHead(tx, projectId, row.costHeadCode);
      const active = await this.activeFor(tx, projectId, row.target);
      if (active) {
        if (active.costHeadCode === row.costHeadCode) continue;
        throw new ConflictException(
          `This commitment is already attributed to "${active.costHeadCode}" — re-attribute it explicitly so the reclassification leaves evidence`,
        );
      }
      await tx.commitmentAttribution.create({
        data: {
          projectId,
          ...('poLineId' in row.target ? { poLineId: row.target.poLineId } : { labourPoLineId: row.target.labourPoLineId }),
          costHeadCode: row.costHeadCode,
          reason: row.reason,
          createdById: actor.actorId,
        },
      });
    }
    // a newly live line is new obligation on its head — always a COMMITMENT, never a move
    await this.evaluate(tx, projectId, actor, rows.map((r) => ({ code: r.costHeadCode, raisedBy: 'commitment' as const })), defer);
  }

  /**
   * AMEND / CLOSE-SHORT — an ATOMIC REPLACEMENT: supersede each `from` line's active attribution
   * and insert the replacement for its `to` line, in ONE transaction. §C: a bare revocation would
   * drop a live vendor obligation out of every budget and forecast, so there is no "release and
   * attribute later" path.
   *
   * An amendment retains v1's line and issues v2's, so BOTH attributions would otherwise stay
   * active and the committed total would read ₹200 for a ₹100 order. Passing v1's line as `from`
   * and v2's as `to` is what keeps exactly one live. A close-short passes the SAME line on both
   * sides: the obligation changed size, and superseding-then-reinserting records that
   * attributably instead of leaving a stamp-free row behind a changed amount.
   *
   * A `from` line with no active attribution is NOT an error — the capability may have been
   * enabled after that version was issued, or the line may already have been released. The
   * replacement is still written, because the invariant is about the LIVE line.
   */
  async replaceAttribution(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    rows: ReadonlyArray<{ from: AttributionTarget; to: AttributionTarget; costHeadCode?: string; reason: string }>,
    defer?: HeadroomTouch[],
  ): Promise<void> {
    if (rows.length === 0) return;
    this.assertAttributeAuthority(actor);
    const touched: HeadroomTouch[] = [];
    for (const row of rows) {
      const active = await this.activeFor(tx, projectId, row.from);
      const code = row.costHeadCode ?? active?.costHeadCode;
      if (!code) {
        throw new ConflictException(
          'This commitment carries no attribution to carry forward — supply the cost head that will hold the amended obligation',
        );
      }
      await this.assertCostHead(tx, projectId, code);
      if (active) await this.supersede(tx, projectId, actor, active.id, row.reason);
      await tx.commitmentAttribution.create({
        data: {
          projectId,
          ...('poLineId' in row.to ? { poLineId: row.to.poLineId } : { labourPoLineId: row.to.labourPoLineId }),
          costHeadCode: code,
          reason: row.reason,
          createdById: actor.actorId,
        },
      });
      // DERIVED, not supplied (Codex round-4 P2): if this row's head actually CHANGED, the money
      // was reclassified — say so. If it did not, the same head simply carries a different amount,
      // which is a COMMITMENT that moved. The caller cannot decide this for the whole call, because
      // ONE amend can do both on different lines.
      // Codex round-1 F1 — an AMEND retires the `from` line and issues the `to` line, so a live
      // claim against the retired one now names an order that authorises nothing. A CLOSE-SHORT
      // passes the SAME line on both sides — the version stays live and the frozen ordered
      // quantity does not move — so nothing is withdrawn there.
      const retired = 'poLineId' in row.from
        ? !('poLineId' in row.to && row.to.poLineId === row.from.poLineId)
        : !('labourPoLineId' in row.to && row.to.labourPoLineId === row.from.labourPoLineId);
      if (retired) await this.withdrawOrderedAuthority(tx, projectId, actor, row.from, row.reason);
      const reclassified = Boolean(active) && active!.costHeadCode !== code;
      const raisedBy: HeadroomMover = reclassified ? 'reattribution' : 'commitment';
      touched.push({ code, raisedBy });
      // §B: a replacement recomputes BOTH the source and the target. Only recomputing the target
      // leaves the source permanently flagged for an obligation it no longer carries.
      if (active) touched.push({ code: active.costHeadCode, raisedBy });
    }
    await this.evaluate(tx, projectId, actor, touched, defer);
  }

  /**
   * CANCEL — supersede without replacement. This is the ONE site where that is correct, and it
   * is not the "revocable to nothing" §C forbids: a cancelled version is no longer live, so the
   * obligation it carried no longer exists. Leaving the attribution active would make `COMMITTED`
   * report a commitment against an order nobody owes.
   */
  async releaseAttribution(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    targets: ReadonlyArray<AttributionTarget>,
    reason: string,
    defer?: HeadroomTouch[],
  ): Promise<void> {
    if (targets.length === 0) return;
    this.assertAttributeAuthority(actor);
    const touched: HeadroomTouch[] = [];
    for (const target of targets) {
      // Codex round-1 F1 — a cancelled version orders nothing, so every live claim against its
      // lines is disputed here. This runs even when the line carries NO attribution: the claim
      // exists independently of which cost head was carrying the money.
      await this.withdrawOrderedAuthority(tx, projectId, actor, target, reason);
      const active = await this.activeFor(tx, projectId, target);
      if (active) {
        await this.supersede(tx, projectId, actor, active.id, reason);
        // a cancelled obligation frees headroom — the exception it caused must CLEAR, or the Inbox
        // keeps an action for a breach that no longer exists. Nothing was reclassified.
        touched.push({ code: active.costHeadCode, raisedBy: 'commitment' });
      }
    }
    await this.evaluate(tx, projectId, actor, touched, defer);
  }

  /**
   * The ONE permitted UPDATE, guarded as a CAS on `supersededAt IS NULL`. The database refuses a
   * second stamp too (the append-only trigger), but a 409 is the honest answer to a concurrent
   * lifecycle command racing this one — a raw trigger error is a 500.
   */
  private async supersede(
    tx: Prisma.TransactionClient,
    projectId: string,
    actor: AttributionActor,
    id: string,
    reason: string,
  ): Promise<void> {
    const { count } = await tx.commitmentAttribution.updateMany({
      where: { id, projectId, supersededAt: null },
      data: { supersededAt: new Date(), supersededById: actor.actorId, supersedeReason: reason },
    });
    if (count === 0) {
      throw new ConflictException('This attribution was superseded concurrently — reload and retry');
    }
  }

  /**
   * Codex round-4 P2 — refuse deleting a photo cited as MEASUREMENT evidence, invoked BY the owning
   * media module's delete transaction (the cleared inventory / labour-attendance / activity-output
   * pattern). Task 3 gave the measurement an `evidenceMediaId` FK but no guard here, so deleting a
   * cited photo raised a raw `P2003` and returned a 500 — an internal error where every other
   * evidence-backed fact returns a controlled refusal.
   *
   * A measurement is FULLY immutable and becomes a payable quantity, so this is the strictest case
   * of the rule the other three already state: the photo backing a number somebody will be paid
   * against cannot quietly disappear from under it.
   */
  async assertMediaDisposable(tx: Prisma.TransactionClient, projectId: string, mediaId: string): Promise<void> {
    const cited = await tx.measurement.count({ where: { projectId, evidenceMediaId: mediaId } });
    if (cited > 0) {
      throw new ConflictException(
        `This photo is evidence on ${cited} measurement(s) — a measurement is immutable and becomes a payable quantity, so its evidence cannot be deleted (§D)`,
      );
    }
  }
}
