import assert from 'node:assert/strict';

import {
  ACTIVITY_PERIODS,
  CODEX_ACCEPTANCE_REACTION,
  GITHUB_ACTIONS_LOGIN,
  readRoleActivationEvidence,
} from './role-activation-evidence.mjs';
import { codexFixComment, probeMarker, probeTrailer } from './codex-fix-probe.mjs';
import { evidenceArtifactName } from './claude-shadow-review.mjs';
import { CODEX_LOGIN, REQUIRED_CHECKS } from './review-policy.mjs';

// Shared test fixture (not a test file): a full, valid role-transfer correction cycle as GitHub would serve
// it, a read-only fake GitHubClient over it, and a deterministic clock. Used by the reader's tests and by the
// verdict's end-to-end tests, so both exercise the same normalized evidence.

export const REPO = 'JagPat/PMCvitan';
export const PR = 619;
export const BRANCH = 'claude/x';
export const BASE = 'b'.repeat(40);
export const ORIGINAL = 'a'.repeat(40);
export const CORRECTIVE = 'c'.repeat(40);
export const OTHER = 'e'.repeat(40);
export const REQUEST_ID = 5001;
export const at = (hhmm) => `2026-09-23T${hhmm}:00Z`;
export const ms = (hhmm) => Date.parse(at(hhmm));

let nextId = 1;
export function ciRuns(headSha, { start = '10:00', end = '10:05', suite = 1, conclusion = 'success' } = {}) {
  return REQUIRED_CHECKS.map((name) => ({
    id: nextId++,
    name,
    head_sha: headSha,
    status: 'completed',
    conclusion,
    started_at: at(start),
    completed_at: at(end),
    check_suite: { id: suite },
  }));
}

export function shadowRun(headSha, { id, completed, state }) {
  const findingCount = state === 'clear' ? 0 : 1;
  const summary = {
    schema: 1,
    repository: REPO,
    pullRequest: PR,
    baseSha: BASE,
    headSha,
    testedBaseSha: BASE,
    runId: 100 + id,
    runAttempt: 1,
    publisherRunId: 200 + id,
    publisherRunAttempt: 1,
    workflowRef: `${REPO}/.github/workflows/claude-shadow-review.yml@refs/heads/main`,
    workflowSha: BASE,
    workflowExecutionRef: 'refs/heads/main',
    state,
    findingCount,
  };
  summary.artifact = {
    id: 300 + id,
    digest: `sha256:${'d'.repeat(64)}`,
    name: evidenceArtifactName(summary, summary, { state, findings: Array.from({ length: findingCount }) }),
  };
  return {
    id,
    name: 'claude-independent-review',
    head_sha: headSha,
    html_url: `https://github.com/${REPO}/runs/${id}`,
    app: { slug: 'github-actions' },
    external_id: `pmcvitan:claude-shadow:v1:repo-${REPO}:pr-${PR}:base-${BASE}:head-${headSha}:run-${summary.runId}`
      + `:attempt-1:publisher-${summary.publisherRunId}:publisher-attempt-1`,
    status: 'completed',
    conclusion: state === 'clear' ? 'success' : 'failure',
    started_at: completed,
    completed_at: completed,
    output: { summary: JSON.stringify(summary) },
  };
}

export const INITIAL_FINDING_RUN = 7001;
export const FINDING_REF = `https://github.com/${REPO}/runs/${INITIAL_FINDING_RUN}`;

export function requestComment(overrides = {}) {
  const marker = probeMarker({ pullRequest: PR, headSha: ORIGINAL, findingRef: FINDING_REF });
  return {
    id: REQUEST_ID,
    issue_url: `https://api.github.com/repos/${REPO}/issues/${PR}`,
    user: { login: GITHUB_ACTIONS_LOGIN, type: 'Bot' },
    created_at: at('10:30'),
    updated_at: at('10:30'),
    body: codexFixComment({ pullRequestNumber: PR, headSha: ORIGINAL, sourceBranch: BRANCH, findingRef: FINDING_REF, marker }),
    ...overrides,
  };
}

export function pull(headSha = CORRECTIVE, overrides = {}) {
  return {
    number: PR,
    state: 'open',
    head: { ref: BRANCH, sha: headSha, repo: { full_name: REPO } },
    base: { ref: 'main', sha: BASE, repo: { full_name: REPO } },
    ...overrides,
  };
}

export function activity(id, before, after, hhmm, { type = 'push', actor = CODEX_LOGIN } = {}) {
  return { id, before, after, ref: `refs/heads/${BRANCH}`, timestamp: at(hhmm), activity_type: type, actor: { login: actor } };
}

// A commit of the corrective push, as the compare API returns it, carrying the request's binding trailer.
export const BINDING_TRAILER = probeTrailer({ pullRequest: PR, headSha: ORIGINAL, findingRef: FINDING_REF });
export function correctiveCommit(sha, message = `fix: correct the finding\n\n${BINDING_TRAILER}`) {
  return { sha, author: { login: CODEX_LOGIN }, commit: { message } };
}

// An item of the PR's conversation, as the issue-comment, review-comment or review API returns it.
export function conversationItem(id, login, hhmm, body = 'ok', { updated = hhmm } = {}) {
  return { id, user: { login }, created_at: at(hhmm), updated_at: at(updated), submitted_at: at(hhmm), body };
}

