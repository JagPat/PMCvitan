# Convergence audit — PR #266 (Phase 5 plan split)

Required by `CLAUDE.md` after two finding-bearing heads.

| Head | Findings | |
| --- | --- | --- |
| `1bd04ca` | 4 | 2×P1 — probe list outside the tree; STATUS strands the runner |
| `55d65e0` | 6 | 4×P1 — §J dangling; `resolved` counted live; bill unlocked at certification; measurement/close-short race |
| `6afb58e` | 3 | 2×P1 — §I still absent while claimed kept; payment WRITES outside the bill lock |

The count rose 4 → 6, then FELL to 3 — the first decline this unit has seen, and the
first in either of the two units this PR exists to avoid repeating (#252 ran twenty
rounds without one; #264 ran twelve).

## The findings that are mine, and the one rule that closes them

Every finding of mine across the three heads is the SAME mistake:
**I moved text out of the reviewed tree and broke a reference into it.**

| Head | What I moved | What broke |
| --- | --- | --- |
| `1bd04ca` | the probe list | the plan no longer defined what adjudicates the deferred questions — a deferral nobody can audit is a deletion |
| `55d65e0` | §I and §J (while restoring the probes) | probes 5o/5bc/5bm/5be cite a §J bucket table that did not exist; probe 5be literally requires it to PARSE |

One rule closes the class, and it is now written into the plan:

> **A section stays in the plan if any retained probe cites it.**

That is checkable by grep, not by judgement, which is why it is worth more than
the two individual fixes. It is also why the plan is now 939 lines against the
owner's 500-line guidance: the guidance and the audit trail were in genuine
conflict, and I chose the audit trail and said so rather than quietly meeting
the number.

## The four findings that are NOT mine — and what they mean

`resolved` bills folding into `BILLED_QTY`; certification reading a bill status
without locking the row; measurement not taking the labour PO-line lock that
close-short takes; supersession auto-reversing paid cash. All four are
pre-existing defects in sections carried VERBATIM from PR #252 — sections that
had already survived **twenty** review rounds.

That is the finding behind the findings. #252's own round-7 conclusion was
*"prose has no compiler"*, and this head is fresh evidence for it: 889 lines of
dense invariant prose still contained four P1 defects after twenty rounds of
competent review, and a twenty-first round found them. Every one is real. Every
one is fixed here. And there is no reason to believe a twenty-second round finds
zero.

Two of the four are the same shape as each other — **a guard that orders the
sequential case but not the concurrent one** (certification vs amend; measurement
vs close-short). Both are answered by putting the contended row in the lock order,
which is a rule a probe can enforce and prose cannot.

## Round 3 — the cap engaged, and changed nothing

`PLAN_REVIEW_ROUND_CAP = 3` engaged on `6afb58e`. The commitment made in the previous
section — before the findings were known — was that *"the plan should also specify X"*
findings convert to named probes, while concrete defects are still fixed.

**All three were concrete defects, so all three are fixed.** The cap changed nothing,
which is the correct outcome and worth recording: a cap that fires on finding COUNT
rather than finding KIND would have deferred two P1s here, one of them a payment
double-spend.

| # | P | Finding | Origin |
| --- | --- | --- | --- |
| 1 | P1 | §I absent while the plan CLAIMED it was kept; probes 5m/5aa/5al/9 cite it | **mine** |
| 2 | P1 | payment and reversal WRITES outside the bill lock — two concurrent ₹100 payments each read `PAID = 0`, both pass bound 5, ₹200 commits against ₹100 approved | pre-existing |
| 3 | P2 | `vendorBillNumber` missing from the non-blank AND frozen-key closure rows though probe 5bg makes it the duplicate-claim key | pre-existing |

Finding 1 is the third instance of my one mistake in this PR, and the most embarrassing
form of it: I wrote the rule (*a section stays if a probe cites it*), wrote "§I and §J are
kept HERE", and then restored only §J. **The claim was false the moment it was written and
a grep would have caught it.** That is exactly why the rule is now phrased as a mechanical
check rather than an intention — an intention is what failed.

Finding 2 is the same shape as round 2's certification-lock finding: a bound that is a
FOLD read at write time is not enforced by locking one participant in the flow. Approval
took the bill lock; the writes that actually move `PAID` did not. Under READ COMMITTED
that is a double-spend with both rows append-only, so nothing walks it back.

## Correction: what the round cap actually obliges

The previous section said the cap "gates KIND rather than COUNT" and therefore
changed nothing on a head whose findings were all concrete defects. **Half of that
was wrong, and the gate caught it** — `ca148eb` was refused with
`convergence_required`: *missing a `Review-Deferred-To-Probes: <task>` trailer*.

The rule as implemented is unconditional. `review-efficiency.mjs` states it
directly — *"PLAN_REVIEW_ROUND_CAP — this adds an obligation, it never removes
one."* Past three finding-bearing heads a docs-only review owes the trailer
**regardless of what kind of findings the latest round produced.**

What I had right: the cap never excuses fixing a finding, and every finding on
every head here was fixed. What I had wrong: I treated "no findings needed
deferring" as "no deferral is owed". Those are different claims. The trailer does
not assert that anything went unanswered — it names **where the plan's remaining
open questions get settled**, which is a standing fact about a plan that defers
mechanism to task PRs, not a per-round judgement about the last review.

**Value: `phase-5-task-7`.** The trailer names the review stop that settles the
deferred questions, and Task 7 is this plan's FINAL STOP. `phase-5-task-1` would
be wrong for the same reason it was a P1 in #252 round 17: the deferred §B–§H
mechanism is settled across every task, and the last stop that can adjudicate any
of it is Task 7, not the first one. Both values are shape-valid and phase-eligible,
so nothing but honesty distinguishes them.

## Correction 2: the deferral could not be verified while this PR moved STATUS

`ed91743` carried the right trailer and was still refused:

> this PR changes `docs/STATUS.md`, so the default-branch copy the gate reads is
> not this PR's own phase truth and cannot verify the deferral's phase.

The gate resolves a deferral's phase from **`docs/STATUS.md` on the default
branch**. A PR that edits STATUS gives it two candidate truths and no way to
choose, so it refuses rather than pick — the same fail-closed instinct as every
other rule here.

The value was never the problem. `main`'s STATUS already lists phase 5 as
eligible through `next_task: phase-5-planning`, so `phase-5-task-7` verifies
cleanly the moment STATUS is not in this diff.

**Remedy taken — the gate's first suggestion: land the STATUS change on its own.**
`docs/STATUS.md` is reverted to `main`'s copy and this PR is now the plan and this
audit, nothing else. That is the better split on its own merits: STATUS advancing
to phase 5 / task 1 belongs with the change that **starts** Phase 5, not with the
document that plans it. The plan is a description; STATUS is a claim about what
the runner should do next, and those are different facts with different lifetimes.

Consequence, stated rather than hidden: until this merges, `main`'s STATUS still
records `open_pr: 265` and the hourly drift shepherd will keep flagging it. That
is noise on a merged PR, not a stranded runner — `assessRunnerState` still returns
`pr:265`, and the Task-1 head corrects it.

## Where this leaves the review

This is head 6 of a docs-only plan, past `PLAN_REVIEW_ROUND_CAP = 3`, with the
deferral declared and verifiable.

**The commitment stands unchanged for every further round:** findings that are
*"the plan should also specify X"* are converted into NAMED PROBES rather than
answered with more prose — the mechanism the repository already has for the case
where a plan can always be specified further. Findings that are concrete DEFECTS
with concrete fixes are fixed, because the cap gates paperwork and never a
finding, and `guardAgainstCurrentHeadFinding` fails closed on every current-head
finding regardless.

Nothing here is dismissed, deferred or downgraded. The `codex-current-head` gate
still admits only a head Codex returns clean on.

## Gates

`pnpm test:automation` 189/189 · review-scope standard · docs-only, no product
surface, no migration, and — from this head — no `docs/STATUS.md` change either.
