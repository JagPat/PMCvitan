import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVATION_INSTALL,
  ACTIVATION_REQUIRED_PROOFS,
  CODEX_TASK_ATTESTATION,
  CYCLE_NEUTRAL_LIFECYCLE_EVENTS,
  roleTransferActivationVerdict,
} from './role-activation.mjs';
import { GITHUB_ACTIONS_LOGIN, ROLE_ACTIVATION_EVIDENCE_SCHEMA } from './role-activation-evidence.mjs';
import { CLAUDE_SHADOW_CONTEXT, CLAUDE_STATUS_CONTEXT, CODEX_LOGIN, REQUIRED_CHECKS, STATUS_CONTEXT } from './review-policy.mjs';
import {
  BASE, CORRECTIVE, FINDING_REF, ORIGINAL, OTHER, PR, REPO, REQUEST_ID, activity, at, conversationItem, correctiveCommit,
  issueEvent, ms, pull, readWorld, shadowRun,
} from './role-activation-test-fixtures.mjs';
import { probeTrailerValue } from './codex-fix-probe.mjs';

const BINDING_VALUE = probeTrailerValue({ pullRequest: PR, headSha: ORIGINAL, findingRef: FINDING_REF });

// The verdict consumes the trusted reader's normalized output. These tests drive the REAL reader over a
// fake GitHub (role-activation-test-fixtures.mjs), then either judge its output directly or mutate one
// normalized field to prove each cross-record rule holds.
const expected = { repository: REPO, pullRequest: PR };
const UNRELATED = 'someone/PMCvitan';
const RECORDS = ['initialCi', 'initialFinding', 'request', 'acceptance', 'correctivePush', 'finalCi', 'finalReview', 'freshness', 'conversation'];

async function evidenceFor(mutateWorld) {
  return (await readWorld(mutateWorld)).evidence;
}
async function verdictWith(mutate) {
  const evidence = structuredClone(await evidenceFor());
  mutate(evidence);
  return roleTransferActivationVerdict(evidence, expected);
}
// Every proof holds, and the verdict still holds: the `activate` install phase is a later unit.
const allProven = (verdict) => {
  assert.equal(verdict.state, 'hold');
  assert.equal(verdict.activate, false);
  assert.deepEqual(verdict.missing, []);
};
const CLOSING_READS = [
  ['request', 'readAtMs'], ['acceptance', 'readAtMs'], ['conversation', 'readAtMs'], ['initialFinding', 'readAtMs'], ['initialCi', 'readAtMs'],
  ['freshness', 'pullReadAtMs'], ['freshness', 'pushLogReadAtMs'], ['finalCi', 'readAtMs'], ['finalReview', 'readAtMs'],
  ['freshness', 'eventLogCoveredFromMs'], ['freshness', 'eventLogReadAtMs'],
];
const holds = (verdict, proof) => {
  assert.equal(verdict.state, 'hold', `${proof}: expected hold`);
  assert.equal(verdict.keepCodexCurrentHead, true);
  assert.ok(verdict.missing.includes(proof), `${proof} not in ${verdict.missing}`);
};

test('a full cycle read by the trusted reader proves every proof, and still holds: activate is a later unit', async () => {
  const evidence = await evidenceFor();
  const verdict = roleTransferActivationVerdict(evidence, expected);
  assert.deepEqual(verdict, {
    state: 'hold',
    activate: false,
    keepCodexCurrentHead: true,
    retireCodexCurrentHead: false,
    proven: [...ACTIVATION_REQUIRED_PROOFS],
    missing: [],
  });
});

test('fail-closed defaults: no evidence, no expected identity, a foreign schema or a mismatched cycle all hold', async () => {
  const empty = roleTransferActivationVerdict();
  assert.equal(empty.state, 'hold');
  assert.deepEqual([...empty.missing].sort(), [...ACTIVATION_REQUIRED_PROOFS].sort());
  const evidence = await evidenceFor();
  holds(roleTransferActivationVerdict(evidence), 'cycleIdentity');
  holds(roleTransferActivationVerdict(evidence, { repository: REPO }), 'cycleIdentity');
  holds(roleTransferActivationVerdict({ ...evidence, schema: 'other' }, expected), 'cycleIdentity');
  holds(roleTransferActivationVerdict(evidence, { repository: UNRELATED, pullRequest: PR }), 'cycleIdentity');
  holds(roleTransferActivationVerdict(evidence, { repository: REPO, pullRequest: PR + 1 }), 'cycleIdentity');
  holds(await verdictWith((e) => { e.cycle.correctiveHeadSha = ORIGINAL; }), 'cycleIdentity');
  holds(await verdictWith((e) => { e.cycle.correctionRequestId = null; }), 'cycleIdentity');
  assert.equal(evidence.schema, ROLE_ACTIVATION_EVIDENCE_SCHEMA);
});

