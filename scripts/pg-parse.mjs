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

/** The relations a query names, lowercased — how a reader asks what a site actually queries. */
export const relationsIn = (tree) => nodesOfType(tree, 'RangeVar')
  .map((r) => String(r.relname ?? '').toLowerCase());

/** The relations a query names, lowercased. */
// Every offset libpg_query reports is a BYTE offset, and these migrations contain `§`, `─` and
// other multi-byte characters, so all position arithmetic happens in a Buffer. Doing it in JS
// string indices slices a statement mid-character: measured, that mis-sliced 48 of the 91
// migrations here before the offsets were moved into byte space.
const NEWLINE = 0x0a;
const isSpace = (byte) => byte === 0x20 || byte === NEWLINE || byte === 0x09 || byte === 0x0d;
/** The first byte of actual text at or after `from`, so a site is reported at its own line. */
const firstNonSpace = (buffer, from, to) => {
  let at = from;
  while (at < to && at < buffer.length && isSpace(buffer[at])) at += 1;
  return at;
};
const lineOfByteOffset = (buffer, offset) => {
  let line = 1;
  for (let i = 0; i < offset && i < buffer.length; i += 1) if (buffer[i] === NEWLINE) line += 1;
  return line;
};

// EVERY PL/pgSQL STATEMENT KIND, CLASSIFIED — and an unknown one THROWS.
//
// The eleven below are the kinds the 91 migrations actually contain, enumerated rather than
// imagined. What matters is not the list but the `default:` case it does not have: a kind absent
// from this table stops the run and names itself, instead of having its SQL walked as if the
// walker understood the position it sat in. PL/pgSQL has dynamic-SQL statements this repository has
// never used — `dynfors`, `open … FOR EXECUTE`, `return_query EXECUTE` — and each would otherwise
// arrive looking exactly like an ordinary expression.
//
// `dynamicSqlField` names the field whose expression EVALUATES TO SQL TEXT rather than being SQL.
// Reading `EXECUTE 'SELECT … FROM pg_constraint WHERE contype = ''f'''` as an ordinary expression
// parses the string LITERAL and never the statement PostgreSQL will run, so the guard inside it
// becomes invisible to every rule — a linter reporting clean about SQL it never read.
const PLPGSQL_STATEMENT_KINDS = new Map([
  ['PLpgSQL_stmt_assign', {}],
  ['PLpgSQL_stmt_block', {}],
  ['PLpgSQL_stmt_dynexecute', { dynamicSqlField: 'query' }],
  ['PLpgSQL_stmt_execsql', {}],
  ['PLpgSQL_stmt_exit', {}],
  ['PLpgSQL_stmt_foreach_a', {}],
  ['PLpgSQL_stmt_fors', {}],
  ['PLpgSQL_stmt_if', {}],
  ['PLpgSQL_stmt_perform', {}],
  ['PLpgSQL_stmt_raise', {}],
  ['PLpgSQL_stmt_return', {}],
]);

// Every SQL text inside a routine lives in a `PLpgSQL_expr.query`, so the walk collects EVERY one
// and attributes it to the nearest enclosing `lineno`, carrying whether it sits in a dynamic-SQL
// position. That is total over whatever expressions a routine contains, while the statement table
// above keeps it total over the statement kinds those expressions sit in.
function* plpgsqlExpressions(value, lineno, dynamic = false) {
  if (Array.isArray(value)) {
    for (const item of value) yield* plpgsqlExpressions(item, lineno, dynamic);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const here = typeof value.lineno === 'number' ? value.lineno : lineno;
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith('PLpgSQL_stmt_')) {
      const kind = PLPGSQL_STATEMENT_KINDS.get(key);
      if (kind === undefined) {
        throw new Error(`pg-parse: unclassified PL/pgSQL statement ${key} — add it to `
          + 'PLPGSQL_STATEMENT_KINDS, saying whether any of its fields evaluates to SQL text, '
          + 'rather than letting the SQL inside it pass unread');
      }
      const statementLine = typeof child?.lineno === 'number' ? child.lineno : here;
      for (const [field, sub] of Object.entries(child ?? {})) {
        yield* plpgsqlExpressions(sub, statementLine, field === kind.dynamicSqlField);
      }
      continue;
    }
    if (key === 'PLpgSQL_expr' && typeof child?.query === 'string') {
      yield { query: child.query, parseMode: child.parseMode ?? 0, lineno: here, dynamic };
      continue;
    }
    yield* plpgsqlExpressions(child, here, dynamic);
  }
}

