import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  DEDUCTION_TYPES_REQUIRING_REASON,
  ROLE_POLICY,
  type BillDeductionDto,
  type BillDeductionLedgerDto,
  type DeductionType,
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
import { CommercialBillService } from './commercial-bill.service';
import type { RecordDeductionInput, ReleaseDeductionInput } from '../contracts';

const ZERO = new Prisma.Decimal(0);

/**
 * Phase 5 Task 5C (§H) — the DEDUCTION LEDGER.
 *
 * §H's shape in one sentence: **a deduction is a ledger row against a certification, never a column
 * on it**, and the retained balance is a FOLD with no stored column — the Phase-3 §C rule that
 * produced a correct stock model.
 *
 * Two bounds, both re-derived HERE under the bill lock and both sealed at PostgreSQL for whatever
 * bypasses this service:
 *
 * 1. **`NET_PAYABLE` has a floor of zero, and the guard is on the DEDUCTION.** §H is explicit that
 *    it cannot live on the approval instead: positive rows and §G bound 4 together still admit a
 *    ₹150 penalty against a ₹100 certificate, because bound 4 only stops a later APPROVAL from
 *    exceeding a number that has already gone negative. Phase 5 models a deduction as a WITHHOLDING
 *    against a payable — not a receivable — so there is nothing beyond the certificate to withhold
 *    from, and recovering more is a matter for the NEXT certificate.
 * 2. **A release may not exceed the unreleased balance of its own deduction.**
 *
 * And both writes RE-DERIVE the payment status under the same lock. §F names the writers that move
 * any of the three folds, and an insertion moves `NET_PAYABLE` just as surely as a release does:
 * withhold the whole of a ₹100 certificate and nothing remains payable, which §F's table calls
 * `paid`. An implementation that only refused the over-withholding would leave the status at
 * `certified` with no legal row anyone could ever write to advance it, because approval and payment
 * rows are strictly positive.
 */
