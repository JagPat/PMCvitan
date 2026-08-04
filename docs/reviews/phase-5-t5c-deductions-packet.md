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
4. **Re-statement of the ledger onto a replacement certificate**, deductions and
   their releases together, so a retained balance never vanishes without an
   attributable release.

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

Fixing F2 opened two edges the finding did not name, and both are sealed rather
than left implicit:

- a replacement certified BELOW its outstanding withholdings is REFUSED, naming
  the conflict (PROBE 8b) — the alternative is a certificate quietly giving money
  back with nobody's signature on it;
- a release against an ALREADY-RESTATED deduction is REFUSED (PROBE 8c) — it
  would strand the release on a superseded certificate as evidence of money
  given back that the live payable denies, which is F2's own defect arriving from
  the other side.

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

`apps/api/test/integration/phase5-t5c-deductions.test.ts` — **22/22 GREEN**.

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
- **the round-4 seals** are RED-proved by DROPPING them from a live database:
  without `BillDeduction_coherent` and `BillCertificate_replacement_restates`,
  PROBES 18, 19 and 20 fail; restored, 22/22.
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
| full integration, pristine migrated DB | **81 files / 917 tests** (was 80/895) |
| `upgrade-proof.sh` | PASSED — the T5C assertions, each paired with an accept, and the re-statement chain walking its OWN bill through the lifecycle rather than assuming a live certificate |
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
