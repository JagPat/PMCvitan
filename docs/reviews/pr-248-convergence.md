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

## Batched Remedy (as it stands on this head)

The runner state machine is TOTAL — every reachable configuration of `docs/STATUS.md` yields a
concrete next action. Round 2 introduced the maintenance queue; the owner's round-3 instruction
then removed the approval gate and restored automatic phase progression, which is what the Now
block on this head actually encodes (`work_item: none`, `next_task: phase-5-planning`,
`blocking_directive: none`):

1. **Open PR** → shepherd it through the exact-head `codex-current-head` gate.
2. **Correction directive active** (`blocking_directive` names one) → work it.
3. **`next_task` set** → start it on the first runner pass after merge, automatically and with
   no human gate. On this head that is `phase-5-planning`, per the restored runner rule "when
   every task in a phase is `merged`, move to the next phase's plan and start at its task 1".
4. **Nothing in flight** (no open PR, no directive, no `next_task`) → the **Maintenance queue**
   section: already-authorized upkeep of delivered scope — the open Dependabot vulnerability
   alerts on the default branch (5 as of 2026-07-29: 3 high, 1 moderate, 1 low) and the
   documented e2e flake-family burn-down (`daily-log-lost-response`, `pillar-chain`,
   `inspections-module-query`, `project-scope`). Each item rides the same draft → CI →
   exact-head Codex gate as feature work.

`work_item: none` records that no work item is currently IN FLIGHT — not that the runner has
nothing to do; rows 3 and 4 supply the next action in that state. The phase-progression rule
and the Now block therefore cannot disagree on `main`.

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

## Invalid Reviewer Evidence (rounds 4–6)

The round-4 P1 "Add the missing convergence trailer" cited head
`bbe402a48e43d605721c80d19aa27d49824bb6ea` — a SHA that is not an object in this repository and
not the PR head. It is a snapshot of the SYNTHETIC merge ref: at verification time
`refs/pull/248/merge` resolved to `6ed3833` with subject "Merge 52d3f71… into 67e7a00…" and
parents (`67e7a00`, `52d3f71`) — an auto-generated merge commit whose message carries no trailer
block by construction. The authoritative head `52d3f71` verifiably carries the required trailer:
`git show -s --format='%(trailers)' 52d3f71` prints `Review-Convergence: complete` in the final
trailer block, and `assessConvergence` against that head's real message with this changed packet
returns `allowed: true`. This repeats the PR #246 round-15 pattern the `AGENTS.md` PR-head
resolution rule addresses (inspect `refs/pull/248/head`, never the synthetic merge SHA). No
resolution content changes for this finding; this head re-presents the same owner-instructed
state with this record added.

Round 5 repeated the identical finding against head `09c98ec`, this time citing
`eacd6cceb698ff7f0b45ef23e43e47bff112f1fc` and asserting it is "the authoritative head …, not a
synthetic merge". It is neither: `eacd6cce` is not an object in this repository, and after the
`09c98ec` push the regenerating merge ref resolved to `7a7055b` — parents (`67e7a00`,
`09c98ec`), subject "Merge 09c98ec… into 67e7a00…". The authoritative head `09c98ec` carries the
trailer (`git show -s --format='%(trailers)' 09c98ec` prints `Review-Convergence: complete`),
and the TRUSTED convergence gate has admitted and promoted every trailered head of this PR
(`dde61c2`, `52d3f71`, `09c98ec`) — the enforcement the finding predicts would "fail closed"
has in fact passed on each of them. To end this loop at the instruction layer, this head also
co-locates the head-resolution recipe inside `AGENTS.md`'s convergence rule itself: verify the
trailer on `HEAD^2` of a merge checkout (or `refs/pull/<n>/head`); the merge commit's
auto-generated message never carries trailers; a SHA that is not the PR head is not evidence.

Round 6 repeated it a third time against head `a74143d`, citing
`e2f7ba0a292be00804cf847b107a43a6ff6472f9` as "the requested single-parent head" — again not an
object in this repository (`git cat-file -t e2f7ba0a…` → "could not get object info"). The
AGENTS.md co-location added in round 5 did not change the outcome, and each round cites a
DIFFERENT nonexistent SHA (`bbe402a`, `eacd6cce`, `9efdb273`, `e2f7ba0`), so the reviewer is
inspecting commits materialized inside its own environment rather than
`refs/pull/248/head`. That is an integration-level defect on the reviewing side; no further
in-repository instruction change can correct it, and none is attempted. The head trailer is
verifiable at any time with
`git show -s --format='%(trailers:key=Review-Convergence,valueonly)' <head>`.

## Remaining Risk

None open in the change itself. Phase-5 planning begins automatically on the first runner pass
after this merge, per the owner's explicit round-3 instruction; the maintenance queue keeps the
loop live between work items. There is no reachable idle state, and the phase-progression rule,
this packet's remedy table, and the Now block now state the same thing.

The one open RISK is procedural, not in the diff: the required `codex-current-head` status
cannot go green while the reviewer keeps filing the phantom-SHA trailer finding, and a
finding-bearing status is deliberately non-retryable. Clearing it needs an owner action outside
the repository — temporarily removing that required check to merge, then restoring it (together
with `review-scope`, whose rollout is also pending) per `docs/AUTONOMOUS_LOOP.md`
§GitHub Enforcement.

## Verification

- Docs-only PR: `docs/STATUS.md` + this packet. No code, no schema, no migration.
- `pnpm check` EXIT 0 on every head, exit code captured directly.
- Convergence gate pre-validated against the live `assessConvergence` (two Codex finding heads
  `8c8f423`, `1d1de47` → `required: true`; the head trailer + this changed packet →
  `allowed: true`; removing either → `allowed: false`). The round-3 head retains the trailer
  and changes this packet, so the requirement holds for it identically.
