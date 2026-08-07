# Phase 5 Task 6B unit ii — the payment reversal, and a `PAID` that can fall

Base: `main` `163c9ae` (unit i, PR #289 at `023307e`, and the STATUS record #290
that recorded what unit ii inherits).

## Vision alignment

Money that leaves a practice sometimes comes back. A duplicated transfer, a wrong
account, an over-certification discovered after the cash moved — these are
ordinary site accounting, not exotic corrections. §0 has always defined
`PAID(bill)` as **Σ payments MINUS Σ payment reversals**, and unit i shipped with
the second term missing and said so plainly rather than claiming a subtraction it
could not carry.

The consequence was not abstract. 6A's §G bound-5 seal refuses a supersession
that would drop `APPROVED` to zero beneath a standing `PAID` — correctly, because
a residual paid amount is cash standing against an amount nobody has certified.
But nothing could lower `PAID`, so a certificate carrying cash was **correct and
permanently uncorrectable**. §0's ordering says the way out is a sequence, and
cash goes first:

1. reverse the cash IN FULL — `PAID` must be 0;
2. supersede the certificate — `APPROVED` falls with it, and both sides of bound
   5 are 0;
3. re-approve the corrected amount, attributably, and re-pay.

This unit supplies step 1, and with it the arrow §F's lifecycle already declared:
`paid | part-paid → (payment reversal) → RE-DERIVED from PAID vs APPROVED, never
left stale`.

## Review unit

- Base SHA: `163c9ae`
- Scope: one architectural concern — the reversal fact and the fold it lowers
- Changed files / changed lines: see the PR body for the head's exact totals. The
  shape is **16 substantive files plus 41 one-line TRUNCATE additions**: a new
  table with inbound foreign keys must join every shared-database reset list, and
  `truncate-closure.test.ts` fails until it does. That mechanical tail is why the
  head carries `justified-large`.
- Split considered: yes, and held. 6C's `advance-recovery` deduction type and its
  paid-advance fact are NOT here. Task 7's frontend and forecast are not here. The
  claim AMENDMENT that lowers a certified amount is Task 4's, already cleared, and
  is not touched.

## What is in it

1. **`PaymentReversal`** — append-only, strictly positive, reasoned,
   provenance-bound; a row against ONE payment through a three-column FK that
   proves the payment is a payment OF THIS BILL. A distinct row TYPE rather than a
   signed amount, because §H gives every append-only money row in this phase a
   positive value with the type carrying direction: a positive ₹50 "reversing
   payment" reads ₹150 paid, and a negative one is refused by
   `Payment_amount_positive`. Neither is a reversal.

2. **The bound, stated once.** `Σ reversals(payment) ≤ that payment's amount`,
   cumulatively, re-derived in the service under the bill lock and sealed at PG by
   a deferred constraint trigger that takes the payment row `FOR UPDATE` before
   counting. §0's bill-scoped `Σ reversals ≤ Σ payments` is this bound **summed**,
   not a second check — and per-payment is the stronger question for the reason 6A
   round 3 found on the paying side: a bill total can be conserved while one
   authority's attribution is a lie.

3. **`commercial.payment.reverse`** — the payer's authority, its own permission
   (`commercial.reverse-payment`), its own route, its own command type. It asks
   NOTHING about the certificate's state, deliberately: §0's ordering requires the
   cash to move before the document, so a reversal that waited for the certificate
   would be a reversal that could never happen.

4. **`reDerive`, unchanged, called by a seventh mover.** A reversal lowers `PAID`,
   so the derivation runs BACKWARDS here — `paid` → `approved-for-payment` on a
   full reversal, `paid` → `part-paid` on a partial one. Unit i's guard is on the
   status FAMILY rather than on direction precisely so this works without a new
   rule.

5. **`PaymentReversal_t6b_status_sealed`** — the derivation seal on the new fold
   input, through the same generic resolver and inheriting the `NOWAIT` bill-first
   behaviour unchanged.

## Every SQL twin of `PAID`, widened together

`docs/reviews/pr-289-convergence.md`, root A: four findings in one unit were the
same mistake — the code wrote down the members instead of deriving them, and each
fix that stopped at the instance named let the next member through.

