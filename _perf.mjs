import initPg from 'pg-query-emscripten';
let t = Date.now();
const a = await initPg();
console.log('init ms', Date.now() - t);
t = Date.now();
const b = await initPg();
console.log('second init ms', Date.now() - t);
// robustness: error in plpgsql then more work on the same instance
const bad = a.parsePlpgsql("DO $$ BEGIN EXCEPTION WHEN exception THEN NULL; END $$;");
console.log('bad err:', bad.error ? bad.error.message : 'none');
try { console.log('parse after bad err:', a.parse('SELECT 1').error); } catch (e) { console.log('CRASH after plpgsql error:', String(e).slice(0, 80)); }
try { console.log('plpgsql after bad err:', a.parsePlpgsql('DO $$ BEGIN NULL; END $$;').error); } catch (e) { console.log('CRASH2:', String(e).slice(0, 80)); }
// sequence: parse then plpgsql ok
try { a.parse('SELECT 1'); console.log('plpgsql after parse ok:', a.parsePlpgsql('DO $$ BEGIN NULL; END $$;').error); } catch (e) { console.log('CRASH3:', String(e).slice(0,80)); }
// throughput
t = Date.now();
for (let i = 0; i < 2000; i++) a.parse('SELECT k.conname FROM pg_constraint k WHERE k.contype = ' + "'f'");
console.log('2000 parses ms', Date.now() - t);
