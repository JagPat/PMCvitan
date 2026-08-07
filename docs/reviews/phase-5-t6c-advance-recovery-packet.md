# Phase 5 Task 6C — the advance, and the recovery that draws it down

Base: `main` `5077336` (6B-ii at `eb3b081`, and the STATUS record + runner-proof
fix at `5077336`).

## Vision alignment

A practice pays a vendor before the work is billed — mobilisation, materials, a
milestone. That cash is real and it has to come back, over the bills that follow.
§H models the return as an `advance-recovery` **withholding**: the vendor's next
certified payable is reduced by what they already hold.

Task 5C shipped `retention`, `penalty` and `other` and left `advance-recovery` out
on purpose, saying why in its own comment:

> `advance-recovery` is deliberately absent: it folds against an `advance` row
> created when the advance is PAID, so the enum member arrives in Task 6 with the
> row that caps it. §0b's "every declared member is in the fold" then holds at
> BOTH stages rather than being briefly false.

This is that arrival. **The member and the row land in one migration**, because
either alone is a rule with nothing behind it — the type without the advance is a
withholding bounded by nothing, and the advance without the type is cash with no
way home.

## Review unit

- Base SHA: `5077336`
- Scope: one architectural concern — §H's advance pool and the ceiling it puts on
  a deduction
- Changed files / changed lines: see the PR body for the head's exact totals. As
  in 6B-ii, a new table with an inbound foreign key must join every shared-database
  reset list, so 41 of the changed files are one-line `TRUNCATE` additions and
  `truncate-closure.test.ts` fails until they are there.
- Split considered: yes. 6C is the last increment of Task 6. Task 7's cash
  forecast (§J), frontend (§M) and consolidated packet are NOT here.

## The two judgements a reviewer should test first

### 1. An advance is not a `Payment`

A `Payment` is nested under a `PaymentApproval` on a `BillCertificate`, and that
nesting is what makes §G bound 5 (`PAID ≤ APPROVED`) askable at all — it compares
two folds scoped to the same claim. An advance has neither parent: it precedes
every claim it will be recovered from, which is what makes it an advance.

Forcing it into `Payment` would need a fabricated approval on a certificate nobody
issued, and it would enter `PAID(bill)` — reading as payment of a claim that does
not exist. So `VendorAdvance` is its own table, and the advance reaches a bill only
through a **deduction**, which lowers `NET_PAYABLE` (money the vendor no longer
receives) rather than raising `PAID` (money the vendor received).

The structural guarantee, stated so it can be checked: `paidFor` folds `"Payment"`
and `"PaymentReversal"` **by `billId`**, and `VendorAdvance` has no `billId` to be
folded by. PROBE 23 asserts `ledger.paid` is `0.00` on a bill whose whole payable
was offset by an advance recovery.

### 2. The ceiling is vendor-scoped, and that differs from 6B-ii on purpose

6B-ii bounds a payment reversal by its **own** payment, because a payment is
nested under one authority and an aggregate can be conserved while the attribution
is a lie.

An advance is not an authority — it is a **pool**. A vendor holding a ₹100
mobilisation advance and a ₹50 materials advance recovers ₹120 from the next bill
with no fact of the matter about which row it came from. Forcing a choice would
put an `advanceId` column on `BillDeduction` that no other type uses and that the
practice would have to invent an answer for. What *does* have a fact of the matter
is the counterparty.

**That makes §0b's bill-first lock insufficient on its own**, and this is the
defect the design exists to prevent: two recoveries on two *different* bills of the
same vendor take two different bill locks and never meet, so under READ COMMITTED
both read the same ₹100 recoverable, both pass, and both commit — ₹200 recovered
against ₹100 that went out, with every row append-only. The `ProjectVendor` row is
the one row both transactions must touch, taken **after** the bill so the order
stays total (bill → vendor).

## `RECOVERABLE(vendor)`, and how the probes corrected it

```
RECOVERABLE = Σ VendorAdvance(vendor)
            − Σ (unreleased `advance-recovery` on that vendor's LIVE certificates)
```

Both qualifiers were learned from a failing probe rather than reasoned to.

**Live certificates.** The first draft counted `advance-recovery` rows on every
certificate, live or superseded, on the reasoning that supersession never refunds
an advance. That forgot §H's **re-statement**: superseding carries the deductions
forward onto the replacement as NEW rows, so a bill-wide count sees the same ₹100
recovery twice. PROBE 28 failed at `certify` — the exact moment the restatement
lands — and the correction is the same scope `NET_PAYABLE` already uses: a restated
recovery is the *same* recovery and the superseded row is history, while a
supersession with no replacement leaves the vendor owed the full claim again, so
the advance genuinely is un-recovered.

**Net of releases.** Releasing an `advance-recovery` gives the money back to the
vendor, so the advance is owed again. A fold ignoring releases would strand the
balance at zero after a correction that returned every rupee.

## Two ceilings, both applying

An `advance-recovery` is a `BillDeduction`, so §H's **bound 1** (a withholding
cannot exceed what the certificate leaves payable) still governs it. 6C adds a
second ceiling rather than replacing the first, and bound 1 is checked first.

That ordering is why PROBE 22 had to move to a ₹200 certificate: a ₹150 recovery
against a ₹100 certificate is refused by the *certificate* and never reaches the
advance ceiling. The first draft asserted the advance message and got bound 1's.
PROBE 26 is the mirror — a ₹200 advance against a ₹100 certificate has plenty of
pool and no payable to take it from, and bound 1 correctly refuses ₹150 while ₹100
is taken and the remaining ₹100 stays recoverable against a later certificate.

