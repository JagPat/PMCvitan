import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DRAIN_DIRECTIVE,
  DRAIN_DIRECTIVE_SET_AT,
  DRAIN_EVIDENCE_DOCUMENT,
  DRAIN_MINIMUM_RELEASE,
  assessCommittedDirectiveClearance,
  assessDirectiveClearance,
  evidenceFreshAtHead,
  fileSystemReader,
  githubCommitReader,
  githubContentsReader,
  headCommitFromGitHub,
  nowBlockDuplicateKeys,
  parseDrainEvidence,
  rederiveDrainVerdict,
  statusPatchRemovesDirective,
} from './autonomous-drain-clearance.mjs';
import { parseStatusNow } from './autonomous-status-state.mjs';
import { run } from './review-scope.mjs';

// PR #686, Codex finding 4157323191: with the human attestation withdrawn, nothing trusted read
// `rollout:drain-evidence`, so a STATUS-only PR could have cleared `phase-6-4d-previous-release-drained`
// and unlocked 4d-iii without a fresh `drained` verdict. These pin the gate that closes that, and the
// round-2 findings on it: the base and head VALUES decide and a repeated Now key is refused (4163577340),
// the record must be committed in the clearance PR itself (4163577348), and the controller re-runs the
// rule from the trusted branch (4163577352, pinned in autonomous-review-workflow.test.mjs).

const JUDGED_AT = Date.parse('2026-10-02T12:00:00.000Z');
const NOW = (over = {}) => ({
  phase: '6', phase_plan: 'docs/superpowers/plans/2026-09-07-decision-workflow-4d.md', task: '4',
  task_state: 'in_progress', work_item: 'none', reviewed_merge: '4707c5d', open_pr: 'none',
  next_task: 'phase-6-task-4d-iii', blocking_directive: 'none', updated: '2026-10-02', ...over,
});
const STANDING = () => NOW({ task_state: 'correction_required', blocking_directive: DRAIN_DIRECTIVE, updated: '2026-10-01' });
const STATUS_DOC = (now, extraLines = []) => `# STATUS\n\n## Now\n\n\`\`\`yaml\n${[...Object.entries(now).map(([k, v]) => `${k}: ${v}`), ...extraLines].join('\n')}\n\`\`\`\n\n### Now — x\n\ntext\n\n## Maintenance queue\n\nnone\n`;

// The STATUS diff of a PR that flips the directive to none, as GitHub's files listing carries it.
const CLEARING_PATCH = [
  '@@ -17,7 +17,7 @@ reviewed_merge: 4707c5d',
  ' open_pr: none',
  ' next_task: phase-6-task-4d-iii',
  '-blocking_directive: phase-6-4d-previous-release-drained',
  '+blocking_directive: none',
  ' updated: 2026-10-01',
].join('\n');
const UNRELATED_PATCH = '@@ -40,3 +40,4 @@\n text\n+more text\n';
// The duplicate-key encoding: nothing removed, two lines appended.
const APPENDING_PATCH = '@@ -19,3 +19,5 @@\n blocking_directive: phase-6-4d-previous-release-drained\n updated: 2026-10-01\n+task_state: merged\n+blocking_directive: none\n';

const EVIDENCE = (over = {}) => JSON.stringify({
  marker: 'DRAIN-EVIDENCE',
  directive: DRAIN_DIRECTIVE,
  minimumRelease: DRAIN_MINIMUM_RELEASE,
  minimumCatalogVersion: { value: 3, source: 'the persisted catalog maximum' },
  generation: { compiled: 3, persistedMinimum: { minimumGeneration: 3, raisedBy: 'a8b', raisedAt: '2026-09-29T00:00:00.000Z' } },
  platform: { available: true, source: 'coolify', application: { uuid: 'app', name: 'pmc-api', status: 'running:healthy', gitCommitSha: DRAIN_MINIMUM_RELEASE, classification: 'at-or-after' }, deploymentsInProgress: [] },
  leases: [{ instanceId: 'i-1', catalogVersion: 3, release: DRAIN_MINIMUM_RELEASE, classification: 'at-or-after' }],
  findings: [],
  verdict: 'drained',
  recordedAt: '2026-10-02T09:00:00.000Z',
  ...over,
});

