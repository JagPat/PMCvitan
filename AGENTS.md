# AGENTS.md

Guidance for AI agents (Codex, Claude Code) working in the PMC Vitan repository.

## Code Review Rules

Review the diff for correctness, safety, and whether it does what its description
claims. Flag only real, high-priority risks. Prefer precise, load-bearing findings
over style nits.

The rules below encode decisions already made in this project. A PR that violates
one of them is wrong even if the code is otherwise clean, and the review should say
so directly rather than framing it as a suggestion.

- GitHub may check out a synthetic merge commit. For exact-head trailers or commit
  files, inspect the authoritative PR head (`refs/pull/<number>/head`), never the
  synthetic merge SHA; do not report a missing trailer from the merge checkout.

### Database migrations

- Deployed migrations are immutable. Never edit, reorder, or rewrite a migration
  that has already shipped — new changes go in a new, additive migration. Flag any
  diff that touches the bytes of an already-deployed migration.
- If a migration adds a column that an append-only trigger governs, the same
  migration must add that column to the trigger's frozen identity/evidence set.
  Flag a new column that an existing trigger's column list does not cover.
- A CHECK meant to enforce "non-blank" text must reject whitespace-only values.
  `btrim(x)` strips spaces only; require the complete ASCII whitespace set
  `btrim(x, E' \t\n\x0B\f\r')` (or equivalent) wherever the intent is non-blank.
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

### Autonomy and evidence

- This project runs as an autonomous loop. Do not block on human sign-off, and do
  not tell the author to wait for approval — no one is standing by to give it.
- Review still happens BEFORE merge. Every PR starts as a draft with Claude Code
  web Auto-fix enabled. After `review-scope` and the five product CI jobs pass,
  the trusted GitHub orchestrator marks the PR ready to trigger Codex on the
  exact current head.
- A human approval is not a substitute for the required `codex-current-head`
  commit status. Every push creates a new head and therefore invalidates the old
  status. Missing, stale, or timed-out review evidence fails closed.
- Expect reproduce-first evidence: a failing (RED) probe at the base commit before
  the fix was written. Flag fixes shipped without a reproduction.
- Scope discipline is reviewable. A PR that mixes an unrelated refactor into a
  focused change should be asked to split, and the scope creep flagged separately
  from the code review.
- A standard review unit changes at most 20 files and 1,500 changed lines. A larger unit
  must carry the PR template's `justified-large` marker and complete all six
  invariant-matrix rows. Missing large-unit evidence is a blocking scope finding,
  not a reason to spend a full product CI run.
- Before review, complete the PR template's five checks: concurrency and
  serialization; compatibility while the previous release is still serving;
  triggers and alternate writers; authorization and tenancy; and reproduce-first
  CI. Checked boxes are an assertion to verify, never a substitute for evidence.
- Keep migration changes in a separate review unit from service or UI work when
  there is a viable seam. An inseparable unit must use the template marker and
  state the concrete compatibility boundary that makes splitting less safe.
- After two distinct heads receive Codex findings, that PR's review round is
  exhausted. Do not push a third correction head. Close it and open a newly
  scoped replacement from current `main`, limited to the unresolved unit and
  carrying `Replaces: #<closed-pr>` in its body. Historical convergence packets
  or trailers do not reset the count. The replacement receives a fresh full
  review and all safety checks; nothing is dismissed or waived.
- That obligation is discharged by a MERGE, and discharge follows the chain: a
  merged PR naming the exhausted unit discharges it, and so does a merged PR
  naming a replacement that itself died unmerged, since it carries the same
  unresolved scope. A replacement still open discharges nothing. Without the
  transitive step a mid-chain death strands the original forever and blocks every
  `Replaces: none` unit in the repository. A dead link only counts if it was
  itself exhausted AND it outlived the unit it claims — a body naming an
  exhausted unit is editable, but the closure times behind it are GitHub's.

## Out of a review's scope

- **Do not review the controller's round-reset state, and do not review CI
  state.** Both are enforced by the trusted gate before promotion, fail-closed,
  on the exact head. A finding about either adds no safety, because a head you
  are asked to review has already passed them by construction. Review the DIFF:
  the code, the schema, the invariants, and the interleavings.
- Do not assert anything that depends on inspecting a git object, a commit
  message, or a check-run API you cannot actually read. If a claim would require
  running `git show`, `git log`, or `git interpret-trailers` against a SHA, it is
  out of scope — state what the diff shows instead.