The instance THIS unit could repeat is exact. Three PL/pgSQL functions compute
`Σ Payment`:

| Function | What it decides |
| --- | --- |
| `phase5_t6a_paid_bound_check` | §G bound 5, bill-scoped |
| `phase5_t6a_approval_paid_check` | §G bound 5, approval-scoped (6A round 3) |
| `phase5_t6b_derive_bill_status` | §F's truth table, the SQL mirror |

Widen two and forget the third and nothing looks broken — until a ₹100 reversal
fails to unlock the supersession it exists for, because the un-widened bound still
reads ₹100 paid. The reversal row is appended, the fold falls everywhere a reader
looks, and the correction is still refused.

**CLOSURE B** (`commercial.contract.test.ts`) derives that set instead of trusting
the table above: every `CREATE OR REPLACE FUNCTION` body that aggregates over
`"Payment"` must subtract `"PaymentReversal"`. Last definition wins, which is
PostgreSQL's own semantics, so a closure reading 6A's pre-widening text would not
report it. The detector is mutation-tested in both directions — an ordinary
aggregate is recognised, a plain row read with `FOR UPDATE` is not, and a body
with no reversal term is reported as missing one.

6C adds `advance-recovery` and will be tempted to write a fourth twin.

## Reproduce-first evidence

Every claim below was verified RED before it was made true. The mutations were
applied to the live database or the migration text, the named probe was run, and
the failure message recorded.

| Mutation | Probe | RED with |
| --- | --- | --- |
| `DROP TRIGGER "PaymentReversal_t6b_status_sealed"` | PROBE 18 | `promise resolved "1" instead of rejecting` |
| `phase5_t6a_paid_bound_check` reverted to its un-netted 6A body | PROBE 17 | `Payments of 100.00 exceed the 0 approved on this bill` — after the FULL reversal |
| `phase5_t6b_ii_reversal_bound_check` with the `FOR UPDATE` removed | PROBE 19(b) | `barrier timeout: the commit-time bound must TAKE the payment row` |
| the approval-scoped twin's reversal term deleted from the migration | CLOSURE B | names `phase5_t6a_approval_paid_check` at the desk |
| `PaymentReversal_t6b_status_sealed` renamed in the migration | derived-seal closure | `` `PaymentReversal` is a fold input of `PAID` and carries no `_t6b_status_sealed` trigger `` |

### The closure that caught the widening

CI failed on the first head, on `commercial-catalog-closure.test.ts`:

```
phase5_t6a_paid_bound_check is reached by its callers but its OWN body is not canonical
phase5_t6a_approval_paid_check is reached by its callers but its OWN body is not canonical
phase5_t6b_ii_reversal_bound_check is reached by its callers but its OWN body is not canonical
```

That is the pin doing its job. The live-catalog closure hashes each seal
FUNCTION's body separately from the triggers that reach it, because a no-op body
passes every caller pin — the trigger stays installed, deferred and correctly
bound while the bound it names refuses nothing. This unit widened two of those
bodies, so their hashes had to move, and moving them is an explicit statement that
the change was intended.

The two closures now hold the widening from opposite sides. CLOSURE B (source)
fails if a `Payment` fold forgets the reversal term; the body hash (catalog) fails
if a body moves without anyone saying so. **Neither can be satisfied by changing
the other**, which is what makes the pair meaningful rather than redundant.

### The barrier that passed for the wrong reason

PROBE 19(b)'s first draft held `SELECT … FOR UPDATE` on the payment row and
asserted that some backend was blocked. It **passed against a trigger with the
`FOR UPDATE` deliberately removed** — because an INSERT into `PaymentReversal`
takes `FOR KEY SHARE` on its referenced `Payment` row for the foreign key, and
`FOR KEY SHARE` conflicts with `FOR UPDATE`. The barrier was satisfied by the FK,
not by the thing under test. "A backend is blocked" is a PROXY for "the trigger
took the lock", and this module's audits keep finding that exact substitution.

The gate now holds `FOR NO KEY UPDATE`, which lets the FK's `FOR KEY SHARE`
through and conflicts only with the trigger's own `FOR UPDATE`. The wait it
observes can have no other cause, and the un-serialized trigger now times out.

