// Owner-aware correction routing.
//
// THE DEFECT, as observed on 2026-08-17. PR #349 (Claude-owned) and PR #350
// (Cursor-owned) both completed product CI, both received current-head Codex
// findings, and both were correctly returned to draft. The controller then told
// BOTH of them, verbatim:
//
//     Next: Claude Auto-fix handles the review comments and pushes a new head.
//
// That sentence is a claim about who is working, and on #350 it was false. The
// controller has no way to know: nothing in a pull request declares which agent
// owns its corrections, the branch prefix does not say (both PRs are on
// `codex/**` branches), and GitHub cannot observe whether a subscription-backed
// Claude or Cursor session is alive. Nothing then noticed that no correction
// arrived — `scripts/autonomous-handoff.mjs` handles conflicts, merge
// continuation and status drift, and reports success while a finding-bearing
// head sits untouched for hours. The owner had to kick both PRs by hand.
//
// D1-D3 below are the reproduction: each one fails at `f9c1d3a` for exactly the
// reason named in its comment. Everything after them is the specification of the
// fix. Nothing here weakens the exact-head `codex-current-head` gate, the draft
// discipline, the same-repository restriction, or the two-finding-head
// replacement policy — O7 pins that.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { guardAgainstCurrentHeadFinding, REQUIRED_CHECKS } from './autonomous-review-gate.mjs';
import { REVIEW_RESET_AFTER_FINDING_HEADS, assessReviewScope } from './review-efficiency.mjs';
import * as handoff from './autonomous-handoff.mjs';

const CODEX = 'chatgpt-codex-connector[bot]';
const HEAD = '76f2d00b4d43b0b1290a5904322290a3cb68ce63';
const GATE = new URL('./autonomous-review-gate.mjs', import.meta.url);
const HANDOFF = new URL('./autonomous-handoff.mjs', import.meta.url);
const REPOSITORY = 'JagPat/PMCvitan';

// Neither new module exists at the reproduction base, so both are imported
// dynamically: a static import would fail to LINK and take the D1-D3
// reproductions down with it, hiding the defects they exist to show.
const ownerModule = () => import('./correction-owner.mjs');
const leaseModule = () => import('./correction-lease.mjs');

function findingComments(head = HEAD, count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    user: { login: CODEX },
    original_commit_id: head,
    path: `file-${index}.ts`,
    line: index + 1,
    body: `finding ${index}`,
  }));
}

function pullRequest({
  number = 350,
  body = '',
  ref = 'codex/cloud-agent-env-replacement',
  head = HEAD,
} = {}) {
  return {
    number,
    body,
    state: 'open',
    draft: true,
    html_url: `https://github.com/${REPOSITORY}/pull/${number}`,
    head: { ref, sha: head, repo: { full_name: REPOSITORY } },
    base: { ref: 'main', repo: { full_name: REPOSITORY } },
  };
}

function fakeGateClient(live, { comments = findingComments(), reviews = [] } = {}) {
  const calls = { statuses: [], drafts: [], stickies: [] };
  const client = {
    reviews: async () => reviews,
    reviewComments: async () => comments,
    pullRequest: async () => live,
    setDraft: async (target, draft) => {
      calls.drafts.push(draft);
      return { ...target, draft };
    },
    setStatus: async (head, state, description) => {
      calls.statuses.push({ head, state, description });
    },
    updateStickyComment: async (number, body) => {
      calls.stickies.push(body);
    },
  };
  return { client, calls };
}

async function publishedSticky(prOverrides, findingCount = 1) {
  const live = pullRequest(prOverrides);
  const { client, calls } = fakeGateClient(live, {
    comments: findingComments(live.head.sha, findingCount),
  });
  await guardAgainstCurrentHeadFinding(client, live, live.head.sha, null);
  assert.equal(calls.stickies.length, 1, 'the finding path must publish exactly one sticky');
  return { body: calls.stickies[0], calls };
}