test('finding 4080104371: every record must name the expected repository', async () => {
  const proofFor = {
    initialCi: 'initialFullCiGreen',
    initialFinding: 'initialClaudeFinding',
    request: 'correctionRequest',
    acceptance: 'codexTaskAcceptance',
    correctivePush: 'codexCorrectivePush',
    finalCi: 'fullCiGreen',
    finalReview: 'boundClaudeClearReReview',
    freshness: 'liveHeadFreshness',
    conversation: 'codexTaskCausation',
  };
  for (const record of RECORDS) {
    holds(await verdictWith((e) => { e.records[record].repository = UNRELATED; }), proofFor[record]);
  }
  holds(await verdictWith((e) => { e.cycle.repository = UNRELATED; }), 'cycleIdentity');
  // A fork head or base repository on the live PR, at the start or at the end, is not this repository's cycle.
  for (const field of ['headRepository', 'baseRepository', 'headRepositoryAtEnd', 'baseRepositoryAtEnd']) {
    holds(await verdictWith((e) => { e.records.freshness[field] = UNRELATED; }), 'liveHeadFreshness');
  }
  // PR scope is checked on every PR-scoped record, and base scope on every CI/review record.
  for (const record of RECORDS) {
    holds(await verdictWith((e) => { e.records[record].pullRequest = PR + 1; }), proofFor[record]);
  }
  for (const record of ['initialCi', 'initialFinding', 'finalCi', 'finalReview', 'freshness']) {
    holds(await verdictWith((e) => { e.records[record].baseSha = OTHER; }), proofFor[record]);
  }
});

test('finding 4080104377: the full milestone chain is strictly ordered', async () => {
  // The operator's probes: each review timed before its own CI.
  holds(await verdictWith((e) => { e.records.initialFinding.atMs = e.records.initialCi.atMs - 1; }), 'milestoneOrder');
  holds(await verdictWith((e) => { e.records.finalReview.atMs = e.records.finalCi.atMs - 1; }), 'milestoneOrder');
  // Every adjacent pair of the chain, swapped or tied. A tie is admitted only where the records prove the
  // order (request after the finding it names, acceptance a reaction on the request; finding 4083067623).
  const chain = [
    ['initialCi', 'atMs'], ['initialFinding', 'atMs'], ['request', 'atMs', 'tie'], ['acceptance', 'atMs', 'tie'],
    ['correctivePush', 'atMs'], ['finalCi', 'atMs'], ['finalReview', 'atMs'], ['freshness', 'startedAtMs'],
  ];
  for (let index = 1; index < chain.length; index += 1) {
    const [earlier, earlierField] = chain[index - 1];
    const [later, laterField, tie] = chain[index];
    const tied = await verdictWith((e) => { e.records[later][laterField] = e.records[earlier][earlierField]; });
    if (tie) allProven(tied);
    else holds(tied, 'milestoneOrder');
    holds(await verdictWith((e) => { e.records[later][laterField] = e.records[earlier][earlierField] - 1; }), 'milestoneOrder');
  }
  holds(await verdictWith((e) => { e.records.acceptance.atMs = null; }), 'milestoneOrder');
});

test('finding 4083067610 (and 4080104384): the verdict never retires; a caller-built gate record is ignored', async () => {
  const evidence = await evidenceFor();
  const gate = {
    context: CLAUDE_STATUS_CONTEXT, repository: REPO, installedRequired: true, observedInRole: true,
    installedAtMs: Date.now() + 60_000, observedAtMs: Date.now() + 120_000,
    observedHeadSha: 'd'.repeat(40), observationId: 'status-run-777',
  };
  const verdict = roleTransferActivationVerdict({ ...evidence, records: { ...evidence.records, replacementGate: gate } }, expected);
  assert.deepEqual(verdict, roleTransferActivationVerdict(evidence, expected));
  assert.equal(verdict.keepCodexCurrentHead, true);
  assert.equal(verdict.retireCodexCurrentHead, false);
});

