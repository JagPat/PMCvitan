import { PrismaService } from '../../prisma.service';
import { registerConsumer, getConsumer } from '../outbox/registry';
import { ProjectionRebuilder } from './rebuilder.service';
import { ProjectionRebuildOperations, REBUILDABLE_PROJECTIONS } from './rebuild-operations';
import { makeDecisionsProjectionConsumer, DECISIONS_PROJECTION } from '../../decisions/decisions.projection';
import { makeDrawingsProjectionConsumer, DRAWINGS_PROJECTION } from '../../drawings/drawings.projection';
import { makeDailyLogProjectionConsumer, DAILY_LOG_PROJECTION } from '../../daily-log/daily-log.projection';
import { makeInspectionsProjectionConsumer, INSPECTIONS_PROJECTION } from '../../inspections/inspections.projection';
import { makeActivitiesProjectionConsumer, ACTIVITIES_PROJECTION } from '../../activities/activities.projection';
import { makeMaterialReadinessProjectionConsumer, bindMaterialReadinessDeps, MATERIAL_READINESS_PROJECTION } from '../../activities/material-readiness.projection';
import { makeLabourReadinessProjectionConsumer, bindLabourReadinessDeps, LABOUR_READINESS_PROJECTION } from '../../labour/labour-readiness.projection';
import { makeCashForecastProjectionConsumer, bindCashForecastDeps, CASH_FORECAST_PROJECTION } from '../../commercial/cash-forecast.projection';
import { LabourCoverageService } from '../../labour/labour-coverage.service';
import { CommercialBudgetQuery } from '../../commercial/commercial-budget.query';
import { CommercialMeasurementQuery } from '../../commercial/commercial-measurement.query';
import { CommercialBillQuery } from '../../commercial/commercial-bill.query';
import { CommercialDeductionQuery } from '../../commercial/commercial-deduction.query';
import { CommercialPaymentQuery } from '../../commercial/commercial-payment.query';
import { ProcurementQuery } from '../../procurement/procurement.query';
import { LabourRequirementQuery } from '../../labour/labour.query';
import { InventoryQuery } from '../../inventory/inventory.query';
import { InventoryService } from '../../inventory/inventory.service';
import { SubstitutionsService } from '../../activities/substitutions.service';
import { ProcurementParticipant } from '../../procurement/procurement.participant';
import { RequirementsQueryService } from '../../activities/requirements.query';

/**
 * Module-4 correction + Task 10 finalization + final-review P1 correction — the operator
 * projection-rebuild command.
 *
 *   pnpm --filter api projection:rebuild --operator <identity> --reason <text> \
 *        [--project <id>] [--consumer <name>]
 *
 * With no `--consumer`, the run covers ALL EIGHT production projection consumers
 * (decisions.inbox, daily-log.inbox, drawings.inbox, inspections.inbox, activities.schedule,
 * activities.material-readiness, labour.readiness, commercial.cash-forecast) —
 * the production upgrade path depends on this default: a legacy `decisions.inbox` generation can
 * hold a non-empty SUBSET of the canonical register while presenting as caught-up, and only a
 * rebuild (or the next decision event) repairs it.
 *
 * Rebuilds the named projections from CANONICAL state through the standard generation-swap +
 * final-activation-barrier protocol, with CHECKPOINT-AWARE before/after diagnostics per
 * (project, consumer): a generation whose checkpoint lags the committed stream head is reported as
 * ordinary LAG (the read path already falls back to live), and only a generation the read path
 * would serve whose stored base differs from the module's own canonical serializer is CORRUPT.
 * The invocation is audited BEFORE work begins and every pair records its own success/failure
 * outcome, so a partial run remains attributable. Exits non-zero when any pair is corrupt after
 * its rebuild or any rebuild attempt failed. Re-running is idempotent (each run builds a fresh
 * generation from canonical and swaps). All semantics live in {@link ProjectionRebuildOperations}
 * (tested against live PostgreSQL, including under concurrent writes); this file only parses args.
 */

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] ?? ''; i++; }
  }
  return out;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  if (!f.operator || !f.reason) {
    process.stderr.write('usage: projection:rebuild --operator <identity> --reason <text> [--project <id>] [--consumer <name>]\n');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaService();
  const ops = new ProjectionRebuildOperations(prisma, new ProjectionRebuilder(prisma));
  try {
    // Register every rebuildable projection consumer (this CLI runs standalone, outside the server
    // boot that normally registers them). The pairing is asserted so the registry and the operator
    // command can never drift apart silently.
    const factories: Record<string, () => ReturnType<typeof makeDecisionsProjectionConsumer>> = {
      [DECISIONS_PROJECTION]: makeDecisionsProjectionConsumer,
      [DAILY_LOG_PROJECTION]: makeDailyLogProjectionConsumer,
      [DRAWINGS_PROJECTION]: makeDrawingsProjectionConsumer,
      [INSPECTIONS_PROJECTION]: makeInspectionsProjectionConsumer,
      [ACTIVITIES_PROJECTION]: makeActivitiesProjectionConsumer,
      [MATERIAL_READINESS_PROJECTION]: makeMaterialReadinessProjectionConsumer,
      [LABOUR_READINESS_PROJECTION]: makeLabourReadinessProjectionConsumer,
      [CASH_FORECAST_PROJECTION]: makeCashForecastProjectionConsumer,
    };
    // Phase 3 Task 6 — the material-readiness recompute routes coverage through inventory +
    // substitutions; the CLI runs standalone, so bind the minimal instances (only the read-only
    // methods `coverageFor`/`coveringCommitments`/`activeTargets` run, all pure over the tx).
    bindMaterialReadinessDeps({
      // the extra `{} as never` is the Phase-5 commercial participant: it is only reached from the
      // acceptance WRITE path, and a rebuild runs read-only methods, so it is never dereferenced
      inventory: new InventoryService(prisma, {} as never, new ProcurementParticipant(new RequirementsQueryService()), {} as never, {} as never, {} as never),
      substitutions: new SubstitutionsService(prisma, {} as never, {} as never),
    });
    // Phase 4 Task 4 — the labour-readiness recompute routes forecast coverage through the labour
    // coverage authority (pure reads over the tx; no command surface).
    bindLabourReadinessDeps({ coverage: new LabourCoverageService(prisma) });
    // Phase 5 Task 7A — the cash-forecast recompute routes through the commercial budget query. Its
    // collaborators are all pure read folds over the tx, so the CLI can construct the real graph
    // rather than stub it: nothing here is a `{} as never` that a future refactor could dereference.
    const bills = new CommercialBillQuery();
    const deductions = new CommercialDeductionQuery(bills);
    bindCashForecastDeps({
      budget: new CommercialBudgetQuery(
        new ProcurementQuery(prisma),
        new LabourRequirementQuery(prisma),
        new InventoryQuery(prisma),
        new CommercialMeasurementQuery(),
        bills,
        deductions,
        new CommercialPaymentQuery(deductions),
      ),
    });
    for (const name of Object.keys(REBUILDABLE_PROJECTIONS)) {
      const make = factories[name];
      if (!make) throw new Error(`no consumer factory wired for rebuildable projection ${name}`);
      if (!getConsumer(name)) registerConsumer(make());
    }
    const report = await ops.run({
      operatorIdentity: f.operator,
      reason: f.reason,
      projectId: f.project || undefined,
      consumers: f.consumer ? [f.consumer] : undefined,
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ok) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`projection:rebuild: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
