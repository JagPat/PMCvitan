import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DRAIN_DIRECTIVE,
  rederiveDrainVerdict,
  DRAIN_DIRECTIVE_SET_AT,
  DRAIN_EVIDENCE_DOCUMENT,
  DRAIN_MINIMUM_RELEASE,
  assessCommittedDirectiveClearance,
  assessDirectiveClearance,
  parseDrainEvidence,
  statusPatchRemovesDirective,
} from './autonomous-drain-clearance.mjs';
import { parseStatusNow } from './autonomous-status-state.mjs';
import { run } from './review-scope.mjs';

// PR #686, Codex finding 4157323191: with the human attestation withdrawn, nothing trusted read
// `rollout:drain-evidence`, so a STATUS-only PR could have cleared `phase-6-4d-previous-release-drained`
// and unlocked 4d-iii without a fresh `drained` verdict. These pin the gate that closes that.

const NOW = (over = {}) => ({
  phase: '6', phase_plan: 'docs/superpowers/plans/2026-09-07-decision-workflow-4d.md', task: '4',
  task_state: 'in_progress', work_item: 'none', reviewed_merge: '4707c5d', open_pr: 'none',
  next_task: 'phase-6-task-4d-iii', blocking_directive: 'none', updated: '2026-10-02', ...over,
});
const STATUS_DOC = (now) => `# STATUS\n\n## Now\n\n\`\`\`yaml\n${Object.entries(now).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\`\`\`\n\n### Now — x\n\ntext\n\n## Maintenance queue\n\nnone\n`;

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

test('the STATUS diff is read for the removed directive line, and only that line', () => {
  assert.equal(statusPatchRemovesDirective(CLEARING_PATCH), true);
  assert.equal(statusPatchRemovesDirective(UNRELATED_PATCH), false);
  // a History paragraph that merely MENTIONS the directive is not a removal of the yaml line
  assert.equal(statusPatchRemovesDirective('-text about phase-6-4d-previous-release-drained\n+other'), false);
  // another directive is another gate
  assert.equal(statusPatchRemovesDirective('-blocking_directive: phase-6-4c-previous-release-drained\n+blocking_directive: none'), false);
  // no patch text is UNKNOWN, not "no removal"
  assert.equal(statusPatchRemovesDirective(undefined), null);
});

test('a STATUS-only edit cannot clear the directive: no evidence record, no clearance', () => {
  const verdict = assessDirectiveClearance({ headNow: NOW(), statusPatch: CLEARING_PATCH, evidenceText: null });
  assert.equal(verdict.applies, true);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.detail, /carries no docs\/rollout\/phase-6-4d-drain-evidence\.json/u);
  assert.match(verdict.detail, /never on a STATUS edit alone/u);
});