test('finding 4083067617: task -> push causation needs the exact trailer on a complete commit list', async () => {
  // The full cycle proves it; the attestation names this repository.
  assert.deepEqual(CODEX_TASK_ATTESTATION, { repository: REPO, owner: 'JagPat' });
  allProven(roleTransferActivationVerdict(await evidenceFor(), expected));
  const trailer = (value) => `fix: x\n\nCodex-Fix-Probe: ${value}`;
  for (const commits of [
    [correctiveCommit('1'.repeat(40)), correctiveCommit(CORRECTIVE, 'fix: no trailer')], // one commit lacks it
    [correctiveCommit('1'.repeat(40)), correctiveCommit(CORRECTIVE, `${trailer(BINDING_VALUE)}\nCodex-Fix-Probe: ${BINDING_VALUE}`)], // twice
    [correctiveCommit('1'.repeat(40)), correctiveCommit(CORRECTIVE, trailer(`${BINDING_VALUE}x`))], // another request's
    [correctiveCommit('1'.repeat(40)), correctiveCommit(CORRECTIVE, `fix: x\n\n\`\`\`\nCodex-Fix-Probe: ${BINDING_VALUE}\n\`\`\`\n`)], // quoted
    [correctiveCommit(CORRECTIVE), correctiveCommit('1'.repeat(40))], // the list does not end at the corrective head
    [correctiveCommit(CORRECTIVE)], // a truncated list (total_commits 2)
  ]) {
    holds(roleTransferActivationVerdict(await evidenceFor((w) => { w.comparison.commits = commits; }), expected), 'codexTaskCausation');
  }
  holds(await verdictWith((e) => { e.records.correctivePush.ancestry.commitsComplete = false; }), 'codexTaskCausation');
  holds(await verdictWith((e) => { e.records.correctivePush.ancestry.commits = []; }), 'codexTaskCausation');
  holds(await verdictWith((e) => { e.records.correctivePush.ancestry.commits[0].probeTrailers = null; }), 'codexTaskCausation');
  // The expected trailer is derived from the request the cycle proves, never supplied by the evidence.
  holds(await verdictWith((e) => { e.records.request.findingRef = `${FINDING_REF}9`; }), 'codexTaskCausation');
  // Another repository has no attestation: its otherwise complete cycle proves everything but causation.
  const elsewhere = JSON.parse(JSON.stringify(await evidenceFor()).replaceAll(`"${REPO}"`, `"${UNRELATED}"`));
  assert.deepEqual(roleTransferActivationVerdict(elsewhere, { repository: UNRELATED, pullRequest: PR }).missing, ['codexTaskCausation']);
  assert.ok(ACTIVATION_REQUIRED_PROOFS.includes('codexTaskCausation'));
});