// A full, valid cycle as GitHub would serve it.
export function world() {
  return {
    comment: requestComment(),
    reactions: [{ user: { login: CODEX_LOGIN, type: 'Bot' }, content: CODEX_ACCEPTANCE_REACTION, created_at: at('10:31') }],
    runs: {
      [ORIGINAL]: [...ciRuns(ORIGINAL), shadowRun(ORIGINAL, { id: INITIAL_FINDING_RUN, completed: at('10:20'), state: 'changes_required' })],
      [CORRECTIVE]: [...ciRuns(CORRECTIVE, { start: '10:51', end: '11:00', suite: 2 }), shadowRun(CORRECTIVE, { id: 7002, completed: at('11:20'), state: 'clear' })],
    },
    // newest first, as the Activity API returns it
    activities: [activity(900, ORIGINAL, CORRECTIVE, '10:50'), activity(800, OTHER, ORIGINAL, '09:00', { actor: 'JagPat' })],
    comparison: {
      status: 'ahead', ahead_by: 2, behind_by: 0, merge_base_commit: { sha: ORIGINAL }, total_commits: 2,
      commits: [correctiveCommit('1'.repeat(40)), correctiveCommit(CORRECTIVE)],
    },
    pulls: [pull(), pull()],
    // the pull request's issue events, oldest first, as GitHub returns them
    events: [issueEvent(40, 'labeled', '09:30'), issueEvent(41, 'base_ref_changed', '08:40')],
    // The PR's conversation: the owner's comment BEFORE the branch reached the reviewed head (09:00), the
    // controller's state comment (edited through the cycle, no @codex), the request itself, and Codex's own
    // review with its "@codex review" boilerplate.
    conversation: {
      issue_comment: [
        conversationItem(61, 'JagPat', '08:30', 'Looks good so far.'),
        conversationItem(62, GITHUB_ACTIONS_LOGIN, '08:50', '<!-- autonomous-review-state --> waiting for Codex', { updated: '11:30' }),
        conversationItem(REQUEST_ID, GITHUB_ACTIONS_LOGIN, '10:30', '@codex fix'),
      ],
      review_comment: [conversationItem(63, CODEX_LOGIN, '11:25', 'P2: nit')],
      review: [conversationItem(64, CODEX_LOGIN, '11:25', 'Comment "@codex review".')],
    },
    verify: true,
  };
}

export function issueEvent(id, event, hhmm, actor = 'JagPat') {
  return { id, event, actor: { login: actor }, created_at: at(hhmm) };
}

// The Activity API's trailing period, as the server applies it (a day unless `time_period` says otherwise).
const SERVER_NOW = ms('12:00');
function activityPage(w, path) {
  const period = new URL(path, 'https://api.github.com').searchParams.get('time_period') ?? 'day';
  const days = Object.fromEntries(ACTIVITY_PERIODS)[period];
  return w.activities.filter((entry) => Date.parse(entry.timestamp) > SERVER_NOW - days * 86_400_000);
}

// A fake GitHubClient. It records every request and refuses anything but a GET, so a test also proves the
// reader is read-only. `w.after` hooks run after the nth read of a kind, so a test can interleave a change
// between two of the reader's own reads (a barrier).
export function client(w) {
  const calls = [];
  const counts = { pull: 0, activity: 0, comment: 0, events: 0 };
  const after = (kind) => w.after?.[kind]?.[(counts[kind] += 1)]?.(w);
  const fake = {
    repository: REPO,
    async request(path, { method = 'GET' } = {}) {
      calls.push(path);
      if (method !== 'GET') throw new Error(`write attempted: ${method} ${path}`);
      if (path === `/repos/${REPO}/issues/comments/${REQUEST_ID}`) {
        const comment = w.comment;
        after('comment');
        if (!comment && w.emptyAnswer) return null;
        if (!comment) throw new Error('Not Found');
        return comment;
      }
      if (path.startsWith(`/repos/${REPO}/issues/comments/${REQUEST_ID}/reactions`)) return w.reactions;
      if (path.startsWith(`/repos/${REPO}/activity?`)) {
        const page = activityPage(w, path);
        after('activity');
        return page;
      }
      if (path.startsWith(`/repos/${REPO}/compare/`)) return w.comparison;
      const talk = /^\/repos\/JagPat\/PMCvitan\/(?:issues|pulls)\/619\/(comments|reviews)\?per_page=(\d+)&page=(\d+)$/u.exec(path);
      if (talk) {
        const kind = talk[1] === 'reviews' ? 'review' : path.includes('/issues/') ? 'issue_comment' : 'review_comment';
        if (w.conversationError?.[kind]) throw new Error(w.conversationError[kind]);
        const [size, page] = [Number(talk[2]), Number(talk[3])];
        const items = w.conversation[kind];
        return Array.isArray(items) ? items.slice((page - 1) * size, page * size) : items;
      }
      const events = /^\/repos\/JagPat\/PMCvitan\/issues\/619\/events\?per_page=(\d+)&page=(\d+)$/u.exec(path);
      if (events) {
        if (w.eventsError) throw new Error(w.eventsError);
        const [size, page] = [Number(events[1]), Number(events[2])];
        const items = w.events.slice((page - 1) * size, page * size);
        after('events');
        return items;
      }
      throw new Error(`unexpected ${path}`);
    },
    async pullRequest(number) {
      assert.equal(number, PR);
      const live = w.pulls.shift() ?? pull();
      after('pull');
      return live;
    },
    async checkRuns(sha) {
      return [...(w.runs[sha] ?? [])];
    },
    async verifyClaudeShadowProducer(run) {
      return typeof w.verify === 'function' ? w.verify(run) : w.verify;
    },
  };
  return { fake, calls };
}

export function clock() {
  let t = ms('12:00');
  return () => (t += 1_000);
}

export async function readWorld(mutate = () => {}) {
  const w = world();
  mutate(w);
  const { fake, calls } = client(w);
  const evidence = await readRoleActivationEvidence(fake, { pullRequest: PR, requestCommentId: REQUEST_ID, now: clock() });
  return { evidence, calls };
}
