import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { REQUIRED_CHECKS, completeReviewedPullRequest } from './autonomous-review-gate.mjs';
import { codexRecordFingerprint } from './autonomous-review-state.mjs';
import { securityVerdictMarker } from './security-verdict-marker.mjs';
import { CODEX_RUN_HELD_DETAIL, CODEX_SECURITY_FINDINGS_DETAIL, CODEX_AUTOMERGE_REARM_FAILED } from './review-policy.mjs';

/**
 * 2A3b-2 B (notes/gate-codex-silent/2a3b/split-plan.md; replaces #1318's arm-tail half) — after the gate's own arm, the
 * Codex review-state records are read once more: a run or security findings on the head, or a `dirty` set changed
 * since the authorization's read, disarms the queued merge and takes the authorization's own refusal.
 */
const HEAD = 'e'.repeat(40);
const OLD = 'd'.repeat(40);
const repo = { full_name: 'JagPat/PMCvitan' };
const queued = { enabled_at: '2026-11-02T00:00:00Z', merge_method: 'squash', enabled_by: { login: 'github-actions[bot]' } };
const codexRecord = (head, status, login = 'chatgpt-codex-connector[bot]') => ({
  id: 77, user: { login }, updated_at: '2026-11-02T21:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: head, has_any_findings: null, has_unresolved_findings: null, status },
    security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
  })} -->`,
});
// Codex's record of a code review completed clean on `head`, the security review idle
const cleanRecord = (head) => ({
  id: 77, user: { login: 'chatgpt-codex-connector[bot]' }, updated_at: '2026-11-02T21:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: head, has_any_findings: false, has_unresolved_findings: false, status: 'completed' },
    security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
  })} -->`,
});
// Codex's record of a code review completed on `head` with unresolved findings (`dirty`)
const dirtyRecord = (head) => ({
  id: 77, user: { login: 'chatgpt-codex-connector[bot]' }, updated_at: '2026-11-02T21:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: head, has_any_findings: true, has_unresolved_findings: true, status: 'completed' },
    security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
  })} -->`,
});
// Codex's record with code_review idle and security_review running on `head` (gap-check P10)
const securityRecord = (head, status) => ({
  id: 78, user: { login: 'chatgpt-codex-connector[bot]' }, updated_at: '2026-11-02T21:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
    security_review: { commit_sha: head, has_any_findings: null, has_unresolved_findings: null, status },
  })} -->`,
});
const written = (log) => log.filter(([k, , , context]) => k === 'status' && context === 'codex-current-head').map(([, state, description]) => [state, description]);

const PR = 900;
const armTailPull = (extra = {}) => ({
  number: PR, node_id: 'PR_900', state: 'open', draft: false, auto_merge: null,
  head: { sha: HEAD, ref: 'claude/g3', repo }, base: { ref: 'main', sha: 'c'.repeat(40), repo },
  html_url: 'https://example.invalid/pr/900', ...extra,
});
const greenChecks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
const eligible = { outcome: 'eligible', mergeEligible: true, owner: 'claude' };
function armTailClient(afterArm, atAuthorization = () => []) {
  const log = [];
  let armedNow = false;
  let reads = 0;
  const client = {
    log,
    repository: 'JagPat/PMCvitan',
    async pullRequest() { log.push(['read']); return armTailPull(armedNow ? { auto_merge: queued } : {}); },
    async openPullRequestsAt() { return []; },
    async disableAutoMerge(pull) { log.push(['disable', pull.number]); armedNow = false; },
    async statuses() { return [{ id: 600, context: 'codex-current-head', state: 'success', description: 'review: clean [wi:none]' }]; },
    async checkRuns() { return greenChecks; },
    async commit() { return { commit: { message: 'fix: x\n\nCorrection-Owner: claude\n' } }; },
    // the authorization's read sees `atAuthorization` (nothing, by default); the read after the arm sees `afterArm`
    async issueComments() { reads += 1; log.push(['comments', reads]); return reads === 1 ? atAuthorization() : afterArm(); },
    async mergeExactHead() { return { merged: false, message: 'Pull request is not mergeable yet' }; },
    async enableAutoMerge(pull, head) { log.push(['arm', pull.number, head]); armedNow = true; },
    async dispatchHandoff() { log.push(['handoff']); },
    async setStatus(sha, state, description, url, context = 'codex-current-head') { log.push(['status', state, description, context]); return { id: 1 }; },
    async setDraft(pull, draft) { log.push(['draft', pull.number, draft]); if (draft) armedNow = false; return { ...pull, draft }; },
    async updateStickyComment(number, body) { log.push(['sticky', number, body]); },
    async createIssueComment(number, body) { log.push(['marker', number, body]); return { id: 901 }; },
    // the finding path's convergence read: no inline review evidence
    async reviews() { return []; },
    async reviewComments() { return []; },
  };
  return client;
}

