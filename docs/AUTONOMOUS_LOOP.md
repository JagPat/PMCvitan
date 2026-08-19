# PMC Vitan Autonomous Build Loop

This repository is designed to progress without the owner's laptop or technical approval. GitHub is the durable control plane; conversations are not.

## Roles

| Role | Responsibility |
| --- | --- |
| Cloud runner | Read `docs/STATUS.md`, start the current work item, and never skip ahead |
| Claude Code web | Author code, tests, migrations, packets, and corrections on `claude/**`; keep Auto-fix subscribed until the PR reaches a terminal state |
| Cursor agent | Author and correct the PRs that declare `<!-- correction-owner: cursor -->`; GitHub cannot start this session, so its stalled corrections are reported for a human to resume |
| Codex Cloud | Independently review every PR head using `AGENTS.md`; never implement its own findings |
| GitHub | Hold drafts, run required CI, trigger Codex by moving CI-green drafts to ready, enforce an exact-head review status, and merge |
| Coolify | Deploy merged `main` |

## Authoritative Read Order

1. `docs/STATUS.md`
2. The `phase_plan` named by that file
3. Any `blocking_directive` named by that file
4. `AGENTS.md` for review and integrity rules
5. `CLAUDE.md` and architecture documentation for broader context

`docs/ROADMAP.md` and review packets are historical evidence. They may explain the lineage, but they do not override `docs/STATUS.md`.

## One Cycle

1. The runner selects only the work item in `docs/STATUS.md`.
2. Claude starts from latest `origin/main`, records the base SHA, opens a draft PR, enables web Auto-fix, and remains subscribed.
3. GitHub first runs the two dependency-free gates `review-scope` and `battery-plan`, then requires `web`, `api`, `e2e`, `api-e2e`, and `upgrade-proof`. An unjustified broad review unit stops before the expensive jobs. A first product-CI failure receives one GitHub-native failed-job retry; deterministic `review-scope` failures do not. A second product failure remains draft and blocked for a real correction. When all seven pass on the current head, the trusted default-branch workflow sets `codex-current-head` pending and marks the draft ready.
4. Marking the PR ready triggers Codex. The same exact-head workflow run polls that one invocation to its terminal result and accepts only evidence from `chatgpt-codex-connector[bot]` for the current SHA and review cycle. Review and review-comment webhooks never start or mutate the merge workflow.
5. A current-head finding fails `codex-current-head` and returns the PR to draft. The PR's DECLARED correction owner reproduces the complete first-round finding set and may push one coherent correction; that push invalidates every prior clearance. If the correction head also receives findings, the trusted owner stops that PR and requires a newly scoped replacement from current `main`.
6. A fresh current-head clean Codex signal succeeds `codex-current-head`. GitHub then squash-merges that exact reviewed SHA immediately when the PR is clean. If GitHub still reports a waiting state, the controller queues squash auto-merge with the same expected head OID; a clean-state race retries the exact-SHA merge once. Missing CI, stale evidence, timeout, or inactive authoring all fail closed.
7. The merge controller explicitly dispatches the trusted handoff workflow because GitHub suppresses ordinary workflow events produced by `GITHUB_TOKEN`. The dispatch is retried three times, and an hourly GitHub-side watchdog drains the durable cursor if the immediate dispatch is interrupted. The handoff waits for a queued merge when necessary, always drains merged work and conflict state before rescheduling an open wait target, and posts one marked `@claude` continuation. Coolify deploys `main`; the runner updates `docs/STATUS.md` and begins the next work item only after merge.

## Review Units And Round Reset

- A standard PR is one user workflow or one architectural concern, at most 20
  files and 1,500 changed lines. PR #247 and later are enforced; earlier PRs are
  grandfathered and retain the original five required checks — neither
  `review-scope` nor `battery-plan` is required of them — so an older branch
  cannot be stranded by a job it does not contain.
- A justified large PR uses the PR template's marker and completes all six risk
  rows: authorization/tenancy, civil time/lifecycle, concurrency/idempotency,
  data integrity/conservation, offline/reconciliation, and UI/server parity.
- For PR #346 and later, the pre-review checklist covers concurrency and
  serialization, old-release migration compatibility, triggers and alternate
  writers, authorization and tenancy, and reproduce-first CI. The gate reads the
  cumulative file list and fails closed if that evidence cannot be inspected.
