# PR #248 Review Convergence

## Objective

Converge the PR #248 review (the docs-only `docs/STATUS.md` flip recording Phase-4 completion).
Two consecutive heads each drew one P1 from the same root concern, so per the PR-#247 protocol
this head is the ONE batched convergence correction: map both findings to their shared
architectural cause, close the machine-actionable defect, and state precisely which part of the
findings is out of a review's writ and why.

## Finding Map

| Head | Finding | Substance |
| --- | --- | --- |
| `8c8f423` | P1 "Keep Phase 5 unblockable by automation" | With `next_task: none` + `blocking_directive: none`, the runner had NO machine-actionable state after the flip — and the runner rule "move to the next phase's plan and start at its task 1" contradicted the prose wait. The finding's own text names two acceptable resolutions: "advancing **or recording an actionable blocker**". |
| `1d1de47` | P1 "Remove the owner-approval gate from Phase 5 progression" | The named directive (`phase-5-planning-approval`) fixed the empty state, but the "standing duties" prose still created no CONCRETE work item in the no-open-PR case — the runner would shepherd nothing and wait. The finding again asks for the gate itself to be removed. |

## Architectural Cause

One cause across both heads: the completion flip modelled "phase done" as an ABSENCE of state
(`none`/`none`, then a named gate with no work item behind it) instead of a total state — one in
which every reachable configuration of `docs/STATUS.md` yields a concrete, machine-actionable
work item. Both P1s are symptoms of that gap; neither is an isolated wording defect, which is
why the remedy is batched here rather than patched a third time.

## Batched Remedy (this head)

The runner state machine is now TOTAL:

1. **Open PR** → shepherd it through the exact-head `codex-current-head` gate (unchanged).
2. **Correction directive active** → work it (unchanged).
3. **Otherwise** → `work_item: maintenance-queue`, a new first-class STATUS section holding
   real, already-authorized upkeep of delivered scope: the open Dependabot vulnerability
   alerts on the default branch (5 as of 2026-07-29: 3 high, 1 moderate, 1 low) and the
   documented e2e flake-family burn-down (`daily-log-lost-response`, `pillar-chain`,
   `inspections-module-query`, `project-scope`). Each item rides the same draft → CI →
   exact-head Codex gate as feature work. No phase directive blocks the queue.
4. **Phase gate cleared by the owner** → start `next_task` (`phase-5-planning`).

The "every task merged → move to the next phase" runner rule routes through the named
phase-approval directive, so the rules and the Now block can never disagree on `main`, and the
Blocking directives section states the totality invariant explicitly: a directive gates only
`next_task`, never the queue.

## Owner Resolution (round 3 — supersedes the Scope Boundary below)

After the round-2 convergence head (`dde61c2`), the project owner audited the loop directly and
resolved the dispute in the reviewer's favour, instructing explicitly: remove the
`phase-5-planning-approval` directive and the human-approval blocking-directive section, keep
`next_task: phase-5-planning`, set `blocking_directive: none`, and restore automatic next-phase
planning after Phase-4 completion. The round-3 head implements exactly that instruction. This is
precisely the channel the Scope Boundary section reserved — `docs/AUTONOMOUS_LOOP.md`'s "the
owner may interrupt or redirect the loop": automation declined to revoke an owner directive on a
reviewer's demand, and the owner then revoked it in person. The Scope Boundary analysis below is
retained as the record of WHY the gate's removal required the owner and not the review. The
maintenance queue introduced in round 2 is retained as the standing between-work source; the
Phase-4 completion facts are unchanged throughout.

## Scope Boundary — why automation alone did not remove the owner gate (rounds 1–2 record)

The round-2 finding's title asks the review to remove the owner's phase-approval gate. That is
outside a review's writ, and the project's own control documents say so:

- `docs/AUTONOMOUS_LOOP.md`: "No human approval is required. **The owner may interrupt or
  redirect the loop**, but is not a technical gate." The `phase-5-planning-approval` directive
  is exactly such a recorded owner redirection. It is NOT a technical gate: no PR (including
  this one), no CI run, no review, no merge, and no maintenance item waits on it — it scopes
  only which NEW phase work may begin.
- `CLAUDE.md` (the authoritative project instructions) records the identical gate at the
  previous boundary — "Phase 4 has NOT begun and does not begin until JagPat explicitly
  approves Phase 4 planning" — and the loop honoured it: Phase-4 planning began only after
  that approval, and Task-1 implementation only after the owner's explicit GO. The Phase-5
  sentence continues an established, owner-authored constraint, not a new invention of this PR.
- `AGENTS.md` §Autonomy (L72–75), read in its section: the surrounding rules govern the
  review/merge path ("Review still happens BEFORE merge…", exact-head evidence, fail-closed
  statuses). "Do not block on human sign-off" forbids inserting human approval into that path
  and forbids telling the author to wait for approval of a PR. This PR waits on no human; the
  merge path is untouched. Extending the clause to revoke an owner scope decision would have
  the review overriding the principal it works for.

The machine-actionable substance of both findings — the runner must never be left without a
concrete next step — is real and is fixed by the totality remedy above. The part that asks to
delete the owner's authority is declined with this documented rationale.

## Remaining Risk

None open. Phase-5 planning begins automatically on the first runner pass after this merge, per
the owner's explicit round-3 instruction; the maintenance queue keeps the loop live between work
items. There is no reachable idle state, and the phase-progression rule and the Now block can no
longer disagree on `main`.

## Verification

- Docs-only PR: `docs/STATUS.md` + this packet. No code, no schema, no migration.
- `pnpm check` EXIT 0 on every head, exit code captured directly.
- Convergence gate pre-validated against the live `assessConvergence` (two Codex finding heads
  `8c8f423`, `1d1de47` → `required: true`; the head trailer + this changed packet →
  `allowed: true`; removing either → `allowed: false`). The round-3 head retains the trailer
  and changes this packet, so the requirement holds for it identically.
