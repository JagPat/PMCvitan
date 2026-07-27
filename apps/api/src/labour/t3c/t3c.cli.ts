import { readFileSync } from 'node:fs';
import { PrismaService } from '../../prisma.service';
import { summarizeT3C } from './t3c-diagnostics';
import { RepairAbortedError, T3CRepairService, type RepairPlan } from './t3c-repair.service';

/**
 * Phase 4 Task 3 correction (round 3) — the §C attendance-integrity operator CLI.
 *
 *   pnpm --filter api t3c:preflight
 *       READ-ONLY. Runs every attendance diagnostic (F1.blank, F1.marker) and prints a per-finding
 *       count + bounded samples, plus the `20270220…` / `20270225…` migration states. Exit 0 when the
 *       database is clean (safe to `prisma migrate deploy`), 3 when any finding is present. Run this
 *       BEFORE deploy so the blank-reason state is reported explicitly and Prisma never starts.
 *
 *   pnpm --filter api t3c:seals
 *       READ-ONLY. Reports whether `20270225000000`'s PHYSICAL objects (the reserved-marker trigger,
 *       the allocation project-lock trigger, the marker-is-revoked CHECK) exist in this database.
 *       Exit 0 when installed or when the §C attendance schema is absent entirely; 3 when the schema
 *       is present but a seal is missing. `scripts/migrate.sh` uses this on the P3005 baseline path
 *       so a `db push` database is never marked as having a correction it does not carry.
 *
 *   pnpm --filter api t3c:repair --plan <plan.json> --operator <identity> --reason <text>
 *       Applies an EXPLICIT operator-authored plan under one bounded maintenance transaction:
 *       durable before-image evidence, surgical (minimal) trigger disable, apply, trigger re-enable
 *       + verify, in-transaction re-diagnose, commit-or-roll-back. NOTHING IS EVER DELETED — a blank
 *       muster is marked with the reserved invalid-legacy marker and revoked, so the original
 *       observation, its recorder and its timestamps stay queryable. Exit 0 on a clean commit, 1 on
 *       an abort (everything rolled back, triggers still firing).
 *
 * Constructed directly over a Prisma client (no Nest DI / HTTP), exactly like the T45/T2C CLIs.
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
  const svc = new T3CRepairService(prisma);
  try {
    if (cmd === 'preflight') {
      // Schema-aware: a fresh/empty or pre-Task-3 database has no §C attendance schema to diagnose.
      // Report "not applicable" and exit 0 so migrations that CREATE that schema may run.
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
          `\nT3C preflight found ${report.total} violation(s) — repair per docs/RUNBOOK.md §P4T3C2 before deploy:\n${summarizeT3C(report)}\n`,
        );
        process.exitCode = 3;
      }
    } else if (cmd === 'seals') {
      // Are `20270225000000`'s raw-SQL objects physically present? Used by `scripts/migrate.sh` on
      // the P3005 baseline path, where marking the migration applied without executing it would
      // leave a database permanently without the seals while Prisma believed they were installed.
      // Reports "not applicable" (exit 0) on a database with no §C attendance schema at all.
      const eligibility = await svc.schemaEligible();
      if (!eligibility.applicable) {
        process.stdout.write(
          JSON.stringify({ ok: true, applicable: false, reason: eligibility.reason, missing: eligibility.missing }, null, 2) + '\n',
        );
        return;
      }
      const seals = await svc.correctionSeals();
      process.stdout.write(JSON.stringify({ ok: seals.installed, applicable: true, ...seals }, null, 2) + '\n');
      if (!seals.installed) {
        process.stderr.write(
          `\nT3C correction-3 seals MISSING: ${seals.missing.join(', ')} — migration 20270225000000 has not physically applied here.\n`,
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
        'usage: t3c <preflight | seals | migration-state | repair --plan <plan.json> --operator <identity> --reason <text>>\n',
      );
      process.exitCode = 2;
    }
  } catch (e) {
    if (e instanceof RepairAbortedError) {
      process.stderr.write(`t3c repair ABORTED (all changes rolled back): ${e.message}\n`);
    } else {
      process.stderr.write(`t3c: ${(e as Error).message}\n`);
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