- Migration changes use a separate review unit from service or UI work whenever
  there is a viable seam. The rare inseparable unit carries
  `<!-- migration-scope: inseparable -->` and explains the concrete compatibility
  boundary; a checked box or marker never replaces the underlying proof.
- The PR-side scope check is fast feedback. The trusted default-branch owner
  re-evaluates the PR metadata and every evidence cell before review promotion,
  so editing the PR's policy script cannot bypass the merge boundary.
- Product CI runs once per SHA, in ONE workflow. Every PR event (including
  `edited`) runs through `ci.yml`, so a completed CI run always wakes the
  trusted owner; the cheap `battery-plan` job gates the five product jobs — a
  metadata-only body/title edit whose head already has real product runs skips
  them, while a base retarget (`changes.base`) or a head whose product jobs
  never really ran (a large PR whose first run failed `review-scope`) gets the
  full battery. The required-check summary reads the newest REAL run per check
  name: a skipped run defers to the evidence it kept, and a stale failure
  never outlives a newer passing run. `scripts/autonomous-ci-battery.test.mjs`
  and the gate tests pin all of this.
- Claude self-audits those rows before the first review. Codex performs one
  comprehensive first pass and batches all findings. Correction reviews cover
  the delta, prior findings, and affected adjacent invariants.
- After two distinct Codex finding-bearing heads, the current PR is exhausted:
  no third correction head is accepted. Close it and open a smaller replacement
  from current `main`, limited to the unresolved review unit and carrying
  `Replaces: #<closed-pr>` in the body. Historical convergence packets and
  trailers cannot reset this count.
- The replacement receives a fresh comprehensive review and the full applicable
  CI battery. Resetting the PR bounds accumulated patch risk; it does not waive,
  dismiss, or downgrade any finding.
- `review-replacement-required` marks the exhausted unit and NEVER moves. What
  settles it is a CLAIM: when the trusted controller admits a `Replaces: #N`
  declaration it labels the claiming unit `review-replaces-N`.
- A claim is read from the issue TIMELINE, never from the label set. Labels carry
  no proof of who applied them and anyone who can manage a pull request here can
  apply one; the timeline records the actor and the time of every label event and
  nothing can edit it afterwards. A label the controller did not write is not a
  claim, and removing one does not undo a claim it did write.
- Discharge follows the claims, and every edge is one the controller wrote: a
  MERGED unit claiming #N settles it, and so does a claiming unit that closed
  unmerged and is itself settled. A claim still open settles nothing — work in
  flight is not work merged — so an exhausted unit keeps refusing every
  `Replaces: none` unit in the repository until its chain reaches a merge.
- A claimant must BE a replacement: opened after the unit it replaces, opened
  after that unit closed, and BRANCHED from the default branch after that
  closure — targeting `main` is where a pull request is going, not where its
  branch came from, and a branch cut from a stale `main` would otherwise settle
  an obligation with scope that never carried it.
- Two claims can be admitted at once: nothing in GitHub makes label writes
  mutually exclusive, so both runs can read a state with no claim and write one.
  The timeline orders them, the EARLIEST recorded claim is the claim, and the
  rest are not — so both runs converge without having been serialised.
- One unit, one claim. A unit whose claim is recorded cannot take on a second:
  its label names the source, so a declaration edited to point elsewhere changes
  nothing.
- The claim is recorded only after the pull request is re-read. The scope, files
  and lineage are read asynchronously, and a head pushed or a declaration edited
  while they were in flight would otherwise record a claim for scope the
  controller never assessed.
- Three shapes this has already been through, and each one is pinned by a probe.
  Deriving the chain from `Replaces:` PROSE let an unrelated exhausted unit have
  a source written into it afterwards, so a merged replacement of it discharged
  scope it never carried; ordering the edges by number, then by closing time,
  narrowed the window without proving when the declaration was written. MOVING
  one boolean label recorded that a debt was taken on but not which, and moving
  it is two writes, so an interrupted move and a unit absorbing a second
  obligation became the same state. Telling those apart by the claimant's own
  review history cannot distinguish a half-finished transfer from a completed
  transfer of a different source.
