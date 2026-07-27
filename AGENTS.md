# AGENTS.md

Guidance for AI agents (Codex, Claude Code) working in the PMC Vitan repository.

## Code Review Rules

Review the diff for correctness, safety, and whether it does what its description
claims. Flag only real, high-priority risks. Prefer precise, load-bearing findings
over style nits.

The rules below encode decisions already made in this project. A PR that violates
one of them is wrong even if the code is otherwise clean, and the review should say
so directly rather than framing it as a suggestion.

### Database migrations

- Deployed migrations are immutable. Never edit, reorder, or rewrite a migration
  that has already shipped — new changes go in a new, additive migration. Flag any
  diff that touches the bytes of an already-deployed migration.
- If a migration adds a column that an append-only trigger governs, the same
  migration must add that column to the trigger's frozen identity/evidence set.
  Flag a new column that an existing trigger's column list does not cover.
- A CHECK meant to enforce "non-blank" text must reject whitespace-only values.
  `btrim(x)` strips spaces only; require `btrim(x, E' \t\r\n')` (or equivalent)
  wherever the intent is non-blank.
- New migrations must be forward-only and safe to re-run. Use `IF NOT EXISTS` /
  `IF EXISTS` guards where the statement supports it, so a partial apply can be
  retried.
- Destructive DDL requires an explicit callout. `DROP COLUMN`, `DROP TABLE`, type
  narrowing, and `NOT NULL` additions without a backfill are blocking findings
  unless the PR description states the migration and backfill plan.

### Append-only / evidence integrity

- A field that justifies a trusted claim (e.g. `manualReason`) must be immutable
  after write, except for a single explicit permitted transition. Flag any path
  that leaves such a field freely rewritable after the fact.
- Destructive external side effects that remove evidence (e.g. `storage.remove`)
  must run only after the transaction that authorizes the delete commits, and only
  on the success path. Flag any destructive side effect that precedes its
  authorizing transaction.
- Do not weaken or remove an existing CHECK constraint. A PR that relaxes one must
  justify it explicitly.
- New user-supplied text columns carry the same non-blank discipline as their
  existing siblings. Inconsistency here is a finding.

### Concurrency / serialization

- A guard that depends on a head/root row's status must take the same row lock
  *before* reading that status. A plain `SELECT` under READ COMMITTED is not
  authoritative. Flag lock-after-read or lock-free status reads on serialized
  entities.
- Concurrency tests must use explicit barriers (not sleep-only synchronization)
  and must assert the terminal invariant directly.
- Flag work that escapes the transaction it appears to be inside — async calls,
  external I/O, or background dispatch that runs outside the boundary.
- When reporting a race, give the concrete interleaving that breaks it.

### Module boundaries

- No module may take a synchronous read of another module's tables. Leaf modules
  stay leaves. Flag any new cross-module synchronous read.
- Flag new imports that create a cycle, or that pull application/orchestration
  concerns into a leaf.
- Shared logic moves *down* into a leaf or *out* into a shared module — never
  sideways between peers.

### Process gates

- Respect any HOLD or "explicit GO" note in the PR description. Never approve past,
  or instruct work beyond, a stated gate (e.g. a blocked task) — even if the code
  looks ready.
- Expect reproduce-first evidence: a failing (RED) probe at the base commit before
  the fix was written. Flag fixes shipped without a reproduction.
- Scope discipline is reviewable. A PR that mixes an approved change with unrelated
  refactoring should be asked to split, and the scope creep flagged separately from
  the code review.

## Review output expectations

- Rank findings by severity. Lead with anything that is a correctness,
  data-integrity, or ordering bug.
- For each finding, give the concrete failure: the inputs or interleaving that
  produce the wrong result. "This could be a race" without the interleaving is not
  a finding.
- Do not pad the review with style nits when there are substantive findings. If
  there are no substantive findings, say so plainly rather than manufacturing
  concerns.
- Cite the rule above that a finding violates, so the standard stays visible.

## Repository conventions

- Match the surrounding code's existing patterns over any general-purpose
  convention.
- Do not add dependencies without justification in the PR description.
- Do not add comments that restate the code.
