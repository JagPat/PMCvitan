import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ROLE_POLICY, isLiveBillStatus,
  type VendorBillDto, type VendorBillLineDto, type VendorBillListDto, type VendorBillStatus,
  type VendorBillVersionDto,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import { recordAudit } from '../platform/audit';
import { lockProjectReadiness } from '../common/readiness-lock';
import { fromIsoCivilDate, toIsoCivilDate } from '../common/civil-date';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { ProcurementParticipant } from '../procurement/procurement.participant';
import { LabourRequirementParticipant } from '../labour/labour.participant';
import { InventoryQuery } from '../inventory/inventory.query';
import { CommercialBillQuery } from './commercial-bill.query';
import { CommercialMeasurementQuery } from './commercial-measurement.query';
import type {
  AmendVendorBillInput, RecordVendorBillInput, RejectVendorBillInput, VendorBillStepInput,
} from '../contracts';

const ZERO = new Prisma.Decimal(0);

/** One claim line as the caller supplied it, resolved to its owning kind. */
type ClaimLine = {
  kind: 'material' | 'labour';
  poLineId: string;
  quantity: Prisma.Decimal;
  rate: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  freightAmount: Prisma.Decimal;
  amount: Prisma.Decimal;
};

/** The §G verdict for ONE purchase-order line the claim touches. */
type BoundVerdict = { poLineId: string; kind: 'material' | 'labour'; breach: string | null };

/**
 * Phase 5 Task 4 (§F/§G) — the VENDOR BILL: what a counterparty says it is owed.
 *
 * A bill is NOT a payable. §G bounds it against operational evidence that Phases 1–4 already made
 * canonical — bound 1 against ordered authority, bound 2 against what actually arrived
 * (`ACCEPTED`) or was measured (`MEASURED`) — and only Task 5's three-way verification and
 * certification can turn a bounded claim into money anyone may approve.
 *
 * **Task 4 stops SHORT of `verified` deliberately.** `verified` is the state whose safety IS the
 * §E verdict, so shipping the transition here while §E lands in Task 5 would let a bill reach it
 * before the ordered/accepted/billed comparison exists — and pulling §E forward would bypass the
 * Task-5 review stop that guards it. A control ships in the task that creates the transition it
 * guards, which is also why BOTH withdrawal guards ship here: this is the task that first creates
 * a LIVE bill, so it is the first tree in which withdrawing evidence can strand a payable claim.
 *
 * **A breach DISPUTES, it does not refuse.** A 101-unit claim against 100 accepted is recorded as
 * a `qty-over-accepted` dispute rather than rejected at submission, because hard-rejecting an
 * over-bound submission destroys the record of what the vendor actually claimed — which is the
 * evidence the dispute is about. §0's LIVE rule then keeps the disputed version out of the billed
 * folds, so nothing certifies against it and the honest corrected claim can still be submitted.
 */
