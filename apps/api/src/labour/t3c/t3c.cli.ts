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
 *       READ-ONLY with respect to every real relation (it builds session-local TEMP probe tables to
 *       obtain canonical constraint deparses — gone at transaction end). Reports whether the two
 *       re-runnable corrections' PHYSICAL objects (`20270220000000`'s non-blank CHECK;
 *       `20270225000000`'s reserved-marker trigger, allocation project-lock trigger,
 *       marker-is-revoked CHECK — plus the `T3CRepairAction` seals whenever that table exists) are
 *       installed AND ENFORCING, and whether the WHOLE `20270210000000`/`20270215000000` raw-SQL
 *       prerequisite inventory (triggers, CHECKs, unique keys, composite FKs) is present.
 *       Exit 0 when everything applicable is installed; 3 when the schema is present but a
 *       correction seal is missing (the JSON's `pendingMigrations` names the migrations to leave
 *       unresolved); 4 when the §C attendance schema is absent entirely; 5 when the §C tables exist
 *       but a PREREQUISITE object does not (the `prisma db push` signature). None of 3/4/5 is a
 *       success. `scripts/migrate.sh` acts on each: 3 leaves the named corrections pending so they
 *       really apply; 4 and 5 refuse to baseline at all.
 *
 *   pnpm --filter api t3c:plan
 *       READ-ONLY. Exports a COMPLETE repair-plan skeleton naming EVERY finding row (not the
 *       report's bounded samples) — blanks as retirements, forged markers as quarantines, plus a
 *       `manual` list of genuine audited repairs left live that must be revoked through the
 *       application instead. Fill in operator/reason and each action's revokedById/revokeReason,
 *       then submit the file whole with t3c:repair.
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
      //
      // "Not applicable" is its OWN exit code (4), never a success. `preflight` may legitimately
      // answer "nothing to diagnose" with exit 0 on a fresh database — there really are no rows.
      // This question is different: the caller is deciding whether to record migrations as applied,
      // and a §C schema that is absent is not the same answer as seals that are present. Collapsing
      // them let a P3005 database built from a PRE-Task-3 schema pass both the baseline check and
      // the post-deploy re-check, so the runner resolved every migration as applied, exited 0, and
      // left Prisma's ledger claiming a schema the application does not have.
      const eligibility = await svc.schemaEligible();
      if (!eligibility.applicable) {
        process.stdout.write(
          JSON.stringify(
            { ok: false, applicable: false, status: 'prerequisite-schema-absent', reason: eligibility.reason, missing: eligibility.missing },
            null,
            2,
          ) + '\n',
        );
        process.stderr.write(
          `\nT3C seals NOT APPLICABLE: ${eligibility.reason}. The §C attendance schema this correction seals does not exist here, so no statement can be made about its seals. See docs/RUNBOOK.md §P4T3C3.\n`,
        );
        process.exitCode = 4;
        return;
      }
      const seals = await svc.correctionSeals();
      // A database holding the §C TABLES without the §C GUARDS from `20270210000000` /
      // `20270215000000` is the `prisma db push` signature, and it gets its OWN answer (exit 5).
      // Those migrations `CREATE TABLE`, so unlike the two corrections they cannot be left pending
      // to re-run — and resolving them as applied records guards that do not exist, permanently.
      // The prerequisite set is the WHOLE raw-SQL object inventory (triggers, CHECKs, unique keys,
      // composite FKs), not only the triggers: a replay that installed the triggers but not
      // `LabourAttendance_revoke_attribution_check` used to baseline cleanly, after which a raw
      // update could set `revokedAt` alone — a permanently unattributed correction.
      const status = seals.prerequisitesMissing.length > 0
        ? 'prerequisite-seals-missing'
        : seals.installed
          ? 'sealed'
          : 'correction-seals-missing';
      process.stdout.write(JSON.stringify({ ok: seals.installed, applicable: true, status, ...seals }, null, 2) + '\n');
      if (seals.prerequisitesMissing.length > 0) {
        process.stderr.write(
          `\nT3C PREREQUISITE seals MISSING: ${seals.prerequisitesMissing.join(', ')} — this database has the §C tables without the §C guards (the signature of \`prisma db push\`). See docs/RUNBOOK.md §P4T3C3.\n`,
        );
        process.exitCode = 5;
      } else if (!seals.installed) {
        // BOTH re-runnable corrections report here — `20270220000000`'s CHECK is its own pending
        // layer, and `migrate.sh` reads `pendingMigrations` to leave exactly the absent ones
        // unresolved so `migrate deploy` really executes them.
        process.stderr.write(
          `\nT3C correction seals MISSING: ${[...(!seals.correction2Installed ? ['LabourAttendance_manual_reason_non_blank'] : []), ...seals.missing].join(', ')} — leave pending and really execute: ${seals.pendingMigrations.join(', ')}.\n`,
        );
        process.exitCode = 3;
      }
    } else if (cmd === 'plan') {
      // A COMPLETE plan skeleton — every finding row, not the report's bounded samples. The report
      // stays bounded on purpose; the repair is all-or-nothing, so the PLAN must name every row or a
      // database with more findings than the sample limit can never be unblocked. Redirect to a
      // file, fill in operator/reason and each action's revokedById/revokeReason, then submit with
      // `t3c repair --plan <file>` (repair reads `actions` and ignores `manual`). `manual` lists the
      // rows the engine must NOT touch — genuine audited repairs left live — with their application
      // exit; see docs/RUNBOOK.md §P4T3C3.
      const eligibility = await svc.schemaEligible();
      if (!eligibility.applicable) {
        process.stdout.write(
          JSON.stringify({ ok: true, applicable: false, note: eligibility.reason, operator: '', reason: '', actions: [], manual: [] }, null, 2) + '\n',
        );
        return;
      }
      process.stdout.write(JSON.stringify(await svc.planSkeleton(), null, 2) + '\n');
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
        'usage: t3c <preflight | seals | plan | migration-state | repair --plan <plan.json> --operator <identity> --reason <text>>\n',
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
