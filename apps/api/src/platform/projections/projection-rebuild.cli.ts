import { PrismaService } from '../../prisma.service';
import { registerConsumer, getConsumer } from '../outbox/registry';
import { ProjectionRebuilder } from './rebuilder.service';
import { ProjectionRebuildOperations } from './rebuild-operations';
import { makeDrawingsProjectionConsumer, DRAWINGS_PROJECTION } from '../../drawings/drawings.projection';
import { makeDailyLogProjectionConsumer, DAILY_LOG_PROJECTION } from '../../daily-log/daily-log.projection';

/**
 * Module-4 correction + Task 10 finalization — the operator projection-rebuild command.
 *
 *   pnpm --filter api projection:rebuild --operator <identity> --reason <text> \
 *        [--project <id>] [--consumer <drawings.inbox | daily-log.inbox>]
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
  if (!getConsumer(DRAWINGS_PROJECTION)) registerConsumer(makeDrawingsProjectionConsumer());
  if (!getConsumer(DAILY_LOG_PROJECTION)) registerConsumer(makeDailyLogProjectionConsumer());
  const ops = new ProjectionRebuildOperations(prisma, new ProjectionRebuilder(prisma));
  try {
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
