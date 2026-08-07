import { PrismaService } from '../prisma.service';
import { CapabilitiesService, COMMERCIAL_CAPABILITY } from '../platform/capabilities.service';
import { CommercialBudgetQuery } from './commercial-budget.query';
import { CommercialBudgetService } from './commercial-budget.service';
import { CommercialMeasurementQuery } from './commercial-measurement.query';
import { CommercialBillQuery } from './commercial-bill.query';
import { CommercialDeductionQuery } from './commercial-deduction.query';
import { CommercialPaymentQuery } from './commercial-payment.query';
import { ProcurementQuery } from '../procurement/procurement.query';
import { LabourRequirementQuery } from '../labour/labour.query';
import { InventoryQuery } from '../inventory/inventory.query';
import { bindCashForecastDeps } from './cash-forecast.projection';
import { recordAudit } from '../platform/audit';
import { systemActor } from '../common/actor';
import { lockProjectReadiness } from '../common/readiness-lock';
import { OrgsParticipant } from '../orgs/orgs.participant';

/**
 * Phase 5 Task 7A — the OPERATOR RE-EVALUATION SWEEP (§B/§J), and why an upgrade needs one.
 *
 *   pnpm --filter api commercial:reevaluate --operator <userId> --reason "<release>: §J partition"
 *
 * Task 7A completes §J's partition, and completing it CHANGES THE ANSWER for data that already
 * exists. Exposure gains `approved` (= `APPROVED − PAID`) and `paid` (= `PAID`), which together add
 * back exactly the `APPROVED` that `certified-payable` subtracts — so every head carrying an
 * approval reads a higher exposure than it did the day before the deploy.
 *
 * That is the correct reading: **money a practice has authorised is money it still owes.** But the
 * `BudgetException` register is an append-only OBSERVATION written by whichever write moved
 * headroom, and no write moved. A head with budget 50, a 100 certificate and a 60 approval was
 * breached, had its exception CLEARED by 6A's code when the approval "healed" it, and now reads
 * `headroom = -50` with nothing open — so the Inbox misses a live breach until some unrelated write
 * happens to touch that head. Which could be never.
 *
 * A migration cannot repair it: the fold spans procurement, inventory, labour and four commercial
 * folds, and none of that is expressible in the SQL a migration can run. So the repair is this
 * sweep, and it is deliberately shaped like the operator rebuild next to it in the runbook:
 *
 *   - IDEMPOTENT. `evaluate` raises at most one open exception per head (a partial unique) and
 *     clears one that no longer breaches, so running twice changes nothing the first run did not.
 *     A run on a healthy database is a no-op that writes no exception rows at all.
 *   - ATTRIBUTABLE. The invocation is audited before any work, and every raise or clear carries
 *     `raisedBy = 'fold_correction'` — a label that says the DEFINITION of exposure changed, rather
 *     than borrowing one of the ten labels that name a site write. §B has had a mover wearing
 *     another act's label three times this phase; this is not the fourth.
 *   - COMPLETE. It sweeps every cost head of every commercial-enabled project, derived from the
 *     capability rows rather than from a list an operator has to assemble.
 *
 * It also refreshes the §J cash forecast for every project it touches, because `evaluate` does —
 * which is the other half of what a post-7A deploy needs.
 */

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith('--')) { out[a.slice(2)] = argv[i + 1] ?? ''; i++; }
  }
  return out;
}

/** Build the budget service with its real collaborator graph — all pure read folds over the tx. */
export function buildBudgetService(prisma: PrismaService): CommercialBudgetService {
  const bills = new CommercialBillQuery();
  const deductions = new CommercialDeductionQuery(bills);
  const query = new CommercialBudgetQuery(
    new ProcurementQuery(prisma),
    new LabourRequirementQuery(prisma),
    new InventoryQuery(prisma),
    new CommercialMeasurementQuery(),
    bills,
    deductions,
    new CommercialPaymentQuery(deductions),
  );
  // the refresh inside `evaluate` needs these bound, exactly as boot and the rebuild CLI do
  bindCashForecastDeps({ budget: query });
  return new CommercialBudgetService(prisma, new CapabilitiesService(prisma), query);
}

export interface ReevaluateReport {
  projects: number;
  heads: number;
  raised: number;
  cleared: number;
}

/**
 * Re-evaluate every head of every commercial-enabled project. Returns what MOVED, counted from the
 * register before and after rather than from what the sweep believes it did — an operator reading
 * "raised: 3" needs that to be three rows they can go and look at.
 */
