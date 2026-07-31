// The exclusive work lease: at most one open `claude/**` pull request at a time.
//
// The loop produced #252, #257, #260 and #261 open simultaneously, each drawing
// review rounds, each blocking the others' assumptions about `main`. Nothing
// forbade it — "work one task at a time" lived in prose that only a reader
// obeys. This makes it a state the runner must consult before starting work.
//
// The lease lives in GitHub issue #235, beside the durable cursor that is
// already there, because it is LIVE state: which PR is active, at which head,
// in which review state. Git is the wrong home for that — it changes several
// times per review round, and recording it in a tracked file means a commit
// (and a CI run, and a merge) for every transition. Durable facts stay in
// docs/STATUS.md; live facts live here.
//
// ── The one thing this module refuses to do ────────────────────────────────
//
// It does not expose a way to write the lease alone. `renderRunnerState` takes
// the WHOLE state — cursor and lease together — and returns the whole body.
// That is deliberate: the issue body has two writers with different concerns,
// and the failure mode of "each writer preserves the other's block" is a bug
// waiting for the next writer. Rendering from one state object means dropping
// the cursor while writing the lease is not something a caller can get wrong;
// it is not expressible.

export const STATE_ISSUE_NUMBER = 235;

const CURSOR_LINE = /Last processed merge: `([^`]+)` \(#(\d+)\)/u;
const LEASE_LINE = /^Active work: #(?<pr>\d+) `(?<head>[^`]*)` (?<state>[a-z_]+)$/mu;
const LEASE_NONE = 'Active work: none';

// A replacement declares its source, the same declaration the review lifecycle
// uses. Recorded on the lease so the handover is visible in the one place the
// runner looks, not only in a PR body it would have to go and read.
const REPLACES = /^[\t ]*replaces:[\t ]*#(?<number>\d+)[\t ]*$/imu;

export const LEASE_STATES = ['building', 'reviewing', 'correcting'];

export function readCursor(body, fallbackMergedAt) {
  const match = CURSOR_LINE.exec(typeof body === 'string' ? body : '');
  if (!match) return { mergedAt: fallbackMergedAt, number: 0 };
  return { mergedAt: Date.parse(match[1]), number: Number(match[2]) };
}

// `null` means the lease is FREE. An unparseable line is not free — see
// `assessLease`: this returns `undefined` for "there is a lease line but it does
// not parse", which the assessment refuses rather than treating as available.
export function readLease(body) {
  const source = typeof body === 'string' ? body : '';
  if (source.includes(LEASE_NONE)) return null;
  const match = LEASE_LINE.exec(source);
  if (!match) return source.includes('Active work:') ? undefined : null;
  const pr = Number(match.groups.pr);
  if (!Number.isInteger(pr) || pr <= 0) return undefined;
  return { pr, head: match.groups.head || null, state: match.groups.state };
}

// ONE renderer for the WHOLE body. There is no `renderLease`, deliberately: a
// caller that could write one block alone could drop the other.
export function renderRunnerState({ cursor, lease }) {
  const cursorAt = cursor?.mergedAt
    ? new Date(cursor.mergedAt).toISOString()
    : null;
  return [
    '<!-- autonomous-runner-state -->',
    'This issue stores the durable cursor and the exclusive work lease for the '
      + 'repository automation. GitHub Actions maintains it; do not close or edit '
      + 'it manually.',
    '',
    cursorAt
      ? `Last processed merge: \`${cursorAt}\` (#${cursor.number ?? 0})`
      : 'Last processed merge: none',
    '',
    lease
      ? `Active work: #${lease.pr} \`${lease.head ?? ''}\` ${lease.state}`
      : LEASE_NONE,
    ...(lease?.replaces ? ['', `Replaces: #${lease.replaces}`] : []),
  ].join('\n');
}

export function replacementSource(body) {
  const match = REPLACES.exec(typeof body === 'string' ? body : '');
  if (!match) return null;
  const number = Number(match.groups.number);
  return Number.isInteger(number) && number > 0 ? number : null;
}

// May the runner start `intent` right now?
//
// Total by construction: every input returns either a concrete permission or the
// reason there isn't one. The runner never has to infer availability from an
// absence, which is the shape that let four PRs open at once.
export function assessLease({ lease, intent, openPullRequests }) {
  const open = (openPullRequests ?? []).filter(
    (pullRequest) => typeof pullRequest?.head?.ref === 'string'
      && pullRequest.head.ref.startsWith('claude/'),
  );

  // Unparseable is not free. A lease line the runner cannot read might name an
  // active PR, and starting a second one on that guess is exactly the overlap
  // this exists to stop — so it blocks and says why, rather than assuming.
  if (lease === undefined) {
    return {
      allowed: false,
      reason: 'the work lease could not be parsed, so whether work is already active '
        + 'is unverified; repair the Active work line in issue '
        + `#${STATE_ISSUE_NUMBER} before starting`,
    };
  }

  // The lease and reality can disagree — a PR closed without releasing, or one
  // opened without acquiring. GitHub is the authority on what is OPEN; the lease
  // is the authority on what the runner CLAIMED. Both are reported, because a
  // disagreement is itself actionable and must not be silently resolved.
  if (!lease && open.length > 0) {
    return {
      allowed: false,
      reason: `the lease is free but ${open.length} claude/** pull request(s) are open `
        + `(${open.map((pullRequest) => `#${pullRequest.number}`).join(', ')}); `
        + 'close or adopt them before starting new work',
      orphaned: open.map((pullRequest) => pullRequest.number),
    };
  }

  if (!lease) {
    return { allowed: true, reason: 'no work is active, so the lease is available' };
  }

  // Continuing the SAME unit is always allowed — that is shepherding, not
  // starting. The lease exists to stop a SECOND unit, never to strand the first.
  if (intent?.pr === lease.pr) {
    return {
      allowed: true,
      held: lease,
      reason: `pull request #${lease.pr} holds the lease and is the work item`,
    };
  }

  // A declared replacement may take the lease from the unit it replaces — the
  // review lifecycle's own handover rule, enforced here rather than trusted.
  if (intent?.replaces === lease.pr) {
    return {
      allowed: true,
      held: lease,
      replaces: lease.pr,
      reason: `declared replacement of #${lease.pr}; close it and take the lease`,
    };
  }

  return {
    allowed: false,
    held: lease,
    reason: `pull request #${lease.pr} holds the work lease (${lease.state}); `
      + 'finish it, or declare "Replaces: #' + lease.pr + '" to supersede it. '
      + 'A second concurrent unit is what this lease exists to prevent',
  };
}
