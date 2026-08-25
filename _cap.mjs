import initPg from 'pg-query-emscripten';
for (const len of [50, 500, 5000]) {
  const pg = await initPg();
  const q = "SELECT '" + 'x'.repeat(Math.max(0, len - 10)) + "'";
  let bytes = 0;
  try { for (let i = 0; i < 100000; i++) { pg.parse(q); bytes += q.length; } }
  catch { console.log('stmt len', len, '-> total bytes parsed before failure:', bytes); continue; }
  console.log('stmt len', len, '-> no failure');
}