test('finding 4089074927: the trailer is not enough; anyone else who could have started a Codex task holds', async () => {
  // Any other @codex mention, whenever posted (a task started earlier could still push), holds; so does
  // anything from anyone but Codex and trusted workflows since the branch reached the reviewed head (09:00),
  // whatever its text, including an older comment edited then and an undated item.
  for (const mutate of [
    (w) => { w.conversation.issue_comment.push(conversationItem(70, 'JagPat', '08:00', '@codex fix this')); },
    (w) => { w.conversation.review.push(conversationItem(70, 'JagPat', '08:00', 'please @codex review')); },
    (w) => { w.conversation.issue_comment.push(conversationItem(70, GITHUB_ACTIONS_LOGIN, '08:00', '@codex fix')); }, // an earlier request
    (w) => { w.conversation.issue_comment.push(conversationItem(70, GITHUB_ACTIONS_LOGIN, '10:40', '@codex fix')); },
    (w) => { w.conversation.issue_comment.push(conversationItem(70, 'JagPat', '10:40', 'copy that trailer')); },
    (w) => { w.conversation.review_comment.push(conversationItem(70, 'JagPat', '09:00', 'nit')); }, // at the arrival
    (w) => { w.conversation.review.push(conversationItem(70, 'someone', '10:40', 'lgtm')); },
    (w) => { w.conversation.issue_comment[0].updated_at = at('10:35'); }, // an older comment edited in the window
    (w) => { w.conversation.issue_comment.push({ id: 70, user: { login: 'someone' }, body: 'x' }); },
    (w) => { w.conversation.pull_request.body = 'Codex: @codex fix the finding'; }, // the PR's own description
    (w) => { w.conversation.pull_request.title = '@codex please'; },
  ]) {
    holds(roleTransferActivationVerdict(await evidenceFor(mutate), expected), 'codexTaskCausation');
  }
  // Codex's own items (its boilerplate mentions @codex), the request itself, trusted-workflow items without
  // @codex (dated or not), and other authors' items without @codex from before the window are quiet.
  allProven(roleTransferActivationVerdict(await evidenceFor((w) => {
    w.conversation.issue_comment.push(conversationItem(71, 'JagPat', '08:59', 'lgtm'));
    w.conversation.issue_comment.push(conversationItem(72, GITHUB_ACTIONS_LOGIN, '10:40', 'state: review_pending'));
    w.conversation.issue_comment.push({ id: 75, user: { login: GITHUB_ACTIONS_LOGIN }, body: 'state' });
    w.conversation.review.push(conversationItem(73, CODEX_LOGIN, '10:40', '@codex fix it'));
    w.conversation.review.push(conversationItem(74, 'JagPat', '08:00', 'lgtm'));
  }), expected));
  // The request is quiet only as itself: the same id as a review comment, or another issue comment, is not.
  holds(await verdictWith((e) => { e.records.conversation.items.find((item) => item.id === REQUEST_ID).kind = 'review_comment'; }), 'codexTaskCausation');
  // The window starts where the branch reached the reviewed head; without that anchor, nothing is quiet.
  holds(await verdictWith((e) => { e.records.freshness.reviewedHeadArrival.afterSha = OTHER; }), 'codexTaskCausation');
  holds(await verdictWith((e) => { e.records.freshness.reviewedHeadArrival.atMs = ms('08:00'); }), 'codexTaskCausation');
  // The description is quiet without a mention, whenever the PR was opened or last active (its edits are
  // undated); the conversation must carry exactly one description.
  allProven(roleTransferActivationVerdict(await evidenceFor((w) => { w.conversation.pull_request.created_at = at('11:50'); }), expected));
  holds(await verdictWith((e) => { e.records.conversation.items = e.records.conversation.items.filter((item) => item.kind !== 'pull_request'); }), 'codexTaskCausation');
  holds(await verdictWith((e) => { e.records.conversation.items.push({ ...e.records.conversation.items[0] }); }), 'codexTaskCausation');
  // A mention the reader could not determine counts as one (fail closed), even from a trusted workflow.
  holds(await verdictWith((e) => { delete e.records.conversation.items.find((item) => item.id === 62).mentionsCodex; }), 'codexTaskCausation');
  // An unread or unscoped conversation holds.
  holds(await verdictWith((e) => { e.records.conversation = null; }), 'codexTaskCausation');
  holds(await verdictWith((e) => { e.records.conversation.items = null; }), 'codexTaskCausation');
  holds(roleTransferActivationVerdict(await evidenceFor((w) => { w.conversationError = { review: 'boom' }; }), expected), 'codexTaskCausation');
});

test('finding 4083067623: a same-second tie is admitted only where the records prove the order', async () => {
  // The acceptance is a reaction ON the request, and the request names the finding: a tie proves nothing wrong.
  allProven(await verdictWith((e) => { e.records.acceptance.atMs = e.records.request.atMs; }));
  allProven(await verdictWith((e) => { e.records.request.atMs = e.records.initialFinding.atMs; }));
  // Without that binding the same tie holds.
  holds(await verdictWith((e) => {
    e.records.acceptance.atMs = e.records.request.atMs;
    e.records.acceptance.requestId += 1;
  }), 'milestoneOrder');
  holds(await verdictWith((e) => {
    e.records.request.atMs = e.records.initialFinding.atMs;
    e.records.request.findingRef = 'https://github.com/JagPat/PMCvitan/runs/1';
  }), 'milestoneOrder');
  holds(await verdictWith((e) => {
    e.records.request.atMs = e.records.initialFinding.atMs;
    delete e.records.request.findingRef;
    delete e.records.initialFinding.reviewRef;
  }), 'milestoneOrder');
  // Every other adjacent tie holds (the chain test below also swaps each pair).
  holds(await verdictWith((e) => { e.records.correctivePush.atMs = e.records.acceptance.atMs; }), 'milestoneOrder');
  holds(await verdictWith((e) => { e.records.finalCi.atMs = e.records.correctivePush.atMs; }), 'milestoneOrder');
});

