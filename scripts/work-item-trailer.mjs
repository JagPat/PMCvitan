// M3b (owner, #482 6090833573 / 6091212460): the work item a unit cites, read from IMMUTABLE evidence — a
// `Work-Item: #N` trailer on the exact head commit — instead of the mutable PR body (#751, stopped at 08816b7).
//
// This module only PARSES. It decides nothing about whether the cited issue exists (that is M3c's trusted,
// approval-time verification, not built here), and whether a citation is mandatory is undecided: no trailer
// means no citation.
//
// The trailer block is read exactly as `git interpret-trailers --parse` reads it (`gitParsedTrailers`, the same
// isolated parser the gate uses for `Correction-Owner`). Nothing is parsed as Markdown, so no fence, HTML comment
// or indentation in the message can hide or invent a citation (#751 finding 4232759655, tracked in #759).
//
// FAIL CLOSED: every line of the message that names the field must be the one terminal trailer. A
// `Work-Item:` line anywhere else (a body paragraph, a code example, a non-terminal block), a second trailer, or
// any value other than `#<digits>` is `malformed` — never silently ignored, so an unrecognised form can neither
// carry a citation past a later verification nor read as "no citation".

import { asciiTrim, gitParsedTrailers } from './git-trailers.mjs';

const FIELD_KEY = 'work-item';
// Any line that names the field ANYWHERE and then attempts a value: the words `work` and exactly `item`, joined by
// any non-alphanumeric run (or none), followed later on the line by a `:`, `=`, `#` or digit. Position, prefix,
// wrapper and delimiter do not matter, so every disguise found in review is covered by one rule instead of a list:
// separators (`Work  Item:`, `Work.Item:`; #761 Codex 4235863454), prefixes (`- Work-Item:`, `1. Work-Item:`;
// 4235885068), delimiters (`Work/Item: #750`, `Work-Item #750`; 4235903051), links (`[Work-Item](…): #750`;
// 4235923856) and alphabetic wrappers (`<strong>Work-Item</strong>: #750`, `*label* Work-Item: #750`;
// 4235950157). Every such line except the one canonical terminal trailer is `malformed`, never `none`.
// The cost is deliberate: a commit message may not mention the field followed by a colon, `#` or number anywhere
// outside its trailer; prose without an attempted value (`work items are now read from commits`) still passes.
const FIELD_NAME = /(?<![\p{L}\p{N}])work[^\p{L}\p{N}\n]*item(?![\p{L}\p{N}])/giu;
const ATTEMPTED_VALUE = /[:=#\d]/gu;
// Markup that renders as nothing, or only as its text, may also sit BETWEEN the two words
// (`<strong>Work</strong>-<em>Item</em>: #750`, `[Work](url)-[Item](url): #750`; #763, #761 Codex 4235968337)
// or inside one (`Wo&#114;k`, `Wo*r*k`, `Wo<b></b>rk`). Rendering Markdown and HTML exactly is open-ended (#814's
// reviews found comments, quoted titles, escaped labels, ...), so a line that holds ANY markup character gets a
// broader rule instead: the words `work` and `item` anywhere on it, in that order, then an attempted value. Whatever
// sits between the words no longer matters. Inside a word, the rendered view removes HTML comments and tags,
// inline link targets and reference labels, named entities and emphasis delimiters, and decodes numeric entities.
// Both views only ADD field lines: a line counts as often as the most any view matches, so nothing the raw rule
// refuses can become `none`. The cost: a markup-bearing line may not mention work, then item, then a `:`, `=`,
// `#` or digit.
// Every line is counted in one forward pass (#816, #817: the lazy patterns made long lines quadratic or worse), and
// every step of the rendered view is linear too, so it runs on lines of any length (4255076074). Comments that span
// lines are removed across the whole message first, as a further view.
const MARKUP_CHARACTER = /[<>&[\]()*_~`\\]/u;
const WORK = /(?<![\p{L}\p{N}])work(?![\p{L}\p{N}])/giu;
const ITEM = /(?<![\p{L}\p{N}])item(?![\p{L}\p{N}])/giu;
/** The end of the first match of `pattern` in `text` at or after `from`, or -1. */
const endOf = (pattern, text, from) => {
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match ? match.index + match[0].length : -1;
};
/** How many times `names` (in order) then an attempted value occur, each match starting after the last value. */
const countFields = (text, names) => {
  let n = 0;
  for (let at = 0; ;) {
    for (const name of names) {
      at = endOf(name, text, at);
      if (at < 0) return n;
    }
    at = endOf(ATTEMPTED_VALUE, text, at);
    if (at < 0) return n;
    n += 1;
  }
};
const RAW = [FIELD_NAME];
const MARKED = [WORK, ITEM];
// Autolinks show their address, so they are kept as text; every other tag renders as nothing (4254874280).
const AUTOLINK = /<([a-z][a-z\d+.-]{1,31}:[^<>\s]*|[^<>\s@]+@[^<>\s]+)>/giu;
const TAG = /<(?:[^<>"'\n]|"[^"\n]*"|'[^'\n]*')*>/gu;
const NUMERIC_ENTITY = /&#(?:(\d{1,7})|x([\da-f]{1,6}));/giu;
const NAMED_ENTITY = /&[a-z][a-z\d]*;/giu;
const EMPHASIS = /[*_~`]/gu;
const BRACKETS = /[[\]]/gu;
const decoded = (code) => (code > 0x10ffff || code === 10 || code === 13 ? ' ' : String.fromCodePoint(code));
/** The message with every complete HTML comment removed, including one that spans lines (4254668164). */
const withoutComments = (message) => {
  let out = '';
  let at = 0;
  for (let open = message.indexOf('<!--'); open >= 0; open = message.indexOf('<!--', at)) {
    const close = message.indexOf('-->', open + 4);
    if (close < 0) break;
    out += message.slice(at, open);
    at = close + 3;
  }
  return out + message.slice(at);
};
/**
 * For each position, where the first `)` at or after it closes depth 1 (a link target opened just before it), or -1.
 * One forward pass pairs parentheses (a backslash escapes the next character) and one backward pass follows each
 * pair, so every target is found in linear time however many there are or however many never close (4255076079).
 */
const targetEnds = (line) => {
  const partner = new Int32Array(line.length).fill(-1);
  const escaped = new Uint8Array(line.length);
  const open = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && i + 1 < line.length) {
      escaped[i + 1] = 1;
      i += 1;
    } else if (line[i] === '(') open.push(i);
    else if (line[i] === ')' && open.length > 0) partner[open.pop()] = i;
  }
  const end = new Int32Array(line.length + 1).fill(-1);
  for (let i = line.length - 1; i >= 0; i -= 1) {
    if (escaped[i]) end[i] = end[i + 1];
    else if (line[i] === ')') end[i] = i;
    else if (line[i] === '(') end[i] = partner[i] < 0 ? -1 : end[partner[i] + 1];
    else end[i] = end[i + 1];
  }
  return end;
};
/** Pairs each unescaped `[` with its `]` on the line (-1 for an unpaired one), in one pass. */
const bracketPartners = (line) => {
  const partner = new Int32Array(line.length).fill(-1);
  const open = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') i += 1;
    else if (line[i] === '[') open.push(i);
    else if (line[i] === ']' && open.length > 0) {
      const at = open.pop();
      partner[at] = i;
      partner[i] = at;
    }
  }
  return partner;
};
/**
 * Removes link markup in one pass: paired brackets, and after a paired `]` either an inline target `(…)` (balanced
 * or escaped parentheses, or a `<…>` destination that may hold `)`; 4254874273) or a paired reference label `[…]`.
 * With `literal`, an unpaired bracket renders literally, so it and whatever follows it stay as text (4255131567);
 * without it, every `]` may end a link, as on `main`. An unterminated target stays as text, and the scan goes on past
 * it (4255076079).
 */
