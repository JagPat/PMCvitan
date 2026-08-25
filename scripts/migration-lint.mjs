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
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadParser, parseMigration, nodesOfType, relationsIn, columnsIn, stringConstsIn,
  relationAliases, referencesColumnOf, comparisonOperands,
} from './pg-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'apps', 'api', 'prisma', 'migrations');

const finding = (rule, site, message) => ({
  rule, line: site.line, fingerprint: fingerprintOf(site.sql), message,
});

/** A site's identity independent of where it sits: its own SQL, whitespace runs collapsed. */
export const fingerprintOf = (sql) => createHash('sha256')
  .update(String(sql ?? '').replace(/\s+/gu, ' ').trim(), 'utf8').digest('hex').slice(0, 16);

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
  // DELIBERATELY unresolved, unlike the enforcement read below. Detection and evidence pull in
  // opposite directions: a permissive detector asks the question of more sites than strictly own
  // it, and a strict evidence test credits fewer answers. Both err toward a FINDING, which is the
  // only direction a linter may err in — the failure this whole unit exists to refuse is a silent
  // clean report, never a site reported that a human then reads and accepts in the ledger.
  return comparisonOperands(expr).some(([a, b]) => columnsIn(a).includes(FK_DISCRIMINATOR)
    && stringConstsIn(b).includes(FK_VALUE));
}

// The states `pg_trigger.tgenabled` can hold: 'O' origin, 'A' always, 'D' disabled, 'R' replica.
// A query that compares the column against something outside this alphabet is not deciding
// enforcement, whatever it is doing.
const ENABLEMENT_STATES = new Set(['D', 'R', 'O', 'A']);

/**
 * Does THIS query establish that the foreign key it is judging actually enforces?
 *
 * Two facts, both required, both resolved rather than name-matched. The first draft of this rule
 * asked only whether the column NAMES `tgenabled` and `tgconstraint` appeared in the query, and
 * Codex was right that this admits two different frauds: a guard that JOINS the right triggers and
 * then merely SELECTS `tgenabled` without rejecting anything, and a query whose `tgenabled` comes
 * from a derived table of its author's own making. Both are the linter's own defect class again —
 * evidence that resembles the claim instead of establishing it.
 */