@Injectable()
export class CommercialBillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly procurement: ProcurementParticipant,
    private readonly labour: LabourRequirementParticipant,
    private readonly inventory: InventoryQuery,
    private readonly bills: CommercialBillQuery,
    private readonly measured: CommercialMeasurementQuery,
  ) {}

  private assertBill(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.bill'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Recording a vendor claim is a pmc/engineer surface');
    }
  }

  private assertVerify(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.verify'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Opening verification on a vendor claim is a pmc surface');
    }
  }

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The commercial register is a pmc/engineer surface');
    }
  }

  // ── §G bounds 1 and 2 ────────────────────────────────────────────────────────────────────────

  /**
   * Re-derive bounds 1 and 2 for every purchase-order line a bill's LIVE claim touches, with the
   * constraining row FOR-UPDATE-locked FIRST (§G) through its OWNING module's participant.
   *
   * The lock order is ascending by `(kind, poLineId)` over the whole set, which is what makes a
   * multi-line claim deadlock-free: two claims touching the same two lines from opposite
   * directions would otherwise each hold what the other needs. It is the Phase-4 overlapping-crews
   * discipline applied to money.
   *
   * Each side is a §0 set by name and no filter is restated here: `BILLED_QTY` comes from
   * `CommercialBillQuery`, `ACCEPTED` from `InventoryQuery`, `MEASURED` from
   * `CommercialMeasurementQuery`, and the ordered side from the line's own owner.
   */
  private async evaluateBounds(
    tx: Prisma.TransactionClient,
    projectId: string,
    lines: readonly ClaimLine[],
  ): Promise<BoundVerdict[]> {
    // A space cannot occur in a cuid, so the join is unambiguous — and sorting the JOINED key
    // is what gives every transaction the SAME total order over the rows it will lock.
    const targets = [...new Set(lines.map((l) => `${l.kind} ${l.poLineId}`))].sort();
    const verdicts: BoundVerdict[] = [];
    for (const target of targets) {
      const [kind, poLineId] = target.split(' ') as ['material' | 'labour', string];
      const ordered = kind === 'material'
        ? await this.procurement.lockOrderedLineForClaim(tx, projectId, poLineId)
        : await this.labour.lockOrderedLineForClaim(tx, projectId, poLineId);
      if (!ordered) throw new NotFoundException(`Purchase-order line ${poLineId} not found in this project`);

      const billed = (await this.bills.billedQtyFor(tx, projectId, kind, [poLineId])).get(poLineId) ?? ZERO;
      const evidence = kind === 'material'
        ? (await this.inventory.acceptedFor(tx, projectId, [poLineId])).get(poLineId) ?? ZERO
        : (await this.measured.measuredForPoLines(tx, projectId, [poLineId])).get(poLineId) ?? ZERO;
      const unit = kind === 'material' ? 'base units' : 'person-shifts';

      // A dead order authorises nothing. This is not a §G bound but the precondition both bounds
      // rest on: a cancelled or superseded version has no ordered authority to compare against,
      // so "billed ≤ ordered" would be vacuously about a number nobody owes.
      let breach: string | null = null;
      if (!ordered.live) {
        breach = `order-not-live: purchase-order line ${poLineId} belongs to a ${ordered.status} version, which orders nothing`;
      } else if (billed.greaterThan(ordered.ordered)) {
        breach = `qty-over-ordered: ${billed.toString()} ${unit} claimed on line ${poLineId} against an ordered authority of ${ordered.ordered.toString()}`;
      } else if (billed.greaterThan(evidence)) {
        // the §E verdict name §G/probe 4 uses for BOTH sides: material claims over what was
        // ACCEPTED and labour claims over what was MEASURED are the same defect in two units
        breach = `qty-over-accepted: ${billed.toString()} ${unit} claimed on line ${poLineId} against ${evidence.toString()} ${kind === 'material' ? 'accepted' : 'measured'}`;
      }
      verdicts.push({ poLineId, kind, breach });
    }
    return verdicts;
  }

  // ── the withdrawal disposition, shared by both guards ────────────────────────────────────────

  /**
   * §E/§G — EVIDENCE was withdrawn under this purchase-order line. Dispute the minimum number of
   * live claims needed to restore bound 2, NEWEST FIRST, and stop as soon as it holds.
   *
   * Probe 5an is precise about why the disposition is driven by the AGGREGATE fold and not by
   * each claim individually: accept 100, bill 80, reverse 20 leaves that bill LIVE (80 ≤ 80);
   * reverse 30 disputes it. And the case a per-claim rule gets wrong — accept 100, bill 60 AND
   * 40, reverse 20 — has neither claim individually over 80 while the fold is 100, so the newest
   * (40) is disputed and the older (60) is left live, ending at 60 ≤ 80. A path that disputes
   * every claim punishes the vendor whose bill was already fine; a path that tests each claim
   * against `ACCEPTED` never disputes anything and leaves the bound broken.
   *
   * Returns the bills it disputed, so the caller can report them.
   */
  async disputeClaimsBeyondEvidence(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: 'material' | 'labour',
    poLineId: string,
    evidence: Prisma.Decimal,
    reason: string,
  ): Promise<string[]> {
    let billed = (await this.bills.billedQtyFor(tx, projectId, kind, [poLineId])).get(poLineId) ?? ZERO;
    if (billed.lessThanOrEqualTo(evidence)) return [];
    const claims = await this.bills.liveClaimsOn(tx, projectId, kind, poLineId);
    const disputed: string[] = [];
    for (const claim of claims) {
      if (billed.lessThanOrEqualTo(evidence)) break;
      // CAS on the status we believe it holds — a concurrent transition that already took this
      // claim out of the live set must not be double-stamped, and a 0-count is not an error here:
      // the fold below re-reads the truth either way.
      const { count } = await tx.vendorBill.updateMany({
        where: { id: claim.billId, projectId, status: { notIn: ['draft', 'rejected', 'disputed', 'resolved'] } },
        data: { status: 'disputed', statusChangedAt: new Date(), statusReason: reason },
      });
      if (count === 0) continue;
      disputed.push(claim.billId);
      billed = billed.sub(claim.quantity);
    }
    return disputed;
  }

  // ── the commands ─────────────────────────────────────────────────────────────────────────────

  /**
   * §F — RECORD the vendor's claim. It lands at `draft`: the claim exists and is readable, but
   * its lines are not in any billed fold yet, so nothing is bounded and nothing is reserved.
   *
   * Recording and submitting are separate acts because §G's bounds are evaluated at SUBMISSION,
   * and a claim that a clerk is still typing must not hold ordered capacity against other bills.
   */
  async record(projectId: string, input: RecordVendorBillInput, user: AuthUser, idempotencyKey?: string): Promise<VendorBillDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertBill(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const documentDate = fromIsoCivilDate(input.documentDate);
    if (!documentDate) throw new ConflictException(`"${input.documentDate}" is not a civil date`);

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'commercial.bill.record', idempotencyKey, requestHash: hashRequest(input),
      // §C rule ii — `sourceCommandId` is a NOT NULL composite FK, so an unkeyed call reserves a
      // SERVER one-shot command (the cleared Phase-3 inventory precedent). A keyed replay appends
      // nothing.
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        const lines = await this.resolveLines(tx, projectId, input.vendorId, input.lines);
        const bill = await tx.vendorBill.create({
          data: {
            projectId, vendorId: input.vendorId,
            vendorBillNumber: input.vendorBillNumber, documentDate,
            status: 'draft', createdById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        }).catch((e) => this.rethrowDuplicateClaim(e, input.vendorBillNumber));
        await this.writeVersion(tx, projectId, bill.id, input.vendorId, 1, null, actor.actorId, lines);
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.bill.record', entity: 'VendorBill', entityId: bill.id,
        });
        return { resultRef: bill.id, events: [] };
      },
    });
    return this.readOne(projectId, outcome.resultRef!, user);
  }

  /**
   * §F — SUBMIT the recorded claim. This is where §G bounds 1–2 are evaluated, under the ordered
   * line's own lock, and where the claim becomes LIVE — or `disputed` if it exceeds the evidence.
   */
  async submit(projectId: string, input: VendorBillStepInput, user: AuthUser, idempotencyKey?: string): Promise<VendorBillDto> {
    return this.transition(projectId, input.billId, user, idempotencyKey, {
      commandType: 'commercial.bill.submit',
      from: ['draft'],
      to: 'submitted',
      assertAuthority: (u) => this.assertBill(u),
      evaluateBounds: true,
      input,
    });
  }

  /**
   * §F — open the §E three-way check. Task 4 ships only the transition INTO verification; the
   * VERDICT is Task 5's, because `verified` is the state whose safety is that verdict.
   */
  async beginVerification(projectId: string, input: VendorBillStepInput, user: AuthUser, idempotencyKey?: string): Promise<VendorBillDto> {
    return this.transition(projectId, input.billId, user, idempotencyKey, {
      commandType: 'commercial.bill.beginVerification',
      from: ['submitted'],
      to: 'under-verification',
      assertAuthority: (u) => this.assertVerify(u),
      evaluateBounds: false,
      input,
    });
  }

  /**
   * §F — REJECT the claim, with an attributable reason. This is a JUDGEMENT about the claim,
   * which is a different fact from a dispute: a dispute says the claim's EVIDENCE moved.
   *
   * Rejection stops at `verified` (and Task 4 can only reach the first five of that set). A
   * CERTIFIED bill has produced append-only payable facts and §0 removes every `rejected` bill
   * from the billed sets, so rejecting one would free its accepted quantity for a second bill
   * while the certificate that consumed it still stands. Past certification the correction path
   * is a superseding certificate.
   */
  async reject(projectId: string, input: RejectVendorBillInput, user: AuthUser, idempotencyKey?: string): Promise<VendorBillDto> {
    return this.transition(projectId, input.billId, user, idempotencyKey, {
      commandType: 'commercial.bill.reject',
      from: ['draft', 'submitted', 'under-verification', 'disputed', 'verified'],
      to: 'rejected',
      reason: input.reason,
      assertAuthority: (u) => this.assertBill(u),
      evaluateBounds: false,
      input,
    });
  }

  /**
   * §F — AMEND into a NEW version, retaining the prior verbatim with `supersedesVersion` lineage.
   * This is also how a DISPUTED claim is RESOLVED.
   *
   * The admissible set is `submitted`, `verified` and `disputed` — never once a live certificate
   * exists. §0 removes a superseded version from `BILLED_AMOUNT(bill)`, so amending a certified
   * bill would orphan every payable fact resting on it: certify a live ₹100 bill, amend to ₹50,
   * and the ₹100 claim lines are no longer live while the ₹100 certificate, its approval and any
   * payment still stand — the bill simultaneously in breach of bound 3 and payable against a
   * claim that has been withdrawn.
   *
   * A DISPUTED version does not return to live (§0/probe 5av): it is stamped `resolved` — terminal
   * — and the corrected claim enters `submitted` as a new version, where the ordinary bounds
   * apply. Moving the same version back would make a 120-unit claim live again BEFORE the
   * quantity changed, breaking bound 2 and blocking the very correction the dispute exists to
   * enable.
   */
  async amend(projectId: string, input: AmendVendorBillInput, user: AuthUser, idempotencyKey?: string): Promise<VendorBillDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertBill(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };

    await executeCommand(this.prisma, {
      scope, actor, commandType: 'commercial.bill.amend', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, _ctx) => {
        await lockProjectReadiness(tx, projectId);
        const bill = await this.lockBill(tx, projectId, input.billId);
        const AMENDABLE = ['submitted', 'verified', 'disputed'];
        if (!AMENDABLE.includes(bill.status)) {
          throw new ConflictException(
            `A ${bill.status} claim cannot be amended — an amendment is admissible only before certification (${AMENDABLE.join(', ')}), and past it the correction path is a superseding certificate`,
          );
        }
        const resolving = bill.status === 'disputed';
        const lines = await this.resolveLines(tx, projectId, bill.vendorId, input.lines);
        const current = await tx.vendorBillVersion.findFirstOrThrow({
          where: { projectId, billId: bill.id, supersededAt: null },
          select: { id: true, version: true },
        });
        // supersede FIRST, so the retained version leaves the live fold before the new one's
        // lines enter it — otherwise the deferred bound check would see BOTH claims at once and a
        // legitimate v1 100 → v2 100 amendment would read as 200 against 100 accepted
        const { count } = await tx.vendorBillVersion.updateMany({
          where: { id: current.id, projectId, supersededAt: null },
          data: { supersededAt: new Date(), supersededById: actor.actorId, supersedeReason: input.reason },
        });
        if (count === 0) throw new ConflictException('This claim was amended concurrently — reload and retry');
        await this.writeVersion(tx, projectId, bill.id, bill.vendorId, current.version + 1, current.version, actor.actorId, lines);

        // a resolved dispute is TERMINAL; an ordinary amendment keeps the claim where it was,
        // except from `verified`, where a new claim has not been verified and must be re-checked
        const nextStatus: VendorBillStatus = resolving ? 'resolved' : bill.status === 'verified' ? 'submitted' : (bill.status as VendorBillStatus);
        if (resolving) {
          await this.cas(tx, projectId, bill.id, 'disputed', 'resolved', input.reason);
          // the corrected claim is a NEW bill document reusing the same vendor reference: the
          // duplicate-document index has released on `resolved`, which is exactly the release
          // §F's terminal states are for
        } else if (nextStatus !== bill.status) {
          await this.cas(tx, projectId, bill.id, bill.status, nextStatus, null);
        }
        const verdicts = await this.evaluateBounds(tx, projectId, lines);
        const breach = verdicts.find((v) => v.breach)?.breach ?? null;
        if (breach && !resolving) {
          await this.cas(tx, projectId, bill.id, nextStatus, 'disputed', breach);
        }
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.bill.amend', entity: 'VendorBill', entityId: bill.id,
        });
        return { resultRef: bill.id, events: [] };
      },
    });
    return this.readOne(projectId, input.billId, user);
  }

  // ── the shared transition machine ────────────────────────────────────────────────────────────

  private async transition(
    projectId: string,
    billId: string,
    user: AuthUser,
    idempotencyKey: string | undefined,
    opts: {
      commandType: 'commercial.bill.submit' | 'commercial.bill.beginVerification' | 'commercial.bill.reject';
      from: readonly string[];
      to: VendorBillStatus;
      reason?: string;
      assertAuthority: (u: AuthUser) => void;
      evaluateBounds: boolean;
      input: unknown;
    },
  ): Promise<VendorBillDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    opts.assertAuthority(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };

    await executeCommand(this.prisma, {
      scope, actor, commandType: opts.commandType, idempotencyKey, requestHash: hashRequest(opts.input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, _ctx) => {
        await lockProjectReadiness(tx, projectId);
        const bill = await this.lockBill(tx, projectId, billId);
        if (!opts.from.includes(bill.status)) {
          throw new ConflictException(
            `A ${bill.status} claim cannot move to ${opts.to} — this transition applies to ${opts.from.join(', ')}`,
          );
        }
        await this.cas(tx, projectId, billId, bill.status, opts.to, opts.reason ?? null);

        if (opts.evaluateBounds) {
          const version = await tx.vendorBillVersion.findFirstOrThrow({
            where: { projectId, billId, supersededAt: null },
            include: { lines: true },
          });
          const lines: ClaimLine[] = version.lines.map((l) => ({
            kind: l.type as 'material' | 'labour',
            poLineId: (l.poLineId ?? l.labourPoLineId)!,
            quantity: l.quantity, rate: l.rate,
            taxAmount: l.taxAmount, freightAmount: l.freightAmount, amount: l.amount,
          }));
          const verdicts = await this.evaluateBounds(tx, projectId, lines);
          const breach = verdicts.find((v) => v.breach)?.breach ?? null;
          if (breach) {
            // §G/probe 4 — the claim is DISPUTED, never refused: hard-rejecting an over-bound
            // submission destroys the record of what the vendor actually claimed, which is the
            // evidence the dispute is about. §0's LIVE rule keeps it out of the folds, so nothing
            // certifies against it and the honest corrected claim can still be submitted.
            await this.cas(tx, projectId, billId, opts.to, 'disputed', breach);
          }
        }
        await recordAudit(tx, { projectId, actor, action: opts.commandType, entity: 'VendorBill', entityId: billId });
        return { resultRef: billId, events: [] };
      },
    });
    return this.readOne(projectId, billId, user);
  }

  /**
   * Every transition is a CAS `updateMany(id, projectId, expectedStatus)` — a deterministic 409
   * on a concurrent second attempt, the Phase-3/4 machine. The PG lifecycle trigger refuses an
   * illegal arrow too; this returns the honest 409 rather than letting a raw trigger error
   * surface as a 500.
   */
  private async cas(
    tx: Prisma.TransactionClient, projectId: string, billId: string,
    from: string, to: VendorBillStatus, reason: string | null,
  ): Promise<void> {
    const { count } = await tx.vendorBill.updateMany({
      where: { id: billId, projectId, status: from },
      data: { status: to, statusChangedAt: new Date(), ...(reason !== null ? { statusReason: reason } : {}) },
    });
    if (count === 0) {
      throw new ConflictException('This claim moved concurrently — reload and retry');
    }
  }

  /**
   * §0b — "a status a guard depends on is read under that row's lock", and the BILL is taken
   * FIRST, before any foreign row, so the order stays total and deadlock-free. Without it, a
   * transition could read `submitted`, a concurrent amend could supersede the version, and the
   * transition would then commit against a claim that no longer exists in the shape it read.
   */
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

  // ── writing a version ────────────────────────────────────────────────────────────────────────

  /**
   * Resolve the caller's lines to their owning kind, refusing anything the FKs would reject with
   * a raw constraint error. The composite FK is still the AUTHORITY on vendor pinning — this
   * returns a controlled 4xx for the cases a request can plainly get wrong.
   */
  private async resolveLines(
    tx: Prisma.TransactionClient,
    projectId: string,
    vendorId: string,
    input: RecordVendorBillInput['lines'],
  ): Promise<ClaimLine[]> {
    const out: ClaimLine[] = [];
    for (const l of input) {
      const kind: 'material' | 'labour' = l.poLineId ? 'material' : 'labour';
      const poLineId = (l.poLineId ?? l.labourPoLineId)!;
      const quantity = new Prisma.Decimal(l.quantity);
      const rate = new Prisma.Decimal(l.rate);
      const taxAmount = new Prisma.Decimal(l.taxAmount ?? '0');
      const freightAmount = new Prisma.Decimal(l.freightAmount ?? '0');
      if (kind === 'labour' && (taxAmount.greaterThan(0) || freightAmount.greaterThan(0))) {
        throw new ConflictException(
          'A labour claim line carries no tax or freight — the labour purchase-order snapshot freezes none, so there would be nothing to verify such a claim against',
        );
      }
      const ordered = kind === 'material'
        ? await this.procurement.lockOrderedLineForClaim(tx, projectId, poLineId)
        : await this.labour.lockOrderedLineForClaim(tx, projectId, poLineId);
      if (!ordered) throw new NotFoundException(`Purchase-order line ${poLineId} not found in this project`);
      if (ordered.vendorId !== vendorId) {
        // the composite FK would refuse this too — this is the readable answer, not the seal
        throw new ConflictException(
          `Purchase-order line ${poLineId} belongs to another vendor — a claim may only draw on its own counterparty's orders`,
        );
      }
      out.push({
        kind, poLineId, quantity, rate, taxAmount, freightAmount,
        // §A — half-up at 2 decimals, applied only where the value is PERSISTED. The DB CHECK
        // re-derives exactly this, so a hand-written amount can never enter the fold.
        amount: rate.mul(quantity).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).add(taxAmount).add(freightAmount),
      });
    }
    return out;
  }

  private async writeVersion(
    tx: Prisma.TransactionClient,
    projectId: string,
    billId: string,
    vendorId: string,
    version: number,
    supersedesVersion: number | null,
    actorId: string,
    lines: readonly ClaimLine[],
  ): Promise<void> {
    const claimedAmount = lines.reduce((acc, l) => acc.add(l.amount), ZERO);
    const row = await tx.vendorBillVersion.create({
      data: {
        projectId, billId, vendorIdPin: vendorId, version, supersedesVersion,
        claimedAmount, lineCount: lines.length, createdById: actorId,
      },
    });
    for (const l of lines) {
      await tx.vendorBillLine.create({
        data: {
          projectId, versionId: row.id, billId, vendorId, type: l.kind,
          ...(l.kind === 'material' ? { poLineId: l.poLineId } : { labourPoLineId: l.poLineId }),
          quantity: l.quantity, rate: l.rate,
          taxAmount: l.taxAmount, freightAmount: l.freightAmount, amount: l.amount,
        },
      });
    }
  }

  /**
   * §F/probe 5bg — a SECOND live claim under the same `(projectId, vendorId, vendorBillNumber)`
   * is refused by the partial unique index. Two concurrent first submissions therefore admit
   * exactly one, and this turns the index's raw P2002 into the answer an operator can act on.
   */
  private rethrowDuplicateClaim(e: unknown, number: string): never {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new ConflictException(
        `This vendor already has a live claim under document "${number}" — a duplicate claim is refused until the first is rejected or its dispute resolved`,
      );
    }
    throw e;
  }

  // ── reads ────────────────────────────────────────────────────────────────────────────────────

  async list(projectId: string, user: AuthUser): Promise<VendorBillListDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);
    const rows = await this.prisma.vendorBill.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      include: { versions: { orderBy: { version: 'asc' }, include: { lines: { orderBy: { id: 'asc' } } } } },
    });
    return { bills: rows.map((b) => serialize(b)) };
  }

  async readOne(projectId: string, billId: string, user: AuthUser): Promise<VendorBillDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);
    const row = await this.prisma.vendorBill.findFirst({
      where: { projectId, id: billId },
      include: { versions: { orderBy: { version: 'asc' }, include: { lines: { orderBy: { id: 'asc' } } } } },
    });
    if (!row) throw new NotFoundException('Vendor bill not found in this project');
    return serialize(row);
  }
}

