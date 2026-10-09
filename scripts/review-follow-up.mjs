// Owner direction 2026-10-09 (#482, 6075561748; selected as M2b-1 in 6076742015) — the same-PR follow-up
// durability component.
//
// Codex findings that a PR does not fix before it merges must survive in a follow-up issue. This module is
// that filing path, on its own: it RECORDS a head's findings on the PR before it files them, FILES them in that
// head's one follow-up issue, and RECOVERS any recorded filing that never completed — including one whose
// head has since moved, when the findings are no longer current-head evidence anywhere else.
//
// It decides nothing about which findings defer: the review-round cap stays inactive in this unit, and the
// strict gate is unchanged. The integration unit (M2b-2) calls it, and clears a head only after
// `fileFollowUp` and `reconcilePendingFollowUps` have SUCCEEDED — a durable pending record enables recovery,
// it never stands in for a completed filing. Every failure here throws.
//
// Bounded: one PR. Records are read only from that PR's own comments, written only by the workflow token,
// and name that PR; follow-up issues are keyed by (PR, exact head).

import { REVIEW_FOLLOW_UP_LABEL } from './review-policy.mjs';

/** The only author whose PR comments count as follow-up records: the workflow token. */
export const FOLLOW_UP_RECORD_AUTHOR = 'github-actions[bot]';

const FULL_SHA = /^[0-9a-f]{40}$/u;
const BADGE = /!\[P(\d) Badge\]|badge\/P(\d)-/u;
const LINE_IDENTITY = /\((https?:\/\/[^)\s]+|finding:[^)\s]+)\)\s*$/u;

const issueMarker = (number, head) => `<!-- review-follow-up: pr-${number} head-${head} -->`;
const pendingMarker = (number, head) => `<!-- review-follow-up-pending: pr-${number} head-${head} -->`;
const filedMarker = (number, head) => `<!-- review-follow-up-filed: pr-${number} head-${head} -->`;
const RECORD_MARKER = /<!-- review-follow-up-(pending|filed): pr-(\d+) head-([0-9a-f]{40}) -->/u;

function requireHead(head) {
  if (!FULL_SHA.test(String(head ?? ''))) throw new TypeError(`a follow-up is keyed by a full head SHA, got ${JSON.stringify(head)}`);
}

function requirePullRequest(pullRequest) {
  if (!Number.isInteger(pullRequest?.number)) throw new TypeError('a follow-up needs the pull request number');
}

/** The P-level a Codex finding declares (0 = most severe), or null when it carries no badge. */
function findingPriority(body) {
  const match = BADGE.exec(String(body ?? ''));
  return match ? Number(match[1] ?? match[2]) : null;
}

/**
 * A finding's stable identity: its GitHub URL, which no edit to the finding or to the checklist changes.
 * Inline comments and reviews have different URLs (`#discussion_r…`, `#pullrequestreview-…`), so a review
 * body and the inline comments it owns are distinct findings. Without a URL, the kind and id stand in.
 */
export function findingIdentity(finding) {
  if (typeof finding?.html_url === 'string' && /^https?:\/\//u.test(finding.html_url)) return finding.html_url;
  const kind = finding?.pull_request_review_id != null || typeof finding?.path === 'string' ? 'comment' : 'review';
  if (finding?.id != null) return `finding:${kind}-${finding.id}`;
  throw new TypeError('a finding without a URL or an id has no stable identity');
}

/** A rendered checklist line's identity (the trailing link), or the line itself when it carries none. */
export function lineIdentity(line) {
  return LINE_IDENTITY.exec(String(line))?.[1] ?? String(line);
}

/**
 * One checklist line per finding, rendered ONCE, on the head the finding was classified on, and carried
 * verbatim from then on. An inline finding keeps its complete anchor (path, line, side); a review-body
 * finding is `review-level`. Duplicates by identity are dropped.
 */
export function renderFollowUpLines(findings = []) {
  const seen = new Set();
  const lines = [];
  for (const finding of findings) {
    const identity = findingIdentity(finding);
    if (seen.has(identity)) continue;
    seen.add(identity);
    const priority = findingPriority(finding?.body);
    const title = String(finding?.body ?? '').split('\n')
      .map((line) => line.replace(/\*\*|<[^>]+>|!\[[^\]]*\]\([^)]*\)/gu, '').trim())
      .find((line) => line.length > 0) ?? 'Codex finding';
    const inline = typeof finding?.path === 'string';
    const line = finding?.line ?? finding?.original_line ?? '?';
    const where = inline ? `${finding.path}:${line}${finding?.side ? ` ${finding.side}` : ''}` : 'review-level';
    lines.push(`- [ ] ${priority === null ? 'P?' : `P${priority}`} \`${where}\` — ${title} (${identity})`);
  }
  return lines;
}

