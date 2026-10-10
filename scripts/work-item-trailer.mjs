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

import { asciiTrim, gitParsedTrailers } from './correction-owner.mjs';

const FIELD_KEY = 'work-item';
// Any line that names the field, however it is spelled or indented: `Work-Item:`, `work item:`, `WORK_ITEM :`.
const FIELD_LINE = /^[^\S\n]*work[-_ ]?item[^\S\n]*:/imu;
const FIELD_LINES = new RegExp(FIELD_LINE.source, 'gimu');
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
  const named = commitMessage.match(FIELD_LINES)?.length ?? 0;
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
  if (!match) {
    return {
      state: 'malformed',
      issue: null,
      detail: `the Work-Item trailer value "${values[0].slice(0, 60)}" must be exactly \`#<issue number>\``,
    };
  }
  return { state: 'cited', issue: Number(match[1]), detail: null };
}
