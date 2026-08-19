#!/usr/bin/env node
/**
 * Runner for the pre-push migration lint. See `migration-lint.mjs` for what each check is and why.
 *
 * Exit 0 clean (advisories may still print), exit 1 on any FAIL. Intended to sit in the same
 * battery as `pnpm check`, before a push — the whole point is to answer these questions in seconds
 * rather than an hour later, in a review round.
 *
 *   node scripts/migration-lint.cli.mjs [--base origin/main] [--all]
 *
 * `--all` lints every migration in the ledger rather than the ones this branch changed. That is the
 * calibration mode: a check that fires on long-merged migrations is not precise enough to ship.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import {
  changedMigrations, migrationSql, touchedTables,
  c1InlineConstraints, c2TruncateSeal, c3NullPassesCheck,
  formatFindings,
} from './migration-lint.mjs';

const args = process.argv.slice(2);
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'origin/main';
const all = args.includes('--all');
// CI passes this: there, a database IS present, so a skip means something broke rather than that
// the check was inapplicable, and the run should fail rather than report a hollow pass.
const requireDb = args.includes('--require-db');
const cwd = process.cwd();

// A check that cannot run must SAY SO. C3 and C4 read the live catalog, so without a database they
// have no answer — and reporting "0 findings" in that case is the failure mode this whole tool
// exists to prevent: a clean result that means "nothing was examined". `skipped` is printed in the
// summary and, under --require-db, is a failure.
const skipped = new Set();

function psql(sql) {
  const url = (process.env.DATABASE_URL ?? '').split('?')[0];
  if (!url) { skipped.add('no DATABASE_URL'); return null; }
  try {
    return execFileSync('psql', [url, '-qtA', '-F', '\u001f', '-c', sql], { encoding: 'utf8' });
  } catch (e) {
    skipped.add(`psql failed: ${String(e?.message ?? e).split('\n')[0]}`);
    return null;
  }
}
/** CHECK constraints on the given tables, with the NULLABLE columns each one names. */
function constraintsFor(tables) {
  if (tables.length === 0) return [];
  const list = tables.map((t) => `'${t.replace(/'/gu, "''")}'`).join(',');
  const out = psql(`
    SELECT c.conname, rel.relname, pg_get_constraintdef(c.oid),
           COALESCE(string_agg(a.attname, ',') FILTER (WHERE NOT a.attnotnull), '')
      FROM pg_constraint c
      JOIN pg_class rel ON rel.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = rel.relnamespace AND n.nspname = 'public'
      LEFT JOIN unnest(c.conkey) AS k(attnum) ON true
      LEFT JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
     WHERE c.contype = 'c' AND rel.relname IN (${list})
     GROUP BY c.conname, rel.relname, c.oid`);
  if (out === null) return [];
  return out.split('\n').filter(Boolean).map((row) => {
    const [name, table, definition, nullable] = row.split('');
    return {
      name, table, definition,
      nullableColumns: nullable ? nullable.split(',').filter(Boolean) : [],
    };
  });
}

/** Drift between the ledger and schema.prisma, SCOPED to the tables this migration touches. */
function scopedDrift(tables) {
  if (tables.length === 0) return [];
  let out;
  try {
    out = execFileSync('npx', ['prisma', 'migrate', 'diff',
      '--from-migrations', 'prisma/migrations',
      '--to-schema-datamodel', 'prisma/schema.prisma',
      '--shadow-database-url', process.env.LINT_SHADOW_URL
        ?? 'postgresql://postgres:postgres@localhost:5432/pmcvitan_lint_shadow'],
    { cwd: `${cwd}/apps/api`, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  const findings = [];
  const blocks = out.split(/\n(?=\[\*\] Changed the )/u);
  for (const block of blocks) {
    const m = /^\[\*\] Changed the `([^`]+)` table/u.exec(block);
    if (!m || !tables.includes(m[1])) continue;
    findings.push({
      check: 'C4', table: m[1], line: null,
      message: 'this migration\'s physical objects disagree with schema.prisma, so later migration '
        + `generation will emit corrective DDL for a schema that is fine:\n      ${block.trim().split('\n').slice(1).join('\n      ')}`,
    });
  }
  return findings;
}

const dirs = all
  ? readdirSync(`${cwd}/apps/api/prisma/migrations`).filter((d) => !d.endsWith('.toml')).sort()
  : changedMigrations(base, cwd);

if (dirs.length === 0) {
  console.log('[migration-lint] no migration added or changed against ' + base + ' — nothing to check.');
  process.exit(0);
}

let failed = 0;
let advisories = 0;

for (const dir of dirs) {
  const sql = migrationSql(dir, cwd);
  if (sql === null) continue;
  const tables = touchedTables(sql);
  const findings = [
    ...c1InlineConstraints(sql),
    ...c2TruncateSeal(sql),
    ...c3NullPassesCheck(constraintsFor(tables)),
    ...(all ? [] : scopedDrift(tables)),
  ];
  if (findings.length === 0) continue;
  console.log(`\n${dir}`);
  console.log(formatFindings(findings));
  failed += findings.filter((f) => !f.advisory).length;
  advisories += findings.filter((f) => f.advisory).length;
}

const ran = skipped.size === 0 ? 'C1, C2, C3, C4' : 'C1 and C2 only';
console.log(`\n[migration-lint] ${dirs.length} migration(s) checked with ${ran} — `
  + `${failed} failing, ${advisories} advisory.`);
if (skipped.size > 0) {
  console.log(`[migration-lint] SKIPPED the catalog checks (C3, C4): ${[...skipped].join('; ')}`);
  console.log('[migration-lint] a clean result here does NOT mean those checks passed.');
}
if (requireDb && skipped.size > 0) {
  console.log('[migration-lint] --require-db was set, so an unexaminable run is a failure.');
  process.exit(1);
}
process.exit(failed > 0 ? 1 : 0);
