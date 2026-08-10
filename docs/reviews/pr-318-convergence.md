# PR #318 — convergence audit (Phase-5 closing packet)

Four finding-bearing heads, five findings on a **docs-only** PR, plus one self-caught. Written
because they are one root rather than separate incidents, and because the root is worth more than
any of the individual fixes.

| # | Head | Finding | Caught by |
|---|---|---|---|
| 1 | `6961c60` | `STATUS.md` declared `open_pr: none` while PR #318 was open | the `automation` tripwire |
| 2 | `2473a71` | the packet cited two parked-finding notes that existed only on their park branches | `rg --files docs/reviews` |
| 3 | `01d16ce` | the packet and the 7B-vi note claimed an advance READ route that had been removed | `rg "@(Get\|Post)\('commercial/advances"` |
| 4 | `c63504d` | §M and §5 STILL claimed the advance read, after §H was corrected | reading the packet whole |
| 5 | `c63504d` | §I called the server side complete; the payment-rule grant's certifier guard is missing | reading `commercial.sod.grant` |

## The root: a claim about the repository is a fact, and facts are checked, not recalled

Every one of these is the same mistake. I described the state of the repository from memory, and in
each case the thing I described was something **I had myself just changed**:

- I wrote `open_pr: none` in the same commit in which I was creating the PR.
- I cited notes I had written minutes earlier — on *other branches*.
- I described `GET commercial/advances` as available in the same session in which I deleted it.

Proximity is what made each one feel safe to assert. Having just handled the thing is exactly the
state in which memory feels most reliable and is least worth trusting, because what I remember is
the *intent* — "the advance stays available through the API" — not the diff that removed the route.

Each was one command away from being verified, and Codex found each with exactly such a command.
That asymmetry is the finding: **verification here costs a single `rg`, and being wrong costs the
next unit a false hand-off.**

The checkable form: *before writing that the repository contains, exposes, or records something,
run the command that shows it. If a claim names a path, a route, a file or a PR number, it is a
fact — and a fact in a hand-off document is load-bearing precisely because the next reader will not
re-derive it.*

## Why a docs PR earned three findings, which is the uncomfortable part

Nothing here was a code defect, and it would be easy to file that as "just docs". It is the
opposite. This PR's entire purpose is the **hand-off**: it tells whoever starts 7B-v and 7B-vi what
is done, what is not, and where the evidence lives. A hand-off that misstates what exists is worse
than no hand-off, because it is trusted. Finding 2 would have pointed the next unit at files that
do not exist; finding 3 would have told it the advance read was already built.

This is the same shape as the lesson PR #317 paid five rounds for, one level up. There the rule was
*a gate may only compare the quantity the server compares*. Here it is *a record may only claim what
the repository actually contains*. Both are the same discipline: **check the world, do not model it
from memory.**

## Round 3 — fixing the instance, not the class, on the document about not doing that

Findings 4 and 5 arrived because round 2's fix corrected **§H, where the finding pointed**, and left
§M and §5 making the same advance-read claim in their own words. Same document, same paragraph-level
claim, three places — and I searched none of them.

That is `pr-317-convergence.md`'s root — *fix the instance not the class* — recurring inside the
audit written about a neighbouring root. The remedy is mechanical and was available: when a finding
says a claim is false, **grep the claim, not the line**. The corrected pass did exactly that
(`rg -nE "advances read|advance ledger|commercial/advances|advance rows"`) and found all three at
once.

Finding 5 is worth separating out because it is not a wording defect. `commercial.sod.grant` checks
that the excused actor holds standing for the act the rule names, but not that — for
`certifier-may-not-approve` — they ARE the certifier, while `approve()` consumes such a grant only
when `certificate.certifiedById === actor`. So a pmc can record a payment-rule grant naming any
approver and it is never spendable. **That is a live server-side gap**, and the packet had called
the §I server side delivered. 7B-v owns it, and the hand-off now says so — the browser picker
narrowing to the certifier is the same rule's other half, not the whole of it.

## Fixes

1. `open_pr: 318`, in a follow-up commit — the number does not exist until the PR does, so the
   ordering is inherent; the tripwire correctly caught the one-commit window.