- The labels the previous rule left behind are named in
  `LEGACY_SETTLED_OBLIGATIONS` and are not live obligations — #344 and #357 were
  discharged by merged replacements, and #367, #373, #374 and #375 are the
  chain the claim rule shipped in. That list is an explicit migration, not a rule that
  keeps recognising such labels: any rule general enough to spot them would read
  bodies and merge states, which is the forgery the claim label removes. Nothing
  is added to it again.

No human approval is required. The owner may interrupt or redirect the loop, but is not a technical gate.

## Correction Ownership

Every pull request declares, in its body, which agent will fix its review
findings:

```
<!-- correction-owner: claude -->
<!-- correction-owner: cursor -->
```

Exactly one, and it is not optional. `review-scope` — the first CI job, which
every product job declares `needs:` on — refuses a missing declaration, an
unknown agent, two different declared owners, or a `claude/**` branch declaring
anything other than `claude`. A refusal there costs no product battery and no
Codex invocation. The trusted default-branch controller re-evaluates the same
assessment before review promotion, so editing the PR-side script cannot bypass
it.

Nothing infers the owner, because nothing can. The branch prefix does not carry
it — PR #349 (Claude-owned) and PR #350 (Cursor-owned) were both on `codex/**` —
the PR author is the repository owner either way, and no API tells GitHub
whether a subscription-backed Claude or Cursor session is alive. Before the
declaration existed the controller answered anyway, telling both PRs
"Claude Auto-fix handles the review comments and pushes a new head"; on #350
that was false, and the owner had to notice and kick both by hand.

Every correction notice is now derived from the declaration:

| Declared owner | Finding, CI, scope and replacement notices |
| --- | --- |
| `claude` | Claude Code web Auto-fix is named as the owner of the correction |
| `cursor` | routed but not awakenable — the Cursor agent is named, Claude is never claimed, and the notice states plainly that GitHub can neither start that session nor observe whether it is running |
| undeclared / invalid / contradictory | no agent is routed; the notice reports `correction_stalled` and names the marker that fixes it |

### Naming an owner is not waking one — the correction lease

Routing decides WHO is asked. Asking them, and noticing that nobody started, is
the **correction lease** (`scripts/correction-lease.mjs`), driven by the hourly
handoff job's watchdog (`handOffCorrectionLease`). Routing shipped first as its
own reviewed unit, because a handle ships WITH the consumer that reads it.

The watchdog opens a lease when the exact head's required `codex-current-head`
status is a **failure someone owes a correction for**, decided by the status
PREFIX the gate writes — `review:`, `scope:`, `ci:` — never by the sentence after
it. An earlier draft matched the two Codex-finding sentences and so never saw the
review-round-limit failure, the one state whose remedy is a replacement rather
than another head. `recovery:` is the gate retrying itself and opens no lease.

Two refinements sit on top of that without weakening it: the prefix decides
WHETHER a correction is owed, where a miss means silence; the sentence may refine
WHAT is asked, where a miss is merely generic.

- **A gate-retryable review failure is DISPATCHED, not reported.** A timed-out
  review, evidence that moved under the gate, required CI changing mid-review, a
  requested bootstrap review — all four mean the gate did not reach a verdict,
  and all four are recovered by the gate being re-dispatched. No agent owes
  anything, so no lease opens; instead the watchdog calls the recovery
  `workflow_dispatch` with the pull request, the exact head and the terminal
  status id the gate authorises against — the workflow already holds
  `actions: write` and already dispatches itself, so asking the gate directly is
  smaller than a runbook for a human and cannot go stale. Acceptance lands on
  `codex-recovery-request/<id>` and leaves the original failure in place, so the
  dispatch is held while that request is pending rather than repeating hourly.
  The list lives in `review-efficiency.mjs` and the gate reads the same one, so a
  fifth cannot be added there and silently become an actionable correction here.

- **A scope notice leads with the verdict that is failing.** The scope gate
  publishes several — an undeclared correction owner, replacement lineage, an
  unchecked pre-review item, a missing migration seam, the review unit's size —
  and they have different remedies. Naming only the size remedy sent every other
  verdict an instruction that could not clear it, and the lease publishes once
  per failure, so the wrong instruction was the only one that arrived. The gate
  summarises a failed PR-side `review-scope` check as
  `ci: Failed checks: review-scope`; that is routed as the scope verdict it is,
  not as CI, because a new head cannot clear it and a body edit can.

