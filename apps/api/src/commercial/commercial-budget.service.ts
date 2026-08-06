import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ROLE_POLICY,
  type BudgetExceptionDto,
  type CommercialBudgetDto,
  type CostHeadPositionDto,
} from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import { recordAudit } from '../platform/audit';
import { lockProjectReadiness } from '../common/readiness-lock';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { CommercialBudgetQuery } from './commercial-budget.query';
import type { SetBudgetInput } from '../contracts';

/**
 * §B's rule is "the exception is raised from EVERY write that can move headroom". The section
 * NAMES three — a commitment, a budget revision, a re-attribution — because those were the writes
 * that existed when it was written. Two more belong to the same rule rather than extending it,
 * and each is named separately so the durable row explains ITSELF:
 *
 * - `acceptance` — §G authorises accepting more than the ordered quantity, §J values the overage
 *   at the frozen rate, and no commitment is released against it, so the receipt raises exposure.
 * - `receipt_progress` — recording, rejecting or reversing a receipt moves `receivedQty`, which is
 *   what a CLOSED-SHORT line's released remainder is computed from. Nothing was accepted, so
 *   labelling it `acceptance` would send a PMC looking for a delivery that never happened.
 * - `measurement` — measured person-shifts are the labour CONSUMPTION term (§D/Task 3). As the
 *   arithmetic stands this mover is exposure-NEUTRAL and can never actually raise: measurement is
 *   hard-capped at the ordered `personShiftQty`, so consumed can never exceed
 *   `committedAmountBase` and the money only changes bucket. It is wired and labelled anyway,
 *   because the closure's rule is mechanical — every writer of a fold input evaluates — and
 *   carving out an exception on the strength of my own arithmetic is what went wrong twice in
 *   Task 2. If labour ever gains an overage path, the mover is already correct.
 *
 * `raisedBy` is the durable explanation a human reads months later, so it must describe what
 * ACTUALLY moved — never merely which code path noticed. That is why `replaceAttribution` DERIVES
 * its label from whether the head changed rather than accepting one from its caller (Codex round-4
 * P2): the same method serves a PO amendment and a reclassification, and only the data can say
 * which one happened.
 *
 * The DB CHECK on `BudgetException.raisedBy` pins exactly this set.
 */
export type HeadroomMover =
  // Phase 5 Task 4 (Codex round-3) — a live CLAIM moves exposure. Wiring `BILLED_AMOUNT` into the
  // position is what made it a mover: an over-rate claim (the §E rate check is Task 5's) carries
  // more exposure than the received value it draws on, so §B's "every write that can move headroom
  // raises or clears the exception in the SAME transaction" now covers the bill lifecycle too.
  | 'claim'
  // Phase 5 Task 5C (§H) — a WITHHOLDING lowers §J `certified-payable` and a RELEASE raises it
  // again, so both move headroom. They are named separately rather than folded into `claim`
  // because `raisedBy` is the durable explanation a human reads months later and must describe
  // what ACTUALLY moved: a release-raised exception labelled `claim` sends a PMC hunting for a
  // vendor claim that never changed. Codex found exactly that, and it is the third time this
  // phase has found a mover wearing another act's label.
  | 'deduction'
  | 'deduction_release'
  // Phase 5 Task 6A (§I/§J) — an APPROVAL lowers `certified-payable` (§J defines the bucket as
  // `NET_PAYABLE − APPROVED`), so authorising money is a headroom mover with no procurement or
  // certification write anywhere. Codex round 2 (P2) found it: the fold was taught to subtract
  // `APPROVED` and the write was not made a mover, so an approval that healed a head's exposure
  // left the old `BudgetException` open and the budget read went on reporting a breach nobody
  // could clear. It is named separately, not folded into `claim`, for the reason `raisedBy` exists
  // at all: an approval-cleared exception labelled `claim` sends a PMC hunting a vendor claim that
  // never changed.
  | 'payment_approval'
  | 'commitment'
  | 'budget_revision'
  | 'reattribution'
  | 'acceptance'
  | 'receipt_progress'
  | 'measurement';

/**
 * Phase 5 Task 2 (§B) — the BUDGET write path and the over-budget EXCEPTION.
 *
 * A budget line does not gate anything. Exceeding it produces a flagged exception and an Inbox
 * action; it never blocks a PO, because stopping site supply over a planning number is the wrong
 * failure mode. Whether an over-budget commitment needs stronger authority is a §I approval-limit
 * decision, not a hard block — and §I lands in Tasks 5–6.
 */
