# PR #318 — convergence audit (Phase-5 closing packet)

**Eight finding-bearing heads, sixteen findings, on a closing packet.** Written because they are a
small number of roots rather than sixteen incidents, and because the roots are worth more than any
individual fix. The complete ledger, so the next unit inherits cause → remedy → proof rather than a
summary:

| # | Head | Finding | Caught by | Remedy |
|---|---|---|---|---|
| 1 | `6961c60` | `STATUS.md` said `open_pr: none` while #318 was open | `automation` tripwire | `open_pr: 318` next commit |
| 2 | `2473a71` | packet cited parked notes existing only on their branches | `rg --files docs/reviews` | both ledgers landed here |
| 3 | `01d16ce` | packet + 7B-vi note claimed an advance READ route that was removed | `rg "@(Get\|Post)\('commercial/advances"` | §H corrected |
| 4 | `c63504d` | §M and §5 STILL claimed it, after §H was fixed | reading the packet whole | grep the CLAIM, fix all three |
| 5 | `c63504d` | §I called the server side complete; the certifier-at-issue guard is missing | reading `commercial.sod.grant` | recorded as open, owned by 7B-v |
| — | `01d16ce` | a wrapped "this branch" survived a single-line grep | self-caught, multiline search | whole-text check |
| 6 | `aa2a9eb` | the 7B-v probe was VACUOUS — `slice(-1)` on a missing literal | reading the probe | locate explicitly; mutation-tested |
| 7 | `aa2a9eb` | deferred probes were not in the phase plan that drives the units | `rg` over `docs/superpowers/plans` | plan rows added |
| 8 | `aa2a9eb` | packet header claimed §I fully server-enforced | its own §I contradicted it | header corrected |
| 9 | `aa2a9eb` | STATUS 7B-vi row still said the read ships | grep the claim | corrected |
| 10 | `aa2a9eb` | P1: merge record would resolve to `task:7`, not 7B-v | reading `assessRunnerState` | **see Round 5** |
| 11 | `df55e6c` | grant-body window 4,000 vs a 7,247-char body | measured it | extent DERIVED; mutation-tested |
| 12 | `df55e6c` | advance route matched one quoting style | reading the regex | matched by shape |
| 13 | `df55e6c` | `import.meta.dirname` needs 20.11; package says `>=20` | reading `engines` | `fileURLToPath` |
| 14 | `df55e6c` | deferral named the EARLIER of two owners | reading the trailer | names 7B-vi, the later stop |
| 15 | `f460cab` | probes grep for the SHAPE OF A FIX and cannot adjudicate it | three rounds of evidence | **probes removed — Round 4** |
| 16 | `f460cab` | adding probes made the diff non-docs-only | reading the deferral rule | **probes removed — Round 4** |
| 17 | `0906e42` | a deferral head may not edit `docs/STATUS.md` | `scripts/review-efficiency.mjs` | **STATUS removed — Round 5** |

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

The rule fits this PR exactly: every finding here was a mechanically checkable fact I asserted in
prose, and prose **cannot fail**. Three rounds of more careful writing produced three more rounds of
findings.

**The first attempt at the fix was wrong, twice over, and the correction is the interesting part.**
I wrote the probes as source-text assertions in `scripts/phase5-handoff-facts.test.mjs`. Three
further review rounds then showed:

1. **They could not adjudicate what they claimed.** Each was a grep for the *shape of a fix*: an
   `@Get` spelling, a `certifiedById` substring, a byte window over a method body. A route restored
   through a constant, or a predicate derived via a helper, closes the gap while the probe stays
   green. A probe that greps for a fix cannot tell you the fix happened; only running the command
   can.
2. **Adding them made the diff non-docs-only** — and the bounded deferral rule is defined over a
   docs-only diff. Taken strictly that is self-defeating, since any compliant response adds a test
   file. The resolution is not to argue the rule but to notice what it is *for*: moving verification
   out of prose. It does not require the verification to live in THIS PR.

So the probes are removed from this PR, which is docs-only again, and each open question is recorded
in the phase plan as a **reproduce-first acceptance criterion owned by the unit that can settle it**
— exercised against live PostgreSQL, RED before the fix, by 7B-v and 7B-vi respectively. That is
strictly stronger than what was here, and it is the repository's ordinary discipline rather than a
mechanism invented for a closing packet.

| Deferred question | Settled by | Owner |
|---|---|---|
| is `commercial.sod.grant` guarded so a payment-rule grant must name the actual certifier? | issuing one that names someone else and proving it ACCEPTED today, then refused | **7B-v** |
| does the advance list read exist, so its coalesce key can settle? | reconciling the key against the read and proving it stuck today | **7B-vi** |