const checklist = (body) => String(body ?? '').split('\n').filter((line) => line.startsWith('- ['));

/** Lines from `candidates` whose identity is in neither `known` nor earlier in `candidates`. */
function missingLines(candidates, known) {
  const have = new Set(known);
  const out = [];
  for (const line of candidates) {
    const identity = lineIdentity(line);
    if (have.has(identity)) continue;
    have.add(identity);
    out.push(line);
  }
  return out;
}

const identitiesOf = (body) => checklist(body).map(lineIdentity);

/** This PR's follow-up records, grouped by head: `{ head, records, lines, pending }`, oldest head first. */
export function followUpRecords(comments, pullRequestNumber) {
  const byHead = new Map();
  for (const comment of comments ?? []) {
    if (comment?.user?.login !== FOLLOW_UP_RECORD_AUTHOR) continue;
    const match = RECORD_MARKER.exec(String(comment?.body ?? ''));
    if (!match || Number(match[2]) !== pullRequestNumber) continue;
    const head = match[3];
    const entry = byHead.get(head) ?? { head, records: [], lines: [], pending: false };
    entry.records.push(comment);
    entry.lines = [...entry.lines, ...missingLines(checklist(comment.body), entry.lines.map(lineIdentity))];
    if (match[1] === 'pending') entry.pending = true;
    byHead.set(head, entry);
  }
  return [...byHead.values()];
}

/** The heads of this PR with a recorded filing that has not completed. A head is not clear while one remains. */
export function pendingFollowUpHeads(comments, pullRequestNumber) {
  return followUpRecords(comments, pullRequestNumber).filter((entry) => entry.pending).map((entry) => entry.head);
}

const recordBody = (marker, head, intro, lines) => [
  marker,
  `Codex findings on \`${head.slice(0, 7)}\`, ${intro}`,
  '',
  ...lines,
].join('\n');

/**
 * Record `lines` for `head` on the PR BEFORE they are filed: one workflow-authored comment per head, created,
 * or updated with any line it lacks (a line already recorded is kept verbatim, with its original-head
 * classification). Returns the head's merged record entry.
 */
export async function recordPendingFollowUp(client, pullRequest, head, lines) {
  requirePullRequest(pullRequest);
  requireHead(head);
  const entry = followUpRecords(await client.issueComments(pullRequest.number), pullRequest.number)
    .find((candidate) => candidate.head === head);
  const pendingIntro = 'recorded before they are filed in this head\'s follow-up issue, so a filing that fails is recovered.';
  if (!entry) {
    const created = await client.createIssueComment(pullRequest.number, recordBody(pendingMarker(pullRequest.number, head), head, pendingIntro, lines));
    return { head, records: [created], lines: [...lines], pending: true };
  }
  const merged = [...entry.lines, ...missingLines(lines, entry.lines.map(lineIdentity))];
  const [first] = entry.records;
  await client.updateIssueComment(first.id, recordBody(pendingMarker(pullRequest.number, head), head, pendingIntro, merged));
  return { head, records: entry.records, lines: merged, pending: true };
}

/**
 * File `lines` in `head`'s ONE open follow-up issue and return its number. Deterministic under retries and
 * concurrent runs for different heads of the same PR:
 *  - The canonical issue is the lowest-numbered OPEN issue carrying the head's marker. A closed duplicate is
 *    never selected (Codex 4226684318).
 *  - A finding already listed in ANY of the head's issues — open, or closed as completed — is not added again,
 *    so completed work is not reopened; identity is the finding's URL, not the editable line (Codex 4225790718).
 *  - Two runs that both create an issue converge on the lowest-numbered one: lines from the other open
 *    issues, and from duplicates this path closed (`not_planned`), are carried before they are closed
 *    (Codex 4226440202).
 *  - The filing is VERIFIED by reading the issues back: every line must be listed in the canonical issue or
 *    in a completed one, or this throws and the record stays pending.
 */
