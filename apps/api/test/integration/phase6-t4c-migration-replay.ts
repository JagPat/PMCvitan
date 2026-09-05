/**
 * Phase 6 unit 4c — replaying SHIPPED migration files inside a test transaction.
 *
 * Shared by the 4c-iii enablement suite and the 4c-v retirement suite, both of which drive the
 * migration file read from disk rather than a paraphrase of it (the difference the 4c-iii round-1
 * P2 finding turned on). It lives in its own module because importing one test file from another
 * would register the imported suite a second time under the importer.
 */

/** Split a migration into executable statements. Postgres dollar-quoted bodies (`$$ … $$`) contain
 *  semicolons that are NOT statement terminators, so a naive split on ';' would tear every trigger
 *  function in half — the migrations are mostly such bodies. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let tag: string | null = null;      // inside $tag$ … $tag$
  let quoted = false;              // inside '…'
  let lineComment = false;         // inside -- …
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (lineComment) { buf += ch; if (ch === '\n') lineComment = false; continue; }
    if (quoted) { buf += ch; if (ch === "'") quoted = false; continue; }
    if (tag !== null) {
      if (sql.startsWith(tag, i)) { buf += tag; i += tag.length - 1; tag = null; continue; }
      buf += ch; continue;
    }
    // …outside every quoting construct: only here is a ';' a terminator. The migrations' own header
    // comments contain semicolons, which is how the first version of this splitter tore a comment
    // in half and handed PostgreSQL the word "the" as a statement.
    if (ch === '-' && sql[i + 1] === '-') { lineComment = true; buf += ch; continue; }
    if (ch === "'") { quoted = true; buf += ch; continue; }
    const open = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (open) { tag = open[0]; buf += open[0]; i += open[0].length - 1; continue; }
    if (ch === ';') { if (buf.trim()) out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  // a fragment that is only comments and whitespace is not a statement
  return out.filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

/** The shipped 4c migrations wrap themselves in an explicit `BEGIN`/`COMMIT` (their atomicity is
 *  their own, not the runner's). Every consumer here replays the file INSIDE a transaction it
 *  already opened, where a nested `BEGIN` is a no-op warning and a `COMMIT` would end the caller's
 *  transaction early — so the transaction-control statements are dropped from the replay while
 *  every DDL and DML statement is kept verbatim. The probes still drive the SHIPPED file; they
 *  simply supply the boundary themselves instead of executing the file's own. */
export function splitSqlForReplay(sql: string): string[] {
  return splitSql(sql).filter((s) => !/^\s*(BEGIN|COMMIT)\s*;?\s*$/i.test(s));
}
