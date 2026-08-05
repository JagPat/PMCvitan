# PR #284 convergence audit — Phase 5 Task 5C

Four finding-bearing heads: `0e9de59` (six), `7c16afd` (eight), then rounds 3
(four) and 4 (three) on the split design. This audit is due because the second
head crossed the threshold; it was written before the third head rather than
after it, and has been carried forward since.

| Round | Findings | P1 | Root |
| --- | --- | --- | --- |
| 1 | 6 | 2 | A ×2, plus four one-offs |
| 2 | 8 | 1 | A ×2, B ×2, four retired by the split |
| 3 | 4 | 0 | A ×4 — all "locked one side, not the other" |
| 4 | 3 | 0 | A ×3 — all "enforced at insert, not at commit" |

The count and the severity are both falling, and no round has produced a root
that was not already named. What has kept root A alive is that each round found
it in a **dimension the previous closure did not cover**, which is what rounds 3
and 4 below are about.

## The signal, stated plainly

Round 2 returned MORE findings than round 1, and four of the eight were on code
round 1 had just added. That is the same signature that ended PR #279 — "each
correction adds review surface faster than review retires it" — and the standing
instruction at that point is to escalate rather than push another head. I did,
and the owner chose to split.

Two of round 2's findings were about my own EVIDENCE, and checking them found the
problem was wider than the reviewer said.

## Root A — a rule reaching the artifact it creates, not the sibling already there

Named before this task, and it produced four findings across the two rounds.

| Head | Instance |
| --- | --- |
| R1 F1 | widened the DB arrow `paid → verified`; left the service guard at `=== 'certified'` |
| R1 F4 → R2 | locked the certificate in the withholding bound; left the release bound counting without a lock |
| R2 | guarded ENTERING `paid` with the fold; left the reverse arrow unguarded |
| R2 | re-read the released total under the bill lock; left the restatement check outside it |

The pattern is sharper than "fix the set, not the member". In each case the fix
had a **twin one step away** — the other side of an arrow, the other end of a
lock, the other half of the same question — and I fixed the side the finding
pointed at. The closure is not another checklist: when a fix names a direction, a
side, or a half, the next thing to write down is what the opposite one is.

### Round 3 — the same root, in the LOCKING dimension

All four of round 3's findings were one physical shape: a plpgsql guard that
SELECTs a row, decides on what it read, and did not take `FOR UPDATE`. Round 1
fixed the withholding bound. Round 2 found its twin, the release bound. Round 3
found the liveness trigger — written in round 2, one function away from the lock
round 2 had just added.

Three rounds of finding twins by hand is the signal that the prose closure above
is not enough. Every other root in this module got a mechanical one, so root A
now has **CLOSURE 3** in `commercial.contract.test.ts`: every deciding guard in
the migration must be serialized. Writing it exposed two things worth recording.

**The rule has two halves, and my first draft had one.** It flagged the
withholding bound's FOLD — which is not a defect and could not be fixed as
stated, because PostgreSQL forbids `FOR UPDATE` with an aggregate. You cannot
lock a fold; you lock the row that SCOPES it. So a ROW read must carry the lock
itself, and a SET read must be PRECEDED by one. Naming one side of a distinction
and leaving the other implicit is root A operating on the closure to root A.

**The first version passed against the very defect it was written for.** With the
lock removed from the liveness trigger, CLOSURE 3 stayed green — because the
comment above that read explains the fix in prose and contains the words `SELECT`
and `FOR UPDATE`, so the statement match started inside the comment and found the
lock in its own explanation. Stripping comments before analysis is now part of
the pin, and the stripper checks its own assumption. That is root B, caught by
running the RED proof rather than trusting the green.

All three historical shapes are RED-proved against the pin: remove the lock from
the withholding bound, the release bound, or the liveness trigger, and it names
the offending function.

### Round 4 — the same root again, in the TIMING dimension

Round 4's three findings are one shape too, and it is a dimension CLOSURE 3 does
not reach: **a rule enforced at BEFORE INSERT but not at COMMIT, or in the
service but not in the database.**

