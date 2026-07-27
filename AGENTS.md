# AGENTS.md

Repo-level guidance for AI agents (Codex, Claude Code) working in this repository.

## Code Review Rules

These are the standards a reviewer must enforce on every pull request. They
encode decisions already made in this project — a PR that violates one of them
is wrong even if the code is otherwise clean, and the review should say so
explicitly rather than framing it as a suggestion.

### Database migrations

- **Deployed migrations are immutable.** A migration file that has already run
  against a deployed environment must never be edited, renamed, reordered, or
  deleted. Corrections ship as a new forward migration. Flag any diff that
  touches an existing migration file.
- **New migrations must be forward-only and idempotent-safe.** Use
  `IF NOT EXISTS` / `IF EXISTS` guards where the statement supports it, so a
  partial apply can be re-run.
- **Destructive DDL requires an explicit callout.** `DROP COLUMN`, `DROP TABLE`,
  type narrowing, and `NOT NULL` additions without a backfill are blocking
  findings unless the PR description states the migration/backfill plan.
- Every migration should be reviewed for whether it needs a corresponding
  rollback path, and the review should say which one applies.

### Append-only tables and integrity constraints

- Tables designated append-only are protected by triggers. Any change that
  would allow `UPDATE` or `DELETE` on an append-only table — dropping the
  trigger, adding a bypassing function, granting rights that route around it —
  is a blocking finding.
- Do not weaken or remove existing `CHECK` constraints. In particular, the
  whitespace/format `CHECK` constraints on text columns exist to keep dirty
  values out at the boundary; a PR that relaxes one must justify it explicitly.
- New user-supplied text columns should carry the same whitespace/format
  discipline as their existing siblings. Inconsistency here is a finding.

### Ordering and serialization

- **Storage ordering:** persist before you publish. Writes that other parts of
  the system observe must be durable before any notification, event, webhook,
  or downstream call that implies the write happened. Flag any code path that
  emits first and writes after, or that does both without a defined ordering.
- **Lock before read.** Where a read-modify-write sequence is the serialization
  point, the lock must be acquired *before* the read, not between the read and
  the write. A `SELECT` followed by a lock followed by an `UPDATE` is a race,
  even if the window looks small. Call it out with the concrete interleaving
  that breaks it.
- Transactions should have an obvious boundary. Flag work that escapes a
  transaction it appears to be inside (async calls, external I/O, background
  dispatch).

### Module boundaries

- **Leaf modules stay leaves.** A module designated a leaf must not import from
  higher layers or from its siblings. New imports that create a cycle, or that
  pull application/orchestration concerns into a leaf, are blocking findings.
- Shared logic moves *down* into a leaf or *out* into a shared module — never
  sideways between peers.
- Flag new cross-layer imports even when they compile fine; the point is the
  dependency direction, not the build.

### Process gates

- **Respect HOLD.** If a PR, issue, or comment thread is marked HOLD, do not
  propose merging, and do not open follow-up PRs that depend on it. Note the
  hold and stop.
- **Explicit GO required.** Work that has been scoped but not explicitly
  approved should not be implemented ahead of the go-ahead. If a PR includes
  changes beyond what was approved, flag the scope creep separately from the
  code review.
- Scope discipline is itself reviewable: a PR that mixes an approved change
  with unrelated refactoring should be asked to split.

## Review output expectations

- Rank findings by severity. Lead with anything that is a correctness,
  data-integrity, or ordering bug.
- For each finding, give the concrete failure: the inputs or interleaving that
  produce the wrong result. "This could be a race" without the interleaving is
  not a finding.
- Do not pad the review with style nits when there are substantive findings.
  If there are no substantive findings, say so plainly rather than manufacturing
  concerns.
- Cite the rule above that a finding violates, so the standard stays visible.

## Repository conventions

- Match the surrounding code's existing patterns over any general-purpose
  convention.
- Do not add dependencies without justification in the PR description.
- Do not add comments that restate the code.