## Reproduce-first evidence

| Mutation | Probe | RED with |
| --- | --- | --- |
| the seal counts without `FOR UPDATE` on the binding | PROBE 30 | barrier times out — nothing ever waits |
| the fold counts every certificate, live or superseded | PROBE 28 | `Advance recoveries of 200.00 stand against 100.00 actually advanced` — at a legal re-certification |

### A probe that asserted a proxy, again

PROBE 24 proves the ceiling serializes and it **passed** against a build with the
seal's `FOR UPDATE` removed — because the *service* holds the binding through
`ProcurementParticipant.lockVendorBinding`, so a gate on that row blocks the
service whether or not the seal locks anything.

That is 6B-ii's PROBE 19(b) lesson one unit later: a lock is only observable by
making something wait on it, and "a backend is blocked" is a proxy for "*this*
object took the lock". PROBE 30 skips the service entirely — a raw `BillDeduction`
insert has no foreign key to `ProjectVendor`, so the only thing that can make it
wait on the binding is `phase5_t6c_recoverable_check` taking it at COMMIT.

## What the analyzers caught

- **The boundary analyzer** flagged two direct reads of procurement-owned
  `ProjectVendor` from the commercial service. Both now route through
  `ProcurementParticipant`, which gains `lockVendorBinding`;
  `commercial.workflowParticipants` already declared the edge.
- **CLOSURE A** demanded a `_t6b_status_sealed` trigger on `VendorAdvance` — a
  false positive. It scanned the whole query file, exact only while every fold
  there fed §F; `recoverableFor` is §H's ceiling, and `VendorAdvance` has no
  `billId` for the seal's resolver to read, so the demanded seal could not have
  been installed correctly even if someone tried. The surface is now **derived from
  `foldsFor`** by a transitive walk of `this.<method>` calls, so a fourth §F fold is
  covered automatically and a fold §F does not read is not demanded. Its own first
  draft brace-counted from the first `{` — which belongs to the *return type* — and
  produced a 78-character "fold surface" that the vacuity guard caught.
- **CLOSURE B** (6B-ii's) is satisfied without change: 6C writes no new function
  folding `"Payment"`. That was the inheritance flagged in advance, and the honest
  report is that it did not fire because there was nothing for it to fire on.
- **`phase5-t6b-production-runner-proof.sh` had root A a FOURTH time**, in the file
  corrected for it last round. Its `LATER_DIRS` hold-back was a hand-kept list with
  a comment admitting *"this is a LIST because the next unit will add to it"* — and
  the next unit did, and did not add to it. The expected seal set beside it had been
  made derived; this had not. It now derives "later" from the fact the filesystem
  already holds (Prisma applies lexicographically, so later is *sorts after*), with
  a guard that fails loudly if the extraction matches nothing while later
  migrations exist. **PASSED 13/13**, holding back 2 migrations.

  The lesson worth carrying: correcting one enumeration in a file does not correct
  the file. `pr-289-convergence.md` says *fix the class, not the member* — and the
  class here was "every set this script hand-keeps", not "the seal set".

## The probes

| # | § | What it proves |
| --- | --- | --- |
| 22 | §H | the plan's 5bp, in order — zero pool refuses ₹1; ₹150 refused naming the balance; ₹100 permitted; a further ₹1 refused cumulatively |
| 23 | §F | the plan's 5bs — a fully-offset certificate derives `paid` with no cash moving, and the advance never entered `PAID` |
| 24 | §0b | the service serializes on the counterparty, asserting the blocked statement is the binding |
| 25 | §H | containment — an advance to one vendor cannot be recovered from another's claim, while the owner's own claim recovers it |
| 26 | §H | BOTH ceilings apply: the certificate's refuses ₹150 while the pool is fine, and the remainder stays recoverable |
| 27 | §H | the advance's own seals — unbound vendor, zero, negative, blank reason, append-only UPDATE/DELETE, wrong-command provenance, and a raw over-recovery refused at PG |
| 28 | §H | a re-stated recovery is counted ONCE — supersede and re-certify does not reopen the pool |
| 29 | §D | authority (engineer refused) and a keyed replay that appends nothing and does not double the ceiling |
| 30 | §0b | the DATABASE ceiling takes the binding rather than merely counting |

## Gates

- `pnpm check` **EXIT 0** — web 543/543, API 749/749, build clean.
- The Task-6 money-fold suite **36/36** on live PostgreSQL (13 §F probes + 6
  round-1 probes + 8 reversal probes + 9 advance probes).
- Full integration suite on a pristine migrated database: **84 files / 1,004
  tests**, zero failures.
- `phase5-t6b-production-runner-proof.sh` **PASSED 13/13** on the real
  `prisma migrate deploy` path — a gate CI structurally cannot run.
- `upgrade-proof.sh` **PASSED** — the advance table arrives row-free, no
  `advance-recovery` predates it, the widened CHECK admits the member, both seals
  are installed with the deferred one deferred, a coherent advance is ACCEPTED, a
  recovery with no advance behind it is refused, the fully-offset certificate moves
  `certified → paid`, and seven forgeries are rejected.
- `test:e2e:api:allmodules` and `:outbox` — attributed to CI. This container's
  pre-baked Playwright browser is `chromium_headless_shell-1194` against a
  Playwright pinned to `-1228`, so every local browser test fails at launch; a gate
  claimed from a run that never started a browser is not evidence.
- Tripwires advanced in the same commits: `MODEL_OWNER` +1, mutating routes
  166 → 167, the commercial manifest's owned/read-encapsulated sets and routes, the
  command-site table, the policy fixture on both sides, and 43 TRUNCATE lists.