Both barrier halves also assert WHICH statement is waiting rather than that
something is.

## The probes

| # | § | What it proves |
| --- | --- | --- |
| 14 | §0 | `PAID` SUBTRACTS — ₹50 back on ₹100 paid reads ₹50, never ₹150; a negative, a zero and a blank-reason row are all refused; the row is append-only against UPDATE and DELETE |
| 15 | §0 | the bound is per PAYMENT and PRECISE: ₹80 against a ₹40 payment refused, EXACTLY ₹40 permitted, one paisa more refused cumulatively, and the same over-reversal refused at PG for a bypass writer |
| 16 | §F | the derivation runs backwards — `paid` → `part-paid` → `approved-for-payment` — and the freed approval headroom lets the money leave again |
| 17 | §0 | the correction ORDERING end to end: supersession refused with cash standing, still refused after a PARTIAL reversal, PERMITTED after the full one, and the corrected claim needs a FRESH approval |
| 18 | §F | a bypass reversal that leaves the status behind is REFUSED, one that does not move the derivation is ACCEPTED, and a reversal citing the wrong command type is refused by name |
| 19 | §0b | the service serializes on the BILL and the database bound serializes on the PAYMENT — both condition-based, both asserting the blocked statement |
| 20 | §D | containment (a sibling project cannot reach the payment), authority (an engineer may not), and a keyed replay that appends nothing |
| 21 | §F | the ledger reports the reversal, its reason and its author, with `paid` net of it at both the bill and the approval level |

Probes 14–21 join unit i's 1–13 and R1-F1..F6 in the same file, and they reuse its
fixtures unchanged. A sibling file would have restated ~290 lines of fixture, and a
fixture stated twice is the drift this module keeps deleting.

## What did NOT change

- Tasks 5C, 6A and 6B-i are not reopened. `20270610000000` is byte-for-byte
  unchanged.
- No behaviour was weakened to make room. The two 6A functions this migration
  replaces are carried forward VERBATIM apart from `v_paid`, and 6A's own comment
  on the first of them asked for exactly this change: *"Neither may be a raw `Σ`
  over positive rows once 6B adds reversals."*
- `phase5_t6a_command_succeeded` gains a third arm rather than a sibling function,
  because `TG_TABLE_NAME` already carried the switch and a second function would
  be the same rule at a second site.
- The certified AMOUNT is still the claim's. Correcting ₹100 down to ₹50 is a
  claim amendment (Task 4), not something the payment side can or should do.
  PROBE 17 says so where a reader would otherwise assume otherwise.

## Upgrade path

The table is CREATED here, so the upgrade is genuinely quiet — and the assertion
is what proves it rather than the claim. A legacy database has no reversals, so
the widened folds return exactly what they returned before (`Σ Payment − 0`), no
stored status moves, and no backfill is needed or performed. Unit i needed a
serialized cutover because it installed a seal over states 6A had legitimately
created; this one seals a table that does not yet have a row.

The migration ends by ABORTING if that is ever false: a row in a table it is
creating means the schema was reached by a path this file does not describe.

`upgrade-proof.sh` asserts all of it over the legacy fixture — row-free arrival,
the four seals installed with the deferred ones deferred, both reversal arrows
moving the status, `PAID` computing as Σ payments − Σ reversals at PG, the
correction PERMITTED once `PAID` is zero, and six forgeries refused.

## Gates

- `pnpm check` **EXIT 0** — web 543/543, API 749/749, build clean.
- The 6B suite **27/27** on live PostgreSQL (13 unit-i probes + 6 unit-i
  round-1 probes + 8 unit-ii probes).
- Full integration suite on a pristine migrated database.
- `upgrade-proof.sh` **PASSED**.
- `test:e2e:api:allmodules` and `:outbox`.
- Tripwires advanced in the same commit: `MODEL_OWNER` +1, mutating routes
  165 → 166, the commercial manifest's owned and read-encapsulated sets, the
  command-site table, `AUTHORITY_GUARDS` +2, the derivation-seal catalog
  assertion (six fold tables → seven relations), and 41 TRUNCATE lists.
