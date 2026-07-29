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
| `52d3f71` | (owner instruction, not a Codex finding) | The project owner resolved the dispute directly: remove the directive, keep `next_task: phase-5-planning`, restore automatic progression. |
| `a74143d` | P1 "Make the convergence remedy match STATUS" | The packet's remedy section still described round 2's design after round 3 had changed STATUS. Real defect — packet/state drift. |

### Evidence and regression surface

An earlier revision of this section claimed a docs-only change admits no RED-then-GREEN probe.
That was wrong, and the review was right to press on it. `docs/STATUS.md` is not prose — it is
the state the runner *executes*, so "the runner has no move from this state" is a decidable
property of the file. `scripts/autonomous-status-state.mjs` decides it, and
`scripts/autonomous-status-state.test.mjs` pins it. Both findings reproduce RED at their own
heads:

```
RED    8c8f423 (finding 1 head)
       task_state is merged with no work_item, no open_pr and no next_task;
       the runner has nothing it can start
RED    1d1de47 (finding 2 head)
       blocking_directive 'phase-5-planning-approval' is set while task_state is 'merged';
       STATUS launches a directive only from correction_required, so this state blocks
       progression without scheduling any work
GREEN  52f04d8 (this head)
       nextStep: next_task:phase-5-planning
```

| Finding | RED at | Probe | Regression surface |
| --- | --- | --- | --- |
| `8c8f423` empty state | `8c8f423` | `assessRunnerState` returns `actionable: false` for the merged terminal state with `work_item`, `next_task` and `blocking_directive` all `none` | The live-file test runs on every CI run: any future STATUS edit that leaves the runner stalled fails `pnpm test:automation` |
| `1d1de47` owner-approval gate | `1d1de47` | `assessRunnerState` rejects a `blocking_directive` recorded against any `task_state` other than `correction_required` | STATUS's own state-value definitions say a directive is what `correction_required` launches; the invariant now enforces that, so parking the loop behind a directive the state machine never scheduled — the shape a human-approval gate takes — is red in CI |
| `91fc1fb` directive from `in_progress` | `91fc1fb` | `assessRunnerState` schedules the directive named by an `in_progress` task — STATUS's documented post-merge fix-forward state | The next validated defect can record its correction target without failing CI |
| `91fc1fb` between-work stall | `91fc1fb` | the all-none state resolves to `maintenance:<first item>`; the live-file test also requires the queue to parse non-empty | Both finding heads have no queue section, so their RED verdicts are unaffected — asserted against the real commits |
| `a74143d` packet ≠ STATUS | `a74143d` | No executable probe — and the attempt to build one was withdrawn, see below. The check is the reviewer's own comparison of this packet against `docs/STATUS.md`, repeatable by inspection | Both files live in this one PR's diff |

The invariant is deliberately total: `assessRunnerState` returns a decision and a reason for
every input, including malformed and unrecognized ones, and every non-actionable branch is
covered by a test. No product code, schema, migration, projection, event or lock is touched.

### The packet-drift check was built, then withdrawn — it was wrong in kind

Round 7 pressed that the `a74143d` finding needed an executable probe, and round 8 built one: the
packet echoed the Now block and a test compared it field-for-field against the live
`docs/STATUS.md`. Round 10 showed that check was a trap. A convergence packet is a FROZEN
historical record of one PR; `docs/STATUS.md` moves on every merge, because advancing it IS the
loop. So the first future PR that advanced STATUS would have found this packet still echoing the
Phase-4-complete block and failed `pnpm test:automation` — blocking the very progression the
runner exists to perform. The check would have had to be rewritten by every future STATUS change,
forever.

The check is removed and this row is honest again: packet-versus-state drift is caught by reading
the two files, which is what the reviewer did. That is a real check; it is simply not an automated
one, and dressing it up as automation cost a round and nearly cost the loop. A mechanism that must
be edited by every unrelated future change is not a regression surface — it is a liability.

The first version of that test read the two historical Now blocks with `git show`, and CI caught
it: `actions/checkout` uses `fetch-depth: 1`, so those objects do not exist on the runner and the
suite failed there while passing locally. The finding-head states are now committed literals, so
the invariant is enforced in CI — the place it actually matters — and a separate test compares
them against the real commits whenever the clone has history, so they cannot drift unnoticed on
any machine that can check. Verified by running the suite in a genuine `--depth 1` clone.

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

## Round 7 (head `91fc1fb`) — two real findings against the new invariant

Making the runner state executable exposed two places where my rule was stricter than the state
machine STATUS actually documents. Both were raised against the real head and both are fixed here.