export async function reevaluateAll(
  prisma: PrismaService, budget: CommercialBudgetService, operator: { userId: string; reason: string },
): Promise<ReevaluateReport> {
  const enabled = await prisma.projectCapability.findMany({
    where: { capability: COMMERCIAL_CAPABILITY }, select: { projectId: true }, orderBy: { projectId: 'asc' },
  });
  const report: ReevaluateReport = { projects: 0, heads: 0, raised: 0, cleared: 0 };

  for (const { projectId } of enabled) {
    const heads = await prisma.costHead.findMany({
      where: { projectId }, select: { code: true }, orderBy: { code: 'asc' },
    });
    if (heads.length === 0) continue;
    report.projects += 1;
    report.heads += heads.length;

    // ONE transaction per project: the fold must see a single consistent picture of that project's
    // money, and a per-head transaction would let a concurrent write split the sweep's own view.
    // Per-PROJECT rather than one global transaction because a sweep that holds every project's
    // rows for its whole duration would block the sites it is repairing for.
    const moved = await prisma.$transaction(async (tx) => {
      // Codex round-2 (P2). The sweep is a HEADROOM MOVER like any other, and §B's rule is that
      // every one of them takes the project readiness lock first. Without it this fold is torn: the
      // sweep reads a head's ₹50 budget, a concurrent `commercial.budget.set` raises it to ₹500 and
      // commits, and the sweep then writes a `fold_correction` breach against a budget that no
      // longer exists — leaving the Inbox showing a breach the live read says is healthy, which is
      // the precise disagreement §B's same-transaction rule exists to prevent. An upgrade repair
      // that can corrupt the register it is repairing is worse than no repair.
      await lockProjectReadiness(tx, projectId);

      // Codex round-2 (P2) — the OPEN ROW IDS, not a count. Net before/after totals report
      // `raised: 0, cleared: 0` when one project both reopens a stale cleared breach and clears a
      // stale open one: two durable rows changed and the operator is told nothing happened. The
      // first spelling of this function claimed in its own comment to count "from the register
      // rather than from what the sweep believes it did", and counting the wrong thing from the
      // register is not better than believing.
      const idsBefore = new Set((await tx.budgetException.findMany({
        where: { projectId, clearedAt: null }, select: { id: true },
      })).map((e) => e.id));

      await budget.evaluate(tx, projectId, operator.userId, heads.map((h) => h.code), 'fold_correction');

      const idsAfter = new Set((await tx.budgetException.findMany({
        where: { projectId, clearedAt: null }, select: { id: true },
      })).map((e) => e.id));
      const raised = [...idsAfter].filter((id) => !idsBefore.has(id)).length;
      const cleared = [...idsBefore].filter((id) => !idsAfter.has(id)).length;

      await recordAudit(tx, {
        projectId,
        actor: systemActor(operator.userId, operator.userId, 'operator'),
        action: 'commercial.reevaluate',
        entity: 'BudgetException',
        entityId: `${projectId}:fold_correction`,
        // Codex round-2 (P2) — the REASON is persisted. The CLI demands `--reason` and the first
        // spelling then discarded it, so every reopened exception said only `fold_correction` plus
        // an operator id: nothing distinguished the mandated §J upgrade repair from an accidental
        // rerun, months later, to the person who has to decide whether the breach is real. A
        // required flag that is thrown away is a required flag that lies about being required.
        payload: { reason: operator.reason, heads: heads.length, raised, cleared },
      });
      return { raised, cleared };
    });
    report.raised += moved.raised;
    report.cleared += moved.cleared;
  }
  return report;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  if (!f.operator || !f.reason) {
    process.stderr.write('usage: commercial:reevaluate --operator <userId> --reason <text>\n');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  try {
    // Codex round-3 (P2) — IDENTITY IS ORGS' QUESTION, not a `User` row this module reads.
    //
    // The first spelling read `prisma.user` directly. That is a cross-module read the boundary
    // analyzer cannot see (this is a CLI file), and it quietly re-decides a question orgs owns:
    // whether an email resolves, whether a disabled or merged account still does, what precedence
    // an id-vs-email collision has. `OrgsParticipant.resolveUserIdentity` exists precisely so those
    // rules "change once rather than in every module that happens to accept an operator string" —
    // and the §L activation path beside this one already routes through it.
    //
    // The stakes are durable: this sweep stamps `BudgetException.raisedById` and audit rows. An
    // identity the owning module would reject must not end up on an append-only observation.
    const actor = await new OrgsParticipant().resolveUserIdentity(prisma, f.operator);
    if (!actor) {
      // the exception rows carry a real `raisedById` FK, so an unresolvable operator must fail
      // BEFORE any work rather than half-way through the sweep
      process.stderr.write(`commercial:reevaluate: --operator ${f.operator} does not resolve to a user\n`);
      process.exitCode = 2;
      return;
    }
    const report = await reevaluateAll(prisma, buildBudgetService(prisma), { userId: actor.id, reason: f.reason });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`commercial:reevaluate: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.env.NODE_ENV !== 'test') void main();
