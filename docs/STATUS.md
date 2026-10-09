# STATUS

Machine-readable state for the autonomous runner. The runner reads this file to
decide what to do next and updates it after each merge. It is also the one place
a human can glance at to see where the loop is.

This file is authoritative for task state. It carries the current unit, the queue
and the blockers only (owner decision 2026-10-08, rule 6: 20 KB or less). History
lives in [docs/archive/STATUS-history-2026-10-08.md](archive/STATUS-history-2026-10-08.md)
and in Git; `docs/ROADMAP.md` is an index into the archived narrative.

## Now

```yaml
phase: 6
phase_plan: docs/superpowers/plans/2026-09-07-decision-workflow-4d.md
task: 4
task_state: in_progress
work_item: maint-m2b2-cap-integration
reviewed_merge: 8cd1315
open_pr: 749
next_task: phase-6-task-4d-iii
blocking_directive: none
updated: 2026-10-09
```

### Current unit

**M2b-2, cap and evidence-snapshot integration** (`claude/maint-m2b2-cap-integration`; owner, #482 6075561748;
selected in 6078164776): the approved review-round cap and the reviews → comments → reviews evidence snapshot from
#744, with every deferred-finding filing routed through the M2b-1 component. A head's settlement withdraws any
earlier green first, completes every recorded filing on the PR and its own, and only then may success be
published; a substantive review body is deferred beside its inline findings. #744 and #742 stay stopped.

