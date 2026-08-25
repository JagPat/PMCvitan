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
// expressed that way — MI-003 here, and MI-006 in the follow-on unit — and each says why.
//
// SCOPE. This unit ships the four rules that share ONE shape: A PROTECTION THAT IS PRESENT BUT
// INERT — a check that looks like it verifies (MI-001), a key that looks valid but does not
// enforce (MI-002), a guard that looks installed but is never re-asked (MI-003), a pin that
// looks set but does nothing (MI-004). All four come from the #410 and #411→#412 rounds.
// Three further classes the same lineage produced are DIFFERENT concerns and ship separately
// rather than pushing this unit past the 1,500-line review budget: snapshot-vs-lock isolation
// (#412→#415 F-B), Prisma constraint-name drift (#412→#415 F-C), and diagnostic-first additive
// migrations. docs/MIGRATION_INVARIANTS.md records all three with their measured evidence.
//
// HOW TO ADD A RULE. Prove it RED against the real historical commit that produced the finding,
// pin that fragment in `scripts/fixtures/migration-lint/`, and cite the PR and head in the rule's
// comment. A rule that does not fire on the head that produced its finding is not implemented;
// `migration-lint.test.mjs` asserts that in both directions. Full prose: docs/MIGRATION_INVARIANTS.md.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statements, dollarBlocks, scan, literals } from './migration-sql-scan.mjs';

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

// Functions that read an object's DEFINITION rather than its name.
const DEFINITION_READS = /\b(pg_get_constraintdef|pg_get_triggerdef|pg_get_indexdef|pg_get_functiondef|pg_get_expr|prosrc)\b/iu;