| Finding | Shape |
| --- | --- |
| re-check deduction liveness at commit | insert-then-supersede in ONE transaction passes every insert-time check |
| seal restatement on replacement certificates | `restateDeductions` is service code; a bypass replacement drops the balance |
| constrain forged deduction restatements | the FK proves the source EXISTS; nothing proves it is a real re-statement |

A BEFORE INSERT trigger sees the world mid-transaction. What a transaction leaves
BEHIND is what a seal has to be about — and the third finding is the same
observation about place rather than time.

The forged-restatement finding is the sharpest of the three, because the damage
runs the opposite way from everything else in this task: a forged row naming an
unrelated still-live withholding as its source **freezes that withholding**,
since a re-stated deduction can never be released. Every other seal here stops
money leaving; this one stops money being trapped.

**CLOSURE 4** covers the timing dimension: every insert-time guard that decides
on another table's rows must DECLARE a commit-time twin, the twin must be wired
as a deferred constraint trigger on the same table, and it must re-read the same
foreign state. The twin is declared rather than inferred deliberately — "the
table has some deferred trigger" is not a closure, because `BillDeduction`
already had two and the hole was still open. It is RED-proved both ways: unwire
the twin, or stop it re-reading the certificate, and the pin names it.

## Root B — evidence asserted without checking that it discriminates

New, and mine.

Round 2 flagged two probes that would pass against the defect they claimed to
guard. Checking them found five more of the same shape:

- **five upgrade-proof assertions** referenced a certificate id the script never
  creates. Every one was rejected by a FOREIGN KEY before reaching the CHECK it
  named. They would have passed with every constraint dropped.
- **the concurrency probe** ran two independent transactions through
  `Promise.allSettled`, which does not force both to insert before either
  commits. Whichever committed first made its row visible and the second rejected
  sequentially — which the lock-free trigger also does.

I ran both and saw them pass, and reported them as evidence. Running a probe is
not the same as proving it discriminates.

**The closure is mechanical and is applied in this head:**

1. every hostile-insert group ACCEPTS a coherent row first, in the same fixture
   state, so a rejection that comes from the wrong rule shows up immediately —
   this is what caught the five vacuous assertions when I rewrote them;
2. every concurrency probe holds both writers open until both have written, then
   releases them, and is RED-proved by removing the lock from a live database
   before being restored.

Both proofs were run for this head: with `FOR UPDATE` stripped from the two bound
functions, PROBE 13 and PROBE 14 fail; restored, 17/17 pass.

The owner has asked for the same audit across every phase's upgrade-proof
assertions, since this is a class of defect that leaves no trace when it is
wrong. It is recorded in the STATUS maintenance queue as its own item.

## What the split changed

The §F status derivation and its three seal widenings leave 5C for Task 6, where
`APPROVED` and `PAID` — two of the three folds it reads — actually arrive.

That retires three of round 2's eight findings outright rather than fixing them,
because the code they were about no longer exists here. It also removes the
widenings of unit A's seals entirely: 5C now touches none of them.

The intermediate state is strictly stricter than the finished rule. A deduction
moves `NET_PAYABLE` and §J's `certified-payable`; the stored bill status does not
move at all, so there is no transition to be wrong about, and the "stranded with
no row that can advance it" case cannot arise because the rows that would advance
it are Task 6's too.

**The reason this was not seen at planning time is worth recording.** §H says the
insertion re-derives the status, so I implemented it. What §H does not say — and
what only shows up in the code — is that §F's derivation reads three folds, two
of which do not exist until Task 6. Deriving from one fold made `paid` reachable,
which forced the seal widenings, which needed fold-backed guards, which needed
guards of their own. The plan's task boundary was right and the section boundary
cut across it.

## A postscript, and it belongs to root B

The head that carried the split — `1faa7e8` — left the review packet describing
the design the split had just removed. It still listed the §F derivation and the
two seal widenings among the things this change ships, and its invariant matrix
cited a RED proof for widenings that no longer exist.

That is root B again, one level up. The packet is evidence: it is what a reviewer
reads to know what was checked and how. A packet that overstates what a change
does reads as verified where nothing was verified, in exactly the way an
assertion rejected by the wrong rule does. I corrected it in the following head
rather than leaving it to be found.

