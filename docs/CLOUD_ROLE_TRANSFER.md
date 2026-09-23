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
- **Acceptance.** The earliest Codex-connector 👀 reaction on that exact request comment. This is an
  observed-behaviour assumption and fails closed.
- **Findings and reviews.** `classifyClaudeShadowReview` with `verifyClaudeShadowProducer`. A finding's
  identity is its verified check run's own URL. The initial finding is the run the request's marker
  names, not merely the newest review. Later reviews of the reviewed head are listed beside it.
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
  request again (it must be unchanged), its acceptance, the live PR (head, base ref and repositories),
  both heads' check runs, and last the push log again. Each closing read starts after the freshness
  point. So an edit, a push (even away-and-back), a retarget, a later review or a newer CI attempt
  before that point is visible. A corrective push that lands during the pass is reported as a
  diagnostic, never silently absent. A consumer that acts must re-read and bind to the reported
  decider runs.

The reader decides nothing across records. Identity equality with the caller's expected repository and
PR, the full milestone order, causation and freshness are the pure verdict's rules (#619). An unreadable
or unauthenticated source yields `null` plus a diagnostic, never a partial record. The reader issues
only reads and is wired to no workflow, gate or routing. It does not observe a replacement-gate
installation (none exists), so it never supplies the separate retirement proof. `codex-fix-probe` keys
a request only to a Codex review comment, so a Claude-finding → Codex-correction cycle cannot bind its
triggering finding until a later probe variant can key a request to a Claude shadow finding. Until
then the verdict holds, fail closed.

### Pull request lifecycle event log (trusted, read-only, non-activating)

A snapshot of a pull request shows what its base, state and head ref are at one read. It cannot show
that they did not change and change back between two reads. A retarget `main → release → main` inside a
window leaves both snapshots equal, while the merge result under test (and the CI it launched) moved.
The #620 evidence reader hit this at its third-head stop (finding 4081030214). Its head freshness already
rests on an append-only history, the branch push log. `scripts/pull-request-event-log.mjs` is the
matching history for base and state.

`readPullRequestEventLog(client, { pullRequest, sinceMs })` reads one pull request's issue timeline and
returns every lifecycle event at or after the anchor, each with its server time, id and actor. Lifecycle
events are base changes (including automatic ones), close, reopen and merge, draft transitions, and
head-ref deletion, restoration and force-push. Comments, labels, reviews and commits are left out.

- **Complete or nothing.** Pages are read to a short page. A timeline longer than the page cap, a
  non-list page or a failed read gives `covered: false` and `events: null` plus a diagnostic, never a
  partial list.
- **Two passes.** A deletion mid-read shifts later items across page boundaries. So the timeline is read
  twice, and the first pass's item sequence must be a prefix of the second's. Appends are fine; a shift
  fails closed. Items are keyed by immutable fields, so an edited comment is not a shift.
- **Undated events are kept.** A lifecycle event without a readable time cannot be ordered before the
  anchor, so it is reported with `atMs: null`.

The log decides nothing. Which events disqualify a cycle, and from which anchor, is its consumer's rule.
It issues only GET requests, writes nothing, and is wired to no workflow, gate or routing.
`codex-current-head` stays required.
