# Agent entrypoint

Read [docs/POLICY.md](docs/POLICY.md) before authoring, reviewing or monitoring work.
It is the canonical contract for requirements, rationale, exceptions and evidence.
Shared executable definitions live in [scripts/review-policy.mjs](scripts/review-policy.mjs).

Read [docs/STATUS.md](docs/STATUS.md) for current work, then its active plan and
blocking directive. Use [docs/AUTONOMOUS_LOOP.md](docs/AUTONOMOUS_LOOP.md) for operations.
Apply the canonical contract to the actual diff and current GitHub evidence.
Do not recreate policy lists here or treat historical chronology as a current order.

## Review guidelines

Do not report findings about a commit's `Correction-Owner` trailer. The controller reads the PR's exact
head commit itself and holds a head without a valid trailer. A review checkout does not reliably show that
commit's message: past reviews reported missing trailers on commits outside the PR and on heads whose
trailer was valid. Findings about the PR body's `correction-owner` marker remain in scope. How ownership is
enforced is in docs/POLICY.md.