// Resolving a catalog object BY NAME.
const NAME_RESOLUTIONS = [
  ['pg_constraint', /\bconname\s*(=|IN\b)/iu, /\b(pg_get_constraintdef|conbin)\b/iu],
  ['pg_trigger', /\btgname\s*(=|IN\b)/iu, /\b(pg_get_triggerdef)\b/iu],
  ['pg_proc', /\bproname\s*(=|IN\b)/iu, /\b(prosrc|pg_get_functiondef)\b/iu],
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
 * Enumerate every constraint the file CREATES, with its kind. Covers both the inline form
 * (`CONSTRAINT "x" FOREIGN KEY …` inside a CREATE TABLE) and the added form
 * (`ADD CONSTRAINT "x" CHECK …`).
 */
export function constraintsCreated(sql) {
  const { mask, lineOf } = scan(sql);
  const out = [];
  const rx = /\bCONSTRAINT\s+"([^"]+)"\s+([A-Za-z]+(?:\s+[A-Za-z]+)?)/giu;
  let m;
  while ((m = rx.exec(mask)) !== null) {
    // `DROP CONSTRAINT "x"` and `RENAME CONSTRAINT` are not creations.
    const before = mask.slice(Math.max(0, m.index - 24), m.index);
    if (/\b(DROP|RENAME|VALIDATE)\s+$/iu.test(before)) continue;
    const tail = m[2];
    const kind = CONSTRAINT_KINDS.find(([, k]) => k.test(tail));
    out.push({ name: m[1], kind: kind ? kind[0] : null, raw: tail.trim(), line: lineOf(m.index), offset: m.index });
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
        `constraint "${c.name}" has an unclassified kind ("${c.raw}"). MI-006 and MI-007 branch on `
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
 * MI-001 — an object judged by NAME where a definition comparison exists.
 *
 * RED at `a222e91` (PR #411). Section 1g looked the install barrier up by `conname` and read its
 * PRESENCE as "this table is unwritable, so it cannot have acquired a row":
 *
 *     SELECT pg_get_constraintdef(k.oid) INTO v_barrier
 *       FROM pg_constraint k WHERE k.conname = 'ActivityDependency_install_incomplete_check' …;
 *     IF v_barrier IS NOT NULL THEN … 'the install barrier is still in place' … END IF;
 *
 * The definition was FETCHED and never COMPARED — only NULL-tested — so a same-named hollow
 * `CHECK (true)` satisfied it while admitting every INSERT. GREEN at `96c9cc4` (PR #412). The shape
 * returned as #415's finding F-A (RED `96c9cc4`, GREEN `2f0e2af9`). Detection is in two halves
 * because the first head defeats the obvious one: (b) below is what catches `a222e91`, which DID
 * call pg_get_constraintdef.
 */
function ruleNameOverDefinition(file) {
  const out = [];

  // (a) asks of the FILE and only of guards that REFUSE. Per-block flags the B1 guard's own split
  // (1g is a presence census, 8 holds the comparison) on every head including the merged one;
  // unscoped by refusal it flagged the create-if-absent idiom in seventeen merged migrations, where
  // a wrong object yields a duplicate-name error rather than a false clearance. Measured both ways.
  const refusingGuards = file.blocks.filter((b) => b.roles.includes('catalog-guard') && /\bRAISE\s+EXCEPTION\b/iu.test(b.maskedBody));
  for (const [catalog, byName, defRead] of NAME_RESOLUTIONS) {
    const site = refusingGuards.find((b) => byName.test(b.maskedBody)
      // A `pg_catalog` function resolved by name is a BUILT-IN with no definition to compare —
      // `prosrc` for a C function is the linker symbol, not a body. Schema + name is the correct
      // pin, which is what MI-002's GREEN form does; demanding `prosrc` would be meaningless.
      && !(catalog === 'pg_proc' && /\bnspname\s*=\s*'/iu.test(b.maskedBody)
           && file.literalsIn(b.bodyStart, b.bodyEnd).some((l) => l.value === 'pg_catalog')));
    if (!site) continue;
    if (defRead.test(file.masked)) continue;
    out.push(finding('MI-001', site.line,
      `this migration resolves a ${catalog} object by NAME inside a guard that REFUSES on what it finds, and `
      + 'never reads that object\'s DEFINITION anywhere. A same-named object with another definition satisfies '
      + 'a name test while meaning something else — PR #411 head a222e91 read a hollow CHECK (true) as proof '
      + `the table was unwritable. Compare it with ${catalog === 'pg_proc' ? 'prosrc' : `pg_get_${catalog.replace('pg_', '')}def`}.`));
  }

  for (const b of file.blocks) {
    if (!b.roles.includes('catalog-guard')) continue;
    const body = b.maskedBody;

    // (b) A definition fetched INTO a variable that is only ever NULL-tested is a presence test
    // wearing a definition test's clothes. This is the `a222e91` shape exactly, and it is the half
    // that matters: (a) alone passes that head, because the head DID call pg_get_constraintdef —
    // it simply never compared what came back.
    const intoRx = /\bINTO\s+((?:STRICT\s+)?[A-Za-z_][A-Za-z0-9_]*)/giu;
    let m;
    while ((m = intoRx.exec(body)) !== null) {
      const variable = m[1].replace(/^STRICT\s+/iu, '');
      const selectStart = body.lastIndexOf('SELECT', m.index);
      if (selectStart === -1) continue;
      const selectList = body.slice(selectStart, m.index);
      if (!DEFINITION_READS.test(selectList)) continue;

      const uses = [...body.matchAll(new RegExp(`\\b${variable}\\b`, 'giu'))].filter((u) => u.index !== m.index + m[0].indexOf(variable));
      const compared = uses.some((u) => {
        const after = body.slice(u.index + variable.length, u.index + variable.length + 40);
        const before = body.slice(Math.max(0, u.index - 40), u.index);
        const nullTest = /^\s*IS\s+(NOT\s+)?NULL\b/iu.test(after);
        if (nullTest) return false;
        return /^\s*(=|<>|!=|~|!~|\|\|)/u.test(after) || /(=|<>|!=)\s*$/u.test(before);
      });
      if (!compared) {
        out.push(finding('MI-001', b.line + countLines(body.slice(0, m.index)),
          `"${variable}" receives an object DEFINITION and is then only tested for NULL. That is a `
          + 'presence check with a definition read in front of it: the object is judged by the NAME '
          + 'that found it, not by what it says. PR #411 head a222e91 shipped exactly this and a '
          + 'hollow CHECK (true) of the right name passed. Compare the value.'));
      }
    }
  }
  return out;
}

/**
 * MI-002 — a foreign key asserted VALID without asserting it ENFORCES.
 *
 * RED at `a222e91` (PR #411): five keys compared by `conname`, `contype='f'`, `conrelid` and the
 * `confrelid` OID — none of which decides whether the key ACTS. `ALTER TABLE … DISABLE TRIGGER ALL`
 * leaves every one of those catalog rows intact and identical while the key enforces nothing, which
 * is precisely what a restore can leave behind. GREEN at `96c9cc4` (PR #412), which reads
 * `pg_trigger.tgenabled` on `tgconstraint` for each key's four internal triggers.
 */
function ruleForeignKeyEnforcement(file) {
  // `contype = 'f'` SPECIFICALLY. The literal is blanked in the mask, so the value is resolved by
  // POSITION against the literal table rather than by asking whether the file contains an 'f'
  // anywhere — a first draft did the latter and flagged 20270225000000_phase4_t3_correction3, whose
  // verification asks `contype = 'c'` about CHECK constraints and has no foreign keys in it at all.
  const body = file.masked;
  const site = [...body.matchAll(/\bcontype\s*=\s*'/giu)]
    .map((m) => ({ quote: m.index + m[0].length - 1, index: m.index }))
    .find(({ quote }) => file.literalsIn(quote, quote + 1).some((l) => l.value === 'f'));
  if (!site) return [];
  if (/\btgconstraint\b/iu.test(body) && /\btgenabled\b/iu.test(body)) return [];
  const line = file.lineOf(site.index);
  return [finding('MI-002', line,
    'this migration verifies foreign keys through pg_constraint (contype = \'f\') without ever reading '
    + 'pg_trigger.tgenabled on tgconstraint. Every column in pg_constraint — including convalidated and '
    + 'the confrelid OID — survives ALTER TABLE … DISABLE TRIGGER ALL unchanged, so a key that enforces '
    + 'nothing passes this check intact. PR #411 head a222e91 verified five keys this way; PR #412 head '
    + '96c9cc4 added the enforcement read. Join pg_trigger on tgconstraint and refuse tgenabled in (D, R).')];
}

/**
 * MI-003 — a guard checked only at apply time.
 *
 * RED at `a222e91` (PR #411): five seals were verified in a block that ran ONLY while the migration
 * was applied. Once the row was in `_prisma_migrations`, `migrate.sh` returned 0 after checking
 * unrelated seals (T45, T2C, T3C), so a restore that disabled a B1 seal produced a GREEN deploy
 * over a database whose guards were gone. GREEN at `96c9cc4` (PR #412), which invoked
 * `node "$B1_SEALS" seals` on the deploy success path — the shape T45/T2C/T3C already had.
 *
 * NOT PURELY ENUMERABLE, and the reason is the finding itself: nothing in a migration's SQL names
 * the verifier that should re-ask its question on every deploy. See the link comment below.
 */
function ruleApplyTimeOnly(file, context) {
  // In scope: a migration that INSTALLS SEALS — trigger guards that refuse writes — and verifies
  // them against the catalog. A migration that only diagnoses data has nothing to stay armed.
  // Seals arrive two ways in this repository and both count. A plain top-level `CREATE TRIGGER`
  // is one; the other — the shape the whole B1 lineage uses — is dynamic DDL, where the statement
  // lives in a string literal handed to `EXECUTE` so the CREATE can be made conditional on a
  // catalog probe. Counting only the first found no seals in the file that produced this finding.
  const dynamicSeal = /\bCREATE\s+(CONSTRAINT\s+)?TRIGGER\b/iu;
  const installsSeals = file.statements.some((s) => s.kind === 'CREATE TRIGGER')
    || file.literalValues.some((v) => dynamicSeal.test(v));
  const selfVerifies = file.blocks.some((b) => b.roles.includes('catalog-guard') && /\bRAISE\s+EXCEPTION\b/iu.test(b.maskedBody));
  if (!installsSeals || !selfVerifies) return [];

  // THE LINK, and why it is read rather than invented. `migrate.sh` names each verifier's repair
  // procedure — `docs/RUNBOOK.md §T45`, `§P4T3C3`, `section B1` — and so does the migration that
  // installs it. That shared token is the only machine-readable connection between a migration and
  // its deploy-time counterpart that this repository already has, so the rule reads it instead of
  // requiring a new annotation on 92 merged files. A migration using no RUNBOOK procedure may
  // declare the link explicitly with `-- migration-invariants: deploy-verifier <token>`.
  const explicit = /--\s*migration-invariants:\s*deploy-verifier\s+(\S+)/iu.exec(file.sql);
  const tokens = explicit
    ? [explicit[1]]
    : [...new Set([...file.sql.matchAll(/RUNBOOK\.md`?\s+(§[A-Za-z0-9]+|section\s+[A-Za-z0-9]+)/gu)].map((m) => m[1].replace(/\s+/u, ' ')))];

  const line = file.statements.find((s) => s.kind === 'CREATE TRIGGER')?.line
    ?? file.blocks.find((b) => b.roles.includes('catalog-guard'))?.line ?? 1;
  const advice = 'Once the migration row is in _prisma_migrations its verification is never asked '
    + 'again, so a restore or an ALTER TABLE … DISABLE TRIGGER that removes a seal yields a GREEN '
    + 'deploy over a database whose guards are gone — PR #411 head a222e91 shipped exactly that, and '
    + 'PR #412 head 96c9cc4 added `node "$B1_SEALS" seals` on the deploy success path. T45, T2C and '
    + 'T3C are three worked precedents in apps/api/scripts/migrate.sh.';

  if (tokens.length === 0) {
    return [finding('MI-003', line,
      'this migration installs seals and verifies them, but names no procedure that ties it to a '
      + `deploy-time counterpart. ${advice} Name the repair procedure (docs/RUNBOOK.md §X) in this `
      + 'file and in migrate.sh, or declare `-- migration-invariants: deploy-verifier <token>`.')];
  }

  // COMMENT LINES ARE STRIPPED FIRST, and this is not a detail. At PR #411 head a222e91 the string
  // "docs/RUNBOOK.md section B1" already appeared in migrate.sh AFTER the deploy — inside a comment
  // explaining an unrelated migration-resolution branch. A rule that searched the raw text found it
  // and reported the head GREEN, which is the same failure the rule is about: a token matched where
  // an ACT was required. Only executable lines count as an invocation.
  const migrateSh = context.migrateSh ?? '';
  const executable = migrateSh.split('\n').filter((l) => !/^\s*#/u.test(l)).join('\n');
  const deployAt = executable.search(/^\s*(out=\$\()?\s*(npx\s+)?prisma\s+migrate\s+deploy/mu);
  const afterDeploy = deployAt === -1 ? '' : executable.slice(deployAt);
  if (tokens.some((t) => afterDeploy.includes(t))) return [];

  if (tokens.some((t) => migrateSh.includes(t))) {
    return [finding('MI-003', line,
      `apps/api/scripts/migrate.sh names ${tokens.map((t) => `"${t}"`).join(' / ')} only BEFORE `
      + '`prisma migrate deploy`. A preflight runs against the database as it WAS, not as the deploy '
      + `left it, so it cannot answer whether the seals are armed now. ${advice}`)];
  }
  return [finding('MI-003', line,
    `this migration installs seals under procedure ${tokens.map((t) => `"${t}"`).join(' / ')}, which `
    + `apps/api/scripts/migrate.sh never invokes. ${advice}`)];
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
  const opensTransaction = file.statements.some((s) => s.kind === 'BEGIN');
  for (const s of file.statements) {
    const isSetLocal = /^\s*SET\s+LOCAL\b/iu.test(s.masked);
    const isLock = s.kind === 'LOCK';
    if (!isSetLocal && !isLock) continue;
    if (opensTransaction) continue;
    out.push(finding('MI-004', s.line,
      `${isSetLocal ? '`SET LOCAL`' : '`LOCK TABLE`'} at top level in a file that opens no explicit `
      + 'transaction block. `prisma migrate deploy` does supply one (measured — see '
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
  ['MI-001', ruleNameOverDefinition],
  ['MI-002', ruleForeignKeyEnforcement],
  ['MI-003', ruleApplyTimeOnly],
  ['MI-004', ruleInertTransactionScoped],
];

export const RULE_IDS = RULES.map(([id]) => id);

function countLines(text) {
  let n = 0;
  for (const ch of text) if (ch === '\n') n += 1;
  return n;
}

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
  const lits = literals(sql);
  return {
    sql,
    masked: mask,
    lineOf,
    statements: stmts,
    blocks,
    constraints: constraintsCreated(sql),
    literalValues: lits.map((l) => l.value),
    literalsIn: (from, to) => lits.filter((l) => l.start >= from && l.start < to),
  };
}

/** Lint one migration. `context` supplies the cross-file facts MI-003 and MI-006 need. */
export function lintMigration({ name, sql, context = {} }) {
  const file = parseMigration(sql);
  const findings = [];
  for (const [, rule] of RULES) findings.push(...rule(file, context));
  return findings.map((f) => ({ ...f, migration: name })).sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Read the repository-level context once, for every migration in a run. */
export function repoContext(root = REPO_ROOT) {
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : '');
  return {
    migrateSh: read('apps/api/scripts/migrate.sh'),
    prismaSchema: read('apps/api/prisma/schema.prisma'),
  };
}

/** Migrations merged before this linter existed, each with a written reason. Recorded, not
 *  suppressed: adding one costs a visible edit that a reviewer reads. See the JSON's __README__. */
export const EXEMPTIONS = new Map(Object.entries(JSON.parse(
  existsSync(join(REPO_ROOT, 'scripts', 'migration-lint-exemptions.json'))
    ? readFileSync(join(REPO_ROOT, 'scripts', 'migration-lint-exemptions.json'), 'utf8')
    : '{}',
)));

export function lintAll({ root = REPO_ROOT, dir = MIGRATIONS_DIR, applyExemptions = true } = {}) {
  const context = repoContext(root);
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'migration.sql');
    if (!existsSync(file)) continue;
    const findings = lintMigration({ name, sql: readFileSync(file, 'utf8'), context });
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
