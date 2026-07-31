# Review lifecycle: `restructure_required`

## Why this exists

The convergence protocol stops ordinary patching after two finding-bearing heads
and demands one batched architectural audit. That is the right move once. It is
not a fixed point, and PR #257 proved it:

| Head | Findings | What the correction did |
| --- | --- | --- |
| `c7913a9` | 4 | patched the coverage watermarks |
| `596fa99` | 4 | patched them again, plus the plan-stat path |
| `e9feaf7` | 2 | scoped battery inference to the current attempt |
| `bd58504` | 2 | keyed the classification cache by base; positive-evidence inference |
| `d5e8f61` | 2 | *(both findings were caused by the previous correction)* |

Five heads, and the last three corrections each introduced the next finding. The
cause was not that the patches were too small. One concept — *evidence must
belong to the current merge result and the current attempt* — lives in six places
(the classification cache, the wait loop, final verification, `gateWatermarks`,
`inferRequiredChecksFromRuns`, `summarizeRequiredChecks`), and each round
corrected two of them. Repeating "batch and audit" cannot converge that, because
the audit keeps being scoped to the sites the last review happened to name.

PR #256 showed the same shape independently: F6 → F8 → F9 → F10, four rounds, each
correction touching one site of a multi-site concept.

The remedy for a unit like that is to re-cut it, not to patch it again.

## What this adds

`scripts/review-lifecycle.mjs` answers one question — has this review unit spent
enough rounds to prove that another correction head is the wrong instrument? Its
only outcomes are "keep reviewing" and "stop; restructure". It never dismisses a
finding and never clears a head.

| State | Enters when | Effect |
| --- | --- | --- |
| `reviewing` | default | ordinary correction heads |
| `convergence_audit` | 2 finding heads | the existing batched-audit obligation, unchanged |
| `restructure_required` | 3 finding heads (docs) / 5 (code) | no further correction head; never publishes success; findings stay open |
| `replacement_reviewing` | body declares `Replaces: #<n>` | fresh history, declared lineage, same limits on its own findings |

The two thresholds differ because the costs differ. A docs-only unit is cheap to
re-cut, and prose that has drawn findings three times is arguing rather than
converging. Ordinary code carries real structural cost, so it gets the longer
leash — but not an unlimited one.

## Design decisions worth stating

**The count is a floor, not a reading.** Findings live on the pull request, so
rewriting the branch does not erase them — but a paginated read, a deleted
comment, or a transient API result can all make the live count look smaller than
it has been. `mergeFindingHeadCount` takes the max of the recorded floor and the
live reading, so neither an accident nor a deliberate history rewrite walks a unit
back below a limit it has crossed. A genuinely fresh unit gets a fresh count by
being a DECLARED replacement — a different pull request, with its own comment and
its own floor.

**An unreadable diff never picks a threshold.** This repository has repeatedly
been bitten by a degraded path silently resolving toward one answer. Two of the
three cases here are decidable without the file list: below the docs limit neither
threshold is crossed, and at or above the code limit both are. Only the band
between them genuinely depends on it, and there the check reports `undecided` and
BLOCKS so the next event re-reads. That is a stop, never a clearance — an
undecided unit cannot merge either.

**Elapsed time is telemetry.** It is recorded beside the count so the cost of a
long review is visible in the same place, and nothing reads it to decide whether a
head may merge. `L11` pins that: thirty days in review, still `allowed: true`,
because only the head count gates. A time-based gate would be a deadline, and a
deadline is exactly the pressure that produces a rushed correction head.

**Restructuring is not dismissal.** `restructure_required` has no branch that
publishes success and no path that resolves a review thread. The instruction it
writes says every open finding stays open and moves with the work.

## Reproduce-first evidence

Every probe fails without `scripts/review-lifecycle.mjs`: the module is new, so
the reproduction of each case is that the repository could not answer the question
at all before it. That is stated plainly rather than dressed up as a behavioural
RED — the same honesty the PR #256 packet applied to its absent-surface findings.

The five cases the directive named, each pinned:

| Case | Probes |
| --- | --- |
| docs threshold | `L1` (2 heads reviews), `L2` (3 heads restructures) |
| code threshold | `L3` (4 heads reviews), `L4` (5 heads restructures), `L4b` (#257's real head SHAs) |
| state persistence across reruns | `L6` (floor survives a smaller live read), `L6c` (max, and malformed records) |
| superseding heads | `L7` (a clean current head does not clear a crossed unit), `L6b` (branch reset) |
| a finding-bearing restructured PR cannot merge | `L9` (never `allowed` at any count past the limit) |

Plus the undecided band (`L5`, `L5b`, `L5c`), replacement lineage (`L8`, `L8b`,
`L8c`), and metrics round-tripping and telemetry (`L10`, `L10b`, `L11`, `L11b`).

`node --test scripts/review-lifecycle.test.mjs` → 20/20.

## Scope

Deliberately narrow, per the directive: this PR does **not** reorder CI relative
to Codex, and does not touch the battery-selection code that #257 is still
correcting. It adds one module, its suite, two call sites in the gate, a metrics
line on the sticky comment, and the two documents.

`docs/STATUS.md` is corrected in the same commit — it recorded `open_pr: none`
while #252 and #257 were open, which the merged runner-continuation shepherd
detected on live state. Riding it along avoids opening a third PR for two lines.

## Validation

| Gate | Result |
| --- | --- |
| `node --test scripts/review-lifecycle.test.mjs` | 32/32 (current head; 20/20 at round 1) |
| `pnpm test:automation` | 176/176 (the new suite joins the glob) |
| `pnpm check` | EXIT 0 |
| Migrations | none |

## What this does not claim

It does not claim to detect an UNDECLARED replacement — a PR opened with the same
work and no `Replaces:` line starts at zero, and nothing here can prove intent.
What it does is make the declared path the easy one and keep the lineage visible
when it is taken. Detecting laundering by content similarity was considered and
rejected: it would guess, and a gate that guesses is the defect this module exists
to stop.

---

## Round 2 — four findings on `a65398d`

All four are P2, all four are correct, and all four are the same concept at four
places: **the restructure assessment must be the FIRST gate, re-evaluated wherever
the finding count can change, durably recorded, and retryable when undecided.**
None of them contradicts the lifecycle model; every one is about the new gate
being reachable and durable at the right moments.

They are corrected together, with a site audit first, because fixing four facets
of one concept one at a time is precisely the cascade this PR exists to stop. It
would have been an embarrassing way to prove the point.

### F1 — check restructuring before convergence remediation

*Codex:* a PR that already has five code finding heads but whose current head is
missing the trailer/packet stops as `convergence_required` and is told to push
another convergence correction, when the gate should move it to
`restructure_required`.

Correct. Restructuring **supersedes** convergence: a unit past its limit must not
be asked for another correction head just because this head lacks a trailer.
`enforceRestructure` now runs BEFORE `enforceReviewConvergence` at **both** call
sites — the policy revalidation path and the review driver. Pinned by `M3`, which
fails when the order is swapped back.

### F2 — recheck the lifecycle after Codex returns a finding

*Codex:* at four prior code heads the pre-review check allows the review; if Codex
then posts findings on this head, the flow goes to `changes_required` and invites
another correction without ever re-running the assessment or recording the floor —
missing the exact transition where the gate must move to `restructure_required`.

Correct, and the sharpest of the four: the pre-review check necessarily read a
count one lower than the truth. The `changes_required` branch now re-assesses
before instructing anyone to push a correction, so the transition is caught and
the floor recorded. Pinned by `M4`, which fails when the re-assessment is removed.

### F3 — keep undecided restructure failures retryable

*Codex:* `isTerminalReviewStatus` treats any `review:` failure as terminal and
`isRetryableTerminalReviewFailure` does not include the undecided description, so
`persistentReviewFailure` latches it and later runs restore the same failure
instead of re-reading the file list.

Correct, and it made my own claim false: the sticky instruction says "re-run once
the file list is readable", and the status made that unreachable on the same head
— a permanent block on a transient condition. The undecided description is now
retryable. `M1b` pins the complement: a *real* restructure block stays persistent,
because crossing the limit is a decision, not a transient failure.

### F4 — page through sticky comments for the metrics floor

*Codex:* the sticky read takes only the first 100 issue comments; on a long PR the
comment is missed, `readMetrics` returns `null`, and a partial live reading can
walk the unit below a threshold it had crossed.

Correct — and the site audit found the same defect in its sibling. The **write**
path `updateStickyComment` also read only page one, so on a long PR it would fail
to find the existing comment and post a DUPLICATE, splitting the very record the
floor is read from. Fixing only the read would have left the floor unreliable for
a different reason. Both now use the existing `paginated` helper. `M2` pins both.

### Evidence

| Probe | Discriminates |
| --- | --- |
| `M1` / `M1b` | the undecided description is retryable; a real block is not |
| `M2` | both sticky paths paginate; neither stops at page one |
| `M3` | RED when the gate order is swapped back |
| `M4` | RED when the re-assessment is removed |

RED verification, with the ordering and the re-assessment reverted and everything
else left in place:

```
ok 23 - M2: both sticky-comment paths paginate
not ok 24 - M3: the restructure gate is consulted BEFORE the convergence gate
not ok 25 - M4: a finding on this head re-assesses the lifecycle before inviting a fix
# tests 25 / # pass 23 / # fail 2
```

Restored: 25/25. `pnpm test:automation` 176/176. `pnpm check` EXIT 0.

---

## Round 3 — the convergence audit

Five findings on `34e2152`. This is the second finding-bearing head, so under the
protocol this PR is itself defining, ordinary patching stops here: what follows is
ONE batched architectural correction, not a third round of call-site edits.

### The audit

Four of the five findings are the round-2 concepts at sites my round-2 "site
audit" did not reach. I said I had audited; I audited the sites Codex named plus
one sibling, and stopped. The enumeration I should have run first:

```
$ grep -n "state: '(changes_required|scope_required|convergence_required|blocked|ci_retry)'"
13 writers of a blocking state
```

**Thirteen** places write a blocking state and invite another correction head.
Round 2 added the lifecycle check before one of them. Codex named two more. At
that rate the remaining ten arrive as findings over the next five rounds — which
is precisely the failure mode this PR exists to stop, reproduced inside the PR
that stops it.

So the correction is not "add the check before ten more callers". It is to stop
asking callers to remember.

### The architectural change

**The lifecycle is now a run-level precondition.** `enforceRestructure` runs ONCE,
first — before the scope gate, before the CI branch, before convergence — in both
the driver and the policy revalidation path. The question "is another correction
head even permitted?" is answered before any code can invite one. No later exit
can bypass a check that has already run.

That subsumes G1 and G4 as a class rather than as two more sites.

### The model fixes

**G3 — the floor keeps identities, not a count.** A count-only `max` walks
backward when a partial live read ADDS the new head and OMITS an older one: floor
4, live read of three old heads plus the new fifth, `max(4, 4) = 4`, and the unit
sits below five having actually crossed it. `mergeFindingHeads` unions head SHAs,
which cannot lose a head either side has seen. A legacy count-only record still
binds as a numeric floor, so upgrading the gate forgives nothing already in
flight.

**G2 — the threshold is monotonic.** A docs-only unit that crossed three heads
could push a correction adding any runnable file, become `code`, have its
threshold rise to five, and return to `reviewing`. The strictest kind the unit has
ever presented now governs. Monotonicity only tightens: `N2b` pins that a code
unit is not retroactively made docs-only.

**G5 — an unreadable floor blocks.** Once a unit has crossed its limit the durable
record is the only thing carrying that forward; the failing status belongs to the
previous SHA. My comment said unreadable metrics are "treated as ABSENT, never as
zero-with-authority" — but absent means the floor cannot raise, which IS the
walk-back. `readStickyComment` now reports unreadable distinctly, and the
assessment blocks as `undecided`. Because `undecided` carries the retryable
description from round 2, fail-closed does not become fail-forever.

### Evidence

| Probe | Discriminates |
| --- | --- |
| `N1` | union is five where a count-only max reads four |
| `N1b` | a legacy count-only record still binds |
| `N1c` | the identity floor drives the verdict |
| `N2` / `N2b` | monotonic kind; tightens only |
| `N3` / `N3b` | unreadable floor blocks, and self-heals via the retryable status |
| `M3` | the lifecycle precedes scope AND convergence in both flows |

RED with the three model fixes reverted and everything else in place:

```
not ok 26 - N1: the floor unions head IDENTITIES, so a partial read cannot walk it back
not ok 28 - N1c: the identity floor drives the verdict
not ok 29 - N2: a crossed docs-only unit cannot raise its threshold by adding code
not ok 31 - N3: an unreadable floor blocks rather than continuing on the live count
# tests 32 / # pass 28 / # fail 4
```

Restored: 32/32. `pnpm test:automation` 176/176.

Five fake clients in `autonomous-review-workflow.test.mjs` gained a `stickyComment`
reader. That is a fixture correcting to reality, not a weakened assertion: the gate
now reads the floor from that comment, and a fake that can write it must be able to
read it. No assertion was changed.

### Carried debt, stated

The round-1 validation table above showed 20/20 and 171/171 after round 2 had made
them 25/25 and 176/176. It is corrected in this head and labelled with both.

---

## Round 4 — head `da70792` → this head

Two P2 findings. Both said the same thing about the same mechanism: the floor
round 3 made **sound** was never made **durable**.

| # | Codex finding | Where it actually lived |
| --- | --- | --- |
| 1 | the runbook recovery `jq` does not emit the new retryable status | `docs/AUTONOMOUS_LOOP.md`, a hand-maintained duplicate of the predicate |
| 2 | the lifecycle floor is not recorded when the assessment is allowed | `enforceRestructure`'s early return — **and** all sixteen sticky writers |

### The audit, before the fix

Round 2's lesson was that fixing the sites Codex names leaves the sites it did not
look at. So both findings were enumerated first.

**Finding 1 — enumerated, and it is genuinely one gap.** The predicate accepts five
descriptions; the runbook's `jq` emitted four. The missing one is exactly the one
named. But the two lists are *duplicates of each other*, which is why they drifted,
so the fix is not the missing string: `isRetryableTerminalReviewFailure` is now
driven by an exported `RETRYABLE_REVIEW_FAILURES` table, and `O1` asserts every
entry appears in the runbook. A sixth status added later fails a test instead of
stranding the next operator at 3 a.m.

**Finding 2 — enumerated, and it is much wider than the anchored line.** Codex
anchored at `if (result.allowed) return result;`. That is real: the floor was
written only on the blocking path, i.e. only once the unit had *already* crossed
its limit — precisely when a floor can no longer do anything, since its whole
purpose is to carry the count while the unit is still under. But the enumeration
found the other half:

```
updateStickyComment call sites : 16
... that pass a metrics block  :  1
```

So even on the blocking path where the floor *was* written, the next
`changes_required` update erased it. The floor was unreachable in both directions.

### The correction

This is the same shape as round 3 — a cross-cutting obligation sprinkled across
call sites — on a different axis: persistence rather than control flow. So it gets
the same kind of answer, not another sprinkle.

1. **Record on every path.** `enforceRestructure` computes the metrics once and
   records them *before* branching, so allowed, superseded and blocking all leave
   the floor behind. The unreadable-floor case is the sole exception and is
   deliberate: overwriting a durable record with a reading taken without it is the
   walk-back the rule forbids.
2. **Preserve structurally.** `updateStickyComment` runs every body through
   `preserveMetrics`, which inherits the run's metrics (or, failing that, the
   previous comment's block) whenever the body carries none. All sixteen writers
   are now correct without knowing the lifecycle exists, and so is the seventeenth.

Neither half works alone: recording without preservation is erased by the next
write; preservation without recording has nothing to preserve.

`client.setLifecycleMetrics(metrics)` is deliberately **not** optional-chained. A
client without the method would silently drop the floor, which is the defect being
corrected; it must fail loudly. It did — two workflow fakes threw, and gained the
method, exactly as five of them gained `stickyComment` in round 2. Fixtures
correcting to reality; no assertion weakened.

### Evidence

RED at `da70792`, before any fix (`O1`–`O3c` added, module unchanged):

```
not ok 33 - O1: the runbook recovery command emits every status the code retries
not ok 34 - O1b: the retryable predicate is driven by that same list
not ok 35 - O2: a sticky write that carries no metrics preserves the recorded floor
not ok 36 - O2b: fresher run metrics win over the previous block
not ok 37 - O2c: a body that already carries metrics is left exactly as written
not ok 39 - O3b: the lifecycle precondition RECORDS the floor when it lets a head through
not ok 40 - O3c: a later metrics-free sticky write still carries that floor
# tests 40 / # pass 33 / # fail 7
```

Discriminating check — the three wiring fixes reverted, tests untouched:

```
not ok 33 - O1: the runbook recovery command emits every status the code retries
not ok 39 - O3b: the lifecycle precondition RECORDS the floor when it lets a head through
not ok 40 - O3c: a later metrics-free sticky write still carries that floor
# tests 40 / # pass 37 / # fail 3
```

Restored: **40/40**. `pnpm test:automation` **191/191**.

### Honesty note on `O3`

`O3` passes at `da70792` and is kept anyway, relabelled. It pins the floor *value*
an allowed assessment would record — which round 3 already made correct — and it
does **not** reproduce this round's defect. The defect is that nothing *called*
`nextMetrics` on that path, so its reproduction is `O3b`, at the wiring level,
which is RED. `O3` earns its place by establishing what `O3b` is entitled to
expect, not by demonstrating the bug. Recorded here rather than left to look like
a seventh reproduction.

### Why this is a fourth head and not a restructure

Under this PR's own rule a code unit gets five finding-bearing heads; this is the
third. Applying a stricter standard to itself than it asks of anything else would
be theatre, and would leave the repository with no lifecycle at all.

The trajectory also argues against it: 4 findings → 5 → 2, all P2, and both of
these live in one function written in round 3 plus one document — not a concept
spread thin across a large surface. And there is no honest seam to cut: the model
without the wiring is dead code, and the wiring without the model has nothing to
wire. `restructure_required` is for a unit whose *shape* is wrong. This one's shape
is fine; its persistence was missing.

---

## Round 5 — head `9bd21ca` → this head

One P2 finding, and it is a real gap in round 4's own fix.

Round 4 made the floor durable **across sticky writes**. It did not make it durable
**across repeated lifecycle checks inside one run**. `enforceRestructure` runs twice
— the driver's precondition and the pre-Codex revalidation — and each seeded
`recordedMetrics` from the sticky comment *alone*. Against a metrics-less sticky
both start from `null`, so a partial second read of three heads replaces a first
observation of four. When Codex then adds the fifth head, a partial read totals
four, the unit reads as still under the limit, and the gate invites another
correction head on a unit that has already crossed.

The floor has **two** durable sources — the sticky comment and what this run has
already observed — and round 4 only unioned one of them with the live read.

### The correction, in two independently-testable halves

1. **Seed the assessment from the in-memory floor.**
   `mergeRecordedMetrics(readMetrics(sticky), client.lifecycleMetrics)` is what the
   assessment runs against, so the *verdict* — not merely the value stored
   afterwards — is taken against the higher floor.
2. **Make the setter monotonic.** `setLifecycleMetrics` merges rather than assigns,
   so no caller, present or future, can lower the floor even if it forgets to seed.

`mergeRecordedMetrics` accumulates what is a floor (identity union, legacy numeric
max, strictest kind ever presented, earliest `firstSeenAt`) and takes last-wins on
what describes the latest assessment (`state`, `threshold`, `elapsedMinutes`).

### Evidence — and a fixture defect caught in passing

The first version of `P1` **passed with both halves reverted**. Its fake client's
`setLifecycleMetrics` called `mergeRecordedMetrics` itself, so the probe measured
the fixture rather than the code. That is precisely the hollow-probe failure this
packet has been calling out elsewhere, and it is recorded here rather than quietly
repaired.

The fixture is now deliberately naive — a plain assignment — so `P1` measures the
seeding fix and nothing else, and `P1b` drives the **real** `GitHubClient` setter to
measure the other half. Each half is now independently discriminating:

```
A) seeding reverted only        →  not ok 41 - P1   (43 pass / 1 fail)
B) monotonic setter reverted    →  not ok 44 - P1b  (43 pass / 1 fail)
C) restored                     →  44/44
```

`P2` states the consequence exactly: with the floor preserved, a partial read that
omits `h1` but includes the new `h5` still totals five and restructures; with the
floor walked back to three, the same read totals four and keeps reviewing.

`pnpm test:automation` **195/195**.

### Head count

This is the fourth finding-bearing head; the code limit is five. Findings by head:
4 → 5 → 2 → 1. The next head is the last one this unit is entitled to under its own
rule, and if it draws findings the honest move is to restructure rather than argue
for an exception.
