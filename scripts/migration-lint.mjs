#!/usr/bin/env node
// MIGRATION INVARIANTS — the checks the schedule-B1 lineage spent sixteen heads rediscovering.
//
// `ActivityDependency` ran #354 → #360 → #361 → #363 → #408 → #409 → #410 → #411 → #412 → #415
// and merged only at the sixteenth head. Every round drew the same class of finding: A CHECK
// NARROWER THAN THE OBJECT IT JUDGES. Each individual fix was correct. The next round found the
// same shape somewhere new, because nothing in the repository could state the shape itself. This
// file states it, executably, before review rather than after.
//
// THIS UNIT SHIPS THE THREE RULES THAT DETECT THAT CLASS DIRECTLY:
//
//   MI-001  an object judged by NAME where a definition comparison was required
//   MI-002  a foreign key verified VALID without ever being asked whether it ENFORCES
//   MI-003  a guard verified at APPLY time and never asked again on any later deploy
//
// They are the reason the unit exists, and they are what found the two latent defects on already
// merged migrations recorded in docs/MIGRATION_INVARIANTS.md. Shipping them first means the
// follow-up units that fix those defects land with a CI backstop that proves the fix holds.
//
// WHAT IS DEFERRED, AND WHERE IT LIVES. MI-000 (the enumerate-and-classify totality backstop) and
// MI-004 (transaction scope) are deferred to the follow-on unit. They are genuinely foundational,
// which is what makes deferring them defensible: they are about THIS LINTER'S OWN HONESTY rather
// than about the historical failure mode, and they lose nothing by landing second. Their corrected
// per-site implementations, their fixtures and their exemption ledger entries are NOT re-derivable
// prose — they are committed code at `a8b401ba` on this branch, the head this one replaces, and
// docs/MIGRATION_INVARIANTS.md records exactly what state each was left in with its RED/GREEN
// evidence. The follow-on starts from corrected code and does not rediscover Codex F4, F5 or F6/F7.
//
// THE SCANNER SHIPS HERE REGARDLESS OF THE CUT, and that is deliberate. Every rule's correctness
// rests on `migration-sql-scan.mjs` identifying statements and blocks correctly; two of the seven
// Codex findings against head c6e9ff17 were scanner desyncs (F6, dollar-tag recognition inside
// block comments; F7, a backslash escape ending an E-string early). Shipping the valuable rules on
// an unfixed scanner would put them on top of the thing that just produced two findings.
//
// THE DESIGN CONSTRAINT. This is deliberately NOT a list of known-bad patterns. A grep for the
// seven fragments the B1 lineage happened to produce would be a check narrower than the object it
// judges — the exact defect it exists to catch, restated as its own implementation. So wherever
// the artifact is ENUMERABLE this file enumerates it and classifies EVERY member, and the rules
// navigate by that classification rather than by pattern-matching raw text.
//
// EVERY RULE IS BOUND TO ITS RESOLUTION SITE. Codex returned seven findings against head c6e9ff17
// and four of them were ONE defect, one meta-level up from this linter's own subject: a FILE-GLOBAL
// TEST STANDING IN FOR A PER-SITE CHECK. "A check narrower than the object it judges" and "a check
// wider than the site it judges" are the same error wearing opposite clothes — in both, the
// evidence and the claim are about different things. Evidence now counts only within the site it
// was found in, and every site is judged.
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
// have let a future construct through SILENTLY, un-reasoned-about.
//
// MI-000 — the rule that FAILS on a verb outside this list rather than skipping it — is deferred
// with its corrected implementation at a8b401ba. Until it lands, an unrecognised statement kind is
// `null` and the rules below simply do not ask anything of it. That is a real gap and it is stated
// here rather than hidden: `migration-lint.test.mjs` still asserts totality over the corpus, so a
// new construct fails `pnpm test:automation`, but it does NOT fail `pnpm lint:migrations`.

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

// The ROLES a `DO` block plays in this repository's migrations. MI-001 and MI-003 decide what to
// ask of a block FROM its role, so a role they have never seen has never been reasoned about.
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
  // Queries USER data and REPORTS on it without aborting.
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

function countLines(text) {
  let n = 0;
  for (const ch of text) if (ch === '\n') n += 1;
  return n;
}

// ── Findings ─────────────────────────────────────────────────────────────────────────────────

const finding = (rule, line, message) => ({ rule, line, message });

