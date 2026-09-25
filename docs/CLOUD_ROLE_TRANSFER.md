# Cloud role transfer staging

This change prepares, but does not activate, the requested role transfer. Codex is
the intended coding owner and Claude Code is the intended independent reviewer.
Cursor remains an optional dispute opinion. The existing `codex-current-head` gate
and branch protection remain authoritative until an atomic later transition.

## Shadow review

`claude-shadow-review.yml` is triggered by GitHub-hosted CI, checks out its trusted
publisher and prompt from the default branch, and checks the candidate out separately
at the immutable PR head. It accepts only one open, same-repository PR targeting
`main`, with successful CI and unchanged base/head bindings. The official Claude Code
action is pinned to commit `7b0b255830a1fab6e602658672acad11c12d841d` and receives
only read permissions. The reviewer's tool surface is constrained, not merely
pre-approved: `--tools "Read,Glob,Grep"` restricts the available built-ins (because
`--allowedTools` alone only pre-approves and does not remove Bash/Write/Edit) and
`--disallowedTools "mcp__*"` denies every MCP tool the action would otherwise enable
from project config. It cannot edit, push, approve, or merge.

Claude returns structured findings. A trusted deterministic publisher validates the
repository, PR, base SHA, head SHA, workflow run id and run attempt, completeness,
every changed file's review coverage, and every finding. It derives the result from
the finding set rather than trusting a model-authored clearance word. The publisher
uploads the full result as a GitHub Actions artifact whose server-side workflow run,
workflow path, job, run attempt, name and digest are verified by the consumer; the
shared `github-actions` App identity and self-asserted check payload are not provenance.
Missing credentials or output, action errors, timeout,
cancellation, malformed output, findings, stale heads, forks, and unauthorized bases
all leave failure evidence; none authorizes merge. This evidence is shadow-only and
is not consumed by branch protection or the current merge gate.

Automatic and manual entries share one per-PR concurrency group with in-progress
cancellation. Each surviving stage still re-fetches the live PR and exact CI binding,
so an older run completing after a new head cannot publish evidence for that new head.
The publisher has `actions: read` only because manual dispatch re-fetches its named CI
run for authorization; artifact upload needs no Actions write permission. Only
`checks: write` is retained for publishing the shadow check.

Candidate content is still adversarial model input. The reviewer's built-ins are
restricted to `Read`/`Glob`/`Grep` and all MCP tools are denied, so it has no shell,
write, or network tools; it receives a diff materialized by trusted code, is told candidate text is data and
must cover every changed file, but these controls do not mathematically prove that a
model resisted every prompt injection. Consequently even server-associated empty
findings are classified only as `shadow_clear`, never authoritative clearance. A real
hosted cycle and an independently reviewed activation contract remain mandatory.

All triggers, runs, bindings, and check results live in GitHub Actions and Checks, so
they are visible from any device and do not depend on a desktop or local runner.

## Pending activation

1. `CLAUDE_CODE_OAUTH_TOKEN` was provisioned as a repository Actions secret on
   2026-09-16. Never copy the token into an issue, log, commit, or agent session.
   Claude Max uses this subscription token; no API key or Team/Enterprise review
   purchase is required for this action path.
2. Run a real hosted shadow review. Once this workflow exists on the default branch,
   its manual dispatch accepts an open PR number, exact head SHA, and the id and
   attempt of a completed successful `CI` pull-request run. The trusted publisher
   re-fetches all of them and refuses mismatches. Verify the
   check's GitHub Actions publisher, run attempt, exact PR/base/head binding, findings,
   failure cases, and a subsequent corrected-head re-review. A workflow launch is not
   activation.
3. Verify, from a GitHub-generated correction request, that the documented Codex
   GitHub integration starts a hosted task and pushes a new head. A human `@codex`
   comment or reaction is not proof. Until that succeeds, Codex is not awakenable and
   existing correction routing must not change.
4. After one real cloud coding → full CI → Claude findings → Codex correction → full
   CI → Claude-clear cycle, atomically add the Claude exact-head gate and switch owner
   routing. Retire `codex-current-head` only after the replacement required check is
   installed and observed. Keep the existing gate on rollback; never leave an interval
   with neither independent-review gate.

