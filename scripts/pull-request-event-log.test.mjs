import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PULL_REQUEST_EVENT_LOG_SCHEMA,
  PULL_REQUEST_LIFECYCLE_EVENTS,
  TIMELINE_MAX_PAGES,
  TIMELINE_PAGE_SIZE,
  readPullRequestEventLog,
} from './pull-request-event-log.mjs';

const REPO = 'JagPat/PMCvitan';
const PR = 620;
const at = (hhmm) => `2026-09-23T${hhmm}:00Z`;
const ms = (hhmm) => Date.parse(at(hhmm));
const SINCE = ms('10:30');

let nextId = 1;
const event = (name, hhmm, actor = 'JagPat') => ({ id: nextId++, event: name, actor: { login: actor }, created_at: at(hhmm) });
const comment = (hhmm) => ({ id: nextId++, event: 'commented', actor: { login: 'JagPat' }, created_at: at(hhmm), body: 'x' });
const filler = (count) => Array.from({ length: count }, () => comment('09:00'));

// A fake GitHubClient serving the timeline in pages, oldest first. `timeline` may be a function of the
// read number so a test can change the timeline between the reader's own reads (a barrier). It refuses
// anything but a GET, so every test also proves the reader is read-only.
function client(timeline) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    repository: REPO,
    async request(path, { method = 'GET' } = {}) {
      calls.push(path);
      if (method !== 'GET') throw new Error(`write attempted: ${method} ${path}`);
      const match = /^\/repos\/JagPat\/PMCvitan\/issues\/620\/timeline\?per_page=(\d+)&page=(\d+)$/u.exec(path);
      if (!match) throw new Error(`unexpected ${path}`);
      reads += 1;
      const items = typeof timeline === 'function' ? timeline(reads) : timeline;
      const [size, page] = [Number(match[1]), Number(match[2])];
      return items.slice((page - 1) * size, page * size);
    },
  };
}
const clock = () => () => ms('12:00');

test('lifecycle events after the anchor are reported with id, actor and server time; everything else is not', async () => {
  const retargeted = event('base_ref_changed', '11:00');
  const closed = event('closed', '11:10', 'someone');
  const timeline = [
    event('base_ref_changed', '10:00'), // before the anchor
    comment('10:40'),
    { id: nextId++, event: 'labeled', created_at: at('10:45') },
    { sha: 'a'.repeat(40), node_id: 'C_1', event: 'committed' }, // commits carry no created_at
    retargeted,
    closed,
  ];
  const fake = client(timeline);
  const log = await readPullRequestEventLog(fake, { pullRequest: PR, sinceMs: SINCE, now: clock() });
  assert.deepEqual(log, {
    schema: PULL_REQUEST_EVENT_LOG_SCHEMA,
    repository: REPO,
    pullRequest: PR,
    sinceMs: SINCE,
    covered: true,
    events: [
      { eventId: retargeted.id, event: 'base_ref_changed', actorLogin: 'JagPat', atMs: ms('11:00') },
      { eventId: closed.id, event: 'closed', actorLogin: 'someone', atMs: ms('11:10') },
    ],
    readAtMs: ms('12:00'),
    problems: [],
  });
  // Read-only, repository- and PR-scoped, two complete passes of one page each.
  assert.equal(fake.calls.length, 2);
  // An event in the anchor's own second cannot be ordered before it, so it is reported.
  const tied = event('reopened', '10:30');
  const atAnchor = await readPullRequestEventLog(client([tied]), { pullRequest: PR, sinceMs: SINCE, now: clock() });
  assert.deepEqual(atAnchor.events.map((entry) => entry.eventId), [tied.id]);
});

test('an away-and-back retarget is two events, even though the base ends where it started', async () => {
  const log = await readPullRequestEventLog(
    client([event('base_ref_changed', '11:00'), event('base_ref_changed', '11:01')]),
    { pullRequest: PR, sinceMs: SINCE, now: clock() },
  );
  assert.deepEqual(log.events.map((entry) => entry.event), ['base_ref_changed', 'base_ref_changed']);
});

test('every lifecycle event type is reported; an undated one is kept, never dropped', async () => {
  const timeline = PULL_REQUEST_LIFECYCLE_EVENTS.map((name) => event(name, '11:00'));
  timeline.push({ id: nextId++, event: 'reopened', actor: { login: 'JagPat' } });
  const log = await readPullRequestEventLog(client(timeline), { pullRequest: PR, sinceMs: SINCE, now: clock() });
  assert.deepEqual(log.events.map((entry) => entry.event), [...PULL_REQUEST_LIFECYCLE_EVENTS, 'reopened']);
  assert.equal(log.events.at(-1).atMs, null);
});

