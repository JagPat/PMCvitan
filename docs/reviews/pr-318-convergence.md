# PR #318 — convergence audit (Phase-5 closing packet)

**Eleven finding-bearing heads, twenty-four findings, on a closing packet** — eight heads as #318,
three more as its replacement #319, which carries the same content and this same audit. Written
because they are a small number of roots rather than twenty-four incidents, and because the roots
are worth more than any individual fix. The complete ledger, so the next unit inherits cause →
remedy → proof rather than a summary:

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
| 18 | `6c586c9` (#319) | the plan still said this head carries `Review-Deferred-To-Probes` | reading plan vs Round 6 table | restated as follow-on acceptance criteria |
| 19 | `a74526f` | STATUS's **7B-iv** row still listed the advances read among its contents | grep the claim | row states what actually merged |
| 20 | `a74526f` | the packet called 7B-v "which acts a browser offers" | its own §I contradicted it | 7B-v has a **server** half |
| 21 | `a74526f` | the criteria table named 2 probes; the ledgers list 7 open items | counting the ledgers | table completed + kept-complete rule |
| 22 | `c04209e` | packet still cited "the plan's deferred-probe row" after the plan renamed it | reading packet against plan | cites `grant-guard`; states why the distinction matters |
| 23 | `c04209e` | the verification paragraph still said "two open questions"; the table now has five | counting the plan table | names all five, with why the count matters |
| 24 | `c04209e` | §25 row claimed both §I rules "exercised in the browser chain" | the packet's own §I + the spec | separates ENFORCED from where each grant is ISSUED |
| — | `9279115` | the deferral deadlock recurred; Round 6's reopen had reset a counter, not solved it | the gate's own refusal text | **STATUS out + deferral in + a follow-up flip — Round 8** |

Findings 19–21 are the sharpest of the twenty-four, because each would have cost a following unit
real work rather than costing a reader accuracy: 7B-vi told the advance read already shipped, 7B-v
told its server guard was a UI concern, and both told a subset of their own parked findings. **A
hand-off that under-states scope is not a smaller error than one that over-states it.**

## Round 8 — the deadlock had a fourth option, and Round 6 reset a counter instead of taking it

The gate refused this head for the reason Round 6 described: three finding-bearing heads on a
docs-only diff make `Review-Deferred-To-Probes` mandatory, and a head carrying it may not edit
`docs/STATUS.md`. Round 6 met that by **opening a replacement PR**, which reset the finding-head
count. #319 then earned three heads of its own and arrived at the identical wall — which is the
evidence that the move was a delay, not a solution. A second reopen would have been a treadmill.

**Round 6's option table was incomplete, and that is the finding.** It listed three options and
judged each terminal:

| Option | Round 6's verdict | Actually |
|---|---|---|
| STATUS in, deferral in | gate refuses | correct |
| STATUS out, deferral in | hand-off resolves to `task:7` | **true only if STATUS never lands** |
| STATUS in, deferral out | deferral is mandatory | correct |

The second row treated "STATUS out" as a final state. It is a step. **STATUS out, deferral in, and
the STATUS flip lands on its own immediately after** closes the hand-off gap within one PR's
lifetime, and it is the option this repository's own gate names in the refusal it prints:

> Land the STATUS change on its own, or defer to a phase the current STATUS already shows has work
> ahead.

I had read the STATUS-versus-deferral conflict in `scripts/review-efficiency.mjs` and built the
option table from it. I had not read the sentence attached to it, which states the remedy. **The
constraint and its remedy live two lines apart; I took the constraint and constructed a dilemma out
of a rule that ships with its own way out.**

That is worth more than the fix. Reading a gate to learn *what it forbids* and reading it to learn
*what it wants instead* are different acts, and only the first is instinctive when the gate is in
the way. A refusal is not only an obstacle — it is usually the most precise statement anyone has
written of what the correct shape is.

**Recorded as a reversal rather than a rewrite**, the same way `pr-317-convergence.md` keeps
Round 4's wrong call: Round 6 below is left exactly as it was written. It was defensible on the
evidence then in hand and wrong on the next head, and a decision log that quietly deletes its wrong
calls teaches nothing. Round 6's *other* conclusion stands unchanged — the hand-off must be
executable, not merely scheduled. What changes is how that is achieved: two landings in sequence
rather than one PR that must satisfy two mutually exclusive rules.

The follow-up is not optional and is not "later": the STATUS flip to
`merged` · `open_pr: none` · `next_task: phase-5-task-7b-v` — the state Round 6 verified against
`test:automation` 200/200 and `assessRunnerState` — lands as its own head immediately after this one
merges. Until it does, the loop's hand-off still resolves to `task:7`, exactly as Round 6 found.

## Round 7 — the root has a sharper form: a correction updates the statement, not the references to it

All three of round 7's findings are one shape, and it is a *specialisation* of the root below
rather than a new one. Each is a *stale cross-reference left behind by a correction to the thing it
points at*:

| Finding | What was corrected | What still pointed at the old version |
|---|---|---|
| 22 | the plan section was RENAMED from a deferral to follow-on acceptance criteria (finding 18) | the packet header still cited "the plan's deferred-probe row" |
| 23 | the criteria table GREW from 2 rows to 5 (finding 21) | the verification paragraph still said "two open questions" |
| 24 | §I was corrected to say the form issues only the certification rule (finding 20) | the §25 acceptance table, two sections away, still claimed both rules were browser-exercised |

So every one of these was created *by* a fix in the immediately preceding round. That is worth
stating plainly: **rounds 6 and 7 were not independent lapses — round 7 is the wake of round 6.**
Finding 23 is the starkest, because it is finding 21's own correction leaving a stale count of the
table it had just completed.

The operational lesson is narrower and more useful than "check your claims", which this document
had already said and which did not prevent this:

> **After correcting a claim, grep for the OLD wording, not just the new one.**

Every round so far verified that the *replacement text* was true. None searched for what still
referred to the *replaced* text. Those are different searches, and only the second finds an orphaned
reference — the new wording is by construction absent from the places that were never updated.

That search was run before this round's fixes rather than after, over `docs/` for all three changed
things: the renamed section, the table's size, and the browser-issuance claim. It returned exactly
three live instances, matching the three findings and no fourth. The other hits were convergence
documents recording these events as history, which is what they are for and which stays correct —
so the sweep also had to distinguish a live claim from a historical record, and that distinction is
the reason the check could not simply be "grep and replace everywhere".

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

**At the time, the trailer named `phase-5-task-7b-vi`** — the LATER of the two owners, deliberately:
naming the earlier stop would have let 7B-v's review be read as settling the whole deferral while the
advance question was still open.

**That trailer is GONE from the replacement head, and deliberately so.** Round 6 restored
`docs/STATUS.md` to make the hand-off executable, and a head that edits STATUS may not carry a
deferral — the two are mutually exclusive. The questions did not disappear with the trailer: they are
recorded in the phase plan as ordinary follow-on acceptance criteria owned by 7B-v and 7B-vi, settled
at those units' own review stops. That is a weaker mechanism only in name; a reproduce-first probe
against live PostgreSQL is stronger evidence than a trailer.

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
above with its result. **No probe ships in this PR** — the open questions are reproduce-first
acceptance criteria owned by 7B-v and 7B-vi, to be written RED against live PostgreSQL by the units
that can exercise them. There are **five**, and the count matters because a reader who takes it as
two will treat the rest as already settled: `grant-guard`, `grant-spendability` and
`grant-conflict-set` for 7B-v — covering parked findings A, B, F1, F2 and F3 — and `advance-read`
and `advance-identity` for 7B-vi. The plan's table is the authority and is kept complete against
both parked ledgers. `test:automation` 200/200, which is the suite unchanged.

This head carries `Review-Deferred-To-Probes: phase-5-task-7b-vi` — the LATER of the two owning
stops, per finding 14, so nothing is treated as settled before both units have run. It does **not**
carry `docs/STATUS.md`; the flip lands on its own head immediately after this merges, for the reason
Round 8 records. Both halves of the deferral obligation are met: the trailer here, and the ledger in
the plan's follow-on table plus the two parked notes, which is where the units that owe the probes
are actually driven from.

**A fourth instance, self-caught, worth recording because of HOW it was nearly missed.** Fixing
finding 2 I corrected each note's opening "This branch is `<sha>`", ran `grep "this branch"` over
both, got no output, and treated that as clean. It was not: one instance wrapped across a line
break, so a single-line grep could not match it. A multiline search found it immediately.

That is this document's own root reappearing one level down — **the check has to be able to observe
the thing it claims to rule out.** A grep that cannot match wrapped prose returning empty is not
evidence of absence, exactly as memory of an intent is not evidence of a route. Same discipline,
same failure mode, caught this time only because the root had just been written down.
