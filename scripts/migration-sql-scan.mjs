// A lexical scanner for PostgreSQL migration files, and the reason this repository has one.
//
// These files are more comment than code — the schedule B1 migration is 2,336 lines of which most
// are prose explaining the SQL, and that prose says `SET LOCAL`, `pg_get_constraintdef` and
// `tgenabled` constantly. A linter grepping raw text would read a comment DESCRIBING a defect as
// the defect and — far worse — read a comment that merely MENTIONS `pg_get_constraintdef` as proof
// the comparison is present. That second failure is the exact class this linter exists to prevent.
//
// So the scanner produces a MASK: same length as the source, every byte of a comment or string
// literal blanked to a space, every byte of real SQL kept. Offsets are identical in both, so a
// match on the mask maps back to a source line with no bookkeeping. Every rule reads the mask.
//
// The dollar-quote handling has to be exactly right: these migrations nest `$body$ … $body$` inside
// `DO $install$ … $install$`, so a scanner treating `$$` as a single toggle desynchronises and
// masks half the SQL as string content — which fails OPEN, reporting a clean file.

/**
 * A dollar-quote tag is `$`, an optional identifier, `$`. The identifier follows the same rules
 * as an unquoted SQL identifier: it may not start with a digit.
 */
const DOLLAR_TAG = /^\$([A-Za-z_-￿][A-Za-z0-9_-￿]*)?\$/u;

/**
 * Scan `sql` and return `{ mask, lineOf }`.
 *
 * `mask` is the same length as `sql`, with comment/literal/dollar-body bytes blanked to spaces.
 * Newlines are PRESERVED inside blanked regions so that line numbers still work and so that a
 * `--` comment cannot swallow the line after it.
 *
 * `lineOf(offset)` returns the 1-based line number for an offset into either string.
 */
