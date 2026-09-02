import { PrismaService } from '../../prisma.service';
import { registerConsumer, getConsumer } from '../outbox/registry';
import { ProjectionRebuilder } from './rebuilder.service';
import { ProjectionRebuildOperations } from './rebuild-operations';
import { makeDecisionsProjectionConsumer, DECISIONS_PROJECTION } from '../../decisions/decisions.projection';
import { runInboxRepairStep, singleConnectionUrl } from './inbox-repair';
import { MARKER_SEAL_TABLE, summarizeMarkerSeals, verifyMarkerSeals } from './inbox-repair-seals';

/**
 * Phase 6 unit 4c-iii-r — the deploy-time `decisions.inbox` repair, as the COMPILED artifact
 * `scripts/migrate.sh` runs before `node dist/main.js` starts.
 *
 *   node dist/platform/projections/inbox-repair.cli.js seals
 *       READ-ONLY. Verifies that the marker seal migration's three triggers are present, enabled,
 *       executing their own canonical function bodies and owned by the table's owner — BEFORE the
 *       repair below is allowed to treat a marker as evidence. Exit 0 sealed; 3 when the table is
 *       there and a seal is missing, disabled, hollowed or unowned; 4 when the table does not
 *       exist at all, which after a successful deploy means the deploy did not do what the ledger
 *       now claims. Mirrors `b1 seals` and `t3c seals`, on the same path and for the same reason.
 *
 *   node dist/platform/projections/inbox-repair.cli.js
 *
 * Exit 0 when the repair succeeded, was already done, or the database provably has nothing to
 * repair. Exit 1 on any refusal — the deploy fails closed and the server never starts.
 *
 * All semantics live in {@link runInboxRepairStep} (tested against live PostgreSQL, including a
 * barrier-controlled concurrent start of two real processes); this file only builds the client and
 * prints the outcome. The client's pool is pinned to ONE connection because the step holds a
 * SESSION-level advisory lock across its whole body.
 */
async function main(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    process.stderr.write('[4c-iii-r] DATABASE_URL is unset — refusing to run.\n');
    process.exitCode = 1;
    return;
  }
  const prisma = new PrismaService({ datasourceUrl: singleConnectionUrl(raw) });
  try {
    if (process.argv[2] === 'seals') {
      const report = await verifyMarkerSeals(prisma);
      process.stdout.write(`${JSON.stringify({ ok: report.sealed, ...report }, null, 2)}\n`);
      if (!report.applicable) {
        process.stderr.write(
          `\n[4c-iii-r] marker seals NOT APPLICABLE: public."${MARKER_SEAL_TABLE}" does not exist, so no statement can be made about its seals. On a deploy path this is a failure, not a pass. See docs/RUNBOOK.md §P64CIIIR.\n`,
        );
        process.exitCode = 4;
        return;
      }
      if (!report.sealed) {
        process.stderr.write(
          `\n[4c-iii-r] marker seals are NOT INTACT:\n${summarizeMarkerSeals(report)}\n\nThe repair marker would not be evidence of anything on this database. See docs/RUNBOOK.md §P64CIIIR.\n`,
        );
        process.exitCode = 3;
      }
      return;
    }
    if (!getConsumer(DECISIONS_PROJECTION)) registerConsumer(makeDecisionsProjectionConsumer());
    const outcome = await runInboxRepairStep(prisma, new ProjectionRebuildOperations(prisma, new ProjectionRebuilder(prisma)), process.env, (line) =>
      process.stdout.write(`${line}\n`));
    // The report is deliberately omitted from the printed summary: it carries one entry per
    // project, and a deploy log should stay readable. Every fact the operator needs on a refusal is
    // already in `refusal.message`, which names the offending pairs.
    const { report: _report, ...summary } = outcome;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (!outcome.ok) process.exitCode = 1;
  } catch (e) {
    process.stderr.write(`[4c-iii-r] ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