// The line the controller tells the loop to act on.
function nextLine(body) {
  return /^- \*\*Next:\*\* (.+)$/mu.exec(body)?.[1] ?? '';
}

// ─────────────────────────────────────────────────────────────────────────────
// D1-D3 — the reproduction. RED at the base commit.

test('D1: a Cursor-owned PR is told that Claude will fix it', async () => {
  // Verbatim reproduction of PR #350. The PR declares Cursor as its correction
  // owner and the controller answers with a Claude claim, because the string is
  // hardcoded at the call site.
  const { body } = await publishedSticky({
    number: 350,
    body: '<!-- correction-owner: cursor -->\n\n## Objective\n\nCloud Agent environment.',
  });

  assert.doesNotMatch(
    body,
    /claude/iu,
    'a Cursor-owned correction must never be attributed to Claude anywhere in the notice',
  );
  assert.doesNotMatch(body, /@claude/u, 'and it must never tag Claude');
});

test('D2: the controller cannot distinguish correction owners', async () => {
  // Two PRs, two different declared owners, one identical instruction. Whatever
  // the controller is saying, it is not reading the declaration — it has none to
  // read.
  const claude = await publishedSticky({
    number: 349,
    body: '<!-- correction-owner: claude -->',
    ref: 'codex/phase6-4b-approval-attribution',
    head: '32cd6a152346d3a28c7695546e2ab6eccb982f6f',
  });
  const cursor = await publishedSticky({
    number: 350,
    body: '<!-- correction-owner: cursor -->',
  });

  assert.notEqual(
    nextLine(claude.body),
    nextLine(cursor.body),
    'a Claude-owned and a Cursor-owned PR must not receive the same correction instruction',
  );
  assert.match(nextLine(claude.body), /claude/iu);
  assert.doesNotMatch(nextLine(cursor.body), /claude/iu);
});

