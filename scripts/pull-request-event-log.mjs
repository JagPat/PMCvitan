/**
 * PULL REQUEST LIFECYCLE EVENT LOG (trusted, read-only, non-activating).
 *
 * A snapshot of a pull request says what its base, state and head ARE at one read; it cannot say that
 * they did not change and change back between two reads. A retarget `main → release → main` inside a
 * window leaves both snapshots equal while the merge result under test (and the CI it launched) moved.
 * This module is the HISTORY side for those dimensions, the base/state counterpart of the branch push
 * log: for ONE repository and ONE pull request it reads the ISSUE EVENTS and returns every lifecycle
 * event at or after an anchor time — base changes, close/reopen/merge, draft transitions and head-ref
 * events — each with its server time, id and actor.
 *
 * Why issue events, not the timeline. The timeline interleaves user content (comments) that can be
 * DELETED; page-based reads over a list with deletions can shift an item across a page boundary and
 * silently skip it, and no number of repeated passes proves a read untorn. Issue events are system
 * records that users cannot delete: the list is append-only, oldest first, so a page-by-page read can only
 * miss what is appended after the read — never an event that existed when it began. `coveredFromMs`
 * (taken before the first page) is therefore the instant up to which the log is complete.
 *
 * The log is COMPLETE or it is nothing. Pages are read until a short page; a log longer than
 * `EVENT_LOG_MAX_PAGES` full pages, a non-array page, a failed read, or event ids that do not strictly
 * increase in read order (the append-only property broken) yields `covered: false` and `events: null`
 * (never a partial list that could pass as "no events") plus a diagnostic. A lifecycle event whose time
 * cannot be read is kept (with `atMs: null`), never dropped, because it cannot be proven to precede the
 * anchor. GitHub stamps events to whole seconds, so the anchor is compared at that precision: an event in
 * the anchor's own second is reported.
 *
 * It decides nothing: which events disqualify a cycle, and from which anchor, is the consumer's rule.
 * READ-ONLY and NON-ACTIVATING: it issues only GET requests, writes nothing, is wired to no workflow,
 * gate or routing, and grants nothing. `codex-current-head` stays the required gate.
 */

export const PULL_REQUEST_EVENT_LOG_SCHEMA = 'pmcvitan.pull-request-event-log.v1';
export const EVENT_LOG_PAGE_SIZE = 100;
export const EVENT_LOG_MAX_PAGES = 10;
// GitHub's event timestamps carry whole seconds.
const SERVER_TIME_PRECISION_MS = 1_000;

// Issue events that change a pull request's base, state or head ref. Draft transitions appear under both
// spellings GitHub has used (`convert_to_draft` and `converted_to_draft`).
export const PULL_REQUEST_LIFECYCLE_EVENTS = Object.freeze([
  'base_ref_changed',
  'base_ref_force_pushed',
  'automatic_base_change_succeeded',
  'automatic_base_change_failed',
  'closed',
  'reopened',
  'merged',
  'convert_to_draft',
  'converted_to_draft',
  'ready_for_review',
  'head_ref_deleted',
  'head_ref_restored',
  'head_ref_force_pushed',
]);

function timeMs(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The lifecycle events on complete event pages at or after `sinceMs`, compared at the server's
 * whole-second precision (an event in the anchor's own second cannot be ordered before it), oldest
 * first. Undated lifecycle events are kept with `atMs: null`. Returns `null` for input that is not a list
 * of pages.
 */
export function normalizePullRequestEvents(pages, { sinceMs }) {
  if (!Array.isArray(pages) || !pages.every(Array.isArray) || !Number.isFinite(sinceMs)) return null;
  const anchorMs = Math.floor(sinceMs / SERVER_TIME_PRECISION_MS) * SERVER_TIME_PRECISION_MS;
  return pages
    .flat()
    .filter((item) => PULL_REQUEST_LIFECYCLE_EVENTS.includes(item?.event))
    .map((item) => ({
      eventId: item.id ?? null,
      event: item.event,
      actorLogin: item.actor?.login ?? null,
      atMs: timeMs(item.created_at),
    }))
    .filter((entry) => entry.atMs === null || entry.atMs >= anchorMs)
    .sort((a, b) => (a.atMs ?? Infinity) - (b.atMs ?? Infinity));
}

/**
 * Read the lifecycle event log of one pull request at or after `sinceMs`. `client` is a `GitHubClient`
 * (only `repository` and `request` are used); `now` is injectable for tests. Never throws on a GitHub
 * error.
 */
export async function readPullRequestEventLog(client, { pullRequest, sinceMs, now = () => Date.now() } = {}) {
  const repository = client?.repository;
  const empty = { schema: PULL_REQUEST_EVENT_LOG_SCHEMA, repository: repository ?? null, pullRequest: pullRequest ?? null,
    sinceMs: sinceMs ?? null, covered: false, events: null, coveredFromMs: null, readAtMs: null };
  if (typeof repository !== 'string' || !Number.isInteger(pullRequest) || pullRequest <= 0 || !Number.isFinite(sinceMs)) {
    return { ...empty, problems: ['invalid event-log input'] };
  }
  const coveredFromMs = now();
  const pages = [];
  for (let page = 1; page <= EVENT_LOG_MAX_PAGES; page += 1) {
    let items;
    try {
      items = await client.request(
        `/repos/${repository}/issues/${pullRequest}/events?per_page=${EVENT_LOG_PAGE_SIZE}&page=${page}`,
      );
    } catch (error) {
      return { ...empty, problems: [`events page ${page}: ${error?.message ?? String(error)}`] };
    }
    if (!Array.isArray(items)) return { ...empty, problems: [`events page ${page}: not a list`] };
    pages.push(items);
    if (items.length < EVENT_LOG_PAGE_SIZE) {
      // Append-only, oldest first: ids must strictly increase across the whole read. Anything else means
      // the property this read relies on did not hold, so the log is not trusted.
      const ids = pages.flat().map((item) => item?.id);
      const ordered = ids.every((id, index) => Number.isInteger(id) && (index === 0 || ids[index - 1] < id));
      if (!ordered) return { ...empty, problems: ['events: ids do not strictly increase (uncovered)'] };
      return {
        ...empty,
        covered: true,
        events: normalizePullRequestEvents(pages, { sinceMs }),
        coveredFromMs,
        readAtMs: now(),
        problems: [],
      };
    }
  }
  return { ...empty, problems: [`events: longer than ${EVENT_LOG_MAX_PAGES} full pages (uncovered)`] };
}
