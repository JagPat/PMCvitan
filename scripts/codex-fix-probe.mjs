import { appendFileSync, readFileSync } from 'node:fs';

import { asciiTrim, gitParsedTrailers } from './correction-owner.mjs';
import { CODEX_LOGIN, LINEAGE_BASE_REF } from './review-policy.mjs';

/**
 * Bounded, manual-only correction-boundary probe.
 *
 * The official Codex docs describe `@codex fix` on a review comment starting a cloud task that can
 * push to the PR branch with permission. They do NOT establish that a comment authored by
 * `github-actions[bot]` (rather than a human) is accepted, nor that unattended publication happens
 * without a manual control. This probe does not assume those facts — it measures them: it posts
 * exactly ONE `@codex fix` request for one operator-armed PR/head/finding and records the created
 * comment id and its real author as dispatch evidence. Whether Codex acts, and whether it pushes a
 * commit rather than only returning a diff or requiring "Update branch", is observed afterwards from
 * the branch and the task, never asserted here.
 *
 * It is `workflow_dispatch`-only and restricted to the trusted default branch (`main`), uses only the
 * ordinary `GITHUB_TOKEN` with `contents: read` + `pull-requests: write`, and writes nothing but one
 * PR comment: no AI credential, no required-status write, no branch update, no merge. Two safety
 * layers cover an overlapping double dispatch: a non-cancelling per-PR workflow concurrency group
 * serializes runs, and the recheck-then-dedup here (keyed per PR/head, across finding ids) refuses a
 * second post once the first is visible. A repeated read is not itself an atomic lock, which is why
 * the concurrency group — asserted in the workflow test — is required, not optional.
 */

const SHA = /^[0-9a-f]{40}$/u;
const SEVERITY = /\bP[12]\b/u;

export const PROBE_MARKER_PREFIX = 'codex-fix-probe';

/** Per PR and head. Dedup keys on this prefix so a second dispatch for the same head — even naming a
 * different finding id — cannot spawn a competing task. The finding id is retained for traceability. */
export function dedupPrefix({ pullRequest, headSha }) {
  return `<!-- ${PROBE_MARKER_PREFIX}:pr-${pullRequest}:head-${headSha}:`;
}
export function probeMarker({ pullRequest, headSha, findingRef }) {
  return `${dedupPrefix({ pullRequest, headSha })}finding-${findingRef} -->`;
}

/**
 * The commit trailer the correction request asks a corrective task to put on every commit it pushes. It
 * repeats the request's own identity (PR, reviewed head, finding). It is NOT a task identifier: it is printed
 * in the public request comment, so another Codex task started on the same head could be told to copy it,
 * and every Codex task pushes as the same connector bot. It is therefore necessary, never sufficient, for
 * task -> push causation: a commit without it is not this request's, but a commit with it is not thereby
 * proven to be. Nothing may prove `codexTaskCausation` from it alone; the reader only reports it.
 */
export const PROBE_TRAILER_KEY = 'Codex-Fix-Probe';
export function probeTrailerValue({ pullRequest, headSha, findingRef }) {
  return `pr-${pullRequest}:head-${headSha}:finding-${findingRef}`;
}
export function probeTrailer(identity) {
  return `${PROBE_TRAILER_KEY}: ${probeTrailerValue(identity)}`;
}
/**
 * The `Codex-Fix-Probe` values in a commit message's TERMINAL trailer block, in order, read as
 * `git interpret-trailers --parse --unfold` reads them (extraction delegated to git, like the
 * `Correction-Owner` trailer). A value quoted in prose or a code fence, or anywhere but the terminal
 * block, is not a trailer; a folded continuation is joined into its value, so the value no longer equals
 * the requested one. Keys match case-insensitively, as git's do, so a differently-cased trailer is still
 * reported. `[]` when there is none; `null` when the message is missing or git cannot run (unreadable,
 * never "none").
 */
export function probeTrailersIn(message) {
  if (typeof message !== 'string') return null;
  const trailers = gitParsedTrailers(message);
  if (trailers === null) return null;
  return trailers
    .filter((trailer) => trailer.key.toLowerCase() === PROBE_TRAILER_KEY.toLowerCase())
    .map((trailer) => asciiTrim(trailer.value));
}

/** The operator must type this exact value to arm ONE PR at ONE head — a careless dispatch, or a
 * dispatch whose head has since moved, cannot match it. */
export function expectedAuthorization({ pullRequest, headSha }) {
  return `arm-pr-${pullRequest}-head-${headSha}`;
}

/** The PR number a review comment belongs to, parsed from the server-provided `pull_request_url`
 * (`.../pulls/<n>`). A repository-wide comment fetch does not bind to a PR on its own, so this is
 * how the finding is tied to the exact target PR. */