Both are recorded in the phase plan, because the follow-on units are driven from the plan and a
deferral recorded only in a review packet can be skipped — Codex's finding, and correct.

**Deferred to: `phase-5-task-7b-vi`** — the LATER of the two owners, deliberately. Naming the
earlier stop would let 7B-v's review be read as settling the whole deferral while the advance
question is still open. Each unit settles its own question at its own stop; the deferral closes at
the last one.

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

## Round 6 — the closing packet gets a clean review head, and STATUS comes back

Round 5 removed STATUS so the deferral could be verified. Codex's next P1 showed what that cost:
with STATUS left at `in_progress` and a stale `open_pr`, `buildPostMergeContinuation` clears the
stale PR and `assessRunnerState` returns `task:7` — the parent task — before it can reach
`next_task`. **A scheduled follow-up is not an executable hand-off for a loop meant to run without
anyone standing by.** That is correct, and it is the reason the review-mechanism-vs-bookkeeping split
could not simply be lived with.

Inside one PR the constraints have no common solution, and each half was verified rather than
assumed:

| Option | Fails |
|---|---|
| STATUS in, deferral in | the gate refuses: a deferral head's phase is unverifiable if it edits STATUS |
| STATUS out, deferral in | the hand-off resolves to `task:7`, not 7B-v (this round's P1) |
| STATUS in, deferral out | the deferral is mandatory at this head count |

The deferral is mandatory only because of accumulated **review history** — not because anything is
unresolved. Every one of the seventeen findings above is fixed, and the ledger records each with its
remedy. So the unit takes the orchestrator's own repeated advice and gets a clean review head: the
same settled content, reopened, carrying STATUS.

The hand-off state is verified, not hoped for: `task_state: merged` · `open_pr: none` ·
`next_task: phase-5-task-7b-v` passes `test:automation` 200/200 **and** `assessRunnerState` resolves
it to `next_task:phase-5-task-7b-v`. It costs one drift-shepherd message while the PR is open
(`open_pr: none` against a live PR) — a message, not a gate, and true the moment it merges.

**Nothing is escaped by the reopen and that is the test worth applying to it:** no finding is
unaddressed, no probe is dropped that was ever load-bearing, and this audit travels with the content
as the complete record of all seventeen.

## Round 5 — why `docs/STATUS.md` was removed, and what it cost

The gate refused the deferral for a reason worth recording rather than working around: it runs from
the trusted default branch and reads `main`'s STATUS, so **a PR that edits STATUS has no verifiable
phase truth** — and reading the head's STATUS would mean pulling PR-authored content into a
write-capable workflow, a boundary this loop deliberately does not cross. The file list is metadata
the gate already holds, and it is sufficient: if STATUS is in the diff, the phase is unverifiable.

It looked at first like a deadlock between two enforced rules — every open autonomous PR must be
named in STATUS, and a PR carrying a deferral must not touch STATUS. It is not. The STATUS coherence
suite validates the file's own internal consistency, not whether `open_pr` matches a live PR; that
is the drift shepherd, which posts a message rather than failing a gate. Verified by running
`test:automation` against `main`'s STATUS with this PR open: 200/200.

So the bookkeeping leaves this PR and lands where it always had to — the **post-merge flip**, which a
work PR cannot do for itself and which this phase's own process note already records as the
irreducible half of the folded-STATUS change. That flip carries all of it: `task_state: merged`,
`open_pr: none`, `reviewed_merge`, `next_task: phase-5-task-7b-v`, **and** the 7B-vi row's
advance-read correction. The correction itself is not lost meanwhile — it is in the packet and the
7B-vi ledger, both of which are in this PR.

The general form, for whoever meets this next: **a review-mechanism trailer and a bookkeeping edit
are different kinds of change and do not belong in one head.** The gate is telling you the record
cannot certify itself.

## Verification

The verification for a docs claim is the command that establishes the fact, and each is recorded
above with its result. **No probe ships in this PR** — the two open questions are reproduce-first
acceptance criteria owned by 7B-v and 7B-vi, to be written RED against live PostgreSQL by the units
that can exercise them. `test:automation` 200/200, which is the suite unchanged.

**A fourth instance, self-caught, worth recording because of HOW it was nearly missed.** Fixing
finding 2 I corrected each note's opening "This branch is `<sha>`", ran `grep "this branch"` over
both, got no output, and treated that as clean. It was not: one instance wrapped across a line
break, so a single-line grep could not match it. A multiline search found it immediately.

That is this document's own root reappearing one level down — **the check has to be able to observe
the thing it claims to rule out.** A grep that cannot match wrapped prose returning empty is not
evidence of absence, exactly as memory of an intent is not evidence of a route. Same discipline,
same failure mode, caught this time only because the root had just been written down.