// Each catalog this repository resolves objects by name in, with the read that would compare the
// object's DEFINITION rather than merely confirm the name found something.
const NAME_RESOLUTIONS = [
  ['pg_constraint', /\bconname\s*=/iu, /\bpg_get_constraintdef\b/iu],
  ['pg_trigger', /\btgname\s*=/iu, /\bpg_get_triggerdef\b/iu],
  ['pg_proc', /\bproname\s*=/iu, /\bprosrc\b|\bpg_get_functiondef\b/iu],
];

const DEFINITION_READS = /\bpg_get_(constraintdef|triggerdef|functiondef|indexdef|expr)\b|\bprosrc\b/iu;

/**
 * MI-001 — an object judged by NAME where a definition comparison was required.
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
 * call pg_get_constraintdef — it simply never compared what came back.
 */
function ruleNameOverDefinition(file) {
  const out = [];
  // Only guards that REFUSE. Unscoped by refusal this flagged the create-if-absent idiom in
  // seventeen merged migrations, where a wrong object yields a duplicate-name error rather than a
  // false clearance. Measured both ways.
  const refusingGuards = file.blocks.filter((b) => b.roles.includes('catalog-guard')
    && /\bRAISE\s+EXCEPTION\b/iu.test(b.maskedBody));

  // (a) A NAME RESOLUTION WITH NO DEFINITION READ IN THE SAME GUARD.
  //
  // CODEX F2 AGAINST HEAD c6e9ff17. This took ONE site per catalog with `.find()` and then asked
  // `defRead.test(file.masked)` — a question about the whole FILE. So a single guard that compared
  // a definition anywhere discharged the requirement at EVERY OTHER GUARD in the file, and one
  // correct neighbour shielded an arbitrary number of defective ones. In the B1 migration exactly
  // that happened: section 8's `pg_get_triggerdef` excused sections 1 and 9, which resolve triggers
  // by `tgname` and compare nothing. The evidence and the claim were about different objects.
  for (const b of refusingGuards) {
    for (const [catalog, byName, defRead] of NAME_RESOLUTIONS) {
      if (!byName.test(b.maskedBody)) continue;
      // A `pg_catalog` function resolved by name is a BUILT-IN with no definition to compare —
      // `prosrc` for a C function is the linker symbol, not a body. Schema + name is the correct
      // pin; demanding `prosrc` would be meaningless.
      if (catalog === 'pg_proc' && /\bnspname\s*=\s*'/iu.test(b.maskedBody)
        && file.literalsIn(b.bodyStart, b.bodyEnd).some((l) => l.value === 'pg_catalog')) continue;
      if (defRead.test(b.maskedBody)) continue;
      out.push(finding('MI-001', b.line,
        `this guard resolves a ${catalog} object by NAME and REFUSES on what it finds, without reading that `
        + 'object\'s DEFINITION anywhere IN THIS GUARD. A same-named object with another definition satisfies '
        + 'a name test while meaning something else — PR #411 head a222e91 read a hollow CHECK (true) as proof '
        + `the table was unwritable. Compare it with ${catalog === 'pg_proc' ? 'prosrc' : `pg_get_${catalog.replace('pg_', '')}def`} `
        + 'HERE. A comparison in a different block does not answer for this one.'));
    }
  }

  // (b) A DEFINITION FETCHED INTO A VARIABLE THAT IS ONLY EVER NULL-TESTED — a presence test
  // wearing a definition test's clothes. This is the `a222e91` shape exactly, and it is the half
  // that matters: (a) alone passes that head, because the head DID call pg_get_constraintdef.
  // This half was already bound to the block that declares the variable and needed no correction.
  for (const b of file.blocks) {
    if (!b.roles.includes('catalog-guard')) continue;
    const body = b.maskedBody;
    const intoRx = /\bINTO\s+((?:STRICT\s+)?[A-Za-z_][A-Za-z0-9_]*)/giu;
    let m;
    while ((m = intoRx.exec(body)) !== null) {
      const variable = m[1].replace(/^STRICT\s+/iu, '');
      const selectStart = body.lastIndexOf('SELECT', m.index);
      if (selectStart === -1) continue;
      const selectList = body.slice(selectStart, m.index);
      if (!DEFINITION_READS.test(selectList)) continue;

      const uses = [...body.matchAll(new RegExp(`\\b${variable}\\b`, 'giu'))]
        .filter((u) => u.index !== m.index + m[0].indexOf(variable));
      const compared = uses.some((u) => {
        const after = body.slice(u.index + variable.length, u.index + variable.length + 40);
        const before = body.slice(Math.max(0, u.index - 40), u.index);
        if (/^\s*IS\s+(NOT\s+)?NULL\b/iu.test(after)) return false;
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
  const out = [];
  // `contype = 'f'` SPECIFICALLY. The literal is blanked in the mask, so the value is resolved by
  // POSITION against the literal table rather than by asking whether the file contains an 'f'
  // anywhere — a first draft did the latter and flagged 20270225000000_phase4_t3_correction3, whose
  // verification asks `contype = 'c'` about CHECK constraints and has no foreign keys in it at all.
  const sites = [...file.masked.matchAll(/\bcontype\s*=\s*'/giu)]
    .map((m) => ({ quote: m.index + m[0].length - 1, index: m.index }))
    .filter(({ quote }) => file.literalsIn(quote, quote + 1).some((l) => l.value === 'f'));

  // CODEX F3 AGAINST HEAD c6e9ff17. This took the FIRST such site in the file and then asked
  // whether the FILE mentioned `tgconstraint` and `tgenabled` anywhere. One guard that read the
  // enforcement state discharged every other foreign-key verification in the file, however many
  // there were and wherever they stood. The enforcement read has to be IN the guard that refuses,
  // because it is that guard's verdict that is wrong without it.
  const reported = new Set();
  for (const site of sites) {
    const block = file.blocks.find((b) => site.index >= b.bodyStart && site.index < b.bodyEnd);
    // A `contype='f'` outside any DO block is a bare statement; it is judged against the file, but
    // only against the part of it that is not inside some other block's body.
    const scope = block ? block.maskedBody : file.masked;
    if (/\btgconstraint\b/iu.test(scope) && /\btgenabled\b/iu.test(scope)) continue;
    // One finding per guard, not one per mention: the defect is the guard's, and a guard that
    // verifies five keys the same wrong way has one thing to fix.
    const key = block ? `b${block.start}` : `f${file.lineOf(site.index)}`;
    if (reported.has(key)) continue;
    reported.add(key);
    out.push(finding('MI-002', file.lineOf(site.index),
      'this guard verifies foreign keys through pg_constraint (contype = \'f\') without reading '
      + 'pg_trigger.tgenabled on tgconstraint IN THIS GUARD. Every column in pg_constraint — including '
      + 'convalidated and the confrelid OID — survives ALTER TABLE … DISABLE TRIGGER ALL unchanged, so a '
      + 'key that enforces nothing passes this check intact. PR #411 head a222e91 verified five keys this '
      + 'way; PR #412 head 96c9cc4 added the enforcement read. Join pg_trigger on tgconstraint and refuse '
      + 'tgenabled in (D, R). An enforcement read in a different block does not answer for this one.'));
  }
  return out;
}

/**
 * Which RUNBOOK procedure tokens does `migrate.sh` actually GUARD WITH AN INVOCATION, after the
 * deploy has succeeded?
 *
 * CODEX F1 AGAINST HEAD c6e9ff17, and it is the reason this rule needs a shell parser at all. That
 * head asked whether the token appeared anywhere in the post-deploy text with comment lines
 * stripped. But AN `echo` IS AN EXECUTABLE LINE TOO. `migrate.sh` line 130 reads
 *
 *     echo "[migrate] This deploy is NOT good. Repair per docs/RUNBOOK.md section B1, then redeploy."
 *
 * so the token was present after the deploy whether or not anything verified anything, and a
 * migration whose seals were never re-checked would have been reported GREEN by the mere presence
 * of the sentence that says what to do when they fail. A token matched where an ACT was required —
 * the same error the rule exists to detect.
 *
 * So the token must stand INSIDE THE FAILURE BRANCH OF A REAL INVOCATION: `if ! <command>; then …
 * <token> … fi`, where `<command>` runs something rather than printing. That is the shape all three
 * worked precedents already have (T45, T2C, T3C), and it is the shape #412 added for B1:
 *
 *     if ! node "$B1_SEALS" seals; then
 *       echo "… Repair per docs/RUNBOOK.md section B1, then redeploy."
 *       exit 1
 *     fi
 *
 * The parser is deliberately small and refuses what it cannot read: a construct it does not
 * recognise yields NO guarded tokens, so the rule fires rather than clearing. Failing closed is the
 * whole point — this is a rule about verification that must not itself verify by assumption.
 */
const PRINTS_ONLY = /^(echo|printf|:|true|false|test|\[|\[\[|exit|return|continue|break|local|export|unset)$/u;

export function guardedProcedureTokens(sh) {
  const guarded = new Set();
  const lines = sh.split('\n');
  // Where does the deploy happen? Everything before it answers about the database as it WAS.
  const deployAt = lines.findIndex((l) => !/^\s*#/u.test(l)
    && /(^|[^A-Za-z0-9_])(npx\s+)?prisma\s+migrate\s+deploy\b/u.test(l));
  if (deployAt === -1) return guarded;

  const stack = [];
  for (let i = deployAt; i < lines.length; i += 1) {
    const raw = lines[i];
    const code = raw.replace(/^\s*#.*$/u, '');

    // `if ! <cmd>; then` / `if <cmd>; then` — record whether <cmd> INVOKES or merely prints.
    const open = /^\s*(?:el)?if\s+(!\s*)?(.+?)\s*;\s*then\s*$/u.exec(code);
    if (open) {
      const first = (open[2].trim().split(/\s+/u)[0] ?? '').replace(/^["']/u, '');
      // A leading VAR=value assignment prefix is not the command; skip past any of them.
      const head = open[2].trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*/u, '').split(/\s+/u)[0] ?? '';
      const word = (head || first).replace(/^["']/u, '');
      stack.push({ invokes: word.length > 0 && !PRINTS_ONLY.test(word) });
      continue;
    }
    if (/^\s*(if|while|until|for|case)\b/u.test(code) && !/\bfi\b/u.test(code)) { stack.push({ invokes: false }); continue; }
    if (/^\s*(fi|done|esac)\b/u.test(code)) { stack.pop(); continue; }

    if (!stack.some((f) => f.invokes)) continue;
    for (const m of raw.matchAll(/RUNBOOK\.md`?\s+(§[A-Za-z0-9]+|section\s+[A-Za-z0-9]+)/gu)) {
      guarded.add(m[1].replace(/\s+/u, ' '));
    }
  }
  return guarded;
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
 * the verifier that should re-ask its question on every deploy. The link between the B1 migration
 * and `dist/activities/b1/b1.cli.js` existed only in a human's head. Enumeration cannot recover a
 * link never written down, so the rule reads the one the corpus already has — the shared
 * `docs/RUNBOOK.md §X` procedure token both files name. A migration using no RUNBOOK procedure may
 * declare the link explicitly with `-- migration-invariants: deploy-verifier <token>`.
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
  const selfVerifies = file.blocks.some((b) => b.roles.includes('catalog-guard')
    && /\bRAISE\s+EXCEPTION\b/iu.test(b.maskedBody));
  if (!installsSeals || !selfVerifies) return [];

  const explicit = /--\s*migration-invariants:\s*deploy-verifier\s+(\S+)/iu.exec(file.sql);
  const tokens = explicit
    ? [explicit[1]]
    : [...new Set([...file.sql.matchAll(/RUNBOOK\.md`?\s+(§[A-Za-z0-9]+|section\s+[A-Za-z0-9]+)/gu)]
      .map((m) => m[1].replace(/\s+/u, ' ')))];

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

  const guarded = guardedProcedureTokens(context.migrateSh ?? '');
  if (tokens.some((t) => guarded.has(t))) return [];

  const namedAnywhere = tokens.filter((t) => (context.migrateSh ?? '').includes(t));
  if (namedAnywhere.length > 0) {
    return [finding('MI-003', line,
      `apps/api/scripts/migrate.sh names ${namedAnywhere.map((t) => `"${t}"`).join(' / ')}, but never `
      + 'inside the failure branch of a command that VERIFIES anything after `prisma migrate deploy` '
      + 'succeeds. A procedure token in an `echo`, or in a preflight that runs against the database as '
      + `it WAS, does not re-ask whether the seals are armed now. ${advice}`)];
  }
  return [finding('MI-003', line,
    `this migration installs seals under procedure ${tokens.map((t) => `"${t}"`).join(' / ')}, which `
    + `apps/api/scripts/migrate.sh never invokes. ${advice}`)];
}

const RULES = [
  ['MI-001', ruleNameOverDefinition],
  ['MI-002', ruleForeignKeyEnforcement],
  ['MI-003', ruleApplyTimeOnly],
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
  const lits = literals(sql);
  return {
    sql,
    masked: mask,
    lineOf,
    statements: stmts,
    blocks,
    literalValues: lits.map((l) => l.value),
    literalsIn: (from, to) => lits.filter((l) => l.start >= from && l.start < to),
  };
}

/** Lint one migration. `context` supplies the cross-file facts MI-003 needs. */
export function lintMigration({ name, sql, context = {} }) {
  const file = parseMigration(sql);
  const findings = [];
  for (const [, rule] of RULES) findings.push(...rule(file, context));
  return findings.map((f) => ({ ...f, migration: name }))
    .sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** Read the repository-level context once, for every migration in a run. */
export function repoContext(root = REPO_ROOT) {
  const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : '');
  return { migrateSh: read('apps/api/scripts/migrate.sh') };
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
  const context = repoContext(root);
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
