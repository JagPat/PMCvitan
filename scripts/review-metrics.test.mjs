import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, classify, collect, render, weekBounds } from './review-metrics.mjs';

const CODEX = { login: 'chatgpt-codex-connector[bot]' };
const at = (day, hour = 0) => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
const comment = (id, head, created_at, body = 'the audit row is written with no event') => ({ id, user: CODEX, original_commit_id: head, created_at, body });
const job = (id, start, end) => ({ id, started_at: start, completed_at: end });
const snapshot = (extra = {}) => ({
  week: '2026-09-07', fetchedAt: at(14, 12), repository: 'o/r',
  pulls: [
    { number: 1, state: 'closed', merged_at: at(9, 12), created_at: at(1) },
    { number: 2, state: 'closed', merged_at: at(14), created_at: at(2) }, // end boundary: excluded
    { number: 3, state: 'closed', merged_at: at(7), created_at: at(3) }, // start boundary: included
    { number: 4, state: 'open', created_at: at(4) },
    { number: 5, state: 'open', created_at: at(15) }, // opened after the week: not its backlog
  ],
  comments: { 1: [comment(10, 'aaa', at(8, 12)), comment(10, 'aaa', at(8, 12)), comment(11, 'aaa', at(8, 13), 'a wrong actorId is claimed'), comment(12, 'bbb', at(9), 'something novel')], 3: [] },
  reviews: { 1: [{ user: CODEX, commit_id: 'aaa' }, { user: CODEX, commit_id: 'aaa' }, { user: CODEX, commit_id: 'ccc' }], 3: [] },
  reactions: { 1: [], 3: [{ user: CODEX, content: '+1' }] },
  jobs: { 1: [job(1, at(8, 12), at(8, 13)), job(1, at(8, 12), at(8, 13)), job(2, at(8, 14), at(8, 15))], 3: [] },
  ...extra,
});

test('week bounds are UTC and end-exclusive; the merged cohort respects both boundaries and open PRs are backlog', () => {
  assert.deepEqual(weekBounds('2026-09-07'), { start: '2026-09-07T00:00:00.000Z', end: '2026-09-14T00:00:00.000Z' });
  assert.throws(() => weekBounds('next monday'), /YYYY-MM-DD/u);
  const report = aggregate(snapshot());
  assert.deepEqual(report.pulls.map((p) => p.number), [1, 3]);
  assert.deepEqual(report.backlog, [{ number: 4, ageDays: 10 }]);
});

test('duplicate comments count once, identical-head reviews are one reviewed head, rounds attribute to original heads, and job attempts count once each', () => {
  const [one] = aggregate(snapshot()).pulls;
  assert.equal(one.findings, 3);
  assert.equal(one.findingHeads, 2);
  assert.equal(one.reviewedHeads, 3);
  assert.equal(one.firstFindingToMergeHours, 24);
  assert.equal(one.ciHours, 2);
});

test('clean-only evidence is reported as missing evidence, zero merges divide nothing, and missing job data is counted', () => {
  const report = aggregate(snapshot());
  assert.equal(report.missingEvidence, 1);
  assert.equal(report.medianFirstFindingToMergeHours, 24);
  assert.equal(report.ciHoursPerMerge, 1);
  assert.equal(aggregate(snapshot({ jobs: { 1: undefined, 3: [] } })).jobsMissing, 1);
  const empty = aggregate(snapshot({ pulls: [{ number: 4, state: 'open', created_at: at(4) }] }));
  assert.equal(empty.merges, 0);
  assert.equal(empty.ciHoursPerMerge, null);
  assert.equal(empty.medianFirstFindingToMergeHours, null);
  assert.match(render(empty), /Merges in cohort \| 0 \|/u);
});

test('findings classify by explicit family with traceable ids and unknown text stays unclassified', () => {
  assert.equal(classify('the audit row is written with no event'), 'missing-counterpart');
  assert.equal(classify('a wrong actorId is claimed'), 'identity-recipient-actor');
  assert.equal(classify('btrim strips spaces only'), 'whitespace-input');
  assert.equal(classify('something novel'), 'unclassified');
  const { families } = aggregate(snapshot());
  assert.deepEqual(families['missing-counterpart'], [10]);
  assert.deepEqual(families.unclassified, [12]);
  assert.match(render(aggregate(snapshot())), /\*\*unclassified\*\*: 1 — 12/u);
  assert.match(render(aggregate(snapshot())), /Comparison note/u);
});

test('collection fails visibly on a rate limit or an incomplete page instead of writing a partial snapshot', async () => {
  const limited = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(collect({ week: '2026-09-07', repository: 'o/r', token: 't', fetchImpl: limited }), /HTTP 403 .*rate limited/u);
  const malformed = async () => ({ ok: true, status: 200, json: async () => ({ nope: true }) });
  await assert.rejects(collect({ week: '2026-09-07', repository: 'o/r', token: 't', fetchImpl: malformed }), /unexpected payload/u);
  const calls = [];
  const paged = async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => (url.includes('/pulls?') && url.endsWith('page=1') ? [{ number: 9, state: 'open', updated_at: at(10), created_at: at(1) }] : []) }; };
  // a full first page whose LAST item predates the week stops the listing without a second page
  const result = await collect({ week: '2026-09-07', repository: 'o/r', token: 't', fetchImpl: paged });
  assert.equal(result.pulls.length, 1);
  assert.ok(calls.every((url) => url.includes('per_page=100')));
  assert.deepEqual(result.jobs, {}, 'an open PR fetches no job data');
  const full = Array.from({ length: 100 }, (_, i) => ({ number: 100 - i, state: 'closed', updated_at: i < 99 ? at(10) : at(1), created_at: at(1) }));
  const pages = [];
  const early = async (url) => { pages.push(url); return { ok: true, status: 200, json: async () => (url.includes('/pulls?') ? full : []) }; };
  await collect({ week: '2026-09-07', repository: 'o/r', token: 't', fetchImpl: early });
  assert.equal(pages.filter((url) => url.includes('/pulls?')).length, 1);
});
