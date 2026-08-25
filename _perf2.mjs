import initPg from 'pg-query-emscripten';
let t = Date.now();
const a = await initPg();
console.log('init ms', Date.now() - t);
t = Date.now(); await initPg(); console.log('second init ms', Date.now() - t);
let n = 0;
t = Date.now();
try {
  for (; n < 20000; n++) a.parse("SELECT k.conname FROM pg_constraint k JOIN pg_trigger g ON g.tgconstraint=k.oid WHERE k.contype = 'f' AND g.tgenabled IN ('D','R')");
} catch (e) { console.log('died at iteration', n, ':', String(e).slice(0, 60)); }
console.log('completed', n, 'parses in', Date.now() - t, 'ms');
