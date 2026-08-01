# Why the five-head rule ships in two units

This records a decision, not a defect. The full 34-finding audit of the first
attempt is preserved at `docs/reviews/pr-264-convergence.md` on the abandoned
`claude/lifecycle-rule-wiring` branch and in PR #264; this document is the part a
future reader needs.

## The defect being fixed

`scripts/review-lifecycle.mjs` shipped in #259 as a policy model with 20 passing
tests, imported by **nothing except those tests**.
`RESTRUCTURE_AFTER_FINDING_HEADS = 5` never fired. PR #263 then ran to **six**
finding-bearing heads without it triggering once. The policy was never wrong; it
was never asked.

## What the first attempt taught

PR #264 tried to wire the rule and enforce it in one unit. Findings per review
round:

| Round | Findings | | Round | Findings |
| --- | --- | --- | --- | --- |
| 1 | 6 | | 7 | 1 |
| 2 | 1 | | 8 | 2 — **P1** |
| 3 | 4 | | 9 | 2 — **P1** |
| 4 | 4 | | 10 | 2 — **P1** |
| 5 | 3 | | 11 | 4 — **2×P1** |
| 6 | 3 | | 12 | 4 — **2×P1** |

Rounds 8–12 each carried a P1, and **four consecutive rounds had a P1 caused by
the immediately preceding round's fix**. Every one of those P1s lived in the same
half of the change: the machinery that exists to make *blocking* safe. The wiring
itself, and the severity classifier, drew nothing after round 3.

That is the whole argument for the split. It is not that the enforcement half was
badly written — the individual fixes were correct and each was discriminated. It
is that a change whose correctness depends on durable state surviving many
writers, a timer reaching a deadline no event announces, and an attributable
human channel is **too much to review as one unit**, and the review record says so
in the only way that counts: by not converging.

## Where the line is, and why it is there

The line is not "big half / small half". It is drawn by what each half needs in
order to be **safe**, and `AGENTS.md` decides it:

> Do not block on human sign-off, and do not tell the author to wait for approval
> — no one is standing by to give it.

A gate that stops an over-limit unit until a human answers is therefore only
correct if it *also* has every mechanism that keeps it from stalling the loop:

| Needed before it may block | Why |
| --- | --- |
| an attributable declaration channel | the answer must come from a real maintainer, not from the loop's own prose |
| a reply window | so silence resolves |
| a durable request record | the crossing is evidence from earlier SHAs; nothing else carries it forward |
| a timer | window expiry is the one state no event announces — it is *defined* by nobody acting |
| a recovery path | a blocked head must be able to resume without a human pushing a commit |

**Unit 1 (this change) needs none of them, because it does not block.** It
recomputes from live evidence every run, and if the read fails it reports nothing
rather than reporting wrongly. There is no state to preserve, no deadline to
reach, and no decision to attribute.

**Unit 2 needs all of them**, and gets its own review budget to earn them.

## What unit 1 delivers

The threshold is finally computed on **both** paths that reach a review, and a
unit that has spent five heads still turning up findings that are not provably
minor says so, in the place a human is already looking.

That is not a consolation prize. It is the signal the owner used to decide to
split PR #264 — the information existed only because a human read twelve rounds
of Codex output by hand. After this change the loop reports it.

| Probe | Pins |
| --- | --- |
| `L1` | an over-limit critical unit is reported at all — the defect |
| `L2` | the rule is called on the **promotion** path, not only at final admission |
| `L3` | threshold, worst-wins tier, and silence below the limit |
| `L4` | unknown severity is never treated as minor, and never hidden behind a readable P1 |
| `L5` | unreadable evidence reports nothing rather than inventing an all-clear |
| `L6` | **the observation never blocks and never throws** — the unit's own boundary |

`L2` is the one that matters structurally. The first attempt wired the rule into
one of the two call sites and stopped; asserting "the function exists" would not
have caught it. `L2` slices the source between the promotion-path convergence
call and `reviewNotBefore` and requires the call inside that region, so a future
path that promotes a head without consulting the rule fails CI rather than
shipping.

`L6` is the one that keeps the split honest. If a later change starts blocking on
this path, it fails.

## What unit 2 will carry

Deferred whole, with the twelve rounds of findings against it preserved as prior
art rather than thrown away:

- the attributable declaration channel (comment-sourced, permission-verified,
  code-span aware, latest-answer-wins)
- the reply window and its severity tiers
- the durable request record — one nested key, written whole, legacy shapes
  normalised on read, carried forward by a single non-throwing writer
- the expiry sweep and the `issue_comment` wake
- the recovery path for lifecycle blocks

Round 12's two open P1s belong to that unit and are recorded here so they are not
re-discovered: permission must be verified **while selecting** the latest valid
declaration rather than after selecting a single candidate, and an authorization
read that fails must propagate as *unreadable*, never as *absent*.

Both are the same mistake — converting "unknown" into "absent" — in a module
whose governing rule is that unreadable evidence fails closed. That mistake is
easy to make under a large diff and hard to make under a small one, which is the
final argument for the shape of this split.
