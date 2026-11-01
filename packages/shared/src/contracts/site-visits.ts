// #1179 — taking a file off a site visit: the rules the server enforces and the screen mirrors, kept in one place.

/** The longest reason the PMC may give, in characters (code points), as the database column counts them. */
export const SITE_VISIT_REMOVAL_REASON_MAX = 300;

// What shows: a letter, digit, punctuation mark or symbol that is neither default-ignorable (a variation selector or a
// Hangul filler draws nothing) nor the blank Braille cell. Listing what shows, rather than what does not, refuses a
// reason of marks, controls, separators, private-use or unassigned code points alike (Codex 4397768825, 4398944044).
const SHOWS = /[\p{L}\p{N}\p{P}\p{S}]/u;
const DRAWS_NOTHING = /[\p{Default_Ignorable_Code_Point}\u2800]/u;

/** Whether a removal reason shows something to read. A combining mark still counts beside the letter it sits on. */
export function removalReasonShows(reason: string): boolean {
  return [...reason].some((c) => SHOWS.test(c) && !DRAWS_NOTHING.test(c));
}

/** The server's 404 texts for a removal of a file the visit no longer holds. The screen takes a 404 on a removal as
 *  "already removed" only when it carries one of these texts, never a route's or a proxy's 404. */
export const VISIT_FILE_GONE_MESSAGE = 'This file is no longer on the site visit';
export const NOT_A_VISIT_FILE_MESSAGE = 'This file is not on a site visit';
