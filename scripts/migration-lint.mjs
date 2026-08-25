#!/usr/bin/env node
// MIGRATION INVARIANTS — the checks the schedule-B1 lineage spent sixteen heads rediscovering.
//
// `ActivityDependency` ran #354 → #360 → #361 → #363 → #408 → #409 → #410 → #411 → #412 → #415
// and merged only at the sixteenth head. Every round drew the same class of finding: A CHECK
// NARROWER THAN THE OBJECT IT JUDGES. Each individual fix was correct. The next round found the
// same shape somewhere new, because nothing in the repository could state the shape itself. This
// file states it, executably, before review rather than after.
//
// THE DESIGN CONSTRAINT. This is deliberately NOT a list of known-bad patterns. A grep for the
// seven fragments the B1 lineage happened to produce would be a check narrower than the object it
// judges — the exact defect it exists to catch, restated as its own implementation. So wherever
// the artifact is ENUMERABLE this file enumerates it and classifies EVERY member (MI-000), and an
// unrecognised construct FAILS rather than passing by being unmentioned. Two rules cannot be
// expressed that way — MI-003 and MI-006 — and both ship in a follow-on unit; see SCOPE below.
//
// SCOPE, AND WHY IT NARROWED DURING THE #423 CORRECTION. This unit ships what it takes to READ a
// migration TOTALLY — the lexical scanner and the enumerate-and-classify backstop (MI-000) — plus
// the one rule that judges a file purely by its own STATEMENT STRUCTURE: MI-004, a pin that looks
// set but does nothing.
//
// The four rules that interrogate CATALOG GUARDS or ANOTHER FILE ship separately:
//
//   MI-001, MI-002  the catalog-guard pair. Both read pg_constraint/pg_trigger/pg_proc inside a
//                   refusing DO block and share every piece of machinery that does it, so they are
//                   one reviewable concern and move together.
//   MI-003, MI-006  the two rules that are not purely enumerable, and the two that leave the
//                   migration file. Closing Codex F1 meant MI-003 could no longer read the RUNBOOK
//                   token as evidence a verifier ran; identifying the invocation took a SHELL
//                   PARSER for apps/api/scripts/migrate.sh. Parsing bash is not the same concern as
//                   reading PostgreSQL.
//
// ALL FOUR WERE IN THIS UNIT AT HEAD c6e9ff17, and the split is the honest consequence of the
// correction rather than a change of mind. That head measured 1,383 changed lines against a 1,500
// budget — 92% of it — so proving seven findings, four of them with two-site adjacent-decoy
// fixtures, could not fit. The seam is taken at shared machinery rather than an exception claimed
// for the size, which is what the first head did with MI-005/006/007. The per-site corrections for
// MI-001, MI-002 and MI-003 are written and proven; they travel WITH their rules.
//
// Three further classes the same lineage produced are deferred for the same reason: snapshot-vs-lock
// isolation (#412→#415 F-B), Prisma constraint-name drift (#412→#415 F-C), and diagnostic-first
// additive migrations. docs/MIGRATION_INVARIANTS.md records every deferral with its measured
// corpus evidence, so nothing is deferred silently.
//
// HOW TO ADD A RULE. Prove it RED against the real historical commit that produced the finding,
// pin that fragment in `scripts/fixtures/migration-lint/`, and cite the PR and head in the rule's
// comment. A rule that does not fire on the head that produced its finding is not implemented;
// `migration-lint.test.mjs` asserts that in both directions. Full prose: docs/MIGRATION_INVARIANTS.md.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statements, dollarBlocks, scan } from './migration-sql-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'apps', 'api', 'prisma', 'migrations');

// ── The classification vocabularies ──────────────────────────────────────────────────────────
// Derived by ENUMERATING the 1,684 top-level statements across the 91 migrations on `main`, not by
// guessing what SQL might contain — and that distinction is load-bearing, not stylistic. A first
// draft also listed CREATE VIEW, CREATE SEQUENCE, ALTER SEQUENCE, WITH, TRUNCATE, COMMENT, GRANT,
// REVOKE and ANALYZE, none of which this repository has ever used in a migration. Every one would
// have let a future construct through SILENTLY, un-reasoned-about, which is precisely the failure
// MI-000 exists to prevent. A speculative vocabulary is a check narrower than the object it judges
// wearing the opposite disguise. So the list is exactly what the corpus contains; a verb outside it
// fails as MI-000 and the author decides whether it is safe, rather than the linter by omission.

