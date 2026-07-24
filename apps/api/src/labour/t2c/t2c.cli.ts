import { readFileSync } from 'node:fs';
import { PrismaService } from '../../prisma.service';
import { summarizeT2C } from './t2c-diagnostics';
import { RepairAbortedError, T2CRepairService, type RepairPlan } from './t2c-repair.service';

/**
 * Phase 4 Task 2 correction (round 2) — the labour commercial-integrity operator CLI.
 *
 *   pnpm --filter api t2c:preflight
 *       READ-ONLY. Runs every labour-commercial diagnostic (F5, F3, F2.spec, F2.slice, F2.poline, F4)
 *       and prints a per-finding count + bounded samples, plus the `20270205…` migration state. Exit
 *       0 when the database is clean (safe to `prisma migrate deploy`), 3 when any finding is present.
 *       Run this BEFORE deploy so the F2.poline/F4 shapes are reported explicitly instead of failing
 *       opaquely inside `ALTER TABLE … ADD CONSTRAINT`.
 *
 *   pnpm --filter api t2c:repair --plan <plan.json> --operator <identity> --reason <text>
 *       Applies an EXPLICIT operator-authored plan (never fabricates provenance) under one bounded
 *       maintenance transaction: durable before-image evidence, surgical (minimal) trigger disable,
 *       apply, trigger re-enable + verify, in-transaction re-diagnose, commit-or-roll-back. Exit 0 on
 *       a clean commit, 1 on an abort (everything rolled back, triggers still firing).
 *
 * Constructed directly over a Prisma client (no Nest DI / HTTP), exactly like the T45 CLI.
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
  const svc = new T2CRepairService(prisma);
  try {
    if (cmd === 'preflight') {
      // Schema-aware: a fresh/empty or pre-Task-2 database has no labour-commercial schema to
      // diagnose. Report "not applicable" and exit 0 so migrations that CREATE that schema may run.
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
          `\nT2C preflight found ${report.total} violation(s) — repair per docs/RUNBOOK.md §P4T2C before deploy:\n${summarizeT2C(report)}\n`,
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
            triggersDisabled: outcome.triggersDisabled,
            triggersRestored: outcome.triggersRestored,
            verified: { clean: outcome.verified.clean, total: outcome.verified.total },
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      process.stderr.write(
        'usage: t2c <preflight | migration-state | repair --plan <plan.json> --operator <identity> --reason <text>>\n',
      );
      process.exitCode = 2;
    }
  } catch (e) {
    if (e instanceof RepairAbortedError) {
      process.stderr.write(`t2c repair ABORTED (all changes rolled back): ${e.message}\n`);
    } else {
      process.stderr.write(`t2c: ${(e as Error).message}\n`);
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
