import initPg from 'pg-query-emscripten';
import { readFileSync } from 'node:fs';
const sql = readFileSync(process.argv[2], 'utf8');
// find DO blocks by asking a FRESH module to parse, then test each body alone in a fresh module
const pg0 = await initPg();
const tree = pg0.parse(sql).parse_tree;
const bodies = [];
JSON.stringify(tree, (k, v) => {
  if (k === 'DoStmt') for (const a of v.args ?? []) if (a.DefElem?.defname === 'as') bodies.push(a.DefElem.arg.String.sval);
  return v;
});
console.log('DO blocks:', bodies.length);
for (let i = 0; i < bodies.length; i++) {
  const pg = await initPg();
  const r = pg.parsePlpgsql('DO $$' + bodies[i] + '$$;');
  if (r.error) {
    console.log('block', i, 'ERROR:', r.error.message, '|', r.error.context);
    const lines = ('DO $$' + bodies[i]).split('\n');
    const m = /near line (\d+)/.exec(r.error.context || '');
    if (m) console.log('   >>>', lines[Number(m[1]) - 1]);
  }
}