test('only a fresh drained verdict for THIS directive and THIS minimum release clears it', () => {
  const refused = (over, pattern) => {
    const parsed = parseDrainEvidence(EVIDENCE(over));
    assert.equal(parsed.ok, false, JSON.stringify(over));
    assert.match(parsed.reason, pattern, JSON.stringify(over));
    const verdict = assessDirectiveClearance({ headNow: NOW(), statusPatch: CLEARING_PATCH, evidenceText: EVIDENCE(over) });
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
  assert.equal(assessDirectiveClearance({ headNow: NOW(), statusPatch: CLEARING_PATCH, evidenceText: '{' }).allowed, false);

  // the one shape that clears: drained, no findings, this directive, this minimum (full or abbreviated),
  // the platform read, recorded after the directive was set
  const full = assessDirectiveClearance({ headNow: NOW(), statusPatch: CLEARING_PATCH, evidenceText: EVIDENCE() });
  assert.equal(full.applies, true);
  assert.equal(full.allowed, true, full.detail);
  assert.match(full.detail, /records a drained verdict/u);
  const abbreviated = assessDirectiveClearance({ headNow: NOW(), statusPatch: CLEARING_PATCH, evidenceText: EVIDENCE({ minimumRelease: 'f8274f4' }) });
  assert.equal(abbreviated.allowed, true, abbreviated.detail);
  assert.equal(Date.parse(DRAIN_DIRECTIVE_SET_AT) > Date.parse('2026-10-01T00:00:00Z'), true);
});

test('the stated verdict is never trusted: the gate re-derives it from the record\'s own inventory', () => {
  // the shadow review's example on #686: a real not-drained record with `verdict` and `findings` edited
  const notDrained = EVIDENCE({
    verdict: 'not-drained',
    findings: ['live lease i-0 (release deadbeef) serves at catalog version 2, below the minimum 3'],
    leases: [{ instanceId: 'i-0', catalogVersion: 2, release: 'deadbeef', classification: 'before' }],
  });
  assert.equal(parseDrainEvidence(notDrained).ok, false);
  const edited = JSON.stringify({ ...JSON.parse(notDrained), verdict: 'drained', findings: [] });
  const parsed = parseDrainEvidence(edited);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /re-derives to not-drained/u);
  assert.match(parsed.reason, /below the minimum/u);
  assert.equal(assessDirectiveClearance({ headNow: NOW(), statusPatch: CLEARING_PATCH, evidenceText: edited }).allowed, false);

  // every inventory fact judgeDrain reads is re-read here, by the same rules
  const rederived = (over) => rederiveDrainVerdict(JSON.parse(EVIDENCE(over)));
  assert.equal(rederived({}).verdict, 'drained');
  assert.equal(rederived({ leases: [{ instanceId: 'i-9', catalogVersion: 3, release: 'old', classification: 'before' }] }).verdict, 'not-drained');
  assert.equal(rederived({ leases: [{ instanceId: 'i-9', catalogVersion: 3, release: 'x', classification: 'unclassifiable' }] }).verdict, 'unclassified');
  assert.equal(rederived({ leases: [] }).verdict, 'unclassified'); // no serving lease is not a drained fleet
  assert.equal(rederived({ platform: { available: true, source: 'coolify', application: { uuid: 'app', name: 'pmc-api', status: 'running:healthy', gitCommitSha: 'old', classification: 'before' }, deploymentsInProgress: [] } }).verdict, 'not-drained');
  assert.equal(rederived({ platform: { available: true, source: 'coolify', application: { uuid: 'app', name: 'pmc-api', status: 'exited', gitCommitSha: DRAIN_MINIMUM_RELEASE, classification: 'at-or-after' }, deploymentsInProgress: [] } }).verdict, 'unclassified');
  assert.equal(rederived({ platform: { available: true, source: 'coolify', application: { uuid: 'app', name: 'pmc-api', status: 'running:healthy', gitCommitSha: DRAIN_MINIMUM_RELEASE, classification: 'at-or-after' }, deploymentsInProgress: [{ deploymentUuid: 'd1', applicationId: 1, status: 'in_progress', commit: null }] } }).verdict, 'unclassified');
  assert.equal(rederived({ generation: { compiled: 2, persistedMinimum: { minimumGeneration: 3, raisedBy: 'a8b', raisedAt: '2026-09-29T00:00:00.000Z' } } }).verdict, 'unclassified');
  assert.equal(rederived({ generation: { compiled: 3, persistedMinimum: null } }).verdict, 'unclassified');
  assert.equal(rederived({ minimumCatalogVersion: { value: 0, source: 'no persisted catalog row' } }).verdict, 'unclassified');
  // a lease's stated catalog version below the record's own minimum is not-drained even if classified at-or-after
  assert.equal(rederived({ leases: [{ instanceId: 'i-2', catalogVersion: 2, release: DRAIN_MINIMUM_RELEASE, classification: 'at-or-after' }] }).verdict, 'not-drained');
  // each re-derived refusal blocks the clearance
  for (const over of [{ leases: [] }, { generation: { compiled: 3, persistedMinimum: null } }]) {
    const verdict = assessDirectiveClearance({ headNow: NOW(), statusPatch: CLEARING_PATCH, evidenceText: EVIDENCE(over) });
    assert.equal(verdict.allowed, false, JSON.stringify(over));
    assert.match(verdict.detail, /re-derives to/u);
  }
});

test('a PR that leaves the directive standing, or never touched it, is not a clearance', () => {
  // the head still carries the directive: whatever the patch says, nothing is cleared
  const standing = assessDirectiveClearance({ headNow: NOW({ blocking_directive: DRAIN_DIRECTIVE }), statusPatch: CLEARING_PATCH, evidenceText: null });
  assert.equal(standing.applies, false);
  assert.equal(standing.allowed, true);
  // a STATUS edit elsewhere in the file, with the directive already none on both sides
  const unrelated = assessDirectiveClearance({ headNow: NOW(), statusPatch: UNRELATED_PATCH, evidenceText: null });
  assert.equal(unrelated.applies, false);
  assert.equal(unrelated.allowed, true);
});