function readsEnforcementState(tree) {
  const aliases = relationAliases(tree);
  if (![...aliases.values()].includes('pg_trigger')) return false;
  const comparisons = nodesOfType(tree, 'A_Expr');

  // (1) LINKED — these triggers are the inspected constraint's own: `tgconstraint = <constraint>.oid`.
  //     Without it the query is reading the enablement of some trigger, not of this key.
  const linked = comparisons.some((expr) => comparisonOperands(expr).some(([a, b]) =>
    referencesColumnOf(a, 'pg_trigger', 'tgconstraint', aliases)
    && referencesColumnOf(b, 'pg_constraint', 'oid', aliases)));
  if (!linked) return false;

  // (2) TESTED — the enablement value is compared against a state it can hold, so the query's
  //     result actually turns on it. `SELECT g.tgenabled` alone decides nothing and is refused.
  return comparisons.some((expr) => comparisonOperands(expr).some(([a, b]) =>
    referencesColumnOf(a, 'pg_trigger', 'tgenabled', aliases)
    && stringConstsIn(b).some((value) => ENABLEMENT_STATES.has(value))));
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

  if (readsEnforcementState(site.tree)) return [];

  return [finding('MI-001', site,
    'this query decides something about a foreign key (it reads pg_constraint and tests '
    + "contype = 'f') without asking whether that key ENFORCES. A foreign key is implemented as "
    + 'internal RI_ConstraintTrigger rows — four per key on PostgreSQL 16 — and ALTER TABLE … '
    + 'DISABLE TRIGGER ALL switches them off while leaving conname, conrelid, confrelid, contype, '
    + 'convalidated and pg_get_constraintdef byte-for-byte unchanged. A key that enforces nothing '
    + 'therefore satisfies every column read here, which is how PR #411 head a222e91 certified a '
    + "database with no containment. IN THIS QUERY, join pg_trigger on tgconstraint = the "
    + "constraint's oid and compare tgenabled against the states it can hold — reading the column "
    + 'without testing it decides nothing, and the same read in a neighbouring query does not '
    + 'answer for this one.')];
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

/**
 * The SQL this linter could not read, because it does not exist until the migration runs.
 *
 * `EXECUTE format('CREATE TRIGGER %I ON %I', …)` has no text a parser can be given. The adapter
 * refuses to hand such a fragment to the rules as though it were an ordinary query — that would be
 * a clean report about SQL nobody read — so each one is reported here instead. This is NOT an
 * exemption: `migration-lint.test.mjs` pins the exact set, so a new one fails the required
 * `automation` job and has to be looked at, and `docs/MIGRATION_INVARIANTS.md` states the limit.
 */
export function unresolvedDynamicSql({ dir = MIGRATIONS_DIR } = {}) {
  const out = [];
  for (const name of migrationNames(dir)) {
    const sql = readFileSync(join(dir, name, 'migration.sql'), 'utf8');
    for (const site of parseMigration(sql).unresolvedDynamicSql) out.push({ migration: name, ...site });
  }
  return out;
}

/**
 * Migrations merged before this linter existed, each with a written reason. Recorded, not
 * suppressed: adding one costs a visible edit that a reviewer reads. See the JSON's __README__.
 *
 * KEYED PER SITE — `"MI-001:167:5d27fbda47ce05f6"`: rule, line AND the site's fingerprint, all
 * three matching. Keying it by rule alone let one accepted site discharge every other finding of
 * that rule in the file — the ledger committing the defect the rule detects, and the THIRD
 * occurrence of that granularity defect in this unit's lineage (file-global, block-global, this).
 * The JSON's __SCHEMA__ states why BOTH halves are carried, and records the audit of every other
 * suppression path.
 */
const EXEMPTIONS_FILE = join(REPO_ROOT, 'scripts', 'migration-lint-exemptions.json');
export const EXEMPTIONS = new Map(Object.entries(JSON.parse(
  existsSync(EXEMPTIONS_FILE) ? readFileSync(EXEMPTIONS_FILE, 'utf8') : '{}',
)));

/** The key one entry must carry to suppress one finding: rule, line, and the query's fingerprint. */
export const exemptionKey = (f) => `${f.rule}:${f.line}:${f.fingerprint}`;

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
export function lintAll({ dir = MIGRATIONS_DIR, applyExemptions = true, exemptions = EXEMPTIONS } = {}) {
  const findings = [];
  const exempted = [];
  for (const name of migrationNames(dir)) {
    for (const f of lintMigration({ name, sql: readFileSync(join(dir, name, 'migration.sql'), 'utf8') })) {
      const reason = applyExemptions ? (exemptions.get(name) ?? {})[exemptionKey(f)] : undefined;
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
  for (const d of unresolvedDynamicSql()) {
    console.error(`${d.migration}/migration.sql:${d.line}  NOT READ  this statement is built at run time, so no rule could be applied to it. `
      + 'Pinned by migration-lint.test.mjs; see docs/MIGRATION_INVARIANTS.md.');
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
  const notRead = unresolvedDynamicSql().length;
  console.log(`migration-lint: clean (${n} migrations, ${RULE_IDS.length} rule${RULE_IDS.length === 1 ? '' : 's'}`
    + `${recorded > 0 ? `, ${recorded} recorded exemption${recorded === 1 ? '' : 's'}` : ''}`
    + `${notRead > 0 ? `, ${notRead} run-time-built statement${notRead === 1 ? '' : 's'} not read` : ''}`
    + `${recorded > 0 || notRead > 0 ? ' — printed above' : ''}).`);
}
