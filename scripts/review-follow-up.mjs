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

/**
 * This PR's follow-up records, grouped by head: `{ head, records: [{ id, pending, lines }], pending }`. Each
 * record is its own workflow-authored comment holding the lines ONE recording wrote; a record is never
 * rewritten to add lines, so concurrent recordings cannot overwrite each other (Codex 4228313741).
 */
export function followUpRecords(comments, pullRequestNumber) {
  const byHead = new Map();
  for (const comment of comments ?? []) {
    if (comment?.user?.login !== FOLLOW_UP_RECORD_AUTHOR) continue;
    const match = RECORD_MARKER.exec(String(comment?.body ?? ''));
    if (!match || Number(match[2]) !== pullRequestNumber) continue;
    const head = match[3];
    const entry = byHead.get(head) ?? { head, records: [], pending: false };
    const pending = match[1] === 'pending';
    entry.records.push({ id: comment.id, pending, lines: checklist(comment.body) });
    if (pending) entry.pending = true;
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
 * Record `lines` for `head` on the PR BEFORE they are filed: a NEW workflow-authored comment, so the lines
 * survive a filing that fails, with their original-head classification, however many runs record at once.
 */
export async function recordPendingFollowUp(client, pullRequest, head, lines) {
  requirePullRequest(pullRequest);
  requireHead(head);
  const created = await client.createIssueComment(pullRequest.number, recordBody(
    pendingMarker(pullRequest.number, head), head,
    'recorded before they are filed in this head\'s follow-up issue, so a filing that fails is recovered.', lines,
  ));
  return { id: created?.id, pending: true, lines: [...lines] };
}

/** Mark one record filed in `issueNumber`, keeping exactly its own lines. */
async function markRecordFiled(client, pullRequest, head, record, issueNumber) {
  await client.updateIssueComment(record.id, recordBody(
    filedMarker(pullRequest.number, head), head, `filed in #${issueNumber}.`, record.lines,
  ));
}

const DUPLICATE_MARKER = '<!-- review-follow-up-duplicate-of: ';
/** How many times one filing re-reads and retries before it reports itself incomplete. */
export const FILING_ATTEMPTS = 3;

/**
 * The head's follow-up issues, each with the findings it lists — its body and the workflow's comments on it
 * (findings are APPENDED as comments, never written into the body, so no write can drop another's line) —
 * and whether this component closed it as a duplicate.
 *
 * `created` are the issues this filing created itself, read back BY NUMBER as well (#482, 6085143973). GitHub
 * attaches the labels of a new issue asynchronously — #752–#754 and #755–#757 each carry a `labeled` event one
 * to two seconds after creation — so the label-filtered list can omit an issue created a moment ago. Read
 * only through that list, a filing never saw its own issue and created another on every attempt.
 */
async function followUpIssues(client, pullRequest, head, created = []) {
  const marker = issueMarker(pullRequest.number, head);
  const labelled = await client.issuesLabelled(REVIEW_FOLLOW_UP_LABEL);
  const unlisted = created.filter((number) => !labelled.some((issue) => issue?.number === number));
  const issues = [...labelled, ...await Promise.all(unlisted.map((number) => client.issue(number)))]
    .filter((issue) => String(issue?.body ?? '').includes(marker) && issue?.pull_request == null);
  return Promise.all(issues.map(async (issue) => {
    const own = (await client.issueComments(issue.number)).filter((comment) => comment?.user?.login === FOLLOW_UP_RECORD_AUTHOR);
    const lines = [...checklist(issue.body), ...own.flatMap((comment) => checklist(comment.body))];
    return {
      number: issue.number,
      open: issue.state === 'open',
      duplicate: own.some((comment) => String(comment.body).includes(DUPLICATE_MARKER)),
      lines,
      identities: new Set(lines.map(lineIdentity)),
    };
  }));
}

/**
 * File `lines` in `head`'s ONE open follow-up issue and return its number. Deterministic under retries and
 * concurrent runs:
 *  - The canonical issue is the lowest-numbered OPEN issue carrying the head's marker; a closed one is never
 *    selected (Codex 4226684318).
 *  - A finding listed in an issue that was already closed (completed, or closed by a person) when this filing
 *    began is not filed again, so finished or declined work is not reopened. Identity is the finding's URL,
 *    not the editable line (Codex 4225790718).
 *  - Findings are appended to the canonical issue as a COMMENT. Concurrent filings each append; none rewrites
 *    what another wrote (Codex 4228313741). GitHub offers no compare-and-set on an issue, so the trade is
 *    explicit: two racing runs may list one finding twice, and can never drop one. A rerun adds nothing listed.
 *  - Two runs that both create an issue converge on the lowest-numbered one; lines from the other open issues,
 *    and from duplicates this component closed earlier, are carried before the duplicates are closed
 *    (Codex 4226440202).
 *  - The filing is VERIFIED by reading the issues back: the canonical issue must still be OPEN and list every
 *    finding. Otherwise — say it was closed meanwhile (Codex 4228313747) — the filing retries into an open
 *    issue, up to FILING_ATTEMPTS times, then throws and the record stays pending.
 */
export async function fileFollowUpLines(client, pullRequest, head, lines) {
  requirePullRequest(pullRequest);
  requireHead(head);
  if (lines.length === 0) return null;
  const marker = issueMarker(pullRequest.number, head);
  const initial = await followUpIssues(client, pullRequest, head);
  const settled = new Set(initial.filter((issue) => !issue.open && !issue.duplicate).flatMap((issue) => [...issue.identities]));
  const required = missingLines(lines, [...settled]);
  if (required.length === 0) {
    return Math.min(...initial.filter((issue) => !issue.open && !issue.duplicate
      && lines.some((line) => issue.identities.has(lineIdentity(line)))).map((issue) => issue.number));
  }

  let issues = initial;
  const created = [];
  for (let attempt = 1; attempt <= FILING_ATTEMPTS; attempt += 1) {
    if (!issues.some((issue) => issue.open)) {
      await client.ensureLabel(REVIEW_FOLLOW_UP_LABEL);
      const issue = await client.createIssue({
        title: `Review follow-up from #${pullRequest.number}: Codex findings on ${head.slice(0, 7)}`,
        labels: [REVIEW_FOLLOW_UP_LABEL],
        body: [
          marker,
          `Codex findings on #${pullRequest.number} at \`${head.slice(0, 7)}\` that need follow-up work after it merges.`,
          '',
          ...required,
        ].join('\n'),
      });
      if (!Number.isInteger(issue?.number)) throw new Error('GitHub created a follow-up issue but returned no issue number');
      created.push(issue.number);
      issues = await followUpIssues(client, pullRequest, head, created);
    }
    const open = issues.filter((issue) => issue.open).sort((a, b) => a.number - b.number);
    if (open.length > 0) {
      const [canonical, ...duplicates] = open;
      const carried = [...duplicates, ...issues.filter((issue) => !issue.open && issue.duplicate)].flatMap((issue) => issue.lines);
      const add = missingLines([...required, ...carried], [...canonical.identities, ...settled]);
      if (add.length > 0) {
        await client.createIssueComment(canonical.number, ['Codex findings filed for follow-up:', '', ...add].join('\n'));
      }
      for (const duplicate of duplicates) {
        await client.closeIssue(duplicate.number, `${DUPLICATE_MARKER}${canonical.number} -->\nDuplicate of #${canonical.number} (the same head's follow-up).`);
      }
      issues = await followUpIssues(client, pullRequest, head, created);
      const after = issues.find((issue) => issue.number === canonical.number);
      if (after?.open && required.every((line) => after.identities.has(lineIdentity(line)))) return canonical.number;
    }
  }
  throw new Error(`follow-up filing for #${pullRequest.number} at ${head.slice(0, 7)} is incomplete after ${FILING_ATTEMPTS} attempts`);
}

/**
 * Record, then file, then mark filed — the whole required filing for one head's findings. Returns the issue
 * number. Throws on any failure, leaving the record pending for `reconcilePendingFollowUps`.
 */
export async function fileFollowUp(client, pullRequest, head, findings) {
  const lines = renderFollowUpLines(findings);
  if (lines.length === 0) return null;
  const record = await recordPendingFollowUp(client, pullRequest, head, lines);
  const number = await fileFollowUpLines(client, pullRequest, head, lines);
  await markRecordFiled(client, pullRequest, head, record, number);
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
    const pending = entry.records.filter((record) => record.pending && record.lines.length > 0);
    if (pending.length === 0) continue;
    const lines = missingLines(pending.flatMap((record) => record.lines), []);
    const number = await fileFollowUpLines(client, pullRequest, entry.head, lines);
    for (const record of pending) await markRecordFiled(client, pullRequest, entry.head, record, number);
    recovered.push({ head: entry.head, issue: number, findings: lines.length });
  }
  return recovered;
}
