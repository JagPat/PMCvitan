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

// Video V2g-1 (#995; Jagrut, 6 Nov 2026: "small clip + paste a Drive link") — a video clip's link to its full-quality
// video in Google Drive or Zoho WorkDrive. The screen checks a pasted link with the same function the server does, and
// the database's CHECK (20280213000000, K1) holds the same list, so a link one of the three accepts all three accept.

/** The longest link, in characters, as the database column counts them (every allowed character is one byte). */
export const VIDEO_LINK_URL_MAX = 2000;
/** The longest label, in characters (code points), as the database column counts them. */
export const VIDEO_LINK_LABEL_MAX = 120;

// https, then one of the allowed hosts exactly (lowercase), then "/": nothing between "https://" and the host (no
// userinfo) and nothing between the host and "/" (no port). docs.google.com is left out on purpose: a Drive file or
// folder share is always on drive.google.com, and docs.google.com also serves Forms and /url redirects.
const VIDEO_LINK_HOSTS = /^https:\/\/(drive\.google\.com|workdrive\.zoho\.(com|in|eu)|workdrive\.zohopublic\.(com|in|eu))\//u;
// printable ASCII only: no space of any kind, no control character, nothing outside ASCII
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/u;

/** Whether a link is one the app keeps beside a clip: the database's K1 CHECK, exactly. The app never fetches it. */
export function isAllowedVideoLink(url: string): boolean {
  return url.length <= VIDEO_LINK_URL_MAX && PRINTABLE_ASCII.test(url) && VIDEO_LINK_HOSTS.test(url);
}

/** Which service an allowed link is on, as the database sets the row's `host`; null for a link that is not allowed. */
export function videoLinkHost(url: string): 'drive' | 'zoho' | null {
  if (!isAllowedVideoLink(url)) return null;
  return url.startsWith('https://drive.google.com/') ? 'drive' : 'zoho';
}

/** The refusal of a link on another host, a link with a port or sign-in part, or one with spaces. */
export const VIDEO_LINK_REFUSED_MESSAGE = 'Paste a share link from Google Drive or Zoho WorkDrive';
/** The server's 404 text for a removal of a link the clip no longer holds under that id. The screen takes a 404 on a
 *  link's removal as "already gone" only when it carries this text, never a route's or a proxy's 404. */
export const VIDEO_LINK_GONE_MESSAGE = 'This full video link is no longer on the clip';