The generalisation worth keeping: **when a change removes something, the removal
is not finished until the documents that claimed it are corrected too.** Code and
tests fail loudly when they go stale; prose does not.

## Root B, twice more — and the closure caught both

Writing the round-4 evidence turned up two further vacuous assertions, and both
were caught by the accept-first guard round 2 produced rather than by a reviewer.

- the re-statement block assumed a live certificate stood where none did. Two
  "rejections" above the guard had already printed `ok` — rejected by a foreign
  key on an empty id, not by the rules they named. The block now walks its own
  bill through the lifecycle and asserts the state it depends on.
- the different-amount forgery named a deduction on ANOTHER BILL, so the scope
  rule refused it before the terms rule was ever reached. It now has a source
  that reaches the rule it is about.

Worth stating plainly: **the closure works, and it works by making the fixture
fail loudly rather than by making me more careful.** Both of these would have
read as green.

A third instance was in the closure itself. CLOSURE 3's first version stayed green
with the lock removed, because the comment above that read explains the fix in
prose and contains the words `SELECT` and `FOR UPDATE`. The pin found the lock in
its own explanation. Running the RED proof is what surfaced it — which is the
whole of root B in one sentence: **a probe you have only seen pass is not
evidence.**

## Findings carried into this head

| Round 2 finding | Disposition |
| --- | --- |
| re-check restatement after the bill lock | FIXED — both halves re-read inside the lock |
| serialize the release bound | FIXED — `FOR UPDATE` on the deduction, RED-proved |
| derive status after restating | RETIRED by the split |
| guard `paid → certified` with the fold | RETIRED by the split |
| reject deductions on superseded certificates | FIXED — BEFORE INSERT trigger, with a probe |
| seal status derivation on ledger commits | RETIRED by the split |
| point the upgrade proof at a certified bill | FIXED — the block is anchored where a live certificate stands, and four more vacuous assertions beside it were found and fixed |
| add a barrier to the concurrency probe | FIXED — real barrier, RED-proved both ways |

## An operational error of mine, recorded because it cost a head

The round-4 head's PR body still described the pre-split design. That is the
postscript's own defect — prose that went stale when the code changed — so I
rewrote it, and in rewriting it I dropped the `<!-- review-size: justified-large -->`
marker. `review-scope` failed, `quality-gate` cascaded, and the head was blocked.

I then re-ran that run's failed jobs, which could never have worked:
`review-scope` reads `GITHUB_EVENT_PATH`, the event payload frozen when the run
was created, so a re-run replays the same marker-less body. The body edit had
already spawned a correct run two minutes earlier.

Worse, the failure is not recoverable on that SHA at all. `attemptOf` groups
check runs by `check_suite.id`, and GitHub puts every run of a workflow on one
commit into a single suite, so all three runs are ONE attempt — and
`attemptsWithPassingGates` excludes an attempt whose gate failed *at any point*,
deliberately, so a later success cannot retroactively legitimise what the earlier
failure caused. Two subsequent runs went fully green and the aggregate stayed
red. The gate is behaving exactly as designed.

**Two things worth keeping.** A PR body is not commentary — it is a gate input,
and editing it is a build step with the same care as a commit. And when a check
reads frozen event state, re-running it re-reads the frozen state: the fix for a
bad payload is a new event, never a retry.

## Findings carried into the round-4 head

| Round 3 finding | Disposition |
| --- | --- |
| lock the certificate in the liveness trigger | FIXED, and closed mechanically by CLOSURE 3 |
| seal the restated-release rule at PostgreSQL | FIXED, with an accept-first pair |
| bind a ledger row to the command that produced it | FIXED — type at insert, status at commit |
| lock the source ledger during re-statement | FIXED — and PROBE 17 now proves the re-statement WAITS on an open release, which is stronger than the probe first claimed |

| Round 4 finding | Disposition |
| --- | --- |
| re-check deduction liveness at commit | FIXED — `BillDeduction_coherent`, deferred; PROBE 18 |
| seal restatement on replacement certificates | FIXED — `BillCertificate_replacement_restates`, deferred; PROBE 20 |
| constrain forged deduction restatements | FIXED — scope, source liveness and terms; PROBE 19 |

