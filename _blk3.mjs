import initPg from 'pg-query-emscripten';
import { readFileSync } from 'node:fs';
const sql = readFileSync(process.argv[2], 'utf8');
const pg0 = await initPg();
const tree = pg0.parse(sql).parse_tree;
const bodies = [];
const collect = (v) => {
  if (Array.isArray(v)) return v.forEach(collect);
  if (!v || typeof v !== 'object') return;
  for (const [k, c] of Object.entries(v)) {
    if (k === 'DoStmt') for (const a of c.args ?? []) if (a.DefElem?.defname === 'as') bodies.push(['DO', a.DefElem.arg.String.sval]);
    if (k === 'CreateFunctionStmt') {
      const as = (c.options ?? []).find((o) => o.DefElem?.defname === 'as');
      let arg = as?.DefElem?.arg;
      if (arg && arg.List) arg = arg.List.items;
      const b = (Array.isArray(arg) ? arg : [arg])[0]?.String?.sval;
      if (b !== undefined) bodies.push(['FN', b]);
    }
    collect(c);
  }
};
collect(tree);
console.log('routines:', bodies.map(b=>b[0]).join(','));
for (let i = 0; i < bodies.length; i++) {
  const pg = await initPg();
  const src = '$probe$' + bodies[i][1] + '$probe$';
  const rr = pg.parsePlpgsql('DO ' + src + ';');
  console.log(i, bodies[i][0], rr.error ? 'ERROR ' + rr.error.message + ' | ' + rr.error.context : 'ok');
  if (rr.error) { const m=/near line (\d+)/.exec(rr.error.context||''); if(m) console.log('   >>>', ('DO ' + src).split('\n')[Number(m[1])-1]); }
}