@Injectable()
export class CommercialDeductionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly deductions: CommercialDeductionQuery,
    // §B's mover rule — a withholding lowers §J's `certified-payable`, so it moves headroom and
    // discharges raise-or-clear through the same public helper certification and verification use.
    private readonly billService: CommercialBillService,
  ) {}

  private assertDeduct(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.deduct'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Withholding money from a certified payable is a pmc surface');
    }
  }

  private assertRelease(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.deduct.release'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Releasing a withholding is a pmc surface');
    }
  }

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The commercial register is a pmc/engineer surface');
    }
  }

  // ── §H — record a withholding ────────────────────────────────────────────────────────────────

  /**
   * WITHHOLD money from a certified payable.
   *
   * The lock order is §0b's, unchanged: readiness, then the BILL, then anything the bill leads to.
   * Every fact this decides on is read INSIDE that order — the live certificate, its existing
   * ledger, and the status the result derives — because the whole point of the floor is that two
   * concurrent withholdings cannot each see room for themselves.
   */
  async record(
    projectId: string, input: RecordDeductionInput, user: AuthUser, idempotencyKey?: string,
  ): Promise<BillDeductionDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertDeduct(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };

    const amount = this.parseAmount(input.amount);
    const type = input.type as DeductionType;
    const reason = this.normalizeReason(input.reason);
    // A `retention` is a contract term and needs no argument; a penalty or an `other` IS a
    // judgement, and one recorded without a reason is append-only evidence nobody can act on.
    if (DEDUCTION_TYPES_REQUIRING_REASON.includes(type) && reason === null) {
      throw new BadRequestException(`A ${type} deduction must carry a reason — it is a judgement, and one nobody can read is not one`);
    }

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'commercial.deduction.record', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        await this.lockBill(tx, projectId, input.billId);

        const position = await this.deductions.positionFor(tx, projectId, input.billId);
        if (!position) {
          throw new ConflictException('This claim has no live certification — a withholding is taken FROM a payable, and an uncertified claim is not one yet');
        }
        // BOUND 1, re-derived under the lock. The remaining balance is NAMED in the refusal: a
        // message that only says "too much" leaves the practice guessing at the number.
        const remaining = position.certifiedAmount.sub(position.withheld);
        if (amount.greaterThan(remaining)) {
          throw new ConflictException(
            `This claim can carry ${remaining.toFixed(2)} more of withholding against its ${position.certifiedAmount.toFixed(2)} certificate — recover the remainder against the NEXT certificate, where the money to withhold exists`,
          );
        }

        const deduction = await tx.billDeduction.create({
          data: {
            projectId, certificateId: position.certificateId, billId: input.billId,
            type, amount, reason,
            recordedById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });

        await this.evaluateHeadroom(tx, projectId, input.billId, actor.actorId, user.role, 'deduction');
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.deduction.record', entity: 'BillDeduction', entityId: deduction.id,
        });
        return { resultRef: deduction.id, events: [] };
      },
    });
    return this.deductionById(projectId, outcome.resultRef!);
  }

  // ── §H — release part of a withholding ───────────────────────────────────────────────────────

  /**
   * GIVE BACK part of a withholding, as its own attributable row.
   *
   * A release is not an undo: the deduction stays as history and this row records who gave the
   * money back and why. §H is explicit that a correction is a release row and never an edit,
   * because a withholding that can be retracted in place is one nobody can audit.
   */
  async release(
    projectId: string, input: ReleaseDeductionInput, user: AuthUser, idempotencyKey?: string,
  ): Promise<BillDeductionDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRelease(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };

    const amount = this.parseAmount(input.amount);
    const reason = this.normalizeReason(input.reason);
    if (reason === null) {
      throw new BadRequestException('A release must carry a reason — it returns withheld money, and an unexplained release is indistinguishable from a mistake');
    }

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'commercial.deduction.release', idempotencyKey, requestHash: hashRequest(input),
      synthesizeKeyWhenAbsent: true,
      run: async (tx, ctx) => {
        await lockProjectReadiness(tx, projectId);
        // the DEDUCTION is reached through its bill, so the bill is locked FIRST — §0b's order,
        // and it is what makes the release bound safe against two concurrent releases
        // located WITHOUT the lock — this only tells us which bill to lock. Every fact decided on
        // is re-read below, inside it.
        const located = await tx.billDeduction.findFirst({
          where: { projectId, id: input.deductionId },
          select: { billId: true },
        });
        if (!located) throw new NotFoundException('Deduction not found in this project');
        await this.lockBill(tx, projectId, located.billId);

        // Codex round 2 — re-read the deduction AND its restatement state INSIDE the lock. The
        // first spelling read `restatedAs` before taking it, so a replacement certification
        // committing in between left this call inserting a release against a row that had just
        // become history: the money is reported released while the live payable still withholds it.
        // Locking then re-reading the released total but not the restatement was checking one half
        // of the same question under the lock and the other half outside it.
        const deduction = await tx.billDeduction.findFirstOrThrow({
          where: { projectId, id: input.deductionId },
          select: { id: true, billId: true, amount: true, certificateId: true, restatedAs: { select: { id: true } } },
        });
        // A row that has already been RE-STATED onto a replacement certificate is closed history:
        // the live withholding is its restatement, and a release recorded here would be stranded on
        // a superseded certificate as evidence of money given back that the live truth denies —
        // the same defect §H describes for a deduction re-stated without its releases, arriving
        // from the other side. Release the live row instead.
        if (deduction.restatedAs.length > 0) {
          throw new ConflictException(
            `This withholding has been re-stated onto a later certificate — release ${deduction.restatedAs[0]!.id}, the row the live payable is folded from, or the money would be given back against a certificate nobody is paying`,
          );
        }

        // the released total, folded under the same lock
        const released = await this.deductions.releasedFor(tx, projectId, deduction.id);
        const remaining = deduction.amount.sub(released);
        if (amount.greaterThan(remaining)) {
          throw new ConflictException(
            `This deduction has ${remaining.toFixed(2)} left to release of the ${deduction.amount.toFixed(2)} it withheld — a release gives back money that was held, and cannot give back more`,
          );
        }

        const row = await tx.billDeductionRelease.create({
          data: {
            projectId, deductionId: deduction.id, amount, reason,
            releasedById: actor.actorId, sourceCommandId: ctx.commandId!,
          },
        });

        await this.evaluateHeadroom(tx, projectId, deduction.billId, actor.actorId, user.role, 'deduction_release');
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.deduction.release', entity: 'BillDeductionRelease', entityId: row.id,
        });
        return { resultRef: deduction.id, events: [] };
      },
    });
    return this.deductionById(projectId, outcome.resultRef!);
  }

  // ── §F — the status is DERIVED, never left stale ─────────────────────────────────────────────

  /**
   * §B — the heads this claim touches are re-evaluated in THIS transaction, because a withholding
   * lowers §J's `certified-payable` and a release raises it again.
   *
   * **It does NOT derive the §F payment status, and that is a scope decision.** §H says the
   * insertion re-derives it; §F derives it from THREE folds and two of them — `APPROVED` and
   * `PAID` — are Task 6's. Deriving from one fold while the others are structurally zero made
   * `paid` reachable at this tree, which required widening three seals unit A wrote when
   * `certified` was terminal, and each widening then needed its own fold-backed guard. The
   * derivation lands in Task 6 beside the rows that supply its other two folds.
   *
   * Until then a deduction moves the money and not the status. That is strictly stricter than the
   * finished rule: no transition exists to be wrong about, and a bill cannot be stranded in a state
   * no legal row can leave, because the rows that would leave it are Task 6's as well.
   */
  private async evaluateHeadroom(
    tx: Prisma.TransactionClient, projectId: string, billId: string, actorId: string, role: string,
    raisedBy: 'deduction' | 'deduction_release',
  ): Promise<void> {
    await this.billService.evaluateHeadsForBill(tx, projectId, { actorId, role }, billId, raisedBy);
  }

  // ── the read ─────────────────────────────────────────────────────────────────────────────────

  /** §H — one claim's ledger and the payable it produces. Every figure is a fold, computed here. */
  async readLedger(projectId: string, billId: string, user: AuthUser): Promise<BillDeductionLedgerDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);

    return this.prisma.$transaction(async (tx) => {
      const bill = await tx.vendorBill.findFirst({ where: { projectId, id: billId }, select: { status: true } });
      if (!bill) throw new NotFoundException('Vendor bill not found in this project');
      const position = await this.deductions.positionFor(tx, projectId, billId);
      const rows = position ? await this.ledgerRows(tx, projectId, position.certificateId) : [];
      return {
        billId,
        certificateId: position?.certificateId ?? null,
        certifiedAmount: position?.certifiedAmount.toFixed(2) ?? null,
        deductions: rows,
        withheld: (position?.withheld ?? ZERO).toFixed(2),
        netPayable: position?.netPayable.toFixed(2) ?? null,
        // the STORED status. §F's derivation is Task 6's (see `evaluateHeadroom`), so reporting a
        // derived value here would be this surface claiming a payment lifecycle the system does
        // not yet run — and a read that is ahead of the writes is how a stale truth gets believed.
        billStatus: bill.status as VendorBillStatus,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  private async ledgerRows(
    tx: Prisma.TransactionClient, projectId: string, certificateId: string,
  ): Promise<BillDeductionDto[]> {
    const rows = await tx.billDeduction.findMany({
      where: { projectId, certificateId },
      orderBy: { recordedAt: 'asc' },
      include: { releases: { orderBy: { releasedAt: 'asc' } } },
    });
    return rows.map((d) => ({
      id: d.id,
      certificateId: d.certificateId,
      billId: d.billId,
      type: d.type as DeductionType,
      amount: d.amount.toFixed(2),
      reason: d.reason,
      recordedAt: d.recordedAt.toISOString(),
      recordedById: d.recordedById,
      unreleased: d.releases.reduce((a, r) => a.sub(r.amount), d.amount).toFixed(2),
      releases: d.releases.map((r) => ({
        id: r.id,
        deductionId: r.deductionId,
        amount: r.amount.toFixed(2),
        reason: r.reason,
        releasedAt: r.releasedAt.toISOString(),
        releasedById: r.releasedById,
      })),
    }));
  }

  private async deductionById(projectId: string, deductionId: string): Promise<BillDeductionDto> {
    const row = await this.prisma.billDeduction.findFirst({
      where: { projectId, id: deductionId }, select: { certificateId: true },
    });
    if (!row) throw new NotFoundException('Deduction not found in this project');
    const rows = await this.ledgerRows(this.prisma, projectId, row.certificateId);
    return rows.find((d) => d.id === deductionId)!;
  }

  // ── helpers ──────────────────────────────────────────────────────────────────────────────────

  /**
   * §A — money arrives as a decimal STRING and is parsed EXACTLY. §0b's sign constraint is checked
   * here as well as at PostgreSQL: the row TYPE carries direction, so a negative amount encodes
   * direction twice and the two encodings disagree — a −10 retention would RAISE a ₹100 certificate
   * to ₹110, a deduction that pays out more, sealed append-only.
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
      throw new BadRequestException('An amount is strictly positive — the row TYPE carries direction, and a negative would encode it twice');
    }
    if (amount.decimalPlaces() > 2) {
      throw new BadRequestException(`${raw} is finer than the paisa this ledger records`);
    }
    return amount;
  }

  /** The complete non-blank discipline — presence is not justification. */
  private normalizeReason(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null;
    // the same ASCII whitespace set the DB CHECKs use (`btrim` alone let whitespace through, the
    // Phase-4 Task 5 finding)
    const trimmed = raw.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/gu, '');
    return trimmed === '' ? null : trimmed;
  }

  /** §0b — the BILL is taken FIRST, before any foreign row, so the lock order stays total. */
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
}
