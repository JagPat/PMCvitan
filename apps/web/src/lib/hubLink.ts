import { hubLabels, type Lang } from '@vitan/shared';

/**
 * #1118 U7a L2 — what a Hub link call's failure means for the screen.
 *
 * - `closed`: 404. Hub is not connected for this company (or the project is not the company's): the row says so.
 * - `retry`: the call may not have finished (no answer, a 5xx, a throttle, or Hub not answering). The attempt keeps its
 *   key, so trying again replays it if PMC had already done it.
 * - `refused`: a final answer. The attempt's key is dropped; `code` picks the words.
 */
export type HubFailure =
  | { kind: 'closed' }
  | { kind: 'retry' }
  | { kind: 'refused'; code: HubRefusal };

export type HubRefusal =
  | 'forbidden'
  | 'hub_key_refused'
  | 'hub_refused'
  | 'hub_linked_elsewhere'
  | 'hub_project_taken'
  | 'hub_drawings_elsewhere'
  | 'hub_not_linked'
  | 'hub_project_unavailable'
  | 'hub_link_changed'
  | 'other';

const REFUSALS: readonly HubRefusal[] = [
  'hub_key_refused',
  'hub_refused',
  'hub_linked_elsewhere',
  'hub_project_taken',
  'hub_drawings_elsewhere',
  'hub_not_linked',
  'hub_project_unavailable',
  'hub_link_changed',
];

export function hubFailureOf(err: unknown): HubFailure {
  const e = err as { status?: unknown; serverCode?: unknown } | null;
  const status = typeof e?.status === 'number' ? e.status : null;
  const code = typeof e?.serverCode === 'string' ? e.serverCode : null;
  if (status === null) return { kind: 'retry' }; // no answer: the call may have landed
  if (status === 404) return { kind: 'closed' };
  if (status === 403) return { kind: 'refused', code: 'forbidden' };
  // only the server's own code makes a 5xx final (an operator renews the key; Hub refused the call): a bare 5xx, a 502
  // from a proxy among them, may come after the command landed (Codex 4479979974)
  if (code && (REFUSALS as readonly string[]).includes(code)) return { kind: 'refused', code: code as HubRefusal };
  if (status >= 500 || status === 408 || status === 429) return { kind: 'retry' };
  return { kind: 'refused', code: 'other' };
}

/** The words for a failure, in the screen's language. */
export function hubFailureText(f: HubFailure, lang: Lang): string {
  const L = hubLabels;
  if (f.kind === 'closed') return L.closed[lang];
  if (f.kind === 'retry') return L.unavailable[lang];
  switch (f.code) {
    case 'forbidden': return L.forbidden[lang];
    case 'hub_key_refused': return L.keyRefused[lang];
    case 'hub_refused': return L.hubRefused[lang];
    case 'hub_linked_elsewhere': return L.linkedElsewhere[lang];
    case 'hub_project_taken': return L.projectTaken[lang];
    case 'hub_drawings_elsewhere': return L.drawingsElsewhere[lang];
    case 'hub_not_linked': return L.notLinkedNow[lang];
    case 'hub_project_unavailable': return L.projectUnavailable[lang];
    case 'hub_link_changed': return L.linkChanged[lang];
    default: return L.failed[lang];
  }
}

/** "Open in Hub" goes only to an http(s) address: anything else the snapshot carried is not a link. */
export function safeHubUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** A Hub link call's answer to the screen. `stale`: the screen moved to another project or sign-in meanwhile, so the
 *  answer is not shown (what PMC did stands, and that project's next snapshot carries it). */
export type HubCallResult<T> =
  | { kind: 'ok'; value: T }
  /** the command landed, but the fresh snapshot does not show it yet: the screen keeps the attempt's key and offers
   *  Try again, which replays the command and pulls again */
  | { kind: 'unconfirmed'; value: T }
  | { kind: 'failed'; failure: HubFailure }
  | { kind: 'stale' };

/** An unlink not yet settled: its key, and the Hub project it ends (the link the person saw and confirmed). */
export type HubUnlinkPending = { key: string; hubProjectId: string };

/** How long a link or unlink waits for a snapshot that shows it before it answers `unconfirmed`. */
export const HUB_SHOWN_WAIT_MS = 10_000;
