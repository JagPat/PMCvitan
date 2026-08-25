#!/usr/bin/env node
// MIGRATION INVARIANTS — the checks the schedule-B1 lineage spent sixteen heads rediscovering.
//
// `ActivityDependency` ran #354 → #360 → #361 → #363 → #408 → #409 → #410 → #411 → #412 → #415 and
// merged only at the sixteenth head. Every round drew the same class of finding: A CHECK NARROWER
// THAN THE OBJECT IT JUDGES. Each individual fix was correct. The next round found the same shape
// somewhere new, because nothing in the repository could state the shape itself. This file states
// it, executably, before review rather than after.
//
// THIS UNIT SHIPS ONE RULE.
//
//   MI-001  a migration that VERIFIES a prerequisite database object must verify that the object
//           ENFORCES, not merely that it EXISTS
//
// WHAT IS DEFERRED, AND WHERE IT LIVES. Four further rules were written, corrected and left green
// on the closed `claude/migration-invariant-linter` branch, whose history IS their handover:
// MI-000 (statement-kind totality) and MI-004 (transaction scope) at `a8b401ba`, MI-002 (an object
// judged by NAME where a definition comparison was required) at `f3f00a88`, MI-003 (a guard
// verified at APPLY time and never asked again on a later deploy) at `08835700`. `git show <sha>`
// is the whole handover. NEVER REBASE OR FORCE-PUSH THAT BRANCH. Those rule numbers are the ones
// that branch used; this file keeps them so the SHAs stay readable, and MI-001 here is the rule
// that branch called MI-002. docs/MIGRATION_INVARIANTS.md states the mapping and what each rule's
// absence costs — including a second live defect that only MI-003 detects and that this unit
// therefore does not report. Deferring a rule did not unfind its defect; it removed the alarm.
//
// THE DESIGN CONSTRAINT. This is deliberately NOT a list of known-bad patterns. A grep for the
// fragments the B1 lineage happened to produce would be a check narrower than the object it judges
// — the exact defect it exists to catch, restated as its own implementation. PR #423 tried and was
// closed for it: it hand-wrote a SQL lexer, and every one of its seven round-2 findings reduced to
// "this linter enumerates a subset of PostgreSQL and treats the subset as the whole". Nothing here
// decides what SQL is. `scripts/pg-parse.mjs` hands each rule PostgreSQL's own parse tree, and the
// rules ask structural questions of it.
//
// EVERY RULE IS BOUND TO ITS RESOLUTION SITE. Four of those seven findings were one defect, one
// meta-level up from this linter's own subject: EVIDENCE GATHERED AT A COARSER GRANULARITY THAN THE
// THING BEING JUDGED. The rule's proof that "this place checks enablement" was first file-global
// and then, after a correction, block-global — so a file that verified one key correctly discharged
// the requirement for every other key in it, and one correct guard shielded an arbitrary number of
// defective neighbours. A site here is ONE QUERY, and a site's evidence must be in that query.
//
// HOW TO ADD A RULE. Prove it RED against the real historical commit that produced the finding, pin
// that fragment in `scripts/fixtures/migration-lint/`, and cite the PR and head in the rule's
// comment. A rule that does not fire on the head that produced its finding is not implemented;
// `migration-lint.test.mjs` asserts that in both directions. Full prose: docs/MIGRATION_INVARIANTS.md.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadParser, parseMigration, walk, nodesOfType, relationsIn, columnsIn, stringConstsIn,
} from './pg-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'apps', 'api', 'prisma', 'migrations');

const finding = (rule, line, message) => ({ rule, line, message });

// ── What "this query is about a foreign key" means, structurally ─────────────────────────────
//
// `contype` is the catalog's own discriminator and `'f'` is its own value for a foreign key, so a
// query that compares one against the other is asking about foreign keys — whatever it then does
// with the answer. Both halves come out of the parse tree as nodes, which is why the value can be
// read at all: PR #423 had to keep a side table of literal positions because its mask blanked every
// string, and one of its findings was a rule that asked whether the FILE contained an `'f'`
// anywhere and so flagged a migration whose guards ask about CHECK constraints.
const FK_DISCRIMINATOR = 'contype';
const FK_VALUE = 'f';

/** True when this comparison puts a `contype` column and the constant `'f'` on opposite sides. */
function comparesFkDiscriminator(expr) {
  const sides = [expr.lexpr, expr.rexpr].filter((s) => s != null);
  if (sides.length < 2) return false;
  const [a, b] = sides;
  const names = (side) => columnsIn(side);
  const consts = (side) => stringConstsIn(side);
  return (names(a).includes(FK_DISCRIMINATOR) && consts(b).includes(FK_VALUE))
    || (names(b).includes(FK_DISCRIMINATOR) && consts(a).includes(FK_VALUE));
}

/**
 * MI-001 — a prerequisite object verified as PRESENT where it had to be verified as ENFORCING.
 *
 * RED at `a222e91` (PR #411). Section 1e verified five foreign keys through `pg_constraint`, by
 * `conname`, `conrelid`, `contype = 'f'` and the `confrelid` OID, and read what it found as proof
 * that the table has containment. It does not prove that. A foreign key is IMPLEMENTED as internal
 * `RI_ConstraintTrigger` rows — measured on PostgreSQL 16, four of them per key — and
 * `ALTER TABLE … DISABLE TRIGGER ALL` switches those off while leaving `pg_get_constraintdef`,
 * `confrelid`, `contype` and `convalidated` intact and identical. So a key that enforces NOTHING
 * satisfies every column that guard reads, and a restored database with no containment at all is
 * certified as the prerequisite and baselined as correct. GREEN at `96c9cc4` (PR #412), which joins
 * `pg_trigger` on `tgconstraint` and refuses a key whose `tgenabled` says it does not act.
 *
 * THE EVIDENCE MUST BE IN THE QUERY THAT DRAWS THE CONCLUSION. This is the correction PR #423 was
 * closed for failing twice: its enforcement evidence was first file-global and then block-global,
 * so a guard that read `tgenabled` correctly for key A discharged the requirement for key B beside
 * it. `scripts/fixtures/migration-lint/mi001-decoy-adjacent-guard.sql` holds both resolutions in a
 * SINGLE `DO` block and the test asserts the rule fires on one and not the other.
 */