test('2A3b-2 B — a Codex run found after the arm disarms and takes the held refusal; idle keeps the arm; an unreadable re-read fails closed', { timeout: 30_000 }, async () => {
  const running = armTailClient(() => [codexRecord(HEAD, 'in_progress')]);
  assert.equal(await completeReviewedPullRequest(running, armTailPull(), HEAD, eligible), 'review_refused');
  const kinds = running.log.map(([k]) => k);
  assert.ok(kinds.indexOf('arm') < kinds.lastIndexOf('comments') && kinds.lastIndexOf('comments') < kinds.indexOf('disable'), kinds.join(','));
  assert.deepEqual(written(running.log), [['failure', `review: ${CODEX_RUN_HELD_DETAIL}`]], 'the retryable hold the recovery re-judges');
  assert.equal(kinds.includes('handoff'), false);

  const securityRunning = armTailClient(() => [securityRecord(HEAD, 'queued')]);
  assert.equal(await completeReviewedPullRequest(securityRunning, armTailPull(), HEAD, eligible), 'review_refused');
  assert.ok(securityRunning.log.some(([k]) => k === 'disable'));

  for (const [name, after] of [['idle', () => []], ['completed clean', () => [cleanRecord(HEAD)]], ['another head', () => [codexRecord(OLD, 'in_progress')]]]) {
    const idle = armTailClient(after);
    assert.equal(await completeReviewedPullRequest(idle, armTailPull(), HEAD, eligible), 'queued', name);
    assert.equal(idle.log.some(([k]) => k === 'disable' || k === 'status'), false, `${name}: the arm stays`);
    assert.ok(idle.log.some(([k]) => k === 'handoff'));
  }

  const unreadable = armTailClient(() => { throw new Error('GitHub GET comments failed (502): Bad Gateway'); });
  await assert.rejects(completeReviewedPullRequest(unreadable, armTailPull(), HEAD, eligible), /502/u);
  assert.deepEqual(written(unreadable.log), [['failure', `review: ${CODEX_AUTOMERGE_REARM_FAILED}`]], 'the tail\'s retryable hold');
  assert.ok(unreadable.log.some(([k, n, draft]) => k === 'draft' && draft === true), 'drafted, which drops the queued merge');
});

