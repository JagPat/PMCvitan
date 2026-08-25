import { PrismaService } from '../../prisma.service';
import { checkEnforcement, summarizeEnforcement } from './enforcement-check';

/**
 * Schema enforcement — the operator CLI. READ-ONLY: it asks the catalog and never writes.
 *
 *   pnpm --filter api enforcement:preflight     (migrate.sh, BEFORE `prisma migrate deploy`)
 *   pnpm --filter api enforcement:verify        (migrate.sh, AFTER a successful deploy)
 *
 * TWO INVOCATIONS, ONE QUESTION, asked at the two moments it has different answers — the pattern
 * `t3c` already uses, for the same reason:
 *
 *   BEFORE Prisma, because a dirty database must never receive a partial migration. A migration
 *   that lands on a schema whose seals are switched off writes rows nothing validated, and every
 *   later deploy sees a complete ledger and re-reads nothing. Failing here means Prisma never
 *   starts and no migration is recorded.
 *
 *   AFTER a successful deploy, because a migration that disables something and fails to restore it
 *   must not pass. `prisma migrate deploy` proves the LEDGER is complete, which is not the same
 *   claim as the guards enforcing.
 *
 * They differ only in what "no application tables" means. Before Prisma that is a fresh database
 * and it PASSES — the migrations that build the schema still have to run. After a successful
 * deploy the tables must exist, so their absence means the deploy did not do what the ledger now
 * claims it did, and it FAILS (exit 4) exactly as `b1 seals` and `t3c seals` do on that path.
 *
 * Exit codes: 0 enforcing · 3 something does not enforce · 4 not applicable where it must be ·
 * 2 usage · 1 error. Constructed directly over a Prisma client (no Nest DI / HTTP), like the
 * T45/T2C/T3C/B1 CLIs.
 */
async function main(): Promise<void> {
  const cmd = process.argv[2];
  const prisma = new PrismaService();
  try {
    if (cmd === 'preflight' || cmd === 'verify') {
      const report = await checkEnforcement(prisma);
      process.stdout.write(JSON.stringify({ ok: report.enforcing && (report.applicable || cmd === 'preflight'), ...report }, null, 2) + '\n');

      if (!report.applicable) {
        if (cmd === 'preflight') return; // fresh/empty database — nothing to verify, and nothing wrong.
        process.stderr.write(
          `\nschema enforcement NOT APPLICABLE after a successful deploy: ${report.note}. On a post-deploy path this is a failure, not a pass. See docs/RUNBOOK.md §ENF.\n`,
        );
        process.exitCode = 4;
        return;
      }

      if (!report.enforcing) {
        process.stderr.write(
          `\nschema enforcement is NOT INTACT:\n${summarizeEnforcement(report)}\n\nSee docs/RUNBOOK.md §ENF.\n`,
        );
        process.exitCode = 3;
      }
    } else {
      process.stderr.write('usage: enforcement <preflight | verify>\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`enforcement: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
