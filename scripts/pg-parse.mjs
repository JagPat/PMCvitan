#!/usr/bin/env node
// THE PARSER ADAPTER — PostgreSQL's own grammar, wrapped so the rules never see the library.
//
// WHY THIS FILE EXISTS. PR #423 hand-wrote a SQL lexer and a set of regexes over the text it
// produced. It reached the two-finding-head limit and was closed. All seven of its round-2 findings
// reduce to one sentence: THAT LINTER ENUMERATED A SUBSET OF POSTGRESQL AND TREATED THE SUBSET AS
// THE WHOLE — which is the defect class the linter exists to detect, restated as its own
// implementation. Two of the findings were the lexer desyncing on constructs nobody had told it
// about (a dollar tag inside a block comment; a backslash escape ending an E-string early). A
// hand-written subset of a grammar cannot be argued into completeness; it can only be extended each
// time reality exceeds it. So nothing here decides what SQL is.
//
// `libpg_query` IS the PostgreSQL server's parser, compiled from the same C sources, and it is
// asked both questions the old lexer answered by hand:
//
//   raw_parse         the raw parse tree — statement boundaries, dollar quoting, every literal
//                     form, comments, all of it, by construction rather than by enumeration
//   raw_parse_plpgsql the PL/pgSQL routine body inside `DO` and `CREATE FUNCTION`, broken into
//                     statements with their line numbers and their SQL text
//
// WHAT THE RULES SEE. `parseMigration()` returns SITES. A site is ONE SQL query as the grammar sees
// it: a top-level statement, or one expression inside one PL/pgSQL routine. That granularity is not
// a convenience — it is the correction #423 failed twice to make. Its evidence for "this place
// checks enablement" was first file-global and then block-global, so one correct guard discharged
// the requirement for every other guard beside it. A rule that judges a site must gather its
// evidence from that site.
//
// WHY THIS BINDING IS CALLED THROUGH ITS RAW ENTRY POINTS. `pg-query-emscripten`'s convenience
// wrappers copy the input onto the WASM STACK (`allocate(…, ALLOC_STACK)`) and never unwind it; the
// `_free` that follows does not apply to a stack pointer. Measured on this repository: an instance
// dies after 44,590–62,874 cumulative input bytes — an emscripten 64 KB stack — and the largest
// migration here is 177,493 bytes, which the wrapper cannot parse at all, on any instance, ever.
// This adapter therefore allocates on the HEAP and frees what it allocated. Measured after the
// change: 20,000 parses in 2.6 s with no growth, and the 177 KB file parses. The alternative
// considered and rejected was recycling the module on a byte budget, which would have hidden a
// library defect behind a magic number and still could not have parsed the largest file.
//
// WHERE THIS ADAPTER STOPS, IT SAYS SO. A routine body the PL/pgSQL parser rejects, a body the raw
// parser reports but that is not findable in the source, and a SQL text the grammar refuses all
// THROW, naming the file. Silence is the failure mode this whole unit exists to refuse, so the
// adapter never degrades quietly to "found nothing".

import initPgQuery from 'pg-query-emscripten';

let pg = null;

/** Load the WASM parser once per process. */
export async function loadParser() {
  if (pg === null) pg = await initPgQuery();
  return pg;
}

