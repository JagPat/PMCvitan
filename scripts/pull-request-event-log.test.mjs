import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVENT_LOG_MAX_PAGES,
  EVENT_LOG_PAGE_SIZE,
  PULL_REQUEST_EVENT_LOG_SCHEMA,
  PULL_REQUEST_LIFECYCLE_EVENTS,
  readPullRequestEventLog,
} from './pull-request-event-log.mjs';

const REPO = 'JagPat/PMCvitan';
const PR = 620;
const at = (hhmm) => `2026-09-23T${hhmm}:00Z`;
const ms = (hhmm) => Date.parse(at(hhmm));
const SINCE = ms('10:30');

let nextId = 1;
const event = (name, created, actor = 'JagPat') => ({
  id: nextId++, event: name, actor: { login: actor }, created_at: created.length === 5 ? at(created) : created,
});
const filler = (count) => Array.from({ length: count }, () => event('subscribed', '09:00'));

// A fake GitHubClient serving the issue events in pages, oldest first. `events` may be a function of the
// read number so a test can change the log between the reader's own page reads (a barrier). It refuses
// anything but a GET, so every test also proves the reader is read-only.
function client(events) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    repository: REPO,
    async request(path, { method = 'GET' } = {}) {
      calls.push(path);
      if (method !== 'GET') throw new Error(`write attempted: ${method} ${path}`);
      const match = /^\/repos\/JagPat\/PMCvitan\/issues\/620\/events\?per_page=(\d+)&page=(\d+)$/u.exec(path);
      if (!match) throw new Error(`unexpected ${path}`);
      reads += 1;
      const items = typeof events === 'function' ? events(reads) : events;
      const [size, page] = [Number(match[1]), Number(match[2])];
      return items.slice((page - 1) * size, page * size);
    },
  };
}
function clock() {
  let t = ms('12:00');
  return () => (t += 1_000);
}

test('lifecycle events at or after the anchor are reported with id, actor and server time; everything else is not', async () => {
  const events = [
    event('base_ref_changed', '10:00'), // before the anchor
    event('labeled', '10:45'),
    event('mentioned', '10:46'),
    event('base_ref_changed', '11:00'),
    event('closed', '11:10', 'someone'),
  ];
  const [retargeted, closed] = events.slice(3);
  const fake = client(events);
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
    coveredFromMs: ms('12:00') + 1_000,
    readAtMs: ms('12:00') + 2_000,
    problems: [],
  });
  // Read-only and repository- and PR-scoped: one page of the append-only issue events.
  assert.deepEqual(fake.calls, [`/repos/${REPO}/issues/${PR}/events?per_page=${EVENT_LOG_PAGE_SIZE}&page=1`]);
});

test('an away-and-back retarget is two events, even though the base ends where it started', async () => {
  const log = await readPullRequestEventLog(
    client([event('base_ref_changed', '11:00'), event('base_ref_changed', '11:01')]),
    { pullRequest: PR, sinceMs: SINCE, now: clock() },
  );
  assert.deepEqual(log.events.map((entry) => entry.event), ['base_ref_changed', 'base_ref_changed']);
});

test('the anchor is compared at the server\'s whole-second precision', async () => {
  // GitHub stamps `10:30:00Z` for an event at 10:30:00.900; an anchor of 10:30:00.500 must not drop it.
  const secondBefore = event('closed', '2026-09-23T10:29:59Z');
  const sameSecond = event('base_ref_changed', '2026-09-23T10:30:00Z');
  const log = await readPullRequestEventLog(
    client([secondBefore, sameSecond]),
    { pullRequest: PR, sinceMs: SINCE + 500, now: clock() },
  );
  assert.deepEqual(log.events.map((entry) => entry.eventId), [sameSecond.id]);
});

test('every lifecycle event type is reported; an undated one is kept, never dropped', async () => {
  const events = PULL_REQUEST_LIFECYCLE_EVENTS.map((name) => event(name, '11:00'));
  events.push({ id: nextId++, event: 'reopened', actor: { login: 'JagPat' } });
  const log = await readPullRequestEventLog(client(events), { pullRequest: PR, sinceMs: SINCE, now: clock() });
  assert.deepEqual(log.events.map((entry) => entry.event), [...PULL_REQUEST_LIFECYCLE_EVENTS, 'reopened']);
  assert.equal(log.events.at(-1).atMs, null);
});

test('the log is read to its end across pages; one longer than the page cap is uncovered', async () => {
  const early = filler(2 * EVENT_LOG_PAGE_SIZE);
  const late = event('base_ref_changed', '11:00');
  const fake = client([...early, late]);
  const log = await readPullRequestEventLog(fake, { pullRequest: PR, sinceMs: SINCE, now: clock() });
  assert.equal(log.covered, true);
  assert.deepEqual(log.events.map((entry) => entry.eventId), [late.id]);
  assert.equal(fake.calls.length, 3);
  const endless = await readPullRequestEventLog(
    client(filler(EVENT_LOG_MAX_PAGES * EVENT_LOG_PAGE_SIZE)),
    { pullRequest: PR, sinceMs: SINCE, now: clock() },
  );
  assert.deepEqual([endless.covered, endless.events, endless.coveredFromMs, endless.readAtMs], [false, null, null, null]);
  assert.ok(endless.problems[0].includes('uncovered'));
});

test('an event appended mid-read is not lost: the list only grows at its end', async () => {
  // Barrier: a retarget is appended right after the first page is read; the full first page is unchanged,
  // so the retarget lands on the next page and is read.
  const first = filler(EVENT_LOG_PAGE_SIZE);
  const retarget = event('base_ref_changed', '11:00');
  const log = await readPullRequestEventLog(
    client((read) => (read <= 1 ? first : [...first, retarget])),
    { pullRequest: PR, sinceMs: SINCE, now: clock() },
  );
  assert.equal(log.covered, true);
  assert.deepEqual(log.events.map((entry) => entry.eventId), [retarget.id]);
});

test('ids that do not strictly increase break the append-only property, so the log is uncovered', async () => {
  const a = event('closed', '11:00');
  const b = event('reopened', '11:01');
  for (const events of [[b, a], [a, a], [a, { ...b, id: undefined }], [{ ...a, id: 'x' }]]) {
    const log = await readPullRequestEventLog(client(events), { pullRequest: PR, sinceMs: SINCE, now: clock() });
    assert.deepEqual([log.covered, log.events], [false, null]);
    assert.deepEqual(log.problems, ['events: ids do not strictly increase (uncovered)']);
  }
});

test('a read failure, a non-list page or invalid input is contained as uncovered with a diagnostic', async () => {
  const failing = { repository: REPO, async request() { throw new Error('boom'); } };
  const failed = await readPullRequestEventLog(failing, { pullRequest: PR, sinceMs: SINCE });
  assert.deepEqual([failed.covered, failed.events], [false, null]);
  assert.deepEqual(failed.problems, ['events page 1: boom']);
  const odd = await readPullRequestEventLog({ repository: REPO, async request() { return { message: 'x' }; } }, { pullRequest: PR, sinceMs: SINCE });
  assert.deepEqual(odd.problems, ['events page 1: not a list']);
  for (const input of [{ pullRequest: 0, sinceMs: SINCE }, { pullRequest: PR }, { pullRequest: PR, sinceMs: Number.NaN }]) {
    const invalid = await readPullRequestEventLog(client([]), input);
    assert.deepEqual([invalid.covered, invalid.problems], [false, ['invalid event-log input']]);
  }
  assert.deepEqual((await readPullRequestEventLog(null, { pullRequest: PR, sinceMs: SINCE })).problems, ['invalid event-log input']);
});
