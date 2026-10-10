// M3c (owner, #482 6091212460; proposal v3 §A, 6095505952): the cited work item is verified at APPROVAL time, and
// that verification lives inside the approval itself — the exact head's `codex-current-head` success description
// ends with an approval token. There is no separate receipt, so an observation can only become durable inside a
// completed approval (v3 gap 3), and a success without a token is never treated as verified (v3 gap 4).
//
//   [wi:none]          the head cites no work item (citing stays optional, 6094067774)
//   [wi:#N open]       the head cites #N, verified a local, non-PR issue of this repository, open when approved
//   [wi:#N closed]     the same, closed when approved (either state is valid, 6094122465)
//
// This module is pure: it formats and parses tokens and classifies one issue read. The controller does the I/O.

// A cited token may name the controller run that wrote it (` r<run id>`, M3c C1): that run uploads the receipt artifact
// `receiptArtifactName(...)`, which is what lets a later run reuse the approval as historical proof.
const TOKEN = /\[wi:(?:none|#([1-9]\d{0,9}) (open|closed)(?: r([1-9]\d{0,19}))?)\]$/u;
const DESCRIPTION_LIMIT = 140;

/** The approval token for a verification result: `{ state: 'none' }` or `{ state: 'valid', issue, issueState }`. */
export function approvalToken(verification, { runId = null } = {}) {
  if (verification?.state === 'none') return '[wi:none]';
  if (verification?.state === 'valid' && Number.isInteger(verification.issue) && verification.issue > 0
    && (verification.issueState === 'open' || verification.issueState === 'closed')) {
    const run = /^[1-9]\d{0,19}$/u.test(String(runId ?? '')) ? ` r${runId}` : '';
    return `[wi:#${verification.issue} ${verification.issueState}${run}]`;
  }
  throw new Error('an approval token needs a verified work item or none');
}

/** `description` with `token` as its final text, the description shortened so the token always survives. */
export function withApprovalToken(description, token) {
  const room = DESCRIPTION_LIMIT - token.length - 1;
  return `${String(description ?? '').slice(0, room).trimEnd()} ${token}`;
}

/**
 * The approval token a status description ends with: `{ state: 'none' }`, `{ state: 'cited', issue, issueState }`,
 * or null when it carries none (an approval written before M3c, or not an approval at all).
 */
export function parseApprovalToken(description) {
  const match = TOKEN.exec(String(description ?? ''));
  if (!match) return null;
  if (match[1] === undefined) return { state: 'none' };
  return { state: 'cited', issue: Number(match[1]), issueState: match[2], runId: match[3] ?? null };
}

/** Does an approval token agree with the head's parsed `Work-Item` trailer (`parseWorkItemTrailer`)? */
export function tokenMatchesTrailer(token, trailer) {
  if (!token || !trailer) return false;
  if (trailer.state === 'none') return token.state === 'none';
  if (trailer.state === 'cited') return token.state === 'cited' && token.issue === trailer.issue;
  return false;
}

/**
 * Classify one read of `GET /repos/{repository}/issues/{number}` (redirects followed). Valid means: the issue
 * exists, it is in THIS repository (a transferred issue answers from another one), and it is not a pull request.
 *   valid      — `issueState` is `open` or `closed`
 *   invalid    — missing (404/410), a pull request, or not in this repository; only a new head clears it
 *   unreadable — anything else (auth, rate limit, 5xx, network, an unexpected payload); retry the same head
 */
export function classifyIssueRead({ status, payload, repository, number }) {
  if (status === 404 || status === 410) {
    return { state: 'invalid', detail: `cited #${number} does not exist in ${repository} (HTTP ${status})` };
  }
  if (status !== 200 || !payload || typeof payload !== 'object') {
    return { state: 'unreadable', detail: `cited #${number} could not be read (HTTP ${status ?? 'none'})` };
  }
  const expected = `https://api.github.com/repos/${repository}`.toLowerCase();
  if (String(payload.repository_url ?? '').toLowerCase() !== expected || payload.number !== number) {
    return { state: 'invalid', detail: `cited #${number} is not an issue of ${repository} (moved or transferred)` };
  }
  if (payload.pull_request) {
    return { state: 'invalid', detail: `cited #${number} is a pull request, not an issue` };
  }
  if (payload.state !== 'open' && payload.state !== 'closed') {
    return { state: 'unreadable', detail: `cited #${number} has an unexpected state` };
  }
  return { state: 'valid', issue: number, issueState: payload.state, detail: null };
}

/**
 * M3c C1 — the name of the receipt artifact a controller run uploads after it completes a cited approval of `sha`.
 * Only that run can attach an artifact to itself, so a genuine run's artifact list naming this exact head, issue and
 * state is run-level provenance that a copied run id cannot fake.
 */
export function receiptArtifactName(sha, issue, issueState) {
  return `wi-approval-${sha}-${issue}-${issueState}`;
}
