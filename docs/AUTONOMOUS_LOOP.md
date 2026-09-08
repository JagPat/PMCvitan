# PMC Vitan autonomous loop operations

Read [POLICY.md](POLICY.md) for the canonical policy. This file explains operation,
recovery and measured hazards; it does not define additional blocking rules.
The exact executable defaults live in `scripts/review-policy.mjs`.

## Read order and roles

Read STATUS, its active plan and blocking directive, then the relevant procedures
below. Claude/Cursor author according to the declared owner, Codex reviews, GitHub
runs CI and the exact-head controller, and Coolify deploys merged main. See POLICY
for trust boundaries, review continuity, ownership and user authorization.

## Cycle

The PR-side CI workflow runs scope and battery planning, then the selected checks.
The trusted default-branch controller rechecks policy and exact-head evidence before
promotion and merge. The handoff workflow processes merged work, conflicts and
correction leases, recovering missed events through its durable cursor.

Ownership errors and wake limitations are explained in POLICY: a declared Cursor
owner is routed but not awakenable; an invalid declaration is correction_stalled.
Use live PRs and STATUS for the current position; do not maintain a second timeline here.

## Recovery

When an accidental merge or stale state occurs:

1. Stop the next task.
2. Review the exact merged tree.
3. Record validated findings in a focused directive.
4. Change `docs/STATUS.md` back to `in_progress` for the correction.
5. Fix forward from current `main`; never rewrite deployed history.

If Codex or Claude web is unavailable, do not bypass the gate. The exact-head
status remains pending or fails after the bounded retry, and the PR stays draft.
After the subscription service is healthy, recover only the PR's current head.
Run from a verified checkout of the trusted default branch so the command imports
the same recovery authorization used by the controller:

```bash
PR=230
HEAD_SHA=$(gh pr view "$PR" --repo JagPat/PMCvitan --json headRefOid --jq .headRefOid)
TERMINAL_STATUS_ID=$(gh api --paginate --slurp \
  "repos/JagPat/PMCvitan/commits/$HEAD_SHA/statuses?per_page=100" \
  | node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { authorizeRecoveryDispatch } from "./scripts/autonomous-review-gate.mjs";
    const statuses = JSON.parse(readFileSync(0, "utf8")).flat();
    const eligible = statuses.find(status => authorizeRecoveryDispatch(statuses, status.id));
    if (eligible) console.log(eligible.id);
  ')
test -n "$TERMINAL_STATUS_ID"
gh workflow run auto-merge.yml --repo JagPat/PMCvitan \
  -f pr_number="$PR" -f head_sha="$HEAD_SHA" \
  -f terminal_status_id="$TERMINAL_STATUS_ID"
```

All three inputs are required. The workflow refuses a stale SHA and authorizes a
retry only when `terminal_status_id` identifies either the exact active review-
pending status or the exact latest retryable terminal failure on that head. The
input name is retained for workflow-dispatch compatibility. Pending recovery
replaces the abandoned owner through the same concurrency lane; it cannot create a
second owner. Timeout, changed-CI, changed provider evidence, and the documented
bootstrap marker are retryable. A current-head Codex finding or review is not:
Claude must fix it and push a new SHA. Successful, finding-bearing, superseded, or
non-current pending status IDs fail closed.
The dispatch job only writes a durable `codex-recovery-request/<terminal-id>`
marker; it never
changes draft state, invokes Codex, publishes `codex-current-head`, or queues a
merge. Both normal CI and recovery then enter the same job-level concurrency group
for that PR and exact head. That one serialized owner performs every review and
merge mutation. If GitHub replaces a queued owner job, the durable request remains
pending and the next owner consumes it. Duplicate dispatches may refresh the same
request, including after an interrupted owner, but cannot create a concurrent
reviewer. Per-terminal contexts prevent an older owner from consuming a newer
request. A request is consumed only after a terminal review outcome; CI failure
leaves it pending for the next green owner.
Before publishing a new pending status or changing readiness, the owner checks live
current-head Codex reviews and inline comments. A finding that arrived after a
timeout is republished as the required failure and requires a new SHA; recovery
cannot trigger another review of that finding-bearing head.
The owner rechecks required CI immediately before publishing review success.
Ordinary CI recovery searches the complete paginated status history, including
terminal review results hidden below legacy `pending` or `ci:` statuses. Review
success can be reused without another trigger only while the PR is already ready.
If legacy CI left the PR draft, the owner enters the normal ready-and-poll path and
requires a fresh exact-head result before completing the merge. Review
and review-comment webhooks are intentionally not orchestrator triggers. The Codex
App's finding comments still wake the subscription-backed Claude Auto-fix session
directly; GitHub Actions does not need an AI key or a second result writer.

## Operating Hazards