const STATEMENT_KINDS = [
  ['CREATE TABLE', /^\s*CREATE\s+TABLE\b/iu],
  ['CREATE UNIQUE INDEX', /^\s*CREATE\s+UNIQUE\s+INDEX\b/iu],
  ['CREATE INDEX', /^\s*CREATE\s+INDEX\b/iu],
  ['CREATE FUNCTION', /^\s*CREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b/iu],
  ['CREATE TRIGGER', /^\s*CREATE\s+(CONSTRAINT\s+)?TRIGGER\b/iu],
  ['CREATE TYPE', /^\s*CREATE\s+TYPE\b/iu],
  ['CREATE EXTENSION', /^\s*CREATE\s+EXTENSION\b/iu],
  ['CREATE SCHEMA', /^\s*CREATE\s+SCHEMA\b/iu],
  ['ALTER TABLE', /^\s*ALTER\s+TABLE\b/iu],
  ['ALTER TYPE', /^\s*ALTER\s+TYPE\b/iu],
  ['DROP', /^\s*DROP\s+/iu],
  ['DO', /^\s*DO\s*\$/iu],
  ['LOCK', /^\s*LOCK\s+TABLE\b/iu],
  ['SET', /^\s*SET\s+/iu],
  ['SELECT', /^\s*SELECT\s+/iu],
  ['INSERT', /^\s*INSERT\s+INTO\b/iu],
  ['UPDATE', /^\s*UPDATE\s+/iu],
  ['DELETE', /^\s*DELETE\s+FROM\b/iu],
  ['BEGIN', /^\s*BEGIN\s*;/iu],
  ['COMMIT', /^\s*COMMIT\s*;/iu],
];

// Constraint kinds, as PostgreSQL spells them in a `CONSTRAINT "name" <kind>` clause.
const CONSTRAINT_KINDS = [
  ['PRIMARY KEY', /^PRIMARY\s+KEY\b/iu],
  ['FOREIGN KEY', /^FOREIGN\s+KEY\b/iu],
  ['UNIQUE', /^UNIQUE\b/iu],
  ['CHECK', /^CHECK\b/iu],
  ['EXCLUDE', /^EXCLUDE\b/iu],
  // A column-level `REFERENCES t (c)` IS a foreign key; PostgreSQL names it and stores it in
  // pg_constraint with contype 'f' exactly as the table-level spelling does.
  ['FOREIGN KEY', /^REFERENCES\b/iu],
];

