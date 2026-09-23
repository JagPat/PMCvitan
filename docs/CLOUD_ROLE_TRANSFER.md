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

### Activation-readiness contract (not activation)

`scripts/role-activation.mjs` is the pure, mutation-free contract that gates the atomic switch
described in §"Pending activation" #4. It touches no live gate and starts nothing: it reads
evidence and returns a verdict. `roleTransferActivationVerdict(evidence)` binds ONE correction cycle on
EVERY identity dimension: every record must name the SAME cycle identity — the correction request, PR,
branch, the **base SHA** the cycle is reviewed against, and the pre-correction (reviewed) head — so
evidence from a different PR/branch/request, a different base (a retarget or an advancing `main`), or
supplied out of order cannot be recombined into a false `activate`. The proofs, in the order the cycle
occurs:

0a. **Initial full CI green** on the reviewed head, at the cycle base.
0b. **The initial Claude finding** on that head that TRIGGERED this correction request (a
   `changes_required` shadow review bound to the request id, at the cycle base) — the full-cycle
   contract's "Claude findings" leg, not just the final clear.
1. **GitHub-generated Codex task acceptance** for this request — an automated GitHub event started a
   hosted Codex task that CAUSED exactly the corrective head; a human `@codex` mention is not proof.
2. **Same-branch corrective push** for this request — a NON-FORCED fast-forward advancing the tip from
   the reviewed head (`before === originalHead`) to the corrective head (`after === correctiveHead`),
   with the reviewed head a server-verified ancestor of the corrective head (`forced === false &&
   originalIsAncestor === true`). before/after tips alone are insufficient (a force push can carry any
   tips), so ancestry is proven, not assumed — while still admitting a task that pushed more than one
   commit (no direct-parent requirement).
3. **Full CI green** on the corrective head, at the cycle base, for this request, run AFTER the push.
4. **A bound independent Claude clear re-review** on that exact corrective head, at the cycle base, for
   this request, run AFTER the push — a `shadow_clear` from the (still non-authoritative) consumer.
   Binding the request and the after-push order defeats replay of a prior clear on a restored SHA.

Retirement of `codex-current-head` is a separate, repository-bound and ordered proof: the replacement
gate must be installed as required FOR THIS REPOSITORY and, at a strictly later time, observed passing
in role on a real head under an identified trusted-controller observation.

**Boundary — pure shape/consistency vs. trusted-consumer authentication.** This module verifies that
every required field is PRESENT and INTERNALLY CONSISTENT (one cycle identity on every record, the
correct SHAs, non-forced fast-forward with an agreeing ancestry flag, and monotonic run ordering). It
does not and cannot AUTHENTICATE evidence against GitHub: producing and server-verifying these fields —
the repository match to the installation, the ancestry/fast-forward comparison, and the authenticated
run, observation and installation identities — is the trusted consumer's responsibility, exactly as the
shadow path delegates producer authentication to `verifyClaudeShadowProducer`.

Anything missing → `{ state: 'hold', keepCodexCurrentHead: true, missing: [...] }`: the existing
`codex-current-head` required gate stays in force. When every cycle proof holds, activation is
permitted in TWO phases so no interval is ever left with neither independent-review gate:

- `activate` — INSTALL the replacement gate and switch routing while KEEPING `codex-current-head`
  required. `keepCodexCurrentHead` stays `true`. The replacement gate is `ACTIVATION_INSTALL.addRequired`
  = a **distinct trusted-controller status** (`CLAUDE_STATUS_CONTEXT`, `claude-current-head`) the
  controller publishes only from ADAPTER-VERIFIED shadow evidence — **not** the raw
  `claude-independent-review` producer check name, whose promotion would let a PR-emitted check of that
  name satisfy branch protection without a verified review.
- `retire` — only once a SEPARATE proof (`replacementGateInstalledObserved`) shows that replacement
  gate installed as required AND observed in that role does the verdict retire `codex-current-head`
  (`ACTIVATION_RETIRE.retire`), setting `keepCodexCurrentHead: false`.

`ACTIVATION_SWITCH` is the whole switch as DATA (`ACTIVATION_INSTALL` + `ACTIVATION_RETIRE`). This unit
APPLIES none of it: it adds nothing to `REQUIRED_CHECKS` (neither the raw shadow check nor the trusted
replacement status), changes no routing, and makes nothing a merge gate. It declares Codex neither
awakenable nor activated; the observed cloud cycle and the operator-authorized atomic switch remain the
separate, later step this contract exists to gate.