export function pullNumberFromUrl(url) {
  const match = /\/pulls\/(\d+)(?:$|\/|\?)/u.exec(String(url ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * A genuine, still-unresolved finding on THIS PR and head. Every clause is required:
 *  - authored by Codex, on this exact head, carrying a P1/P2 severity;
 *  - bound to the target PR by the comment's own `pull_request_url` (not merely fetched by id, which
 *    is repository-wide and could belong to another PR on the same commit);
 *  - the comment's review thread is really UNRESOLVED. `threadUnresolved` is the GraphQL resolution
 *    state: `true` unresolved, `false` resolved, `null` unavailable. Only `true` passes — a resolved
 *    thread or an unavailable/missing resolution fails closed. A failing `codex-current-head` status
 *    is deliberately NOT used, because it can fail for scope or a different finding entirely.
 */
export function isGenuineUnresolvedFinding({ findingComment, headSha, pullRequestNumber, threadUnresolved }) {
  const commentHead = findingComment?.original_commit_id ?? findingComment?.commit_id;
  return Boolean(
    findingComment
    && findingComment.user?.login === CODEX_LOGIN
    && commentHead === headSha
    && typeof findingComment.body === 'string'
    && SEVERITY.test(findingComment.body)
    && pullNumberFromUrl(findingComment.pull_request_url) === pullRequestNumber
    && threadUnresolved === true,
  );
}

/**
 * Decide whether to post. Every check is fail-closed; the only success is an open, same-repository
 * PR targeting main whose live head equals the armed head, with a matching authorization token, a
 * genuine unresolved finding bound to this PR, and no existing probe comment for the same PR/head.
 */
export function authorizeCodexFixDispatch({
  repository,
  pullRequestNumber,
  headSha,
  findingRef,
  authorization,
  livePull,
  findingComment,
  threadUnresolved,
  existingComments = [],
}) {
  if (
    !SHA.test(headSha ?? '')
    || typeof findingRef !== 'string'
    || findingRef.length === 0
    || authorization !== expectedAuthorization({ pullRequest: pullRequestNumber, headSha })
    || livePull?.state !== 'open'
    || livePull?.number !== pullRequestNumber
    || livePull?.head?.sha !== headSha
    || livePull?.head?.repo?.full_name !== repository
    || livePull?.base?.ref !== LINEAGE_BASE_REF
    || livePull?.base?.repo?.full_name !== repository
    || !isGenuineUnresolvedFinding({ findingComment, headSha, pullRequestNumber, threadUnresolved })
  ) {
    return { allowed: false, state: 'unauthorized_or_stale' };
  }
  const prefix = dedupPrefix({ pullRequest: pullRequestNumber, headSha });
  if (existingComments.some((comment) => typeof comment?.body === 'string' && comment.body.includes(prefix))) {
    return { allowed: false, state: 'duplicate' };
  }
  return {
    allowed: true,
    state: 'ready',
    marker: probeMarker({ pullRequest: pullRequestNumber, headSha, findingRef }),
    sourceBranch: livePull.head.ref,
  };
}

export function codexFixComment({ pullRequestNumber, headSha, sourceBranch, findingRef, marker }) {
  return [
    marker,
    '@codex fix',
    '',
    `Corrective push requested for PR #${pullRequestNumber} at exact head \`${headSha}\` on source branch \`${sourceBranch}\`.`,
    '',
    `Finding to correct: ${findingRef}`,
    '',
    'Before editing, verify the remote branch still has this exact head '
      + `(\`${headSha}\`). If it has advanced, STOP and report stale-dispatch evidence instead of `
      + 'editing a different head.',
    '',
    'Requirements: push the corrective commit to that source branch (do not open a new PR); '
      + 'preserve every other open finding and do not resolve, overwrite, or hide them; do not touch '
      + 'branch protection, required statuses, or unrelated code.',
    '',
    'End the message of EVERY commit you push for this request with this exact trailer line, on its own '
      + 'line in the final trailer block, unchanged (it identifies this request on your commits):',
    '',
    '```',
    probeTrailer({ pullRequest: pullRequestNumber, headSha, findingRef }),
    '```',
    '',
    'This is a one-time, bounded correction-boundary probe. It is dispatch evidence only — no review '
      + 'clearance is implied, and the shadow review remains non-authoritative.',
    '',
    '---',
    '_Generated by [Claude Code](https://claude.ai/code)_',
  ].join('\n');
}

// ── production GitHub API seam ────────────────────────────────────────────────────────────────
function restClient(token) {
  return async (path, options = {}) => {
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...options.headers,
      },
    });
    if (!response.ok) throw new Error(`GitHub ${options.method ?? 'GET'} ${path}: ${response.status}`);
    return response.json();
  };
}