test('finding 4080104390: the triggering finding binds through the GitHub-generated request to the accepted task', async () => {
  holds(await verdictWith((e) => { e.records.request.findingRef = 'https://github.com/JagPat/PMCvitan/runs/1'; }), 'correctionRequest');
  holds(await verdictWith((e) => { e.records.initialFinding.reviewRef = 'https://github.com/JagPat/PMCvitan/runs/1'; }), 'correctionRequest');
  holds(await verdictWith((e) => { e.records.request.requestId += 1; }), 'correctionRequest');
  holds(await verdictWith((e) => { e.records.request.headSha = OTHER; }), 'correctionRequest');
  holds(await verdictWith((e) => { e.records.acceptance.requestId += 1; }), 'codexTaskAcceptance');
  holds(await verdictWith((e) => { e.records.acceptance.actorLogin = 'JagPat'; }), 'codexTaskAcceptance');
  // A human @codex, a non-bot author, or an edited request is not a GitHub-generated request.
  for (const change of [{ githubGenerated: false }, { humanAuthored: true }, { edited: true }]) {
    holds(await verdictWith((e) => { Object.assign(e.records.request, change); }), 'correctionRequest');
  }
  // End to end: the reader reports a human-authored or edited request, and the verdict holds.
  const human = await evidenceFor((w) => { w.comment.user = { login: 'JagPat', type: 'User' }; });
  holds(roleTransferActivationVerdict(human, expected), 'correctionRequest');
  const edited = await evidenceFor((w) => { w.comment.updated_at = at('10:45'); });
  holds(roleTransferActivationVerdict(edited, expected), 'correctionRequest');
});