2. Both parked-finding ledgers landed on `main` in this PR, their opening lines corrected from
   "This branch is `<sha>`" (true where written, false on `main`) to naming their park branch.
3. The packet and the 7B-vi note now say plainly: `POST commercial/advances` survives and the
   recovery ceiling is enforced, but `GET commercial/advances` and `listAdvances` were removed with
   the control — so 7B-vi owes the **read as well as the surface**, and the read lands first,
   because the advance coalesce key has no settling read without it.

That third fix carries a real handoff correction, not just a wording change: getting the read/control
ordering wrong is what made this surface a defect in 7B-iv in the first place.

## Round 4 — the open questions move from prose to probes

Three finding-bearing heads on a docs-only diff triggers the plan's bounded-review rule: the next
head converts each still-open question into a **named probe** rather than answering it with more
prose. Nothing is dismissed; only the place of verification moves.

The rule fits this PR exactly, and that is worth saying rather than treating it as a formality.
Every finding here was a mechanically checkable fact about the repository that I asserted in prose
— and prose **cannot fail**. Three rounds of more careful writing produced three more rounds of
findings. `scripts/phase5-handoff-facts.test.mjs` makes the same claims executable:

| Probe | The question it settles | Which finding it retires |
|---|---|---|
| ledgers reachable | do the cited parked notes exist here? | 2 |
| ledger names its park BRANCH | does any note still say "this branch"? (whole-text, wrap-safe) | 4 (self-caught) |
| 7B-vi is OPEN | does the advance LIST read exist? | 3, and the §M/§5 repeats |
| 7B-v is OPEN | is the payment-rule grant guarded to the certifier at ISSUE? | 5 |
| packet claims no parked surface | does any packet section still assert a parked surface is delivered? | the CLASS behind 3–4 |

Two probes deliberately pin an **absence**, and their failure messages say what to do when the gap
closes: invert the probe and update the packet section and ledger with it. That coupling is the
point — the record can no longer drift from the code silently, because the drift breaks a test.

**Deferred to: `phase-5-task-7b-v`** (the §I guard) and, for the advance read, `phase-5-task-7b-vi`.
The probes are also recorded in the **phase plan** (`§ Deferred hand-off probes`), because the
follow-on units are driven from the plan and a deferral recorded only in a review packet can be
skipped — Codex's finding, and correct.

**One finding on this head could NOT be applied as suggested, and that is recorded rather than
silently dropped.** The P1 asked for the merge record to land in a state that resolves to
`phase-5-task-7b-v`. It cannot: `assessRunnerState` reaches `next_task` only from
`task_state: merged`, and a second validator refuses `merged` while `open_pr` names a live PR — *"a
MERGED between-work STATUS must clear open_pr — a merged PR is not the next step"*. A PR that is
itself the open PR therefore cannot land in the hand-off state; the flip is a separate post-merge
commit **by design**, which is the irreducible half of the folded-STATUS process change already
recorded in the 7B-iv row. The diagnosis is right — `in_progress` does resolve to `task:7` after the
continuation clears `open_pr` — and the remedy is the post-merge flip, which is scheduled.

Each probe was mutation-tested rather than merely run green: re-adding `@Get('commercial/advances')`,
re-introducing a wrapped "this branch", and restoring the false §M claim each turn exactly one probe
red, and the tree restores green. A probe that cannot fail is the same defect as prose.

## Verification

The verification for a docs claim is the command that establishes the fact; each is recorded above
with its result, and the five that matter are now executable. `automation` 205/205 (200 + 5).

**A fourth instance, self-caught, worth recording because of HOW it was nearly missed.** Fixing
finding 2 I corrected each note's opening "This branch is `<sha>`", ran `grep "this branch"` over
both, got no output, and treated that as clean. It was not: one instance wrapped across a line
break, so a single-line grep could not match it. A multiline search found it immediately.

That is this document's own root reappearing one level down — **the check has to be able to observe
the thing it claims to rule out.** A grep that cannot match wrapped prose returning empty is not
evidence of absence, exactly as memory of an intent is not evidence of a route. Same discipline,
same failure mode, caught this time only because the root had just been written down.