type BillRow = Prisma.VendorBillGetPayload<{ include: { versions: { include: { lines: true } } } }>;

function serializeLine(l: BillRow['versions'][number]['lines'][number]): VendorBillLineDto {
  return {
    id: l.id,
    type: l.type as 'material' | 'labour',
    poLineId: l.poLineId,
    labourPoLineId: l.labourPoLineId,
    // §A — decimal STRINGS on the wire. A money value that passes through float64 anywhere,
    // including a read projection, is exactly the corruption the rule exists to prevent.
    quantity: l.quantity.toString(),
    rate: l.rate.toString(),
    taxAmount: l.taxAmount.toString(),
    freightAmount: l.freightAmount.toString(),
    amount: l.amount.toString(),
  };
}

function serialize(b: BillRow): VendorBillDto {
  return {
    id: b.id,
    vendorId: b.vendorId,
    vendorBillNumber: b.vendorBillNumber,
    documentDate: toIsoCivilDate(b.documentDate) ?? '',
    status: b.status as VendorBillStatus,
    statusChangedAt: b.statusChangedAt.toISOString(),
    statusReason: b.statusReason,
    createdAt: b.createdAt.toISOString(),
    createdById: b.createdById,
    versions: b.versions.map<VendorBillVersionDto>((v) => ({
      id: v.id,
      version: v.version,
      supersedesVersion: v.supersedesVersion,
      claimedAmount: v.claimedAmount.toString(),
      lines: v.lines.map(serializeLine),
      createdAt: v.createdAt.toISOString(),
      createdById: v.createdById,
      supersededAt: v.supersededAt?.toISOString() ?? null,
      supersededById: v.supersededById,
      supersedeReason: v.supersedeReason,
      // §0 LIVE, from the ONE shared predicate — a reader never re-derives the status filter
      live: v.supersededAt === null && isLiveBillStatus(b.status),
    })),
  };
}