function ruleEnforcementNotExistence(site) {
  const reads = relationsIn(site.tree);
  if (!reads.includes('pg_constraint')) return [];
  const comparisons = nodesOfType(site.tree, 'A_Expr');
  if (!comparisons.some(comparesFkDiscriminator)) return [];

  // The enforcement read, in THIS query: `pg_trigger.tgenabled`, reached through `tgconstraint`.
  // Both halves are required and neither is decoration. `tgenabled` alone would accept the
  // enablement of some unrelated trigger that happens to be read nearby; `tgconstraint` alone
  // reaches the key's own triggers and then never asks whether they are switched on.
  const columns = columnsIn(site.tree);
  if (columns.includes('tgenabled') && columns.includes('tgconstraint')) return [];

  return [finding('MI-001', site.line,
    'this query decides something about a foreign key (it reads pg_constraint and tests '
    + "contype = 'f') without asking whether that key ENFORCES. A foreign key is implemented as "
    + 'internal RI_ConstraintTrigger rows — four per key on PostgreSQL 16 — and ALTER TABLE … '
    + 'DISABLE TRIGGER ALL switches them off while leaving conname, conrelid, confrelid, contype, '
    + 'convalidated and pg_get_constraintdef byte-for-byte unchanged. A key that enforces nothing '
    + 'therefore satisfies every column read here, which is how PR #411 head a222e91 certified a '
    + 'database with no containment. Join pg_trigger on tgconstraint and refuse tgenabled in '
    + "('D','R') IN THIS QUERY. The same read in a neighbouring query does not answer for this one.")];
}

const RULES = [
  ['MI-001', ruleEnforcementNotExistence],
];

export const RULE_IDS = RULES.map(([id]) => id);

/** Lint one migration. Every site is judged; nothing is sampled. */
export function lintMigration({ name, sql }) {
  const { sites } = parseMigration(sql);
  const findings = [];
  for (const site of sites) {
    for (const [, rule] of RULES) findings.push(...rule(site));
  }
  return findings
    .map((f) => ({ ...f, migration: name }))
    .sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Migrations merged before this linter existed, each with a written reason. Recorded, not
 *  suppressed: adding one costs a visible edit that a reviewer reads. See the JSON's __README__. */
const EXEMPTIONS_FILE = join(REPO_ROOT, 'scripts', 'migration-lint-exemptions.json');
export const EXEMPTIONS = new Map(Object.entries(JSON.parse(
  existsSync(EXEMPTIONS_FILE) ? readFileSync(EXEMPTIONS_FILE, 'utf8') : '{}',
)));

export function migrationNames(dir = MIGRATIONS_DIR) {
  return readdirSync(dir).sort().filter((n) => existsSync(join(dir, n, 'migration.sql')));
}

/**
 * Lint the whole corpus.
 *
 * Returns findings AND exempted findings separately. An exemption suppresses the BUILD FAILURE, not
 * the report: the CLI prints every exempted finding with its written reason on each run, so a live
 * defect this unit is not allowed to repair stays visible in the same output as a failing one
 * rather than disappearing into a JSON file nobody opens.
 */
export function lintAll({ dir = MIGRATIONS_DIR, applyExemptions = true } = {}) {
  const findings = [];
  const exempted = [];
  for (const name of migrationNames(dir)) {
    for (const f of lintMigration({ name, sql: readFileSync(join(dir, name, 'migration.sql'), 'utf8') })) {
      const reason = applyExemptions ? (EXEMPTIONS.get(name) ?? {})[f.rule] : undefined;
      if (reason) exempted.push({ ...f, reason });
      else findings.push(f);
    }
  }
  return Object.assign(findings, { exempted });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await loadParser();
  const findings = lintAll();
  for (const f of findings.exempted) {
    const live = f.reason.startsWith('LIVE DEFECT');
    console.error(`${f.migration}/migration.sql:${f.line}  ${f.rule}  ${live ? 'LIVE DEFECT (recorded, not repaired here)' : 'RECORDED EXEMPTION'}: ${f.reason}`);
  }
  if (findings.exempted.length > 0) console.error('');
  for (const f of findings) {
    console.error(`${f.migration}/migration.sql:${f.line}  ${f.rule}  ${f.message}`);
  }
  if (findings.length > 0) {
    const migrations = new Set(findings.map((f) => f.migration));
    console.error(`\nmigration-lint: ${findings.length} finding(s) across ${migrations.size} migration(s).`);
    console.error('Each rule is explained at its definition in scripts/migration-lint.mjs, with the PR');
    console.error('and head whose finding produced it. See docs/MIGRATION_INVARIANTS.md.');
    process.exit(1);
  }
  const n = migrationNames().length;
  const recorded = findings.exempted.length;
  console.log(`migration-lint: clean (${n} migrations, ${RULE_IDS.length} rule${RULE_IDS.length === 1 ? '' : 's'}`
    + `${recorded > 0 ? `, ${recorded} recorded exemption${recorded === 1 ? '' : 's'} printed above` : ''}).`);
}
