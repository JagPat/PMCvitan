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
// ── Two things this module refuses to do ───────────────────────────────────
//
// 1. It does not expose a way to write the lease alone. `renderRunnerState`
//    takes the WHOLE state — cursor and lease together — and returns the whole
//    body. The failure mode of "each writer preserves the other's block" is a
//    bug waiting for the next writer; here, dropping the cursor while writing
//    the lease is not expressible.
//
// 2. It does not expose the START instruction as text a caller can print.
//    `startInstruction` returns the words and the lease that must be persisted
//    to earn them, as ONE value. The first version of this module assessed the
//    lease and let callers decide what to do with the verdict; every caller
//    that forgot became a way to start a second unit, and the verdict ended up
//    decorating an instruction instead of gating it. A caller cannot now obtain
//    the words without also receiving the obligation.

export const STATE_ISSUE_NUMBER = 235;

const CURSOR_LINE = /Last processed merge: `([^`]+)` \(#(\d+)\)/u;

// Every line that CLAIMS to be a lease, however malformed. Counting these is
// what makes a duplicated or corrupted block fail closed instead of matching
// whichever line happens to parse.
const LEASE_ANY_LINE = /^[\t ]*Active work:.*$/gmu;
const LEASE_FREE_LINE = /^[\t ]*Active work: none[\t ]*$/u;
const LEASE_HELD_LINE =
  /^[\t ]*Active work: (?:#(?<pr>\d+)|pending:(?<claimId>[A-Za-z0-9._-]+)) `(?<head>[^`]*)` (?<state>[a-z_]+)[\t ]*$/u;

const LEASE_NONE = 'Active work: none';

// A replacement declares its source, the same declaration the review lifecycle
// uses. Recorded on the lease so the handover is visible in the one place the
// runner looks, not only in a PR body it would have to go and read.
const REPLACES = /^[\t ]*replaces:[\t ]*#(?<number>\d+)[\t ]*$/imu;

export const LEASE_STATES = ['building', 'reviewing', 'correcting'];

// The ONE wording that tells the runner to begin a new unit. It lives here,
// beside the acquisition, so that a grep for it finds exactly one site.
const START_TEXT =
  'Create the next same-repository `claude/**` branch and draft PR with Auto-fix '
  + 'enabled. If the merged result or state file is inconsistent, open a focused '
  + 'correction instead of advancing.';

export function readCursor(body, fallbackMergedAt) {
  const match = CURSOR_LINE.exec(typeof body === 'string' ? body : '');
  if (!match) return { mergedAt: fallbackMergedAt, number: 0 };
  return { mergedAt: Date.parse(match[1]), number: Number(match[2]) };
}

// `null` means FREE, `undefined` means "there is a lease line but it cannot be
// trusted". The distinction matters because `assessLease` refuses the second
// rather than treating it as available.
//
// Parsing is line-EXACT and counts candidates first. A substring search for
// "Active work: none" read `Active work: nonee` as free, and read a body
// carrying BOTH a stale `none` line and a held line as free — the two shapes a
// half-written update actually produces. The rule this module states about
// unreadable leases has to hold for its own reader first.
export function readLease(body) {
  const source = typeof body === 'string' ? body : '';
  const candidates = source.match(LEASE_ANY_LINE) ?? [];
  if (candidates.length === 0) return null;
  // Two lease lines is a half-finished write, not a state. Which one is current
  // is exactly what cannot be known, so neither is believed.
  if (candidates.length > 1) return undefined;

  const [line] = candidates;
  if (LEASE_FREE_LINE.test(line)) return null;

  const match = LEASE_HELD_LINE.exec(line);
  if (!match) return undefined;

  const { pr, claimId, head, state } = match.groups;
  // An unknown state is an unreadable lease: the runner would not know whether
  // the unit is being built, reviewed or corrected.
  if (!LEASE_STATES.includes(state)) return undefined;

  if (claimId) return { pr: null, claimId, head: head || null, state };

  const number = Number(pr);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  return { pr: number, claimId: null, head: head || null, state };
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
    lease ? `Active work: ${leaseRef(lease)} \`${lease.head ?? ''}\` ${lease.state}` : LEASE_NONE,
    ...(lease?.replaces ? ['', `Replaces: #${lease.replaces}`] : []),
  ].join('\n');
}

// A lease claimed before its pull request exists names the claim instead of a
// number. Without this the window between "start this unit" and "the PR is
// open" is unprotected — which is the window two backlog drains both walked
// through.
function leaseRef(lease) {
  return lease.pr ? `#${lease.pr}` : `pending:${lease.claimId}`;
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
  if (intent?.pr && lease.pr === intent.pr) {
    return {
      allowed: true,
      held: lease,
      reason: `pull request #${lease.pr} holds the lease and is the work item`,
    };
  }

  // A pending claim is fulfilled by whichever PR the runner then opened: the
  // claim exists precisely to reserve the lease for that PR before it had a
  // number. Adopting it is the claim closing, not a second unit starting.
  if (lease.pr === null && intent?.pr) {
    return {
      allowed: true,
      held: lease,
      adopts: intent.pr,
      reason: `pull request #${intent.pr} fulfils the pending claim \`${lease.claimId}\``,
    };
  }

  // A declared replacement may take the lease from the unit it replaces — the
  // review lifecycle's own handover rule, enforced here rather than trusted.
  if (intent?.replaces && intent.replaces === lease.pr) {
    return {
      allowed: true,
      held: lease,
      replaces: lease.pr,
      reason: `declared replacement of #${lease.pr}; close it and take the lease`,
    };
  }

  if (lease.pr === null) {
    return {
      allowed: false,
      held: lease,
      reason: `a start was already issued (claim \`${lease.claimId}\`) and no pull request `
        + 'has been opened for it yet; open that unit rather than starting a second',
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

// The words that start a unit, and the lease that must be written to earn them.
//
// Returned together on purpose. A caller can print `text` only by receiving
// `acquire` in the same value, so "told the runner to start but never recorded
// it" is not a thing a caller can forget — it is a thing a caller must
// deliberately discard. The publishers persist `acquire` BEFORE posting, so a
// failed post leaves the lease held (blocking, recoverable) rather than free
// (duplicating, not).
export function startInstruction({ verdict, claimId, head = null }) {
  if (!verdict?.allowed) {
    return {
      permitted: false,
      acquire: null,
      text: `**Work lease: BLOCKED — do not start new work.** ${verdict?.reason ?? 'the lease could not be assessed'}`,
    };
  }
  return {
    permitted: true,
    acquire: { pr: null, claimId, head, state: 'building' },
    text: START_TEXT,
  };
}

// Does processing `pullRequestNumber` as merged end the lease it holds?
//
// A merged unit is finished, so continuing to record it as active makes the
// next start look blocked by work that no longer exists.
export function releaseOnMerge(lease, pullRequestNumber) {
  return Boolean(lease && lease.pr && lease.pr === pullRequestNumber);
}