**A directive is legitimate from `in_progress`, not only `correction_required`.** STATUS's runner
rules say a post-merge defect "return[s] the parent task to `in_progress` and name[s] its blocking
directive" — the documented fix-forward path. My guard rejected exactly that state, so the next
validated defect would have had to choose between dropping its correction target and failing CI.
`assessRunnerState` now schedules the directive from either state, and rejects it only from states
that never schedule one — which is still where an approval gate would appear.

**An all-none state is the maintenance queue's turn, not a stall.** STATUS says the queue "keeps
the loop live; it never idles", so the between-work configuration resolves to the first queue item.
`parseMaintenanceQueue` reads the section, and the live-file test additionally asserts the queue
parses to at least one item — emptying it would otherwise silently remove the loop's fallback.

Neither correction weakens the original reproductions, and that is asserted rather than argued:
`8c8f423` and `1d1de47` carry **no Maintenance queue section at all** (it arrived later, in round
2), so both stay RED, and the test that reads the real commits now checks the parsed queue is empty
at each head before asserting the verdict:

```
RED    8c8f423  queue=[]  merged, nothing to start
RED    1d1de47  queue=[]  directive from a state that schedules none
GREEN  91fc1fb  queue=[dependabot-security-updates, e2e-flake-burndown]  next_task:phase-5-planning
```

The round's third finding claimed head `41abd1bd5b67d2e9199106aa8f44911f05d1b907` lacks the
convergence trailer. That object does not exist in this repository (`git cat-file -t` fails), and
the actual reviewed head `91fc1fb` does carry a git-parsed `Review-Convergence: complete`. It is
the tenth such citation; it is recorded below, not acted on.

## Invalid Reviewer Evidence (rounds 4–7)

The round-4 P1 "Add the missing convergence trailer" cited head
`bbe402a48e43d605721c80d19aa27d49824bb6ea` — a SHA that is not an object in this repository and
not the PR head. This entry originally attributed it to the SYNTHETIC merge ref; that was an
over-reading of my own evidence and is corrected here. The merge ref at verification time was
`6ed3833` (subject "Merge 52d3f71… into 67e7a00…", parents `67e7a00`/`52d3f71`) — which is not
`bbe402a` either. The honest statement is narrower: the cited SHA is not the head, not the merge
ref, and not any object in this repository. The authoritative head `52d3f71` verifiably carries
the required trailer:
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

### Round 7 addition

`41abd1bd5b67d2e9199106aa8f44911f05d1b907` — cited as the head lacking a convergence trailer.
`git cat-file -t` reports no such object; it is not the PR head (`91fc1fb`), not any earlier head,
and not `refs/pull/248/merge`. The real head's trailer parses:
`git show -s --format='%(trailers)' 91fc1fb` prints `Review-Convergence: complete`.

Notably, this round's review header and its `AGENTS.md` permalinks BOTH cite `91fc1fb` correctly —
only the finding body carries the corrupted SHA. The other two findings in the same review were
real and are fixed. So the corruption is confined to SHAs quoted inside finding text, not to which
commit is reviewed, which is why round 7 produced actionable work where rounds 4–6 did not.

### Round 9 (head `cd1be7d`): no substantive finding remains

The round-9 review returned exactly one finding: that head `0efb7696854fd27a91b03f6f7226c22dc983563a`
lacks the convergence trailer. That object does not exist in this repository, and the reviewed head
`cd1be7d` carries a git-parsed `Review-Convergence: complete`
(`git show -s --format='%(trailers:key=Review-Convergence,valueonly)' cd1be7d` prints `complete`).

Every code and documentation finding raised against this PR is resolved: the runner-state invariant
(rounds 1–2), the owner's rework (round 3), the executable RED proof (round 7), the directive-state
and PR-bearing-state corrections plus the mechanical packet↔STATUS check (round 8). Round 9 found
nothing else. The convergence audit is therefore complete on the substance, and the sole remaining
obstacle is a citation that does not correspond to any commit — see below.

### Round 10 (head `c78a112`): the packet-drift trap, and a missing task id

Two real findings. The P1 above — my own mechanization would have blocked every future STATUS
advance — is withdrawn rather than patched. The P2: an open task (`not_started`/`in_progress`)
with no `task` recorded returned `actionable: true` / `task:undefined`, certifying a state the
runner cannot start, which is exactly what this module exists to prevent. It now fails closed.

The round's third finding cited head `bd0c1ef2439238e2f32ebb440bd64379bda5b28a`, which is not an
object in this repository; the reviewed head `c78a112` carries a git-parsed trailer.

## Remaining Risk

None open in the change itself. Phase-5 planning begins automatically on the first runner pass
after this merge, per the owner's explicit round-3 instruction; the maintenance queue keeps the
loop live between work items. There is no reachable idle state, and the phase-progression rule,
this packet's remedy table, and the Now block now state the same thing.