test('finding 4080104397: fresh live-head evidence after the review; any intervening push holds', async () => {
  // The operator's probe: away and back to the same corrective SHA is still two intervening updates.
  const awayAndBack = await evidenceFor((w) => {
    w.activities.unshift(activity(960, OTHER, CORRECTIVE, '11:40'), activity(950, CORRECTIVE, OTHER, '11:30'));
  });
  assert.equal(awayAndBack.records.freshness.liveHeadAtEnd, CORRECTIVE);
  holds(roleTransferActivationVerdict(awayAndBack, expected), 'liveHeadFreshness');
  const moved = await evidenceFor((w) => { w.pulls = [pull(CORRECTIVE), pull(OTHER)]; });
  holds(roleTransferActivationVerdict(moved, expected), 'liveHeadFreshness');
  // An away-and-back right after the reader's first push-log read is caught by its closing read.
  const inPass = await evidenceFor((w) => {
    w.after = { activity: { 1: (world) => world.activities.unshift(activity(960, OTHER, CORRECTIVE, '11:59'), activity(950, CORRECTIVE, OTHER, '11:58')) } };
  });
  holds(roleTransferActivationVerdict(inPass, expected), 'liveHeadFreshness');
  // A retarget to a same-SHA branch between the two live reads.
  const retargeted = await evidenceFor((w) => {
    w.pulls = [pull(), pull(CORRECTIVE, { base: { ref: 'release', sha: BASE, repo: { full_name: REPO } } })];
  });
  holds(roleTransferActivationVerdict(retargeted, expected), 'liveHeadFreshness');
  for (const mutate of [
    (e) => { e.records.freshness.prState = 'closed'; },
    (e) => { e.records.freshness.baseRef = 'release'; },
    (e) => { e.records.freshness.baseRefAtEnd = 'release'; },
    (e) => { e.records.freshness.baseShaAtEnd = OTHER; },
    (e) => { e.records.freshness.branchAtEnd = 'other/branch'; },
    (e) => { e.records.freshness.pushesAfterCorrective = null; },
    (e) => { e.records.freshness.observedAtMs = e.records.freshness.startedAtMs; },
  ]) {
    holds(await verdictWith(mutate), 'liveHeadFreshness');
  }
  // Every mutable source must be read after the freshness point: at it, before it, or unread all hold.
  for (const [record, field] of CLOSING_READS) {
    holds(await verdictWith((e) => { e.records[record][field] = e.records.freshness.observedAtMs; }), 'liveHeadFreshness');
    holds(await verdictWith((e) => { e.records[record][field] = e.records.freshness.startedAtMs; }), 'liveHeadFreshness');
    holds(await verdictWith((e) => { e.records[record][field] = null; }), 'liveHeadFreshness');
  }
  // End to end: a retarget away and back inside the pass leaves both live-PR snapshots equal, but the
  // lifecycle event log lists both base changes, so the verdict holds (#620 finding 4081030214).
  const retargetedAndBack = await evidenceFor((w) => {
    w.after = { pull: { 1: (world) => world.events.push(issueEvent(50, 'base_ref_changed', '11:58'), issueEvent(51, 'base_ref_changed', '11:59')) } };
  });
  assert.equal(retargetedAndBack.records.freshness.baseRefAtEnd, 'main');
  assert.equal(retargetedAndBack.records.freshness.baseShaAtEnd, BASE);
  holds(roleTransferActivationVerdict(retargetedAndBack, expected), 'liveHeadFreshness');
  // Every event that is not a draft transition holds: close/reopen, merge, head-ref events, an event this
  // verdict does not know, and an undated base change.
  for (const events of [
    [issueEvent(50, 'closed', '11:00'), issueEvent(51, 'reopened', '11:01')],
    [issueEvent(50, 'head_ref_force_pushed', '11:00')],
    [issueEvent(50, 'automatic_base_change_succeeded', '11:00')],
    [{ id: 50, event: 'base_ref_changed', actor: { login: 'JagPat' } }],
  ]) {
    const evidence = await evidenceFor((w) => { w.events.push(...events); });
    holds(roleTransferActivationVerdict(evidence, expected), 'liveHeadFreshness');
  }
  holds(await verdictWith((e) => { e.records.freshness.lifecycleEvents = [{ eventId: 1, event: 'something_new', atMs: 1 }]; }), 'liveHeadFreshness');
  // The controller's own draft -> ready toggles move neither the base nor the code under test.
  const toggled = await evidenceFor((w) => {
    w.events.push(issueEvent(50, 'convert_to_draft', '10:52'), issueEvent(51, 'ready_for_review', '11:01'));
  });
  assert.deepEqual(toggled.records.freshness.lifecycleEvents.map((entry) => entry.event), ['convert_to_draft', 'ready_for_review']);
  allProven(roleTransferActivationVerdict(toggled, expected));
  assert.deepEqual(CYCLE_NEUTRAL_LIFECYCLE_EVENTS, ['convert_to_draft', 'converted_to_draft', 'ready_for_review']);
  // An incomplete log, or one anchored after the triggering finding, proves nothing about the cycle.
  const unreadable = await evidenceFor((w) => { w.eventsError = 'boom'; });
  assert.equal(unreadable.records.freshness.lifecycleEvents, null);
  holds(roleTransferActivationVerdict(unreadable, expected), 'liveHeadFreshness');
  holds(await verdictWith((e) => { e.records.freshness.lifecycleSinceMs = e.records.initialFinding.atMs + 1; }), 'liveHeadFreshness');
  // Finding 4085733131: coverage must reach back to the initial CI's earliest decider start, not merely the
  // finding. A retarget away and back after CI started but before the finding holds, end to end.
  const afterCi = await evidenceFor((w) => {
    w.events.push(issueEvent(50, 'base_ref_changed', '10:10'), issueEvent(51, 'base_ref_changed', '10:11'));
  });
  holds(roleTransferActivationVerdict(afterCi, expected), 'liveHeadFreshness');
  holds(await verdictWith((e) => { e.records.freshness.lifecycleSinceMs = e.records.initialCi.startedAtMs + 1; }), 'liveHeadFreshness');
  holds(await verdictWith((e) => { e.records.initialCi.startedAtMs = null; }), 'liveHeadFreshness');
  // Finding 4086243264: a workflow is created (and may queue) when the reviewed head arrives, before its
  // first job starts. A retarget away and back in that queued window holds, end to end.
  const queued = await evidenceFor((w) => {
    w.events.push(issueEvent(52, 'base_ref_changed', '09:10'), issueEvent(53, 'base_ref_changed', '09:11'));
  });
  holds(roleTransferActivationVerdict(queued, expected), 'liveHeadFreshness');
  // Deciders that started before the recorded arrival (the SHA arrived earlier too) are not covered: hold.
  const reArrived = await evidenceFor((w) => { w.activities[1] = { ...w.activities[1], timestamp: at('10:10') }; });
  holds(roleTransferActivationVerdict(reArrived, expected), 'liveHeadFreshness');
  holds(await verdictWith((e) => { e.records.freshness.reviewedHeadArrival.afterSha = OTHER; }), 'liveHeadFreshness');
  holds(await verdictWith((e) => { e.records.freshness.reviewedHeadArrival = null; }), 'liveHeadFreshness');
  holds(await verdictWith((e) => { e.records.freshness.lifecycleSinceMs = e.records.freshness.reviewedHeadArrival.atMs + 1; }), 'liveHeadFreshness');
  // Finding 4086243273: the base branch deleted (and recreated at the same SHA) holds, and so does any event
  // the event log does not know to be neutral, end to end.
  for (const name of ['base_ref_deleted', 'some_future_mutation']) {
    const evidence = await evidenceFor((w) => { w.events.push(issueEvent(54, name, '11:00')); });
    assert.deepEqual(evidence.records.freshness.baseRefAtEnd, 'main');
    holds(roleTransferActivationVerdict(evidence, expected), 'liveHeadFreshness');
  }
  // Finding 4087443171: a deleted comment could be the correction request itself, so it is not neutral.
  const commentDeleted = await evidenceFor((w) => { w.events.push(issueEvent(58, 'comment_deleted', '11:30')); });
  assert.deepEqual(commentDeleted.records.freshness.lifecycleEvents.map((entry) => entry.event), ['comment_deleted']);
  holds(roleTransferActivationVerdict(commentDeleted, expected), 'liveHeadFreshness');
  // Finding 4087443162: main fast-forwards after the closing live-PR read, even after the event log. The
  // final live-PR read, after every other closing read, sees the new base SHA: hold, end to end.
  const fastForwarded = await evidenceFor((w) => {
    w.after = { events: { 1: (world) => world.pulls.push(pull(CORRECTIVE, { base: { ref: 'main', sha: OTHER, repo: { full_name: REPO } } })) } };
  });
  assert.equal(fastForwarded.records.freshness.baseShaAtEnd, BASE);
  assert.equal(fastForwarded.records.freshness.baseShaAtClose, OTHER);
  holds(roleTransferActivationVerdict(fastForwarded, expected), 'liveHeadFreshness');
  for (const mutate of [
    (e) => { e.records.freshness.baseShaAtClose = OTHER; },
    (e) => { e.records.freshness.baseRefAtClose = 'release'; },
    (e) => { e.records.freshness.baseRepositoryAtClose = UNRELATED; },
    (e) => { e.records.freshness.liveHeadAtClose = OTHER; },
    (e) => { e.records.freshness.prStateAtClose = 'closed'; },
    (e) => { e.records.freshness.pullFinalReadAtMs = null; },
    (e) => { e.records.freshness.pullFinalReadAtMs = e.records.freshness.eventLogReadAtMs; },
  ]) {
    holds(await verdictWith(mutate), 'liveHeadFreshness');
  }
  // Neutral events (labels, review requests, auto-merge toggles) change nothing.
  const neutral = await evidenceFor((w) => {
    w.events.push(issueEvent(55, 'labeled', '11:00'), issueEvent(56, 'review_requested', '11:01'), issueEvent(57, 'auto_merge_disabled', '11:02'));
  });
  allProven(roleTransferActivationVerdict(neutral, expected));
  holds(await verdictWith((e) => { e.records.freshness.lifecycleSinceMs = null; }), 'liveHeadFreshness');
  // End to end: a request edited during the pass holds.
  const edited = await evidenceFor((w) => {
    w.after = { comment: { 1: (world) => { world.comment.updated_at = at('11:59'); } } };
  });
  holds(roleTransferActivationVerdict(edited, expected), 'correctionRequest');
});

