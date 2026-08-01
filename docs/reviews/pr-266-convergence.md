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

## Where this leaves the review

This is head 4 of a docs-only plan, past `PLAN_REVIEW_ROUND_CAP = 3`. The cap has
now engaged once and changed nothing, because it gates KIND rather than COUNT.

**The commitment stands unchanged for every further round:** findings that are
*"the plan should also specify X"* are converted into
NAMED PROBES carrying `Review-Deferred-To-Probes: phase-5-task-1` rather than
answered with more prose — the mechanism the repository already has for the case
where a plan can always be specified further. If head 3 draws findings that are
concrete DEFECTS with concrete fixes — as all six here were — they are fixed,
because the cap gates paperwork and never a finding, and `guardAgainstCurrentHeadFinding`
fails closed on every current-head finding regardless.

Nothing here is dismissed, deferred or downgraded. The `codex-current-head` gate
still admits only a head Codex returns clean on.

## Gates

`pnpm test:automation` 189/189 · `autonomous-status-state` 12/12 · review-scope
standard · docs-only, no product surface, no migration.
