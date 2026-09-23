import { CODEX_LOGIN, requiredChecksForPullRequest } from './review-policy.mjs';
import { summarizeRequiredChecks } from './autonomous-review-gate.mjs';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import { PROBE_MARKER_PREFIX } from './codex-fix-probe.mjs';

/**
 * Role-transfer ACTIVATION EVIDENCE READER (trusted, read-only, non-activating).
 *
 * The pure activation verdict (scripts/role-activation.mjs, PR #619) must not trust caller-assembled
 * records: "the latest CI attempt", "no push since the corrective push" and "the live head" are facts about
 * GitHub at decision time, not about any stored record. This module is the trusted side of that boundary.
 * For ONE repository, ONE pull request and ONE GitHub-generated correction-request comment it reads the
 * cycle from GitHub, authenticates each source, and returns NORMALIZED evidence
 * (`ROLE_ACTIVATION_EVIDENCE_SCHEMA`). Every record carries the identity it was read under (repository, PR,
 * branch/base/head where applicable) and the server timestamp of its milestone, so the pure verdict can
 * compare every record against the caller's expected identity and enforce the full milestone order.
 *
 * Per-source authentication, reusing the repository's existing trusted adapters:
 *   - correction request  — the `issues/comments/{id}` record; its `issue_url` binds repository and PR; the
 *                           GitHub-generated `codex-fix-probe` marker names the reviewed head and the
 *                           triggering finding; the author/type say whether a bot or a human posted it.
 *   - task acceptance     — a Codex-connector 👀 reaction on THAT request comment.
 *   - findings / reviews  — `classifyClaudeShadowReview` + `GitHubClient.verifyClaudeShadowProducer`
 *                           (server-associated publisher run, trusted workflow path, artifact digest); the
 *                           finding's identity is the verified check run's own URL.
 *   - CI                  — `summarizeRequiredChecks`, the gate's newest-evidence rule (retargets and
 *                           cancelled attempts included). The initial CI is evaluated AS OF the triggering
 *                           finding; the final CI is read fresh, so a newer failed/cancelled attempt governs.
 *   - corrective push     — the repository Activity API's branch push log (server before/after/type/actor/
 *                           timestamp); ancestry from the compare API. The corrective push is the FIRST
 *                           branch update after the request; every later update is reported, so an
 *                           away-and-back return to the same SHA is still two updates.
 *   - freshness           — the live PR is read before and after the fresh reads; the window's times are
 *                           recorded so the verdict can require the reads to post-date the final review.
 *                           Window times come from the reader host (`now`), milestones from GitHub; the
 *                           freshness itself is anchored by the reads, since the final review and CI are
 *                           read already-complete inside the pass.
 *
 * It decides nothing across records: identity equality, ordering, causation and freshness are the pure
 * verdict's rules. A source that cannot be read or authenticated yields `null` (never a partial record that
 * could pass) and a diagnostic in `problems`; the reader never throws on a GitHub error.
 *
 * READ-ONLY and NON-ACTIVATING: it issues only GET requests and the producer-verification reads, writes no
 * status, comment, label, branch or setting, is wired to no workflow, gate or routing, and grants nothing.
 * `codex-current-head` stays the required gate. It does not observe a replacement-gate installation (none
 * exists yet), so it never supplies the verdict's separate retirement proof.
 */

export const ROLE_ACTIVATION_EVIDENCE_SCHEMA = 'pmcvitan.role-activation-evidence.v1';
export const GITHUB_ACTIONS_LOGIN = 'github-actions[bot]';
// Observed-behaviour assumption, fail closed: the Codex connector acknowledges a task with 👀 on the
// triggering comment. Any other reaction, or one from another account, is not acceptance.
export const CODEX_ACCEPTANCE_REACTION = 'eyes';
// One page of the branch push log. A full page that does not reach back past the request is TRUNCATED
// (reported, not guessed): the corrective push cannot be identified without the whole window.
export const PUSH_LOG_PAGE_SIZE = 100;

const SHA = /^[0-9a-f]{40}$/u;
const MARKER = new RegExp(
  `<!-- ${PROBE_MARKER_PREFIX}:pr-(\\d+):head-([0-9a-f]{40}):finding-(\\S+) -->`,
  'gu',
);