test('finding 4080104403: the latest applicable CI governs; a superseded success holds', async () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const evidence = await evidenceFor((w) => {
      w.runs[CORRECTIVE].push({ ...w.runs[CORRECTIVE].find((run) => run.name === 'api'), id: 9000, conclusion, started_at: at('11:05'), completed_at: at('11:10'), check_suite: { id: 3 } });
    });
    holds(roleTransferActivationVerdict(evidence, expected), 'fullCiGreen');
  }
  holds(await verdictWith((e) => { e.records.finalCi.state = 'pending'; }), 'fullCiGreen');
  // The deciding runs are the attempt an installer binds to: each must be named and successful.
  holds(await verdictWith((e) => { e.records.finalCi.deciders = []; }), 'fullCiGreen');
  holds(await verdictWith((e) => { e.records.finalCi.deciders[0].conclusion = 'failure'; }), 'fullCiGreen');
  holds(await verdictWith((e) => { e.records.finalCi.deciders[0].checkRunId = null; }), 'fullCiGreen');
  holds(await verdictWith((e) => { e.records.initialCi.state = 'failure'; }), 'initialFullCiGreen');
});

test('the corrective push is a non-forced Codex fast-forward from the reviewed head; multi-commit is admitted', async () => {
  const forced = await evidenceFor((w) => { w.activities[0] = activity(900, ORIGINAL, CORRECTIVE, '10:50', { type: 'force_push' }); });
  holds(roleTransferActivationVerdict(forced, expected), 'codexCorrectivePush');
  const diverged = await evidenceFor((w) => { w.comparison = { status: 'diverged', ahead_by: 1, behind_by: 1, merge_base_commit: { sha: OTHER } }; });
  holds(roleTransferActivationVerdict(diverged, expected), 'codexCorrectivePush');
  const human = await evidenceFor((w) => { w.activities[0] = activity(900, ORIGINAL, CORRECTIVE, '10:50', { actor: 'JagPat' }); });
  holds(roleTransferActivationVerdict(human, expected), 'codexCorrectivePush');
  holds(await verdictWith((e) => { e.records.correctivePush.beforeSha = OTHER; }), 'codexCorrectivePush');
  holds(await verdictWith((e) => { e.records.correctivePush.afterSha = OTHER; }), 'codexCorrectivePush');
  holds(await verdictWith((e) => { e.records.correctivePush.ancestry.mergeBaseSha = OTHER; }), 'codexCorrectivePush');
  holds(await verdictWith((e) => { e.records.correctivePush.ancestry.status = 'diverged'; }), 'codexCorrectivePush');
  holds(await verdictWith((e) => { e.records.correctivePush.ancestry.behindBy = 1; }), 'codexCorrectivePush');
  holds(await verdictWith((e) => { e.records.correctivePush.ancestry = null; }), 'codexCorrectivePush');
  holds(await verdictWith((e) => { e.records.correctivePush.branch = 'other/branch'; }), 'codexCorrectivePush');
  // A task that pushed three commits in one fast-forward update still proves the cycle.
  const multiCommit = await evidenceFor((w) => {
    w.comparison = { status: 'ahead', ahead_by: 3, behind_by: 0, merge_base_commit: { sha: ORIGINAL }, total_commits: 3,
      commits: [correctiveCommit('1'.repeat(40)), correctiveCommit('2'.repeat(40)), correctiveCommit(CORRECTIVE)] };
  });
  allProven(roleTransferActivationVerdict(multiCommit, expected));
});

