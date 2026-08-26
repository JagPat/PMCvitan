import { PrismaService } from '../../prisma.service';
import { summarizeArmedSeals, verifyArmedSeals } from './armed-seals';

/**
 * Armed-seal verification — the operator CLI.
 *
 *   pnpm --filter api seals:armed
 *       READ-ONLY. Asks the catalog whether every enforcement object in the `public` schema is
 *       switched on. Exit 0 when all are armed; 3 when any is disabled, NOT VALID, bypassed via
 *       `relhastriggers`, or of a constraint kind this check has never classified; 4 when the
 *       schema holds no tables at all.
 *
 *       `scripts/migrate.sh` runs this on the ORDINARY success path, after `prisma migrate deploy`
 *       reports the ledger complete — the same path and the same reason as `t3c seals` and
 *       `b1 seals`. A complete ledger is not a working guard: once a migration is recorded nothing
 *       re-reads it, so a badly restored database deploys green with its guards switched off.
 *       MEASURED before this was written: with `DecisionOption_kind_selectable_ins/upd` disabled,
 *       `scripts/migrate.sh` exited 0 and never named them.
 *
 *       Exit 4 is a FAILURE on that path and not a pass — after a successful deploy the schema must
 *       exist, so its absence means the deploy did not do what the ledger now claims it did.
 *
 *       This verifier is UNSCOPED, unlike `t3c seals` and `b1 seals`, which each re-execute one
 *       migration's own hand-written inventory. Those two answer a stronger question (is the body
 *       CANONICAL?) about a handful of objects; this answers a weaker question (is it ARMED?) about
 *       every object there is. They compose: keep both.
 *
 * Constructed directly over a Prisma client (no Nest DI / HTTP), exactly like the T45/T2C/T3C/B1 CLIs.
 */
async function main(): Promise<void> {
  const cmd = process.argv[2];
  const prisma = new PrismaService();
  try {
    if (cmd === 'armed') {
      const report = await verifyArmedSeals(prisma);
      process.stdout.write(JSON.stringify({ ok: report.armed, ...report }, null, 2) + '\n');
      if (!report.applicable) {
        process.stderr.write(
          '\narmed seals NOT APPLICABLE: the public schema holds no tables, so no statement can be '
          + 'made about its seals. On a deploy path this is a failure, not a pass. See docs/RUNBOOK.md §SEALS.\n',
        );
        process.exitCode = 4;
        return;
      }
      if (!report.armed) {
        process.stderr.write(
          `\n${report.findings.length} enforcement object(s) are present and NOT ENFORCING `
          + `(of ${report.considered} considered):\n${summarizeArmedSeals(report)}\n\nSee docs/RUNBOOK.md §SEALS.\n`,
        );
        process.exitCode = 3;
      }
    } else {
      process.stderr.write('usage: seals <armed>\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`seals: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
