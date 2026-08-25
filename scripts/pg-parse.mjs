#!/usr/bin/env node
// THE PARSER BINDING — PostgreSQL's own grammar, wrapped so nothing above it sees the library.
//
// THIS UNIT SHIPS ONE DECISION AND ONE CLAIM.
//
//   DECISION  how this repository reads its own migrations programmatically, and with which parser
//   CLAIM     all 91 migrations parse with PostgreSQL's grammar through this binding, and the
//             binding neither leaks nor truncates on the largest of them
//
// It ships NOTHING ELSE — no sites, no line attribution, no coverage accounting, no rule. Those
// are the next units, and they are deferred whole. `docs/MIGRATION_INVARIANTS.md` records what is
// deferred and the live defects that consequently have no alarm.
//
// WHY THE SCOPE IS THIS NARROW. Three pull requests in this lineage reached the two-finding-head
// limit and were closed: #423 (a hand-written SQL lexer), #430 (this binding plus an enforcement
// rule), #431 (this binding plus site attribution and a total-coverage claim). Their findings did
// not scatter. Every one reduced to a single shape:
//
//     A CHECK NARROWER THAN THE OBJECT IT JUDGES.
//
// which is the very defect the eventual rules exist to detect, restated as their implementation.
// What survived all three reviews untouched is what is here: the choice of parser and the two
// measured defects in using it. Attribution and coverage — where every #431 finding landed — start
// again on top of a binding that has been reviewed for what it is.
//
// NOTHING HERE DECIDES WHAT SQL IS. `libpg_query` IS the PostgreSQL server's parser, compiled from
// the same C sources, and it is asked both questions a hand-written lexer answered by guessing:
//
//   raw_parse         the raw parse tree — statement boundaries, dollar quoting, every literal
//                     form, comments, all of it, by construction rather than by enumeration
//   raw_parse_plpgsql the PL/pgSQL routine body inside `DO` and `CREATE FUNCTION`
//
// `libpg-query` was measured as the alternative and rejected on one fact: it ships NO PL/pgSQL
// parser at any dist-tag. Every guard in this repository lives inside a `DO` block, whose body is
// one opaque string literal to the SQL grammar, so it could not read a single guard.
//
// WHY THIS BINDING IS CALLED THROUGH ITS RAW ENTRY POINTS. `pg-query-emscripten`'s convenience
// wrappers copy the input onto the WASM STACK (`allocate(…, ALLOC_STACK)`) and never unwind it; the
// `_free` that follows does not apply to a stack pointer. Measured on this repository: an instance
// dies after 44,590–62,874 cumulative input bytes — an emscripten 64 KB stack — and the largest
// migration here is 177,493 bytes, which the wrapper cannot parse at all, on any instance, ever.
// This binding therefore allocates on the HEAP and frees what it allocated. Measured after the
// change: 20,000 parses in 2.6 s with no growth, and the 177 KB file parses. The alternative
// considered and rejected was recycling the module on a byte budget, which would have hidden a
// library defect behind a magic number and still could not have parsed the largest file.
//
// WHERE THIS BINDING STOPS, IT SAYS SO. A SQL text the grammar refuses and a routine body the
// PL/pgSQL parser rejects both THROW, carrying the server's own message. Silence is the failure
// mode this whole line of work exists to refuse, so the binding never degrades to "found nothing".

import initPgQuery from 'pg-query-emscripten';

let pg = null;

/** Load the WASM parser once per process. */
export async function loadParser() {
  if (pg === null) pg = await initPgQuery();
  return pg;
}

/**
 * Hand `text` to a raw libpg_query entry point on the heap, and give the heap back afterwards.
 *
 * `select` is a FUNCTION that picks the entry point off the loaded module, not the entry point
 * itself. That is not a style choice: passing `pg.raw_parse` dereferences `pg` at the CALL SITE,
 * before this function runs, so an unloaded parser produced `TypeError: Cannot read properties of
 * null` and the guard below — written precisely to say what the caller forgot — was unreachable.
 * The check has to happen before anything touches `pg`, so nothing may touch `pg` until it has.
 */