export function scan(sql) {
  const mask = new Array(sql.length);
  const tagStack = [];
  let i = 0;

  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) mask[k] = sql[k] === '\n' ? '\n' : ' ';
  };

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      let end = sql.indexOf('\n', i);
      if (end === -1) end = sql.length;
      blank(i, end);
      i = end;
      continue;
    }

    if (two === '/*') {
      // Block comments NEST in PostgreSQL, unlike C. `/* /* */ */` is one comment, and a scanner
      // that stopped at the first `*/` would resume inside a comment and mask real SQL as code.
      let depth = 1;
      let k = i + 2;
      while (k < sql.length && depth > 0) {
        if (sql.slice(k, k + 2) === '/*') { depth += 1; k += 2; continue; }
        if (sql.slice(k, k + 2) === '*/') { depth -= 1; k += 2; continue; }
        k += 1;
      }
      blank(i, k);
      i = k;
      continue;
    }

    if (sql[i] === "'") {
      // A single-quoted literal. `''` is an escaped quote and does NOT end it.
      let k = i + 1;
      while (k < sql.length) {
        if (sql[k] === "'" && sql[k + 1] === "'") { k += 2; continue; }
        if (sql[k] === "'") { k += 1; break; }
        k += 1;
      }
      // Keep the delimiters as code so a rule can still see that a literal was PRESENT.
      mask[i] = "'";
      blank(i + 1, Math.max(i + 1, k - 1));
      if (k - 1 > i) mask[k - 1] = "'";
      i = k;
      continue;
    }

    if (sql[i] === '"') {
      // A quoted IDENTIFIER is code, not a literal — `"ActivityDependency"` is the object's name
      // and every rule here needs to read it. It is left intact; only the escape rule matters.
      let k = i + 1;
      while (k < sql.length) {
        if (sql[k] === '"' && sql[k + 1] === '"') { k += 2; continue; }
        if (sql[k] === '"') { k += 1; break; }
        k += 1;
      }
      i = k;
      continue;
    }

    if (sql[i] === '$') {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        // A dollar-quoted body is NOT masked. In ordinary SQL `$$ … $$` holds a string; in these
        // migrations it holds the PL/pgSQL every rule here is about — the catalog guards, the
        // trigger bodies, the emptiness fast path. Blanking it hid 100% of the code under test:
        // measured, the first draft found MI-001, MI-002 and MI-005 nowhere in the corpus,
        // including on the heads that provably contain them. So the body is SCANNED THROUGH with a
        // tag stack pairing delimiters; comments and literals nested inside are still blanked.
        const tag = m[0];
        if (tagStack.at(-1) === tag) tagStack.pop(); else tagStack.push(tag);
        for (let k = i; k < i + tag.length; k += 1) mask[k] = sql[k];
        i += tag.length;
        continue;
      }
    }

    mask[i] = sql[i];
    i += 1;
  }

  for (let k = 0; k < sql.length; k += 1) if (mask[k] === undefined) mask[k] = sql[k];

  const lineStarts = [0];
  for (let k = 0; k < sql.length; k += 1) if (sql[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  return { mask: mask.join(''), lineOf };
}

/**
 * Enumerate the DOLLAR-QUOTED BLOCKS, outermost first, with nesting depth. `DO $$ … $$` and
 * `CREATE FUNCTION … AS $body$ … $body$` are the shapes that matter; both outer and inner are
 * returned because some rules ask about the guard and some about the body nested inside it.
 */
export function dollarBlocks(sql) {
  const blocks = [];
  const walk = (text, base, depth) => {
    let i = 0;
    while (i < text.length) {
      if (text[i] === '$') {
        const m = DOLLAR_TAG.exec(text.slice(i));
        if (m) {
          const tag = m[0];
          const close = text.indexOf(tag, i + tag.length);
          if (close !== -1) {
            const bodyStart = i + tag.length;
            blocks.push({
              tag,
              depth,
              start: base + i,
              bodyStart: base + bodyStart,
              bodyEnd: base + close,
              end: base + close + tag.length,
              body: text.slice(bodyStart, close),
            });
            walk(text.slice(bodyStart, close), base + bodyStart, depth + 1);
            i = close + tag.length;
            continue;
          }
        }
      }
      // Skip over the constructs that can CONTAIN a `$` that is not a tag.
      if (text.slice(i, i + 2) === '--') {
        const nl = text.indexOf('\n', i);
        i = nl === -1 ? text.length : nl;
        continue;
      }
      if (text[i] === "'") {
        let k = i + 1;
        while (k < text.length) {
          if (text[k] === "'" && text[k + 1] === "'") { k += 2; continue; }
          if (text[k] === "'") { k += 1; break; }
          k += 1;
        }
        i = k;
        continue;
      }
      i += 1;
    }
  };
  walk(sql, 0, 0);
  return blocks.sort((a, b) => a.start - b.start || a.depth - b.depth);
}

/**
 * Split the file into TOP-LEVEL statements: `;` at dollar-quote depth zero, read off the mask so
 * a semicolon inside a comment, a literal or a PL/pgSQL body never splits anything.
 */
export function statements(sql) {
  const { mask, lineOf } = scan(sql);
  const outer = dollarBlocks(sql).filter((b) => b.depth === 0);

  const insideBlock = (offset) => outer.some((b) => offset >= b.start && offset < b.end);

  // A fragment whose MASK is blank is comment-only — the prose tail these files end sections with.
  // Offering it for classification would be a false MI-000 finding, the kind that trains a reader
  // to ignore the linter. Measured: two such tails on `main` (20270205000000_phase4_t2_correction,
  // 20270425000000_platform_command_receipt_seal).
  const out = [];
  let start = 0;
  const push = (from, to) => {
    const masked = mask.slice(from, to);
    if (!masked.trim()) return;
    out.push({ raw: sql.slice(from, to), masked, start: from, end: to, line: lineOf(firstCode(mask, from, to - 1)) });
  };
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] !== ';' || insideBlock(i)) continue;
    push(start, i + 1);
    start = i + 1;
  }
  push(start, sql.length);
  return out;
}

/**
 * Enumerate the SINGLE-QUOTED LITERALS with their line numbers. `scan` blanks literal bodies so no
 * rule matches a defect inside one by accident; a rule that genuinely needs them — MI-006 asks
 * whether a constraint NAME is re-stated as an inventory entry — asks here, deliberately.
 */
export function literals(sql) {
  const { lineOf } = scan(sql);
  const out = [];
  let i = 0;
  while (i < sql.length) {
    if (sql.slice(i, i + 2) === '--') { const nl = sql.indexOf('\n', i); i = nl === -1 ? sql.length : nl; continue; }
    if (sql[i] === '$') {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      // Literals inside a dollar-quoted body are still literals: the PL/pgSQL inside a `DO` block
      // is where these files state their inventories. Recurse rather than skip.
      if (m) { i += m[0].length; continue; }
    }
    if (sql[i] === '"') {
      let k = i + 1;
      while (k < sql.length) {
        if (sql[k] === '"' && sql[k + 1] === '"') { k += 2; continue; }
        if (sql[k] === '"') { k += 1; break; }
        k += 1;
      }
      i = k;
      continue;
    }
    if (sql[i] === "'") {
      let k = i + 1;
      let value = '';
      while (k < sql.length) {
        if (sql[k] === "'" && sql[k + 1] === "'") { value += "'"; k += 2; continue; }
        if (sql[k] === "'") { k += 1; break; }
        value += sql[k];
        k += 1;
      }
      out.push({ value, start: i, line: lineOf(i) });
      i = k;
      continue;
    }
    i += 1;
  }
  return out;
}

function firstCode(mask, from, to) {
  for (let k = from; k <= to && k < mask.length; k += 1) if (!/\s/u.test(mask[k])) return k;
  return from;
}