test('D3: a green handoff can report success while no correction worker exists', () => {
  // The handoff job is the only thing that runs on a schedule, and it has no
  // notion of an unresolved correction: conflicts, merge continuation, drift.
  // A finding-bearing head with no correction in flight passes through it
  // silently, and the job goes green.
  assert.equal(
    typeof handoff.handOffCorrectionLease,
    'function',
    'the handoff must implement a correction watchdog, not only conflicts/merge/drift',
  );
  const source = readFileSync(HANDOFF, 'utf8');
  assert.match(
    source.slice(source.indexOf('export async function run()')),
    /handOffCorrectionLease\(/u,
    'and its own run loop must drive it',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// O1-O8 — the specification.

test('O1: the declaration is machine-readable, and every failure mode is named', async () => {
  const { parseCorrectionOwner, CORRECTION_OWNERS } = await ownerModule();

  assert.deepEqual(CORRECTION_OWNERS, ['claude', 'cursor']);

  const claude = parseCorrectionOwner('<!-- correction-owner: claude -->');
  assert.equal(claude.state, 'declared');
  assert.equal(claude.owner, 'claude');

  const cursor = parseCorrectionOwner(
    '<!-- review-size: standard -->\n<!-- correction-owner:cursor -->\n\n## Objective',
  );
  assert.equal(cursor.state, 'declared', 'the separator space is optional');
  assert.equal(cursor.owner, 'cursor');

  assert.equal(parseCorrectionOwner('').state, 'missing');
  assert.equal(parseCorrectionOwner('').owner, null);
  assert.equal(parseCorrectionOwner(undefined).state, 'missing');

  const invalid = parseCorrectionOwner('<!-- correction-owner: codex -->');
  assert.equal(invalid.state, 'invalid');
  assert.equal(invalid.owner, null, 'an unknown agent is never routed to');

  const contradictory = parseCorrectionOwner(
    '<!-- correction-owner: claude -->\n<!-- correction-owner: cursor -->',
  );
  assert.equal(contradictory.state, 'contradictory');
  assert.equal(contradictory.owner, null);

  // A repeated marker is REFUSED: exactly one declaration, not merely one
  // distinct owner. This probe originally asserted the opposite — see C3, which
  // reproduces why that reasoning had the authoring slip backwards.
  const repeated = parseCorrectionOwner(
    '<!-- correction-owner: cursor -->\n<!-- correction-owner: cursor -->',
  );
  assert.equal(repeated.state, 'invalid');
  assert.equal(repeated.owner, null);

  // Only the MARKER BLOCK at the top declares. A body that also EXPLAINS the
  // markers in prose — which the PR template's own guidance does, and which the
  // first head of PR #352 did while documenting the #349/#350 bootstrap — is
  // declaring once and describing twice. Reading the whole body refused both.
  const documented = parseCorrectionOwner(
    [
      '<!-- review-size: standard -->',
      '<!-- correction-owner: claude -->',
      '',
      '## Objective',
      '',
      'Replace the marker with `<!-- correction-owner: cursor -->` when a Cursor agent owns it.',
    ].join('\n'),
  );
  assert.equal(documented.state, 'declared');
  assert.equal(documented.owner, 'claude');

  // The strongest form of that probe: the repository's own template must be
  // usable as written.
  const template = readFileSync(
    new URL('../.github/pull_request_template.md', import.meta.url),
    'utf8',
  );
  assert.equal(parseCorrectionOwner(template).state, 'declared');
  assert.equal(parseCorrectionOwner(template).owner, 'claude');

  // A marker below the header block declares nothing, and says so.
  const buried = parseCorrectionOwner('## Objective\n\n<!-- correction-owner: cursor -->');
  assert.equal(buried.state, 'missing');
  assert.match(buried.detail, /top of the PR body/u);

  // The branch prefix is not the authority — #349 and #350 are both Claude-loop
  // PRs on `codex/**` branches — but `claude/**` IS reserved by
  // docs/AUTONOMOUS_LOOP.md for Claude-authored work, so a `claude/**` branch
  // declaring another owner contradicts itself.
  const branchConflict = parseCorrectionOwner('<!-- correction-owner: cursor -->', {
    headRef: 'claude/some-task',
  });
  assert.equal(branchConflict.state, 'contradictory');
  assert.equal(
    parseCorrectionOwner('<!-- correction-owner: cursor -->', {
      headRef: 'codex/cloud-agent-env-replacement',
    }).state,
    'declared',
    'any other prefix imposes nothing',
  );
});

test('O2: review-scope rejects undeclared ownership before any expensive job', async () => {
  const { CORRECTION_OWNER_ENFORCE_AFTER_PR } = await ownerModule();

  const CHECKLIST = [
    '- [x] `concurrency-serialization`',
    '- [x] `old-release-migration-compatibility`',
    '- [x] `trigger-alternate-writers`',
    '- [x] `authorization-tenancy`',
    '- [x] `ci-reproduce-first`',
    'Replaces: none',
  ].join('\n');

  const scoped = ({ number = 400, ref = 'claude/task', declaration = '<!-- correction-owner: claude -->' }) =>
    assessReviewScope(
      {
        number,
        additions: 10,
        deletions: 0,
        changed_files: 1,
        head: { ref },
        body: declaration ? `${declaration}\n${CHECKLIST}` : CHECKLIST,
      },
      { changedFiles: [{ filename: 'scripts/a.mjs' }], requireChangedFiles: true },
    );

  assert.equal(scoped({}).allowed, true, 'a declared owner passes');

  const undeclared = scoped({ declaration: '' });
  assert.equal(undeclared.allowed, false);
  assert.match(undeclared.detail, /correction-owner/u);

  const invalid = scoped({ declaration: '<!-- correction-owner: codex -->', ref: 'codex/x' });
  assert.equal(invalid.allowed, false, 'an unknown agent is refused');

  const contradictory = scoped({
    declaration: '<!-- correction-owner: claude -->\n<!-- correction-owner: cursor -->',
    ref: 'codex/x',
  });
  assert.equal(contradictory.allowed, false, 'two different declared owners are refused');

  const branchConflict = scoped({ declaration: '<!-- correction-owner: cursor -->' });
  assert.equal(
    branchConflict.allowed,
    false,
    'a `claude/**` branch declaring another owner contradicts itself',
  );

  // review-scope is the first job and everything expensive depends on it, so a
  // refusal here costs no product battery and no Codex invocation.
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /^  review-scope:$/mu);
  for (const job of ['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof']) {
    assert.match(
      ci,
      new RegExp(`\\n  ${job}:\\n[\\s\\S]{0,400}?needs: \\[review-scope`, 'u'),
      `${job} must not run before review-scope`,
    );
  }

  // #349 and #350 predate the requirement and are bootstrapped by declaring the
  // marker themselves, not by a forced edit from this branch.
  assert.equal(CORRECTION_OWNER_ENFORCE_AFTER_PR, 350);
  const openPr = scoped({ number: 350, ref: 'codex/cloud-agent-env-replacement', declaration: '' });
  assert.equal(openPr.allowed, true, 'an already-open PR is not retroactively blocked');
});

test('O3: findings are routed by the declaration, and Claude is never claimed for Cursor', async () => {
  const { correctionRouting, parseCorrectionOwner } = await ownerModule();

  const claude = correctionRouting({
    declaration: parseCorrectionOwner('<!-- correction-owner: claude -->'),
    head: HEAD,
    detail: '3 current-head Codex findings',
  });
  assert.equal(claude.owner, 'claude');
  assert.equal(claude.state, 'routed');
  assert.equal(claude.mention, '@claude');
  assert.match(claude.instruction, /Auto-fix/u);

  const cursor = correctionRouting({
    declaration: parseCorrectionOwner('<!-- correction-owner: cursor -->'),
    head: HEAD,
    detail: '3 current-head Codex findings',
  });
  assert.equal(cursor.owner, 'cursor');
  assert.equal(cursor.mention, null, 'a Cursor correction never tags Claude');
  assert.doesNotMatch(cursor.instruction, /claude/iu);
  assert.match(cursor.instruction, /cursor/iu);

  const undeclared = correctionRouting({
    declaration: parseCorrectionOwner(''),
    head: HEAD,
    detail: '2 current-head Codex findings',
  });
  assert.equal(undeclared.state, 'correction_stalled');
  assert.equal(undeclared.owner, null, 'an undeclared owner never defaults to Claude');
  assert.equal(undeclared.mention, null);
  assert.doesNotMatch(
    undeclared.instruction,
    /Claude (Auto-fix|handles|will|owns)/iu,
    'and nothing claims Claude is handling it',
  );

  // And the gate publishes exactly that, rather than a hardcoded sentence.
  const cursorSticky = await publishedSticky({
    number: 350,
    body: '<!-- correction-owner: cursor -->',
  });
  assert.equal(nextLine(cursorSticky.body), cursor.instruction);
  assert.match(cursorSticky.body, /- \*\*Correction owner:\*\* `cursor`/u);

  const gate = readFileSync(GATE, 'utf8');
  assert.doesNotMatch(
    gate,
    /next: '[^']*Claude/u,
    'no call site may hardcode a Claude claim; the owner decides',
  );
});

test('O4: the correction lease is keyed to PR, exact head and owner, and never repeats', async () => {
  const { assessCorrectionLease, correctionLeaseMarker, CORRECTION_LEASE_GRACE_MS } =
    await leaseModule();

  const base = {
    pullRequest: pullRequest({ body: '<!-- correction-owner: claude -->' }),
    head: HEAD,
    body: '<!-- correction-owner: claude -->',
    findingHeads: [HEAD],
    detail: '3 current-head Codex findings',
    findingObservedAt: '2026-08-17T10:00:00Z',
    comments: [],
  };

  const early = assessCorrectionLease({ ...base, now: '2026-08-17T10:10:00Z' });
  assert.equal(early.state, 'waiting', 'a bounded interval passes before any notification');

  const due = assessCorrectionLease({ ...base, now: '2026-08-17T11:00:00Z' });
  assert.equal(due.state, 'notify');
  assert.equal(due.owner, 'claude');
  assert.match(due.body, /@claude/u);
  assert.match(due.body, new RegExp(HEAD, 'u'), 'the notice names the exact head');
  assert.match(due.body, /3 current-head Codex findings/u);

  const key = correctionLeaseMarker({ number: 350, head: HEAD, owner: 'claude' });
  assert.ok(due.body.includes(key), 'the notice carries its own idempotency marker');

  // Published once, never again — for this PR, this head, this owner.
  const already = assessCorrectionLease({
    ...base,
    now: '2026-08-17T13:00:00Z',
    comments: [{ user: { login: 'github-actions[bot]' }, body: due.body }],
  });
  assert.equal(already.state, 'notified');
  assert.equal(already.body, null);

  // A DIFFERENT head is a different lease, so a real correction that then draws
  // findings again is still watched.
  const nextHead = assessCorrectionLease({
    ...base,
    pullRequest: pullRequest({ body: base.body, head: 'aaaa111' }),
    head: 'aaaa111',
    findingHeads: [HEAD, 'aaaa111'],
    now: '2026-08-17T13:00:00Z',
    comments: [{ user: { login: 'github-actions[bot]' }, body: due.body }],
  });
  assert.notEqual(nextHead.state, 'notified');

  // A NOTIFICATION IS NOT PROOF A WORKER STARTED. Only head movement clears the
  // lease: not the comment, not an acknowledgement reaction on it. This is the
  // exact failure the owner hit — both PRs "acknowledged only as a subscription"
  // and produced nothing.
  const acknowledged = assessCorrectionLease({
    ...base,
    now: '2026-08-17T14:00:00Z',
    comments: [
      {
        user: { login: 'github-actions[bot]' },
        body: due.body,
        reactions: { total_count: 1, eyes: 1 },
      },
    ],
  });
  assert.equal(acknowledged.state, 'notified', 'an acknowledged notice is still an open lease');

  const moved = assessCorrectionLease({
    ...base,
    pullRequest: pullRequest({ body: base.body, head: 'bbbb222' }),
    now: '2026-08-17T14:00:00Z',
  });
  assert.equal(moved.state, 'superseded', 'only a new head satisfies the lease');

  assert.ok(CORRECTION_LEASE_GRACE_MS >= 15 * 60_000, 'the interval is bounded, not instant');
});

test('O5: an owner GitHub cannot awaken is reported as correction_stalled, never as progress', async () => {
  const { assessCorrectionLease } = await leaseModule();
  const { CORRECTION_STALLED } = await ownerModule();

  const stalled = assessCorrectionLease({
    pullRequest: pullRequest({ body: '<!-- correction-owner: cursor -->' }),
    head: HEAD,
    body: '<!-- correction-owner: cursor -->',
    findingHeads: [HEAD],
    detail: '3 current-head Codex findings',
    findingObservedAt: '2026-08-17T10:00:00Z',
    now: '2026-08-17T11:00:00Z',
    comments: [],
  });

  assert.equal(stalled.state, 'notify');
  assert.equal(stalled.reportedState, CORRECTION_STALLED);
  assert.match(stalled.body, /correction_stalled/u);
  assert.match(stalled.body, /cursor/iu, 'the exact owner');
  assert.match(stalled.body, new RegExp(HEAD, 'u'), 'the exact head');
  assert.match(stalled.body, /3 current-head Codex findings/u, 'the findings');
  assert.match(stalled.body, /resume/iu, 'and the required resume action');
  assert.doesNotMatch(stalled.body, /@claude/u);
  assert.doesNotMatch(
    stalled.body,
    /(in progress|continuing|is working|will push)/iu,
    'it must not claim progress that is not happening',
  );

  const undeclared = assessCorrectionLease({
    pullRequest: pullRequest({ body: '' }),
    head: HEAD,
    body: '',
    findingHeads: [HEAD],
    detail: '3 current-head Codex findings',
    findingObservedAt: '2026-08-17T10:00:00Z',
    now: '2026-08-17T11:00:00Z',
    comments: [],
  });
  assert.equal(undeclared.reportedState, CORRECTION_STALLED);
  assert.match(undeclared.body, /correction-owner/u, 'and names how to fix the declaration');
});

test('O6: the lease never authorizes a correction past the two-finding-head limit', async () => {
  const { assessCorrectionLease } = await leaseModule();

  const exhausted = assessCorrectionLease({
    pullRequest: pullRequest({ body: '<!-- correction-owner: claude -->' }),
    head: HEAD,
    body: '<!-- correction-owner: claude -->',
    findingHeads: ['first', HEAD],
    detail: '1 current-head Codex finding',
    findingObservedAt: '2026-08-17T10:00:00Z',
    now: '2026-08-17T11:00:00Z',
    comments: [],
  });

  assert.equal(exhausted.state, 'notify');
  assert.equal(exhausted.reportedState, 'replacement_required');
  assert.match(exhausted.body, /replacement/iu);
  assert.doesNotMatch(
    exhausted.body,
    /push (a|one) new head/iu,
    'a third correction head must never be requested',
  );
  assert.equal(REVIEW_RESET_AFTER_FINDING_HEADS, 2);
});

test('O7: the watchdog changes no gate state, and the safety boundaries are unchanged', async () => {
  const { isCorrectionEligiblePullRequest } = await ownerModule();

  // Same-repository, base = default branch, open. Ownership now comes from the
  // declaration rather than the branch name, so `codex/**` PRs are watched too —
  // but a fork or a non-default base still is not.
  assert.equal(
    isCorrectionEligiblePullRequest(pullRequest(), REPOSITORY, 'main'),
    true,
  );
  assert.equal(
    isCorrectionEligiblePullRequest(
      { ...pullRequest(), head: { ref: 'x', sha: HEAD, repo: { full_name: 'fork/repo' } } },
      REPOSITORY,
      'main',
    ),
    false,
  );
  assert.equal(
    isCorrectionEligiblePullRequest(
      { ...pullRequest(), base: { ref: 'release', repo: { full_name: REPOSITORY } } },
      REPOSITORY,
      'main',
    ),
    false,
  );
  assert.equal(
    isCorrectionEligiblePullRequest({ ...pullRequest(), state: 'closed' }, REPOSITORY, 'main'),
    false,
  );

  // The watchdog only ever comments. It cannot publish the required status,
  // change draft state, merge, or invoke Codex.
  const source = readFileSync(HANDOFF, 'utf8');
  const watchdog = source.slice(
    source.indexOf('export async function handOffCorrectionLease('),
    source.indexOf('export async function run()'),
  );
  assert.ok(watchdog.length > 0, 'the watchdog must be locatable');
  assert.doesNotMatch(watchdog, /setStatus|setDraft|merge|markPullRequestReadyForReview/u);

  // The required-check contract and the exact-head status are untouched.
  assert.deepEqual(REQUIRED_CHECKS, [
    'review-scope',
    'battery-plan',
    'web',
    'api',
    'e2e',
    'api-e2e',
    'upgrade-proof',
  ]);
  assert.match(readFileSync(GATE, 'utf8'), /const STATUS_CONTEXT = 'codex-current-head';/u);
});

test('O8: the PR template and the loop documentation carry the declaration', async () => {
  const { CORRECTION_OWNERS } = await ownerModule();
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

  const template = read('../.github/pull_request_template.md');
  assert.match(template, /<!-- correction-owner: claude -->/u);
  for (const owner of CORRECTION_OWNERS) {
    assert.match(template, new RegExp(`correction-owner: ${owner}`, 'u'));
  }

  for (const document of ['../docs/AUTONOMOUS_LOOP.md', '../AGENTS.md', '../CLAUDE.md']) {
    assert.match(read(document), /correction-owner/u, `${document} must state the requirement`);
  }
  assert.match(read('../docs/AUTONOMOUS_LOOP.md'), /correction_stalled/u);
});

// ─────────────────────────────────────────────────────────────────────────────
// C1-C5 — round-1 Codex findings on `cdae569`. All five reproduce here.
//
// Four of them are the same shape: an instruction that is correct about WHO and
// wrong about WHAT to do next, or a decision taken from a stale snapshot. The
// unit's whole claim is that these notices are derived rather than assumed, so a
// notice that contradicts itself, or that describes a PR as it was rather than
// as it is, is a defect in exactly the thing under review.

test('C1: the watchdog assesses the LIVE head, not the snapshot it was handed', async () => {
  // The open-PR snapshot is taken once at the top of the handoff loop. A
  // correction pushing a new head while the loop works through conflicts and
  // status reads leaves that snapshot stale, and a lease keyed to the stale head
  // matches itself — so a notice is published for a head that has already been
  // superseded, which is the one thing the lease must never do.
  const source = readFileSync(HANDOFF, 'utf8');
  const watchdog = source.slice(
    source.indexOf('export async function handOffCorrectionLease('),
    source.indexOf('export async function run()'),
  );
  assert.match(
    watchdog,
    /await client\.pullRequest\(/u,
    'the watchdog must re-read the pull request before assessing the lease',
  );
  const refetch = watchdog.indexOf('await client.pullRequest(');
  const assess = watchdog.indexOf('assessCorrectionLease(');
  assert.ok(refetch > 0 && refetch < assess, 'and it must re-read BEFORE assessing');

  // Behaviourally: a lease whose PR has moved on is superseded, never notified.
  const { assessCorrectionLease } = await leaseModule();
  const moved = assessCorrectionLease({
    pullRequest: pullRequest({ body: '<!-- correction-owner: claude -->', head: 'newhead' }),
    head: HEAD,
    body: '<!-- correction-owner: claude -->',
    findingHeads: [HEAD],
    detail: '3 current-head Codex findings',
    findingObservedAt: '2026-08-17T10:00:00Z',
    now: '2026-08-17T12:00:00Z',
    comments: [],
  });
  assert.equal(moved.state, 'superseded');
  assert.equal(moved.body, null);
});

test('C2: a finding notice is routed from the REFRESHED declaration', async () => {
  // `setDraftForCurrentHead` returns the live pull request. Routing from the
  // object captured at run start means an owner marker edited during the Codex
  // poll is ignored — and the specific failure is the original defect returning:
  // a PR that now declares `cursor` is told Claude will fix it.
  const gate = readFileSync(GATE, 'utf8');
  const publisher = gate.slice(
    gate.indexOf('export async function publishCurrentHeadFinding('),
    gate.indexOf('export async function guardAgainstCurrentHeadFinding('),
  );
  assert.match(
    publisher,
    /correctionNotice\(live\b/u,
    'the finding notice must be derived from the refreshed pull request',
  );
  assert.doesNotMatch(
    publisher,
    /correctionNotice\(pullRequest\b/u,
    'never from the stale run-start snapshot',
  );

  // Behaviourally: the client serves a body that changed after the run started,
  // and the published notice must follow the NEW owner.
  const stale = pullRequest({ number: 352, body: '<!-- correction-owner: claude -->' });
  const edited = { ...stale, body: '<!-- correction-owner: cursor -->' };
  const calls = { stickies: [] };
  const client = {
    reviews: async () => [],
    reviewComments: async () => findingComments(HEAD, 2),
    pullRequest: async () => edited,
    setDraft: async (target, draft) => ({ ...target, draft }),
    setStatus: async () => {},
    updateStickyComment: async (_number, body) => calls.stickies.push(body),
  };
  await guardAgainstCurrentHeadFinding(client, stale, HEAD, null);
  assert.equal(calls.stickies.length, 1);
  assert.doesNotMatch(
    calls.stickies[0],
    /claude/iu,
    'an owner edited to cursor mid-run must not still be told Claude will fix it',
  );
});

test('C3: exactly ONE marker is required, not merely one distinct owner', async () => {
  // The documented contract — AGENTS.md, CLAUDE.md, the template — says exactly
  // one marker. The parser deduplicated first, so two identical markers passed.
  // The earlier justification (an author editing in place) was backwards:
  // editing in place produces one marker, and a duplicate comes from ADDING a
  // line, which is the same slip that produces a contradiction.
  const { parseCorrectionOwner } = await ownerModule();

  const twice = parseCorrectionOwner(
    '<!-- correction-owner: claude -->\n<!-- correction-owner: claude -->\n\n## Objective',
  );
  assert.notEqual(twice.state, 'declared', 'a repeated marker is not a valid declaration');
  assert.equal(twice.owner, null);
  assert.match(twice.detail, /exactly one/u);

  // One marker still passes, and the four-state contract is unchanged.
  assert.equal(parseCorrectionOwner('<!-- correction-owner: claude -->').state, 'declared');
});

test('C4: an exhausted unit is never asked for another head on its own branch', async () => {
  // The replacement instruction says "close this PR without another correction
  // head" and the shared non-awakenable suffix then said "…until a new head
  // appears on this branch". Following the suffix produces the prohibited third
  // correction head instead of the required replacement.
  const { correctionRouting, parseCorrectionOwner } = await ownerModule();
  const cursor = parseCorrectionOwner('<!-- correction-owner: cursor -->');

  const replacement = correctionRouting({
    declaration: cursor, head: HEAD, detail: '2 finding-bearing heads',
    reason: 'replacement', pullRequestNumber: 352,
  });
  assert.match(replacement.instruction, /replacement/iu, 'it still demands a replacement');
  assert.doesNotMatch(
    replacement.instruction,
    /new head (appears|on this branch)|push (a|one) new head/iu,
    'and never asks for another head on the exhausted branch',
  );

  // The ordinary correction path still carries the honest "nobody started this"
  // note — the fix is specialisation, not deletion.
  const review = correctionRouting({
    declaration: cursor, head: HEAD, detail: '3 findings', reason: 'review',
  });
  assert.match(review.instruction, /new head/iu);
  assert.match(review.instruction, /GitHub cannot start/iu);
});

test('C5: a malformed declaration is told to REPLACE the marker, not add one', async () => {
  // "Add exactly one marker" is correct only when none exists. Told to a PR that
  // already carries an invalid or branch-contradicting marker, following it
  // leaves two declarations in the block — which parses as contradictory and
  // keeps review-scope blocked. The recovery text must resolve the state it is
  // actually addressed to.
  const { correctionRouting, parseCorrectionOwner } = await ownerModule();

  const missing = correctionRouting({ declaration: parseCorrectionOwner(''), head: HEAD });
  assert.match(missing.instruction, /\badd\b/iu, 'nothing there yet: add one');

  for (const [label, body, headRef] of [
    ['unknown agent', '<!-- correction-owner: codex -->', 'codex/x'],
    ['two owners', '<!-- correction-owner: claude -->\n<!-- correction-owner: cursor -->', 'codex/x'],
    ['branch conflict', '<!-- correction-owner: cursor -->', 'claude/x'],
  ]) {
    const routed = correctionRouting({
      declaration: parseCorrectionOwner(body, { headRef }), head: HEAD,
    });
    assert.match(
      routed.instruction,
      /replace/iu,
      `${label}: a marker already exists, so the instruction must say replace it`,
    );
    assert.doesNotMatch(
      routed.instruction,
      /Resume action: add\b/iu,
      `${label}: telling the author to ADD leaves two declarations and stays blocked`,
    );
  }
});
