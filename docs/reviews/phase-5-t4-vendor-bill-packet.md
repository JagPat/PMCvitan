# Phase 5 Task 4 — the §F vendor bill and the §G conservation bounds 1–2

**Base:** `main` `5dc70c1` · **Branch:** `claude/phase5-task4` · **Plan:**
`docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md` (§F and §G carried into it
VERBATIM from `claude/phase5-planning` `a4d469b` by this PR, per the plan's own rule).

## What ships

The task table's row 4, in full: `VendorBill` + lines + immutable versions + the §F CAS lifecycle
**up to `under-verification`** + §G bounds 1–2 + the `disputed` transition **and both withdrawal
guards**.

| Piece | Where |
|---|---|
| `VendorBill` / `VendorBillVersion` / `VendorBillLine` | `schema.prisma`, `20270420000000_phase5_t4_vendor_bill` |
| §F vendor pinning on BOTH PO-line snapshots + the diagnostic-first backfill | same migration, part A |
| The §F CAS lifecycle, the §G bound evaluation, the dispute disposition | `commercial-bill.service.ts` |
| The §0 billed sets (`BILLED_QTY`, `BILLED_AMOUNT`, live claims, the certified floor) | `commercial-bill.query.ts` |
| Withdrawal guard, acceptance side (`assertAcceptanceReversible`) | `commercial.participant.ts` ← `inventory.service.ts` |
| Withdrawal guard, measurement side (`assertMeasurementWithdrawable`) | `commercial.participant.ts` ← `commercial-measurement.service.ts` |
| The ordered-side locks, through each line's OWNING module | `procurement.participant.ts`, `labour.participant.ts` |

## Vision alignment

A PMC cannot today answer, per order, what a vendor has claimed against what actually arrived. This
task makes the claim a **first-class, immutable, bounded record**: bound 1 caps it at what was
ordered, bound 2 at what was accepted (material) or measured (labour), and neither can be satisfied
by anything a commercial actor authored — every right-hand side is a Phase-1–4 fact read through
its owner's contract. It gates nothing: commercial stays a SINK and no readiness verdict consults a
bill.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | A new write surface, and a claim that could name another counterparty's order | `commercial.bill`/`commercial.verify` declared in `ROLE_POLICY` and mirrored web-side; §D/§I probe (engineer records, contractor refused 403, verification pmc-only, off-pilot 404 with zero rows); probe 5f/5ao proves cross-vendor claims are refused **at PostgreSQL** within one project, and the cross-project case by the tenancy composite FK (upgrade proof) |
| civil-time-lifecycle | `documentDate` is a civil date; the §F status graph must not admit an illegal arrow | `documentDate` is `@db.Date`, frozen by the lifecycle trigger; the transition table is enforced in PG (`VendorBill_lifecycle`) — upgrade proof rejects `draft → certified` and an unreasoned dispute; probe 5av proves a `resolved` claim cannot be revived even by direct SQL |
| concurrency-idempotency | Two claims racing one PO line's capacity; a duplicate document number submitted twice | **PROBE 5 (DATABASE)** — two independent `PrismaClient` sessions, each holding its transaction open until the other has written, are serialized by the deferred trigger's `FOR UPDATE`: exactly one commits. **Proven RED** by stripping that one `FOR UPDATE` from the function (both committed, 200 units live against 100 accepted). PROBE 5 (SERVICE) under the readiness-lock barrier; probe 5bg concurrent duplicate submission admits exactly one; every transition is a CAS `updateMany`; keyed replays append nothing |
| data-integrity-conservation | The whole point: a claim above the evidence behind it | §G bounds 1–2 re-derived in-service under the owning module's row lock **and** sealed by a DEFERRABLE INITIALLY DEFERRED constraint trigger firing from five sites; 29 upgrade-proof assertions incl. a coherent claim ACCEPTED before every rejection; the derived-amount CHECK; append-only triggers on all three tables |
| offline-reconciliation | None — no client outbox surface in this task | §M frontend is Task 7. No web change beyond the policy mirror |
| ui-server-parity | None — no UI | Same |

## The two things worth a reviewer's attention

**1. A breach DISPUTES; it does not refuse — and the DB seal is what makes that safe.**

§G says the bounds are "sealed by a PostgreSQL constraint", and §E says an over-bound submission is
disputed rather than rejected. Those look contradictory until you take §0's LIVE rule seriously: a
`disputed` version's lines are not in the fold, so the seal is never violated by a disputed claim.
The service evaluates the bound and routes the claim to `disputed`; the database independently
refuses to let any **live** claim set exceed the bound.

That seal is **deferred to COMMIT**, and that is load-bearing in both directions:

- *Adding* a claim: a bill is created at `draft` (lines not live) and becomes live one statement
  later. A `BEFORE INSERT` check on the line would pass on a claim that only becomes live at the
  transition — the PR-#217 lesson, where a seal durable only at initial insertion was not durable.
- *Withdrawing* the evidence: an acceptance reversal or a reducing measurement correction lowers the
  right-hand side, and the withdrawal guard disputes enough live claims in the same transaction to
  restore it. A deferred check passes when the guard did its job and **aborts the transaction when
  it did not** — which is exactly what happened in the RED proofs below.

**2. One probe passed while proving nothing, and I found it by running the RED proof.**

`PROBE 5 (SERVICE)` — two concurrent submissions under the readiness-lock barrier — stayed **green**
after I stripped the `FOR UPDATE` out of `ProcurementParticipant.lockOrderedLineForClaim`. It had to:
every commercial command takes `lockProjectReadiness`, so that lock, not the PO-line lock, is what
serializes the service path. The probe proves the bound holds under a race; it does not prove the
row lock is load-bearing. Rather than claim otherwise, I added `PROBE 5 (DATABASE)`, which drives two
independent PostgreSQL sessions straight at the rows with no readiness lock anywhere — and *that*
one goes RED the moment the trigger's `FOR UPDATE` is removed. The service-side lock is retained as
a second, narrower barrier and the packet says plainly which one carries the invariant.

This is the rule Task 3 closed once and it applied again here: **a guard is only proven by a probe
that fails without it.**

## Reproduce-first evidence

The claim surface does not exist at `5dc70c1`, so "RED at base" is trivially true and worth nothing.
Each guard was instead proven by removing it from **this** tree and confirming its probe fails:

| Guard removed | Probe | Result |
|---|---|---|
| `assertAcceptanceReversible` call in `stock.reverse` | PROBE 4/5ak | RED — `Bound 2 breached … 80 base units against 0.000000 accepted`, raised by the **deferred DB seal** at commit |
| `assertMeasurementWithdrawable` call in the correction path | PROBE 5bl | RED — `Bound 2 breached … 2 person-shifts against 1.000000 measured` |
| `FOR UPDATE` in `phase5_t4_billed_bound_check` | PROBE 5 (DATABASE) | RED — both sessions commit; 200 units live against 100 accepted |
| `FOR UPDATE` in `lockOrderedLineForClaim` | PROBE 5 (SERVICE) | **still GREEN** — recorded above, not hidden |

The first two are the strongest evidence in the PR: with the service guard gone, the database
refused the transaction on its own. The seal and the guard are independently real.

## Probe coverage (15 tests, `phase5-t4-vendor-bill.test.ts`)

`4`/`5ak` dispute-not-refuse + 80/20 acceptance fold + reversal disputes · `5` bound-2 race (DB and
service) · `5ac`/`5av` a dispute frees the fold and never returns · `5d` amended bill folds once ·
`5an` the disposition disputes the MINIMUM, newest-first · `5bl` the labour twin · `5bf`/`5ag`/`5au`
line seals precise not merely strict · `5bg`/`5bj` duplicate-claim key · `5f`/`5ao`/`5ax` vendor
pinning + backfill · `5h` unit discipline · `7` append-only · §D/§I capability + authority · §C
idempotency.

## Deliberately NOT in this task

- **`verified` and everything past it.** `verified` is the state whose safety IS the §E verdict;
  shipping it here would let a bill reach it before the ordered/accepted/billed comparison exists,
  and pulling §E forward would bypass the Task-5 review stop. The status CHECK names the full set
  because §0's LIVE rule is defined over all of it, but no transition into `verified` exists.
- **The row-level measurement freeze.** §D requires a correction to be refused if it would reduce a
  measurement row a live certificate has FROZEN as consumed evidence (`(measurementId, consumedQty)`).
  That set does not exist until Task 5. The **aggregate** certified floor ships here, written over
  the status set rather than hardcoded to zero, so Task 5 adds the certificate without re-deriving
  the floor. At this tree the arm is unreachable — stated as a property of the tree, not a stub.
- **The refusal arm of `assertAcceptanceReversible`.** Same reason: there is no certificate to refuse
  against yet. The dispute half, which is real now, ships now.

## One decision recorded rather than assumed

§I's permission list does not name an authority for *recording* a vendor's claim. Task 4 adds
`commercial.bill` (pmc/engineer, mirroring `commercial.measure`) rather than borrowing
`commercial.read` or silently reusing `commercial.certify` — following §I's own rule that "a
permission a route needs and the manifest does not declare … is an unauthorized write path".
`commercial.verify` is §I's own name and is declared here because `beginVerification` needs it; its
verdict lands in Task 5.

## Gates

- `pnpm check` **EXIT 0** — web 42 files/543 tests, API 56 files/718 tests, builds clean
- Full integration suite **76 files / 779 tests** on a pristine migrated DB
- `boundary.test.ts` / `module-registry.test.ts` / `cross-module-graph.test.ts` green (mutating
  routes 152 → 157; MODEL_OWNER + owned/read-encapsulated sets extended)
- `upgrade-proof.sh` **PASSED** — the three tables upgrade ROW-FREE; the vendor-pinning backfill runs
  against two chains planted on the PRE-Task-4 schema in their own project `p3` (the only migration
  in this phase that migrates existing data, so a proof over empty tables would have been vacuous);
  a coherent claim is ACCEPTED before every one of the 20 hostile rejections
- `test:e2e:api:allmodules` **35/35**, `:outbox` **29/29** (one `drawings-module-query` visibility
  flake on the first allmodules run — an untouched surface; clean on re-run)

## Files

32 changed, ~3,750 lines. `<!-- review-size: justified-large -->`: the schema, its migration, the
service, the two withdrawal-guard call sites, the two owning-module locks, the tripwires, the probe
suite and the upgrade proof are one architectural concern — the vendor claim — and splitting the
seal from the fact it seals is exactly the failure mode §0b names. Roughly half the line count is
the migration (685 lines, most of it the reasoning behind each seal), the probe suite (620) and this
packet plus the §F/§G verbatim carry-forward into the plan.
