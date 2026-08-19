/**
 * Pre-push migration lint — the finding classes this repository keeps rediscovering in review.
 *
 * This exists because the Codex findings on recent migration units were not novel. They repeated,
 * across units, in a small set of shapes. Every check below is one of those shapes, and each cost a
 * full review round (push → CI → promote → review → correct, on the order of an hour) to be told.
 *
 * WHAT IT WILL AND WILL NOT DO. Every check here is meant to be PRECISE — it fires on a fact, not a
 * suspicion — because a linter that cries wolf is read once and disabled, and then it is worse than
 * nothing. Where a rule genuinely needs judgement it is ADVISORY and can be silenced in place with a
 * `-- lint-ok: <reason>` comment on the line above, which records the reason in the diff rather than
 * hiding it. It replaces no review; it removes the findings a reviewer should never have to spend a
 * round on.
 *
 * Checks
 *   C1  `CREATE TABLE IF NOT EXISTS` carrying INLINE constraints
 *   C2  a protective row trigger on a table with no BEFORE TRUNCATE seal
 *   C3  a CHECK that a NULL passes, because SQL is three-valued
 *   C4  drift between this migration's physical objects and `schema.prisma`
 *   C5  a trigger reading a row it does not lock (advisory)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = 'apps/api/prisma/migrations';

/** Migration directories this branch adds or edits, relative to the base ref. */
export function changedMigrations(baseRef = 'origin/main', cwd = process.cwd()) {
  const out = execFileSync('git', ['diff', '--name-only', `${baseRef}...`, '--', MIGRATIONS],
    { cwd, encoding: 'utf8' });
  const dirs = new Set();
  for (const line of out.split('\n')) {
    const m = /^apps\/api\/prisma\/migrations\/([^/]+)\/migration\.sql$/u.exec(line.trim());
    if (m) dirs.add(m[1]);
  }
  return [...dirs].sort();
}

/** Strip line comments so a rule never fires on prose describing it. */
function code(sql) {
  return sql.split('\n').map((l) => l.replace(/--(?!\s*lint-ok:).*$/u, '')).join('\n');
}

/** Lines carrying an explicit, reasoned waiver. */
function waivers(sql) {
  const set = new Set();
  const lines = sql.split('\n');
  lines.forEach((l, i) => { if (/--\s*lint-ok:\s*\S/u.test(l)) set.add(i + 2); });
  return set;
}

function lineOf(sql, index) {
  return sql.slice(0, index).split('\n').length;
}

/** Every table this migration creates a trigger, constraint or column on. */
export function touchedTables(sql) {
  const s = code(sql);
  const tables = new Set();
  const patterns = [
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"([^"]+)"/giu,
    /ALTER\s+TABLE\s+(?:ONLY\s+)?"([^"]+)"/giu,
    /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"[^"]+"\s+(?:BEFORE|AFTER|INSTEAD\s+OF)[\s\S]{0,120}?\sON\s+"([^"]+)"/giu,
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?"[^"]+"\s+ON\s+"([^"]+)"/giu,
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) tables.add(m[1]);
  }
  return [...tables].sort();
}

// ── C1 ────────────────────────────────────────────────────────────────────────────────────────
// `CREATE TABLE IF NOT EXISTS` is skipped WHOLESALE when the table already exists — and it can
// already exist without this file having run, because `schema.prisma` describes it and a baseline
// or a `db push`-shaped reconciliation produces it. Prisma reproduces tables, columns, primary keys
// and foreign keys; it does NOT reproduce a CHECK. So an inline CHECK is silently absent on exactly
// the databases that most need the migration to assert it, while the ledger records success.
export function c1InlineConstraints(sql) {
  const s = code(sql);
  const findings = [];
  for (const m of s.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"\s*\(/giu)) {
    // walk to the matching close paren
    let depth = 0; let i = m.index + m[0].length - 1; let body = '';
    for (; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '(') depth += 1;
      if (ch === ')') { depth -= 1; if (depth === 0) break; }
      if (depth >= 1) body += ch;
    }
    const inline = /\bCHECK\s*\(/iu.test(body);
    if (inline) {
      findings.push({
        check: 'C1', line: lineOf(s, m.index), table: m[1],
        message: `CREATE TABLE IF NOT EXISTS "${m[1]}" carries an INLINE constraint. The whole `
          + 'statement is skipped when the table already exists, so that constraint is silently '
          + 'absent on any database Prisma reconstructed the table on. Add it as a guarded ALTER.',
      });
    }
  }
  return findings;
}