async function graphqlThreadUnresolved({ rest, repository, prNumber, commentId }) {
  const [owner, name] = repository.split('/');
  let after = null;
  do {
    const data = await rest('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($owner:String!,$name:String!,$number:Int!,$after:String){
          repository(owner:$owner,name:$name){ pullRequest(number:$number){
            reviewThreads(first:50, after:$after){
              nodes { isResolved comments(first:100){ nodes { databaseId } } }
              pageInfo { hasNextPage endCursor }
            } } } }`,
        variables: { owner, name, number: prNumber, after },
      }),
    });
    const page = data?.data?.repository?.pullRequest?.reviewThreads;
    if (!page) return null; // unavailable → fail closed
    for (const thread of page.nodes) {
      if ((thread.comments?.nodes ?? []).some((comment) => comment.databaseId === commentId)) {
        return thread.isResolved === false; // true = unresolved
      }
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return null; // the comment's thread was not found → stale/unavailable → fail closed
}

function productionApi(token) {
  const rest = restClient(token);
  return {
    getPull: (repository, number) => rest(`/repos/${repository}/pulls/${number}`),
    getReviewComment: (repository, id) => rest(`/repos/${repository}/pulls/comments/${id}`),
    threadUnresolved: (repository, prNumber, commentId) =>
      graphqlThreadUnresolved({ rest, repository, prNumber, commentId }),
    async listComments(repository, number) {
      const comments = [];
      for (let page = 1; ; page += 1) {
        const batch = await rest(`/repos/${repository}/issues/${number}/comments?per_page=100&page=${page}`);
        comments.push(...batch);
        if (batch.length < 100) return comments;
      }
    },
    postComment: (repository, number, body) => rest(`/repos/${repository}/issues/${number}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    }),
  };
}

/**
 * The dispatch seam. `env`, `loadEvent`, `api`, `writeOutput` are injected so a barrier test can
 * drive two overlapping dispatches through the real recheck-then-post path. `onBeforePost` is the
 * barrier hook: production leaves it a no-op; a test releases the competing run there to prove the
 * second dispatch dedups once the first has posted.
 */
export async function runDispatch({ env, loadEvent, api, writeOutput = () => {}, onBeforePost = async () => {} }) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('not_workflow_dispatch');
  if (env.GITHUB_REF !== `refs/heads/${LINEAGE_BASE_REF}`) throw new Error('untrusted_ref');
  const event = loadEvent();
  const repository = event?.repository?.full_name;
  const pullRequestNumber = Number(env.PROBE_PR_NUMBER);
  const headSha = env.PROBE_HEAD_SHA;
  const findingCommentId = Number(env.PROBE_FINDING_COMMENT_ID);
  const authorization = env.PROBE_AUTHORIZATION ?? '';
  if (!Number.isInteger(pullRequestNumber) || !Number.isInteger(findingCommentId)) {
    throw new Error('pr_number and finding_comment_id must be integers');
  }

  const livePull = await api.getPull(repository, pullRequestNumber);
  const findingComment = await api.getReviewComment(repository, findingCommentId);
  const threadUnresolved = await api.threadUnresolved(repository, pullRequestNumber, findingCommentId);
  const findingRef = findingComment?.html_url ?? `comment-${findingCommentId}`;
  const existingComments = await api.listComments(repository, pullRequestNumber);

  const authorized = authorizeCodexFixDispatch({
    repository,
    pullRequestNumber,
    headSha,
    findingRef,
    authorization,
    livePull,
    findingComment,
    threadUnresolved,
    existingComments,
  });
  if (!authorized.allowed) throw new Error(authorized.state);

  await onBeforePost();

  // Recheck immediately before posting by re-fetching ALL inputs and re-running the COMPLETE
  // authorizer, not just open+head. State can change during the window: the thread can be resolved,
  // the PR can be retargeted off main, the finding body can be withdrawn, or an overlapping dispatch
  // can post first. Any of those must abort here. The comment is rendered from the refreshed source
  // branch and marker so a mid-window rename cannot mislabel the request.
  const freshPull = await api.getPull(repository, pullRequestNumber);
  const freshComment = await api.getReviewComment(repository, findingCommentId);
  const freshThreadUnresolved = await api.threadUnresolved(repository, pullRequestNumber, findingCommentId);
  const freshFindingRef = freshComment?.html_url ?? `comment-${findingCommentId}`;
  const freshComments = await api.listComments(repository, pullRequestNumber);
  const reauthorized = authorizeCodexFixDispatch({
    repository,
    pullRequestNumber,
    headSha,
    findingRef: freshFindingRef,
    authorization,
    livePull: freshPull,
    findingComment: freshComment,
    threadUnresolved: freshThreadUnresolved,
    existingComments: freshComments,
  });
  if (!reauthorized.allowed) {
    throw new Error(reauthorized.state === 'duplicate' ? 'duplicate' : 'stale_before_post');
  }

  const created = await api.postComment(repository, pullRequestNumber, codexFixComment({
    pullRequestNumber,
    headSha,
    sourceBranch: reauthorized.sourceBranch,
    findingRef: freshFindingRef,
    marker: reauthorized.marker,
  }));
  const evidence = { commentId: created.id, commentAuthor: created.user?.login };
  writeOutput(`comment_id=${evidence.commentId}\ncomment_author=${evidence.commentAuthor}\n`);
  return evidence;
}

async function main() {
  const [mode] = process.argv.slice(2);
  if (mode !== 'dispatch') throw new Error('Expected dispatch mode');
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const evidence = await runDispatch({
    env: process.env,
    loadEvent: () => JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    api: productionApi(token),
    writeOutput: (line) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line); },
  });
  console.log(`codex-fix-probe: posted dispatch evidence ${JSON.stringify(evidence)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