Two of round 3's fixes changed what a valid probe looks like, and both were
caught by the suite rather than assumed:

- the insert-time certificate lock means two `BillDeduction` inserts now
  serialize AT INSERT, so the old hold-both-open barrier deadlocks against the
  lock the fix installed. PROBE 13 now proves the second writer **blocks** —
  verified through `pg_blocking_pids`, never a sleep — and is then refused.
- the release's foreign key holds a KEY SHARE lock on the deduction, which
  conflicts with the re-statement's `FOR UPDATE`. So the re-statement genuinely
  waits for an open release and carries the reduced balance, rather than racing
  it. PROBE 17 asserts the wait and the conserved arithmetic.

## Round 5 — the split

Four findings, all P2, all confirmed against the code:

| Finding | Disposition |
| --- | --- |
| label supersession-raised exceptions distinctly | DISSOLVED by the split — see below |
| require carried releases, not just a carried deduction | LEAVES with re-statement |
| bind ledger commands to the row they produced | FIXED here — `resultRef` IS the row, both tables |
| preserve restated ledger evidence fields | LEAVES with re-statement |

Three of the four landed on seals rounds 3 and 4 had just added, which was the
third consecutive round where findings arrived on the previous round's new code.
The orchestrator's own state comment reported the unit at five finding-bearing
heads — its stated limit — and recommended splitting.

Two of the four are the same shape, and it is a shape this document had already
named one head earlier: *when a fix names a direction, a side, or a half, write
down what the opposite one is.* The carried-releases finding is the deduction
half sealed without the release half. The evidence-fields finding is two fields
of a copy checked out of five. That closure was written as prose, and prose did
not change the behaviour it described — the same author wrote the same defect
twice in the head that recorded the lesson.

Both instances live in the re-statement machinery, and so does the third round-4
finding before them. That is the actual signal: not four independent slips, but
one mechanism whose faithful-copy rule needs more care than a paragraph in a
review packet. It earns its own review unit.

### What the split is

§H's rule is that a retained balance never vanishes without an attributable
release. Two mechanisms honour it:

1. CARRY the ledger onto the replacement certificate (re-statement).
2. REFUSE the correction until the money is given back attributably.

This PR now does (2). Re-statement — carrying both row kinds together, sealing
that the copy is faithful in every evidence-bearing field, keeping a source row
releasable exactly once — becomes a follow-up unit.

The refusal is STRICTER than re-statement: every state it permits, re-statement
permits too, and it permits no act re-statement would refuse. That is the
criterion that made splitting Task 5B safe, and it is why this is a split and
not a gap. The practice's path is unchanged in substance — release the
withholding, then correct the certificate — and the release is the attributable
act §H wanted either way.

The cost is stated plainly: until the follow-up lands, a certificate carrying
unreleased money cannot be corrected in place.

### Why finding 1 dissolves rather than being fixed

The finding was that `supersede()` reports a `claim` mover while a deduction's
withheld fold disappears. With supersession refused while an unreleased
withholding stands, the withheld fold is necessarily ZERO at supersession, so
the only money moving is the claim leaving `certified-payable`. `claim` is then
the accurate label, and a deduction-shaped mover would name an act that cannot
occur. This is recorded rather than silently dropped, because "the finding no
longer applies" is a claim a reviewer should be able to check: PROBE 8 pins the
refusal and PROBE 19 pins it at PostgreSQL.

### CLOSURE 5 — a copy is checked field by field, or it is not checked

Not adopted here, because the machinery it would govern is leaving. It is
recorded as the entry condition for the follow-up unit: any rule that copies a
row forward states the COMPLETE field list it preserves, and a test enumerates
that list against the table's columns so a new column fails the test rather than
silently escaping the copy. Three findings across two rounds came from checking
a subset; the next unit does not get to rediscover that.

### The PR-body gate, twice

The round-5 head was blocked by `review-scope` before Codex saw it: the rewritten
body dropped the `<!-- review-size: justified-large -->` marker. The PREVIOUS
head was blocked by the same gate, for a different missing element, and that
head's commit message was *"Convergence: record the PR-body gate error that
blocked the last head."*