Each of these cost the loop a round or a cycle, and each was a case of trusting a
signal that does not carry the thing it appears to carry. They are recorded so the
next reader pays the cost once rather than again.

### Review continuity supersedes the former round budget

The former two-head rule caused unresolved work to move through replacement PRs
without advancing `main`. The user retired that rule on 2026-09-08. Historical
`replacement_required` comments and labels are not instructions to close a PR.
Read current findings and gate state, fix forward with one owner, and verify the
new head. Repeated findings warrant a root-cause audit, not a new PR number.

### PR-body markers are invisible in every rendered view

`<!-- review-size: … -->`, `<!-- migration-scope: … -->` and
`<!-- correction-owner: … -->` are HTML comments, so they do not appear in the
rendered PR page, and the MCP `pull_request_read` tool strips them as well (it also
HTML-escapes apostrophes). A reader looking at the rendered body sees a large diff
with no declaration and reasonably concludes the declaration is missing.

This produced a false P1 on PR #371: the review asked for a `justified-large`
marker and the six invariant rows that were both already present, on a head where
`review-scope` — the check that validates exactly those markers and fails closed
when they are absent — had passed.

1. Judge marker state by the **`review-scope` outcome**, never by reading the body
   back through a rendered view or through the MCP tool.
2. When a unit is `justified-large`, also restate the size evidence in **visible
   markdown**. The marker satisfies the gate; the visible line satisfies the reader.
3. The class disappears entirely if `review-scope` maintains a visible line
   reflecting what it validated. Until then, 1 and 2 are the workaround.

### Verify the measurement, not just the value

Two instances of one mistake — taking a reading from something that does not
measure the thing.

**An exit code through a pipe is the pipe's.** `cmd | tail` reports `tail`'s
status, so a failing gate reads as passing. Capture `${PIPESTATUS[0]}`, or run the
command without a pipe.

**Elapsed time cannot be inferred from `sleep` calls.** A loop of `sleep` in the
Bash tool that exceeds the 120s tool timeout is moved to the background and returns
*immediately* saying it waited. Four such calls read as "eight minutes elapsed"
while almost no time passed. On PR #369 that compounded into a ~20-minute
overestimate, a conclusion that the `api` job was hung at 31 minutes when it was at
13 — normal for that job — and a needlessly cancelled workflow run.

**To know the time, read a clock:** `date -u`, or the `current-time` attribute on a
wake event. Never infer duration from the mechanism used to wait, and never from
how many tool calls have gone by.

### A trailer git does not parse is a trailer that is not there

`git interpret-trailers --parse` reads only the **last** block of the commit
message, and every line in that block must be `Key: value`. A `Key: value` line
written as its own paragraph above the `Co-Authored-By` block is prose to git, no
matter how much it looks like a trailer to a reader.

That cost a full gate cycle on PR #344 head `ecaf451`, where a since-retired
protocol marker sat one blank line too high and the gate correctly reported the
line present but unparsed. (The mechanism it belonged to was later removed
outright rather than patched — this file deliberately does not name it, so nobody
reintroduces retired vocabulary by reading a hazard note.)

Put every trailer in the **same** final block as `Co-Authored-By` and
`Claude-Session`, with no blank line between them, and verify with
`git log -1 --format=%B | git interpret-trailers --parse` before pushing. Grep is
not a substitute: grep finds exactly the line git is ignoring.

### Resetting the shared test database does not stop a live run

`DROP DATABASE … WITH (FORCE)` terminates the connections of a running integration
suite, and **Prisma reconnects** to the recreated database. The two runs then
truncate each other's fixtures.

The symptom is a large, alarming, entirely fake failure set concentrated in
whichever suites vitest schedules first — it orders by file size, so the biggest
suites take the hit. On PR #344 round 8 that looked exactly like a 48-test product
regression (`phase5-t6b-status-derivation` 11 failed,
`phase5-t5b-certification` 37 failed) and both were 49/49 green in isolation at the
same working tree. The cause was a background battery that survived a context
compaction and whose reset ran seven seconds into the previous run.

1. Before any battery that resets the shared database, **refuse to start** if
   `pgrep -A -f "vitest.mjs run --config vitest.integration"` or
   `pgrep -A -f test-api-e2e` matches. Print the offending processes and exit
   non-zero.

   **`-A` (`--ignore-ancestors`) is load-bearing, not decoration.** Run inline — the
   way an agent runs it — the checking shell's own command line *contains the search
   string*, and `-f` matches full command lines, so a plain `pgrep -f` reports the
   process doing the checking. The guard then refuses every battery, including the
   one it was meant to permit: a guard that fails closed on nothing at all is worse
   than no guard, because it looks like protection.

   This is easy to miss because **it behaves differently depending on where you run
   it**. Inside a script file the pattern lives in the file rather than on a command
   line, so plain `-f` does not self-match and the rule appears to work; typed
   inline it always self-matches. Verified by execution both ways: inline, plain
   `-f` matched its own shell with no suite running, and `-A -f` did not.

   A `pgrep -f "vitest[.]mjs …"` bracket also avoids the self-match — but only when
   nothing *else* on that command line carries the unbracketed string, which is a
   property of the line rather than of the check. It fails the moment the guard is
   run beside a plain-pattern command, which is how it was first measured here.
   `-A` excludes ancestors structurally and does not care. It needs
   procps-ng ≥ 3.3.16 (4.0.4 in this container).
