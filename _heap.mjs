import initPg from 'pg-query-emscripten';
const pg = await initPg();
const call = (fn, text) => {
  const b = Buffer.from(text, 'utf8');
  const arr = new Uint8Array(b.length + 1); arr.set(b);
  const ptr = pg.allocate(arr, 0);
  try { return fn(ptr); } finally { pg._free(ptr); }
};
let n = 0; const t = Date.now();
try {
  for (; n < 20000; n++) call((p) => pg.raw_parse(p), "SELECT k.conname FROM pg_constraint k JOIN pg_trigger g ON g.tgconstraint=k.oid WHERE k.contype='f' AND g.tgenabled IN ('D','R')");
} catch (e) { console.log('died at', n); }
console.log('parses:', n, 'ms', Date.now() - t);
const r = call((p) => pg.raw_parse_plpgsql(p), "DO $$ BEGIN PERFORM 1; END $$;");
console.log('plpgsql heap path:', r.error && r.error.message ? r.error.message : 'ok', JSON.parse(r.plpgsql_funcs || '[]').length);
