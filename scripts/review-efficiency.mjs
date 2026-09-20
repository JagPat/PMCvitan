import {
  REVIEW_SCOPE_ENFORCE_AFTER_PR,
  PRE_REVIEW_ENFORCE_AFTER_PR,
  STANDARD_MAX_FILES,
  STANDARD_MAX_CHANGED_LINES,
  REPLACEMENT_REQUIRED_LABEL,
  REQUIRED_PRE_REVIEW_CHECKS,
  REQUIRED_INVARIANTS,
  STATUS_DOCUMENT,
  CODEX_LOGIN,
  HARD_SIZE_CAP_AFTER_PR,
  isRetryableReviewFailureDescription,
} from './review-policy.mjs';
export {
  REVIEW_SCOPE_ENFORCE_AFTER_PR,
  PRE_REVIEW_ENFORCE_AFTER_PR,
  STANDARD_MAX_FILES,
  STANDARD_MAX_CHANGED_LINES,
  REPLACEMENT_REQUIRED_LABEL,
  REQUIRED_PRE_REVIEW_CHECKS,
  REQUIRED_INVARIANTS,
  STATUS_DOCUMENT,
  HARD_SIZE_CAP_AFTER_PR,
  isRetryableReviewFailureDescription,
} from './review-policy.mjs';

// The deferral-phase check shares docs/STATUS.md's own state vocabulary rather than keeping
// a second copy of it — see phaseHasOpenWork.
import { OPEN_TASK_STATES } from './autonomous-status-state.mjs';
import { LINEAGE_BASE_REF, isLineageBase } from './lineage-policy.mjs';
// Correction ownership is checked HERE, in the one assessment both the PR-side
// `review-scope` job and the trusted controller's `enforceReviewScope` call, so
// the cheap gate and the merge boundary cannot disagree about who owns a fix.
import { correctionOwnerProblem } from './correction-owner.mjs';

// Legacy convergence packets retain their parsing threshold; the live gate
// never closes or blocks a PR based on the number of reviewed heads.
export const CONVERGENCE_AFTER_FINDING_HEADS = 2;

// How many finding-bearing heads a DOCS-ONLY review may take before the still-open
// questions must be handed to probes.
//
// The convergence protocol was written for code. On code it terminates, because every
// finding is answered by a RED→GREEN probe and a fix that either works or does not. A
// PLAN has no executable surface: a finding on it can only be answered with more prose,
// and a plan can always be specified further, so the protocol demands a batched audit
// after two heads and then never says when the review is done.
//
// PR #252 is the measurement. Four finding-bearing heads — 8, 8, 7, 7 — every finding
// correct, none contradicted by a later round, and no declining rate. Every finding in
// rounds 2-4 was of the form "the plan does not yet say how X is handled", which is
// always true of a plan at some depth.
//
// THIS IS NOT A DISMISSAL MECHANISM. A finding-dismissal engine was built for this
// repository in PR #250 and withdrawn, because on the first real case it would have
// suppressed a CORRECT finding. Nothing here discounts, filters, or downgrades a finding,
// and the `codex-current-head` status still fails closed on every current-head finding.
// What this bounds is only WHERE the remaining questions get verified: past the cap the
// author must convert each one into a named probe in the plan and name the task whose
// review stop will settle it. The finding is kept and its verification is moved to the
// one place a verification can exist.
export const PLAN_REVIEW_ROUND_CAP = 3;
// `HARD_SIZE_CAP_AFTER_PR` is defined once in review-policy.mjs (with the other scope thresholds)
// and re-exported above, so this consumer and the policy-contract suite read one cutoff.