Live PR/session handoff evidence (including issue #482 and active PRs) must be checked
before any ownership claim. For PR #597, issue #482 records the prior Claude producer
stopped at 2026-09-16T08:31:17Z with its unpushed checkpoint and stopped findings
preserved. The shadow workflow exists only in PR #597, not on the trusted default
branch, and GitHub registers `workflow_dispatch` only for workflows present on the
default branch. Therefore neither `workflow_run` nor manual dispatch can safely
bootstrap this PR. The draft must remain blocked unless the existing independent gate
clears this exact head or this exact trusted workflow reaches `main` through a
protection-compliant reviewed change; no PR-head workflow may receive the subscription
secret.

That prerequisite is not permission to bypass protection:
`main` enforces administrators and required product/review checks. The base-branch
scope gate admits only truthful Claude/Cursor correction owners, while Codex authored
#597 and Claude has relinquished production coding. A `codex` marker is rejected by
the base gate and a Claude/Cursor marker would be false. Therefore #597 has no safe
self-bootstrap path under the current base policy. It remains draft until a
branch-protection-compliant, independently cleared base-policy admission contract
exists; this PR does not invent an exemption, self-clear, or ask Claude to resume.

The project handover does not reopen stopped or deferred product work. In particular,
#590 at `ae6263ce` remains stopped with all findings and 51-case evidence retained for
its recorded additive redesign; #591, #592 and #594 remain stopped; #595 remains
deferred; and no partial #596 recovery artifact is applied. Reform 4 metrics and later
reform/product units remain queued outside this sole implementation lane.

## Automatic Codex correction wake

The configured Codex GitHub integration documents user-authored `@codex` task
mentions, but the available contract does not say that a comment authored by
`github-actions[bot]` is accepted, nor does it expose a documented Actions API for
starting a hosted Codex task. PR #597 has no GitHub-generated Codex wake that started
a task and pushed a new head. Consequently Codex remains **not awakenable** in the
repository policy.

To MEASURE — not assume — that boundary, this PR adds one bounded, manual,
disabled-by-default probe (`.github/workflows/codex-fix-probe.yml`) that, only when an
operator arms it for one chosen PR/head/finding on the trusted `main` ref, posts a
single `github-actions[bot]`-authored `@codex fix` comment and records the created
comment id and author as dispatch evidence. That is the only bot mention added, and it
is inert until dispatched. No automatic watchdog route, no unattended wake, no
undocumented endpoint, no lease, and no local process is added. Activation still
requires observable GitHub evidence linking an automated trusted event to a new hosted
Codex task and its pushed PR head; a task that only returns a diff or needs "Update
branch" leaves unattended publication unproven.

## Shadow evidence hardening (non-authoritative)

This stage hardens the shadow evidence path only. It does not admit Codex as a correction
owner, change correction routing, or grant any merge authority; the existing
`codex-current-head` gate and branch protection remain authoritative. A separate, later,
independently reviewed unit carries the ownership, protective-hold, and merge-recovery
contract; nothing here anticipates it.

Shadow review requires a server-associated CI merge-identity artifact binding the current target tip,
candidate head, tested merge commit, and the uploading run attempt. The selector accepts only
artifacts server-associated with the exact CI run/head and takes the highest unambiguous upload
attempt no newer than the refreshed run (supporting full and partial reruns). The current target
must also be the comparison merge base, PR-file and comparison-file sets must agree, and candidate
changes to the CI workflow are refused. This remains non-authoritative shadow validation.

The `shadow-merge-identity` CI job that uploads that artifact is auxiliary on BOTH axes: it carries
job-level `continue-on-error`, so a failed or missing identity never turns the aggregate CI run red,
and it is deliberately absent from the `quality-gate` required-status `needs`, so its result never
reaches the quality verdict. Dropping the `needs` edge alone would leave a failed job reddening the
aggregate run, which is why `continue-on-error` is also required. Non-authoritative is not permissive:
shadow authorization is decided by querying the server-associated identity artifact by exact metadata,
not by the job's reported conclusion. A missing, invalid, or conflicting binding denies shadow
authorization — invisible to CI and to the merge gate, fatal to shadow clearance. A job that reports a
failed upload response after the server has already recorded a correctly bound artifact does not, on
that response alone, invalidate the confirmed artifact.

### Private shadow failure diagnostics

The Claude action keeps `show_full_output: false`. An `if: always()` trusted step reads only the
bounded `$RUNNER_TEMP/claude-execution-output.json` file and emits a fixed categorical record
(initialization, result/error/structured-output booleans, and an allowlisted SDK assistant error
enum or `unclassified`) — never transcript content, messages, results, environment data, or
unexpected fields. It distinguishes a bounded early inference failure from an authentication
conclusion without exposing private output. Artifact digests accept only raw 64-hex or canonical
`sha256:` form: the publisher validates and normalizes the digest the upload action returns; the
unchanged non-authoritative consumer compares that reported artifact metadata to GitHub; operator
verification additionally hashes the downloaded ZIP bytes.

### Trusted workflow execution provenance

Both shadow jobs require `refs/heads/main`. The producer checks its workflow and execution refs from
GitHub-provided environment values and binds evidence to the workflow SHA. It re-reads the source CI
run, live PR, current main tip, comparison and PR files, and server-associated CI merge-identity
artifacts; stale or inconsistent bindings and candidate CI-workflow edits are rejected. Publication
records the artifact ID and normalized digest returned by the pinned upload action. The producer does
not independently query its own publisher jobs or download and hash its uploaded artifact. Before a
hosted review counts as operational proof, the operator must verify publisher run/job provenance,
artifact association and downloaded ZIP digest against GitHub server metadata, plus complete
structured coverage of the expected commit.

This unit does **not** change the consumer. The existing (D6) adapter that reads the published shadow
check stays non-authoritative and unchanged: it binds evidence to the shadow-review workflow path and
requires `workflowSha === baseSha`, with no `head_branch` check and no earlier-`main`-SHA allowance.
Broadening consumer-side provenance and finding consumption — a `head_branch=main` check, accepting an
earlier trusted `main` workflow SHA, and full finding admission — is deferred to the later unit. A
source-controlled guard does not sandbox a principal who can replace workflows; repository
administration and branch protection remain outside this mechanism.

### Consumer broadening — main-lineage evidence and full finding admission (non-authoritative)

The consumer broadening the previous stage deferred now lands, still non-authoritative.
`scripts/claude-review-adapter.mjs` no longer pins `workflowSha === baseSha`: it keeps the 40-hex
format check, additionally requires the summary's `workflowExecutionRef` to be `refs/heads/main`, and
moves the `workflowSha` trust anchor onto the server-associated producer check.
`verifyClaudeShadowProducer` (`scripts/autonomous-review-gate.mjs`) now also requires the publisher
run's `head_branch === 'main'`; combined with its existing `run.head_sha === evidence.workflowSha`
proof, that binds `workflowSha` to a real commit the shadow workflow ran at on `main`, so an earlier
trusted `main` workflow SHA is accepted without weakening provenance.

Producer verification now runs for EVERY admitted state, not only `clear`, so a non-clear result
carries the same authenticated artifact/digest/provenance/freshness/dedup/actor obligations as a clear
one; the authenticated state and its finding count are admitted verbatim. Because the publisher
concludes the check, its run and its `publish` job deterministically from the evidence — `success` only
for a clear result with zero findings, `failure` for any non-clear result — the consumer binds the
check conclusion to the evidence and the verifier requires the run/job to conclude in that same
evidence-matching form. A non-clear result therefore authenticates through the publisher's FAILING
run/job (requiring `success` would leave every real finding-bearing artifact unverifiable), while a
conclusion that disagrees with the evidence it carries is rejected. Every consumer path still returns
`authoritative: false`. This grants no merge authority, does not feed branch protection or the
`codex-current-head` gate, retires nothing, and admits no correction owner —
`claude-independent-review` stays absent from the required checks. Flipping the authoritative gate
remains a separate, later, atomically reviewed unit (§"Pending activation" #4); a non-authoritative
consumer improvement does not activate the role transfer.

### Activation evidence reader (trusted, read-only, non-activating)

The activation verdict cannot trust records its caller assembles: "the latest CI attempt", "no push
since the corrective push" and "the live head" are facts about GitHub at decision time. After the #619
convergence stop, the operator approved an additive split. `scripts/role-activation-evidence.mjs` is the
trusted side. For one repository, one PR and one GitHub-generated correction-request comment,
`readRoleActivationEvidence(client, { pullRequest, requestCommentId })` reads the cycle and returns
normalized evidence (`ROLE_ACTIVATION_EVIDENCE_SCHEMA`). Every record carries the identity it was read
under and its milestone's server timestamp. It reuses the existing trusted adapters:

- **Request.** The comment's server `issue_url` binds the repository and PR. Its single `codex-fix-probe`
  marker names the reviewed head and the triggering finding. The author and edit state are reported.
  A comment that is fetched but rejected (another PR or repository, no single marker, a marker naming
  another PR, no readable time) is diagnosed with its reason, never a silent `null`.
- **Acceptance.** The earliest Codex-connector 👀 reaction on that exact request comment. This is an
  observed-behaviour assumption and fails closed.
- **Conversation.** The PR's own title and description, then every issue comment, review comment and
  review on it, read to the last page. Each item carries its server author, its dates and whether its text
  mentions `@codex`. A review has only its submission date and the description only its creation date:
  their edits are undated. The description is read only from a whole record of this PR (number, id,
  author, creation time and title; a null body is a PR without one), and each comment or review only from a
  whole record (id, author, a text or null body, and its dates). A failed or malformed read, a partial
  record, or a source still full after 10 pages (the event log's bound), leaves no conversation, with a
  diagnostic: an unread body is never a "no mention".
- **Findings and reviews.** `classifyClaudeShadowReview` with `verifyClaudeShadowProducer`. A finding's
  identity is its verified check run's own URL. The initial finding is the run the request's marker
  names, not merely the newest review. Later reviews of the reviewed head are listed beside it only when
  producer-verified; a run that merely carries the shadow name is listed apart and counts for nothing.
- **CI.** `resolveRequiredChecks`, the gate's newest-evidence rule, which includes cancelled attempts. A
  CI record is dated by, and names, the run that decided each required name (`deciders`). A superseded
  straggler never dates it. The initial CI is evaluated as of the triggering finding.
- **Corrective push.** The Activity API's branch push log, giving server before/after/type/actor/time;
  ancestry comes from the compare API. The corrective push is the first branch update after the
  request. Every later update is listed, so an away-and-back to the same SHA still shows two updates.
  The log counts only when it reaches back to an update at or before the request. The reader widens the
  API's trailing `time_period` (a day by default) until it does. If it never does, the log is reported
  as uncovered, not guessed.
- **Freshness.** Opening reads decide only what to read: the request, the live PR and the push log.
  Then the freshness point is taken. Every mutable source is then read in the closing pass: the
  request again (it must be unchanged), its acceptance, the PR's conversation, the live PR (head, base ref and repositories),
  both heads' check runs, the push log again, the lifecycle event log below, and last the live PR once
  more (an ordinary fast-forward of the base branch appends no PR event). Each closing read
  starts after the freshness point. So an edit, a push or a retarget (either even away-and-back), a
  later review or a newer CI attempt before that point is visible. A corrective push that lands during
  the pass is reported as a diagnostic, never silently absent. A consumer that acts must re-read and
  bind to the reported decider runs.

The reader decides nothing across records. Identity equality with the caller's expected repository and
PR, the full milestone order, causation and freshness are the pure verdict's rules (#619). An unreadable
or unauthenticated source yields `null` plus a diagnostic, never a partial record. The reader issues
only reads and is wired to no workflow, gate or routing. It does not observe a replacement-gate
installation (none exists), so it never supplies the separate retirement proof. A Claude-finding →
Codex-correction cycle binds its triggering finding through `codex-fix-probe`'s shadow-finding source
(**Claude shadow finding as the probe's source**, below): the request names the shadow check run, which
is exactly the verified finding's `reviewRef`.

### Pull request lifecycle event log (trusted, read-only, non-activating)

A snapshot of a pull request shows what its base, state and head ref are at one read. It cannot show
that they did not change and change back between two reads. A retarget `main → release → main` inside a
window leaves both snapshots equal, while the merge result under test (and the CI it launched) moved.
The #620 evidence reader hit this at its third-head stop (finding 4081030214). Its head freshness already
rests on an append-only history, the branch push log. `scripts/pull-request-event-log.mjs` is the
matching history for base and state.

`readPullRequestEventLog(client, { pullRequest, sinceMs })` reads one pull request's **issue events** and
returns every lifecycle event at or after the anchor, each with its server time, id and actor. Lifecycle
events are base changes (including automatic ones and base-branch deletion), close, reopen and merge,
draft transitions, and head-ref deletion, restoration and force-push. Any event not on the known-neutral
list (labels, assignment, mentions, review requests, auto-merge toggles and the like) is reported too, so
an unknown mutation is surfaced rather than dropped. A comment deletion is not neutral: the deleted
comment could be the correction request.

- **Why issue events, not the timeline.** The timeline mixes in comments, which users can delete. Paging
  through a list with deletions can shift an item across a page boundary and skip it, and repeating the
  read does not prove it untorn. Issue events are system records users cannot delete, so the list only
  grows at its end: a paged read cannot skip an event that existed when it began (`coveredFromMs`).
- **Complete or nothing.** Pages are read to a short page. A log over the page cap, a non-list page, a
  failed read, or ids that do not strictly increase give `covered: false` and `events: null` plus a
  diagnostic, never a partial list.
- **Fail-closed boundaries.** GitHub stamps events to whole seconds, so the anchor is compared at that
  precision and an event in the anchor's own second is reported. An undated lifecycle event is kept.

The log decides nothing. Which events disqualify a cycle, and from which anchor, is its consumer's rule.
It issues only GET requests, writes nothing, and is wired to no workflow, gate or routing.
`codex-current-head` stays required.

**Consumed by the reader.** The evidence reader reads this log last in its closing pass, anchored at the
cycle's earliest milestone: the push-log update that brought the branch to the reviewed head (every
workflow for that head, queued or running, was created after it), else the initial CI's earliest decider
start, the finding or the request, whichever is first. Its freshness record
carries `lifecycleEvents` (with `lifecycleSinceMs`, `eventLogCoveredFromMs` and `eventLogReadAtMs`), so a
retarget or close/reopen away and back is listed even when both live-PR snapshots agree. An incomplete log
is `null` with an `event-log:` diagnostic. The verdict (next section) decides which events disqualify
the cycle.

### Activation-readiness verdict (not activation)

`scripts/role-activation.mjs` is the pure, mutation-free verdict that gates the atomic switch in
§"Pending activation" #4. It touches no live gate and starts nothing. It went through four reviewed
heads on #619, and each fix drew the next identity/ordering/freshness dimension. At the third-head stop
the operator approved an additive split: the verdict now consumes only the trusted reader's normalized
output (the two sections above), and the reader performs every live read.

`roleTransferActivationVerdict(evidence, expected)` takes the reader's `{ schema, cycle, records }` and
the caller's expected `{ repository, pullRequest }`. It never takes the cycle's identity from the
evidence alone. It reports every required proof as `proven` or `missing`. Its state is `hold` while any
proof is missing, and `activate` only when every proof is proven (see **The activate phase** below).

- **Identity.** The schema matches. The cycle names the expected repository and PR, a branch, the base,
  the reviewed and corrective heads (which must differ), and the correction-request id. Every record
  names the expected repository; PR-scoped records also name the PR; CI and review records also name
  the base.
- **Initial legs.** CI on the reviewed head is green as of the finding. The producer-verified
  `changes_required` review of that head, the one the request names, exists, and no later review of
  that head follows it.
- **Request.** The GitHub-generated request (bot author, not human, unedited) is on this PR, for the
  reviewed head, and names that exact finding (`findingRef === reviewRef`).
- **Acceptance.** The Codex connector accepted that same request.
- **Corrective push.** The first branch update after the request is a non-forced push by the Codex
  connector from the reviewed head to the corrective head. The reviewed head is a server-verified
  ancestor (compare `ahead`, `behind 0`). A multi-commit fast-forward is admitted.
- **Causation.** That push was made by the task accepted for this request. Every Codex task pushes as
  the same connector bot, and the request's trailer (below) is public text a second task could be told to
  copy, so neither proves it alone. It rests on the owner's attestation (`CODEX_TASK_ATTESTATION`, next
  section) plus two checks: the complete commit list of the corrective push, ending at the corrective head,
  carries exactly this request's trailer on every commit; and the PR's complete conversation shows no one
  else who could have started a Codex task (next section).
- **Final legs.** The latest applicable CI on the corrective head is green, with a named successful
  deciding run for each required check (the reader names them, so a later installer can bind to that exact
  attempt). The newest producer-verified review of that head is clear.
- **Freshness.** Read after the review. The open same-repository PR targets `main` at the cycle base,
  both at the start and at the end (ref, SHA and both repositories). Its head is the corrective head at
  both reads. No branch update follows the corrective push; an away-and-back to the same SHA is two
  updates. The lifecycle event log is anchored no later than the update that brought the branch to the
  reviewed head, and the initial CI's deciders started after that update (a decider from an earlier
  arrival of the same SHA holds). The log is complete and lists only draft transitions (the controller
  toggles them to request a review; they move neither the base nor the code). Any base change or
  deletion, close, reopen, merge, head-ref or unknown event holds, so a retarget away and back cannot pass
  between two agreeing snapshots. The final live-PR read, after every other closing read, still shows the
  open PR at the corrective head on `main` at the cycle base, so a base fast-forward during the pass
  holds. Every mutable source (request, acceptance,
  live PR, both heads' reviews and CI, push log, event log) was read after the freshness point, which
  follows the pass's opening.
- **Order.** Strictly: initial CI < finding < request < acceptance < corrective push < final CI <
  review < freshness window. GitHub stamps whole seconds, so a tie is admitted only where the records
  prove the order: the request names the finding, and the acceptance is a reaction on the request.

**The activate phase (a readiness decision, not an activation).** When every proof is proven, the verdict
returns `state: 'activate'`, `activate: true` and `install`: the install switch as frozen data, bound to that
exact cycle. The switch **installs** the distinct trusted-controller status `CLAUDE_STATUS_CONTEXT`
(`claude-current-head`, published from adapter-verified shadow evidence, never from the raw
`claude-independent-review` check name) and switches routing (Codex codes, Claude reviews) while
**keeping** `codex-current-head`. The binding is `install.cycle`: repository, PR, branch, base, reviewed and
corrective heads, the correction-request id, the CI runs that decided each required check, and the
verified clear review's own check run (so `boundClaudeClearReReview` now also requires that run's id).
`fullCiGreen` requires exactly one successful deciding run for each required check of the PR, each a
distinct run, and every bound id must be a real GitHub id (a positive integer).
While any proof is missing the state is `hold` and `install` is `null`.

Nothing applies `install`. A later installer must re-read the cycle, bind to `install.cycle`, and require
the operator's authorization: this verdict is necessary, never sufficient. It never retires
`codex-current-head` (`keepCodexCurrentHead` is always true, `retireCodexCurrentHead` always false); that
needs a trusted observation of the installed gate in role, which cannot exist before installation and has
no reader, so it is a separate, later unit. Nothing is added to `REQUIRED_CHECKS`, no routing changes, and
Codex is declared neither awakenable nor activated. The state becomes reachable once a real cycle is
dispatched through the probe's shadow-finding source (below) and observed end to end.

**Convergence stop.** The re-scoped verdict (`e3a0ece1`) drew three findings: an unauthenticated
retirement record, task → push causation, and same-second ties. Together with the controller's fifth
finding-bearing head, that is the stop recorded at #619 comment 5795929840. The narrowing above is its
additive redesign: this unit keeps only what trusted evidence can prove.

### Task → push binding (evidence only, non-activating)

Requested as a maintenance change to the frozen `codex-fix-probe` (the repository owner asked for it after
#619). The correction request now asks Codex to end every commit it pushes with one terminal trailer block:
a line that repeats the request's own identity, and a truthful owner declaration (`correctiveTrailerBlock`):

```
Codex-Fix-Probe: pr-<number>:head-<reviewed head SHA>:finding-<finding reference>
Correction-Owner: codex
```

The owner line is containment, not evidence: Codex authored the commit, so it declares Codex (never Claude),
and the corrective head is a merge-ineligible candidate the controller holds (`OWNERSHIP_CANDIDATE_HELD`,
which opens no correction lease). A commit that drops it is invalid, which is also never merge-eligible.
The request also tells Codex not to edit the PR description or its correction-owner marker.

`probeTrailer`/`probeTrailerValue` build it. `probeTrailersIn` reads it back from the commit message's
terminal trailer block only, as `git interpret-trailers --parse --unfold` reads it (extraction delegated to
git, like the `Correction-Owner` trailer): a value quoted in prose or a code fence is not a trailer, and a
folded continuation joins its value, so it no longer matches. A missing message, or a git that cannot run,
is unreadable (`null`), never "none". The evidence reader lists the corrective push's commits from the
compare API it already reads for ancestry, with each commit's SHA, author and `Codex-Fix-Probe` trailers
(`ancestry.commits`). `ancestry.commitsComplete` is true only when the server returned every commit (the
list's length equals `total_commits`, which equals `ahead_by`), because the compare API returns at most one
page. The reader decides nothing: a missing, mismatched or extra trailer, or an incomplete list, is for the
verdict to judge.

**The trailer is not causation.** Its value is printed in the public request comment, so it identifies
the request, not the task: a second Codex task started on the same head could be told to copy it, and it
pushes as the same connector bot (Codex finding on #623). A commit without the exact trailer is not this
request's, but a fully-trailered push is not thereby proven to be. Whether Codex actually writes the
trailer is observed on a real cycle, not assumed; if it doesn't, the cycle holds.

### Task → push causation (the owner's attestation, non-activating)

After #623 the repository owner chose how causation is proven: an attested assumption plus a check of the
PR. `CODEX_TASK_ATTESTATION` (in `scripts/role-activation.mjs`, repository `JagPat/PMCvitan`, owner
`JagPat`) records it. Codex tasks that can push to this repository's branches are started only by the owner
or by the trusted `codex-fix-probe` request; automatic Codex reviews do not push. During a correction cycle
the owner starts none except by a comment that stays visible in the pull request's conversation: a mention,
once posted, is never edited away. A task started any other way (the Codex web UI, a deleted or since-edited
mention) leaves no complete GitHub record, which is why this part is attested, not checked.

The verdict checks the rest, from the reader's evidence:

- **Commits.** The corrective push's commit list is complete, ends at the corrective head, and lists whole,
  distinct commits (each with its own SHA). Every commit carries exactly one `Codex-Fix-Probe` trailer, equal to the value derived from this cycle's own PR,
  reviewed head and finding (never taken from the evidence). Every commit also declares exactly one
  `Correction-Owner: codex`, read as the controller reads a head (`shaMergeAuthority` → a held
  `candidate`). That is containment, not causation: a commit without it would leave an invalid head the
  controller cannot hold as a candidate, so the cycle holds.
- **Seed.** The cycle ran on a truthful codex candidate seed: the reviewed head commit itself (read once, by
  SHA) declares `Correction-Owner: codex`, and the PR still declares `<!-- correction-owner: codex -->` on a
  branch outside `claude/**` at both closing PR reads. A Claude-owned head relabelled only in the body holds.
- **Conversation.** The PR's complete conversation, its own title and description included, currently has
  no `@codex` mention except the request's (as that issue comment) and the Codex connector's own, however
  old: a task started earlier could still push. (The Codex connector does answer a mention in a PR
  description; it replied to one on #624.)
  A mention the reader could not determine counts as one. And from the update that brought the branch to
  the reviewed head onwards, nothing at all comes from anyone but the Codex connector and trusted workflows
  (`github-actions[bot]`): another author's comment in that window holds whatever its text, and so do an
  older comment edited in it and an undated one. A review's edits are undated (a mention added and then
  removed leaves only the old submission date), so another author's review holds whenever it was submitted
  (Claude shadow finding on #624). The description starts a task only by a mention, so without one it is
  quiet whenever the PR was opened; its edits are undated too, and a mention edited away there, or anywhere
  before the window, is what the attestation rules out. The conversation must carry exactly one description.

A cycle that proves every proof reaches the `activate` readiness state above; nothing is activated,
installed or routed by it.

### Claude shadow finding as the probe's source (manual, non-activating)

`codex-fix-probe` can now key its single `@codex fix` request to a **Claude shadow finding** instead of a
Codex review comment: the operator dispatches it with `shadow_run_id` (the `claude-independent-review` check
run) in place of `finding_comment_id`. Exactly one of the two is accepted. The rest of the probe is
unchanged: `workflow_dispatch` only, from `main` only, armed by `arm-pr-<n>-head-<sha>` for one PR and head,
one comment at most per PR/head, and every input read again and re-authorized immediately before the post.

- **The finding.** The named run must be the NEWEST producer-verified shadow review of this PR and head at
  the PR's live base (`classifyClaudeShadowReview` with `GitHubClient.verifyClaudeShadowProducer`), in
  state `changes_required`. A newer review of the head, clear or not, supersedes it; a moved base or an
  unverified producer refuses. The request names the check run's own URL, which is exactly the verified
  finding's `reviewRef` in the activation evidence reader, so the cycle's request and finding bind.
- **What Codex reads.** The shadow check carries identity only; its findings are in the evidence artifact.
  The probe downloads that ZIP, requires its SHA-256 to equal the published digest, reads the single
  `claude-shadow-evidence.json` from it (`scripts/zip-entry.mjs`: central directory, stored or deflated,
  CRC-32 and size checked, fail closed), requires the file's identity to equal the verified summary field
  for field, and requires exactly `findingCount` (at least one) well-formed findings (`P0`–`P3`, a path,
  an optional integer line, a description).
- **Quoting.** Findings are review output over adversarial candidate content. They are quoted as data:
  at most 20, each description at most 1500 characters, and neutralized so they cannot add a second
  probe marker, mention anyone (no `@codex fix` line of their own), or break out of their quote.
- **Permissions.** The probe job adds `actions: read` and `checks: read`, to verify the producer run and
  read the artifact; it still writes only the one PR comment.

Nothing here activates anything. It makes the observed cycle possible; the verdict and every other gate
are unchanged.

### Observer and the observed-cycle runbook (manual, read-only, non-activating)

`.github/workflows/role-activation-observe.yml` (`scripts/role-activation-observe.mjs`) runs the trusted
evidence reader over one correction cycle and judges it with the pure verdict. The operator dispatches it
from `main` with the PR number and the id of the `codex-fix-probe` request comment that started the cycle.
The job's token is read-only (`actions`, `checks`, `contents`, `issues`, `pull-requests`: read), and it
writes the verdict, every proof, the reader's diagnostics, any install binding and the normalized evidence to
the job summary. It writes nothing to GitHub and applies nothing: an `activate` verdict is a readiness
decision for the separate, operator-authorized installer.

**The observed cycle.** One real Claude-finding → Codex-correction cycle, run once by the owner:

1. **Pick the PR.** An open, same-repository PR targeting `main` whose current head (the *reviewed head*) has
   green CI and a Claude shadow review (`claude-independent-review`) in state `changes_required`, the newest
   verified review of that head. It must be a truthful Codex candidate seed: its body declares
   `<!-- correction-owner: codex -->` on a branch outside `claude/**`, and every commit (the reviewed head
   included) ends with `Correction-Owner: codex`. The probe refuses any other PR (`not_candidate_seed`), and
   the observer's verdict holds unless the reviewed head and the PR both still declare the codex candidate.
   Until candidate scope admission lands (the next unit), `review-scope` refuses a codex marker, so no such
   seed gets CI yet and no cycle can run. Its title, description, comments and reviews must hold no Codex mention
   except Codex's own, and no one but Codex and trusted workflows may have left a GitHub review on it.
2. **Keep the cycle quiet** from the moment the reviewed head was pushed until the observer runs: nobody
   comments on, reviews, edits or pushes to the PR (a Claude session acting through the owner's account
   counts as the owner), the PR is not retargeted, closed, reopened or merged, and nothing is merged into
   `main` (the cycle's base must not move between the reviewed head's shadow review and the observation).
3. **Dispatch the probe** (`Codex correction-boundary probe`, on `main`): `pr_number`, `head_sha` = the
   reviewed head, `shadow_run_id` = that shadow check run's id, `finding_comment_id` left empty, and
   `authorization` = `arm-pr-<pr_number>-head-<head_sha>`. The job's output names the request `comment_id`.
4. **Let Codex correct it.** Expected, and observed rather than assumed: a Codex-connector 👀 on the request,
   then a non-forced push by the connector from the reviewed head, every commit ending with the request's
   `Codex-Fix-Probe` trailer and `Correction-Owner: codex`; then green CI and a `clear` shadow review on
   the corrective head. A Codex head is a candidate (or, without the owner line, invalid), never
   merge-eligible, so the controller holds it rather than merge.
5. **Observe.** Once the corrective head's CI and shadow review are complete, dispatch `Role-transfer
   observer` on `main` with `pr_number` and `request_comment_id`. The job summary shows `activate`, or `hold`
   with each missing proof and the reader's diagnostics.

A `hold` is a result, not a failure: it names what the cycle lacked (for example, Codex not accepting a
bot-authored request, or a missing trailer). Only an `activate` observation leads to the installer, which
needs the operator's authorization and keeps `codex-current-head` required.
