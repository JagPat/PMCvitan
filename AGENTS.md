# Agent entrypoint

Read [docs/POLICY.md](docs/POLICY.md) before authoring, reviewing or monitoring work.
It is the canonical contract for requirements, rationale, exceptions and evidence.
Shared executable definitions live in [scripts/review-policy.mjs](scripts/review-policy.mjs).

Read [docs/STATUS.md](docs/STATUS.md) for current work, then its active plan and
blocking directive. Use [docs/AUTONOMOUS_LOOP.md](docs/AUTONOMOUS_LOOP.md) for operations.
Apply the canonical contract to the actual diff and current GitHub evidence.
Do not recreate policy lists here or treat historical chronology as a current order.

## Review guidelines

The merge gate and `review-scope` read correction ownership from exactly one commit: the pull
request's head commit (`head.sha`). Only that commit message's final trailer block counts
(`shaMergeAuthority` in [scripts/correction-owner.mjs](scripts/correction-owner.mjs)).
A review checkout is usually a merge commit (`refs/pull/<n>/merge`, or one made locally), and its
message carries no trailers. Never report a missing or invalid `Correction-Owner` trailer from such a
commit: read `git log -1 --format=%B <head.sha>` (`HEAD^2` on a merge checkout), and report only when
that exact commit lacks it. Earlier PR commits and commits outside the PR do not affect merge ownership.