- **A commit SHA you did not read from the diff or the review request is not
  evidence.** Across PRs #246–#250, 27 findings quoted `git show` output for a
  40-hex commit that is not an object in this repository — checked with
  `git cat-file -t` against both the default branch and `refs/pull/<n>/head` —
  while the head each was posted against verifiably carried the trailer the
  finding said was missing. Five of PR #248's rounds had such a claim as their
  only finding. Each cost a full product CI battery and a draft round-trip for a
  statement about no state this repository has ever been in.

  If you cannot name where a SHA came from, do not cite it. Describe the defect
  in the diff instead: the file, the line, the inputs, the interleaving. A
  finding needs none of `git show`, `git log`, `git cat-file` or
  `git interpret-trailers` to be correct and actionable, and every finding that
  has needed them here has been wrong.

## Review output expectations

- On the first reviewed head, complete one comprehensive pass across the entire
  diff and all six invariant-matrix categories before submitting the review.
  Report the complete set of current findings together.
- On correction heads, review the correction delta, every prior finding, and the
  adjacent invariants the correction can affect. Do not reopen a cleared area
  merely to restate it, but do report any newly exposed correctness or integrity
  defect. After a second finding-bearing head the current PR is closed; review
  its replacement as a fresh, comprehensive unit.
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

## Review → fix handoff

- Codex reviews only after the orchestrator moves the CI-green draft to ready.
  Codex does not fix its own findings; that keeps the reviewer independent of the
  author.
- Every PR declares its correction owner in the body, as exactly one
  `<!-- correction-owner: claude -->` or `<!-- correction-owner: cursor -->`
  marker. `review-scope` refuses a missing, unknown, or contradictory
  declaration before any expensive job runs, and a `claude/**` branch may only
  declare `claude`. Nothing infers the owner: the branch prefix does not carry
  it, and GitHub cannot see whether a subscription-backed agent session is
  alive.
- A current-head finding makes `codex-current-head` fail and returns the PR to
  draft. The DECLARED owner reads every current-head finding before editing,
  reproduces the complete set, fixes forward as one coherent batch, and pushes a
  new head. Claude Code web Auto-fix must remain subscribed until merge or close
  on the PRs it owns; a notice must never attribute a correction to an agent the
  PR did not declare.
- A notice never claims more than it knows. An owner GitHub cannot start (today,
  anything other than `claude`) is named and the notice says plainly that GitHub
  can neither begin that session nor observe whether it is already running — it
  never asserts that no correction is in flight, and never treats a new head as
  the test of one, because a body edit clears a scope refusal without producing
  one; an undeclared or malformed declaration reports
  `correction_stalled` and names the marker that fixes it. Naming an owner is not
  waking one: an actionable mention needs a new comment, and detecting that an
  asked owner never started needs a lease. Both are the CORRECTION LEASE, driven
  by the hourly handoff job's watchdog: it opens on a failing required status
  (classified by the gate's `review:`/`scope:`/`ci:` prefix, never by its
  wording), publishes at most ONE new comment per pull request, exact head,
  owner and owed failure (the head does not move when a body edit clears a scope
  refusal, so a later failure on the same SHA is its own lease) — carrying `@claude` only where GitHub can actually wake the owner AND
  the owner actually has something to do — and is cleared by a new head or by
  that status ceasing to fail, never by an acknowledgement. A gate-retryable
  review failure — a timeout, moved evidence, CI changing mid-review, a
  requested bootstrap review — opens NO lease: nobody owes a correction, so the
  watchdog DISPATCHES the gate's own recovery workflow with the pull request,
  the exact head and the terminal status id, and the accepted request's
  `recovery:` status stops the next tick. That list has one definition, which
  the gate reads too. A scope notice leads with the verdict that is
  failing, because the size remedy cannot clear a lineage or checklist verdict.
  And the whole assessment is re-derived from a fresh read immediately before
  publishing: the notice goes out only if it comes out identical, so anything
  that changed while the watchdog was reading — the head, the status, which
  failure it is, the declared owner — defers to the next tick instead of
  claiming the lease key with a stale verdict. It comments and nothing else: no status, no draft change, no
  merge, no Codex call. A watchdog that could not assess a pull request fails the
  handoff job rather than reporting green over an unobserved correction.
- On the second finding-bearing head, the PR's declared correction owner makes
  no further correction on that PR. That same owner closes the exhausted PR and
  opens a smaller replacement from current `main`, preserving the unresolved
  findings and reproduce-first proofs and declaring `Replaces: #<closed-pr>`.
  Ownership carries to the replacement path exactly as it does to a fix: a
  Cursor-owned unit is closed and replaced by Cursor, and Claude — subscribed to
  every PR — must not perform it on that owner's behalf. The replacement starts a
  new comprehensive review round; it does not inherit a clean signal or bypass
  any check.
- A fresh current-head clean signal makes `codex-current-head` succeed and queues
  squash auto-merge. No human tags anyone and no human technical approval is
  involved. The runner continues only after the reviewed PR merges and
  `docs/STATUS.md` advances.