test('the timeline is read to its end across pages; one longer than the page cap is uncovered', async () => {
  const late = event('base_ref_changed', '11:00');
  const long = [...filler(2 * TIMELINE_PAGE_SIZE), late];
  const fake = client(long);
  const log = await readPullRequestEventLog(fake, { pullRequest: PR, sinceMs: SINCE, now: clock() });
  assert.equal(log.covered, true);
  assert.deepEqual(log.events.map((entry) => entry.eventId), [late.id]);
  assert.equal(fake.calls.length, 6); // three pages, twice
  const endless = await readPullRequestEventLog(
    client(filler(TIMELINE_MAX_PAGES * TIMELINE_PAGE_SIZE)),
    { pullRequest: PR, sinceMs: SINCE, now: clock() },
  );
  assert.deepEqual([endless.covered, endless.events, endless.readAtMs], [false, null, null]);
  assert.ok(endless.problems[0].includes('uncovered'));
});

test('a deletion that shifts the pages between the two passes is uncovered, never a short list', async () => {
  // Barrier: an early comment is deleted after the first pass has read page 1, so a later page shifts
  // left; the two passes then disagree on the item sequence.
  const early = filler(TIMELINE_PAGE_SIZE);
  const retarget = event('base_ref_changed', '11:00');
  const full = [...early, retarget];
  const log = await readPullRequestEventLog(
    client((read) => (read <= 1 ? full : full.filter((item) => item !== early[0]))),
    { pullRequest: PR, sinceMs: SINCE, now: clock() },
  );
  assert.deepEqual([log.covered, log.events], [false, null]);
  assert.ok(log.problems[0].includes('shifted'));
  // Appends between the passes are not a shift: the second pass is taken.
  const appended = event('closed', '11:30');
  const grown = await readPullRequestEventLog(
    client((read) => (read <= 1 ? [retarget] : [retarget, appended])),
    { pullRequest: PR, sinceMs: SINCE, now: clock() },
  );
  assert.equal(grown.covered, true);
  assert.deepEqual(grown.events.map((entry) => entry.eventId), [retarget.id, appended.id]);
});

test('items without an id are keyed by immutable fields, so an edited comment is not a shift', async () => {
  const reference = { event: 'cross-referenced', actor: { login: 'JagPat' }, created_at: at('10:50'), source: { issue: { id: 77 } } };
  const edited = comment('10:55');
  const retarget = event('base_ref_changed', '11:00');
  const log = await readPullRequestEventLog(
    client((read) => [reference, read <= 1 ? edited : { ...edited, body: 'edited', updated_at: at('11:59') }, retarget]),
    { pullRequest: PR, sinceMs: SINCE, now: clock() },
  );
  assert.equal(log.covered, true);
  assert.deepEqual(log.events.map((entry) => entry.eventId), [retarget.id]);
  // An item with no identity at all fails the prefix check closed.
  const anonymous = await readPullRequestEventLog(client([{ event: 'mystery' }]), { pullRequest: PR, sinceMs: SINCE, now: clock() });
  assert.equal(anonymous.covered, false);
});

test('a read failure, a non-list page or invalid input is contained as uncovered with a diagnostic', async () => {
  const failing = { repository: REPO, async request() { throw new Error('boom'); } };
  const failed = await readPullRequestEventLog(failing, { pullRequest: PR, sinceMs: SINCE });
  assert.deepEqual([failed.covered, failed.events], [false, null]);
  assert.deepEqual(failed.problems, ['timeline pass 1 page 1: boom']);
  const odd = await readPullRequestEventLog({ repository: REPO, async request() { return { message: 'x' }; } }, { pullRequest: PR, sinceMs: SINCE });
  assert.deepEqual(odd.problems, ['timeline pass 1 page 1: not a list']);
  for (const input of [{ pullRequest: 0, sinceMs: SINCE }, { pullRequest: PR }, { pullRequest: PR, sinceMs: Number.NaN }]) {
    const invalid = await readPullRequestEventLog(client([]), input);
    assert.deepEqual([invalid.covered, invalid.problems], [false, ['invalid event-log input']]);
  }
  assert.deepEqual((await readPullRequestEventLog(null, { pullRequest: PR, sinceMs: SINCE })).problems, ['invalid event-log input']);
});