function timeMs(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The one `codex-fix-probe` marker in a request body, or null (none, several, or no `@codex fix` line). */
export function parseProbeMarker(body) {
  if (typeof body !== 'string') return null;
  const matches = [...body.matchAll(MARKER)];
  if (matches.length !== 1 || !/(^|\n)@codex fix(\n|$)/u.test(body)) return null;
  const [, pullRequest, headSha, findingRef] = matches[0];
  return { pullRequest: Number(pullRequest), headSha, findingRef };
}

/** The correction-request comment, bound to this repository and PR by its server `issue_url`. */
export function normalizeCorrectionRequest(comment, { repository, pullRequest }) {
  if (!comment || !Number.isInteger(comment.id)) return null;
  if (comment.issue_url !== `https://api.github.com/repos/${repository}/issues/${pullRequest}`) return null;
  const marker = parseProbeMarker(comment.body);
  const atMs = timeMs(comment.created_at);
  if (!marker || marker.pullRequest !== pullRequest || atMs === null) return null;
  return {
    repository,
    pullRequest,
    requestId: comment.id,
    authorLogin: comment.user?.login ?? null,
    githubGenerated: comment.user?.login === GITHUB_ACTIONS_LOGIN && comment.user?.type === 'Bot',
    humanAuthored: comment.user?.type !== 'Bot',
    // An edit after creation could re-point the finding or head; the verdict refuses an edited request.
    edited: comment.updated_at !== comment.created_at,
    headSha: marker.headSha,
    findingRef: marker.findingRef,
    atMs,
  };
}

/** The earliest Codex-connector acceptance reaction on the request comment itself. */
export function normalizeAcceptance(reactions, request) {
  if (!request || !Array.isArray(reactions)) return null;
  const [first] = reactions
    .filter((reaction) => reaction?.user?.login === CODEX_LOGIN
      && reaction.user.type === 'Bot'
      && reaction.content === CODEX_ACCEPTANCE_REACTION
      && timeMs(reaction.created_at) !== null)
    .sort((a, b) => timeMs(a.created_at) - timeMs(b.created_at));
  if (!first) return null;
  return {
    repository: request.repository,
    pullRequest: request.pullRequest,
    requestId: request.requestId,
    actorLogin: first.user.login,
    atMs: timeMs(first.created_at),
  };
}

/**
 * The branch push log since the request. The corrective push is the FIRST update after the request; every
 * later update is listed (an away-and-back return to the same SHA is two entries). The log is branch-scoped;
 * the record also names the PR whose live head ref the branch was resolved from, so it carries the same
 * repository+PR identity as every other record. Returns
 * `{ correctivePush: null, truncated }` when the window is not fully covered or holds no update.
 */
export function normalizePushLog(activities, { repository, pullRequest, branch, sinceMs }) {
  if (!Array.isArray(activities) || typeof branch !== 'string' || !Number.isFinite(sinceMs)) {
    return { correctivePush: null, pushesAfterCorrective: null, truncated: false };
  }
  const ref = `refs/heads/${branch}`;
  const dated = activities
    .filter((activity) => activity?.ref === ref && timeMs(activity.timestamp) !== null)
    .map((activity) => ({ activity, atMs: timeMs(activity.timestamp) }))
    .sort((a, b) => (a.atMs - b.atMs) || (a.activity.id - b.activity.id));
  // Covered only when the page was not full, or it reaches back to (or before) the request.
  const truncated = activities.length >= PUSH_LOG_PAGE_SIZE && !(dated[0] && dated[0].atMs <= sinceMs);
  const since = dated.filter((entry) => entry.atMs > sinceMs);
  if (truncated || since.length === 0) return { correctivePush: null, pushesAfterCorrective: null, truncated };
  const describe = ({ activity, atMs }) => ({
    activityId: activity.id,
    activityType: activity.activity_type ?? null,
    actorLogin: activity.actor?.login ?? null,
    beforeSha: activity.before ?? null,
    afterSha: activity.after ?? null,
    atMs,
  });
  return {
    correctivePush: { repository, pullRequest, branch, ...describe(since[0]), ancestry: null },
    pushesAfterCorrective: since.slice(1).map(describe),
    truncated: false,
  };
}

/** Server-computed ancestry of the corrective head relative to the reviewed head. */
export function normalizeAncestry(comparison) {
  if (!comparison || typeof comparison.status !== 'string') return null;
  return {
    status: comparison.status,
    aheadBy: Number.isInteger(comparison.ahead_by) ? comparison.ahead_by : null,
    behindBy: Number.isInteger(comparison.behind_by) ? comparison.behind_by : null,
    mergeBaseSha: comparison.merge_base_commit?.sha ?? null,
  };
}

/**
 * A producer-verified shadow review, normalized. Identity fields come from the authenticated summary and the
 * verified check run; a classification without an admitted run carries its state only (no identity), so it
 * cannot satisfy any identity rule.
 */
export function normalizeShadowReview(classification, checkRuns) {
  if (!classification) return null;
  if (!Number.isInteger(classification.runId)) return { state: classification.state ?? null };
  const run = (checkRuns ?? []).find((candidate) => candidate?.id === classification.runId);
  let summary;
  try {
    summary = JSON.parse(run?.output?.summary ?? '');
  } catch {
    return { state: 'malformed' };
  }
  return {
    repository: summary.repository ?? null,
    pullRequest: summary.pullRequest ?? null,
    baseSha: summary.baseSha ?? null,
    testedBaseSha: summary.testedBaseSha ?? null,
    headSha: summary.headSha ?? null,
    state: classification.state,
    findingCount: classification.findingCount ?? 0,
    reviewRef: typeof run.html_url === 'string' ? run.html_url : null,
    checkRunId: run.id,
    atMs: timeMs(run.completed_at),
  };
}

/**
 * Check runs as they stood at `asOfMs`: runs started later are dropped, and runs still unfinished then are
 * reported unfinished. `null` means "now" (every run, as read).
 */
export function checkRunsAsOf(checkRuns, asOfMs) {
  if (asOfMs === null) return checkRuns;
  return checkRuns.flatMap((run) => {
    const started = timeMs(run?.started_at) ?? timeMs(run?.completed_at);
    if (started === null || started >= asOfMs) return [];
    const completed = timeMs(run?.completed_at);
    if (run?.status === 'completed' && completed !== null && completed < asOfMs) return [run];
    return [{ ...run, status: 'in_progress', conclusion: null, completed_at: null }];
  });
}

/** Required CI for one head under the gate's newest-evidence rule, dated by its newest completion. */
export function normalizeCi(checkRuns, { repository, pullRequest, headSha, baseSha, asOfMs = null, readAtMs }) {
  if (!Array.isArray(checkRuns) || !SHA.test(headSha ?? '')) return null;
  const required = requiredChecksForPullRequest(pullRequest);
  const runs = checkRunsAsOf(checkRuns.filter((run) => run?.head_sha === headSha), asOfMs);
  const summary = summarizeRequiredChecks(runs, required);
  const completions = runs
    .filter((run) => required.includes(run.name) && run.status === 'completed')
    .map((run) => timeMs(run.completed_at))
    .filter((time) => time !== null);
  return {
    repository,
    pullRequest,
    baseSha: baseSha ?? null,
    headSha,
    state: summary.state,
    missing: summary.missing,
    pending: summary.pending,
    failed: summary.failed,
    atMs: completions.length > 0 ? Math.max(...completions) : null,
    readAtMs,
  };
}

/**
 * Read one correction cycle. `client` is a `GitHubClient` (only `repository`, `request`, `pullRequest`,
 * `checkRuns` and `verifyClaudeShadowProducer` are used). `now` is injectable for tests.
 */
export async function readRoleActivationEvidence(
  client,
  { pullRequest, requestCommentId, now = () => Date.now() } = {},
) {
  const problems = [];
  const read = async (label, operation) => {
    try {
      return await operation();
    } catch (error) {
      problems.push(`${label}: ${error?.message ?? String(error)}`);
      return null;
    }
  };
  const repository = client?.repository;
  const empty = { initialCi: null, initialFinding: null, request: null, acceptance: null,
    correctivePush: null, finalCi: null, finalReview: null, freshness: null };
  if (typeof repository !== 'string' || !Number.isInteger(pullRequest) || pullRequest <= 0
    || !Number.isInteger(requestCommentId)) {
    return { schema: ROLE_ACTIVATION_EVIDENCE_SCHEMA, cycle: null, records: empty, problems: ['invalid reader input'] };
  }
  const verifyProducer = (run, evidence) => client.verifyClaudeShadowProducer(run, evidence);
  const review = (checkRuns, headSha, baseSha) => read(`review@${headSha}`, () => classifyClaudeShadowReview({
    checkRuns,
    expectedHead: headSha,
    expectedBase: baseSha,
    pullRequestNumber: pullRequest,
    verifyProducer,
  }));

  // Historical legs: the request, its acceptance.
  const requestComment = await read('request', () =>
    client.request(`/repos/${repository}/issues/comments/${requestCommentId}`));
  const request = normalizeCorrectionRequest(requestComment, { repository, pullRequest });
  const reactions = request
    ? await read('acceptance', () =>
      client.request(`/repos/${repository}/issues/comments/${request.requestId}/reactions?per_page=100`))
    : null;
  const acceptance = normalizeAcceptance(reactions, request);

  // The freshness pass: live PR, then every live-state read, then the live PR again.
  const startedAtMs = now();
  const pullAtStart = await read('pull', () => client.pullRequest(pullRequest));
  const branch = typeof pullAtStart?.head?.ref === 'string' ? pullAtStart.head.ref : null;
  const baseSha = SHA.test(pullAtStart?.base?.sha ?? '') ? pullAtStart.base.sha : null;
  const originalHeadSha = request?.headSha ?? null;

  // Initial legs on the reviewed head, bound to the cycle base; CI is evaluated as of the finding.
  let initialFinding = null;
  let initialCi = null;
  if (originalHeadSha && baseSha) {
    const originalRuns = await read('original-check-runs', () => client.checkRuns(originalHeadSha));
    if (originalRuns) {
      initialFinding = normalizeShadowReview(await review(originalRuns, originalHeadSha, baseSha), originalRuns);
      if (Number.isFinite(initialFinding?.atMs)) {
        initialCi = normalizeCi(originalRuns, {
          repository,
          pullRequest,
          headSha: originalHeadSha,
          baseSha: initialFinding.testedBaseSha,
          asOfMs: initialFinding.atMs,
          readAtMs: now(),
        });
      }
    }
  }

  // The branch push log: the corrective push and every later update.
  const activities = branch && request
    ? await read('push-log', () => client.request(
      `/repos/${repository}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}`
        + `&direction=desc&per_page=${PUSH_LOG_PAGE_SIZE}`,
    ))
    : null;
  const pushLogReadAtMs = now();
  const log = request
    ? normalizePushLog(activities, { repository, pullRequest, branch, sinceMs: request.atMs })
    : { correctivePush: null, pushesAfterCorrective: null, truncated: false };
  if (log.truncated) problems.push('push-log: page does not reach back to the request (truncated)');
  const correctivePush = log.correctivePush;
  const correctiveHeadSha = SHA.test(correctivePush?.afterSha ?? '') ? correctivePush.afterSha : null;
  if (correctivePush && originalHeadSha && correctiveHeadSha) {
    correctivePush.ancestry = normalizeAncestry(await read('ancestry', () =>
      client.request(`/repos/${repository}/compare/${originalHeadSha}...${correctiveHeadSha}`)));
  }

  // Final legs on the corrective head, read fresh: the newest shadow review and the latest applicable CI.
  let finalReview = null;
  let finalCi = null;
  if (correctiveHeadSha && baseSha) {
    const finalRuns = await read('final-check-runs', () => client.checkRuns(correctiveHeadSha));
    const readAtMs = now();
    if (finalRuns) {
      finalReview = normalizeShadowReview(await review(finalRuns, correctiveHeadSha, baseSha), finalRuns);
      if (finalReview) finalReview.readAtMs = readAtMs;
      finalCi = normalizeCi(finalRuns, {
        repository,
        pullRequest,
        headSha: correctiveHeadSha,
        baseSha: finalReview?.testedBaseSha ?? null,
        readAtMs,
      });
    }
  }

  const pullAtEnd = await read('pull-recheck', () => client.pullRequest(pullRequest));
  const observedAtMs = now();
  const freshness = pullAtStart && pullAtEnd
    ? {
      repository,
      pullRequest,
      branch,
      baseSha,
      headRepository: pullAtStart.head?.repo?.full_name ?? null,
      baseRepository: pullAtStart.base?.repo?.full_name ?? null,
      baseRef: pullAtStart.base?.ref ?? null,
      prState: pullAtEnd.state ?? null,
      liveHeadAtStart: pullAtStart.head?.sha ?? null,
      liveHeadAtEnd: pullAtEnd.head?.sha ?? null,
      branchAtEnd: pullAtEnd.head?.ref ?? null,
      baseShaAtEnd: pullAtEnd.base?.sha ?? null,
      pushesAfterCorrective: log.pushesAfterCorrective,
      pushLogReadAtMs,
      startedAtMs,
      observedAtMs,
    }
    : null;

  return {
    schema: ROLE_ACTIVATION_EVIDENCE_SCHEMA,
    cycle: {
      repository,
      pullRequest,
      branch,
      baseSha,
      originalHeadSha,
      correctiveHeadSha,
      correctionRequestId: request?.requestId ?? null,
    },
    records: { initialCi, initialFinding, request, acceptance, correctivePush, finalCi, finalReview, freshness },
    problems,
  };
}