@Injectable()
export class CommercialBudgetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: CapabilitiesService,
    private readonly budget: CommercialBudgetQuery,
  ) {}

  private assertManage(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.budget.manage'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('Setting a budget is a pmc surface');
    }
  }

  private assertRead(user: AuthUser): void {
    if (!(ROLE_POLICY['commercial.read'] as readonly string[]).includes(user.role)) {
      throw new ForbiddenException('The commercial register is a pmc/engineer surface');
    }
  }

  /**
   * §B/§J — the `commercial.budget` read: every cost head's BUDGET, its outstanding COMMITTED
   * exposure, the received-not-billed value, the resulting headroom, and the OPEN exception if
   * one stands.
   *
   * Folded inside ONE **repeatable-read** transaction because the position spans four owners
   * (commercial's budget and attribution rows, procurement's and labour's frozen PO-line snapshots,
   * inventory's accepted ledger). The isolation level is load-bearing, not decoration (Codex
   * round-3 P2): under PostgreSQL's default READ COMMITTED each STATEMENT takes its own snapshot,
   * so a PO issue committing between the fold and the exception read returns healthy headroom
   * alongside the freshly opened exception for that same head — a page that contradicts itself and
   * that nobody can reconcile against the register. One snapshot makes every figure in the response
   * true at one instant.
   *
   * The read does NOT take `lockProjectReadiness`. It reports; it decides nothing. Blocking every
   * budget page-load behind the lock that serializes the PO lifecycle would make reporting contend
   * with the site's own writes, and a read that is one commit stale is honest — a read that
   * delayed a purchase order would not be.
   *
   * Sorted worst-first: breaches at the top, then thinning headroom, then unbudgeted heads. That
   * is the order the practice needs to act in, and it makes the top of the list the same set the
   * Inbox action counts.
   */
  async readBudget(projectId: string, user: AuthUser): Promise<CommercialBudgetDto> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertRead(user);

    const { positions, names, open } = await this.prisma.$transaction(async (tx) => {
      const heads = await tx.costHead.findMany({
        where: { projectId },
        select: { code: true, name: true },
        orderBy: { code: 'asc' },
      });
      const codes = heads.map((h) => h.code);
      const [folded, liveVersions, exceptions] = await Promise.all([
        this.budget.positionsFor(tx, projectId, codes),
        tx.budgetLine.findMany({
          where: { projectId, supersededAt: null },
          select: { costHeadCode: true, version: true },
        }),
        tx.budgetException.findMany({
          where: { projectId, clearedAt: null },
          orderBy: { raisedAt: 'asc' },
        }),
      ]);
      return {
        positions: { folded, versionOf: new Map(liveVersions.map((v) => [v.costHeadCode, v.version])) },
        names: new Map(heads.map((h) => [h.code, h.name])),
        open: exceptions,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

    const exceptionOf = new Map(open.map((e) => [e.costHeadCode, serializeException(e)]));
    const rows: CostHeadPositionDto[] = [...positions.folded.values()].map((p) => ({
      costHeadCode: p.costHeadCode,
      costHeadName: names.get(p.costHeadCode) ?? p.costHeadCode,
      budget: p.budget?.toFixed(2) ?? null,
      budgetVersion: positions.versionOf.get(p.costHeadCode) ?? null,
      committed: p.committed.toFixed(2),
      receivedNotBilled: p.receivedNotBilled.toFixed(2),
      awaitingCertification: p.awaitingCertification.toFixed(2),
      certifiedPayable: p.certifiedPayable.toFixed(2),
      headroom: p.headroom?.toFixed(2) ?? null,
      exception: exceptionOf.get(p.costHeadCode) ?? null,
    }));
    rows.sort((a, b) => {
      // unbudgeted heads have no headroom to rank and sort last, by code
      if (a.headroom === null || b.headroom === null) {
        if (a.headroom === b.headroom) return a.costHeadCode.localeCompare(b.costHeadCode);
        return a.headroom === null ? 1 : -1;
      }
      const cmp = new Prisma.Decimal(a.headroom).comparedTo(new Prisma.Decimal(b.headroom));
      return cmp !== 0 ? cmp : a.costHeadCode.localeCompare(b.costHeadCode);
    });
    return { positions: rows, openExceptions: open.length };
  }

  /**
   * §B — set the budget for one cost head. v1 and a revision are the SAME act on a versioned
   * immutable chain: the live row is superseded and the next version inserted atomically, never
   * edited. Splitting "create" from "revise" would let a caller open a second live version for a
   * head that already has one, which the partial unique refuses anyway — better to have one
   * command that cannot express the mistake.
   */
  async setBudget(projectId: string, input: SetBudgetInput, user: AuthUser, idempotencyKey?: string): Promise<{
    costHeadCode: string; amount: string; version: number;
  }> {
    await this.capabilities.assertEnabled(projectId, COMMERCIAL_CAPABILITY);
    this.assertManage(user);
    const actor = await resolveActor(this.prisma, user);
    const scope: CommandScope = { scopeKind: 'project', projectId };
    const amount = new Prisma.Decimal(input.amount);

    const outcome = await executeCommand(this.prisma, {
      scope, actor, commandType: 'commercial.budget.set', idempotencyKey, requestHash: hashRequest(input),
      run: async (tx) => {
        // The budget is one of the three headroom-moving writes, so it serializes with the PO
        // lifecycle exactly as the attribution writes do — the exception it raises is computed
        // from commitment facts that must not move underneath it.
        await lockProjectReadiness(tx, projectId);

        const head = await tx.costHead.findUnique({
          where: { projectId_code: { projectId, code: input.costHeadCode } },
          select: { code: true },
        });
        if (!head) {
          throw new ForbiddenException(
            `Cost head "${input.costHeadCode}" is not defined in this project — define it before budgeting to it`,
          );
        }

        const live = await tx.budgetLine.findFirst({
          where: { projectId, costHeadCode: input.costHeadCode, supersededAt: null },
          select: { id: true, version: true, amount: true },
        });
        // A no-op revision is not a revision: appending an identical version would add a row that
        // says nothing happened, and every later reader has to skip it.
        if (live && live.amount.equals(amount)) {
          return { resultRef: live.id, events: [] };
        }
        if (live) {
          const { count } = await tx.budgetLine.updateMany({
            where: { id: live.id, projectId, supersededAt: null },
            data: { supersededAt: new Date(), supersededById: actor.actorId, supersedeReason: input.reason },
          });
          if (count === 0) throw new ForbiddenException('This budget was revised concurrently — reload and retry');
        }
        const next = await tx.budgetLine.create({
          data: {
            projectId,
            costHeadCode: input.costHeadCode,
            amount,
            version: (live?.version ?? 0) + 1,
            reason: input.reason,
            createdById: actor.actorId,
          },
        });
        await recordAudit(tx, {
          projectId, actor, action: 'commercial.budget.set',
          entity: 'BudgetLine', entityId: next.id,
        });
        // §B — the exception is raised (or cleared) IN THE SAME TRANSACTION as the write that
        // moved headroom. Revising a live ₹100 budget down to ₹50 against a ₹90 attributed PO
        // produces −₹40 with NO commitment write anywhere; a commitment-triggered exception would
        // never fire and the practice would learn nothing.
        await this.evaluate(tx, projectId, actor.actorId, [input.costHeadCode], 'budget_revision');
        return { resultRef: next.id, events: [] };
      },
    });

    const row = await this.prisma.budgetLine.findFirstOrThrow({ where: { projectId, id: outcome.resultRef } });
    return { costHeadCode: row.costHeadCode, amount: row.amount.toString(), version: row.version };
  }

  /**
   * §B — recompute the affected cost head(s) and RAISE OR CLEAR the exception, in the caller's
   * transaction. Every write that can move headroom calls this: the budget revision above, the
   * re-attribution (which passes BOTH the source and the target head), and the PO lifecycle hooks
   * through `CommercialParticipant`.
   *
   * Idempotent by construction: one OPEN exception per head is a partial unique, so a second
   * breach on an already-excepted head does not stack a duplicate Inbox action, and a head that
   * returns to non-negative headroom has its open row cleared.
   */
  async evaluate(
    tx: Prisma.TransactionClient,
    projectId: string,
    actorId: string,
    costHeadCodes: readonly string[],
    raisedBy: HeadroomMover,
  ): Promise<void> {
    const heads = [...new Set(costHeadCodes)].filter((c) => c.length > 0);
    if (heads.length === 0) return;
    const positions = await this.budget.positionsFor(tx, projectId, heads);
    const open = await tx.budgetException.findMany({
      where: { projectId, costHeadCode: { in: heads }, clearedAt: null },
      select: { id: true, costHeadCode: true },
    });
    const openOf = new Map(open.map((e) => [e.costHeadCode, e.id]));

    for (const code of heads) {
      const position = positions.get(code);
      // An UNBUDGETED head has no authority to breach — there is nothing to be over. That is not
      // the same as headroom zero, and treating it as such would flag every commitment on a
      // project that has not budgeted yet.
      const breached = position?.headroom != null && position.headroom.isNegative();
      const existing = openOf.get(code);

      if (breached && !existing) {
        await tx.budgetException.create({
          data: {
            projectId,
            costHeadCode: code,
            // Codex round-2 P2 — all three figures come from the fold ALREADY at the persisted
            // `Decimal(18,2)` money scale, and `headroom` was derived from this exact `exposure`.
            // So `headroom < 0` and `headroom = budget - exposure` both hold at PostgreSQL by
            // construction; nothing here can be silently re-rounded on the way in.
            headroom: position!.headroom!,
            budget: position!.budget!,
            exposure: position!.exposure,
            raisedBy,
            raisedById: actorId,
          },
        });
      } else if (!breached && existing) {
        // the ONE permitted transition on an open row
        await tx.budgetException.updateMany({
          where: { id: existing, projectId, clearedAt: null },
          data: { clearedAt: new Date() },
        });
      }
    }
  }
}

function serializeException(r: {
  id: string; costHeadCode: string; headroom: Prisma.Decimal; budget: Prisma.Decimal; exposure: Prisma.Decimal;
  raisedBy: string; raisedAt: Date; raisedById: string; clearedAt: Date | null;
}): BudgetExceptionDto {
  return {
    id: r.id,
    costHeadCode: r.costHeadCode,
    headroom: r.headroom.toFixed(2),
    budget: r.budget.toFixed(2),
    exposure: r.exposure.toFixed(2),
    // the DB CHECK pins the same three-value set, so the cast reflects a constraint, not a hope
    raisedBy: r.raisedBy as BudgetExceptionDto['raisedBy'],
    raisedAt: r.raisedAt.toISOString(),
    raisedById: r.raisedById,
    clearedAt: r.clearedAt?.toISOString() ?? null,
  };
}