test('reviews are producer-verified shadow results of the exact heads', async () => {
  holds(roleTransferActivationVerdict(await evidenceFor((w) => { w.verify = false; }), expected), 'initialClaudeFinding');
  holds(await verdictWith((e) => { e.records.initialFinding.state = 'shadow_clear'; }), 'initialClaudeFinding');
  // A later review of the reviewed head after the named finding holds; so does an unreported one.
  const reReviewed = await evidenceFor((w) => { w.runs[ORIGINAL].push(shadowRun(ORIGINAL, { id: 7500, completed: at('10:40'), state: 'clear' })); });
  holds(roleTransferActivationVerdict(reReviewed, expected), 'initialClaudeFinding');
  // Finding 4085733140: a later run that only carries the shadow name (fails producer verification) is not a
  // review, so it cannot deny readiness.
  const impostor = await evidenceFor((w) => {
    w.runs[ORIGINAL].push(shadowRun(ORIGINAL, { id: 7600, completed: at('10:40'), state: 'clear' }));
    w.verify = (run) => run.id !== 7600;
  });
  assert.deepEqual(impostor.records.initialFinding.unverifiedLaterRunIds, [7600]);
  allProven(roleTransferActivationVerdict(impostor, expected));
  holds(await verdictWith((e) => { delete e.records.initialFinding.laterReviewRunIds; }), 'initialClaudeFinding');
  holds(await verdictWith((e) => { e.records.finalReview.state = 'changes_required'; }), 'boundClaudeClearReReview');
  holds(await verdictWith((e) => { e.records.finalReview.headSha = OTHER; }), 'boundClaudeClearReReview');
  holds(await verdictWith((e) => { e.records.initialCi.headSha = OTHER; }), 'initialFullCiGreen');
  holds(await verdictWith((e) => { e.records.finalCi.headSha = OTHER; }), 'fullCiGreen');
});

test('the install switch is data the verdict never applies; the live required gate is unchanged', () => {
  assert.deepEqual(ACTIVATION_INSTALL, { addRequired: CLAUDE_STATUS_CONTEXT, codingOwner: 'codex', reviewer: 'claude' });
  assert.notEqual(ACTIVATION_INSTALL.addRequired, STATUS_CONTEXT);
  assert.ok(!REQUIRED_CHECKS.includes(CLAUDE_SHADOW_CONTEXT));
  assert.ok(!REQUIRED_CHECKS.includes(CLAUDE_STATUS_CONTEXT));
});
