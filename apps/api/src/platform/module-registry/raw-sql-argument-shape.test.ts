import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Phase 6 unit 4d-i — a second SQL STATEMENT is never passed to `$executeRawUnsafe` as an argument.
 *
 * `prisma.$executeRawUnsafe(sql, ...values)` runs ONE statement. Everything after the first
 * argument is a QUERY PARAMETER bound to `$1`, `$2`, … So this:
 *
 *     prisma.$executeRawUnsafe(
 *       `DO $$ … DISABLE TRIGGER "A" … $$;`,
 *       `DO $$ … DISABLE TRIGGER "B" … $$;`,   // ← NOT executed. A parameter.
 *     )
 *
 * runs the first statement and silently discards the second. It does not even error: a `DO` block
 * binds no placeholders, so the extra parameters go nowhere and PostgreSQL says nothing.
 *
 * That is exactly what happened in `prisma/seed.ts`. Two 4d seal disables were written as extra
 * arguments to the delivered one, so `DecisionEvent_t4d_append_only` was never off for the wipe
 * that followed, and the seed aborted — but ONLY on the second seed of a database, because the
 * first seed of an empty one deletes no rows and the trigger never fires. It survived a local
 * reproduction, a green `pnpm check`, a green 1518-test integration run and a full local
 * `api-e2e` battery, and was caught by CI.
 *
 * The rule is mechanical, so it is checked mechanically: no argument after the first may look
 * like a SQL statement. A real parameter — an id, a JSON blob, a timestamp — never does.
 */

const ROOTS = ['src', 'prisma', 'test', 'scripts'];
const API_ROOT = join(__dirname, '..', '..', '..');
/** How a SQL STATEMENT starts, and a bound value never does. */
const STATEMENT = /^\s*(DO\s*\$\$|ALTER\s|INSERT\s|UPDATE\s|DELETE\s|TRUNCATE\s|CREATE\s|DROP\s|SELECT\s|BEGIN;|COMMIT;)/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|mts|mjs)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Split a call's argument list at top-level commas, respecting brackets and template literals. */
function splitArgs(body: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let cur = '';
  let inTick = false;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]!;
    if (c === '`' && body[i - 1] !== '\\') inTick = !inTick;
    if (!inTick) {
      if (c === '(' || c === '[' || c === '{') depth += 1;
      else if (c === ')' || c === ']' || c === '}') depth -= 1;
      else if (c === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim() !== '') args.push(cur);
  return args;
}

/** Every `$executeRawUnsafe(…)` call whose 2nd+ argument reads as a SQL statement. */
function offenders(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(API_ROOT, root))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\$executeRawUnsafe\(/g)) {
        let depth = 1;
        let j = m.index! + m[0].length;
        const from = j;
        while (j < text.length && depth > 0) {
          if (text[j] === '(') depth += 1;
          else if (text[j] === ')') depth -= 1;
          j += 1;
        }
        const args = splitArgs(text.slice(from, j - 1));
        for (const arg of args.slice(1)) {
          if (STATEMENT.test(arg.trim().replace(/^`/, ''))) {
            const line = text.slice(0, m.index!).split('\n').length;
            found.push(`${relative(API_ROOT, file)}:${line}`);
            break;
          }
        }
      }
    }
  }
  return found;
}

describe('phase 6 unit 4d-i — $executeRawUnsafe is given ONE statement and only values after it', () => {
  it('the scan reaches real call sites — an empty scan proves nothing', () => {
    let calls = 0;
    for (const root of ROOTS) {
      for (const file of walk(join(API_ROOT, root))) {
        calls += [...readFileSync(file, 'utf8').matchAll(/\$executeRawUnsafe\(/g)].length;
      }
    }
    expect(calls, 'this repository uses $executeRawUnsafe widely; 0 means the matcher broke')
      .toBeGreaterThan(50);
  });

  it('no call passes a second SQL statement where a bound value belongs', () => {
    expect(
      offenders().sort(),
      'each of these passes something that reads as a SQL STATEMENT after the first argument. '
      + '`$executeRawUnsafe(sql, ...values)` runs ONE statement and binds the rest to $1, $2, … so '
      + 'the extra statement is silently DISCARDED — and a DO block binds no placeholders, so '
      + 'PostgreSQL never complains. Split it into its own $executeRawUnsafe call.',
    ).toEqual([]);
  });
});
