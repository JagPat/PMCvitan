# Review packet — Review lifecycle, part 2: durable floor + gate enforcement

Companion to PR #259 ("Review lifecycle, part 1: the restructure policy model",
merged at `main` `503b10c`). Part 1 shipped the policy as pure functions with no
consumer, stated plainly at the time:

> **Nothing enforces this yet.** The module has no consumer until part 2.

This is part 2. It makes the policy durable and wires it into the gate, so `main`
stops carrying a rule nothing consults.

## Review unit

| | |
| --- | --- |
| Base SHA | `503b10c` |
| Concern | one: make the merged restructure policy enforceable |
| Changed files / lines | 7 files, 795 lines — inside the 20-file / 1,500-line budget |
| Migrations | none |
| Product surface | none — `scripts/` + two docs files |

## What part 1 left undone, and why it is two things

Part 1's own PR body recorded where #258's five rounds of findings actually
landed: **five of six were about the floor's persistence and propagation**, one
was about policy. Part 2 is therefore not "the plumbing" — it is the half of the
problem that drew almost every finding, reviewed on its own.

Two properties make a floor real, and they are separate:

| Property | Why a floor without it is worthless |
| --- | --- |
| **Durability across writers** | The sticky comment is written from more than a dozen places in the gate. Only the lifecycle writer has any reason to know metrics exist. If preserving them were each writer's job, the first `changes_required` update after a lifecycle verdict erases the record — and so does the next writer anyone adds. |
| **Durability across sources** | The gate assesses more than once per run. Each assessment re-reads the sticky comment; against a comment with no block yet, every read starts from nothing, so a later partial read of the findings API can replace an earlier, larger observation. |

Both are answered **structurally**, not per site — see below.

## The design decisions, and the alternative rejected in each

### 1. Preservation is structural, not per-writer

`GitHubClient.updateStickyComment` wraps every body through
`preserveMetrics(body, existing?.body, this.lifecycleMetrics)`. A body that
already carries a block keeps its own; a body that carries none inherits this
run's assessment, falling back to the previous comment's block when the run never
reached the precondition.

*Rejected:* teaching each of the sticky-comment writers to re-attach the block.
That is the defect class this whole lifecycle exists to stop — a concept with
many sites, corrected one site at a time. It also fails open on the site nobody
has written yet.

### 2. The in-run floor is monotonic by construction

`GitHubClient.setLifecycleMetrics` **merges** rather than assigns:

```js
setLifecycleMetrics(metrics) {
  this.lifecycleMetrics = mergeRecordedMetrics(this.lifecycleMetrics, metrics);
}
```

and `enforceRestructure` unions both durable sources *before* assessing, so the
higher floor decides the **verdict**, not merely the value stored afterwards:

```js
const recordedMetrics = floorUnreadable
  ? null
  : mergeRecordedMetrics(readMetrics(sticky), client.lifecycleMetrics);
```

*Rejected:* assigning the latest observation. A second precondition call against
a metrics-less sticky comment would then assess a partial live read as the whole
truth — the exact walk-back the floor rule forbids.

### 3. The floor is recorded on **every** path, before branching

```js
const metrics = floorUnreadable ? null : nextMetrics({ ... });
if (metrics) client.setLifecycleMetrics(metrics);
if (result.allowed) return result;
```

Recording only on the blocked path records the count only once the unit has
already crossed — precisely when a floor can no longer do anything. Its whole
purpose is to carry the count while the unit is still *under* the limit.

The call is deliberately **not** optional-chained. A client without the method
would silently drop the floor, which is the defect this gate exists to prevent;
it fails loudly instead. Two of the five workflow-test fakes did not have the
method and threw — they now implement it.

### 4. Unreadable is not absent

A failed sticky read returns a distinguishable `FLOOR_UNREADABLE` sentinel, not
`null`. The assessment blocks on it and publishes `failure` with
`review: restructure check undecided`.

Because that condition is transient by construction — and its own instruction
says to re-run once the comment is readable — it joins
`isRetryableTerminalReviewFailure`. Latching it as persistent would make its own
instruction unreachable on the same head: a permanent block on a temporary
failure.

*Rejected:* treating a failed read as "no record". A partial live read would then
continue a unit that had already crossed.

### 5. Both sticky-comment paths paginate

The reader (`stickyComment`) and the writer (`updateStickyComment`) both use
`paginated(...)`. On a long PR the sticky comment is not on page one. A missed
read returns "no record"; a missed write posts a **duplicate**, splitting the
record across two comments.

### 6. The check is a run-level precondition, hoisted

It runs once, first, at both enforcement seams (`run()` and
`revalidateFinalReviewPolicy`), ahead of `enforceReviewScope`.