// The exact head commit as the readers see it: it changes STATUS and the record, committed after the record.
const HEAD_SHA = 'a1'.repeat(20);
const HEAD_COMMIT = (over = {}) => ({ sha: HEAD_SHA, files: ['docs/STATUS.md', DRAIN_EVIDENCE_DOCUMENT], committedAt: '2026-10-02T09:30:00.000Z', ...over });

// A clearance as the readers see it: base carries the directive, head does not, the record regenerated here.
const CLEARANCE = (over = {}) => assessDirectiveClearance({
  baseNow: STANDING(), headNow: NOW(), statusPatch: CLEARING_PATCH, evidenceText: EVIDENCE(), evidenceChanged: true, headCommit: HEAD_COMMIT(), now: JUDGED_AT, ...over,
});

test('the STATUS diff is read for the removed directive line, and only that line', () => {
  assert.equal(statusPatchRemovesDirective(CLEARING_PATCH), true);
  assert.equal(statusPatchRemovesDirective(UNRELATED_PATCH), false);
  assert.equal(statusPatchRemovesDirective(APPENDING_PATCH), false);
  // a History paragraph that merely MENTIONS the directive is not a removal of the yaml line
  assert.equal(statusPatchRemovesDirective('-text about phase-6-4d-previous-release-drained\n+other'), false);
  // another directive is another gate
  assert.equal(statusPatchRemovesDirective('-blocking_directive: phase-6-4c-previous-release-drained\n+blocking_directive: none'), false);
  // no patch text is UNKNOWN, not "no removal"
  assert.equal(statusPatchRemovesDirective(undefined), null);
});

test('a STATUS-only edit cannot clear the directive: no evidence record, no clearance', () => {
  const verdict = CLEARANCE({ evidenceText: null });
  assert.equal(verdict.applies, true);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.detail, /carries no docs\/rollout\/phase-6-4d-drain-evidence\.json/u);
  assert.match(verdict.detail, /never on a STATUS edit alone/u);
});

test('the base and head VALUES decide, and a Now block that repeats a key is refused (finding 4163577340)', () => {
  // the duplicate-key encoding: the head parses as cleared, the diff removed nothing
  const appended = STATUS_DOC(STANDING(), ['task_state: merged', 'blocking_directive: none']);
  assert.deepEqual(nowBlockDuplicateKeys(appended), ['blocking_directive', 'task_state']);
  assert.equal(parseStatusNow(appended).blocking_directive, 'none', 'parseStatusNow keeps the last value — the hole this closes');
  const duplicate = assessDirectiveClearance({
    baseNow: STANDING(), headNow: parseStatusNow(appended), duplicateNowKeys: nowBlockDuplicateKeys(appended), statusPatch: APPENDING_PATCH, evidenceText: null, now: JUDGED_AT,
  });
  assert.equal(duplicate.applies, true);
  assert.equal(duplicate.allowed, false);
  assert.match(duplicate.detail, /repeats `blocking_directive`, `task_state`/u);
  // even WITH a committed record: a repeated key is an ambiguous state, not a clearance
  assert.equal(CLEARANCE({ headNow: parseStatusNow(appended), duplicateNowKeys: ['blocking_directive'] }).allowed, false);
  assert.deepEqual(nowBlockDuplicateKeys(STATUS_DOC(STANDING())), []);
  assert.deepEqual(nowBlockDuplicateKeys('no Now block here'), []);

  // base carries, head does not, and the diff text is missing or silent: still a clearance, judged on the record
  const silentDiff = CLEARANCE({ statusPatch: UNRELATED_PATCH, evidenceText: null });
  assert.equal(silentDiff.applies, true);
  assert.equal(silentDiff.allowed, false);
  assert.match(silentDiff.detail, /the base Now block carries .* and this head does not/u);
  assert.equal(CLEARANCE({ statusPatch: undefined }).allowed, true);
  // base does not carry it either: nothing to clear, whatever else STATUS changed
  const idle = assessDirectiveClearance({ baseNow: NOW(), headNow: NOW(), statusPatch: UNRELATED_PATCH, evidenceText: null, now: JUDGED_AT });
  assert.equal(idle.applies, false);
  assert.equal(idle.allowed, true);
  // an unreadable base fails closed: the record is required (and suffices)
  const unknownBase = assessDirectiveClearance({ baseNow: undefined, headNow: NOW(), statusPatch: UNRELATED_PATCH, evidenceText: null, now: JUDGED_AT });
  assert.equal(unknownBase.applies, true);
  assert.equal(unknownBase.allowed, false);
  assert.match(unknownBase.detail, /cannot be ruled out/u);
  assert.equal(CLEARANCE({ baseNow: undefined, statusPatch: undefined }).allowed, true);
});