// The ROLES a `DO` block plays in this repository's migrations. Every top-level `DO` block must
// match at least one; a block matching none is MI-000, because the rules below decide what to
// ask of a block FROM its role, and a role they have never seen has never been reasoned about.
// A block's role comes from the STATEMENT THAT ENCLOSES IT first, and only then from its body.
// The first draft sniffed the body alone and left 102 blocks across 33 migrations unclassified —
// nearly all of them the body of a `CREATE OR REPLACE FUNCTION … AS $$ … $$ LANGUAGE plpgsql`,
// where `RETURNS trigger` and `LANGUAGE plpgsql` sit OUTSIDE the block and the body is four lines
// of `PERFORM`. Reading the enclosing statement classifies those exactly instead of by guesswork.
const BLOCK_ROLES = [
  // Reads the system catalogs to decide whether this file's own objects are present and canonical.
  ['catalog-guard', (body) => /\bpg_(constraint|trigger|proc|class|index|attribute|namespace|type)\b/iu.test(body)],
  // Queries USER data and ABORTS on what it finds — the repository's diagnostic-first shape.
  ['data-diagnostic', (body) => /\bRAISE\s+EXCEPTION\b/iu.test(body) && /\b(SELECT|COUNT|EXISTS)\b/iu.test(body)],
  // Queries USER data and REPORTS on it without aborting. Distinct from a diagnostic on purpose:
  // MI-007 accepts a diagnostic as the thing that stands between dirty data and an opaque DDL
  // failure, and a NOTICE stops nothing.
  ['data-report', (body) => /\bRAISE\s+NOTICE\b/iu.test(body)],
  // Emits DDL through EXECUTE, typically to make a CREATE conditional on a catalog probe.
  ['conditional-ddl', (body) => /\bEXECUTE\s+(format\s*\(|'|\$)/iu.test(body)],
  // Runs DDL directly and swallows the duplicate-object error — the idempotent `CREATE TYPE` shape.
  ['guarded-ddl', (body) => /\bEXCEPTION\s+WHEN\b/iu.test(body) && /\b(CREATE|ALTER|DROP)\s+/iu.test(body)],
  // Takes a lock.
  ['lock-acquisition', (body) => /\bLOCK\s+TABLE\b/iu.test(body)],
  // Backfills or repairs rows.
  ['data-backfill', (body) => /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b/iu.test(body)],
  // Declares a PL/pgSQL routine's body inline, for a later dynamic install.
  ['function-body', (body) => /\bRETURNS\s+TRIGGER\b|\bLANGUAGE\s+plpgsql\b/iu.test(body)],
];

function classifyStatement(masked) {
  const hit = STATEMENT_KINDS.find(([, rx]) => rx.test(masked));
  return hit ? hit[0] : null;
}

function classifyBlock(body, enclosingKind) {
  // The body of a `CREATE FUNCTION` IS the routine, whatever it happens to say. That is a fact
  // about the statement, not a guess from the text, so it is settled here rather than sniffed.
  const roles = enclosingKind === 'CREATE FUNCTION' ? ['function-body'] : [];
  for (const [name, test] of BLOCK_ROLES) if (test(body) && !roles.includes(name)) roles.push(name);
  return roles;
}

/**
 * Enumerate every constraint the file CREATES, with its kind.
 *
 * EVERY FORM, and that word is the whole point. The first head required a DOUBLE-QUOTED explicit
 * name — `CONSTRAINT "x" CHECK …` — which is Codex finding F5 against head c6e9ff17: ordinary
 * PostgreSQL that this repository's own migrations are simply not in the habit of writing
 * (`CONSTRAINT ck CHECK (a > 0)`, an inline `a int CHECK (a > 0)`, a table-level `UNIQUE (a)`)
 * produced an EMPTY inventory and therefore a clean MI-000. A backstop whose claim is TOTALITY,
 * reporting "I classified everything" about constructs it never enumerated, is the same false
 * comfort as a name standing in for a definition — one level up, in the rule that exists to stop it.
 *
 * The forms are read off PostgreSQL's own grammar rather than off this corpus, because here the
 * corpus is not the authority: the risk is precisely the syntax nobody has written YET.
 *
 *   named        `CONSTRAINT <name> <kind>`, the name quoted or not
 *   table-level  `PRIMARY KEY (…)`, `FOREIGN KEY (…)`, `UNIQUE (…)`, `CHECK (…)`, `EXCLUDE …`
 *   column-level the same keywords after a column definition, plus a bare `REFERENCES t (c)`
 *
 * The alternation is ordered so the named form consumes its own kind keyword, and a `REFERENCES`
 * belonging to a FOREIGN KEY clause is consumed by that clause — otherwise one constraint would be
 * counted twice, and an inventory that over-counts is no more honest than one that under-counts.
 */
export function constraintsCreated(sql) {
  const { mask, lineOf } = scan(sql);
  const out = [];
  const rx = new RegExp(
    // (1) the named form — quoted or unquoted name, then the kind
    '\\bCONSTRAINT\\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))'
      + '\\s+(PRIMARY\\s+KEY|FOREIGN\\s+KEY|UNIQUE|CHECK|EXCLUDE)\\b'
    // (2) the implicitly named form — the kind keyword standing alone
    + '|\\b(PRIMARY\\s+KEY|FOREIGN\\s+KEY|UNIQUE(?!\\s+INDEX)|CHECK|EXCLUDE|REFERENCES)\\b',
    'giu',
  );
  let m;
  let skipNextReferences = false;
  while ((m = rx.exec(mask)) !== null) {
    const named = m[3] !== undefined;
    const raw = (named ? m[3] : m[4]).trim();

    // `DROP CONSTRAINT x`, `RENAME CONSTRAINT` and `VALIDATE CONSTRAINT` are not creations. The
    // named branch already cannot match `DROP CONSTRAINT x` (no kind follows), but `ALTER TABLE …
    // DROP CONSTRAINT x, ADD CONSTRAINT y CHECK …` puts them in one statement, so this still reads.
    const before = mask.slice(Math.max(0, m.index - 24), m.index);
    if (named && /\b(DROP|RENAME|VALIDATE)\s+$/iu.test(before)) continue;

    // `FOREIGN KEY (cols) REFERENCES t (c)` is ONE constraint. Its `REFERENCES` is consumed here so
    // the standalone branch does not count the same clause a second time.
    if (raw.toUpperCase().replace(/\s+/u, ' ') === 'REFERENCES') {
      if (skipNextReferences) { skipNextReferences = false; continue; }
    }
    const kind = CONSTRAINT_KINDS.find(([, k]) => k.test(raw));
    skipNextReferences = kind?.[0] === 'FOREIGN KEY';

    out.push({
      // An implicitly named constraint has no name in the source; PostgreSQL derives one at
      // execution time. `null` says so rather than inventing a name the file does not contain.
      name: named ? (m[1] ?? m[2]) : null,
      kind: kind ? kind[0] : null,
      raw,
      line: lineOf(m.index),
      offset: m.index,
    });
  }
  return out;
}

// ── Findings ─────────────────────────────────────────────────────────────────────────────────

const finding = (rule, line, message) => ({ rule, line, message });

/**
 * MI-000 — an unclassified construct. Not a lineage finding; it is the property that keeps the
 * other seven honest. A linter that silently ignores what it does not recognise reports "clean" on
 * a file it did not read — the same false comfort as a name standing in for a definition.
 */
function ruleUnclassified(file) {
  const out = [];
  for (const s of file.statements) {
    if (!s.kind) {
      out.push(finding('MI-000', s.line,
        `unclassified top-level statement: "${s.masked.trim().replace(/\s+/gu, ' ').slice(0, 70)}…". Every rule `
        + 'decides what to ask of a statement from its kind, and this kind has never been reasoned about here. '
        + 'Add it to STATEMENT_KINDS once you have decided which rules apply to it.'));
    }
  }
  for (const c of file.constraints) {
    if (!c.kind) {
      out.push(finding('MI-000', c.line,
        `constraint ${c.name ? `"${c.name}"` : `(implicitly named) at line ${c.line}`} has an `
        + `unclassified kind ("${c.raw}"). MI-006 and MI-007 branch on `
        + 'constraint kind; an unknown kind would be skipped by both in silence.'));
    }
  }
  for (const b of file.blocks) {
    if (b.roles.length === 0) {
      out.push(finding('MI-000', b.line,
        `the DO block at line ${b.line} matches no known role. MI-001/003/005/007 each ask a different `
        + 'question of a guard than of a backfill, so an unrecognised block is checked by none. Classify '
        + 'it in BLOCK_ROLES.'));
    }
  }
  return out;
}

/**
 * MI-004 — `SET LOCAL` or `LOCK TABLE` outside an explicit transaction block.
 *
 * RED at `c1054005` (PR #410) line 108: a bare top-level `SET LOCAL search_path = public;` after
 * the file's `BEGIN;`/`COMMIT;` were removed one head earlier. PostgreSQL only WARNS, so the pin
 * was INERT and every unqualified `REFERENCES "Project"` bound through the caller's path —
 * measured there with a path of `b1decoy,public`: exit 0, all five keys in `b1decoy`, no
 * containment. GREEN at `2f0e2af9` (PR #415). That head's own comment called the hazard out and it
 * shipped anyway, written as something to WATCH FOR rather than enforced. This is the enforcement.
 *
 * WHICH CALLER — `prisma migrate deploy` is NOT at risk; B1 measured that the schema engine sends
 * the script to a connection ALREADY in a transaction (migration.sql:75-79). The exposure is the
 * caller supplying none, which AGENTS.md requires these files to tolerate. Under it `SET LOCAL` is
 * a silent no-op and `LOCK TABLE` a hard error; the message says which, and silence is the worse.
 */
function ruleInertTransactionScoped(file) {
  const out = [];
  // TRANSACTION DEPTH IN STATEMENT ORDER. Codex F4 against head c6e9ff17: this asked
  // `file.statements.some(s => s.kind === 'BEGIN')` — a question about the FILE, blind to position
  // and to order — so ANY `BEGIN` anywhere accepted EVERY top-level `SET LOCAL` and `LOCK TABLE`,
  // including one after the matching COMMIT and including one whose `BEGIN` appears LATER in the
  // file. `BEGIN; … COMMIT; SET LOCAL search_path = public;` reported clean while that pin was as
  // inert as the c1054005 head's. Each scoped statement is now judged where it actually stands.
  let depth = 0;
  for (const s of file.statements) {
    if (s.kind === 'BEGIN') { depth += 1; continue; }
    if (s.kind === 'COMMIT') { depth = Math.max(0, depth - 1); continue; }
    const isSetLocal = /^\s*SET\s+LOCAL\b/iu.test(s.masked);
    const isLock = s.kind === 'LOCK';
    if (!isSetLocal && !isLock) continue;
    if (depth > 0) continue;
    out.push(finding('MI-004', s.line,
      `${isSetLocal ? '`SET LOCAL`' : '`LOCK TABLE`'} at top level, OUTSIDE any explicit transaction `
      + 'block — this statement does not stand between a `BEGIN` and its `COMMIT`. '
      + '`prisma migrate deploy` does supply one (measured — see '
      + '20270930000000_schedule_dependency_graph/migration.sql:75-79), but AGENTS.md requires these '
      + 'files to tolerate a caller that supplies NO transaction, and under that caller '
      + (isSetLocal
        ? 'this is a WARNING that silently changes nothing. PR #410 head c1054005 shipped a top-level '
          + '`SET LOCAL search_path` that was inert for exactly that reason, and all five foreign keys '
          + 'bound through the caller\'s search path instead — measured with a path of `b1decoy,public`: '
          + 'exit 0, no containment at all. Use a plain `SET` with an explicit set_config save/restore.'
        : 'this is a HARD ERROR ("LOCK TABLE can only be used in transaction blocks"), so the migration '
          + 'refuses to apply at all. Wrap it as `DO $$ BEGIN LOCK TABLE … ; END $$;` — a DO block is its '
          + 'own transaction — which is what 20270930000000_schedule_dependency_graph does at line 1245.')));
  }
  return out;
}

const RULES = [
  ['MI-000', ruleUnclassified],
  ['MI-004', ruleInertTransactionScoped],
];

export const RULE_IDS = RULES.map(([id]) => id);

/** Parse one migration into the inventories the rules read. */
export function parseMigration(sql) {
  const { mask, lineOf } = scan(sql);
  const stmts = statements(sql).map((s) => ({ ...s, kind: classifyStatement(s.masked) }));
  const blocks = dollarBlocks(sql)
    .filter((b) => b.depth === 0)
    .map((b) => {
      const enclosing = stmts.find((s) => b.start >= s.start && b.end <= s.end);
      return {
        ...b,
        line: lineOf(b.start),
        maskedBody: mask.slice(b.bodyStart, b.bodyEnd),
        enclosingKind: enclosing?.kind ?? null,
        roles: classifyBlock(b.body, enclosing?.kind ?? null),
      };
    });
  return {
    sql,
    masked: mask,
    lineOf,
    statements: stmts,
    blocks,
    constraints: constraintsCreated(sql),
  };
}

/** Lint one migration. Every rule this unit ships answers from the migration file alone; the
 *  cross-file `context` the deferred MI-003/MI-006 need arrives with them. */
export function lintMigration({ name, sql, context = {} }) {
  const file = parseMigration(sql);
  const findings = [];
  for (const [, rule] of RULES) findings.push(...rule(file, context));
  return findings.map((f) => ({ ...f, migration: name })).sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Migrations merged before this linter existed, each with a written reason. Recorded, not
 *  suppressed: adding one costs a visible edit that a reviewer reads. See the JSON's __README__. */
export const EXEMPTIONS = new Map(Object.entries(JSON.parse(
  existsSync(join(REPO_ROOT, 'scripts', 'migration-lint-exemptions.json'))
    ? readFileSync(join(REPO_ROOT, 'scripts', 'migration-lint-exemptions.json'), 'utf8')
    : '{}',
)));

export function lintAll({ root = REPO_ROOT, dir = MIGRATIONS_DIR, applyExemptions = true } = {}) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'migration.sql');
    if (!existsSync(file)) continue;
    const findings = lintMigration({ name, sql: readFileSync(file, 'utf8') });
    for (const f of findings) {
      const exempt = applyExemptions && (EXEMPTIONS.get(name) ?? {})[f.rule];
      if (exempt) continue;
      out.push(f);
    }
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = lintAll();
  for (const f of findings) {
    console.error(`${f.migration}/migration.sql:${f.line}  ${f.rule}  ${f.message}`);
  }
  const migrations = new Set(findings.map((f) => f.migration));
  if (findings.length > 0) {
    console.error(`\nmigration-lint: ${findings.length} finding(s) across ${migrations.size} migration(s).`);
    console.error('Each rule is explained at its definition in scripts/migration-lint.mjs, with the PR');
    console.error('and head whose finding produced it. See docs/MIGRATION_INVARIANTS.md.');
    process.exit(1);
  }
  console.log(`migration-lint: clean (${readdirSync(MIGRATIONS_DIR).filter((n) => existsSync(join(MIGRATIONS_DIR, n, 'migration.sql'))).length} migrations, ${RULE_IDS.length} rules).`);
}
