import { PrismaService } from '../../prisma.service';
import { B1_TABLE, summarizeB1, verifyB1Seals } from './b1-seals';

/**
 * Schedule B1 — the physical-seal operator CLI.
 *
 *   pnpm --filter api b1:seals
 *       READ-ONLY. Re-executes the migration's OWN section-9 seal inventory against this database,
 *       and additionally requires that the install barrier has been lifted and that all five
 *       trigger functions still carry the body the migration installed and the table owner's
 *       ownership. Exit 0 when sealed; 3 when the table is there and something is missing,
 *       disabled, hollowed or unowned; 4 when "ActivityDependency" does not exist at all.
 *
 *       `scripts/migrate.sh` runs this on the ORDINARY success path, after `prisma migrate deploy`
 *       reports the ledger complete. A complete ledger is not a working guard: once the migration
 *       is recorded nothing re-reads it, so a database that has since been restored badly deploys
 *       green with its evidence rewritable. Exit 4 is a FAILURE there and not a pass — after a
 *       successful deploy the table must exist, so its absence means the deploy did not do what the
 *       ledger now claims it did. This mirrors `t3c seals`, for the same reason and on the same path.
 *
 * Constructed directly over a Prisma client (no Nest DI / HTTP), exactly like the T45/T2C/T3C CLIs.
 */
async function main(): Promise<void> {
  const cmd = process.argv[2];
  const prisma = new PrismaService();
  try {
    if (cmd === 'seals') {
      const report = await verifyB1Seals(prisma);
      process.stdout.write(JSON.stringify({ ok: report.sealed, ...report }, null, 2) + '\n');
      if (!report.applicable) {
        process.stderr.write(
          `\nschedule B1 seals NOT APPLICABLE: ${B1_TABLE} does not exist, so no statement can be made about its seals. On a deploy path this is a failure, not a pass. See docs/RUNBOOK.md section B1.\n`,
        );
        process.exitCode = 4;
        return;
      }
      if (!report.sealed) {
        process.stderr.write(`\nschedule B1 seals are NOT INTACT:\n${summarizeB1(report)}\n\nSee docs/RUNBOOK.md section B1.\n`);
        process.exitCode = 3;
      }
    } else {
      process.stderr.write('usage: b1 <seals>\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`b1: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
