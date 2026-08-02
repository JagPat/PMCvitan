import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROLE_POLICY } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import type { AuthUser } from '../common/auth';
import { executeCommand, hashRequest, type CommandScope } from '../platform/commands';
import { resolveActor } from '../common/actor';
import { recordAudit } from '../platform/audit';
import { lockProjectReadiness } from '../common/readiness-lock';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { CommercialBudgetQuery } from './commercial-budget.query';
import type { SetBudgetInput } from '../contracts';

/** §B names exactly three writes that can move headroom; the DB CHECK pins the same set. */
export type HeadroomMover = 'commitment' | 'budget_revision' | 'reattribution';

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
            headroom: position!.headroom!,
            budget: position!.budget!,
            // recorded so `headroom = budget - exposure` holds on the row itself (DB CHECK)
            exposure: position!.budget!.sub(position!.headroom!),
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
