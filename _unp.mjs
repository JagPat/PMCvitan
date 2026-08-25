import { loadParser, parseSql, parsePlpgsqlStatement } from './scripts/pg-parse.mjs';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
await loadParser();
// re-derive the skipped fragments by instrumenting: re-walk each routine
const { parseMigration } = await import('./scripts/pg-parse.mjs');
const DIR = 'apps/api/prisma/migrations';
const samples = [];
for (const n of readdirSync(DIR).sort()) {
  const f = join(DIR, n, 'migration.sql');
  if (!existsSync(f)) continue;
  const r = parseMigration(readFileSync(f, 'utf8'));
  for (const rt of r.routines) {
    if (!rt.unparsed) continue;
    // find them again
    const walkExpr = function* (v, ln) {
      if (Array.isArray(v)) { for (const i of v) yield* walkExpr(i, ln); return; }
      if (!v || typeof v !== 'object') return;
      const here = typeof v.lineno === 'number' ? v.lineno : ln;
      for (const [k, c] of Object.entries(v)) {
        if (k === 'PLpgSQL_expr' && typeof c?.query === 'string') yield { q: c.query, pm: c.parseMode ?? 0 };
        yield* walkExpr(c, here);
      }
    };
    for (const e of walkExpr(rt.tree, 1)) {
      const text = e.pm === 0 ? e.q : `SELECT ${e.q}`;
      try { parseSql(text); } catch (err) { samples.push([n, e.pm, e.q.slice(0, 90)]); }
    }
  }
}
console.log('total unparsed:', samples.length);
const byMode = {}; samples.forEach(s => byMode[s[1]] = (byMode[s[1]] || 0) + 1);
console.log('by parseMode:', byMode);
samples.slice(0, 12).forEach(s => console.log(' ', s[1], JSON.stringify(s[2])));
