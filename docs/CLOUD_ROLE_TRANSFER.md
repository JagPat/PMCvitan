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

## Ownership admission and routing foundation (non-authoritative)

The first sequential successor to the stopped `codex/**` recovery unit. It installs ownership resolution
WITHOUT changing what is authoritative: the `codex-current-head` gate and branch protection still decide
every merge, and no owner routing is switched on. Two units follow, published only after this
protected-merges: task classification and continuation shepherding, then merge recovery and backlog
reconciliation.

**HEAD-bound owner resolution is three-valued.** Authority is the exact server-verified HEAD commit's
single terminal `Correction-Owner:` trailer (read Git-faithfully; a marker in prose or a code fence is
not a trailer), which must AGREE with the leading PR-body marker; branch names never authorize. The
three cases each consumer acts on: **eligible** (trailer names a merge-eligible owner, body agrees —
only this may promote/merge); **readable-inconsistent** (a clean read with a missing/invalid/
disagreeing trailer — an author-fixable fault: a `scope:` failure leading with a shared signature,
redraft, auto-merge disabled, correction STALLED so no owner is woken, a new agreeing head owed); and
**unreadable-infra** (the commit could not be read — retryable infrastructure: a retryable placeholder
the watchdog re-dispatches, never an author accusation).

**Codex is a truthful candidate** alongside `claude`/`cursor`: trackable as an in-flight unit but NOT
awakenable (task and reviewer share one bot identity) and NOT merge-eligible — a consistent Codex head
is held PENDING independent reviewer activation. **Ownership is a precondition of scope** at every entry
(review attempt, enforcement, final admission), but a more actionable non-retryable CI/current-head
failure short-circuits first, and a retryable placeholder never masks a fresh ownership fault.

This unit does **not** activate unattended role reversal and does **not** change continuation/drift
selection: continuation still selects Claude PRs exactly as before, and task classification — distinguishing
autonomous product/correction PRs from maintenance PRs at pointer selection AND at every `openPullRequests`
consumer (`buildDriftHandoff`, `buildPostMergeContinuation`) — is the deferred next successor, with merge
recovery and backlog reconciliation after it. Nothing here anticipates either.