test('the record must be committed in the clearance PR itself (finding 4163577348)', () => {
  // a valid record already in the tree, committed by an earlier PR while the directive stood
  const reused = CLEARANCE({ evidenceChanged: false });
  assert.equal(reused.applies, true);
  assert.equal(reused.allowed, false);
  assert.match(reused.detail, /does not add or change docs\/rollout\/phase-6-4d-drain-evidence\.json/u);
  assert.match(reused.detail, /snapshot of an earlier fleet/u);
  assert.equal(CLEARANCE({ evidenceChanged: undefined }).allowed, false);
  assert.equal(CLEARANCE({ evidenceChanged: true }).allowed, true);
  // freshness: recorded after the directive was set, and not in the future of the judging clock
  const late = HEAD_COMMIT({ committedAt: '2026-10-02T12:05:00.000Z' });
  assert.equal(CLEARANCE({ evidenceText: EVIDENCE({ recordedAt: '2026-10-02T12:04:59.000Z' }), headCommit: late }).allowed, true);
  const future = CLEARANCE({ evidenceText: EVIDENCE({ recordedAt: '2026-10-02T12:06:00.000Z' }), headCommit: HEAD_COMMIT({ committedAt: '2026-10-02T12:07:00.000Z' }) });
  assert.equal(future.allowed, false);
  assert.match(future.detail, /in the future of the judging clock/u);
});

test('the record must be regenerated on the clearing head (finding 4163934196)', () => {
  // a record added on an early head of a long-open PR: still in the cumulative diff, absent from the head commit
  const early = CLEARANCE({ headCommit: HEAD_COMMIT({ files: ['docs/STATUS.md'] }) });
  assert.equal(early.applies, true);
  assert.equal(early.allowed, false);
  assert.match(early.detail, /was not regenerated on the clearing head: commit a1a1a1a does not change it/u);
  assert.match(early.detail, /re-run rollout:drain-evidence/u);
  // a record dated after the commit that carries it is not that commit's observation
  const postdated = CLEARANCE({ evidenceText: EVIDENCE({ recordedAt: '2026-10-02T09:40:00.000Z' }) });
  assert.equal(postdated.allowed, false);
  assert.match(postdated.detail, /after the commit a1a1a1a that carries it/u);
  assert.equal(CLEARANCE({ evidenceText: EVIDENCE({ recordedAt: '2026-10-02T09:34:00.000Z' }) }).allowed, true); // within skew
  // an unreadable head commit fails closed
  const unknown = CLEARANCE({ headCommit: undefined });
  assert.equal(unknown.allowed, false);
  assert.match(unknown.detail, /head commit could not be read/u);
  assert.equal(CLEARANCE({ headCommit: HEAD_COMMIT({ committedAt: undefined }) }).allowed, false);
  // the predicate alone
  assert.deepEqual(evidenceFreshAtHead(JSON.parse(EVIDENCE()), HEAD_COMMIT()), { ok: true });
  assert.equal(evidenceFreshAtHead(JSON.parse(EVIDENCE()), { sha: HEAD_SHA, files: [] }).ok, false);
  assert.equal(evidenceFreshAtHead(JSON.parse(EVIDENCE()), null).ok, false);
  // the GitHub commit shape, with paginated files
  assert.deepEqual(
    headCommitFromGitHub(HEAD_SHA, { sha: HEAD_SHA, commit: { committer: { date: '2026-10-02T09:30:00Z' } }, files: [{ filename: 'docs/STATUS.md' }, { filename: DRAIN_EVIDENCE_DOCUMENT }] }),
    { sha: HEAD_SHA, files: ['docs/STATUS.md', DRAIN_EVIDENCE_DOCUMENT], committedAt: '2026-10-02T09:30:00Z' },
  );
  assert.equal(headCommitFromGitHub(HEAD_SHA, null), undefined);
  assert.equal(headCommitFromGitHub(HEAD_SHA, { sha: HEAD_SHA, commit: {} }).files, undefined);
});

