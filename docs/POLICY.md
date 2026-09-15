# PMCvitan policy

This is the canonical written contract for authoring, reviewing and monitoring this
repository. `scripts/review-policy.mjs` is the shared executable definition module;
[REVIEW_RUBRIC.md](REVIEW_RUBRIC.md) is the whole-file self-review every push follows.
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
A `claude/**` branch must declare Claude. The marker selects an agent type,
not a unique session: coordinate one producer on each branch before editing.
Only the declared owner handles normal correction handoff; do not start a competing
producer. Conflict handoffs re-read the owner and current head before publication;
invalid or non-awakenable ownership is reported without waking a different agent.

Codex implementation ownership is currently inadmissible: GitHub implementation
tasks and reviews share the Codex bot identity, and a fresh reaction does not prove
a separate reviewer supplied it. A transfer marker cannot bypass this restriction.
Enabling that role requires reviewer-specific provenance first. User-requested Codex
assistance does not itself change the configured normal correction owner.

This repository currently enables only the Claude correction wake integration.
Codex supports GitHub task mentions such as `@codex fix the CI failures` through its
[GitHub integration](https://learn.chatgpt.com/docs/third-party/github); independent
reviewer provenance, account permissions and acceptance of watchdog-generated
mentions must be verified before enabling that implementation route here.

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
every unresolved finding and reproduce-first proof, and link both PRs.
The declared correction owner continues fixing the current PR, family-wide
(REVIEW_RUBRIC.md): every dimension, every writer branch, whole file, before one push. At the THIRD distinct
reviewed head with a P1 in the same file, ordinary patching stops for an additive
redesign in smaller units; the findings stay open. A disputed finding gets one
reconsideration round on a concrete counterexample under the `disputed-finding` label;
unresolved, it still blocks. Review machinery is frozen: no new controller, watchdog or
lease feature outside a requested maintenance PR.

Keep one concern per PR. A review unit is at most 20 files and 1,500 changed lines;
an oversized unit is split. The only exemption is `<!-- migration-scope: inseparable -->`
on a diff that carries a migration and its inseparable service, with all six invariant
rows carrying concrete risk and evidence; for units after #590
`<!-- review-size: justified-large -->` admits nothing and no human size marker exists.
An added or modified plan is at most 400 lines at the PR head. Limits are aids, not proof.

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
A unit whose cumulative diff (renames and deletions included) touches only documentation
files under `docs/**` or `*.md` anywhere is exempt from Codex: required CI, the author
checklist and no finding on the head merge it, and the status records truthfully that no
review occurred. A runnable file is code wherever it lives; any other path keeps review.

Missing, stale or timed-out review evidence cannot authorize merge. Every push
invalidates prior clearance. The controller accepts only the configured Codex actor
and current review cycle. It checks the newest valid CI evidence, including base
retargets and cancelled attempts, and revalidates before merge. Product coverage can
be reused for metadata edits only when the common CI-evidence rules permit it.

The two invocation attempts and timeout budgets bound a workflow run; they do not
limit correction heads or require a replacement. After required CI and independent
review pass on the exact current head, the system completes the exact-SHA squash
merge automatically, or queues GitHub auto-merge behind branch protection.
No per-commit human or Board authorization, authorization comment, or approver
allow-list is required. This user decision of 2026-09-14 supersedes the proposed
Board-held merge rule. Drafts, changed heads/bases and failed or missing required
gates still prevent completion. The implementer cannot supply independent review
clearance; it must come from the configured review integration.

No routine human technical approval substitutes for CI or independent review.
The retained production-drain exception is different: clearing
`phase-6-4d-previous-release-drained` requires the human `OPERATOR-ATTESTATION`.
Automated release-lease/fleet evidence is fail-closed corroboration, not a substitute.
This consolidation does not reverse that decision or authorize a production action.

## Correction routing and recovery

Naming an owner does not prove a running session. Claude is awakenable through the
configured subscription integration. Cursor is routed but has no enabled correction
wake integration in this repository; report that configuration limit without claiming
no session is running. Codex and other inadmissible owner declarations report
`correction_stalled` with the exact corrective action.

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
  that has already shipped — new changes go in a new, additive migration. CI verifies
  every protected file's bytes against `migration-manifest.sha256.json` at the PR base
  (`scripts/migration-manifest.mjs`); a new migration is recorded with `pnpm migrations:manifest`.
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

Reviewer output rules, the family probes and the dispute path live in
[REVIEW_RUBRIC.md](REVIEW_RUBRIC.md); a finding cites the rule here that it violates.

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
| Hard size cap, plan size, docs-only exemption | review-efficiency.mjs / autonomous-review-gate.mjs | review-efficiency.test.mjs; autonomous-review-workflow.test.mjs |
| Migration immutability | migration-manifest.mjs / CI `review-scope` job | migration-manifest.test.mjs |
| Family probes (eight families) | apps/api/test/invariants/probes.ts | process-invariant-probes.test.ts |
| Weekly metrics | review-metrics.mjs → docs/METRICS.md | review-metrics.test.mjs |

### Claude independent-review shadow boundary

The Claude subscription integration exposes no immutable reviewer completion, actor
and exact SHA, so no comment, mention response, exit code, absence of findings or
timeout is green review evidence. `claude-review-adapter.mjs` is a non-authoritative
fail-closed boundary: activation needs a documented GitHub App Check Run named
`claude-independent-review` from a dedicated App identity with an external id binding
PR and SHA and the v1 structured summary, proven on a real current-head shadow run.
Rollout is additive (install a new required gate before retiring `codex-current-head`;
never an interval with neither); it changes no branch protection, credential,
deployment or drain state. `assessConvergence` and `assessRestructure` are legacy
models, not live closure authority; a synthetic APPROVED Codex review classifies as a
finding until the adapter's contract is validated.

For every new blocking rule, document the concrete defect it prevents, enforcement
location, failing counterexample, legitimate recovery path and operating cost.
Measure merged outcomes, review-to-merge time, repeated findings, unnecessary CI and
escaped defects weekly with `pnpm review:metrics` (definitions in docs/METRICS.md).
Do not use PR counts or completed checklists as delivery measures.