export async function fileFollowUpLines(client, pullRequest, head, lines) {
  requirePullRequest(pullRequest);
  requireHead(head);
  if (lines.length === 0) return null;
  const marker = issueMarker(pullRequest.number, head);
  const issuesFor = async () => (await client.issuesLabelled(REVIEW_FOLLOW_UP_LABEL))
    .filter((issue) => String(issue?.body ?? '').includes(marker) && issue?.pull_request == null);
  const completedIdentities = (issues) => issues
    .filter((issue) => issue.state === 'closed' && issue.state_reason !== 'not_planned')
    .flatMap((issue) => identitiesOf(issue.body));

  let issues = await issuesFor();
  if (!issues.some((issue) => issue.state === 'open')) {
    // only a COMPLETED issue holds a finding; one closed as a duplicate (or not planned) does not
    const fresh = missingLines(lines, completedIdentities(issues));
    if (fresh.length === 0) return verified(client, pullRequest, head, lines, issues);
    await client.ensureLabel(REVIEW_FOLLOW_UP_LABEL);
    await client.createIssue({
      title: `Review follow-up from #${pullRequest.number}: Codex findings on ${head.slice(0, 7)}`,
      labels: [REVIEW_FOLLOW_UP_LABEL],
      body: [
        marker,
        `Codex findings on #${pullRequest.number} at \`${head.slice(0, 7)}\` that need follow-up work after it merges.`,
        '',
        ...fresh,
      ].join('\n'),
    });
    issues = await issuesFor();
  }

  const open = issues.filter((issue) => issue.state === 'open').sort((a, b) => a.number - b.number);
  if (open.length === 0) throw new Error(`the follow-up issue for #${pullRequest.number} at ${head.slice(0, 7)} was not found after it was created`);
  const [canonical, ...duplicates] = open;
  const carried = [
    ...duplicates,
    ...issues.filter((issue) => issue.state === 'closed' && issue.state_reason === 'not_planned'),
  ].flatMap((issue) => checklist(issue.body));
  const add = missingLines([...lines, ...carried], [...identitiesOf(canonical.body), ...completedIdentities(issues)]);
  if (add.length > 0) await client.updateIssueBody(canonical.number, [String(canonical.body ?? '').trimEnd(), ...add].join('\n'));
  for (const duplicate of duplicates) {
    await client.closeIssue(duplicate.number, `Duplicate of #${canonical.number} (the same head's follow-up).`);
  }
  return verified(client, pullRequest, head, lines, null, canonical.number);
}

/** Read the head's issues back and return the issue that holds the filing, or throw if any line is missing. */
async function verified(client, pullRequest, head, lines, known, canonicalNumber = null) {
  const marker = issueMarker(pullRequest.number, head);
  const issues = known ?? (await client.issuesLabelled(REVIEW_FOLLOW_UP_LABEL))
    .filter((issue) => String(issue?.body ?? '').includes(marker) && issue?.pull_request == null);
  const holding = issues.filter((issue) => issue.number === canonicalNumber
    || (issue.state === 'closed' && issue.state_reason !== 'not_planned'));
  const listed = new Set(holding.flatMap((issue) => identitiesOf(issue.body)));
  const absent = lines.filter((line) => !listed.has(lineIdentity(line)));
  if (absent.length > 0) {
    throw new Error(`follow-up filing for #${pullRequest.number} at ${head.slice(0, 7)} is incomplete: ${absent.length} finding(s) not listed`);
  }
  return canonicalNumber ?? Math.min(...holding.map((issue) => issue.number));
}

/** Mark every record of `head` filed in `issueNumber`, keeping its lines. */
async function markFollowUpFiled(client, pullRequest, entry, issueNumber) {
  for (const record of entry.records) {
    if (record?.id == null) continue;
    await client.updateIssueComment(record.id, recordBody(
      filedMarker(pullRequest.number, entry.head), entry.head, `filed in #${issueNumber}.`, entry.lines,
    ));
  }
}

/**
 * Record, then file, then mark filed — the whole required filing for one head's findings. Returns the issue
 * number. Throws on any failure, leaving whatever was recorded pending for `reconcilePendingFollowUps`.
 */
export async function fileFollowUp(client, pullRequest, head, findings) {
  const lines = renderFollowUpLines(findings);
  if (lines.length === 0) return null;
  const entry = await recordPendingFollowUp(client, pullRequest, head, lines);
  const number = await fileFollowUpLines(client, pullRequest, head, entry.lines);
  await markFollowUpFiled(client, pullRequest, entry, number);
  return number;
}

/**
 * Complete every recorded filing on this PR that is still pending, each in ITS OWN head's follow-up issue,
 * with the lines exactly as recorded on that head. Same PR only. Returns what it recovered; throws on the
 * first filing that fails, leaving that head (and any after it) pending.
 */
export async function reconcilePendingFollowUps(client, pullRequest) {
  requirePullRequest(pullRequest);
  const recovered = [];
  for (const entry of followUpRecords(await client.issueComments(pullRequest.number), pullRequest.number)) {
    if (!entry.pending || entry.lines.length === 0) continue;
    const number = await fileFollowUpLines(client, pullRequest, entry.head, entry.lines);
    await markFollowUpFiled(client, pullRequest, entry, number);
    recovered.push({ head: entry.head, issue: number, findings: entry.lines.length });
  }
  return recovered;
}
