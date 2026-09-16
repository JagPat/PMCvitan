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
only read permissions. It cannot edit, push, approve, or merge.

Claude returns structured findings. A trusted deterministic publisher validates the
repository, PR, base SHA, head SHA, workflow run id and run attempt, completeness,
and every finding. It derives the result from the finding set rather than trusting a
model-authored clearance word. Missing credentials or output, action errors, timeout,
cancellation, malformed output, findings, stale heads, forks, and unauthorized bases
all leave failure evidence; none authorizes merge. This evidence is shadow-only and
is not consumed by branch protection or the current merge gate.

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
clears this exact head or a repository administrator installs this exact trusted
workflow on `main`; no PR-head workflow may receive the subscription secret.

## Automatic Codex correction wake

The configured Codex GitHub integration documents user-authored `@codex` task
mentions, but the available contract does not say that a comment authored by
`github-actions[bot]` is accepted, nor does it expose a documented Actions API for
starting a hosted Codex task. PR #597 has no GitHub-generated Codex wake that started
a task and pushed a new head. Consequently Codex remains **not awakenable** in the
repository policy. No watchdog route, bot mention, undocumented endpoint, lease, or
local process is added here. Activation requires observable GitHub evidence linking
an automated trusted event to a new hosted Codex task and its pushed PR head.