The one open RISK is procedural, not in the diff: the required `codex-current-head` status
cannot go green while the reviewer keeps filing the phantom-SHA trailer finding on every head,
and a finding-bearing status is deliberately non-retryable — correctly so. **This packet
prescribes no way around that check.** An earlier revision of this section suggested removing
the required check to merge; that was wrong to record here, because turning failed review
evidence into a manual bypass is exactly what the fail-closed rule exists to prevent
(`AGENTS.md` §Autonomy: "Missing, stale, or timed-out review evidence fails closed"), and a
review packet is the last place such a workaround should be normalized. It is withdrawn.

The correct fix is at the integration: the reviewer must inspect `refs/pull/248/head` rather
than commits materialized in its own environment, at which point it will read the trailer that
is demonstrably present and the check can pass on its own evidence. Until that is fixed, the
honest state of this PR is: change complete and verified, review evidence unobtainable through
no fault of the diff. Any decision to override a required check is the repository owner's
alone, is made outside this packet, and is not recommended by it.

## Verification

- Changed surface: `docs/STATUS.md`, this packet, `AGENTS.md`, and **two scripts** —
  `scripts/autonomous-status-state.mjs` (the `assessRunnerState` invariant added in round 1, which
  makes "STATUS records a state the runner cannot act from" an executable check rather than a
  documentation convention) and `scripts/autonomous-status-state.test.mjs`, which asserts the LIVE
  `docs/STATUS.md` always names a next move. The test runs in `pnpm test:automation`
  (`scripts/autonomous-*.test.mjs`), 12/12.
- No product code, no schema, no migration.

  An earlier revision of this section said "Docs-only PR … No code". That was **false** from
  round 1 onward, and Codex was right to flag it: the scripts above are part of the diff and any
  auditor trusting this packet would have treated a new executable CI invariant as out of scope.
  Corrected here and left visible rather than silently rewritten.
- `pnpm check` EXIT 0 on every head, exit code captured directly.
- Convergence gate pre-validated against the live `assessConvergence` (two Codex finding heads
  `8c8f423`, `1d1de47` → `required: true`; the head trailer + this changed packet →
  `allowed: true`; removing either → `allowed: false`). The round-3 head retains the trailer
  and changes this packet, so the requirement holds for it identically.

## Base merge (head after `main` advanced)

This head is a merge of `origin/main` requested by the conflict bot after PR #251 merged. It
carries **no correction content**: the only incoming change is
`apps/web/tests/labour.test.ts` (the labour onboarding probe's load-dependent wait), and the
merge is conflict-free.

It is recorded here because the convergence gate cannot distinguish a base merge from a
correction head — with 12 finding heads behind this PR, every subsequent head is required to
carry the trailer and a changed packet, including one that fixes nothing. The trailer on this
commit therefore asserts only what remains true: the batched architectural audit for this PR is
complete and is the document you are reading. It does not claim this head is that audit.

The gate should exempt a head whose diff against its first parent is empty — a pure base merge
introduces no reviewable change of its own. That is a defect in the gate, not in this PR, and is
raised separately rather than worked around silently.

Validation on the merged tree: `pnpm check` EXIT 0 (web 543/543, API 680/680);
`pnpm test:automation` green.

## The trailer finding on this head is unfounded — and why that matters

The second finding on `b541768` asserts the trailer is missing, quoting
`git show -s --format='%(trailers:key=Review-Convergence,valueonly)' 4f5ec0ff…`. Checked directly:

```
git cat-file -t 4f5ec0ff07334e23dccd17ebf6b049d898298556
  → fatal: git cat-file: could not get object info      (also absent from refs/pull/248/head)

git log -1 --format='%(trailers:key=Review-Convergence,valueonly)' b541768
  → complete
```

The cited commit is not an object in this repository, and the head it was posted against does
carry the trailer. The finding describes no state this repository has ever been in.

**What makes this round worth recording** is that the OTHER finding — the false "docs-only"
claim, which is correct and which this head fixes — cites the same absent `4f5ec0f` as its
evidence. PR #250's dismissal rule discounts a finding when every full SHA it cites is confirmed
absent. Applied here it would have discounted a **true** finding about a **false** claim in this
very packet.

That is the "Remaining Risk" section of `pr-250-convergence.md` materialising on a real pull
request, at the first opportunity. It is recorded here as evidence for the decision on whether
that rule should ship at all — the AGENTS.md scope exclusion prevents the phantom claim from
being written, and carries no such risk.

### Base merge after PR #250

`origin/main` merged again after PR #250 landed (`e416d7d`), at the conflict bot's request.
Conflict-free; the incoming change is the `AGENTS.md` review-scope instruction and its packet.
No correction content. As before, the trailer on this commit asserts only that this PR's
batched architectural audit is complete and is this document — not that a base merge is that
audit.