const withoutLinks = (line, gap, literal) => {
  if (!line.includes('[') && !line.includes(']')) return line;
  const brackets = bracketPartners(line);
  const end = line.includes('](') ? targetEnds(line) : null;
  let out = '';
  let gt = -2;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') {
      out += line.slice(i, i + 2);
      i += 1;
      continue;
    }
    if ((line[i] !== '[' && line[i] !== ']') || (literal && brackets[i] < 0)) {
      out += line[i];
      continue;
    }
    out += gap;
    if (line[i] !== ']') continue;
    if (line[i + 1] === '(' && end) {
      let j = i + 2;
      while (line[j] === ' ' || line[j] === '\t') j += 1;
      if (line[j] === '<') {
        if (gt !== -1 && gt < j) gt = line.indexOf('>', j);
        j = gt < 0 ? -1 : gt + 1;
      }
      const close = j < 0 ? -1 : end[j];
      if (close >= 0) i = close;
    } else if (line[i + 1] === '[' && brackets[i + 1] > i) {
      out += gap;
      i = brackets[i + 1];
    }
  }
  return out;
};
// Three rendered views. Comments, tags, entities and emphasis always join what they separated (`Wo<b></b>rk` renders
// `Work`). Link markup joins (`Wo[](x)rk`) in the first two views, where every `]` may end a link (as on `main`) or
// only a paired one may, and leaves a boundary in the third. Any bracket left over is removed the same way. Every
// view only adds field lines.
const VIEWS = [['', false], ['', true], [' ', true]];
const rendered = (line, [gap, literal]) => withoutLinks(
  withoutComments(line).replace(AUTOLINK, '$1').replace(TAG, ''),
  gap,
  literal,
)
  .replace(BRACKETS, gap)
  .replace(NUMERIC_ENTITY, (_, dec, hex) => decoded(dec === undefined ? Number.parseInt(hex, 16) : Number(dec)))
  .replace(NAMED_ENTITY, '')
  .replace(EMPHASIS, '');