So this is the same lesson landing twice, and recording it a second time in prose
would be the exact mistake this round is about. The mechanical closure:

**CLOSURE 6 — the PR body is an artifact with a contract, and the contract is
executable.** `scripts/review-efficiency.mjs` already states every requirement:
the marker must be the FIRST thing in the body (`^` against `body.trimStart()`),
and all six `REQUIRED_INVARIANTS` need a row with two non-empty cells. Rewriting
the body means re-satisfying that contract, not re-remembering it — run the
checker against the drafted body before pushing, exactly as any other test is run
before pushing. A body rewritten from scratch loses whatever was not re-derived,
and both blocks were bodies rewritten from scratch.

The very next head proved the closure's own scope was too narrow. The gate then
rejected the commit MESSAGE: `Review-Convergence: complete` was present, but in
its own paragraph, so git parsed only the final `Co-Authored-By` block as
trailers and the marker was invisible. Same failure mode as the PR body — an
artifact with a machine contract, satisfied by eye instead of by the machine —
so CLOSURE 6 is stated for the class rather than the instance:

**every artifact with a machine-readable contract is verified with the machine
that reads it, before the push.** The PR body against
`scripts/review-efficiency.mjs`; the commit message against
`git interpret-trailers --parse`. Not "I wrote the marker" but "the parser
returned it".

## Round 6 — a lock justified by a caller the seal exists to bypass

One finding: the deferred supersession seal took `VendorBill` `FOR UPDATE`,
inverting the honest bill → certificate order. Real, and it reproduces as
PostgreSQL `40P01`.

The comment justifying that lock said: *"`supersede` already holds `lockBill`, so
the seal adds no new lock order."* That sentence is true. It is true **of the
service path** — and this seal is a DEFERRED constraint trigger, which exists
precisely for the writer that did not come through the service. So the lock
discipline of a DB seal was justified by the behaviour of the caller the seal was
written to catch.

That is a root worth naming on its own, because it is not root A's twin-one-step-
away and it is not root B's non-discriminating evidence:

**Root C — a database seal justified by application behaviour.** A seal's premise
may only cite what the DATABASE guarantees: row locks the firing statement itself
takes, constraints, other triggers. The moment a seal's correctness argument
contains the name of a service function, the argument is about the path that does
not need the seal. The closure is mechanical: any lock or ordering claim written
inside a trigger must be justifiable with the service layer deleted from the
picture.

Applied here, the corrected justification cites only database facts — the firing
`UPDATE` holds `FOR NO KEY UPDATE` on the certificate row to end of transaction,
and the counterpart `BillDeduction_targets_live` takes `FOR UPDATE` on that same
row — and those two conflict, so neither writer can pass the other.

### The part I got wrong, and what caught it

I removed the lock on the argument that it "bought no serialization", and pushed
that argument as a finished head. `commercial.contract.test.ts` — a pin written
in this PR, at root A — went red: *"a guard decides on state it did not serialize
— two concurrent writers can each pass it."*

The pin was right to fire. My reasoning happened to be correct, but I had shipped
it as prose, and prose is exactly what this PR has spent six rounds learning not
to accept. **A claim that a lock is redundant is a claim about concurrent
executions, and it is worth what an experiment says it is worth.** PROBE 21 now
pins the block in both directions and goes RED when the counterpart trigger is
disabled; the removal is justified by that, not by the paragraph above it.

The pin was also not weakened to let the head pass. `SERIALIZED_BY_THE_FIRING_ROW`
names one function with its counterpart and its probe, because a general
"folds scoped by `NEW."id"` are fine" rule would exempt future cases that have no
counterpart at all — a hole rather than an exemption — and the entry re-derives
its own premise so it fires again if the scoping disappears.

### What is NOT fixed, and why it is named instead

Removing the 5C lock does not remove the deadlock. The arm that closes the cycle
is `phase5_t5_certified_bound_check`, fired by 5B's deferred
`BillCertificate_bound_sealed` in the merged, independently cleared
`20270510000000_phase5_t5b_certification`. That lock is load-bearing — it folds
`VendorBillLine` across non-superseded versions, which the certificate row lock
does not cover — so removing it would trade a deadlock for an unserialized
bound-3 check.