*Rejected:* invoking it from each of the ~13 places that write a blocking state.
Every one of those invites another correction head, and asking all of them to
remember a cross-cutting rule is how the rule gets missed at the one site nobody
looked at.

## Reproduce-first evidence

`scripts/review-lifecycle-enforcement.test.mjs` — **9/9**.

| Probe | What it pins |
| --- | --- |
| `E1` | a unit at the limit is blocked: drafted, status `failure`, sticky names `Replaces: #900` |
| `E1b` | a unit under the limit proceeds untouched — no draft, no status, no comment |
| `E2` | the floor is recorded on the **allowed** path, not only when blocking |
| `E2b` | a second check in the same run cannot lower the recorded floor |
| `E2c` | a metrics-free sticky write through the **real** `GitHubClient` preserves the floor |
| `E3` | an unreadable floor blocks rather than guessing (`undecided`) |
| `E3b` | that status is retryable; `review: restructure required` is not |
| `E4` | both sticky paths paginate — the floor is found on page 2 |
| `E5` | the precondition precedes `enforceReviewScope` at **both** seams |

### Discrimination — each mechanism reverted in turn

Every probe was proven to fail when the mechanism it claims to pin is removed.
Reverted one at a time against the same suite:

| Reverted mechanism | Result | Probe that failed |
| --- | --- | --- |
| structural preservation in `updateStickyComment` | 8 pass / 1 fail | `E2c` |
| in-run floor union (read the sticky comment only) | 8 pass / 1 fail | `E2b` |
| fail-closed unreadable floor (`catch` → `null`) | 8 pass / 1 fail | `E3` |
| the `run()` seam's precondition | 8 pass / 1 fail | `E5` |
| — restored — | **9 pass / 0 fail** | — |

Four mechanisms, four distinct probes, one failure each. No probe passes with its
mechanism absent.

### Honest note on `E5`

`E5` is a **structural** pin, not a behavioural one: it reads
`autonomous-review-gate.mjs` and asserts that `await enforceRestructure(` appears
at both seams and precedes both `await enforceReviewScope(` calls. It proves
ordering *as written*, not ordering *as executed*. It is recorded that way rather
than described as an end-to-end proof, because a source-text assertion is what it
is. Executing both seams end-to-end would require standing up the full run
pipeline; the behavioural half is covered by `E1`/`E1b`, which drive
`enforceRestructure` directly.