/** Hand `text` to a raw libpg_query entry point on the heap, and give the heap back afterwards. */
function callWithText(rawFn, text) {
  if (pg === null) throw new Error('pg-parse: call loadParser() first');
  const bytes = Buffer.from(text, 'utf8');
  const buffer = new Uint8Array(bytes.length + 1); // libpg_query reads a NUL-terminated C string
  buffer.set(bytes);
  const pointer = pg.allocate(buffer, 0); // 0 = ALLOC_NORMAL: the heap, not the 64 KB stack
  try {
    return rawFn.call(pg, pointer);
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
  const result = callWithText(pg.raw_parse, sql);
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
  const result = callWithText(pg.raw_parse_plpgsql, statementSql);
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

/** The relations a query names, lowercased. */
export const relationsIn = (tree) => nodesOfType(tree, 'RangeVar')
  .map((r) => String(r.relname ?? '').toLowerCase());

/** The final field of every column reference — `k.contype` and a bare `contype` both give `contype`. */
export const columnsIn = (tree) => nodesOfType(tree, 'ColumnRef')
  .map((ref) => (ref.fields ?? [])[(ref.fields ?? []).length - 1])
  .filter((last) => typeof last?.String?.sval === 'string')
  .map((last) => last.String.sval.toLowerCase());

/** Every string constant in a subtree, as the parser resolved it — no unquoting of our own. */
export const stringConstsIn = (tree) => nodesOfType(tree, 'A_Const')
  .filter((c) => typeof c.sval?.sval === 'string')
  .map((c) => c.sval.sval);

// Every offset libpg_query reports is a BYTE offset, and these migrations contain `§`, `─` and
// other multi-byte characters, so all position arithmetic happens in a Buffer. Doing it in JS
// string indices slices a statement mid-character: measured, that mis-sliced 48 of the 91
// migrations here before the offsets were moved into byte space.
const NEWLINE = 0x0a;
const lineOfByteOffset = (buffer, offset) => {
  let line = 1;
  for (let i = 0; i < offset && i < buffer.length; i += 1) if (buffer[i] === NEWLINE) line += 1;
  return line;
};

// Every SQL text inside a routine lives in a `PLpgSQL_expr.query`, so the walk collects EVERY one
// and attributes it to the nearest enclosing `lineno`. That is total over whatever statement kinds
// a routine contains, rather than over a list of the kinds this repository has used so far.
function* plpgsqlExpressions(value, lineno) {
  if (Array.isArray(value)) {
    for (const item of value) yield* plpgsqlExpressions(item, lineno);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const here = typeof value.lineno === 'number' ? value.lineno : lineno;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'PLpgSQL_expr' && typeof child?.query === 'string') {
      yield { query: child.query, parseMode: child.parseMode ?? 0, lineno: here };
    }
    yield* plpgsqlExpressions(child, here);
  }
}

/**
 * Read one PL/pgSQL fragment as SQL, in whichever reading its parse mode calls for.
 *
 * `parseMode` 0 is a complete statement. Every other mode is a fragment the grammar accepts only in
 * a value position, which `SELECT` supplies. The assignment modes additionally carry their TARGET
 * in the same string — `NEW."disputedAtVersion" := (SELECT …)` — and the right-hand side of one of
 * those is where a real query can hide; 91 fragments across this corpus are assignments, and 19 of
 * them assign the result of a sub-select. The split point is not guessed: every `:=` in the text is
 * offered to the parser in turn and the first reading it ACCEPTS is the one used, so a quoted
 * identifier that happens to contain `:=` cannot mis-split it.
 */
function parseFragment(expr) {
  const candidates = expr.parseMode === 0 ? [expr.query] : [`SELECT ${expr.query}`];
  if (expr.parseMode !== 0) {
    for (let at = expr.query.indexOf(':='); at !== -1; at = expr.query.indexOf(':=', at + 2)) {
      candidates.push(`SELECT (${expr.query.slice(at + 2)})`);
    }
  }
  for (const text of candidates) {
    try {
      return parseSql(text);
    } catch {
      // try the next reading
    }
  }
  return null;
}

const ROUTINE_STATEMENTS = new Set(['DoStmt', 'CreateFunctionStmt']);

// A routine's body is the string the raw parser already extracted, so its position in the file is
// found by locating that exact string. No dollar-tag matching of our own, at any point.
function routineBodies(tree, buffer) {
  const out = [];
  let searchFrom = 0;
  for (const { type, node, statement } of topLevelRoutineStatements(tree)) {
    let body = null;
    if (type === 'DoStmt') {
      for (const arg of node.args ?? []) {
        if (arg.DefElem?.defname === 'as') body = arg.DefElem.arg?.String?.sval ?? null;
      }
    } else if (type === 'CreateFunctionStmt') {
      const options = node.options ?? [];
      const lang = options.find((o) => o.DefElem?.defname === 'language')?.DefElem?.arg?.String?.sval ?? '';
      if (lang.toLowerCase() !== 'plpgsql') continue;
      let arg = options.find((o) => o.DefElem?.defname === 'as')?.DefElem?.arg;
      if (arg?.List) arg = arg.List.items;
      body = (Array.isArray(arg) ? arg : [arg])[0]?.String?.sval ?? null;
    }
    if (body === null) continue;
    const bodyBytes = Buffer.from(body, 'utf8');
    const at = buffer.indexOf(bodyBytes, searchFrom);
    if (at === -1) throw new Error('pg-parse: a routine body the parser returned is not findable in the source');
    searchFrom = at + bodyBytes.length;
    // `lineno` 1 in the PL/pgSQL tree is the line the body STARTS on — the line carrying the
    // opening dollar tag — so the two line spaces differ by exactly this offset.
    const from = statement.stmt_location ?? 0;
    const to = typeof statement.stmt_len === 'number' ? from + statement.stmt_len : buffer.length;
    out.push({
      kind: type,
      body,
      startLine: lineOfByteOffset(buffer, at),
      statementSql: buffer.subarray(from, to).toString('utf8'),
    });
  }
  return out;
}

/** The top-level statements that declare a PL/pgSQL routine, each with its raw-tree entry. */
function* topLevelRoutineStatements(tree) {
  for (const statement of tree.stmts ?? []) {
    for (const { type, node } of walk(statement.stmt)) {
      if (ROUTINE_STATEMENTS.has(type)) yield { type, node, statement };
    }
  }
}

/**
 * Parse one migration into the SITES the rules judge.
 *
 * Each site is `{ line, sql, tree, routine }`. `routine` is null for a top-level statement and
 * otherwise the enclosing PL/pgSQL routine, which a rule may read for CONTEXT — does this routine
 * refuse? — but never for EVIDENCE about the site.
 */
export function parseMigration(sql) {
  const buffer = Buffer.from(sql, 'utf8');
  const tree = parseSql(sql);
  const sites = [];

  const statements = (tree.stmts ?? []).map((s, index) => ({
    index,
    line: lineOfByteOffset(buffer, s.stmt_location ?? 0),
    node: s.stmt,
    type: Object.keys(s.stmt ?? {})[0] ?? null,
  }));

  for (const s of statements) {
    if (ROUTINE_STATEMENTS.has(s.type)) continue;
    sites.push({ line: s.line, sql: null, tree: s.node, routine: null });
  }

  const routines = routineBodies(tree, buffer).map((body) => {
    const compiled = parsePlpgsqlStatement(body.statementSql);
    const routine = { ...body, tree: compiled };
    for (const expr of plpgsqlExpressions(compiled, 1)) {
      const exprTree = parseFragment(expr);
      if (exprTree === null) {
        // Refused in every reading the grammar offers. Counted rather than shrugged off:
        // `migration-lint.test.mjs` pins the corpus total at zero, so a construct this adapter
        // cannot read cannot appear without failing a test.
        routine.unparsed = (routine.unparsed ?? 0) + 1;
        continue;
      }
      sites.push({
        line: body.startLine + Math.max(0, expr.lineno - 1),
        sql: expr.query,
        tree: exprTree,
        routine,
      });
    }
    return routine;
  });

  sites.sort((a, b) => a.line - b.line);
  return { statements, sites, routines };
}
