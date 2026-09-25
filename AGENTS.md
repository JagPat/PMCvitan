# Agent entrypoint

Read [docs/POLICY.md](docs/POLICY.md) before authoring, reviewing or monitoring work.
It is the canonical contract for requirements, rationale, exceptions and evidence.
Shared executable definitions live in [scripts/review-policy.mjs](scripts/review-policy.mjs).

Read [docs/STATUS.md](docs/STATUS.md) for current work, then its active plan and
blocking directive. Use [docs/AUTONOMOUS_LOOP.md](docs/AUTONOMOUS_LOOP.md) for operations.
Apply the canonical contract to the actual diff and current GitHub evidence.
Do not recreate policy lists here or treat historical chronology as a current order.

## Review guidelines

A review checkout is usually a merge commit (`refs/pull/<n>/merge`, or one made locally), and its message
carries no trailers. Before reporting a missing or invalid `Correction-Owner` trailer, read the PR's head
commit (`head.sha`): `git log -1 --format=%B <head.sha>`, or `HEAD^2` on a merge checkout. Report it only
when that exact commit lacks the trailer, and name that commit. Never report it from a merge commit or from a
commit outside the PR. How ownership is enforced is in docs/POLICY.md.