test('only a fresh drained verdict for THIS directive and THIS minimum release clears it', () => {
  const refused = (over, pattern) => {
    const parsed = parseDrainEvidence(EVIDENCE(over), { now: JUDGED_AT });
    assert.equal(parsed.ok, false, JSON.stringify(over));
    assert.match(parsed.reason, pattern, JSON.stringify(over));
    const verdict = CLEARANCE({ evidenceText: EVIDENCE(over) });
    assert.equal(verdict.applies, true);
    assert.equal(verdict.allowed, false, JSON.stringify(over));
  };
  refused({ verdict: 'not-drained', findings: ['live lease i-0 serves at catalog version 2, below the minimum 3'] }, /verdict is "not-drained"/u);
  refused({ verdict: 'unclassified', findings: ['platform inventory unavailable: COOLIFY_TOKEN is not set'] }, /verdict is "unclassified"/u);
  refused({ findings: ['a finding beside a drained verdict is not a drained verdict'] }, /carries no findings/u);
  refused({ directive: 'phase-6-4c-previous-release-drained' }, /names directive/u);
  refused({ minimumRelease: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, /not the directive's minimum/u);
  refused({ minimumRelease: 'f82' }, /not the directive's minimum/u); // too short to be a release
  refused({ recordedAt: '2026-09-30T23:00:00.000Z' }, /before the directive was set/u); // older than #685
  refused({ recordedAt: 'yesterday' }, /not a timestamp/u);
  refused({ platform: { available: false, reason: 'COOLIFY_TOKEN is not set' } }, /without the platform inventory/u);
  refused({ marker: 'ATTESTATION' }, /marker/u);
  // not JSON, not an object, empty
  assert.equal(parseDrainEvidence('{').ok, false);
  assert.equal(parseDrainEvidence('[]').ok, false);
  assert.equal(parseDrainEvidence('').ok, false);
  assert.equal(CLEARANCE({ evidenceText: '{' }).allowed, false);

  // the one shape that clears: drained, no findings, this directive, this minimum (full or abbreviated),
  // the platform read, recorded after the directive was set, committed here
  const full = CLEARANCE();
  assert.equal(full.applies, true);
  assert.equal(full.allowed, true, full.detail);
  assert.match(full.detail, /records a drained verdict .* regenerated in head a1a1a1a/u);
  assert.equal(CLEARANCE({ evidenceText: EVIDENCE({ minimumRelease: 'f8274f4' }) }).allowed, true);
  assert.equal(Date.parse(DRAIN_DIRECTIVE_SET_AT) > Date.parse('2026-10-01T00:00:00Z'), true);
});

test('the stated verdict is never trusted: the gate re-derives it from the record\'s own inventory', () => {
  // the shadow review's example on #686: a real not-drained record with `verdict` and `findings` edited
  const notDrained = EVIDENCE({
    verdict: 'not-drained',
    findings: ['live lease i-0 (release deadbeef) serves at catalog version 2, below the minimum 3'],
    leases: [{ instanceId: 'i-0', catalogVersion: 2, release: 'deadbeef', classification: 'before' }],
  });
  assert.equal(parseDrainEvidence(notDrained, { now: JUDGED_AT }).ok, false);
  const edited = JSON.stringify({ ...JSON.parse(notDrained), verdict: 'drained', findings: [] });
  const parsed = parseDrainEvidence(edited, { now: JUDGED_AT });
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /re-derives to not-drained/u);
  assert.match(parsed.reason, /below the minimum/u);
  assert.equal(CLEARANCE({ evidenceText: edited }).allowed, false);

  // every inventory fact judgeDrain reads is re-read here, by the same rules (parity with the real
  // judgeDrain is pinned in apps/api/src/platform/rollout/drain-evidence.test.ts)
  const rederived = (over) => rederiveDrainVerdict(JSON.parse(EVIDENCE(over)));
  assert.equal(rederived({}).verdict, 'drained');
  assert.equal(rederived({ leases: [{ instanceId: 'i-9', catalogVersion: 3, release: 'old', classification: 'before' }] }).verdict, 'not-drained');
  assert.equal(rederived({ leases: [{ instanceId: 'i-9', catalogVersion: 3, release: 'x', classification: 'unclassifiable' }] }).verdict, 'unclassified');
  // an empty lease register adds no finding, exactly as judgeDrain's lease loop adds none (shadow round 3)
  assert.deepEqual(rederived({ leases: [] }), { verdict: 'drained', findings: [] });
  assert.equal(rederived({ platform: { available: true, source: 'coolify', application: { uuid: 'app', name: 'pmc-api', status: 'running:healthy', gitCommitSha: 'old', classification: 'before' }, deploymentsInProgress: [] } }).verdict, 'not-drained');
  assert.equal(rederived({ platform: { available: true, source: 'coolify', application: { uuid: 'app', name: 'pmc-api', status: 'exited', gitCommitSha: DRAIN_MINIMUM_RELEASE, classification: 'at-or-after' }, deploymentsInProgress: [] } }).verdict, 'unclassified');
  assert.equal(rederived({ platform: { available: true, source: 'coolify', application: { uuid: 'app', name: 'pmc-api', status: 'running:healthy', gitCommitSha: DRAIN_MINIMUM_RELEASE, classification: 'at-or-after' }, deploymentsInProgress: [{ deploymentUuid: 'd1', applicationId: 1, status: 'in_progress', commit: null }] } }).verdict, 'unclassified');
  assert.equal(rederived({ generation: { compiled: 2, persistedMinimum: { minimumGeneration: 3, raisedBy: 'a8b', raisedAt: '2026-09-29T00:00:00.000Z' } } }).verdict, 'unclassified');
  assert.equal(rederived({ generation: { compiled: 3, persistedMinimum: null } }).verdict, 'unclassified');
  assert.equal(rederived({ minimumCatalogVersion: { value: 0, source: 'no persisted catalog row' } }).verdict, 'unclassified');
  // a lease's stated catalog version below the record's own minimum is not-drained even if classified at-or-after
  assert.equal(rederived({ leases: [{ instanceId: 'i-2', catalogVersion: 2, release: DRAIN_MINIMUM_RELEASE, classification: 'at-or-after' }] }).verdict, 'not-drained');
  // each re-derived refusal blocks the clearance
  for (const over of [{ generation: { compiled: 3, persistedMinimum: null } }, { leases: [{ instanceId: 'i-2', catalogVersion: 2, release: DRAIN_MINIMUM_RELEASE, classification: 'at-or-after' }] }]) {
    const verdict = CLEARANCE({ evidenceText: EVIDENCE(over) });
    assert.equal(verdict.allowed, false, JSON.stringify(over));
    assert.match(verdict.detail, /re-derives to/u);
  }
});

test('a PR that leaves the directive standing, or never touched it, is not a clearance', () => {
  // the head still carries the directive: whatever the patch says, nothing is cleared
  const standing = assessDirectiveClearance({ baseNow: STANDING(), headNow: STANDING(), statusPatch: CLEARING_PATCH, evidenceText: null, now: JUDGED_AT });
  assert.equal(standing.applies, false);
  assert.equal(standing.allowed, true);
  // a STATUS edit elsewhere in the file, with the directive already none on both sides
  const unrelated = assessDirectiveClearance({ baseNow: NOW(), headNow: NOW(), statusPatch: UNRELATED_PATCH, evidenceText: null, now: JUDGED_AT });
  assert.equal(unrelated.applies, false);
  assert.equal(unrelated.allowed, true);
});

test('the shared wiring reads the head and base trees through injected readers, and only when the diff touches STATUS', async () => {
  const tree = (files) => async (path) => (path in files ? files[path] : null);
  const failing = (message) => async () => { throw new Error(message); };
  const clearing = STATUS_DOC(NOW());
  const standing = STATUS_DOC(STANDING());
  const STATUS_CHANGE = { filename: 'docs/STATUS.md', status: 'modified', patch: CLEARING_PATCH };
  const RECORD_ADDED = { filename: DRAIN_EVIDENCE_DOCUMENT, status: 'added', patch: '+{...}' };
  const operator = { number: 700, body: '<!-- correction-owner: operator -->' };
  const fresh = () => EVIDENCE({ recordedAt: new Date(Date.now() - 60_000).toISOString() });
  const headCommit = (files = ['docs/STATUS.md', DRAIN_EVIDENCE_DOCUMENT]) => async () => ({ sha: HEAD_SHA, files, committedAt: new Date().toISOString() });

  // untouched STATUS: nothing to assess, nothing read
  assert.equal(await assessCommittedDirectiveClearance(operator, [{ filename: 'apps/api/src/thing.ts' }], { readHead: failing('must not read'), readBase: failing('must not read') }), null);
  assert.equal(await assessCommittedDirectiveClearance(operator, undefined, { readHead: failing('must not read') }), null);

  // the directive standing on the head: not a clearance, and the base is not read
  const stands = await assessCommittedDirectiveClearance(operator, [STATUS_CHANGE], { readHead: tree({ 'docs/STATUS.md': standing }), readBase: failing('must not read') });
  assert.equal(stands.applies, false);

  // STATUS-only clearance with no record in the tree: refused
  const bare = await assessCommittedDirectiveClearance(operator, [STATUS_CHANGE], { readHead: tree({ 'docs/STATUS.md': clearing }), readBase: tree({ 'docs/STATUS.md': standing }) });
  assert.equal(bare.applies, true);
  assert.equal(bare.allowed, false);
  assert.match(bare.detail, /the base Now block carries/u);

  // the duplicate-key encoding, with the real `patch` GitHub would carry: refused
  const appended = await assessCommittedDirectiveClearance(
    operator, [{ filename: 'docs/STATUS.md', status: 'modified', patch: APPENDING_PATCH }],
    { readHead: tree({ 'docs/STATUS.md': STATUS_DOC(STANDING(), ['task_state: merged', 'blocking_directive: none']) }), readBase: tree({ 'docs/STATUS.md': standing }) },
  );
  assert.equal(appended.allowed, false);
  assert.match(appended.detail, /repeats/u);

  // the record regenerated on the clearing head: allowed
  const recorded = await assessCommittedDirectiveClearance(
    operator, [STATUS_CHANGE, RECORD_ADDED],
    { readHead: tree({ 'docs/STATUS.md': clearing, [DRAIN_EVIDENCE_DOCUMENT]: fresh() }), readBase: tree({ 'docs/STATUS.md': standing }), readHeadCommit: headCommit() },
  );
  assert.equal(recorded.allowed, true, recorded.detail);
  // ...the same record added on an EARLIER head of this PR (in the cumulative diff, not in the head commit): refused
  const earlyHead = await assessCommittedDirectiveClearance(
    operator, [STATUS_CHANGE, RECORD_ADDED],
    { readHead: tree({ 'docs/STATUS.md': clearing, [DRAIN_EVIDENCE_DOCUMENT]: fresh() }), readBase: tree({ 'docs/STATUS.md': standing }), readHeadCommit: headCommit(['docs/STATUS.md']) },
  );
  assert.equal(earlyHead.allowed, false);
  assert.match(earlyHead.detail, /not regenerated on the clearing head/u);
  // ...an unreadable head commit fails closed; a wiring without a commit reader does too
  const commitDown = await assessCommittedDirectiveClearance(
    operator, [STATUS_CHANGE, RECORD_ADDED],
    { readHead: tree({ 'docs/STATUS.md': clearing, [DRAIN_EVIDENCE_DOCUMENT]: fresh() }), readBase: tree({ 'docs/STATUS.md': standing }), readHeadCommit: failing('HTTP 502') },
  );
  assert.equal(commitDown.allowed, false);
  assert.match(commitDown.detail, /head commit could not be read/u);
  const noReader = await assessCommittedDirectiveClearance(
    operator, [STATUS_CHANGE, RECORD_ADDED],
    { readHead: tree({ 'docs/STATUS.md': clearing, [DRAIN_EVIDENCE_DOCUMENT]: fresh() }), readBase: tree({ 'docs/STATUS.md': standing }) },
  );
  assert.equal(noReader.allowed, false);
  // the record in the tree but NOT in this PR's files: refused (finding 4163577348), and the head commit is not read for it
  const reused = await assessCommittedDirectiveClearance(
    operator, [STATUS_CHANGE],
    { readHead: tree({ 'docs/STATUS.md': clearing, [DRAIN_EVIDENCE_DOCUMENT]: fresh() }), readBase: tree({ 'docs/STATUS.md': standing }), readHeadCommit: failing('must not read') },
  );
  assert.equal(reused.allowed, false);
  assert.match(reused.detail, /does not add or change/u);
  // ...nor a PR that REMOVES the record
  const removing = await assessCommittedDirectiveClearance(
    operator, [STATUS_CHANGE, { filename: DRAIN_EVIDENCE_DOCUMENT, status: 'removed' }],
    { readHead: tree({ 'docs/STATUS.md': clearing }), readBase: tree({ 'docs/STATUS.md': standing }) },
  );
  assert.equal(removing.allowed, false);

  // a stale record (recorded before the directive was set) does not clear
  const stale = await assessCommittedDirectiveClearance(
    operator, [STATUS_CHANGE, RECORD_ADDED],
    { readHead: tree({ 'docs/STATUS.md': clearing, [DRAIN_EVIDENCE_DOCUMENT]: EVIDENCE({ recordedAt: '2026-09-29T00:00:00.000Z' }) }), readBase: tree({ 'docs/STATUS.md': standing }) },
  );
  assert.equal(stale.allowed, false);

  // an unreadable base fails closed without a record, and the committed record still suffices
  const baseDown = await assessCommittedDirectiveClearance(operator, [STATUS_CHANGE], { readHead: tree({ 'docs/STATUS.md': clearing }), readBase: failing('HTTP 502') });
  assert.equal(baseDown.allowed, false);
  assert.match(baseDown.detail, /removes .* from the Now block/u);
  const baseDownRecorded = await assessCommittedDirectiveClearance(
    operator, [STATUS_CHANGE, RECORD_ADDED],
    { readHead: tree({ 'docs/STATUS.md': clearing, [DRAIN_EVIDENCE_DOCUMENT]: fresh() }), readBase: failing('HTTP 502'), readHeadCommit: headCommit() },
  );
  assert.equal(baseDownRecorded.allowed, true, baseDownRecorded.detail);

  // an unreadable, removed or renamed STATUS when the diff says it changed: refused, not skipped
  const unreadable = await assessCommittedDirectiveClearance(operator, [STATUS_CHANGE], { readHead: failing('EACCES') });
  assert.equal(unreadable.allowed, false);
  assert.match(unreadable.detail, /could not be read/u);
  const renamed = await assessCommittedDirectiveClearance(operator, [{ filename: 'docs/STATE.md', previous_filename: 'docs/STATUS.md' }], { readHead: tree({}) });
  assert.equal(renamed.allowed, false);
  assert.match(renamed.detail, /removed or renamed/u);

  // a record that exists but cannot be read is a refusal too
  const broken = await assessCommittedDirectiveClearance(operator, [STATUS_CHANGE, RECORD_ADDED], {
    readHead: async (path) => { if (path === 'docs/STATUS.md') return clearing; throw new Error('EACCES'); },
    readBase: tree({ 'docs/STATUS.md': standing }),
  });
  assert.equal(broken.allowed, false);
  assert.match(broken.detail, /could not be read/u);
});

test('the two readers: the checkout beside this module, and one exact ref through the contents API', async () => {
  const fs = fileSystemReader(async (url) => {
    if (String(url).endsWith('docs/STATUS.md')) return 'status';
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  assert.equal(await fs('docs/STATUS.md'), 'status');
  assert.equal(await fs(DRAIN_EVIDENCE_DOCUMENT), null);
  await assert.rejects(fileSystemReader(async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); })('docs/STATUS.md'), /EACCES/u);

  const requests = [];
  const ref = '4'.repeat(40);
  const api = githubContentsReader({
    repository: 'JagPat/PMCvitan', token: 't', ref,
    fetchImpl: async (url, init) => {
      requests.push([String(url), init.headers.accept]);
      if (String(url).includes(DRAIN_EVIDENCE_DOCUMENT)) return new Response('missing', { status: 404 });
      if (String(url).includes('docs/STATUS.md')) return new Response('# STATUS', { status: 200 });
      return new Response('boom', { status: 503 });
    },
  });
  assert.equal(await api('docs/STATUS.md'), '# STATUS');
  assert.equal(await api(DRAIN_EVIDENCE_DOCUMENT), null);
  await assert.rejects(api('docs/other.md'), /HTTP 503/u);
  assert.equal(requests[0][0], `https://api.github.com/repos/JagPat/PMCvitan/contents/docs/STATUS.md?ref=${ref}`);
  assert.equal(requests[0][1], 'application/vnd.github.raw+json');
  // no exact ref, no read: the caller treats a thrown base read as unknown and fails closed
  await assert.rejects(githubContentsReader({ repository: 'r', token: 't', ref: 'main', fetchImpl: async () => new Response('') })('docs/STATUS.md'), /no exact ref/u);

  // the head commit reader: files across pages, the committer date, failures thrown
  const commitRequests = [];
  const page = (n) => Array.from({ length: n }, (_, i) => ({ filename: `file-${i}.txt` }));
  const commitReader = githubCommitReader({
    repository: 'JagPat/PMCvitan', token: 't', sha: HEAD_SHA,
    fetchImpl: async (url) => {
      commitRequests.push(String(url));
      const pageNumber = Number(new URL(url).searchParams.get('page'));
      const body = { sha: HEAD_SHA, commit: { committer: { date: '2026-10-02T09:30:00Z' } }, files: pageNumber === 1 ? page(100) : [{ filename: DRAIN_EVIDENCE_DOCUMENT }] };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
  const commit = await commitReader();
  assert.equal(commit.sha, HEAD_SHA);
  assert.equal(commit.files.length, 101);
  assert.ok(commit.files.includes(DRAIN_EVIDENCE_DOCUMENT));
  assert.equal(commit.committedAt, '2026-10-02T09:30:00Z');
  assert.deepEqual(commitRequests, [
    `https://api.github.com/repos/JagPat/PMCvitan/commits/${HEAD_SHA}?per_page=100&page=1`,
    `https://api.github.com/repos/JagPat/PMCvitan/commits/${HEAD_SHA}?per_page=100&page=2`,
  ]);
  await assert.rejects(githubCommitReader({ repository: 'r', token: 't', sha: HEAD_SHA, fetchImpl: async () => new Response('x', { status: 502 }) })(), /HTTP 502/u);
  await assert.rejects(githubCommitReader({ repository: 'r', token: 't', sha: 'main', fetchImpl: async () => new Response('') })(), /no exact head SHA/u);
});

test('the live repository: the directive stands and no clearing record exists, so a clearance here would refuse', async () => {
  const markdown = await readFile(new URL('../docs/STATUS.md', import.meta.url), 'utf8');
  const now = parseStatusNow(markdown);
  assert.deepEqual(nowBlockDuplicateKeys(markdown), [], 'the live Now block repeats no key');
  // Pinned while the directive stands: when a later PR clears it, this test is replaced by the record
  // it commits (the tests above are the ones that keep applying).
  if (now.blocking_directive === DRAIN_DIRECTIVE) {
    const evidenceText = await fileSystemReader()(DRAIN_EVIDENCE_DOCUMENT);
    const verdict = assessDirectiveClearance({ baseNow: now, headNow: NOW(), statusPatch: CLEARING_PATCH, evidenceText, evidenceChanged: evidenceText !== null, headCommit: HEAD_COMMIT() });
    assert.equal(verdict.allowed, false, 'no committed drained verdict exists yet, so nothing may clear the directive');
  }
  assert.match(markdown, /rollout:drain-evidence/u);
  assert.equal(typeof run, 'function');
});
