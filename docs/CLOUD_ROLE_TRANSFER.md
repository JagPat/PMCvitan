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

1. The repository owner runs `claude setup-token` in their own trusted environment
   and stores the result as the repository Actions secret `CLAUDE_CODE_OAUTH_TOKEN`.
   Never copy the token into an issue, log, commit, or another agent session. Claude
   Max uses this subscription token; no API key or Team/Enterprise review purchase is
   required for this action path.
2. Publish this branch legitimately and run a real hosted shadow review. Verify the
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
with authenticated GitHub access before publication or any ownership claim. This
checkout had public fetch access but no authenticated GitHub CLI session, so it does
not claim the prior Claude session stopped or that unattended correction is active.