This was established by instrumenting the live lock graph, not inferred: the
blocked side is the correction's `COMMIT`, and disabling the 5C seal entirely
still deadlocks. Under the residual a deadlock aborts both sides and no money
moves, so what degrades is the error message, not the ledger. PROBE 20 therefore
pins conservation, which holds under either resolution, and deliberately does not
pin the error text, which does not.

Reopening a cleared 5B seal at a post-Task-5 review stop is a scope decision, not
a defect fix. It is named here and in the migration so the next unit inherits it
knowingly.

### CLOSURE 6, a third time — and the machine I still did not run

Round 5 recorded CLOSURE 6 for the PR body, then immediately re-recorded it for
the commit message: *every artifact with a machine-readable contract is verified
with the machine that reads it, before the push.*

This head satisfied that for the commit message — `git interpret-trailers --parse`
was run, and the trailer was confirmed present rather than assumed. Then the head
was blocked anyway, by the convergence gate, for the packet: `assessConvergence`
requires THIS head's commit to CHANGE a file matching
`docs/reviews/[^/]*convergence[^/]*\.md`. The file existed. I had read its name in
the packet and treated "it exists" as "the requirement is met" — which is
precisely satisfying a machine contract by eye.

So the closure holds and my application of it was partial: I ran the machine for
the artifact I remembered had one, and not for the artifact whose contract I had
not read. The mechanical form, stated so it does not need remembering: **before a
push, the gate's own predicates are evaluated against the head — the trailer via
`git interpret-trailers --parse`, and the changed-file set via `git show --stat`
against `CONVERGENCE_PACKET`.** Both are one command. Neither is a judgement call.

## Round 7 — root B, in the upgrade proof

One P2, and it is root B exactly: **evidence asserted without checking that it
discriminates.**

The assertion named the superseded-certificate rule but cited `UP5C-CMD`, a
command bound to `UP5C-DED`. So the row was rejected for *provenance*, not for
liveness, and the line would have stayed green with the rule it names deleted.
The file states the correct discipline eight hundred lines above the defect —
*"every fixture below binds to the id of the row it is about to attempt"* — which
is the familiar shape: the rule was written down, and then not applied to a
fixture added later.

Verified rather than assumed, on the scratch database with BOTH liveness seals
disabled:

| fixture | what rejects it once the named rule is gone |
| --- | --- |
| old, cites `UP5C-CMD` | the provenance trigger — assertion still passes, proving nothing |
| new, cites `UP5C-CMD-LATE` | nothing; the row is ACCEPTED — assertion fails, as it should |

Two seals had to come off, not one: `BillDeduction_targets_live` (immediate) and
`BillDeduction_coherent` (deferred) both carry the rule, and with only the first
disabled the second still rejected — which is why the first attempt at this proof
looked green and had to be pushed further before it said anything.

### The twins, checked mechanically

Root A's standing lesson is that a finding names one instance and the twin is one
step away, so every ledger fixture in the file was audited by script rather than
by eye: each row's id against the `resultRef` of the command it cites. Four
mismatches, all four deliberate and correctly named — `UP5C-WT` (wrong command
type), `UP5C-PS` (a command that never succeeded), `UP5C-RWT` (a release citing a
record command), `UP5C-REUSE`/`UP5C-RREUSE` (reused receipts). Codex found the
only real instance.

### CLOSURE 7 — an assertion may name the rule that must reject it

Rebinding the fixture fixes the instance. The reason the instance was possible is
that `assert_rejects` accepted ANY rejection as proof of a NAMED rule, so every
one of its call sites has this failure mode latent.

`assert_rejects` now takes an optional third argument: an ERE the rejection
message must match, failing with *"rejected, but by the WRONG rule"* when it does
not. The superseded-certificate assertion uses it. Omitted, the check is exactly
the original, so this adds a capability without touching the other call sites.

The honest limit, stated because it matters: the reason-match does NOT by itself
prove discrimination. With the seal present, the correct rule rejects first and
the message matches either way — that is why the mis-bound fixture still passed
the reason check, and why the proof above had to disable the seals instead. The
argument narrows what an assertion accepts; only removing the rule shows what the
assertion is actually testing.
