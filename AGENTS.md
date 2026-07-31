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
- **A plan is not an implementation, and a docs-only review is bounded.** After 3
  finding-bearing heads on a PR whose CUMULATIVE diff contains only documentation
  (by extension and location — anything that runs keeps the ordinary code protocol;
  see `docs/AUTONOMOUS_LOOP.md`), the author must
  stop answering findings with more prose: each still-open question is converted
  into a named probe in the plan, and the head carries
  `Review-Deferred-To-Probes: <task>` naming the task whose review stop settles
  them. Nothing is dismissed — `codex-current-head` still fails closed on every
  current-head finding — and the deferral ledger in the convergence packet records
  each question with the probe that will adjudicate it. The GATE checks only that the
  trailer names a real task — shape plus a phase `docs/STATUS.md` shows still has work
  ahead of it (and it fails closed when that cannot be established: STATUS unparsable, or the
  PR itself editing STATUS so the default-branch copy is not its phase truth), though not the
  task index; the ledger itself is the author's obligation and the
  REVIEWER's to judge — deliberately not machine-checked, because telling a question
  from a probe list needs meaning. Flag a deferral whose ledger is absent, whose
  questions are not the open ones, or whose probes are not actually in the plan.
  See `docs/AUTONOMOUS_LOOP.md`.
  On such a head, a finding whose remedy is "the plan should also specify X" is
  answered by that ledger when X already has a named probe. Report it if the
  DECISION is wrong; a missing level of mechanism detail belongs to the task that
  implements it, where a RED probe can prove the point instead of arguing it.
- After two distinct heads receive Codex findings, ordinary patching stops. The
  next head must be one batched architectural convergence correction with a
  changed `docs/reviews/*convergence*.md` packet and the commit trailer
  `Review-Convergence: complete`. Never evade this by splitting one fix into
  multiple commits or by resetting review history.
- The convergence audit is not a fixed point. A review unit that keeps drawing
  findings is telling you the UNIT is wrong, not that the next patch was too
  small. After **3** finding-bearing heads on a docs-only unit, or **5** on an
  ordinary-code unit, the gate moves the PR to `restructure_required`: no further
  correction head is accepted, and the required `codex-current-head` status is
  never published successful for it. Restructuring dismisses nothing — every open
  finding stays open and moves with the work.
  - The remedy is ONE replacement pull request whose body declares
    `Replaces: #<number>`. The declaration is what makes a fresh review history
    legitimate; the lineage stays visible and the replaced unit's metrics are
    preserved. A replacement is bound by the same limits on its own findings.
  - The finding-head count recorded on the sticky comment is a FLOOR. Rewriting a
    branch, force-pushing, or a rerun that happens to read fewer findings can
    never walk a unit back below a limit it has already crossed.
  - Signals that the unit — not the patch — is the problem: consecutive findings
    in the same file or concept; a correction that introduces the next finding;
    the same invariant restated at a new call site each round.
- To verify that trailer, resolve the PR HEAD first: in a synthetic-merge
  checkout the head is `HEAD^2` (`git show -s --format='%(trailers)' HEAD^2`),
  or fetch `refs/pull/<number>/head`. The merge commit's own auto-generated
  message ("Merge <head> into <base>") never carries trailers, and a SHA that
  is not the PR head — including any snapshot of the regenerating merge ref —
  is not evidence of a missing trailer.

## Out of a review's scope

- **Do not review the convergence trailer, and do not review CI state.** Both
  are enforced by the trusted gate before promotion, fail-closed, on the exact
  head: the trailer by `enforceReviewConvergence`, the required checks by
  `codex-current-head`. A finding about either adds no safety, because a head
  you are asked to review has already passed them by construction. Review the
  DIFF: the code, the schema, the invariants, the interleavings.
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
  defect. The goal is convergence, not fewer findings at the expense of quality.
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
- A current-head finding makes `codex-current-head` fail and returns the PR to
  draft. Claude Code web Auto-fix, which must remain subscribed until merge or
  close, reads every current-head finding before editing, reproduces the complete
  set, fixes forward as one coherent batch, and pushes a new head.
- On the second finding-bearing head, Claude stops isolated remediation and
  performs the required convergence audit. The packet maps every finding to its
  architectural cause, remedy, reproduce-first proof, regression surface, and
  remaining risk before another Codex review is requested.
- A fresh current-head clean signal makes `codex-current-head` succeed and queues
  squash auto-merge. No human tags anyone and no human technical approval is
  involved. The runner continues only after the reviewed PR merges and
  `docs/STATUS.md` advances.