M2b-1 merged at `8cd1315` (#748); the commercial-approval deadlock correction at `1281962` (#747).

**Delivery-speed maintenance** (owner decisions 2026-10-08 on #482). #731 hit the review-continuity redesign
stop and the owner approved splitting it, each unit from `main`: M1a (#740, merged at `94d1cdb`), this file's shrink (STATUS and ROADMAP
archived); M1b (#739, merged at `f970180`), affected-only PR CI and shadow review off. M2 (#742) hit the same
stop at `d31aaf7` (third reviewed head with a P1 in `autonomous-review-gate.mjs`); the owner approved splitting
it in turn: M2a (merged), then M2b (#744), the review-round cap through one reviews → comments → reviews
evidence snapshot and one failure → draft → deferred-findings publication path. #744 hit the same stop at
`e5842f1`; the owner approved a durability-first split (#482, 6075561748): M2b-1 (merged), then M2b-2 (current
unit), the cap and evidence snapshot. #742 stays open and stopped until M2b replaces it. M3 follows: the trivial fast lane on the ordinary merge path, the size target and one
issue per work item. #731 stays open until they land. Maintenance runs beside the live-bug unit (rule 8).

### Queue (the owner's order of 2026-10-07, recorded on #482)

1. **Live bug 1: notifications open the record they name.**
   - 1a, decision notices: done (#727, `6972ec5`).
   - 1b, inspection notices, in three parts:
     - 1b-1: done (#729, `a08f896`).
     - 1b-2: done (#730, `20b5f0f`).
     - 1b-3: done (#735 `3559f20`, #736 `d028cc4`, #738 `8ab364e`, #741 `647d580`; #734 closed).
   - 1c, drawing notices: done (#746, `79d0d15`, option A).
   - Then the commercial-approval deadlock correction (owner, #482 6062791947): done (#747, `1281962`).
2. **Remaining live bugs**, folded into the Board's Top 10 queue (7 Oct 2026 UI/UX review), one PR per item:
   - demo controls out of production, including hiding Generate Weekly Report;
   - one source of truth for counts;
   - deep links beyond live bug 1;
   - notification dedupe, read/unread and an empty state;
   - Hindi and Gujarati on the translated paths;
   - one OTP flow and a real Invite;
   - rename the role to "Project manager (PMC)";
   - calendar date pickers;
   - a per-role nav trim;
   - notification contrast and minimum text size.
3. **Team-owned client estimates.**
4. **Remove demo controls** (Top 10 item 1, if it was not already done under item 2).
5. **Isolated QA** (owner decision 2026-10-08, proposal on #482): QA-1 a `Project.synthetic` flag, QA-2 its
   exclusion from portfolio totals, counts and notifications, QA-3 an owner-only test-project option; then the
   owner or Hark creates "QA – Test Site" and invites the five qa.* aliases through the app (email + password).
6. **4d-iii R1–R4.** R0a-1 (#715), R0a-2 (#722), R0b (#724) and R0c (#725) are merged. R1 also needs R0c's
   deployment confirmed. `next_task` stays `phase-6-task-4d-iii` until then.
7. **Site Visits**, after R1–R4 (the owner's direction, unchanged by the 2026-10-08 order).

Each unit is a focused PR from `main`, with its own GitHub issue (rule 9). It goes through CI, exact-head
Codex review (capped at two rounds once M2 lands), merge, deployment evidence and live validation. Nothing
here authorises rollout activation, a manual merge or a deployment.

### Blockers

- No `blocking_directive` is scheduled.
- The standing gates under **Blocking directives** below still bind.
- 4d-iii R1 waits on the owner's confirmation that R0c (#725) is deployed.
- Any drain directive clears only on a committed `drained` verdict from `rollout:drain-evidence`
  (docs/POLICY.md), never on a STATUS edit alone.

## State values

- `not_started` — no branch, no PR
- `correction_required` — a reviewed merge has a validated defect; launch the
  named `blocking_directive` before any later task
- `in_progress` — branch exists, PR open as a draft, still being built
- `in_review` — PR open as a draft, waiting on a Codex review or on a fix for
  review findings
- `ready` — PR marked ready for review; the merge is queued behind CI
### A STATUS-only HANDOFF PR records the state AFTER its own merge

A STATUS handoff is not a work item — it IS the handoff, and the
runner reads it only once it has merged. A completed task lands with
`task_state: merged`, `work_item: none`, `open_pr: none`. When only a unit has
merged and its parent still has work, retain `task_state: in_progress`, clear
`work_item` and `open_pr`, keep `blocking_directive: none`, and name the parent
continuation in `next_task`. The resolver then resumes that same parent task.
Neither handoff records ITSELF as
the open PR: `assessRunnerState` consumes any non-`none` `open_pr` before it reaches
`next_task`, so a handoff naming its own number sends the post-merge runner back to a
PR that no longer exists instead of starting the next unit.

This is the one case where the hourly drift shepherd's advice is wrong, and it asked
for exactly that on PR #303. The shepherd compares `main` against live PRs, and while a
handoff PR is open `main` IS stale — unavoidably, because the fix is the thing in
flight. Transient drift for the minutes a handoff is open is the correct trade against
a loop that cannot advance afterwards. `open_pr` names the PR to shepherd for a
WORK-ITEM PR, which is what CLAUDE.md's rule is about.

- `merged` — squash-merged to `main` and deployed. **CLEAR `work_item` in the
  same flip.** `assessRunnerState` consults `work_item` BEFORE `next_task`, so a
  merge record that still names the finished unit sends the runner straight back
  into completed work — silently, because every field is individually valid and
  preferring a named follow-on is the right default. ENFORCED in
  `scripts/autonomous-status-state.test.mjs` against THIS document — an earlier
  revision said "pinned in both directions", which was accurate and was the
  problem: a fixture can only demonstrate the resolution, so the guard has to
  read the artifact.

## Maintenance queue

The standing work source whenever no phase task, no correction directive,
and no open PR is active — the runner is never without a machine-actionable
item. Queue items are already-authorized upkeep of delivered scope (never
new product scope), and each rides the same draft → CI → exact-head Codex
gate as feature work. Work them top-down, one focused PR per item:

1. `lifecycle-rule-unit-2` — the five-head restructure rule currently
   REPORTS a crossing (PR #265) but does not act on one. Unit 2 adds the
   apparatus that must exist before it may block without stalling the loop:
   an attributable declaration channel, a reply window, a durable request
   record, an expiry sweep, and a recovery path. PR #264 attempted this
   together with the wiring and took twelve review rounds without
   converging; its 34 findings are preserved as prior art in
   `docs/reviews/lifecycle-rule-split.md`, including the two unresolved P1s
   that must be designed in from the start. **Not scheduled ahead of Phase 5
   — the owner decides the order.**
2. `dependabot-security-updates` — GitHub reports open vulnerability alerts
   on the default branch (5 as of 2026-07-29: 3 high, 1 moderate, 1 low).
   Raise the affected dependencies with the full gate battery; one PR per
   coherent dependency group.
3. `upgrade-proof-evidence-audit` — PR #284 found that five of its own
   upgrade-proof "hostile insert rejected" assertions referenced a certificate
   the script never creates, so each was rejected by a FOREIGN KEY before
   reaching the CHECK it named: they would have passed with every constraint
   dropped. The owner asked for the same audit across ALL phases. The mechanical
   rule is that every hostile-insert group must ACCEPT a coherent row first, in
   the same fixture state — a rejection is evidence only when an
   otherwise-identical case is accepted. Sweep `apps/api/scripts/upgrade-proof.sh`
   back through Phases 1–4 for assertions whose fixture rows do not exist, or
   whose target is in a state that makes a different rule fire. One PR.
4. `phase-4-t3c-p3005-baseline-dependency-ordering` — SEQUENCED, not merely
   queued: it is the next separate correction AFTER the
   `phase-6-4c-iiir-post-deployment-evidence` lease clears and BEFORE 4c-iv
   begins. On the P3005 baseline path `migrate.sh` resolves `20271015` as
   applied over a `prisma db push` database whose objects the migration never
   installed, so the ledger claims a migration the database did not run. It is
   deliberately NOT folded into the 4c-iii-r unit — that unit is the inbox
   repair and its seals, and widening it to carry an unrelated baseline defect
   is what the review-efficiency rules exist to prevent. One focused PR, full
   gate battery.
5. `e2e-flake-burndown` — the documented flake families the review packets
   record honestly (`daily-log-lost-response` visibility, the
   timing-sensitive `pillar-chain` inspection steps,
   `inspections-module-query`, `project-scope` browser history). Convert
   each to a deterministic wait — reproduce-first, one family per PR.

## Blocking directives

STANDING scope gates, recorded here so every continuation honors them. A
standing gate is deliberately NOT placed in the Now block's
`blocking_directive` field: that field SCHEDULES correction work (the
Now-block rules admit it only from `correction_required` or `in_progress`,
where the resolver returns it as the next step), so an approval gate there
would either hand the runner an unexecutable step ahead of all executable
work — stalling the loop against AGENTS.md's never-wait rule — or fail the
Now-block rules outright from any other state. A standing gate instead binds
regardless of resolver output: the runner continues every already-authorized
duty (the open-PR shepherding, fix-forward corrections, CI and the gate
battery, the active task's own remaining units, the Maintenance queue) and
starts the GATED work only when the gate's recorded clearance arrives.

- `contractor-capture-units-1-6-board-go` — the Board's standing per-unit gate
  on units 1–6 of the contractor-capture staging
  (`docs/ux/CONTRACTOR_CAPTURE_PROPOSAL.md` §4; Board call recorded
  2026-08-28, on #458's thread and re-affirmed after #459 merged). Unit 0 is
  delivered and cleared; each of units 1–6 starts ONLY on its own explicit
  Board GO, exactly as unit 0 did. This is a **scope-authorization** gate,
  not a review gate: no open PR waits on it, and it never substitutes for —
  or adds to — the exact-head review evidence. Unit 1 (the attribution-shape
  migration) is NEW product scope and is not begun under any other authority.
  A review finding that asks for the gate's removal is NOT a clearance and
  does not reopen the recorded decision — that finding class routes to the
  Board, never to a correction push. Cleared by: an explicit per-unit GO from
  JagPat recorded in the session or repository, naming the unit it opens.

- `phase-6-4d-inspection-assignment-drain` — the inspection ASSIGNMENT
  authority of #571 must not be deployed while a previous-release replica is
  still serving. Its evidence fence
  (`20271217000000_inspection_evidence_authority_fence`) is `BEFORE INSERT`
  only, and that is a MEASURED limit, not an oversight: the `Media` wipe's FK
  cascade issues a statement byte-identical to the legacy unlink, so a DELETE
  arm refuses every reset in the repository — the seed, and each of the 15+
  integration teardowns that call `media.deleteMany` directly rather than
  through `sanctionedReset`. ATTACHING evidence to somebody else's binding
  work is therefore fenced at the database; REMOVING it rests on
  `MediaService.remove`'s guard, which a previous-release replica is not
  running. That replica can delete an assigned checklist's evidence and its
  bucket object, and the bytes do not come back.
  #571's round 11, finding 2 is correct that the migration DEFERRED to this
  drain without anything carrying it — `blocking_directive: none` carried
  nothing. It is carried here now, and this is the shape 4c-iii-r's round 13
  settled for the same class: the fence this code cannot build is a stated
  limit held by a directive, and enforcing a drain at DEPLOY time is a change
  to production deploy behaviour that is ROUTED to the Board, not taken by a
  correction push. Landing #571 is not gated; DEPLOYING it is. Cleared by: a
  recorded attestation that no previous-release replica is serving, naming the
  minimum release, exactly as `phase-6-4c-previous-release-drained` is cleared.

- `phase-6-4c-iiir-post-deployment-evidence` — the deploy-time `decisions.inbox`
  repair is DELIVERED IN CODE and independently reviewed, but merging code is
  not running it, and this unit's entire value is what the step does to the
  PRODUCTION register. So 4c-iv stays gated until attributable runtime evidence
  exists for a real deployment, naming ALL of:
  the intended **environment and application**; the deployed **release/commit**;
  an **independently expected NONEMPTY project inventory** (a count established
  outside the run, so a wrong or empty database cannot satisfy it with its own
  numbers); **complete project coverage**; `exit 0`; `ok: true`;
  `corruptAfter: 0`; and `failures: 0`.
  Every one of those is a field the step already emits — the gate is that the
  values must come from the deployment, not from this file or a PR narrative.
  This is a **production-fact** gate, exactly like the drain directive: no code
  push, green CI, generated PR text, or exact-head Codex review can supply it,
  because an exact-head review establishes properties of a diff and this is a
  fact about the world outside the repository. Cleared by: an attributable
  operator record of that run — a direct statement in the controlling
  conversation, or an issue-#482 comment beginning `OPERATOR-ATTESTATION` —
  carrying the fields above. **Cleared 2026-09-05** on `OPERATOR-ATTESTATION` #482 comment
  5547936201 (recorded at the 4c-iv landing above); the entry stays as the record of the gate's
  shape. The successor production-fact gate, `phase-6-4c-iv-rollout-complete`, lived in the Now
  block as a scheduled directive and was cleared on comment 5548460858 at the 4c-v landing.

## Rules for the runner

- Work one task at a time. A correction keeps its parent task open. Do not open a
  PR for task N+1 while task N is not `merged`.
- **Open every PR as a draft with Claude Code web Auto-fix enabled.** The trusted
  GitHub workflow marks an exact CI-green head ready to trigger Codex. A finding
  returns it to draft; only the required exact-SHA `codex-current-head` status may
  queue auto-merge. A human ready/merge action is not review clearance.
- After a clean-reviewed merge: set that task to `merged`, set the next task to
  `in_progress`, update `open_pr` and `updated`. If post-merge review finds a
  defect, return the parent task to `in_progress` and name its blocking directive.
- When every task in a phase is `merged`, move to the next phase's plan and
  start at its task 1 — beginning with the phase's planning item
  (`next_task`) when that plan does not yet exist. Between work items the
  **Maintenance queue** keeps the loop live; it never idles.
- Update this file in the same PR as the work it describes, so state and code
  never disagree on `main`.
- The Now block must always leave the runner a move. That is enforced, not
  merely asked for: `scripts/autonomous-status-state.mjs` decides the next step
  from the Now block and `scripts/autonomous-status-state.test.mjs` runs it
  against this file on every CI run. These states fail the build:
  - nothing to start at all — no directive, no open PR, no task in flight, no
    `work_item`, no `next_task`, and an empty Maintenance queue;
  - a `blocking_directive` recorded from a state that does not schedule one.
    Exactly two do: `correction_required` (which launches it by definition) and
    `in_progress` (the post-merge fix-forward path in the rule above). From any
    other state a directive parks the loop behind work nothing scheduled;
  - `correction_required` with no directive naming the correction;
  - `in_review` or `ready` while `open_pr` is `none` — both states are defined
    above as PR-bearing, so there is no PR for the runner to shepherd.
