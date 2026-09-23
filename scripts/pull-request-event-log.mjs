/**
 * PULL REQUEST LIFECYCLE EVENT LOG (trusted, read-only, non-activating).
 *
 * A snapshot of a pull request says what its base, state and head ARE at one read; it cannot say that
 * they did not change and change back between two reads. A retarget `main → release → main` inside a
 * window leaves both snapshots equal while the merge result under test (and the CI it launched) moved.
 * This module is the HISTORY side for those dimensions, the base/state counterpart of the branch push
 * log: for ONE repository and ONE pull request it reads the issue timeline and returns every lifecycle
 * event after an anchor time — base changes, close/reopen/merge, draft transitions and head-ref
 * events — each with its server time, id and actor.
 *
 * The log is COMPLETE or it is nothing. The timeline is read page by page, oldest first, until a short
 * page; a timeline longer than `TIMELINE_MAX_PAGES` full pages, a non-array page or a failed read yields
 * `covered: false` and `events: null` (never a partial list that could pass as "no events") plus a
 * diagnostic. Page-based reads can skip an item when an earlier one is deleted mid-read (later items
 * shift left), so the whole timeline is read TWICE: the first pass's item sequence must be a prefix of
 * the second's (appends are fine; a deletion or shift fails closed), and the events come from the second
 * pass. A lifecycle event whose time cannot be read is kept (with `atMs: null`), never dropped, because
 * it cannot be proven to precede the anchor.
 *
 * It decides nothing: which events disqualify a cycle, and from which anchor, is the consumer's rule.
 * READ-ONLY and NON-ACTIVATING: it issues only GET requests, writes nothing, is wired to no workflow,
 * gate or routing, and grants nothing. `codex-current-head` stays the required gate.
 */

export const PULL_REQUEST_EVENT_LOG_SCHEMA = 'pmcvitan.pull-request-event-log.v1';
export const TIMELINE_PAGE_SIZE = 100;
export const TIMELINE_MAX_PAGES = 10;

// Timeline events that change a pull request's base, state or head ref. Anything else on the timeline
// (comments, labels, reviews, commits, references) does not move what the pull request merges.
export const PULL_REQUEST_LIFECYCLE_EVENTS = Object.freeze([
  'base_ref_changed',
  'base_ref_force_pushed',
  'automatic_base_change_succeeded',
  'automatic_base_change_failed',
  'closed',
  'reopened',
  'merged',
  'converted_to_draft',
  'ready_for_review',
  'head_ref_deleted',
  'head_ref_restored',
  'head_ref_force_pushed',
]);

// An item's identity on the timeline, from immutable fields only (an edited comment keeps its key). Issue
// events carry `id`, commits `sha`, most others `node_id`; the few that carry none (cross-references,
// line-comment groups) are keyed by creation time, actor and source. An item with no identity at all
// cannot take part in the prefix check and fails it.
function itemKey(item) {
  const direct = item?.id ?? item?.sha ?? item?.node_id;
  const composite = [item?.created_at, item?.actor?.login, item?.source?.issue?.id, item?.comments?.[0]?.id]
    .filter((part) => part !== undefined && part !== null)
    .join('|');
  const key = direct ?? (composite || null);
  return key === null ? null : `${item?.event ?? ''}:${key}`;
}

function timeMs(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The lifecycle events on complete timeline pages at or after `sinceMs` (an event in the anchor's own
 * second cannot be ordered before it), oldest first. Undated lifecycle events are kept with `atMs: null`. Returns `null` for input that is not a list of pages.
 */
export function normalizePullRequestEvents(pages, { sinceMs }) {
  if (!Array.isArray(pages) || !pages.every(Array.isArray) || !Number.isFinite(sinceMs)) return null;
  return pages
    .flat()
    .filter((item) => PULL_REQUEST_LIFECYCLE_EVENTS.includes(item?.event))
    .map((item) => ({
      eventId: item.id ?? null,
      event: item.event,
      actorLogin: item.actor?.login ?? null,
      atMs: timeMs(item.created_at),
    }))
    .filter((entry) => entry.atMs === null || entry.atMs >= sinceMs)
    .sort((a, b) => (a.atMs ?? Infinity) - (b.atMs ?? Infinity));
}

/**
 * Read the lifecycle event log of one pull request after `sinceMs`. `client` is a `GitHubClient` (only
 * `repository` and `request` are used); `now` is injectable for tests. Never throws on a GitHub error.
 */
export async function readPullRequestEventLog(client, { pullRequest, sinceMs, now = () => Date.now() } = {}) {
  const repository = client?.repository;
  const empty = { schema: PULL_REQUEST_EVENT_LOG_SCHEMA, repository: repository ?? null, pullRequest: pullRequest ?? null,
    sinceMs: sinceMs ?? null, covered: false, events: null, readAtMs: null };
  if (typeof repository !== 'string' || !Number.isInteger(pullRequest) || pullRequest <= 0 || !Number.isFinite(sinceMs)) {
    return { ...empty, problems: ['invalid event-log input'] };
  }
  const readPass = async (pass) => {
    const pages = [];
    for (let page = 1; page <= TIMELINE_MAX_PAGES; page += 1) {
      let items;
      try {
        items = await client.request(
          `/repos/${repository}/issues/${pullRequest}/timeline?per_page=${TIMELINE_PAGE_SIZE}&page=${page}`,
        );
      } catch (error) {
        return { problem: `timeline pass ${pass} page ${page}: ${error?.message ?? String(error)}` };
      }
      if (!Array.isArray(items)) return { problem: `timeline pass ${pass} page ${page}: not a list` };
      pages.push(items);
      if (items.length < TIMELINE_PAGE_SIZE) return { pages };
    }
    return { problem: `timeline pass ${pass}: longer than ${TIMELINE_MAX_PAGES} full pages (uncovered)` };
  };

  const first = await readPass(1);
  if (first.problem) return { ...empty, problems: [first.problem] };
  const second = await readPass(2);
  if (second.problem) return { ...empty, problems: [second.problem] };
  const firstKeys = first.pages.flat().map(itemKey);
  const secondKeys = second.pages.flat().map(itemKey);
  const prefix = firstKeys.length <= secondKeys.length
    && firstKeys.every((key, index) => key !== null && key === secondKeys[index]);
  if (!prefix) {
    return { ...empty, problems: ['timeline: the item sequence shifted between passes (uncovered)'] };
  }
  return {
    ...empty,
    covered: true,
    events: normalizePullRequestEvents(second.pages, { sinceMs }),
    readAtMs: now(),
    problems: [],
  };
}