function callWithText(select, text) {
  if (pg === null) throw new Error('pg-parse: call loadParser() first');
  const bytes = Buffer.from(text, 'utf8');
  // AN EMBEDDED NUL WOULD TRUNCATE THIS SILENTLY. libpg_query reads a NUL-terminated C string, so
  // a NUL inside the text ends it early: the parser reads the prefix, returns a clean tree for it,
  // and everything after that byte is gone with no error anywhere. That is the exact failure this
  // binding exists to refuse — a caller cannot tell a short file from a truncated read — so it is
  // refused here rather than reported as a successful parse of part of the input.
  const nul = bytes.indexOf(0);
  if (nul !== -1) {
    throw new Error(`pg-parse: refusing text with an embedded NUL byte at offset ${nul}; `
      + 'libpg_query would read only the bytes before it and report success');
  }
  const buffer = new Uint8Array(bytes.length + 1); // the terminator this adds is the only one
  buffer.set(bytes);
  const pointer = pg.allocate(buffer, 0); // 0 = ALLOC_NORMAL: the heap, not the 64 KB stack
  try {
    return select(pg).call(pg, pointer);
  } finally {
    pg._free(pointer);
  }
}

const raise = (result, what) => {
  const message = result?.error?.message;
  if (!message) return;
  const err = new Error(`${what}: ${message}${result.error.context ? ` (${result.error.context})` : ''}`);
  err.cursorPosition = result.error.cursorpos;
  throw err;
};

/** Parse SQL with PostgreSQL's grammar. Throws with the server's own message. */
export function parseSql(sql) {
  const result = callWithText((parser) => parser.raw_parse, sql);
  raise(result, 'SQL parse failed');
  return JSON.parse(result.parse_tree);
}

/**
 * Compile ONE PL/pgSQL routine, from its own statement text verbatim.
 *
 * The whole file is not handed to the PL/pgSQL parser in one call, and the reason is measured:
 * over this corpus it aborts at the first routine it dislikes and reports nothing about any other,
 * so one awkward block would blind the linter to the rest of the file without saying so. The text
 * is the ORIGINAL statement, sliced by the offsets the raw parser reported, rather than a body
 * re-wrapped in a `DO` of our own — a trigger function re-wrapped that way loses `NEW` and `OLD`
 * and fails to compile, which is how this was found: four merged migrations refused to parse.
 */
export function parsePlpgsqlStatement(statementSql) {
  const result = callWithText((parser) => parser.raw_parse_plpgsql, statementSql);
  raise(result, 'PL/pgSQL compilation failed');
  const funcs = JSON.parse(result.plpgsql_funcs || '[]');
  if (funcs.length !== 1) throw new Error(`pg-parse: expected 1 compiled routine, got ${funcs.length}`);
  return funcs[0];
}

// A parse tree is JSON of the C node structs: a node is `{ NodeType: { …fields… } }`, and every
// field name is lowerCamelCase while every node type name is UpperCamelCase. That casing rule is
// the parser's own convention across all 300-odd node types, so the walk needs no list of them —
// which is the point. Enumerating the node types this repository happens to use would rebuild the
// very defect this file exists to retire.
const isNodeType = (key) => key.length > 0 && key[0] !== key[0].toLowerCase() && key[0] === key[0].toUpperCase();

/** Yield `{ type, node }` for EVERY node in a parse tree, at any depth, sub-selects included. */
export function* walk(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (isNodeType(key)) yield { type: key, node: child };
    yield* walk(child);
  }
}

/** Every node of one type in a tree. */
export const nodesOfType = (tree, type) => [...walk(tree)].filter((n) => n.type === type).map((n) => n.node);

/** The relations a query names, lowercased — how a reader asks what a site actually queries. */
export const relationsIn = (tree) => nodesOfType(tree, 'RangeVar')
  .map((r) => String(r.relname ?? '').toLowerCase());