An earlier draft of the in-run probe was **not** discriminating and is recorded
here rather than quietly repaired: the fake client's `setLifecycleMetrics` called
`mergeRecordedMetrics` itself, so the probe passed with the production fix
reverted — it tested the fixture. The fake is now a plain assignment, which
isolates the seeding, and `E2c` drives the real `GitHubClient` for the
preservation half.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | None — no auth, membership, org or project scoping touched. The gate acts only on its own PR under the existing trusted-workflow identity | No route, policy, guard or tenancy code in the diff |
| civil-time-lifecycle | `nextMetrics` stamps `firstSeenAt`/`elapsedMinutes`; if elapsed time gated, a slow review would become a deadline that pressures rushed heads | Elapsed time remains telemetry — only the head count gates (pinned by part 1's `L11`/`L11b`, unchanged here). `mergeRecordedMetrics` keeps the **earliest** `firstSeenAt`, so a later record cannot restart the clock |
| concurrency-idempotency | The precondition runs more than once per run and across reruns; a later partial read must not lower a crossed floor | `E2` (recorded on the allowed path), `E2b` (second in-run check cannot lower it), `E2c` (survives an unrelated sticky write). `setLifecycleMetrics` merges rather than assigns, so no caller can lower it |
| data-integrity-conservation | The finding record is what is conserved; a partial read, a dropped block or a duplicate comment destroys it | `preserveMetrics` is structural, so no writer can erase it; `E4` pins pagination on **both** paths (a missed write posts a duplicate and splits the record); `E3` pins that an unreadable record blocks rather than reading as zero |
| offline-reconciliation | None — no client outbox, IndexedDB or replay path touched | No `apps/web` source in the diff |
| ui-server-parity | None — no UI or API surface changed | Diff is `scripts/` + `AGENTS.md` + `docs/AUTONOMOUS_LOOP.md` + this packet |

## Gate battery

| Gate | Result |
| --- | --- |
| `node --test scripts/review-lifecycle-enforcement.test.mjs` | **9/9** |
| discrimination (4 reverts) | each 8/1, restored 9/9 |
| `pnpm test:automation` | **180/180** |
| `pnpm check` | **EXIT 0** (web 543/543, API 680/680, build clean) |
| Migrations | none — `upgrade-proof.sh` not applicable |

## Correction round 1 — head `4e3644a`, three findings

All three were real. Two were gaps in the enforcement; the third held this PR to a
rule part 1 had already written down and part 2 then failed to honour.

### P1 — the precondition is necessary, not sufficient

The lifecycle check ran only as a run-level precondition, *before* Codex is
promoted. So it sees the count as of the PREVIOUS head: a unit at four
finding-bearing heads passes it, Codex posts findings on this head making five,
and the plain `changes_required` branch answers the fifth head by asking for a
sixth. The gate would only notice on the head after the one that crossed.

**Fix.** The finding outcome now funnels through one `publishFindingOutcome`,
which re-asks the cap against live evidence that *includes* this head's findings.
When the cap is reached, `enforceRestructure` has already drafted, failed the
status and written the sticky comment, so the caller reports it rather than
publishing a second verdict — one head, one verdict. Three `changes_required`
publication sites now share it, so a fourth added later inherits the re-check.

### P2 — an unreadable floor must not rescue a unit the live evidence convicts

The unreadable-floor rule took the retryable `undecided` path unconditionally,
even when the successfully-read comments already showed five finding-bearing
heads. The floor is a **lower bound**, and a lower bound cannot lower anything:
if the live reading alone reaches the limit, `max(unrecorded, live)` reaches it
too. Publishing `undecided` there stranded an already-over-limit unit in recovery
instead of issuing the replacement verdict it had earned.

**Fix.** `assessRestructure` blocks as `undecided` only where it is actually
blind — floor unreadable **and** the live reading under the limit.

### P2 — preserve docs-only probe deferrals at the cap

This module's own header says it governs "the case that had no rule", and part 1
deleted the docs/code classifier precisely so a second, shorter cap could not
collide with the bounded `Review-Deferred-To-Probes` protocol. But the
enforcement then ran ahead of `enforceReviewConvergence` and blocked a docs-only
unit that had *already made* that handoff — replacing the protocol for the exact
case the repository wrote it for. The subtraction went one step too far: removing
the classifier also removed the awareness that a deferred unit is already handled.

**Fix.** When the cap would otherwise block, the gate asks whether an **accepted**
deferral is in force, and stands down if so. Deliberately:

- the answer comes from `assessConvergence` on the same inputs the convergence
  gate uses — not from re-deriving "is this docs-only" here, which is how one rule
  ends up with two implementations that disagree;
- `allowed === true` already folds in every validity condition, so a deferral the
  convergence gate would reject buys nothing here either (`E8c`);
- an unverifiable answer is **not** an exemption — failing the other way would let
  an unreadable API turn every over-limit unit into an exempt one;
- it is not the classifier returning: nothing is inferred and no second threshold
  exists. The signal is an explicit, declared, already-validated handoff.

### Correction probes

| Probe | What it pins |
| --- | --- |
| `E6` | a finding that CROSSES the limit gets the replacement verdict, not another round |
| `E6b` | a finding below the limit still gets an ordinary correction head |
| `E7` | an unreadable floor does not rescue a unit five live heads already convict |
| `E7b` | it still blocks as `undecided` when the live reading is under the limit |
| `E8` | the policy stands down for an accepted deferral (pure) |
| `E8b` | the gate recognises one through the convergence contract (wiring) |
| `E8c` | an invalid deferral (`later`) exempts nothing |
| `E8d` | a code unit at the limit is still blocked |

Discrimination, each mechanism reverted in turn:

| Reverted mechanism | Probe that failed |
| --- | --- |
| the post-review re-check inside `publishFindingOutcome` | `E6` |
| the live-evidence exception on an unreadable floor | `E7` |
| the deferral stand-down (policy) | `E8` **and** `E8b` |
| the deferral consult (gate wiring only) | `E8b` only |

The last two rows are the useful ones: reverting the policy breaks both probes,
reverting only the wiring breaks only the wiring probe. Policy and wiring are
independently pinned rather than jointly covered by one passing assertion.

`E8b` derives its phase from `deferralPhases(loadStatusDocument())` — the same
source the gate reads — so it tracks `docs/STATUS.md` instead of pinning a phase
number that legitimately changes.

Round-1 gates: focused suite **17/17**; `pnpm test:automation` **188/188**;
`pnpm check` **EXIT 0** (web 543/543, API 680/680).

## What this deliberately does not do

- Does **not** change the threshold. Five finding-bearing heads is part 1's
  number and is not revisited here; whether it should count P1s rather than raw
  finding-bearing heads is a policy question for the project owner, recorded as
  open rather than decided by this PR.
- Does **not** detect an *undeclared* replacement. A PR opened with the same work
  and no `Replaces:` line starts at zero. Detecting laundering by content
  similarity was considered and rejected in part 1: it would guess, and a gate
  that guesses is the defect this module exists to stop.
- Does **not** claim `E5` proves runtime ordering. See the honest note above.
