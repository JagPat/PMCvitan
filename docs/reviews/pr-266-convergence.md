# Convergence audit — PR #266 (Phase 5 plan split)

Required by `CLAUDE.md` after two finding-bearing heads.

| Head | Findings | |
| --- | --- | --- |
| `1bd04ca` | 4 | 2×P1 — probe list outside the tree; STATUS strands the runner |
| `55d65e0` | 6 | 4×P1 — §J dangling; `resolved` counted live; bill unlocked at certification; measurement/close-short race |

The count rose, 4 → 6. That needs an honest answer rather than a third round of
patches, because it is the exact trajectory of the two units this PR exists to
avoid repeating.

## The two findings that are mine, and the one rule that closes them

Both of my findings across the two heads are the SAME mistake in two forms:
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

## Where this leaves the review

This is head 3 of a docs-only plan. `PLAN_REVIEW_ROUND_CAP = 3` exists precisely
for this case and #252 used it from round 11.

**The commitment for the next round, stated before seeing it:** if head 3 draws
findings that are *"the plan should also specify X"*, they are converted into
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
