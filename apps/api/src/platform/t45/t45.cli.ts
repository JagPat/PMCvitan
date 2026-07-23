import { readFileSync } from 'node:fs';
import { PrismaService } from '../../prisma.service';
import { summarizeT45 } from './t45-diagnostics';
import { RepairAbortedError, T45RepairService, type RepairPlan } from './t45-repair.service';

/**
 * Phase 3 Tasks 4–5 integrity correction — the operator CLI.
 *
 *   pnpm --filter api t45:preflight
 *       READ-ONLY. Runs every §C/§E diagnostic (F1, F2.1–F2.3, F3.1, F3.2, F3.3, F4) and prints a
 *       per-finding count + bounded samples, plus the `20261231…` migration state. Exit 0 when the
 *       database is clean (safe to `prisma migrate deploy`), 3 when any finding is present. Run this
 *       BEFORE deploy so the F3.1 duplicate-issue shape is reported explicitly instead of failing
 *       opaquely inside `CREATE UNIQUE INDEX`.
 *
 *   pnpm --filter api t45:repair --plan <plan.json> --operator <identity> --reason <text>
 *       Applies an EXPLICIT operator-authored plan (never guesses provenance) under one bounded
 *       maintenance transaction: durable before-image evidence, surgical trigger disable, apply,
 *       trigger re-enable + verify, in-transaction re-diagnose, commit-or-roll-back. Exit 0 on a
 *       clean commit, 1 on an abort (everything rolled back, triggers still firing).
 *
 * Constructed directly over a Prisma client (no Nest DI / HTTP), exactly like the outbox CLI.
 */

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const prisma = new PrismaService();
  const svc = new T45RepairService(prisma);
  try {
    if (cmd === 'preflight') {
      // Schema-aware: a fresh/empty or pre-Task-5 database has no §C/§E schema to diagnose. Report
      // "not applicable" and exit 0 so `scripts/migrate.sh` proceeds to apply the migrations that
      // CREATE that schema. Only an ELIGIBLE database runs the diagnostics and can block the deploy.
      const eligibility = await svc.schemaEligible();
      if (!eligibility.applicable) {
        process.stdout.write(
          JSON.stringify({ ok: true, applicable: false, reason: eligibility.reason, missing: eligibility.missing }, null, 2) + '\n',
        );
        return; // exit 0 — normal migrations may run
      }
      const report = await svc.preflight();
      const migration = await svc.migrationState();
      process.stdout.write(
        JSON.stringify({ ok: report.clean, applicable: true, migration, report }, null, 2) + '\n',
      );
      if (!report.clean) {
        process.stderr.write(
          `\nT45 preflight found ${report.total} violation(s) — repair per docs/RUNBOOK.md §T45 before deploy:\n${summarizeT45(report)}\n`,
        );
        process.exitCode = 3;
      }
    } else if (cmd === 'migration-state') {
      process.stdout.write(JSON.stringify(await svc.migrationState(), null, 2) + '\n');
    } else if (cmd === 'repair') {
      const f = parseFlags(process.argv.slice(3));
      if (!f.plan) throw new Error('repair requires --plan <path to decisions json>');
      const raw = JSON.parse(readFileSync(f.plan, 'utf8')) as Partial<RepairPlan>;
      const plan: RepairPlan = {
        operator: (f.operator ?? raw.operator ?? '').trim(),
        reason: (f.reason ?? raw.reason ?? '').trim(),
        actions: raw.actions ?? [],
      };
      const outcome = await svc.repair(plan);
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            action: 'repair',
            repairId: outcome.repairId,
            applied: outcome.applied,
            triggersRestored: outcome.triggersRestored,
            verified: { clean: outcome.verified.clean, total: outcome.verified.total },
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(
        'usage: t45 <preflight | migration-state | repair --plan <plan.json> --operator <identity> --reason <text>>\n',
      );
      process.exitCode = 2;
    }
  } catch (e) {
    if (e instanceof RepairAbortedError) {
      process.stderr.write(`t45 repair ABORTED (all changes rolled back): ${e.message}\n`);
    } else {
      process.stderr.write(`t45: ${(e as Error).message}\n`);
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
