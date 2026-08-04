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