const fieldMatches = (line) => {
  const raw = countFields(line, RAW);
  if (!MARKUP_CHARACTER.test(line)) return raw;
  const views = VIEWS.map((view) => rendered(line, view));
  const counts = views.flatMap((view) => [countFields(view, RAW), countFields(view, MARKED)]);
  return Math.max(raw, countFields(line, MARKED), ...counts);
};
const fieldCount = (lines) => lines.reduce((sum, line) => sum + fieldMatches(line), 0);
// The one field line, raw, must itself be the canonical trailer: git's `--unfold` joins an indented continuation
// into the value, so `Work-Item:` followed by an indented ` #750` would otherwise read as cited (4235903046).
const CANONICAL_LINE = /^work-item:[ \t]*#[1-9]\d{0,9}[ \t]*$/iu;
const VALUE = /^#([1-9]\d{0,9})$/u;

/**
 * The head commit's cited work item. Outcomes, all named:
 *   none       — no line names the field (a citation is optional)
 *   cited      — exactly one terminal `Work-Item: #N` trailer and no other line naming the field; `issue` is N
 *   malformed  — a field line outside the terminal trailer block, more than one, or a value other than `#N`
 *   unreadable — the message could not be read, or git could not parse it (a consumer fails closed or retries)
 * `parse` is injectable for tests; production uses the isolated git parser.
 */
export function parseWorkItemTrailer(commitMessage, { parse = gitParsedTrailers } = {}) {
  if (typeof commitMessage !== 'string') {
    return { state: 'unreadable', issue: null, detail: 'the head commit message could not be read' };
  }
  const lines = commitMessage.split('\n');
  const uncommented = commitMessage.includes('<!--') ? withoutComments(commitMessage) : commitMessage;
  const named = Math.max(fieldCount(lines), uncommented === commitMessage ? 0 : fieldCount(uncommented.split('\n')));
  if (named === 0) return { state: 'none', issue: null, detail: null };
  const trailers = parse(commitMessage);
  if (trailers === null) {
    return { state: 'unreadable', issue: null, detail: 'git could not parse the head commit trailers' };
  }
  const values = trailers
    .filter((trailer) => trailer.key.toLowerCase() === FIELD_KEY)
    .map((trailer) => asciiTrim(trailer.value));
  if (values.length !== 1 || named !== 1) {
    return {
      state: 'malformed',
      issue: null,
      detail: values.length > 1
        ? `the head commit has ${values.length} Work-Item trailers; cite exactly one`
        : 'a Work-Item line must be the single trailer in the head commit\'s final trailer block',
    };
  }
  const match = VALUE.exec(values[0]);
  const at = lines.findIndex((line) => fieldMatches(line) > 0);
  if (match && (!CANONICAL_LINE.test(lines[at]) || /^[ \t]/u.test(lines[at + 1] ?? ''))) {
    return {
      state: 'malformed',
      issue: null,
      detail: 'the Work-Item trailer must be one unfolded line, exactly `Work-Item: #<issue number>`',
    };
  }
  if (!match) {
    return {
      state: 'malformed',
      issue: null,
      detail: `the Work-Item trailer value "${values[0].slice(0, 60)}" must be exactly \`#<issue number>\``,
    };
  }
  return { state: 'cited', issue: Number(match[1]), detail: null };
}
