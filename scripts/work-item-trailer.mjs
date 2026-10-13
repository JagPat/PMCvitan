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
const FIELD_LINE = /(?<![\p{L}\p{N}])work[^\p{L}\p{N}\n]*item(?![\p{L}\p{N}])[^\n]*?[:=#\d]/iu;
const FIELD_LINES = new RegExp(FIELD_LINE.source, 'gimu');
// Markup that renders as nothing, or only as its text, may also sit BETWEEN the two words
// (`<strong>Work</strong>-<em>Item</em>: #750`, `[Work](url)-[Item](url): #750`, `Work&#45;Item: #750`; #763,
// #761 Codex 4235968337). A line is also checked as rendered: HTML tags (quoted attribute values may hold `>`),
// link targets and reference labels removed, numeric entities decoded (`Wo&#114;k`; #814 Codex 4254561958,
// 4254561977) and named ones removed, since none renders as an ASCII letter. That view only ADDS field lines: a line
// counts as often as the larger of its raw and rendered matches, so nothing the raw rule refuses can become `none`.
const MARKUP = /<(?:[^<>"'\n]|"[^"\n]*"|'[^'\n]*')*>|(?<=\])\([^()\n]*\)|(?<=\])\[[^[\]\n]*\]/gu;
const NUMERIC_ENTITY = /&#(?:(\d{1,7})|x([\da-f]{1,6}));/giu;
const NAMED_ENTITY = /&[a-z][a-z\d]*;/giu;
const decoded = (code) => (code > 0x10ffff || code === 10 || code === 13 ? ' ' : String.fromCodePoint(code));
const rendered = (line) => line
  .replace(MARKUP, '')
  .replace(NUMERIC_ENTITY, (_, dec, hex) => decoded(dec === undefined ? Number.parseInt(hex, 16) : Number(dec)))
  .replace(NAMED_ENTITY, '');
const fieldMatches = (line) =>
  Math.max(line.match(FIELD_LINES)?.length ?? 0, rendered(line).match(FIELD_LINES)?.length ?? 0);
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
  const named = lines.reduce((sum, line) => sum + fieldMatches(line), 0);
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