test('an unreadable STATUS diff fails closed: the record is required, and suffices', () => {
  const unknown = assessDirectiveClearance({ headNow: NOW(), statusPatch: undefined, evidenceText: null });
  assert.equal(unknown.applies, true);
  assert.equal(unknown.allowed, false);
  assert.match(unknown.detail, /cannot be ruled out/u);
  const withRecord = assessDirectiveClearance({ headNow: NOW(), statusPatch: undefined, evidenceText: EVIDENCE() });
  assert.equal(withRecord.allowed, true, withRecord.detail);
});

test('the review-scope wiring reads the PR tree, and only when the diff touches STATUS', async () => {
  const tree = (files) => async (url) => {
    const path = String(url).replace(/^.*\/(docs\/.*)$/u, '$1');
    if (path in files) return files[path];
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  };
  const clearing = STATUS_DOC(NOW());

  // untouched STATUS: nothing to assess
  assert.equal(await assessCommittedDirectiveClearance({ number: 700 }, [{ filename: 'apps/api/src/thing.ts' }], tree({})), null);

  // STATUS-only clearance with no record in the tree: refused
  const bare = await assessCommittedDirectiveClearance({ number: 700 }, [{ filename: 'docs/STATUS.md', patch: CLEARING_PATCH }], tree({ 'docs/STATUS.md': clearing }));
  assert.equal(bare.applies, true);
  assert.equal(bare.allowed, false);

  // the record committed beside the clearance: allowed
  const recorded = await assessCommittedDirectiveClearance(
    { number: 700 },
    [{ filename: 'docs/STATUS.md', patch: CLEARING_PATCH }, { filename: DRAIN_EVIDENCE_DOCUMENT, patch: '+{...}' }],
    tree({ 'docs/STATUS.md': clearing, [DRAIN_EVIDENCE_DOCUMENT]: EVIDENCE() }),
  );
  assert.equal(recorded.allowed, true, recorded.detail);

  // a stale record (recorded before the directive was set) does not clear
  const stale = await assessCommittedDirectiveClearance(
    { number: 700 },
    [{ filename: 'docs/STATUS.md', patch: CLEARING_PATCH }],
    tree({ 'docs/STATUS.md': clearing, [DRAIN_EVIDENCE_DOCUMENT]: EVIDENCE({ recordedAt: '2026-09-29T00:00:00.000Z' }) }),
  );
  assert.equal(stale.allowed, false);

  // an unreadable STATUS when the diff says it changed: refused, not skipped
  const unreadable = await assessCommittedDirectiveClearance({ number: 700 }, [{ filename: 'docs/STATUS.md', patch: CLEARING_PATCH }], tree({}));
  assert.equal(unreadable.allowed, false);
  assert.match(unreadable.detail, /could not be read/u);

  // a record that exists but cannot be read (not ENOENT) is a refusal too
  const broken = await assessCommittedDirectiveClearance({ number: 700 }, [{ filename: 'docs/STATUS.md', patch: CLEARING_PATCH }], async (url) => {
    if (String(url).endsWith('docs/STATUS.md')) return clearing;
    throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
  });
  assert.equal(broken.allowed, false);
  assert.match(broken.detail, /could not be read/u);
});

test('the live repository: the directive stands and no clearing record exists, so a clearance here would refuse', async () => {
  const markdown = await readFile(new URL('../docs/STATUS.md', import.meta.url), 'utf8');
  const now = parseStatusNow(markdown);
  // Pinned while the directive stands: when a later PR clears it, this test is replaced by the record
  // it commits (the test above is the one that keeps applying).
  if (now.blocking_directive === DRAIN_DIRECTIVE) {
    const verdict = assessDirectiveClearance({ headNow: NOW(), statusPatch: CLEARING_PATCH, evidenceText: await readFile(new URL(`../${DRAIN_EVIDENCE_DOCUMENT}`, import.meta.url), 'utf8').catch(() => null) });
    assert.equal(verdict.allowed, false, 'no committed drained verdict exists yet, so nothing may clear the directive');
  }
  assert.match(markdown, /rollout:drain-evidence/u);
  assert.equal(typeof run, 'function');
});