The lease has three properties the manual kick it replaces cannot guarantee:

- **Idempotent.** Keyed to `(pull request, exact head, owner, owed failure)` and
  carried in the published comment's own marker. The failure is part of the key
  because the head does NOT move when a body edit clears a scope refusal, so the
  next gate run can publish a different failure on that same SHA — and a
  reason-agnostic key let the first notice silence the second, stalling the loop
  behind a verdict nobody could act on. One notification per key, ever — a repeated
  cron tick, a replaced Actions run, or a second event for the same head all
  publish nothing.
- **Actionable.** The notice is a **new** comment, which is the only thing that
  creates a GitHub notification. The `@claude` mention lives there, and only for
  an owner GitHub can wake; the state comment above is `PATCH`ed once it exists,
  so a handle written there would look like a wake-up and wake nobody. A
  Cursor-owned correction is never tagged and never attributed to Claude.
- **Honest.** It is cleared by a new head, or by that required status ceasing to
  fail — a scope refusal is routinely cleared by editing the PR body with no new
  head at all. Nothing else clears it.

  **A notice is published only if a fresh read still produces the identical
  notice.** It is composed from a snapshot — the failing status, the head, the
  owner declaration — and everything after that takes time each of them can
  change in. Three review rounds each found a different input that could move in
  that window, so the guard is not a list of inputs: the whole assessment is
  re-derived from a fresh read and compared. A body differing by one character
  means something the notice depends on changed, and the next hourly tick
  reassesses rather than this one publishing a stale verdict — a lease key is
  claimed forever, so a wrong notice is worse than a late one. Not by the notification existing, not by a
  reaction, not by a reply. Both PRs that started this work were acknowledged
  only as a subscription and produced no correction, which is exactly the state
  an acknowledgement-based check would have called healthy.

It publishes a comment and nothing else: no `codex-current-head`, no draft
change, no merge, no Codex invocation. Its remit is every same-repository pull
request against the default branch, `codex/**` included, because ownership is
declared and not inferable from the branch. A watchdog that could not assess a
pull request fails the handoff job rather than letting it report green over an
unobserved correction — reporting green is the defect this replaces.

A notice for a non-awakenable owner reports the routing and nothing more. It
never asserts that no correction is in flight, and never makes a new head the
test of one: a human may have started the session already. Reporting that as
stalled invites a duplicate intervention.

### `correction_stalled`

`correction_stalled` is the routing state for a correction nobody can be asked
to start — today, every undeclared, invalid or contradictory declaration. The
notice names the defect and the exact action that resolves it, and resolves to no
agent, least of all to Claude by default. A declared owner GitHub cannot start
(today, any owner other than `claude`) is routed by name, with the notice stating
that GitHub cannot begin that session. Neither ever
says a correction is under way. This is the honest reading of a
subscription-only loop: a Cursor session is started by a human, and pretending
otherwise is what let two PRs sit for an hour.

### Every pull request declares an owner

