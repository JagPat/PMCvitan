# PMCvitan policy

This is the canonical written contract for authoring, reviewing and monitoring this
repository. `scripts/review-policy.mjs` is the shared executable definition module.
AGENTS.md and CLAUDE.md are entrypoints; AUTONOMOUS_LOOP.md is the operations guide.
Do not copy policy definitions into those files, workflow prompts or new controllers.

Current explicit user instructions override standing policy. If code still enforces
an older rule, record the discrepancy and fix the policy implementation; do not use
false metadata, erase findings, or claim delivery to get around it. Changes in a PR
are not active in the trusted controller until merged to the default branch.

## Current work and ownership

Read `docs/STATUS.md`, then its active `phase_plan` and `blocking_directive`.
Git and live GitHub evidence determine current state; historical chat and chronology
are context only. Before architecture work also read the modular-platform design
in `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md`
and the relevant ARCHITECTURE, DATA_MODEL, TENANCY and TEMPLATES documents.

One project represents one site. Project operational records never become global.
One fact has one canonical owner. Preserve attributable human approvals. Use additive
migrations and prove tenant isolation against PostgreSQL. Include the vision-alignment
statement, invariant matrix and review packet required by the active plan. A task is
not complete until its focused tests and required `pnpm check` pass.

Every PR declares exactly one correction owner in its leading marker block:
`<!-- correction-owner: claude -->` or `<!-- correction-owner: cursor -->`.
A `claude/**` branch can declare only `claude`. The marker selects an agent type,
not a unique session: coordinate one producer on each branch before editing.
Only the declared owner handles normal correction handoff; do not start a competing
producer. Codex independently reviews and does not implement its own findings.

When opening or resuming a task-bearing autonomous PR, keep STATUS's `open_pr` and
`task_state` coherent. Never start the next task while STATUS keeps this task open.
Repository maintenance PRs do not replace an unrelated product task's STATUS pointer.

## Review continuity and scope

Keep unresolved PRs open and fix forward on the same branch, regardless of how many
heads have received findings. This user decision of 2026-09-08 supersedes the old
two-head close-and-replace rule. New PR numbers are not delivery progress; only
merged changes advance `main`. Historical replacement labels cannot block unrelated
fresh work. Existing explicit replacement declarations retain provenance validation.

A replacement is exceptional: record a concrete scope or approach benefit, preserve
every unresolved finding and reproduce-first proof, and link both PRs. Repeated
findings call for a root-cause audit and stronger proofs, not automatic renumbering.
The declared correction owner continues fixing the current PR.

Keep one concern per PR. A standard review unit is at most 20 files and 1,500 changed
lines. Larger units need `<!-- review-size: justified-large -->` and all six invariant
rows with concrete risk and verification evidence. Numeric limits are review aids,
not proof of quality. Legacy PR-number exemptions remain solely for compatibility.

Complete the template's five pre-review checks: concurrency/serialization, previous-
release compatibility, alternate writers/triggers, authorization/tenancy, and
reproduce-first CI. The six invariant categories are authorization/tenancy, civil-
time/lifecycle, concurrency/idempotency, data integrity/conservation, offline
reconciliation and UI/server parity. Checked boxes and filled cells are assertions
for review, never substitutes for their evidence. Explain genuine non-applicability.

Keep migration changes separate from service/UI work where a viable compatibility
seam exists; justify the rare inseparable unit with the template marker and the
concrete boundary using `<!-- migration-scope: inseparable -->`. Do not add unrelated refactoring to a focused correction.

## Review and merge evidence

Every PR starts draft. Keep the authoring session subscribed for corrections.
The trusted controller admits only open same-repository PRs targeting the configured
base. Required CI precedes review; it marks the CI-green draft ready to invoke Codex
on the exact current head. A current-head finding fails `codex-current-head` and
returns the same PR to draft. Read all findings and reproduce/fix them as one batch.

Missing, stale or timed-out review evidence cannot authorize merge. Every push
invalidates prior clearance. The controller accepts only the configured Codex actor
and current review cycle. It checks the newest valid CI evidence, including base
retargets and cancelled attempts, and revalidates before merge. Product coverage can
be reused for metadata edits only when the common CI-evidence rules permit it.

The two invocation attempts and timeout budgets bound a workflow run; they do not
limit correction heads or require a replacement. A current-head clean result allows
the existing exact-SHA squash-merge path within the user's authorization. Explicit
merge/deploy holds must be respected. The current merge helper does not parse a
prose hold: that enforcement gap remains a separately identified follow-up, not a
claim that this consolidation implements a durable hold mechanism.