const LARGE_MARKER = '<!-- review-size: justified-large -->';
const INSEPARABLE_MIGRATION_MARKER = '<!-- migration-scope: inseparable -->';
const CONVERGENCE_PACKET = /^docs\/reviews\/[^/]*convergence[^/]*\.md$/iu;
const MIGRATION_FILE = /^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/u;
const SERVICE_OR_UI_FILE = /^(?:apps\/api\/src|apps\/web\/src|packages\/shared\/src)\//u;
// The hard-cap exemption is for a migration and the SERVICE it cannot be separated from — the API
// that runs the schema. `apps/web/src` (UI) and `packages/shared/src` (a shared library) are not
// that service, so a migration paired only with them is an ordinary oversized unit and must split.
const SERVICE_FILE = /^apps\/api\/src\//u;
const REPLACES_DECLARATION = /^[\t ]*replaces:[\t ]*(none|#\d+)[\t ]*$/gimu;

// A body DECLARES its size and migration markers in the leading marker block and DESCRIBES them
// everywhere else, exactly as correction-owner.mjs reads its own marker (correction-owner.mjs:39-53):
// the leading run of marker-only lines, blanks allowed, ending at the first line that is not a
// marker. A marker quoted in a sentence, a code fence or a later section is prose, so it cannot
// claim the size justification or the sole hard-cap exemption — a whole-body scan let an oversized
// PR quote `<!-- migration-scope: inseparable -->` in explanatory text and pass the trusted gate.
// Two different values for one marker in the block is a contradiction, read as no declaration so
// the exemption/justification fails closed.
function declaredMarker(body, name) {
  const marker = new RegExp(`^<!--\\s*${name}:\\s*([a-z][a-z-]*)\\s*-->$`, 'iu');
  const values = new Set();
  for (const line of String(body ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!/^<!--[\s\S]*-->$/u.test(trimmed)) break;
    const match = marker.exec(trimmed);
    if (match) values.add(match[1].toLowerCase());
  }
  return values.size === 1 ? [...values][0] : undefined;
}

// The seven CommonMark HTML-block kinds, keyed by end condition. GitHub renders the content of ANY
// of them as raw HTML — never as a GFM table — so a table (or a declaration bullet) wrapped in one
// does not render as itself and must not be read by this scanner. This is the FULL, fixed CommonMark
// leaf-block set, so the scanner is complete for HTML blocks rather than a denylist of tags:
//   - types 1-5 close on a specific string on some later line (or the opening line itself): a raw-text
//     element `<pre|script|style|textarea>` (1), an HTML comment `<!--` (2), a processing
//     instruction `<?` (3), a declaration `<!LETTER` (4), and CDATA `<![CDATA[` (5);
//   - types 6 and 7 close at the next BLANK line: a block-level tag from the fixed CommonMark list
//     (6), and any other single complete open/close tag alone on a line that does not interrupt a
//     paragraph (7).
const HTML_BLOCK_TAGS_6 = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption', 'center', 'col',
  'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr',
  'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol',
  'optgroup', 'option', 'p', 'param', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'title', 'tr', 'track', 'ul',
]);
const HTML_TYPE1_OPEN = /^<(?:script|pre|style|textarea)(?:[\t >]|$)/iu;
const HTML_TYPE1_CLOSE = /<\/(?:script|pre|style|textarea)>/iu;
const HTML_TYPE1_NAMES = /^(?:script|pre|style|textarea)$/iu;
const HTML_TAG_NAME = /^<\/?([a-z][a-z0-9-]*)/iu;
const HTML_TYPE6_OPEN = /^<\/?[a-z][a-z0-9-]*(?:[\t >]|\/>|$)/iu;
const HTML_COMPLETE_OPEN_TAG =
  /^<[a-z][a-z0-9-]*(?:\s+[a-z_:][a-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>\s*$/iu;
const HTML_COMPLETE_CLOSE_TAG = /^<\/[a-z][a-z0-9-]*\s*>\s*$/iu;

// The end condition for an open HTML block of the given kind, tested against a whole line.
function htmlBlockEnds(kind, line) {
  switch (kind) {
    case 'comment': return line.includes('-->');
    case 'pi': return line.includes('?>');
    case 'cdata': return line.includes(']]>');
    case 'decl': return line.includes('>');
    case 'raw': return HTML_TYPE1_CLOSE.test(line);
    case 'blank': return line.trim() === '';
    default: return false;
  }
}

// Which HTML-block kind, if any, a top-level (indent < 4) line OPENS, in CommonMark's fixed order.
// `paragraphOpen` gates type 7, which alone cannot interrupt a paragraph.
function htmlBlockStartKind(line, paragraphOpen) {
  if (HTML_TYPE1_OPEN.test(line)) return 'raw'; // type 1
  if (line.startsWith('<!--')) return 'comment'; // type 2
  if (line.startsWith('<?')) return 'pi'; // type 3
  if (/^<!\[CDATA\[/u.test(line)) return 'cdata'; // type 5 (before type 4: `<![` is not `<!LETTER`)
  if (/^<![A-Za-z]/u.test(line)) return 'decl'; // type 4
  const named = HTML_TYPE6_OPEN.test(line) && HTML_TAG_NAME.exec(line);
  if (named && HTML_BLOCK_TAGS_6.has(named[1].toLowerCase())) return 'blank'; // type 6
  if (!paragraphOpen) { // type 7: a single complete tag alone on the line, outside a paragraph
    const tag = HTML_TAG_NAME.exec(line);
    if (tag && !HTML_TYPE1_NAMES.test(tag[1])
      && (HTML_COMPLETE_OPEN_TAG.test(line) || HTML_COMPLETE_CLOSE_TAG.test(line))) return 'blank';
  }
  return null;
}

// Reduce a Markdown body to the lines GitHub renders at the TOP block level, excluding every
// construct it renders as something other than ordinary Markdown — fenced code, indented code, and
// the seven CommonMark HTML blocks (above) — by a BOUNDED, CommonMark-aligned state machine rather
// than an ad-hoc toggle (owner decision, #596). Blank lines are kept as block boundaries. Both the
// invariant-matrix reader and the migration/service-seam reader consume this ONE stream, so neither
// counts content the reader cannot see: a table or a seam bullet hidden in a code fence, an HTML
// comment, or a `<pre>`/`<div>`/`<details>` wrapper does not render as itself and does not count.
//
//   - Fenced code: a line (indent < 4) of >= 3 backticks OR >= 3 tildes opens a fence; it closes
//     ONLY on a later line of the SAME fence character, at least as long, with nothing after the run
//     but whitespace. A different character or a shorter run does NOT close it, and an info string is
//     allowed only on the opener.
//   - HTML block: opened per htmlBlockStartKind and closed per htmlBlockEnds; nothing inside renders
//     as Markdown. A type 6/7 block closes at a blank line, so a real table placed AFTER that blank
//     (the standard `<details>`/`<summary>` + blank + table shape GitHub renders) is seen again.
//   - Indented code: a line indented four spaces or a tab renders as code, not a table.
function renderedTopLevelLines(body) {
  const top = [];
  let fence = null; // { char: '`' | '~', len } while inside a fenced code block
  let html = null; // an htmlBlockEnds kind while inside an HTML block
  let paragraphOpen = false;
  for (const line of String(body ?? '').split(/\r?\n/u)) {
    if (html) {
      if (htmlBlockEnds(html, line)) {
        // A type 6/7 block ends AT the blank line, which is itself a boundary; a type 1-5 block ends
        // ON its closing line, which is part of the block and renders nothing.
        if (html === 'blank') { top.push(''); paragraphOpen = false; }
        html = null;
      }
      continue;
    }
    const trimmed = line.replace(/^[\t ]+/u, '');
    const indent = line.length - trimmed.length;
    if (fence) {
      const fenceRun = indent < 4 ? /^(`{3,}|~{3,})/u.exec(trimmed) : null;
      if (fenceRun && fenceRun[1][0] === fence.char && fenceRun[1].length >= fence.len
        && trimmed.slice(fenceRun[1].length).trim() === '') fence = null;
      continue; // no line inside a fenced code block is a table row
    }
    if (indent < 4) {
      const fenceRun = /^(`{3,}|~{3,})/u.exec(trimmed);
      if (fenceRun) { fence = { char: fenceRun[1][0], len: fenceRun[1].length }; paragraphOpen = false; continue; }
      const kind = htmlBlockStartKind(trimmed, paragraphOpen);
      if (kind) {
        paragraphOpen = false;
        // A type 1-5 block may open and close on its own line; a type 6/7 block runs to a blank line.
        html = kind !== 'blank' && htmlBlockEnds(kind, line) ? null : kind;
        continue;
      }
    }
    if (indent >= 4) continue; // an indented code block renders as code, not a table
    top.push(trimmed);
    paragraphOpen = trimmed !== '';
  }
  return top;
}

// The invariant-matrix rows that actually RENDER as a GFM table row. Read from the top-level rendered
// stream (renderedTopLevelLines), so no row inside a fence, comment, indented code or HTML block is
// counted. Whether the rendered matrix is genuinely concrete stays the reviewer's judgement; this
// only decides which rows render at all.
function matrixRows(body) {
  const top = renderedTopLevelLines(body);
  // A GFM table is a header row, a DELIMITER row (`| --- | --- |`) of matching column count, then
  //    contiguous pipe rows until a blank or non-pipe line. Only those data rows render as a table —
  //    six bare pipe lines with no delimiter render as ordinary pipe-filled text, not a matrix — so
  //    the gate counts a row only when it belongs to a real table. This is the table grammar itself,
  //    not a denylist of shapes.
  const rows = [];
  for (let i = 0; i < top.length; i += 1) {
    const header = top[i];
    const delimiter = top[i + 1];
    if (!header.includes('|') || delimiter === undefined || !isDelimiterRow(delimiter)) continue;
    if (splitCells(header).length !== splitCells(delimiter).length) continue;
    let j = i + 2;
    for (; j < top.length && top[j].trim() !== '' && top[j].includes('|'); j += 1) {
      rows.push(splitCells(top[j]));
    }
    i = j - 1; // skip the consumed table so its body is not rescanned as a new header
  }
  return rows;
}

// A GFM delimiter row: every cell is a run of hyphens, optionally colon-bracketed for alignment
// (`---`, `:--`, `--:`, `:-:`). Its presence directly under a header row is what makes GitHub render
// the following pipe lines as a table.
function isDelimiterRow(line) {
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/u.test(cell));
}

// Split a table row into cells on UNESCAPED pipes, with correct backslash PARITY. A single `\|` is a
// literal pipe inside a cell; `\\|` is an escaped backslash (a literal `\`) followed by a real cell
// delimiter. A lookbehind cannot count the backslash run, so this walks the line: a backslash
// escapes the next character, any other `|` is a delimiter. A leading and a trailing EMPTY cell (the
// row's optional outer pipes) are dropped; `\|` and `\\` are unescaped and each cell is trimmed.
function splitCells(line) {
  const cells = [];
  let cell = '';
  let escaped = false;
  for (const ch of String(line)) {
    if (escaped) { cell += ch; escaped = false; continue; }
    if (ch === '\\') { cell += ch; escaped = true; continue; }
    if (ch === '|') { cells.push(cell); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell);
  const trimmed = cells.map((c) => c.replace(/\\([|\\])/gu, '$1').trim());
  if (trimmed.length > 0 && trimmed[0] === '') trimmed.shift();
  if (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}

function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export function replacementDeclaration(body) {
  const source = typeof body === 'string' ? body : '';
  const matches = [...source.matchAll(REPLACES_DECLARATION)];
  if (matches.length !== 1) return { kind: 'invalid', source: null };
  if (matches[0][1].toLowerCase() === 'none') {
    return { kind: 'none', source: null };
  }
  const number = Number(matches[0][1].slice(1));
  return Number.isInteger(number) && number > 0
    ? { kind: 'source', source: number }
    : { kind: 'invalid', source: null };
}

export function replacementSource(body) {
  const declaration = replacementDeclaration(body);
  return declaration.kind === 'source' ? declaration.source : null;
}

/**
 * The pull request that DISCHARGED an obligation, or null.
 *
 * One definition, so that "discharged" means one thing. `fulfilledSources` is computed
 * from it, and anything that later needs the same question — inside this gate or
 * outside it — asks this rather than restating the rule. A second copy would
 * eventually disagree, and a disagreement here means either a pending obligation
 * nobody can discharge or a duplicate replacement that lands.
 *
 * A discharge is a MERGE, on `main`, numbered above the source it claims — the same
 * three facts admission requires of a claimant, read from the merge record rather
 * than predicted.
 */
export function settlementOf(source, replacementPullRequests = []) {
  if (!Number.isInteger(source)) return null;
  return replacementPullRequests.find((candidate) => candidate?.merged_at
    && isLineageBase(candidate?.base?.ref)
    && candidate.number > source
    && replacementSource(candidate.body) === source) ?? null;
}

// A voluntary replacement must "record a concrete scope or approach benefit" (POLICY.md).
// The first version of this check tested only that SOME non-whitespace followed the label, so
// `Replacement reason: n/a` cleared it — the provenance path existed and validated nothing.
//
// What a gate can honestly enforce is a FLOOR, not a judgement. It cannot tell whether a stated
// benefit is real; a reviewer does that. What it can refuse is the shapes that carry no claim at
// all: a known placeholder token, and a fragment too short to be a statement of anything. Both
// refusals name what is missing, so an author who meant it can say it properly rather than guess.
const REPLACEMENT_REASON_PLACEHOLDERS = new Set([
  'n/a', 'n.a.', 'na', 'none', 'nil', 'nothing', 'no reason', 'reason', 'placeholder', 'tbd', 'tba',
  'todo', 'to do', 'x', 'xx', 'xxx', '-', '--', '---', '.', '?', '??', 'test', 'testing', 'asdf',
  'same', 'same as above', 'see above', 'see below', 'as discussed', 'as above', 'duplicate',
  'replacement', 'replaces', 'scope', 'approach', 'refactor', 'cleanup', 'fix',
]);

/** The text after `Replacement reason:`, or null when the line is absent. */
export function replacementReasonOf(body) {
  const match = /^[\t ]*Replacement reason:[\t ]*(\S[^\r\n]*)$/imu.exec(String(body ?? ''));
  return match ? match[1].trim() : null;
}

/** Does the body state a replacement reason that clears the placeholder floor? */
export function statesConcreteReplacementReason(body) {
  const reason = replacementReasonOf(body);
  if (!reason) return false;
  const normalized = reason.toLowerCase().replace(/[\s.!,;:]+$/u, '').trim();
  if (REPLACEMENT_REASON_PLACEHOLDERS.has(normalized)) return false;
  // A benefit is a claim about scope or approach, which takes a sentence to make. Six words and
  // twenty characters is the floor a placeholder cannot reach and a real reason clears without
  // trying — deliberately low, because the check is not the reviewer.
  const words = normalized.split(/\s+/u).filter((word) => /[a-z0-9]/u.test(word));
  return words.length >= 6 && normalized.replace(/\s+/gu, '').length >= 20;
}

export function assessReplacementLineage({
  pullRequest,
  requiredReplacements,
  replacementPullRequests,
}) {
  const declaration = replacementDeclaration(pullRequest?.body);
  if (!Array.isArray(requiredReplacements) || !Array.isArray(replacementPullRequests)) {
    return {
      allowed: false,
      detail: 'required replacement lineage could not be read from GitHub',
    };
  }

  const fulfilledSources = new Set(requiredReplacements
    .filter(({ pullRequest: source }) => Boolean(
      settlementOf(source?.number, replacementPullRequests),
    ))
    .map(({ pullRequest: source }) => source.number));
  const pending = requiredReplacements.filter(({ pullRequest: source }) =>
    source?.number !== pullRequest?.number
    && !fulfilledSources.has(source?.number));

  // ONE-CLAIMANT EXCLUSIVITY IS NOT ENFORCED AT ALL, by an explicit owner decision of
  // 2026-08-21. Two open claimants for one obligation can both merge. The cost is
  // duplicated effort — two replacements carrying the same scope — and NOT a corrupted
  // ledger: settlement below discharges an obligation exactly once, and only for a
  // merge that landed on `main` above its source.
  //
  // Four mechanisms were built and each was refuted by executing it. Refusing when any
  // other claimant is open is symmetric, so two coexisting claimants each refuse the
  // other and the loop stops until a human intervenes. Admitting the lowest-numbered
  // claimant recomputes a winner from a set that changes underneath work already in
  // flight. Checking at the merge boundary whether the source is discharged is not
  // atomic with the merge. Taking an atomic claim ref closes the race but deadlocks the
  // obligation permanently if a runner dies while holding it, and removes the
  // claimant's only wake path.
  //
  // The root is that reading cannot decide this, and the one atomic primitive available
  // brings worse failures than the defect. Deciding it properly needs persisted
  // "who was admitted first" state, or the ability to cancel another pull request's
  // queued merge under a lock keyed on the replaced source. GitHub offers neither to a
  // pure assessment of one pull request, which is what this function is.
  //
  // If it is revisited it belongs OUTSIDE this gate — a merge queue, or a workflow
  // serialized on the replaced source. Recorded as an accepted gap in
  // docs/reviews/replacement-lineage-repair.md so a later reader finds a decision
  // rather than a silence.

  if (declaration.kind === 'source') {
    let requirement = pending.find(
      ({ pullRequest: source }) => source?.number === declaration.source,
    );
    if (!requirement) {
      // Voluntary replacements have no retired round-limit label. Validate the
      // actual source and a stated benefit instead of requiring that label.
      const source = replacementPullRequests.find(pr => pr.number === declaration.source);
      const repository = pullRequest?.base?.repo?.full_name;
      const justified = statesConcreteReplacementReason(pullRequest?.body);
      if (!source || !justified || !repository || source.state !== 'closed'
          || source.merged_at || source.merged
          || !isLineageBase(source.base?.ref)
          || source.base?.repo?.full_name !== repository
          || source.head?.repo?.full_name !== repository
          || settlementOf(source.number, replacementPullRequests)) {
        return {
          allowed: false,
          detail: `Replaces: #${declaration.source} needs a closed, unmerged same-repository main source `
            + 'and a concrete Replacement reason naming the scope or approach benefit — a placeholder '
            + 'such as "n/a" does not state one; an already settled source cannot be replaced again',
        };
      }
      requirement = { pullRequest: source };
    }
    if (requirement.pullRequest.state !== 'closed') {
      return {
        allowed: false,
        detail: `Replaces: #${declaration.source} is not closed; close the exhausted unit before reviewing its replacement`,
      };
    }
    // A claimant must be numbered ABOVE its source, because settlement already
    // requires exactly that — and admitting a claimant that settlement can never
    // accept is worse than refusing it. An older pull request EDITED to declare
    // `Replaces: #N` would otherwise be admitted, occupy the obligation, and never
    // discharge it however far it got: the loop would review the wrong unit while the
    // obligation stayed pending and kept blocking every `Replaces: none` unit.
    //
    // This is the missing half of the settlement rule rather than a new policy. The
    // two are the same ordering, read at the two ends of one obligation.
    if (!(pullRequest?.number > declaration.source)) {
      return {
        allowed: false,
        detail: `a replacement must be numbered above the unit it replaces; #${pullRequest?.number} `
          + `cannot replace #${declaration.source}, and settlement would never accept it`,
      };
    }
    return { allowed: true, detail: null };
  }

  // Historical round-limit labels cannot compel new replacement PRs or block
  // unrelated work. Explicit replacements above still retain their provenance.
  return { allowed: true, detail: null };
}

export function assessReviewScope(
  pullRequest,
  {
    enforceAfterPr = REVIEW_SCOPE_ENFORCE_AFTER_PR,
    preReviewEnforceAfterPr = PRE_REVIEW_ENFORCE_AFTER_PR,
    maxFiles = STANDARD_MAX_FILES,
    maxChangedLines = STANDARD_MAX_CHANGED_LINES,
    changedFiles,
    requireChangedFiles = false,
    requireReplacementLineage = false,
    requiredReplacements,
    replacementPullRequests,
  } = {},
) {
  const additions = finiteCount(pullRequest?.additions);
  const deletions = finiteCount(pullRequest?.deletions);
  const changedFileCount = finiteCount(pullRequest?.changed_files);
  const changedLines = additions + deletions;
  const large = changedFileCount > maxFiles || changedLines > maxChangedLines;
  const number = finiteCount(pullRequest?.number);
  const body = String(pullRequest?.body ?? '');
  const preReviewRequired = number > preReviewEnforceAfterPr;
  const replaces = replacementDeclaration(body);
  const missingChecklist = preReviewRequired
    ? REQUIRED_PRE_REVIEW_CHECKS.filter((key) => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return !new RegExp(
        '^[\\t ]*- \\[x\\] `' + escaped + '`(?:[\\t ]|$)',
        'imu',
      ).test(body);
    })
    : [];
  const fileListUnreadable = preReviewRequired
    && requireChangedFiles
    && !Array.isArray(changedFiles);
  const paths = Array.isArray(changedFiles)
    ? changedFiles.flatMap((file) => changedPaths(file))
    : [];
  const hasMigration = paths.some((path) => MIGRATION_FILE.test(path));
  const migrationServiceMix = hasMigration
    && paths.some((path) => SERVICE_OR_UI_FILE.test(path));
  // The hard-cap exemption needs the actual service seam, not any UI/shared change: a migration
  // paired only with `apps/web/src` or `packages/shared/src` is not an inseparable migration/service
  // unit and does not earn the exemption, even though it still trips `migrationServiceMix`.
  const migrationServiceExemptible = hasMigration
    && paths.some((path) => SERVICE_FILE.test(path));
  const migrationScope = declaredMarker(body, 'migration-scope');
  // Read the seam explanation ONLY from the top-level rendered stream, the same content the invariant
  // matrix is read from: a `- Migration/service seam:` bullet hidden in an HTML comment or a fenced
  // example does not render as a declaration and must not satisfy the exemption (owner decision, #596).
  const seam = /^[\t ]*- Migration\/service seam:[\t ]*(.+?)[\t ]*$/imu
    .exec(renderedTopLevelLines(body).join('\n'))?.[1]?.trim();
  // A bounded floor only: present, past a length floor, not a placeholder token or punctuation run.
  // Whether the seam actually explains why the migration and service cannot be reviewed apart is a
  // judgement the reviewer makes (owner decision, #596) — the gate does not score prose concreteness.
  const meaningfulSeam = typeof seam === 'string'
    && seam.length >= 20
    && !/^(?:n\/?a|none|not applicable|separated|tbd|todo|to do|pending|unknown|fixme)(?:\b.*)?$/iu
      .test(seam)
    && !/^[-?.]+$/u.test(seam)
    && !/^<[^>]+>$/u.test(seam);
  // THE BASE RULE APPLIES TO EVERY REVIEW UNIT, and it is evaluated HERE rather
  // than inside `assessReplacementLineage`.
  //
  // An earlier head put it there, and the placement was wrong in a way that made
  // the rule unreachable from the one caller that matters. The lineage assessment
  // runs only when a caller passes `requireReplacementLineage` AND supplies the two
  // GitHub-fetched arrays it needs; the required `review-scope` job supplies
  // neither, because fetching a repository-wide obligation set is exactly the work
  // the cheap preflight exists to avoid. So an off-`main` unit passed the required
  // check, every dependent CI job ran, and the base was rejected only later by the
  // trusted orchestrator — while the record document claimed the refusal was
  // persisted by `review-scope`.
  //
  // The rule reads `base.ref` and nothing else. Living inside the lineage
  // assessment gave a universal rule a data dependency it does not have. Out here
  // it runs for every caller, and the cheap preflight fails first, which is the
  // whole point of putting the guard at admission.
  //
  // Scoping it to `Replaces: #N` would leave the worse case open anyway: a
  // `Replaces: none` unit targeting another branch passes, accumulates two
  // finding-bearing heads, and is then labelled `review-replacement-required` — a
  // REPOSITORY-WIDE obligation. Every fresh `main` unit is blocked behind it until
  // some replacement carries work that was never eligible to land on `main` at all.
  // A claimant merging off-`main` is the narrower failure; this is the one that
  // stops the loop.
  //
  // Gated on `preReviewRequired` like every other rule this repair introduced, so
  // it governs exactly the units the protocol governs and never retroactively
  // fails one that predates it.
  const unitBase = pullRequest?.base?.ref;
  const baseProblem = preReviewRequired && !isLineageBase(unitBase)
    ? `a review unit must target ${LINEAGE_BASE_REF}; this unit targets `
      + `${typeof unitBase === 'string' && unitBase.length > 0 ? unitBase : 'an unreadable base'}`
    : null;
  const lineage = preReviewRequired && requireReplacementLineage
    ? assessReplacementLineage({
      pullRequest,
      requiredReplacements,
      replacementPullRequests,
    })
    : { allowed: true, detail: null };
  const preReviewProblems = [
    ...(baseProblem ? [baseProblem] : []),
    ...(missingChecklist.length > 0
      ? [`pre-review checklist items: ${missingChecklist.join(', ')}`]
      : []),
    ...(fileListUnreadable
      ? ["the PR's cumulative file list could not be read"]
      : []),
    ...(preReviewRequired && replaces.kind === 'invalid'
      ? ['the PR body needs exactly one `Replaces: none` or `Replaces: #<closed-pr>` declaration']
      : []),
    ...(!lineage.allowed ? [lineage.detail] : []),
    ...(migrationServiceMix && migrationScope !== 'inseparable'
      ? [`migration and service/UI changes must use separate review units when a viable seam exists; `
        + `use ${INSEPARABLE_MIGRATION_MARKER} only when they cannot be reviewed safely apart`]
      : []),
    ...(migrationServiceMix && migrationScope === 'inseparable' && !meaningfulSeam
      ? ['an inseparable migration/service unit needs a concrete "Migration/service seam" explanation']
      : []),
  ];
  const common = {
    changedFiles: changedFileCount,
    changedLines,
    large,
    limits: { maxFiles, maxChangedLines },
    missingChecklist,
    migrationServiceMix,
  };
  let state = 'standard';
  let missingInvariants = [];
  let sizeProblem = null;

  if (large && number <= enforceAfterPr) {
    state = 'grandfathered';
  } else if (large) {
    const justified = declaredMarker(body, 'review-size') === 'justified-large';
    const tableRows = matrixRows(body);
    missingInvariants = REQUIRED_INVARIANTS.filter(
      (invariant) => !tableRows.some(
        (cells) => cells[0]?.toLowerCase() === invariant
          && Boolean(cells[1])
          && Boolean(cells[2]),
      ),
    );
    if (number > HARD_SIZE_CAP_AFTER_PR) {
      // The gate checks that all six invariant rows are PRESENT with filled risk and evidence cells;
      // the reviewer judges whether that content is concrete (owner decision, #596 — see filledCell).
      const unfilled = REQUIRED_INVARIANTS.filter((invariant) => !tableRows.some(
        (cells) => cells[0]?.toLowerCase() === invariant && filledCell(cells[1]) && filledCell(cells[2]),
      ));
      missingInvariants = unfilled;
      // the exemption is for MIGRATION work the service cannot be separated from: the diff itself
      // must carry that migration + API-service seam, or the marker and six boilerplate rows would
      // exempt anything (a migration paired only with UI/shared does not earn it)
      if (migrationScope === 'inseparable' && unfilled.length === 0 && migrationServiceExemptible) {
        state = 'inseparable_large';
      } else {
        sizeProblem = `Review unit exceeds the hard cap of ${maxFiles} files / ${maxChangedLines.toLocaleString('en-US')} changed lines `
          + `(${changedFileCount} files, ${changedLines.toLocaleString('en-US')} lines): split it into ordinary units. The only exemption is `
          + `${INSEPARABLE_MIGRATION_MARKER} on a diff carrying a migration and its inseparable API service, with the invariant matrix's six rows filled with risk and evidence the review judges concrete`
          + (justified ? '; `justified-large` no longer admits a new oversized unit' : '')
          + (migrationScope !== 'inseparable' ? '; no inseparable-migration marker' : '')
          + (!migrationServiceExemptible ? '; the diff carries no migration + API-service (apps/api/src) seam' : '')
          + (unfilled.length > 0 ? `; invariant rows missing risk and evidence: ${unfilled.join(', ')}` : '');
      }
    } else if (!justified || missingInvariants.length > 0) {
      const missing = [
        ...(!justified ? [`the ${LARGE_MARKER} marker`] : []),
        ...(missingInvariants.length > 0
          ? [`invariant matrix rows: ${missingInvariants.join(', ')}`]
          : []),
      ];
      sizeProblem = `Large review unit requires a justified-large marker and complete invariant matrix; missing ${missing.join('; ')}`;
    } else {
      state = 'justified_large';
    }
  }

  // Deliberately outside the pre-review block, which is gated on
  // `preReviewEnforceAfterPr`: ownership is required at EVERY pull request
  // number, with no exemption. An earlier draft carried its own threshold; the
  // carve-out let a PR inside it pass this gate with no owner and then route to
  // nobody on its first finding, so it was deleted rather than raised.
  const ownerProblem = correctionOwnerProblem(pullRequest);
  const problems = [
    ...(sizeProblem ? [sizeProblem] : []),
    ...(ownerProblem ? [ownerProblem] : []),
    ...preReviewProblems,
  ];
  if (problems.length > 0) {
    return {
      ...common,
      state: 'blocked',
      allowed: false,
      missingInvariants,
      detail: problems.join('; '),
    };
  }

  return { ...common, state, allowed: true, missingInvariants };
}

// Which finding heads carry a CRITICAL finding.
//
// Codex tags every finding with a severity badge. Matching the BADGE markup is
// structural; matching a bare "P1" would fire on any prose that mentions it,
// including a comment explaining the rule itself.
const BADGE = /!\[P(\d) Badge\]|badge\/P(\d)-/gu;

// Severity per finding head, as one of:
//   'very-critical' — a P0 finding
//   'critical'      — a P1 finding
//   'minor'         — findings present, all badged, none P0/P1
//   'unknown'       — a finding whose severity could not be read
//
// 'unknown' is a first-class outcome, not a synonym for 'minor'. The obvious
// shape — "critical means some head shows a P1" — silently reclassifies an
// unparseable head as harmless, so a badge format change would turn a safety
// signal permissive exactly when it had lost the ability to see.
export function findingHeadSeverity(comments, reviews = []) {
  // Per head: the lowest severity seen, AND whether any finding on it was
  // unreadable. Tracking only "was a badge seen anywhere" let one badged comment
  // vouch for an unbadged sibling on the same head — the head came back minor
  // while carrying a finding of unknown severity. Any unreadable finding taints
  // its whole head.
  const worst = new Map(); // head -> { lowest: number|null, unreadable: boolean }

  const note = (head, body, { container = false } = {}) => {
    if (typeof head !== 'string' || head.length === 0) return;
    const entry = worst.get(head) ?? { lowest: null, unreadable: false };
    const text = String(body ?? '');
    let lowest = null;
    for (const match of text.matchAll(BADGE)) {
      const level = Number(match[1] ?? match[2]);
      if (Number.isFinite(level)) lowest = lowest === null ? level : Math.min(lowest, level);
    }
    if (lowest !== null) {
      entry.lowest = entry.lowest === null ? lowest : Math.min(entry.lowest, lowest);
    } else if (!container) {
      // A Codex REVIEW is posted as a container — "here are some automated review
      // suggestions" — with the findings themselves as inline review comments, so
      // its body never carries a badge. Counting that as an unreadable finding
      // would taint every reviewed head as unknown.
      entry.unreadable = true;
    }
    worst.set(head, entry);
  };

  for (const comment of comments ?? []) {
    if (comment?.user?.login !== CODEX_LOGIN) continue;
    note(comment.original_commit_id ?? comment.commit_id, comment.body);
  }
  for (const review of reviews ?? []) {
    if (review?.user?.login !== CODEX_LOGIN) continue;
    note(review.commit_id, review.body, { container: true });
  }

  const severity = new Map();
  for (const [head, entry] of worst) {
    // UNREADABLE outranks a readable P1. Ordering the P1 check first classified a
    // head carrying both a P1 and an unbadged finding as merely `critical`, which
    // understates it. P0 stays first only for accurate reporting.
    if (entry.lowest === 0) severity.set(head, 'very-critical');
    else if (entry.unreadable || entry.lowest === null) severity.set(head, 'unknown');
    else if (entry.lowest === 1) severity.set(head, 'critical');
    else severity.set(head, 'minor');
  }
  return severity;
}

export function codexFindingHeads(comments, reviews = []) {
  const heads = new Set();
  for (const comment of comments ?? []) {
    if (comment?.user?.login !== CODEX_LOGIN) continue;
    const head = comment.original_commit_id ?? comment.commit_id;
    if (typeof head === 'string' && head.length > 0) heads.add(head);
  }
  for (const review of reviews ?? []) {
    if (review?.user?.login !== CODEX_LOGIN) continue;
    const head = review.commit_id;
    if (typeof head === 'string' && head.length > 0) heads.add(head);
  }
  return [...heads];
}

function changedFilename(file) {
  return typeof file === 'string' ? file : file?.filename;
}

// A bare non-answer: the whole cell is one of these tokens.
const CELL_PLACEHOLDER_EXACT = /^(?:n\/?a|na|none|nil|tbd|to[\s-]?do|yes|ok|okay|done|checked|see above|as above|relevant risk|focused probe|not applicable|not relevant)$/iu;
// Punctuation only: a run of dashes, question marks or the like states nothing however long it is
// (the length floor alone would let 20 dashes through).
const CELL_PLACEHOLDER_SYMBOLS = /^[\s.,:;!?–—-]+$/u;
/**
 * A risk or evidence cell the gate accepts: present, not a punctuation run, not a bare placeholder
 * token. This is a BOUNDED lexical check ONLY. Whether the cell is genuinely CONCRETE — names a real
 * mechanism and consequence — is a judgement the reviewer makes on the rendered PR, not the gate
 * (owner decision, #596).
 *
 * An earlier design tried to score concreteness with a denylist of non-answer phrasings. Five Codex
 * review rounds proved it cannot be completed: it drew a new evasion synonym every round AND began
 * rejecting genuine risks that share a phrase ("The API carries no tenant identifier, allowing
 * cross-project writes" was refused for containing "carries no"). Rejecting more non-answers rejects
 * more real risks; the two are not separable by regex on free text. So the gate now enforces the
 * bounded, decidable requirements — the inseparable marker in the declaration block, a real
 * migration and its `apps/api/src` service, an oversized diff, and six named invariant rows whose
 * risk and evidence cells are filled — and the reviewer (Codex/human, which reviews every exemption
 * use) judges whether that content is concrete.
 */
function filledCell(cell) {
  const text = String(cell ?? '').trim();
  if (text.length === 0) return false;
  if (CELL_PLACEHOLDER_SYMBOLS.test(text)) return false;
  if (CELL_PLACEHOLDER_EXACT.test(text)) return false;
  return true;
}

// Documentation, for the purpose of "can a finding on this be proven?". Anything that
// runs — a script, a schema, a migration, a test, a workflow, application source — makes
// the diff provable and puts it back under the ordinary code protocol.
//
// A directory name cannot decide that. `docs/probes/x.test.mjs`, `docs/schema.prisma` and
// `docs/ci/deploy.yml` run exactly as they would anywhere else, and a rule that admitted
// everything under `docs/` would hand the deferral escape to a diff whose findings are
// perfectly provable. So a file is documentation only when BOTH its extension and its
// location say so.
//
// The extension test is an ALLOWLIST, deliberately. A blocklist of runnable extensions
// has to anticipate every one that exists and silently admits the ones it missed; an
// allowlist treats an unrecognised extension as code, which is the direction that fails
// closed. An empty diff is not a plan review either; it is a broken read, and it also
// fails toward the strict path.
const DOCS_EXTENSION = /\.(?:md|mdx|txt|rst|svg|png|jpe?g|gif|webp|pdf)$/iu;
const DOCS_LOCATION = /^(?:docs\/.+|\.github\/.+|[^/]+)$/u;

function isDocumentation(name) {
  return DOCS_EXTENSION.test(name) && DOCS_LOCATION.test(name);
}

// Every path a diff entry TOUCHES. A rename touches two: GitHub reports it as
// `status: 'renamed'` with `filename` set to the new path and `previous_filename` to the
// old one, so reading only `filename` let `scripts/old-gate.mjs` → `docs/old-gate.md`
// present as pure documentation while runnable code was removed. A rename is a removal
// plus an addition, and both sides have to be classified.
function changedPaths(file) {
  if (typeof file === 'string') return [file];
  return [file?.filename, file?.previous_filename]
    .filter((name) => typeof name === 'string' && name.length > 0);
}

export function isDocsOnlyDiff(changedFiles) {
  // Every entry, INCLUDING removals and renames. Deleting `scripts/old-gate.mjs` — or
  // moving it out from under that name — changes what runs just as surely as editing it,
  // so such a diff is provable and is not a plan review. (The convergence-PACKET check
  // below keeps its own `removed` filter and reads only `filename`: there the question is
  // whether the head ADDS the audit at that path, which the surviving name answers.)
  const names = (changedFiles ?? []).flatMap((file) => changedPaths(file));
  return names.length > 0 && names.every((name) => isDocumentation(name));
}

// The deferral names the TASK that will settle the deferred findings, so the handoff is
// schedulable rather than an assertion that the review is over. A bare marker ("yes",
// "complete", "done") schedules nothing and is refused.
const DEFERRAL_TRAILER = 'review-deferred-to-probes';
// The trailer names THE TASK whose review stop settles the deferred questions, so the value
// must be a task reference. This was a BLOCKLIST of bare words, which is the exact mistake
// this PR's own round-2 remedy argued against for file extensions: a blocklist has to
// anticipate every placeholder that exists and silently admits the ones it missed, so
// `Review-Deferred-To-Probes: later` was accepted as a scheduled handoff. An ALLOWLIST treats
// an unrecognised value as no task at all — the direction that fails closed. The two shapes
// are this repository's own task vocabulary, the same strings `docs/STATUS.md` uses for
// `next_task`/`work_item`.
//
// The SPLIT UNIT suffixes are part of that vocabulary and were missing, which made the comment
// above false rather than merely incomplete: `docs/STATUS.md` has named lettered units since Task
// 5A (`5A`/`5B`/`5C`, then `6A`/`6B`), so `phase-5-task-6b` was already rejected before any
// finer-grained id existed — a deferral trailer naming the unit actually under review could never
// parse. The roman suffix admits the second level the 6B split introduced (`6b-i`, `6b-ii`).
//
// THIRD LEVEL, and the same lesson a third time. The 7B-ii split coined `7B-ii-a`/`7B-ii-b` —
// both now merged and independently cleared — so a lettered unit below a roman one is not a
// hypothetical shape, it is the vocabulary `docs/STATUS.md` has been writing since PR #299.
// `phase-5-task-7b-ii-b` sat in STATUS as `work_item` and never parsed; the mismatch stayed
// LATENT only because that entry coincided with `task_state: in_progress`, which makes
// `phaseHasOpenWork` supply the phase from `phase:` and the unparseable id irrelevant.
//
// It stops being latent in the BETWEEN-WORK shape (`task_state: merged`, `work_item: none`),
// where `next_task` is the ONLY source of an eligible phase: an unparseable id there collapses
// `deferralPhases` to `[]`, which the contract below reads as "no phase has an open review stop"
// — so a correctly-formed deferral naming a REAL upcoming stop is refused, and a scheduled
// review stop fails closed. The vocabulary is extended rather than the STATUS id blunted,
// because naming the parent split when the next unit is `7b-iii-a` would trade a parse error
// for a wrong answer.
const TASK_REFERENCE = /^phase-(?<phase>\d+)-(?:task-\d+[a-z]?(?:-[iv]+)?(?:-[a-z])?|planning)$/iu;

// A shape-valid value can still name a review stop that does not exist:
// `phase-999-task-999` parses and schedules nothing. The PHASE is checkable against
// `docs/STATUS.md`, which is a machine-readable state file with an existing parser — so this is
// a structured-field read, not the prose parsing withdrawn below. Acceptable phases are the
// CURRENT one and the one `next_task` names: a deferral belongs to the phase under review, and
// pointing at a later phase is a scope change disguised as a deferral, not a handoff.
//
// The task INDEX inside a valid phase is NOT checked. It lives in the plan's markdown task
// table, and reading that is the prose parsing this PR withdrew. AGENTS.md asks the reviewer to
// flag a deferral naming a task the plan does not define.
// A phase is eligible only while it can still SETTLE something. The current phase qualifies
// only when it has open work: with `task_state: merged` and no `work_item` — the between-work
// shape STATUS uses — every phase-4 review stop is already closed, so `phase-4-task-99` names a
// stop that cannot adjudicate anything. `next_task`'s phase is always eligible, because that is
// the phase whose stops are about to exist.
const NO_WORK_ITEM = new Set(['', 'none', 'null', '-']);
// The states STATUS uses for a task that is DONE. Recognized, so a named work_item against
// one still counts; distinct from a state this repository has no vocabulary for at all.
const TERMINAL_TASK_STATES = new Set(['merged', 'complete', 'completed', 'cleared']);

function phaseHasOpenWork(now) {
  const state = String(now?.task_state ?? '').trim().toLowerCase();
  const item = String(now?.work_item ?? '').trim().toLowerCase();
  // An ALLOWLIST, sharing docs/STATUS.md's own vocabulary. A blocklist of closed words
  // treats every state it has not heard of as open — `task_state: somewhere-new`, or an
  // absent field — and authorizes a deferral on evidence STATUS never gave. Round 6 of
  // this PR replaced exactly such a blocklist (BARE_DEFERRAL) with the TASK_REFERENCE
  // allowlist for the same reason; this is that lesson at a second site.
  if (OPEN_TASK_STATES.has(state)) return true;
  // A recognized terminal state can still carry a named work item — a follow-up recorded
  // against a merged task. Anything UNRECOGNIZED is unverified, not open.
  if (!TERMINAL_TASK_STATES.has(state)) return false;
  return !NO_WORK_ITEM.has(item);
}

// undefined means "STATUS told us nothing" — no constraint. An empty ARRAY is a different
// answer: STATUS was readable and no phase has an open review stop, so there is nothing a
// deferral could hand work to. Collapsing the two would make an unreadable STATUS refuse every
// deferral, or a closed phase authorize any of them.
export function deferralPhases(now) {
  const current = Number.parseInt(String(now?.phase ?? '').trim(), 10);
  const next = TASK_REFERENCE.exec(String(now?.next_task ?? '').trim());
  if (!Number.isInteger(current) && !next) return undefined;
  const phases = new Set();
  if (Number.isInteger(current) && phaseHasOpenWork(now)) phases.add(current);
  if (next) phases.add(Number.parseInt(next.groups.phase, 10));
  return [...phases];
}

function messageTrailers(message) {
  const blocks = String(message ?? '').trimEnd().split(/\n[\t ]*\n/u);
  if (blocks.length < 2) return [];
  const trailers = [];
  for (const line of blocks.at(-1).split('\n')) {
    if (/^[\t ]+\S/u.test(line)) {
      if (trailers.length === 0) return [];
      trailers.at(-1)[1] += ` ${line.trim()}`;
      continue;
    }
    const trailer = /^([A-Za-z0-9][A-Za-z0-9-]*):[\t ]*(.+)$/u.exec(line);
    if (!trailer) return [];
    trailers.push([trailer[1].toLowerCase(), trailer[2].trim()]);
  }
  return trailers;
}

export function deferredToProbes(message) {
  for (const [key, value] of messageTrailers(message)) {
    if (key !== DEFERRAL_TRAILER) continue;
    const target = value.trim();
    if (!TASK_REFERENCE.test(target)) return null;
    return target;
  }
  return undefined;
}

// The deferral LEDGER is deliberately NOT gate-verified. Read this before adding it back.
//
// Four rounds of this PR tried to verify it mechanically — a keyword, then a row shape, then a
// header exclusion, then a complete artifact definition with a plan cross-reference. Each was
// defeated by a new input, and the round that defeated the "complete" definition settled the
// question rather than adding a fifth clause:
//
//   - a ledger is a mapping from QUESTIONS to probes, and the definition specified only the
//     probe side, so `- probe 5w` under the heading passed with no question anywhere;
//   - `planDefinesProbe` could not tell a probe declaration from an ordinary numbered list
//     item, so `probe 5` matched the plan line `5. **Task 5 — frontend surfaces**`.
//
// Neither is answerable without reading for MEANING. Is this row a question? Is that numbered
// line a probe or a task heading? Those are judgements, which puts them on the reviewer's side
// of the line this repository already draws — the PR #250 line, where a mechanism that scored
// substance was withdrawn because on its first real case it would have suppressed a correct
// finding. The line was right; I had drawn it in the wrong place and defended it for four
// rounds.
//
// And the check was guarding a door that opens onto a wall. `guardAgainstCurrentHeadFinding`
// runs AFTER convergence and fails closed on every current-head finding, so a deferral buys an
// author NOTHING that a clean review would not already give them. There is no incentive to
// forge a ledger, and no outcome a forged one changes.
//
// So what remains is the one thing that is mechanically decidable without interpretation: the
// trailer must name a TASK (see TASK_REFERENCE). The ledger itself is an author obligation
// stated in AGENTS.md and judged by the reviewer, which is where a question about whether
// enough thinking happened belongs.

// The separator is ':' with OPTIONAL whitespace after it — `git interpret-trailers --parse`
// normalizes `Key:value` to `Key: value`, so a head spelled without the space carries a VALID
// trailer. Requiring the space made the gate report a present trailer as missing. All three
// parsers in this file had the same too-strict separator; all three are fixed together.
const CONVERGENCE_MARKER = /^[\t ]*review-convergence:[\t ]*complete[\t ]*$/imu;

function hasConvergenceTrailer(message) {
  const blocks = String(message ?? '').trimEnd().split(/\n[\t ]*\n/u);
  if (blocks.length < 2) return false;
  const lines = blocks.at(-1).split('\n');
  const trailers = [];
  for (const line of lines) {
    if (/^[\t ]+\S/u.test(line)) {
      if (trailers.length === 0) return false;
      trailers.at(-1)[1] += ` ${line.trim()}`;
      continue;
    }
    const trailer = /^([A-Za-z0-9][A-Za-z0-9-]*):[\t ]*(.+)$/u.exec(line);
    if (!trailer) return false;
    trailers.push([trailer[1].toLowerCase(), trailer[2].trim().toLowerCase()]);
  }
  return trailers.some(
    ([key, value]) => key === 'review-convergence' && value === 'complete',
  );
}

// Git reads trailers from the LAST paragraph only, and only when every line in
// it is a `Key: value` trailer. So the marker can be present and still not be a
// trailer — a blank line above it demotes it to body text, and a prose line
// anywhere in that final block invalidates the whole block. Both are ordinary
// authoring mistakes, and "missing trailer" alone reads as "you forgot it" when
// the line is right there. Naming the real cause turns a wasted round into a
// one-line fix. The hint states the rule rather than guessing which of the two
// it is, so it is never wrong about the cause.
export function convergenceTrailerHint(message) {
  if (hasConvergenceTrailer(message)) return null;
  return CONVERGENCE_MARKER.test(String(message ?? ''))
    ? 'trailer (the line is present but git does not parse it as a trailer: it '
      + 'must be in the final block of the message, and every line in that '
      + 'block must be a "Key: value" trailer)'
    : 'trailer';
}

export function assessConvergence({
  comments,
  reviews,
  headMessage,
  changedFiles,
  pullRequestFiles,
  activePhases,
}) {
  const findingHeads = codexFindingHeads(comments, reviews);
  const findingHeadCount = findingHeads.length;
  if (findingHeadCount < CONVERGENCE_AFTER_FINDING_HEADS) {
    return {
      required: false,
      allowed: true,
      findingHeadCount,
      findingHeads,
      missing: [],
    };
  }

  const hasTrailer = hasConvergenceTrailer(headMessage);
  const hasPacket = (changedFiles ?? [])
    .some((file) => {
      const filename = changedFilename(file);
      return file?.status !== 'removed'
        && typeof filename === 'string'
        && CONVERGENCE_PACKET.test(filename);
    });
  // Past the cap, a docs-only review also owes the probe deferral: each still-open
  // question named, with the probe and the task that will settle it. See
  // PLAN_REVIEW_ROUND_CAP — this adds an obligation, it never removes one.
  //
  // Judged on the PR's CUMULATIVE diff, not on `changedFiles` (this head's commit). A
  // code PR's convergence head is very often the packet alone, and reading that one
  // commit would classify the whole review as a plan review and block it pending a
  // deferral trailer that means nothing for it. `changedFiles` keeps its own meaning
  // above — whether THIS head carries the audit — which is a per-head question.
  //
  // An UNREADABLE cumulative diff is not evidence either way, and it must not silently pick a
  // path. Resolving it toward "code" drops the deferral obligation on a docs-only PR; resolving
  // it toward "docs" demands a meaningless trailer from a code PR. So past the cap it BLOCKS
  // with its own reason and the gate re-runs on the next event — the same self-healing shape the
  // packet read used. Below the cap it is irrelevant, because no deferral is owed.
  const cumulativeUnreadable = !Array.isArray(pullRequestFiles)
    && findingHeadCount >= PLAN_REVIEW_ROUND_CAP;
  const deferralRequired = Array.isArray(pullRequestFiles)
    && isDocsOnlyDiff(pullRequestFiles)
    && findingHeadCount >= PLAN_REVIEW_ROUND_CAP;
  const deferral = deferralRequired ? deferredToProbes(headMessage) : undefined;

  const missing = [
    ...(!hasTrailer ? [convergenceTrailerHint(headMessage)] : []),
    ...(!hasPacket ? ['packet'] : []),
    ...(cumulativeUnreadable
      ? ["the PR's cumulative diff could not be read, so whether this review is docs-only — and "
        + 'therefore whether it owes a probe deferral — is unverified. This is not evidence '
        + 'either way; re-run once the file list is readable']
      : []),
    ...(deferralRequired && deferral === undefined
      ? [`a "Review-Deferred-To-Probes: <task>" trailer — after ${PLAN_REVIEW_ROUND_CAP} `
        + 'finding-bearing heads a docs-only review must hand its remaining open '
        + 'questions to named probes instead of answering them with more prose']
      : []),
    ...(deferralRequired && deferral === null
      ? ['the Review-Deferred-To-Probes value must name the TASK that will settle the '
        + 'deferred findings, in this repository\'s own task vocabulary '
        + '("phase-<n>-task-<m>" or "phase-<n>-planning"); a bare marker or a word like '
        + '"later" schedules nothing']
      : []),
    // A shape-valid task needs a PROVABLE phase, and "unprovable" is not "proven". Round 9
    // made an unreadable cumulative diff block rather than pick a path, then left the phase
    // check resolving an unreadable STATUS toward "no constraint" — the same defect, two
    // fields apart, in one commit. Both now fail closed. This never touches a head that
    // claims no deferral.
    ...(deferralRequired && typeof deferral === 'string' && !Array.isArray(activePhases)
      ? [`"${deferral}" names a task, but docs/STATUS.md could not be read, so whether that `
        + 'phase still has a review stop ahead of it is unverified. An unprovable phase is not '
        + 'a proven one; re-run once STATUS parses']
      : []),
    // And the phase set must be ABOUT this PR. The gate runs from the trusted default branch,
    // so it reads main's STATUS — which is not this PR's phase truth when the PR itself edits
    // STATUS. A head that closes phase 5 while deferring into phase-5-task-1 would otherwise
    // pass on the pre-merge state. Reading the head's STATUS would fix it too, and would mean
    // fetching PR-authored content into a write-capable workflow — the boundary this loop does
    // not cross, and the content read round 7 withdrew. The FILE LIST is metadata the gate
    // already has, and it is sufficient: if STATUS is in the diff, the phase is unverifiable.
    ...(deferralRequired && typeof deferral === 'string' && Array.isArray(activePhases)
      && (pullRequestFiles ?? []).some(
        // BOTH paths, via the same helper the docs-only classifier uses. A rename AWAY from
        // docs/STATUS.md carries the new path in `filename` and the old one in
        // `previous_filename`, so reading `filename` alone misses a PR that moved the phase
        // truth out from under the gate. Round 2 of this PR established the two-path rule
        // and built changedPaths for it; this new check simply has to USE it.
        (file) => changedPaths(file).includes(STATUS_DOCUMENT),
      )
      ? ['this PR changes docs/STATUS.md, so the default-branch copy the gate reads is not this '
        + "PR's own phase truth and cannot verify the deferral's phase. Land the STATUS change "
        + 'on its own, or defer to a phase the current STATUS already shows has work ahead']
      : []),
    // A shape-valid task in a phase this repository is not working on schedules nothing
    // either. An empty set is readable evidence: no phase has an open review stop, so no
    // deferral can hand work to one.
    ...(deferralRequired && typeof deferral === 'string'
      && Array.isArray(activePhases)
      && !activePhases.includes(
        Number.parseInt(TASK_REFERENCE.exec(deferral).groups.phase, 10),
      )
      ? [`"${deferral}" names phase `
        + `${Number.parseInt(TASK_REFERENCE.exec(deferral).groups.phase, 10)}, but `
        + (activePhases.length > 0
          ? `docs/STATUS.md puts this repository in phase ${activePhases.join(' or ')}. A `
            + 'deferral hands work to a review stop in the phase under review; a later phase '
            + 'is a scope change, not a handoff'
          : 'docs/STATUS.md records no phase with open work, so there is no review stop left '
            + 'to settle these questions. Advance STATUS to the phase that will answer them, '
            + 'or answer them on this head')]
      : []),
    // A trailer naming a task, with a packet that records no handoff, is the bare marker
    // wearing a task name: nothing is actually scheduled. The obligation has always been
    // trailer AND ledger (AGENTS.md, and this repo's own packets say so); only the trailer
    // half was enforced.
  ];
  return {
    required: true,
    allowed: missing.length === 0,
    findingHeadCount,
    findingHeads,
    hasTrailer,
    hasPacket,
    deferralRequired,
    cumulativeUnreadable,
    deferredTo: deferral ?? null,
    missing,
  };
}