There is no exemption by number. An earlier draft grandfathered PRs at or below
#350 so that #349 and #350 — open at the time, and off-limits to edit — were not
retroactively blocked. Every PR in that range has since closed (#338, #344,
#349, #350, #352, #356), so the carve-out protected nothing while contradicting
the rule beside it: a PR inside it could pass `review-scope` with no owner and
then route to nobody on its first finding. The constant is gone, and
`review-scope` refuses an undeclared, unknown, or self-contradicting declaration
at any PR number.

A pull request that predates the requirement — including one reopened from
before it — is bootstrapped by DECLARING: adding the marker to the body reruns
the scope gate through the ordinary `edited` CI event and routes every
subsequent notice correctly. Ownership is recorded, never reassigned, and no PR
is edited on another owner's behalf.

## Non-Negotiable Safety Rules

- Review happens before merge, especially for migrations.
- Deployed migration bytes are immutable; corrections use new forward migrations.
- A PR remains draft while any Codex finding is unresolved. Its temporary ready
  state exists only to invoke Codex after CI passes.
- Claude does not self-certify a Codex finding as closed; Codex re-reviews the new head.
- Task N+1 never starts while `docs/STATUS.md` keeps Task N open.
- Never add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, a Cursor credential, or an AI
  action. Codex GitHub review, Claude Code web Auto-fix, and any Cursor agent use
  the owner's product subscriptions. This is why a declared owner GitHub cannot
  wake is ROUTED BUT NOT AWAKENABLE — named in the notice, which states plainly
  that GitHub cannot begin that session — rather than started. Only an absent or
  malformed declaration is `correction_stalled`, because only then is there no
  owner to name.
- A write-capable workflow checks out only the trusted default branch, never PR
  code. Only open same-repository PRs are eligible.
- Credentials and raw transcripts never enter Git. In particular, never commit Coolify tokens, SMTP credentials, database passwords, `.env` contents, or local attachments.

## Recovery

When an accidental merge or stale state occurs:

1. Stop the next task.
2. Review the exact merged tree.
3. Record validated findings in a focused directive.
4. Change `docs/STATUS.md` back to `in_progress` for the correction.
5. Fix forward from current `main`; never rewrite deployed history.

If Codex or Claude web is unavailable, do not bypass the gate. The exact-head
status remains pending or fails after the bounded retry, and the PR stays draft.
After the subscription service is healthy, recover only the PR's current head:

```bash
PR=230
HEAD_SHA=$(gh pr view "$PR" --repo JagPat/PMCvitan --json headRefOid --jq .headRefOid)
TERMINAL_STATUS_ID=$(gh api --paginate --slurp \
  "repos/JagPat/PMCvitan/commits/$HEAD_SHA/statuses?per_page=100" \
  --jq 'def active_pending: .state == "pending" and ((.description // "") | startswith("review: pending") or startswith("Waiting for required CI")); def retryable: .state == "failure" and ((.description // "") as $description | ($description | contains("Codex review timed out")) or ($description | contains("Codex evidence changed during final verification")) or $description == "review: Required CI changed during current-head Codex review" or $description == "review: bootstrap exact-head review requested"); def persistent: .state == "failure" and (((.description // "") | startswith("review:") or contains("current-head Codex finding") or contains("Codex submitted a current-head review")) and (retryable | not)); add | map(select(.context == "codex-current-head")) as $statuses | ($statuses[0] // {}) as $latest | if any($statuses[]; persistent) then empty elif ($latest | active_pending) then $latest.id else ($statuses | map(select(retryable)) | (.[0].id // empty)) end')
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

## Current Position

Phase 4 is complete (PR #246 merged at `main` `67e7a00`). Phase 5 planning is the
recorded `next_task` in `docs/STATUS.md` and is in progress on draft PR #252
(branch `claude/phase5-planning`). The autonomous handoff workflow posts
`@claude` continuation comments after each exact-head merge and, on the hourly
cron, a drift shepherd when `open_pr: none` disagrees with live open `claude/**`
PRs. See `docs/STATUS.md` and `scripts/runner-continuation.mjs`.

## External Dependencies

The Codex GitHub review integration, GitHub Actions, and Claude Code web Auto-fix
operate without the owner's computer. Codex and Claude use the owner's product
subscriptions; GitHub stores no AI API key. Claude Auto-fix must be enabled on the
PR before the laptop is unavailable. If that subscription-backed session stops,
the GitHub gate deliberately leaves the PR unmerged rather than silently falling
back to an unreviewed path.

## Review-round reset

The round limit applies uniformly to code, migrations, UI work, and documentation.
After the first finding-bearing head, the author may make one batched correction
that reproduces and addresses the complete set. If that correction head also has a
finding, the trusted owner publishes `replacement_required`, returns the PR to
draft, and does not invoke Codex again for another head on that PR.

The author closes the exhausted PR and starts from current `main`. The replacement
body declares `Replaces: #<closed-pr>`, carries forward every unresolved finding
and its reproduction, and narrows the diff to one reviewable unit. Work already
merged to `main` is not replayed. Unrelated service, UI, refactor, or migration work
moves to separate PRs; migration and service/UI code remain together only when the
template records why no safe compatibility seam exists.

This is a review-unit reset, not a finding reset. The replacement runs the full
applicable CI battery, receives a fresh comprehensive Codex review, and still fails
closed on any current-head finding. A convergence packet, commit trailer, extra
commit, or body edit on the exhausted PR cannot create another review round.