No routine human technical approval substitutes for CI or independent review.
The retained production-drain exception is different: clearing
`phase-6-4d-previous-release-drained` requires the human `OPERATOR-ATTESTATION`.
Automated release-lease/fleet evidence is fail-closed corroboration, not a substitute.
This consolidation does not reverse that decision or authorize a production action.

## Correction routing and recovery

Naming an owner does not prove a running session. Claude is awakenable through the
configured subscription integration. Cursor is routed but not awakenable by GitHub;
report that limitation without claiming no session is running. Invalid ownership
reports `correction_stalled` with the exact corrective action.

The correction watchdog identifies an owed failure from the gate's review/scope/CI
classification, rechecks live owner/head/status before publishing, and sends at most
one notice per PR, exact head, owner and owed failure. A changed head or cleared
failure ends that lease; acknowledgement alone is not evidence of a fix. The lease
reports correction_recovery or correction_stalled according to wake capability.

Gate-retryable failures invoke the gate's recovery workflow instead of asking an
author to change code. Recovery binds the current SHA and terminal status ID and
cannot bypass current-head findings. Retired round-limit failures also request a
fresh gate evaluation. The watchdog reports failures it could not assess; it does
not silently report successful observation.

## Trust and credentials

Write-capable workflows execute trusted default-branch automation, never untrusted
PR code. Required checks and independent review cannot be bypassed through a human
approval or a PR edit. Keep credentials, raw transcripts, local attachments and
.env contents out of Git. Do not add ANTHROPIC_API_KEY, OPENAI_API_KEY, Cursor
credentials or an AI action: current integrations use product subscriptions.

## Engineering requirements

The following requirements are preserved from AGENTS.md. They are enforced by
relevant application/database tests and independent review; shared PR metadata
checks do not prove every domain invariant.

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

## Review evidence and scope

Inspect the authoritative PR head (`refs/pull/<number>/head`) for commit files and
trailers; a synthetic merge commit is not evidence of a missing PR-head trailer.
Review the code and invariants affected by the diff, including controller and CI
logic when those files change. Do not repeat unrelated CI-state findings already
answered by verified checks. Never assert Git-object contents, commit metadata or
API results you could not read; cite the actual file, inputs and interleaving.
A SHA is evidence only when its origin and relevant contents have been verified.

## Review output expectations

- On the first reviewed head, complete one comprehensive pass across the entire
  diff and all six invariant-matrix categories before submitting the review.
  Report the complete set of current findings together.
- On correction heads, review the correction delta, every prior finding, and the
  adjacent invariants the correction can affect. Do not reopen a cleared area
  merely to restate it, but do report any newly exposed correctness or integrity
  defect. Continue correcting on this PR until the findings are resolved;
  review count alone does not require a fresh PR.
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

## Enforcement and validation map

| Requirement | Shared definition / consumer | Validation |
| --- | --- | --- |
| Scope, checklist, migration seam and legacy lineage | review-policy.mjs / review-efficiency.mjs | review-efficiency.test.mjs; policy-contract tests |
| Owner declaration and wake capability | review-policy.mjs / correction-owner.mjs | autonomous-correction-owner.test.mjs; policy-contract tests |
| Required checks and retry budgets | review-policy.mjs / gate and check-run-coverage.mjs | autonomous-review-workflow.test.mjs; CI coverage tests |
| Fix forward and history advisory | review-policy.mjs / autonomous-review-gate.mjs | autonomous-fix-forward.test.mjs; workflow tests |
| Review actor and current-head interpretation | review-policy.mjs / autonomous-review-state.mjs | autonomous-review-state.test.mjs |
| Correction lease and gate recovery | review-policy.mjs / correction-lease.mjs, autonomous-handoff.mjs | autonomous-correction-lease.test.mjs |
| Current task and post-merge coherence | docs/STATUS.md / autonomous-status-state.mjs | autonomous-status-state.test.mjs; continuation tests |
| Engineering invariants | Owning product module, SQL constraints and review | Relevant unit, PostgreSQL, migration and browser proofs |

`assessConvergence` and `assessRestructure` are legacy test/metrics models, not live
closure authority. A test for a legacy model does not make it active policy. A
synthetic APPROVED Codex review currently classifies as a finding; validate the
adapter's actual contract before changing that behavior. Neither that classifier
nor the durable hold gap is silently changed by this refactor.

For every new blocking rule, document the concrete defect it prevents, enforcement
location, failing counterexample, legitimate recovery path and operating cost.
Measure merged outcomes, review-to-merge time, repeated findings, unnecessary CI and
escaped defects. Do not use PR counts or completed checklists as delivery measures.