// ── C2 ────────────────────────────────────────────────────────────────────────────────────────
// TRUNCATE fires NO row-level trigger. A protective row trigger — one that RAISEs to refuse a write
// — is therefore walked straight around by `TRUNCATE`, which needs its own statement-level seal.
export function c2TruncateGap(sql, sealedTables = new Set()) {
  const s = code(sql);
  const guarded = new Map();          // table -> trigger name, for protective row triggers
  const truncateSealed = new Set(sealedTables);

  const fnRaises = new Set();
  for (const m of s.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z0-9_."]+)\s*\(/giu)) {
    const start = m.index;
    const end = s.indexOf('$$', s.indexOf('$$', start) + 2);
    const body = s.slice(start, end > start ? end : s.length);
    if (/RAISE\s+EXCEPTION/iu.test(body)) fnRaises.add(m[1].replace(/"/gu, '').split('.').pop());
  }

  const trigRe = /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER\s+"([^"]+)"\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+([\s\S]*?)\sON\s+"([^"]+)"([\s\S]*?)EXECUTE\s+(?:PROCEDURE|FUNCTION)\s+([A-Za-z0-9_."]+)/giu;
  for (const m of s.matchAll(trigRe)) {
    const [, name, timing, verbs, table, mid, fn] = m;
    const isRow = /FOR\s+EACH\s+ROW/iu.test(mid);
    const fname = fn.replace(/"/gu, '').split('.').pop();
    if (/TRUNCATE/iu.test(verbs)) truncateSealed.add(table);
    if (isRow && fnRaises.has(fname)) {
      if (!guarded.has(table)) guarded.set(table, { name, line: lineOf(s, m.index) });
    }
    void timing;
  }

  return [...guarded.entries()]
    .filter(([table]) => !truncateSealed.has(table))
    .map(([table, { name, line }]) => ({
      check: 'C2', line, table,
      message: `"${table}" gains the protective row trigger "${name}", but nothing seals TRUNCATE `
        + 'on it. TRUNCATE fires no row-level trigger, so it walks straight around that guard. Add '
        + 'a statement-level BEFORE TRUNCATE seal, or waive with `-- lint-ok:` and say why the row '
        + 'rule need not hold against truncation.',
    }));
}

// ── C3 ────────────────────────────────────────────────────────────────────────────────────────
// A CHECK PASSES when its expression is UNKNOWN, and `NULL !~ '...'` is UNKNOWN. So a bare regex or
// comparison on a NULLABLE column is not a test at all for exactly the rows it is meant to catch.
/**
 * Is THIS column's nullability handled in the expression? Per column, deliberately: a definition
 * may guard one nullable column and leave another bare, and a definition-wide test reads the first
 * guard as covering both. That is not a hypothetical — it is why the first cut of C3 reported
 * nothing across 89 migrations while missing the exact defect it was written for.
 */
function guardsColumn(definition, column) {
  const c = column.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // BOTH renderings, because `pg_get_constraintdef` prints a lowercase-safe identifier WITHOUT
  // quotes. Matching only the quoted form reads a guarded column as unguarded — which is the same
  // mistake as reading the wrong column: testing how a thing is PRINTED rather than what it IS.
  const id = `(?:"${c}"|\\b${c}\\b)`;
  return new RegExp(
    `COALESCE\\s*\\(\\s*${id}`
    + `|${id}\\s+IS\\s+(?:NOT\\s+)?NULL`
    + `|${id}\\s+IS\\s+(?:NOT\\s+)?DISTINCT\\s+FROM`, 'iu').test(definition);
}

export function c3NullPassesCheck(constraints) {
  return constraints
    .map((c) => ({ ...c, unguarded: c.nullableColumns.filter((col) => !guardsColumn(c.definition, col)) }))
    .filter(({ unguarded }) => unguarded.length > 0)
    .map(({ name, table, definition, unguarded: nullableColumns }) => ({
      check: 'C3', table, line: null,
      message: `CHECK "${name}" on "${table}" tests the NULLABLE column(s) `
        + `${nullableColumns.map((c) => `"${c}"`).join(', ')} without COALESCE or an explicit NULL `
        + 'test. A CHECK passes when its expression is UNKNOWN, so this admits exactly the rows it '
        + `reads as absent. Definition: ${definition}`,
    }));
}

// ── C5 ────────────────────────────────────────────────────────────────────────────────────────
// A trigger that reads a row to decide something, without locking it, decides on a value a
// concurrent writer may already have changed. Advisory: plenty of reads are legitimately lock-free.
export function c5UnlockedTriggerRead(sql) {
  const s = code(sql);
  const waived = waivers(sql);
  const findings = [];
  for (const m of s.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z0-9_."]+)\s*\([\s\S]*?RETURNS\s+TRIGGER([\s\S]*?)\$\$[\s\S]*?\$\$/giu)) {
    const body = m[0];
    const fname = m[1].replace(/"/gu, '');
    for (const sel of body.matchAll(/SELECT\s[\s\S]{0,400}?\sINTO\s[\s\S]{0,400}?;/giu)) {
      const stmt = sel[0];
      if (/FOR\s+(SHARE|UPDATE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)/iu.test(stmt)) continue;
      if (!/\bFROM\b/iu.test(stmt)) continue;                 // SELECT expr INTO v — reads no row
      const line = lineOf(s, m.index + sel.index);
      if (waived.has(line)) continue;
      findings.push({
        check: 'C5', line, table: null, advisory: true,
        message: `${fname} reads a row with SELECT ... INTO and takes no row lock. If the value it `
          + 'reads decides a refusal, a concurrent writer can change it between the read and the '
          + 'commit. Add FOR SHARE / FOR UPDATE, or waive with `-- lint-ok:` stating why the read '
          + 'cannot go stale.',
      });
    }
  }
  return findings;
}

export function formatFindings(findings) {
  return findings.map((f) => {
    const where = [f.line ? `line ${f.line}` : null, f.table ? `"${f.table}"` : null]
      .filter(Boolean).join(' ');
    return `${f.advisory ? 'warn' : 'FAIL'}  [${f.check}] ${where}\n      ${f.message}`;
  }).join('\n');
}

export function migrationSql(dir, cwd = process.cwd()) {
  const p = join(cwd, MIGRATIONS, dir, 'migration.sql');
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