// Fold check of 190a20b4 (1) — security findings completed on the head after the arm: the refusal routes them for
// correction (the durable marker, then CODEX_SECURITY_FINDINGS_DETAIL), never the retryable run-held state
test('2A3b-2 B — security findings found after the arm disarm before any status and go through the finding path, not the hold', { timeout: 30_000 }, async () => {
  const findings = {
    id: 79, user: { login: 'chatgpt-codex-connector[bot]' }, updated_at: '2026-11-02T21:00:00Z',
    body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
      code_review: { commit_sha: HEAD, has_any_findings: false, has_unresolved_findings: false, status: 'completed' },
      security_review: { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: 'completed' },
    })} -->`,
  };
  const client = armTailClient(() => [findings]);
  assert.equal(await completeReviewedPullRequest(client, armTailPull(), HEAD, eligible), 'review_refused');
  const kinds = client.log.map(([k]) => k);
  assert.ok(kinds.indexOf('arm') >= 0 && kinds.indexOf('disable') > kinds.indexOf('arm'), kinds.join(','));
  assert.ok(kinds.indexOf('status') > kinds.indexOf('disable'), 'the disable comes before any status');
  assert.deepEqual(client.log.filter(([k]) => k === 'marker'), [['marker', PR, securityVerdictMarker(HEAD)]], 'the durable security marker');
  assert.ok(kinds.indexOf('marker') < kinds.lastIndexOf('status'), 'the marker precedes the verdict');
  assert.deepEqual(written(client.log).filter(([state]) => state === 'failure'), [['failure', `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`]]);
  assert.equal(client.log.some(([k, , description]) => k === 'status' && String(description).includes(CODEX_RUN_HELD_DETAIL)), false, 'never the run-held state');
  assert.equal(kinds.includes('handoff'), false);
});

// #1318 Codex 4448897188 — a review that started after the authorization's read and completed with findings before the
// re-read leaves the record dirty, which no event disarms: refused as changed evidence (retryable, re-judged). A dirty
// record the authorization already saw (the evidence judged it; a cap-deferred head merges on it) keeps the arm
test('2A3b-2 B (#1318 Codex 4448897188) — a record that turned dirty since the authorization disarms and is re-judged; one it already saw keeps the arm', { timeout: 30_000 }, async () => {
  const changed = armTailClient(() => [dirtyRecord(HEAD)]);
  assert.equal(await completeReviewedPullRequest(changed, armTailPull(), HEAD, eligible), 'review_refused');
  const kinds = changed.log.map(([k]) => k);
  assert.ok(kinds.indexOf('arm') < kinds.indexOf('disable') && kinds.indexOf('disable') < kinds.indexOf('status'), kinds.join(','));
  assert.deepEqual(written(changed.log), [['failure', 'review: Codex evidence changed during final verification']], 'the retryable changed-evidence hold');
  assert.equal(kinds.includes('handoff'), false);

  for (const [name, before, after] of [
    ['clean, then a new dirty record', () => [cleanRecord(HEAD)], () => [dirtyRecord(HEAD)]],
    // Stage 1's re-check of 5c0102ba — a second review ending dirty with an identical body: only its update time moves
    ['dirty, then another review completed dirty, same body', () => [dirtyRecord(HEAD)], () => [{ ...dirtyRecord(HEAD), updated_at: '2026-11-02T22:00:00Z' }]],
    // #1320 Codex 4450011604 — a record about another head that comes to name this head, dirty, is new evidence
    ['another head\'s record, then the same record dirty on this head', () => [dirtyRecord(HEAD), { ...codexRecord(OLD, 'completed'), id: 80 }],
      () => [dirtyRecord(HEAD), { ...dirtyRecord(HEAD), id: 80, updated_at: '2026-11-02T22:00:00Z' }]],
  ]) {
    const moved = armTailClient(after, before);
    assert.equal(await completeReviewedPullRequest(moved, armTailPull(), HEAD, eligible), 'review_refused', name);
  }

  const seen = armTailClient(() => [dirtyRecord(HEAD)], () => [dirtyRecord(HEAD)]);
  assert.equal(await completeReviewedPullRequest(seen, armTailPull(), HEAD, eligible), 'queued');
  assert.equal(seen.log.some(([k]) => k === 'disable' || k === 'status'), false, 'the record the authorization judged keeps the arm');
  assert.ok(seen.log.some(([k]) => k === 'handoff'));

  // #1320 Codex 4450011604 — the dirty record the authorization admitted is unchanged; only a record about another head
  // moved (a late edit, or a new one): not evidence for this head, so the arm stays
  for (const [name, after] of [
    ['an old-head run completed late', () => [dirtyRecord(HEAD), { ...codexRecord(OLD, 'completed'), id: 80, updated_at: '2026-11-02T22:00:00Z' }]],
    ['a new old-head record', () => [dirtyRecord(HEAD), { ...codexRecord(OLD, 'in_progress'), id: 80 }, { ...securityRecord(OLD, 'completed'), id: 81 }]],
  ]) {
    const late = armTailClient(after, () => [dirtyRecord(HEAD), { ...codexRecord(OLD, 'in_progress'), id: 80 }]);
    assert.equal(await completeReviewedPullRequest(late, armTailPull(), HEAD, eligible), 'queued', name);
    assert.equal(late.log.some(([k]) => k === 'disable' || k === 'status'), false, name);
  }
});

test('2A3b-2 B — structural: the record re-read follows the one arm, inside the guarded tail', async () => {
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const tail = gate.slice(gate.indexOf('async function mergeOrArmAuthorizedHead('), gate.indexOf('export class AutoMergeDisarmFailed'));
  const arm = tail.indexOf('await client.enableAutoMerge(pullRequest, expectedHead);');
  const reread = tail.indexOf('const comments = await client.issueComments(pullRequest.number);');
  const queuedReturn = tail.indexOf("return { outcome: 'queued', pullRequest };");
  assert.ok(arm > 0 && reread > arm && queuedReturn > reread, 'arm, then the re-read, then the queued outcome');
  const judged = tail.slice(reread, queuedReturn);
  assert.match(judged, /codexStateRecordVerdict\(comments, expectedHead, 0\)/u);
  assert.match(judged, /after === 'dirty' && codexRecordFingerprint\(comments, expectedHead\) !== authorization\.recordFingerprint/u);
  assert.match(judged, /await disarmQueuedAutoMerge\(client, pullRequest\.number, expectedHead\);\s*await refuseReviewedGreen\(/u);
});

test('2A3b-2 B (#1318 Codex 4448897188) — the record fingerprint: Codex\'s records naming the head only, by id, update time and body, sorted', () => {
  const a = codexRecord(HEAD, 'in_progress');
  const b = { ...securityRecord(HEAD, 'completed'), id: 12 };
  const note = { id: 5, user: { login: 'someone' }, body: 'note' };
  const fp = (comments) => codexRecordFingerprint(comments, HEAD);
  assert.equal(fp([a, b, note]), fp([note, b, a]), 'order and other comments do not count');
  assert.notEqual(fp([a]), fp([codexRecord(HEAD, 'completed')]), 'an edited record changes it');
  assert.notEqual(fp([a]), fp([{ ...a, updated_at: '2026-11-02T22:00:00Z' }]), 'a record edited again with the same body changes it');
  assert.equal(fp([codexRecord(HEAD, 'in_progress', 'someone')]), '', 'another login carrying the marker');
  assert.equal(fp([{ ...note, user: { login: 'chatgpt-codex-connector[bot]' } }]), '', 'Codex without the marker');
  assert.equal(fp(null), '');
  // #1320 Codex 4450011604 — a record naming only another head, or one whose JSON does not parse, is not this head's
  const other = { ...codexRecord(OLD, 'in_progress'), id: 80 };
  assert.equal(fp([a, other]), fp([a, { ...other, updated_at: '2026-11-02T22:00:00Z', body: codexRecord(OLD, 'completed').body }]), 'another head\'s record does not count');
  assert.equal(fp([other]), '');
  assert.equal(fp([{ ...a, body: '<!-- codex-review-state:v1 {not json -->' }]), '', 'an unparseable record');
  assert.notEqual(fp([a, b]), fp([a, { ...b, body: securityRecord(OLD, 'completed').body }]), 'a record that stops naming the head changes it');
  assert.notEqual(fp([b]), fp([{ ...b, body: securityRecord(null, null).body }]), 'the security section naming the head counts');
});

// Stage 1's split check (B-M2, B-M3) — the arm tail's refusal carries the adopted recovery request and the attempt: the
// request is settled, and the refusal's own sticky shows the attempt
test('2A3b-2 B — the arm-tail refusal settles the adopted recovery request and carries the attempt', { timeout: 30_000 }, async () => {
  const recoveryRequest = { status: { id: 7002, context: 'codex-recovery-request/6101', state: 'pending', description: 'recovery: requested terminal status 6101' } };
  const findings = {
    id: 79, user: { login: 'chatgpt-codex-connector[bot]' }, updated_at: '2026-11-02T21:00:00Z',
    body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
      code_review: { commit_sha: HEAD, has_any_findings: false, has_unresolved_findings: false, status: 'completed' },
      security_review: { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: 'completed' },
    })} -->`,
  };
  for (const [name, after, before, retry] of [
    ['a run after the arm', () => [codexRecord(HEAD, 'in_progress')], () => [], true],
    ['a record turned dirty since the authorization', () => [dirtyRecord(HEAD)], () => [cleanRecord(HEAD)], true],
    ['security findings after the arm', () => [findings], () => [], false],
  ]) {
    const client = armTailClient(after, before);
    assert.equal(await completeReviewedPullRequest(client, armTailPull(), HEAD, eligible, { recoveryRequest, attempt: 2 }), 'review_refused', name);
    assert.ok(client.log.some(([k, state, description, context]) => k === 'status' && state === 'success' && context === 'codex-recovery-request/6101' && /^recovery: consumed by /u.test(description)),
      `${name}: the adopted recovery request is settled`);
    // the refusal's own sticky is the last one written (the green's sticky before the arm carries the attempt too)
    const last = String(client.log.filter(([k]) => k === 'sticky').at(-1)?.[2] ?? '');
    if (retry) assert.match(last, /review_retry/u, `${name}: the refusal's sticky is the last`);
    assert.match(last, /\*\*Codex attempt:\*\* 2\//u, `${name}: the refusal's sticky carries the attempt`);
  }
});
