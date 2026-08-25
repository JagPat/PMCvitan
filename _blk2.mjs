import initPg from 'pg-query-emscripten';
import { readFileSync } from 'node:fs';
const sql = readFileSync(process.argv[2], 'utf8');
const pgA = await initPg();
const r = pgA.parsePlpgsql(sql);
console.log('WHOLE FILE:', r.error ? JSON.stringify(r.error) : `ok (${(r.plpgsql_funcs||[]).length} funcs)`);
const pg0 = await initPg();
const tree = pg0.parse(sql).parse_tree;
const bodies = [];
JSON.stringify(tree, (k, v) => {
  if (k === 'DoStmt') for (const a of v.args ?? []) if (a.DefElem?.defname === 'as') bodies.push(['DO', a.DefElem.arg.String.sval]);
  if (k === 'CreateFunctionStmt') {
    const as = (v.options ?? []).find((o) => o.DefElem?.defname === 'as');
    const items = as?.DefElem?.arg ?? [];
    const b = (Array.isArray(items) ? items : [items])[0]?.String?.sval;
    if (b) bodies.push(['FN', b]);
  }
  return v;
});
console.log('routines:', bodies.map(b=>b[0]).join(','));
for (let i = 0; i < bodies.length; i++) {
  const pg = await initPg();
  const src = 'DO $$' + bodies[i][1] + '$$;';
  const rr = pg.parsePlpgsql(src);
  console.log(i, bodies[i][0], rr.error ? 'ERROR ' + rr.error.message + ' | ' + rr.error.context : 'ok');
  if (rr.error) { const m=/near line (\d+)/.exec(rr.error.context||''); if(m) console.log('   >>>', src.split('\n')[Number(m[1])-1]); }
}
