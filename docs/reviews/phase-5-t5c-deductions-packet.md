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
3. **The §F derivation**, as one shared function over all three folds.
4. **The first real subtraction into §J's `certified-payable`** — the term unit C
   shipped with both of its subtractions as the identity.
5. **Two seal widenings**, which are the part of this change most worth a
   reviewer's attention. They have their own section below.

`advance-recovery` is deliberately NOT in the type set. It folds against an
`advance` row created when the advance is PAID, so the enum member arrives in
Task 6 with the row that caps it. §0b's "every declared member is in the fold"
then holds at both stages rather than being briefly false.

## The two seal widenings

Unit A sealed a biconditional: *a live certificate exists for a bill if and only
if that bill is `certified`*. It also gated the lifecycle arrows and required a
certificate behind any bill entering `certified`.

Those were right when `certified` was a claim's terminal status, which it was at
that tree. §F's derivation table — cleared with the plan — evaluates
`NET_PAYABLE = PAID` **first**, so withholding the whole of a certificate settles
the bill. The unwidened seals refuse the first deduction that does so.

The invariant is unchanged and still enforced in both directions. What changed is
which statuses mean "past certification":

| Seal | Before | After |
| --- | --- | --- |
| certificate↔status biconditional | `= 'certified'` | the post-certification SET |
| lifecycle arrows | `certified → verified` | `+ certified → paid`, `paid → {certified, verified}` |
| certificate shadow rule | entering `certified` | entering the reachable post-certification set |

The lifecycle table opens only the two arrows §H's facts produce.
`approved-for-payment` and `part-paid` stay closed until Task 6 ships the approval
that makes them safe — the discipline this table has followed since Task 4. The
biconditional names all four, because it answers "is a live certificate
legitimate?" rather than "does this arrow exist", and naming fewer would make it
wrong the moment Task 6 lands.

**PROBE 4 is the evidence, and the RED proof was run directly.** Restoring unit
A's narrow definitions on a live database and re-running it fails with unit A's
own message — which anticipated this task by name:

> A vendor bill cannot move from certified to paid — … the arrows past
> `certified` belong to the task that produces their evidence

Restoring the widened definitions returns the suite to 11/11. The certification
suite is 49/49 against the widened seals, and its R1-F2 probe still asserts both
refusals the original was written for; only the sentence it reports them in moved.

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

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | two new commands and one read; a deduction reaches money, so its authority must not be inherited from certification | `commercial.deduct` / `commercial.deduct.release` declared separately (same list today, so a later widening of one cannot widen the other); every fold and route is project-scoped; contract test pins each command to its `executeCommand` site and each query to its route |
| civil-time-lifecycle | **the seal widenings.** A bill moving past `certified` must still be provably certified | PROBE 4 with its direct RED proof; upgrade-proof asserts the widened biconditional still refuses a bill moved OFF the post-certification set while a certificate stands; certification suite 49/49 |
| concurrency-idempotency | two concurrent withholdings must not each see room for themselves | both bounds re-derived INSIDE the bill lock, after `lockProjectReadiness` and `lockBill` (§0b's order); the release re-reads its deduction inside the lock; PROBE 10 proves a keyed replay of either write appends nothing |
| data-integrity-conservation | a withholding that could be edited never withheld anything; a negative one RAISES the payable | append-only triggers on both tables (PROBE 6); `amount > 0` at PG and in the service (PROBE 2); both bounds sealed at COMMIT and proven by hostile insert; PROBE 8 proves supersession takes deductions out of every fold while keeping them as history |
| offline-reconciliation | not applicable — no client surface (§M frontend is Task 7) | — |
| ui-server-parity | the DTO gains a ledger and a `netPayable`; no UI consumes it yet | `pnpm check` web 543/543 |

## Evidence

`apps/api/test/integration/phase5-t5c-deductions.test.ts` — **11/11 GREEN**.

Every probe is RED at `0b87d85` for the trivial reason that the ledger does not
exist there, so the packet does not lean on that. The load-bearing RED proofs
were run against the risk that is real:

- **the seal widenings** — narrow definitions restored on a live database, PROBE
  4 fails with unit A's message, widened definitions restored, 11/11 (above);
- **the `FOLD_INPUTS` closure** — the pin now derives the mover set from every
  COMMERCIAL-OWNED fold the budget query reads, not just `this.bills.*`. The
  closure's own root applies to itself: naming one owner would leave the next
  blind, exactly as naming `CERTIFIED` and leaving `BILLED_AMOUNT` unclaimed did
  in unit C.

| Gate | Result |
| --- | --- |
| `pnpm check` | EXIT 0 — web 543/543, API 735/735 |
| full integration, pristine migrated DB | **81 files / 906 tests** (was 80/895) |
| `upgrade-proof.sh` | PASSED — ledger row-free over the legacy fixture; five hostile inserts rejected; the widened biconditional still refuses both directions |
| `test:e2e:api:allmodules` | 35/35 (one run flaked on `cross-cutting-surfaces`, a surface this change does not touch; clean on re-run) |
| `test:e2e:api:outbox` | 29/29 |

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