/**
 * Fold a dynamic-SQL expression to the constant text it always produces, or null.
 *
 * `EXECUTE 'SELECT …'` and `EXECUTE 'CREATE ' || 'TABLE …'` are decidable: the statement is written
 * in the file and is parsed for real. `EXECUTE format('DROP TRIGGER %I ON %I', …)` is not — its
 * text does not exist until the migration runs. The two are told apart by the parse tree, not by
 * pattern: a string constant, or a `||` of string constants, folds; anything else does not.
 */
function foldConstantSql(node) {
  if (typeof node?.A_Const?.sval?.sval === 'string') return node.A_Const.sval.sval;
  const expr = node?.A_Expr;
  if (expr && (expr.name ?? []).some((n) => n.String?.sval === '||')) {
    const left = foldConstantSql(expr.lexpr);
    const right = foldConstantSql(expr.rexpr);
    return left === null || right === null ? null : left + right;
  }
  return null;
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

// A ROUTINE BODY IS NOT ALWAYS PL/pgSQL, and the difference is not cosmetic.
//
// An earlier head skipped every `CREATE FUNCTION … LANGUAGE sql` body with a bare `continue`, and
// because `CreateFunctionStmt` is ALSO excluded from ordinary top-level sites, those bodies were
// visible to nothing at all — no site, no fragment, no count. This corpus holds five of them. A
// migration may define a SQL helper that queries the catalog and call it from a later guard; the
// call site shows only the call, so the query existed in a place the linter reported as fully read.
// That is the same defect the dynamic-`EXECUTE` correction closed, in a second location.
//
// So a body is classified by its DECLARED LANGUAGE and every branch is total:
//   plpgsql  compiled by the PL/pgSQL parser, as before
//   sql      parsed by the SQL grammar — its statements become ordinary sites
//   anything else, or a body the grammar refuses, is an UNREADABLE FRAGMENT, named and counted.
const defElem = (list, name) => (list ?? [])
  .find((o) => o.DefElem?.defname === name)?.DefElem?.arg;

const bodyOf = (node, type) => {
  // `DO` CARRIES A LANGUAGE TOO, and assuming `plpgsql` here is not a harmless default: PostgreSQL
  // accepts `DO LANGUAGE plpython3u $$ … $$` for any installed procedural language, and a body
  // assumed to be PL/pgSQL is handed to `raw_parse_plpgsql`, which ABORTS on it. That turns a
  // construct this adapter merely cannot read — which it is supposed to report as a fragment and
  // let an explicit pin cover — into a hard failure no pin can clear. The grammar records the
  // language, so it is read, and `plpgsql` is the default ONLY when the clause is absent, which is
  // what the default means in PostgreSQL.
  const list = type === 'DoStmt' ? node.args : node.options;
  const declared = defElem(list, 'language')?.String?.sval;
  const language = String(declared ?? (type === 'DoStmt' ? 'plpgsql' : '')).toLowerCase();
  let arg = defElem(list, 'as');
  if (arg?.List) arg = arg.List.items;
  return { language, body: (Array.isArray(arg) ? arg : [arg])[0]?.String?.sval ?? null };
};

// A routine's body is the string the raw parser already extracted, so its position in the file is
// found by locating that exact string. No dollar-tag matching of our own, at any point.
function routineBodies(tree, buffer) {
  const out = [];
  for (const { type, node, statement } of topLevelRoutineStatements(tree)) {
    const { language, body } = bodyOf(node, type);
    const from = statement.stmt_location ?? 0;
    const declaredAt = lineOfByteOffset(buffer, from);
    if (body === null) {
      // A routine whose body this adapter cannot even locate is reported, never passed over: a
      // `CREATE FUNCTION` with no readable `AS` is SQL nobody read.
      out.push({ kind: type, language, body: null, startLine: declaredAt, statementSql: null });
      continue;
    }
    // THE BODY IS FOUND INSIDE ITS OWN STATEMENT, and from the END of it.
    //
    // A forward search takes the FIRST occurrence of the body text — and a comment quoting a short
    // body, or a second routine with an identical one-line body, is such an occurrence. The routine
    // and every site inside it are then reported at unrelated text, which is worse than not
    // reporting them: an exact fragment pin would point somewhere meaningless.
    //
    // Bounding the search to the statement's own byte range is NOT sufficient, and the reason is
    // measured rather than assumed: libpg_query omits `stmt_location` entirely for a first
    // statement, so its span begins at byte 0 and includes every comment before it. What is
    // reliable is the other end — a routine's body is the LAST thing in its own declaration before
    // the language clause, so the span is searched BACKWARDS and the first hit from that end is
    // the real body. (Measured on the probe in `migration-readability.test.mjs`: the decoy sits at
    // byte 33 and the body at 119, inside a span of 0..165.)
    const to = Math.min(
      typeof statement.stmt_len === 'number' ? from + statement.stmt_len : buffer.length,
      buffer.length,
    );
    const bodyBytes = Buffer.from(body, 'utf8');
    const at = buffer.lastIndexOf(bodyBytes, to - bodyBytes.length);
    if (at === -1 || at < from) {
      throw new Error('pg-parse: a routine body the parser returned is not findable inside its own '
        + `statement (bytes ${from}..${to})`);
    }
    // `lineno` 1 in the PL/pgSQL tree is the line the body STARTS on — the line carrying the
    // opening dollar tag — so the two line spaces differ by exactly this offset.
    out.push({
      kind: type,
      language,
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
 * One site per STATEMENT of a parsed SQL text — the only way either caller turns text into sites.
 *
 * It is shared rather than written twice because the two callers already drifted apart once: the
 * SQL-body path split its statements while the dynamic-`EXECUTE` path recorded the whole tree as a
 * single site, so `EXECUTE 'SELECT …; SELECT …'` produced ONE site spanning two commands. A rule
 * judging that site would gather evidence from one command and excuse a defect in its neighbour —
 * the cross-neighbour false pass this adapter exists to make impossible. Two call sites that must
 * agree are one function.
 *
 * `lineFor` maps a byte offset inside `text` to a line in the FILE. The two callers know different
 * things and say so: a routine body has a real span in the file, so its offsets resolve to real
 * lines; a dynamic string was folded from constants and has no single span, so every statement in
 * it is reported at the `EXECUTE` that runs it.
 */
function* sqlTextSites(text, lineFor) {
  const buffer = Buffer.from(text, 'utf8');
  for (const inner of parseSql(text).stmts ?? []) {
    const from = inner.stmt_location ?? 0;
    const to = typeof inner.stmt_len === 'number' ? from + inner.stmt_len : buffer.length;
    yield {
      // libpg_query reports `stmt_location` 0 for a first statement, which includes any leading
      // newline, so the offset is advanced to real text before it is turned into a line.
      line: lineFor(firstNonSpace(buffer, from, to)),
      sql: buffer.subarray(from, to).toString('utf8').trim(),
      tree: inner.stmt,
    };
  }
}

/**
 * Parse one migration into the SITES the rules judge.
 *
 * Each site is `{ line, sql, tree, routine }`. `routine` is null for a top-level statement and
 * otherwise the enclosing routine, which a reader may consult for CONTEXT but never for EVIDENCE
 * about the site itself.
 *
 * `unreadable` is the other half of the answer and it is RETURNED, not swallowed: one entry per
 * fragment this adapter could not read as SQL, each with its line and why. The two lists together
 * are the claim this unit makes — everything in the corpus is either a site or a named fragment,
 * and nothing is silently neither.
 */
export function parseMigration(sql) {
  const buffer = Buffer.from(sql, 'utf8');
  const tree = parseSql(sql);
  const sites = [];

  // EVERY site carries its own text, top-level statements included. A site with no text cannot be
  // identified, reported at a line a reader can open, or told apart from its neighbours.
  const statements = (tree.stmts ?? []).map((s, index) => {
    const from = s.stmt_location ?? 0;
    return {
      index,
      line: lineOfByteOffset(buffer, from),
      node: s.stmt,
      sql: buffer.subarray(from, typeof s.stmt_len === 'number' ? from + s.stmt_len : buffer.length)
        .toString('utf8'),
      type: Object.keys(s.stmt ?? {})[0] ?? null,
    };
  });

  for (const s of statements) {
    if (ROUTINE_STATEMENTS.has(s.type)) continue;
    sites.push({ line: s.line, sql: s.sql, tree: s.node, routine: null });
  }

  const unreadable = [];
  const routines = [];
  for (const body of routineBodies(tree, buffer)) {
    // ── A body this adapter has no reader for is NAMED, never stepped over ────────────────────
    if (body.body === null) {
      unreadable.push({ line: body.startLine, kind: 'body-not-found', detail: body.language });
      continue;
    }
    if (body.language === 'sql') {
      // A SQL-language body IS SQL. It is parsed by the SQL grammar and its statements become
      // ordinary sites, so a catalog query written in a SQL helper is read like any other.
      let bodySites = null;
      let bodyTree = null;
      try {
        bodyTree = parseSql(body.body);
        // `startLine` is the line the body OPENS on and offsets inside it are relative to that,
        // so the two line spaces compose by addition.
        const bodyBuffer = Buffer.from(body.body, 'utf8');
        bodySites = [...sqlTextSites(body.body,
          (at) => body.startLine + lineOfByteOffset(bodyBuffer, at) - 1)];
      } catch {
        bodySites = null;
      }
      if (bodySites === null) {
        unreadable.push({ line: body.startLine, kind: 'sql-body-unparsed', detail: body.language });
        continue;
      }
      const routine = { ...body, tree: bodyTree };
      for (const site of bodySites) sites.push({ ...site, routine });
      routines.push(routine);
      continue;
    }
    if (body.language !== 'plpgsql') {
      // C, PL/Python, anything else: this adapter has no reader, and saying so is the only honest
      // report. Silently continuing is what let five SQL bodies vanish from the accounting.
      unreadable.push({ line: body.startLine, kind: 'language-unsupported', detail: body.language });
      continue;
    }

    const compiled = parsePlpgsqlStatement(body.statementSql);
    const routine = { ...body, tree: compiled };
    for (const expr of plpgsqlExpressions(compiled, 1)) {
      const line = body.startLine + Math.max(0, expr.lineno - 1);

      // A dynamic-SQL position is read as the STATEMENT it produces, never as the string that
      // produces it. When the text is decidable from the file it is parsed for real and becomes an
      // ordinary site. When it is not, it is REPORTED — the test pins the exact set, so a new one
      // cannot appear without a visible diff — rather than being handed on as a harmless string
      // expression a reader will find nothing in.
      if (expr.dynamic) {
        const valueTree = parseFragment({ ...expr, dynamic: false });
        const value = valueTree === null ? null : nodesOfType(valueTree, 'ResTarget')[0]?.val;
        const text = value ? foldConstantSql(value) : null;
        let executed = null;
        if (text !== null) {
          try {
            // A folded constant has no single span in the file, so every statement it holds is
            // reported at the `EXECUTE` that runs it — the line a reader would actually open.
            executed = [...sqlTextSites(text, () => line)];
          } catch {
            executed = null;
          }
        }
        if (executed === null) {
          unreadable.push({ line, kind: 'dynamic-unresolved', detail: expr.query });
          continue;
        }
        for (const site of executed) sites.push({ ...site, routine, dynamic: true });
        continue;
      }

      const exprTree = parseFragment(expr);
      if (exprTree === null) {
        unreadable.push({ line, kind: 'fragment-unparsed', detail: expr.query });
        continue;
      }
      sites.push({ line, sql: expr.query, tree: exprTree, routine });
    }
    routines.push(routine);
  }

  sites.sort((a, b) => a.line - b.line);
  unreadable.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  return { statements, sites, routines, unreadable };
}