2. A mass failure concentrated in the first-scheduled suites, in modules the diff
   does not touch, is an **environment** signal, not a product signal. Discriminate
   by re-running one failing suite alone against a separate scratch database before
   diagnosing anything.
3. A scratch database name must contain `test` — `createTestApp` refuses any
   `DATABASE_URL` without it.

### A plausible optimization is a hypothesis until a log says otherwise

When a CI step is slow, the reason it is slow feels obvious, and the fix that
follows from that reason feels safe. Both are guesses until something measures them.

The concrete instance: `playwright install --with-deps` stalled 33 and 36 minutes on
one job's two attempts, and the recorded remedy was to drop `--with-deps` (the
runner image already carries Chromium's libraries) and cache `~/.cache/ms-playwright`
(the download is not the slow part). PR #406 bounded the step in time and deferred
both halves for want of runner evidence. The first green job log after it supplied
that evidence and **refuted both**:

- The libraries are indeed all present — and the 9 packages apt installs anyway are
  **fonts**. The premise was true and the conclusion still did not follow.
- apt and the download cost the same to within 3%, so "the download is not the slow
  part" was simply false. It was stated in a merged PR body and commit message.

Two rules follow.

**Read the job log before spending a review round on a CI change.** The evidence
already exists, in the logs of runs that have passed. It is cheaper than the round.

**Deferring for want of evidence is the correct move, and it has to be finished.**
PR #406 was right to bound the step and name what it was not doing. What made that
deferral pay was going back for the evidence rather than leaving the guess standing
in the record as a plan. A named "not done" that is never revisited becomes an
instruction to a future reader who has less context than the person who deferred it.

Correct such a claim **forward**, in a new commit that says what was wrong and what
the measurement showed. Do not edit the merged PR body: the record of what was
believed at the time is worth keeping next to the correction.

## GitHub Enforcement

After the autonomous workflow is merged **and PR #246 has merged or closed**, add
the new check to `main` protection. Waiting for that terminal state prevents
GitHub branch protection from requiring a job the legacy branch cannot emit.
**That precondition is met as of 2026-07-29 — PR #246 merged at `main`
`67e7a00` — so the settings below should be applied now.** Branch protection is
a repository admin setting (Settings → Branches → `main`); the autonomous
tooling has no admin credential and cannot apply it, so this step is the
owner's. The resulting exact settings are:

- Require status checks: `review-scope`, `battery-plan`, `web`, `api`, `e2e`, `api-e2e`,
  `upgrade-proof`, and `codex-current-head`. `battery-plan` decides whether the five product
  jobs run, so requiring it is what makes a failed planner visible instead of leaving five
  silently skipped products beneath a green summary.
- Require branches to be up to date before merging (`strict: true`).
- Enforce the protection for administrators.
- Keep squash auto-merge enabled for the waiting-state fallback.

Do not add `codex-current-head` before the workflow is present on the default
branch; doing so would intentionally block every PR, including the bootstrap PR.

## External Dependencies

The Codex GitHub review integration, GitHub Actions, and Claude Code web Auto-fix
operate without the owner's computer. Codex and Claude use the owner's product
subscriptions; GitHub stores no AI API key. Claude Auto-fix must be enabled on the
PR before the laptop is unavailable. If that subscription-backed session stops,
the GitHub gate deliberately leaves the PR unmerged rather than silently falling
back to an unreviewed path.

## Review continuity

The gate records review history without rejecting another correction head merely
because earlier heads received findings. Current-head findings still fail
`codex-current-head` and return the existing PR to draft. The watchdog routes the
same declared owner to fix forward; it never orders closure based on a round count.
Obsolete round-limit failures request the existing gate recovery workflow, which
rechecks CI and current-head review rather than clearing the status directly.

Historical replacement labels no longer block unrelated `Replaces: none` work.
Explicit replacement declarations retain their existing provenance checks so
previously carried findings stay traceable. A replacement is exceptional and must
explain a concrete scope or approach benefit; it receives full applicable CI and a
fresh comprehensive review. No finding is dismissed and no clean signal is inherited.

Voluntary replacements without a historical round-limit label must include a
concrete `Replacement reason:` alongside `Replaces: #N`; the source must be a
closed, unmerged PR from this repository targeting `main`, with findings and
proofs preserved in both PRs. Do not replace an already settled source.
