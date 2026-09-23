import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACTIVATION_INSTALL,
  ACTIVATION_REQUIRED_PROOFS,
  CYCLE_NEUTRAL_LIFECYCLE_EVENTS,
  roleTransferActivationVerdict,
} from './role-activation.mjs';
import { ROLE_ACTIVATION_EVIDENCE_SCHEMA } from './role-activation-evidence.mjs';
import { CLAUDE_SHADOW_CONTEXT, CLAUDE_STATUS_CONTEXT, CODEX_LOGIN, REQUIRED_CHECKS, STATUS_CONTEXT } from './review-policy.mjs';
import {
  BASE, CORRECTIVE, ORIGINAL, OTHER, PR, REPO, activity, at, issueEvent, pull, readWorld, shadowRun,
} from './role-activation-test-fixtures.mjs';

// The verdict consumes the trusted reader's normalized output. These tests drive the REAL reader over a
// fake GitHub (role-activation-test-fixtures.mjs), then either judge its output directly or mutate one
// normalized field to prove each cross-record rule holds.
const expected = { repository: REPO, pullRequest: PR };
const UNRELATED = 'someone/PMCvitan';
const RECORDS = ['initialCi', 'initialFinding', 'request', 'acceptance', 'correctivePush', 'finalCi', 'finalReview', 'freshness'];

async function evidenceFor(mutateWorld) {
  return (await readWorld(mutateWorld)).evidence;
}
async function verdictWith(mutate) {
  const evidence = structuredClone(await evidenceFor());
  mutate(evidence);
  return roleTransferActivationVerdict(evidence, expected);
}
// Every proof the trusted reader's evidence can carry holds; only task -> push causation, which no trusted
// source records yet, is missing.
const allButCausation = (verdict) => {
  assert.equal(verdict.state, 'hold');
  assert.deepEqual(verdict.missing, ['codexTaskCausation']);
};
const CLOSING_READS = [
  ['request', 'readAtMs'], ['acceptance', 'readAtMs'], ['initialFinding', 'readAtMs'], ['initialCi', 'readAtMs'],
  ['freshness', 'pullReadAtMs'], ['freshness', 'pushLogReadAtMs'], ['finalCi', 'readAtMs'], ['finalReview', 'readAtMs'],
  ['freshness', 'eventLogCoveredFromMs'], ['freshness', 'eventLogReadAtMs'],
];
const holds = (verdict, proof) => {
  assert.equal(verdict.state, 'hold', `${proof}: expected hold`);
  assert.equal(verdict.keepCodexCurrentHead, true);
  assert.ok(verdict.missing.includes(proof), `${proof} not in ${verdict.missing}`);
};

test('a full cycle read by the trusted reader proves every observable proof, and still holds on causation', async () => {
  const evidence = await evidenceFor();
  const verdict = roleTransferActivationVerdict(evidence, expected);
  assert.deepEqual(verdict, {
    state: 'hold',
    activate: false,
    keepCodexCurrentHead: true,
    retireCodexCurrentHead: false,
    proven: ACTIVATION_REQUIRED_PROOFS.filter((proof) => proof !== 'codexTaskCausation'),
    missing: ['codexTaskCausation'],
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
    if (tie) allButCausation(tied);
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

test('finding 4083067617: task -> push causation is unproven by any trusted record, so the verdict holds', async () => {
  // The reader's corrective push is the Codex connector's, but nothing ties it to THIS request's task.
  const evidence = await evidenceFor();
  assert.equal(evidence.records.correctivePush.actorLogin, CODEX_LOGIN);
  holds(roleTransferActivationVerdict(evidence, expected), 'codexTaskCausation');
  // A caller cannot supply the binding: fields the reader does not produce change nothing.
  holds(await verdictWith((e) => { Object.assign(e.records.correctivePush, { requestId: e.cycle.correctionRequestId, taskId: 't-1' }); }), 'codexTaskCausation');
  assert.ok(ACTIVATION_REQUIRED_PROOFS.includes('codexTaskCausation'));
});

test('finding 4083067623: a same-second tie is admitted only where the records prove the order', async () => {
  // The acceptance is a reaction ON the request, and the request names the finding: a tie proves nothing wrong.
  allButCausation(await verdictWith((e) => { e.records.acceptance.atMs = e.records.request.atMs; }));
  allButCausation(await verdictWith((e) => { e.records.request.atMs = e.records.initialFinding.atMs; }));
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
  allButCausation(roleTransferActivationVerdict(toggled, expected));
  assert.deepEqual(CYCLE_NEUTRAL_LIFECYCLE_EVENTS, ['convert_to_draft', 'converted_to_draft', 'ready_for_review']);
  // An incomplete log, or one anchored after the triggering finding, proves nothing about the cycle.
  const unreadable = await evidenceFor((w) => { w.eventsError = 'boom'; });
  assert.equal(unreadable.records.freshness.lifecycleEvents, null);
  holds(roleTransferActivationVerdict(unreadable, expected), 'liveHeadFreshness');
  holds(await verdictWith((e) => { e.records.freshness.lifecycleSinceMs = e.records.initialFinding.atMs + 1; }), 'liveHeadFreshness');
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
  const multiCommit = await evidenceFor((w) => { w.comparison = { status: 'ahead', ahead_by: 3, behind_by: 0, merge_base_commit: { sha: ORIGINAL } }; });
  allButCausation(roleTransferActivationVerdict(multiCommit, expected));
});

test('reviews are producer-verified shadow results of the exact heads', async () => {
  holds(roleTransferActivationVerdict(await evidenceFor((w) => { w.verify = false; }), expected), 'initialClaudeFinding');
  holds(await verdictWith((e) => { e.records.initialFinding.state = 'shadow_clear'; }), 'initialClaudeFinding');
  // A later review of the reviewed head after the named finding holds; so does an unreported one.
  const reReviewed = await evidenceFor((w) => { w.runs[ORIGINAL].push(shadowRun(ORIGINAL, { id: 7500, completed: at('10:40'), state: 'clear' })); });
  holds(roleTransferActivationVerdict(reReviewed, expected), 'initialClaudeFinding');
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
