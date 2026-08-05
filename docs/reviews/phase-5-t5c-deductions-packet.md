# Phase 5 Task 5C — §H's deduction ledger, releases, and the `NET_PAYABLE` floor

Base: `main` `0b87d85` (Task 5B complete: units A #280, B #281, C #282, and the
STATUS record #283).

## Vision alignment

Task 5B established what a vendor is OWED — the certificate, its frozen
evidence, and the segregation rule around who may sign it. This task establishes
what is actually PAYABLE, which in construction is rarely the same number.
Retention is withheld against a defects liability period; a penalty is applied
for delay; something else is deducted and everyone needs to know why. A practice
that cannot record those against a certification records them in a spreadsheet,
and the certificate stops being the authority.

§H's shape is one sentence: **a deduction is a ledger row against a
certification, never a column on it**, and the retained balance is a fold with no
stored column — the Phase-3 §C rule that produced a correct stock model.

This is the last increment of Task 5. When it merges, the plan's post-Task-5
review stop applies with payment authority fully in place.

## What is in it

1. **`BillDeduction`** (`retention`, `penalty`, `other`) and
   **`BillDeductionRelease`** — both append-only at PostgreSQL, both strictly
   positive, the row TYPE carrying direction.
2. **§H's two bounds**, re-derived under the bill lock and sealed at commit: the
   `NET_PAYABLE` floor of zero, and a release bounded by its own deduction.
3. **The first real subtraction into §J's `certified-payable`** — the term unit C
   shipped with both of its subtractions as the identity.
4. **A certificate that still holds money is not correctable in place** — the
   §H rule that a retained balance never vanishes without an attributable
   release, honoured by REFUSING the supersession rather than carrying the ledger
   forward. Re-statement is a follow-up review unit; see §"Round 5" for why, and
   for what that costs.

It ships NO §F status derivation and touches NONE of unit A's seals — see the
next section, which is the part of this change most worth a reviewer's attention.

`advance-recovery` is deliberately NOT in the type set. It folds against an
`advance` row created when the advance is PAID, so the enum member arrives in
Task 6 with the row that caps it. §0b's "every declared member is in the fold"
then holds at both stages rather than being briefly false.

## What this task deliberately does NOT do

§H says a deduction insertion RE-DERIVES the §F payment status. **That derivation
is not here, and its absence is a scope decision the owner took after round 2.**

§F derives the status from THREE folds — `NET_PAYABLE`, `APPROVED`, `PAID` — and
two of them are Task 6's. Deriving from one fold while the others were
structurally zero made `paid` reachable at this tree, which required widening
three seals Task 5B unit A wrote when `certified` was a claim's terminal status.
Each widening then needed its own fold-backed guard, and the guards needed
guards. Round 2 returned eight findings, four of them on code round 1 had just
added.

So the derivation lands in Task 6, beside the approval and payment rows that
supply its other two folds. **5C now touches none of unit A's seals.**

Until Task 6, a deduction moves `NET_PAYABLE` and §J's `certified-payable`, and
the stored bill status does not move at all. That intermediate state is strictly
stricter than the finished rule — there is no transition to be wrong about — and
a bill cannot be stranded in a state no legal row can leave, because the rows
that would leave it are Task 6's as well. PROBE 4 pins the half-step explicitly,
so Task 6 changes it knowingly rather than discovering it.

The convergence audit is `docs/reviews/pr-284-convergence.md`.

## Why the floor is on the deduction

§H is explicit, and it is worth restating because the alternative looks
reasonable. Positive rows plus §G bound 4 still admit a ₹150 penalty against a
₹100 certificate: every row is positive so the CHECKs pass, and bound 4 only
stops a later APPROVAL from exceeding `NET_PAYABLE` — which a negative number
satisfies trivially. −₹50 then flows into §F's status derivation and §J's
forecast as negative payable money.

Phase 5 models a deduction as a WITHHOLDING against a payable, not a receivable
or a credit note, so there is nothing beyond the certificate to withhold FROM.
The refusal sits on the write that would break the invariant, and it names the
remaining balance, because a message that only says "too much" leaves the
practice guessing.

## Codex round 1 — six findings, all correct, all fixed forward

The head `0e9de59` drew six findings. Every one was right, and two of them were
the same root this phase has now named several times: **a rule reaching the
artifact it creates but not the sibling already there.**

| # | Finding | Fix |
| --- | --- | --- |
| F1 (P1) | supersession unreachable after a full withholding — the DB arrow `paid → verified` was opened, the service guard still read `status === 'certified'` | the guard names the SET (`isPastCertification`, stated once in shared and mirrored by `phase5_t5c_past_certification()` in SQL) and the CAS transitions from whatever the row says |
| F2 (P1) | retained balances vanished on supersession — the plan REQUIRES re-statement onto the replacement | `certify` carries the superseded certificate's live ledger forward, deductions AND their releases together, with a UNIQUE `restatedFromId` audit chain; the superseded rows survive as history |
| F3 (P2) | `certified → paid` accepted any live certificate, so bypass SQL could settle an ordinary ₹100 payable | a `paid` shadow rule asking the FOLD (`phase5_t5c_net_payable`), beside the existing `verified`/`certified` shadow rules |
| F4 (P2) | the withholding trigger COUNTED without serializing — two bypass writers each saw only their own row | `FOR UPDATE` on the certificate before the fold |
| F5 (P2) | the migration was not safe to re-run after a partial apply | `IF NOT EXISTS` throughout and guarded `ADD CONSTRAINT` blocks, the repo's established pattern |
| F6 (P2) | a release-raised exception was labelled `raisedBy = 'claim'` | `deduction` and `deduction_release` movers threaded through `evaluateHeadsForBill`, with the DB CHECK widened to match |

**F2 is the one I should have caught, and its lesson is specific.** The plan says
in as many words that supersession re-states the deductions and their releases,
and that dropping them makes a retained balance vanish with no release. PROBE 8
asserted the dropping as correct. The deferral ledger's rule is that a task PR
carries its section forward rather than re-deriving it — I re-derived, and got
the opposite answer.

> **Superseded by the round-5 split — read §"Round 5" below before this row.**
> F2's *defect* (a retained balance vanishing with no attributable release) is
> still fixed and still sealed at PostgreSQL. What changed is the MECHANISM: the
> re-statement machinery described here has been split into its own review unit,
> and this PR now honours the same rule by REFUSING the correction until the
> money is given back. The rows below that describe re-statement seals
> (`BillCertificate_replacement_restates`, the `restatedFromId` rules, PROBES
> 8b/8c/17/19/20) are history, not current behaviour.

## Round 5 — the split, and what it costs

Round 5 returned four findings on `1b6ba60`, all P2, all correct. Three of them
landed on seals rounds 3 and 4 had just added — the third consecutive round where
findings arrived on the previous round's new code — and the orchestrator reported
the unit at five finding-bearing heads, its stated limit, recommending a split.

| # | Finding | Disposition |
| --- | --- | --- |
| 1 | supersession-raised exceptions labelled `claim` | DISSOLVED — with a live withholding refused, the withheld fold is zero at supersession, so `claim` is the accurate label and no deduction-shaped mover can apply |
| 2 | the replacement seal required a carried deduction but not its carried releases | LEAVES with re-statement |
| 3 | the provenance seal checked the command's status but never bound it to the row | FIXED HERE |
| 4 | the restatement terms check compared two fields of a copy, not all of them | LEAVES with re-statement |

Findings 2 and 4 are the same shape, and it is the shape the convergence document
had named one head earlier: *when a fix names a direction, a side, or a half,
write down what the opposite one is.* One sealed the deduction half without the
release half; the other checked two fields of a copy out of five. Both were
written by the author who had just recorded that lesson as prose, which is the
evidence that prose was not enough — and both live in the re-statement machinery,
as did one of round 4's three.

That is the signal the split acts on: not four independent slips, but one
mechanism whose faithful-copy rule needs its own review unit.

### What §H requires, and the two ways to honour it

A retained balance never vanishes without an attributable release. Either:

1. CARRY the ledger onto the replacement certificate (re-statement), or
2. REFUSE the correction until the money is given back attributably.

This PR does (2). `supersede` refuses while any withholding still holds money,
naming the row and the balance, and `phase5_t5c_supersede_needs_release` refuses
the same thing at COMMIT for anything that never came through the service.

**The refusal is strictly stricter than re-statement**: every state it permits,
re-statement permits too, and it permits no act re-statement would refuse. That
is the criterion that made splitting Task 5B safe, and it is what makes this a
split rather than a gap.

**The cost, stated plainly:** until the follow-up unit lands, a practice
correcting a certificate that still holds money must release the withholding
first. That release is the attributable act §H wanted either way — the money is
never silently dropped — but it is one extra step the finished design will not
require.

### Finding 3, fixed here

The provenance seal checked `CommandExecution.status` and never bound the command
to the row. A type check is satisfied by EVERY prior command of that type, so a
direct writer could reuse one succeeded `commercial.deduction.record` receipt to
append a second, third, fourth withholding, and the append-only ledger would
permanently attribute money movement to an act that produced none of it.

The seal now compares `resultRef` to the row. The rule is ONE sentence for both
tables — `resultRef` IS the row — which is why `release()` now answers with the
release row rather than the deduction it belongs to; the DTO is still the
deduction, resolved through that row. Row ids are unique, so a reused receipt is
unrepresentable with no extra constraint holding it up.

This also corrected the probes: `mintCommand` now requires the caller to say
which row the command produced. The default it had before would have made every
hostile insert in the file fail on provenance instead of the rule it names —
the vacuous-assertion shape round 2 found in the upgrade proof, arriving from the
other direction.

## Codex rounds 3 and 4 — the same root, in two dimensions the closures did not reach

Round 3 returned four findings, round 4 three, none above P2. Every one of the
seven was root A, and each round found it somewhere the previous closure could
not see.

| Round | Finding | Fix |
| --- | --- | --- |
| 3 | the liveness trigger read the certificate without `FOR UPDATE` | the lock, plus **CLOSURE 3** — a mechanical pin that every deciding guard is serialized, RED-proved against all three historical shapes |
| 3 | a release could land on a re-stated deduction at PostgreSQL | the seal appended to the release bound, with an accept-first pair |
| 3 | a ledger row could cite any command | provenance split by when it is knowable — TYPE at insert, STATUS at commit |
| 3 | `restateDeductions` read the source ledger without locking it | `FOR UPDATE` in ascending id order, with a barrier probe |
| 4 | liveness was insert-time only | a deferred commit-time seal: insert-then-supersede in ONE transaction is refused |
| 4 | the re-statement was required only by the service | `BillCertificate_replacement_restates` — a replacement carrying an unreleased withholding it does not re-state is refused at commit |
| 4 | `restatedFromId` was FK-checked only for existence | same bill, different certificate, superseded source, identical terms — and the release side of the same rule |

**The forged-restatement finding is worth naming separately**, because its damage
runs the opposite way from every other seal in this task. `release()` refuses any
deduction that has been re-stated, so a forged row naming an unrelated
**still-live** withholding as its source freezes that withholding permanently.
Everything else here stops money leaving; this one stops money being trapped.

Round 4's shape — a rule enforced at INSERT but not at COMMIT, or in the SERVICE
but not in the DATABASE — now has **CLOSURE 4**: an insert-time guard that
decides on another table's rows must declare a commit-time twin, wired as a
deferred constraint trigger on the same table and re-reading the same state. Both
closures are RED-proved by breaking them, not by observing them pass.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | two new commands and one read; a deduction reaches money, so its authority must not be inherited from certification | `commercial.deduct` / `commercial.deduct.release` declared separately (same list today, so a later widening of one cannot widen the other); every fold and route is project-scoped; contract test pins each command to its `executeCommand` site and each query to its route |
| civil-time-lifecycle | a withholding must not move the claim through a lifecycle this task does not own | the §F derivation is DEFERRED to Task 6 and 5C touches none of unit A's seals; PROBE 4 pins that the status deliberately stays `certified`; the certification suite is 49/49 with its R1-F2 probe restored to unit A's original message |
| concurrency-idempotency | two concurrent withholdings must not each see room for themselves | both bounds re-derived INSIDE the bill lock, after `lockProjectReadiness` and `lockBill` (§0b's order); the release re-reads its deduction inside the lock; PROBE 10 proves a keyed replay of either write appends nothing |
| data-integrity-conservation | a withholding that could be edited never withheld anything; a negative one RAISES the payable | append-only triggers on both tables (PROBE 6); `amount > 0` at PG and in the service (PROBE 2); both bounds sealed at COMMIT and proven by hostile insert; PROBE 8 proves supersession takes deductions out of every fold while keeping them as history |
| offline-reconciliation | not applicable — no client surface (§M frontend is Task 7) | — |
| ui-server-parity | the DTO gains a ledger and a `netPayable`; no UI consumes it yet | `pnpm check` web 543/543 |

## Evidence

`apps/api/test/integration/phase5-t5c-deductions.test.ts` — **22/22 GREEN**
(22 before the split: the three re-statement probes left with the mechanism, and
two probes were added for the refusal and its DB seal; round 6 added PROBE 20 and
PROBE 21).

Every probe is RED at `0b87d85` for the trivial reason that the ledger does not
exist there, so this packet does not lean on that. What it leans on instead is
that each probe was shown to DISCRIMINATE — because round 2 found that two of
mine did not, and checking turned up five more of the same shape.

- **the two concurrency probes** (PROBE 13, 14) hold both writers open until both
  have inserted, then release them. RED-proved directly: with `FOR UPDATE`
  stripped from the two bound functions on a live database, both fail; restored,
  17/17. The round-1 version used `Promise.allSettled` over independent
  transactions and passed against the very defect it named.
- **every upgrade-proof hostile insert** is preceded by an ACCEPT of a coherent
  row in the same fixture state, and the block is anchored where a live
  certificate actually stands. The round-1 version named a certificate the script
  never creates, so each "rejection" came from a foreign key rather than the CHECK
  it claimed to test — they would have passed with every constraint dropped. The
  accept-first line is what surfaced this the moment it was added.
- **the `FOLD_INPUTS` closure** derives the mover set from every COMMERCIAL-OWNED
  fold the budget query reads, not just `this.bills.*` — the closure's own root
  applied to itself, exactly as naming `CERTIFIED` and leaving `BILLED_AMOUNT`
  unclaimed did in unit C.
- **the round-4 liveness seal and the round-5 refusal seal** are RED-proved by
  DROPPING them from a live database: without `BillDeduction_coherent` PROBE 18
  fails, and without `phase5_t5c_supersede_needs_release` PROBE 19 fails;
  restored, 22/22.
- **the round-5 provenance binding** is RED-proved the same way: with the
  `resultRef` comparison removed, PROBE 16's two reuse assertions pass a reused
  receipt. Its probe-side twin matters as much — `mintCommand` now REQUIRES the
  caller to name the row the command produced, because the old default would have
  made every hostile insert in the file fail on provenance rather than on the rule
  it names.

### Round 7: the late-withholding fixture proved provenance, not liveness

Codex round 7 (P2): the superseded-certificate assertion in `upgrade-proof.sh`
cited a command bound to a DIFFERENT row, so the provenance trigger rejected it
and the line would have stayed green with the liveness rule deleted. The fixture
now mints its own command, and `assert_rejects` gained an optional expected-reason
argument so an assertion can name the rule that must do the rejecting.

Proved on the scratch database with BOTH liveness seals disabled
(`BillDeduction_targets_live` immediate AND `BillDeduction_coherent` deferred):
the old fixture is still rejected — by provenance — while the corrected one is
ACCEPTED, so only the corrected one fails when the rule it names is gone. Every
other ledger fixture in the file was audited by script for the same defect; the
four command mismatches found are all deliberate and correctly named.

### Round 6: the redundant lock in the refusal seal, and what it did not fix

Codex round 6 found a lock-order inversion in `phase5_t5c_supersede_needs_release`.
The cycle is real and reproduces as PostgreSQL `40P01`. The attribution is
incomplete, and the difference is recorded here rather than smoothed over.

The seal locked `VendorBill`, justified by "`supersede` already holds `lockBill`,
so the seal introduces no new order". That is true of the SERVICE path and false
of the only path this seal ever runs for: a bypass writer updating
`BillCertificate` alone holds the certificate first, so the seal reaches
certificate → bill against the honest bill → certificate.

**The lock is removed** because it bought no serialization: the certificate row is
already locked by the UPDATE that fires the trigger, a concurrent deduction takes
that same certificate `FOR UPDATE`, and a concurrent release can only reduce an
outstanding balance. What it did buy was one arm of the cycle.

**Removal is necessary and not sufficient, and the packet will not claim
otherwise.** With the 5C lock gone the race still deadlocks, because the arm that
closes the cycle is `phase5_t5_certified_bound_check` — fired by 5B's deferred
`BillCertificate_bound_sealed`, defined in the merged, independently cleared
`20270510000000_phase5_t5b_certification`, which 5C does not redefine. This was
established by instrumenting the live lock graph, not inferred: the blocked side
is the correction's `COMMIT`, and disabling the 5C seal entirely still deadlocks.

That 5B lock is **load-bearing** — unlike the one removed here, it folds
`VendorBillLine` across non-superseded versions, a fold the certificate row lock
does not cover. Removing it would trade a deadlock for an unserialized bound-3
check. Nor can the order be repaired inside a trigger: a bypass writer takes the
certificate lock before any trigger runs, so any certificate-side trigger needing
the bill is certificate → bill by construction. The remedies are 5B-owned (drop
or restructure that fold) or global (a project-wide certificate-first order across
cleared services) — either is out of this unit, and both are named rather than
quietly attempted here.

**No integrity is at risk under the residual.** A deadlock aborts both sides; no
withholding and no correction commits, and no money moves. What degrades is the
error quality — `deadlock detected` instead of the seal's precise refusal.

PROBE 20 therefore pins the property that actually holds — **a withholding is
never committed against a retired certificate**, true under either resolution of
the race — and deliberately does NOT pin the error text, which after this change
is not deterministic. A probe asserting the refusal message would be asserting
something false.

**Why dropping the lock does not cost serialization.** The `commercial.contract`
pin caught this removal, on the rule that a fold must be preceded by a lock —
"you cannot lock a fold, so the scoping row must already be held". The rule is
right, and the removal survives it for a reason a text scan cannot see: the fold's
scoping row is held by the UPDATE that FIRED the trigger.

| | lock on the certificate row |
|---|---|
| supersede | `UPDATE … SET "supersededAt"` → `FOR NO KEY UPDATE`, held to end of transaction, so still held when the DEFERRED body folds at COMMIT |
| withhold | `BillDeduction_targets_live` (BEFORE INSERT, immediate) → `FOR UPDATE` |

Those two conflict, so neither can pass the other. **PROBE 21** pins that block in
BOTH directions with two bypass writers touching one table each — no `lockBill`,
so the certificate row is the only thing that could be serializing them — and
`waitUntilBlocked` throws if the block never happens, so it cannot pass quietly.
It is RED-proved the same way the round-4 and round-5 seals are: with
`BillDeduction_targets_live` disabled on a live database it FAILS, restored 22/22.

The pin is not weakened into a pattern. `SERIALIZED_BY_THE_FIRING_ROW` names this
ONE function, because the firing row being locked only helps if the counterpart
writer reaches for that same row, and nothing in a static scan can check that — a
general "folds scoped by `NEW."id"` are fine" rule would be a hole rather than an
exemption. The entry also re-derives its own premise: if the fold ever stops being
scoped to `NEW."id"`, the pin fires again. Anything new still trips it.
- **CLOSURE 3 and CLOSURE 4** are RED-proved by breaking them, not by watching
  them pass. Remove the lock from the withholding bound, the release bound, or
  the liveness trigger and CLOSURE 3 names the function; unwire the commit-time
  twin, or stop it re-reading the certificate, and CLOSURE 4 names it.
- **two more vacuous upgrade-proof assertions were caught while writing this
  head**, both by the accept-first guard that round 2 produced. The re-statement
  block assumed a live certificate stood where none did, so two "rejections" came
  from a foreign key on an empty id; and the different-amount forgery named a
  deduction on ANOTHER BILL, so it was refused by the scope rule rather than the
  terms rule it claimed to test. The block now walks its own bill through the
  lifecycle and asserts the state it depends on before using it.

| Gate | Result |
| --- | --- |
| `pnpm check` | EXIT 0 — web 543/543, API 738/738 (+3: CLOSURE 3, CLOSURE 4, the single-writer pin) |
| `phase5-t5c-deductions.test.ts` | **22/22** |
| full integration, pristine migrated DB | **81 files / 915 tests** |
| `upgrade-proof.sh` | PASSED — 424 assertions, 0 failures; the T5C block each paired with an accept, walking its OWN bill through the lifecycle, and the round-5 seals asserted on the COHERENT §F correction shape (partial release still blocks; full release then allows the same correction) |
| migration re-apply | the whole `20270520000000` file re-applied over an already-migrated database with no error (F5) |
| `test:e2e:api:allmodules` | 35/35 |
| `test:e2e:api:outbox` | 29/29 (6 skipped by design) |

Tripwires advanced in the same change: `MODEL_OWNER` +2, the deduction service's
graph entry, controller route signatures 14→16, mutating routes 161→163, the
boundary route pin, the manifest's owned + read-encapsulated sets and route list,
the web policy mirror, and the TRUNCATE lists across 40 suites.

## What this task does NOT do

- No `advance-recovery` type, and no advance fact (Task 6).
- No approval, payment, or payment-reversal row (Task 6). `APPROVED` and `PAID`
  are stated as folds beside `NET_PAYABLE` and return zero, so Task 6 fills them
  in rather than teaching `deriveBillStatus` a second source of truth.
- No `approved-for-payment` or `part-paid` arrow.
