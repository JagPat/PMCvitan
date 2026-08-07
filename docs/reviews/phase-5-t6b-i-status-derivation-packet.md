# Phase 5 Task 6B unit i — §F's DERIVED payment status

Base: `main` `5b8186a` (Task 6A #286, its CLOSURE-10 unit #287, and the STATUS
record #288 that scoped 6B into two units).

## Vision alignment

A construction practice does not ask "what status is this bill?" — it asks
"how much of what we certified has actually gone out?" §F's answer is that the
status is not a fact anyone writes. It is a **function of three folds**:

```
NET_PAYABLE  = certified − withheld + released     (Task 5C)
APPROVED     = Σ approvals on the LIVE certificate (Task 6A)
PAID         = Σ payments on the bill              (Task 6A)
```

Tasks 5C and 6A built all three and deliberately stopped short of storing the
answer, each leaving a probe that pinned the half-step so this task would change
it knowingly. This unit supplies the derivation, wires every writer that can move
any of the three folds into it, and opens the lifecycle arrows the derived
statuses need — as a **family**, not as a list.

## Review unit

- Base SHA: `5b8186a`
- Scope: one architectural concern — §F's status derivation
- Changed files / changed lines: 13 files, ~1,040 changed lines (within budget)
- Split considered: yes, and taken. `docs/STATUS.md` records the 6B split. Unit
  ii (the `PaymentReversal` table and its subtraction from `PAID`) is NOT here;
  6C's advance-recovery is not here; Task 7's frontend and forecast are not here.

## What is in it

1. **`commercial-status.ts`** — §F's truth table as one pure function,
   `derivedBillStatus({netPayable, approved, paid})`, plus the derived FAMILY
   (`certified`, `approved-for-payment`, `part-paid`, `paid`) and
   `isDerivedBillStatus`. No I/O, no Prisma, no transaction: it is the
   specification, and everything else in this change reads it rather than
   restating it.

2. **`commercial-status.service.ts`** — `CommercialStatusService.reDerive(tx,
   projectId, billId, current)`. Reads the three folds through the module's own
   query, computes `derivedBillStatus`, and CASes the bill from `current` to the
   answer. It guards on the **family** (`isDerivedBillStatus`), never on
   direction — see "Why it is not monotonic" below.

3. **`commercial-deduction.query.ts`** — the three folds get ONE definition
   each. `approvedFor` (live-certificate-scoped), `paidFor` (bill-scoped), and
   `foldsFor` reading all three together. `CommercialPaymentService`'s private
   `approvedTotal`/`paidTotal` are DELETED and routed here; `paidForApproval`
   stays, because it is a different fold (per-approval, §G's nested bound).

4. **Six movers, one call each**, inside the existing bill-first lock and the
   existing transaction — `payment.approve`, `payment.record`,
   `deduction.record`, `deductions.release`, `certificate.certify`,
   `certificate.supersede`. That set is complete by construction: it is exactly
   the writers of the three folds.

5. **`20270610000000_phase5_t6b_status_derivation`** — no new table and no new
   column. Three guards encoded "past certification" as `= 'certified'`, which
   was exact only while `certified` was the last status a bill could hold. They
   are widened TOGETHER against one shared SQL predicate
   (`phase5_t6b_derived_bill_status`, mirroring `isDerivedBillStatus`), rather
   than one at a time as each failure surfaced. Everything else in both replaced
   functions is carried forward verbatim.

6. **The derivation itself, in SQL** (Codex round 1) —
   `phase5_t6b_derive_bill_status` mirrors `derivedBillStatus` arm for arm, and
   `phase5_t6b_status_coherent` refuses any bill inside the family whose stored
   status disagrees with its own folds. It fires at COMMIT from **five** tables:
   `VendorBill` and every table that can make the equation false. Plus an
   **idempotent backfill** that moves bills 6A legitimately left at `certified`.

## Codex round 1 — the family was a PROXY for the derivation

Four findings on head `392b46f`, all correct, and two of them the same root
reaching opposite sides. The first head guarded family MEMBERSHIP at PostgreSQL
and left the MEMBER to the service, with a comment in the migration justifying
it: enumerating §F's arrows in SQL would put a second copy of the truth table
there, free to disagree.

**That reasoning was wrong, in the way this module keeps being found for.** The
choice was never one copy or two — `phase5_t6b_derived_bill_status` was already
a second copy of the FAMILY. The choice was which question the database is
allowed to answer, and answering only the coarse one left the fine one enforced
nowhere.

| # | P | Finding | Fix |
|---|---|---|---|
| 1 | P1 | `UPDATE "VendorBill" SET status='paid'` on a bill with `APPROVED = PAID = 0` passed membership and committed; every read then reported an unpaid bill as paid. | The database computes the exact derivation (`phase5_t6b_derive_bill_status`) and refuses disagreement. |
| 4 | P1 | The same gap's other mouth: a direct writer appends a VALID `PaymentApproval` — every 6A seal satisfied — and simply does not move the status. | The same coherence function fires from `PaymentApproval`, `Payment`, `BillDeduction` and `BillDeductionRelease` as well as the bill. Sealing only `VendorBill` would have closed one mouth and left the other. |
| 2 | P1 | On upgrade from 6A a bill can already carry live approvals and payments at `certified` — 6A's PROBE 9 pinned exactly that. The migration installed the derivation without moving those rows. | An idempotent backfill, run BEFORE the seal. It is not a courtesy: without it the next honest write to such a bill would be refused for a state it did not create. It invents nothing — every value comes from existing rows through the same function the runtime uses, and the `WHERE` clause is the fixpoint condition. |
| 3 | P2 | `commercial.payments` read the bill status and then queried approvals separately, so a concurrent `payment.approve` could land between them and produce `approved: 100.00` beside `billStatus: certified`. | One repeatable-read snapshot, as the deduction ledger has done since 5C. The stale comment there claiming the derivation was still ahead of the writes is deleted. |

The fix that generalises is finding 4's: the seal is **one function fired from
every table that can falsify the equation**, not a check bolted to the row the
finding happened to name.

### A probe that proved nothing

R1-F3's first draft read the ledger 25 times with nothing else writing and
asserted the response was internally consistent. It passed at the reviewed head
too — a serial read has no seam to straddle. It is now a deterministic
two-session barrier: a session holds `ACCESS EXCLUSIVE` on `PaymentApproval`,
the ledger read is confirmed BLOCKED via `pg_stat_activity` (condition-based,
never a sleep), the writer then commits an approval **and** the status move, and
the read resumes. At `392b46f` it returns `billStatus=certified` beside
`approved=40.00`; under one snapshot it is coherent.

## What this unit deliberately does NOT do

- **No `PaymentReversal`.** `PAID` is `Σ Payment.amount` with no subtraction
  term, and `paidFor`'s docstring says so at the point of definition rather than
  claiming a term the SQL does not have. The reversal ships in unit ii **with its
  table**, so the fold and the row that feeds it arrive together.
- **No advance-recovery** (6C) and **no frontend or forecast** (Task 7).
- **No new authority.** Every mover already had its permission check, its lock,
  and its command; this adds a call inside them.

Because there is no reversal yet, superseding a certificate with cash standing
against it is still refused — by Task 6A's existing §G bound-5 seal, not by
anything this change adds. See "The correction that mattered most" below.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | `reDerive` is called inside six existing commands; a derivation that read or wrote across projects would leak one vendor's settlement into another's ledger. Every fold query is `projectId`-scoped and the CAS `where` carries `projectId`. | PROBE 10 — two projects, each with a certified claim; paying one to completion leaves the sibling `certified`. Off-pilot 404s unchanged (5B PROBE 14, 6A §D probes, all green). |
| civil-time-lifecycle | The lifecycle trigger's arrow set is the risk: opening four statuses invites either an under-open set (an honest mover refused) or an over-open one (a status flip with no fold behind it). | The DB guards the FAMILY only — nothing escapes forward except supersession, nothing enters except `verified → certified` — and the derivation owns which member. PROBE 9 walks all six movers; PROBE 6 proves the backward arrow; 5B R1-F2 proves the projection seal still refuses a certificate and a status moving apart, now across four statuses instead of one. |
| concurrency-idempotency | `reDerive` reads folds then writes; a concurrent mover could make the read stale. All six movers already hold the bill row `FOR UPDATE` (§0b bill-first order) before `reDerive` runs, and the write is a CAS from the status read under that lock. | PROBE 11 — a keyed replay re-derives to the same status and appends nothing. PROBE 13 — a refused supersede leaves the status exactly as it was. The CAS throws `ConflictException` on a 0-count rather than silently no-op'ing. |
| data-integrity-conservation | The whole change. A derived status that disagrees with its folds is a lie about money, and the failure is silent. | `expectDerived` re-reads the folds and the stored status and asserts equality — it is used at every assertion point in the suite rather than comparing against a literal, so a probe cannot agree with a wrong derivation. PROBES 1–5 are the truth table; 7 is the fully-offset case; 8 proves a release never invents an approval; 12 proves the read surface reports the same answer. |
| offline-reconciliation | None — no client-visible contract changed and no new command exists. The status a stale client holds is refreshed by the same reads it already used. | `pnpm check` web 543/543 unchanged; no shared-contract change in the diff. |
| ui-server-parity | The ledger read reports the STORED status. If storage and derivation could disagree, the UI would show a settled bill as certified (or worse, the reverse). | PROBE 12 asserts `ledger.billStatus` equals the freshly-derived answer. 6A PROBE 9's pin — which asserted `certified` after a part-payment — is changed here to `part-paid`, which is the visible consequence. |

## Why it is not monotonic

`reDerive` has **no forward-only guard**, and that is deliberate. A retention
release RAISES `NET_PAYABLE`, so a bill that was `paid` (nothing left payable)
becomes `certified` (money payable again, none of it approved). `paid →
certified` is a required move, not a corruption. An earlier draft of this task's
STATUS note claimed "no status can move backwards"; that was false, contradicted
by the truth table in this task's own `commercial-status.ts`, and it is corrected
in `docs/STATUS.md`.

The lifecycle trigger is therefore closed under BOTH directions within the
family, and the guard everywhere is `isDerivedBillStatus` — membership, not
order.

- **PROBE 6** withholds the whole certificate (`paid`), then releases part of it
  and asserts the bill is `certified` again.
- **5C PROBE 4**, the pin 5C left for this task, now asserts the same round trip
  with its MONEY assertions byte-for-byte unchanged.

## The correction that mattered most

While widening `supersede`'s status guard from the member `certified` to the
family, this task added a service-level refusal claiming the paid-certificate
case was "reachable before this task and unguarded".

**That was false.** Task 6A's PROBE 11 proves the §G bound-5 constraint trigger
`BillCertificate_paid_bound_sealed` already refuses exactly that supersession at
commit — a supersession that drops `APPROVED` below a standing `PAID` cannot
commit. The refusal was removed: a second copy of the rule with a second message
is precisely the drift this module keeps deleting.

**PROBE 13** now carries the obligation that comes with widening the guard: it
proves `approved-for-payment` (newly reachable, legitimately correctable) is let
through, and `part-paid` (newly reachable, NOT correctable while cash stands) is
refused **by the existing seal's own message**. The widened guard does not weaken
anything.

## Reproduce-first evidence

The base tree was checked out into a worktree at `5b8186a` against a scratch
PostgreSQL database with only the base migrations applied. The pure
specification (`commercial-status.ts`) and the fold reader
(`commercial-deduction.query.ts`) were copied in; the **six movers and the
migration were not**. That is the exact RED condition: the truth table and the
folds present, the writers absent.

**13 failures across all four suites at base:**

| Suite | RED at `5b8186a` |
| --- | --- |
| `phase5-t6b-status-derivation.test.ts` | 10 of 13 |
| `phase5-t5c-deductions.test.ts` | PROBE 4 |
| `phase5-t6a-payments.test.ts` | PROBE 9 |
| `phase5-t5b-certification.test.ts` | R1-F2 |

The three 6B probes that pass at base are PROBES 1, 5 and 8 — every one of them
asserts `certified`, which is the single status the base tree stores. Their green
is the point: the derivation must not break the state that already worked.

All 13 are GREEN on this head.

### Codex round 1 — RED at the reviewed head `392b46f`

The reviewed head was checked out into a worktree against its own scratch
database. Only the four new probes travelled; the derivation function, the
coherence seal, the backfill and the ledger snapshot stayed behind.

| Probe | RED at `392b46f` |
| --- | --- |
| R1-F1 — a raw family flip with no fold behind it | stores `paid` on a bill with `APPROVED = PAID = 0` |
| R1-F4 — a valid fold row appended without its status | approval, payment and release all commit |
| R1-F2 — the backfill | the stale bill stays `certified` |
| R1-F3 — the ledger snapshot | `billStatus=certified` beside `approved=40.00` |

All four GREEN here.

## Gates

| Gate | Result |
| --- | --- |
| `pnpm check` | EXIT 0 — web 543/543, API 746/746, build clean |
| Full integration, pristine migrated DB | see PR body |
| `phase5-t6b-status-derivation.test.ts` | 17/17 |
| `phase5-t5b` / `t5c` / `t6a` | 102/102 |
| `upgrade-proof.sh` | PASSED — 469 assertions, 0 failures |
| `test:e2e:api:allmodules` / `:outbox` | see PR body |

The round-1 seal also broke seven **pre-existing** upgrade-proof fixture writes,
and that is the seal working: those steps appended a fold without moving the
status, which is now illegal. `UP6A-A-OK` (the approval at exactly the net
payable) now carries its status move in the same transaction. The row and the
bound under test are identical; the fixture was made to do what
`payment.approve` does, which is what an upgrade proof should exercise anyway.

## Files

```
apps/api/prisma/migrations/20270610000000_phase5_t6b_status_derivation/migration.sql
apps/api/src/app.module.ts
apps/api/src/commercial/commercial-status.ts                    (new — the specification)
apps/api/src/commercial/commercial-status.service.ts            (new — reDerive)
apps/api/src/commercial/commercial-deduction.query.ts           (the three folds, one definition each)
apps/api/src/commercial/commercial-payment.service.ts           (two movers; private folds deleted)
apps/api/src/commercial/commercial-deduction.service.ts         (two movers)
apps/api/src/commercial/commercial-certification.service.ts     (two movers; family guard; redundant refusal removed)
apps/api/src/common/cross-module-graph.test.ts                  (classify the new service)
apps/api/test/integration/phase5-t6b-status-derivation.test.ts  (new — 13 probes)
apps/api/test/integration/phase5-t5c-deductions.test.ts         (5C's pin, changed knowingly)
apps/api/test/integration/phase5-t6a-payments.test.ts           (6A's pin, changed knowingly)
apps/api/test/integration/phase5-t5b-certification.test.ts      (projection seal message widened to the family)
```

## What unit ii must do

`PaymentReversal` and the subtraction of it from `PAID`. The fold's definition in
`commercial-deduction.query.ts` is the single site that changes, and every mover
already routes through it — which is the property this unit was built to have.
