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

## Probe coverage (19 tests, `phase5-t4-vendor-bill.test.ts`)

`4`/`5ak` dispute-not-refuse + 80/20 acceptance fold + reversal disputes · `5` bound-2 race (DB and
service) · `5ac`/`5av` a dispute frees the fold and never returns · `5d` amended bill folds once ·
`5an` the disposition disputes the MINIMUM, newest-first · `5bl` the labour twin · `5bf`/`5ag`/`5au`
line seals precise not merely strict · `5bg`/`5bj` duplicate-claim key · `5f`/`5ao`/`5ax` vendor
pinning + backfill · `5h` unit discipline · `7` append-only · §D/§I capability + authority · §C
idempotency · `F1`–`F4` the Codex round-1 findings.

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

## Codex round 1 — four findings, all fixed forward

Head `61adb3d` drew four findings, every one correct about its mechanism. Each was reproduced RED
before the fix and is RED again with the fix reverted (verified by stashing the migration and the
participant and re-running: 4 failed / 15 passed).

| # | Finding | What was actually wrong | Fix |
|---|---|---|---|
| F1 | P1 — recheck PO version status when sealing billed bounds | The bound check read the line's frozen quantity without asking whether its version was still live, and **no vendor-bill trigger fired when one stopped being live**. Ordered authority is the THIRD withdrawal path and §0b's closure row does not name it | The seal joins the version status and treats a non-live version as ZERO authority; both PO-version tables become deferred firing sites (5 → 7); `withdrawOrderedAuthority` disputes the affected claims from `replaceAttribution`/`releaseAttribution` — the one channel all eight lifecycle sites already reach |
| F2 | P2 — freeze status reasons after they explain a claim exit | The lifecycle trigger only looked when the status itself moved, so a later update could rewrite the justification for an append-only exit | `statusReason` is writable only as part of the transition that sets it |
| F3 | P2 — seal supersession fields until the actual amendment | The trigger checked the immutable columns and returned, so `supersededById`/`supersedeReason` could be pre-filled and rewritten on a still-current version; and nothing forbade ZERO current versions | Those two columns are writable only WITH `supersededAt`; the deferred check gains an exactly-one-current-version rule and now fires on UPDATE, not only INSERT |
| F4 | P2 — reject late bill-line inserts into existing versions | The line trigger froze updates and deletes but not inserts. The reviewer's exploit is exact: a **zero-money** line leaves `claimedAmount` equal to the line total, so the money check passes while QUANTITY enters `BILLED_QTY` — on a PO line the original claim never named | `lineCount` frozen at creation and re-derived by the same deferred check. A COUNT, not a quantity: one version can carry base units and person-shifts, which do not sum |

**F1 is worth reading in full, because the mechanism was right and the consequence was not.** Codex
said an amend/cancel could strand a live claim. Chasing it down, that turns out to be unreachable
through any service path in this tree — three guards from three different tasks close it: Task 2
refuses labour cancel/amend while a live capacity commitment stands, Task 3 refuses defaulting that
commitment below `MEASURED` (and a labour claim needs `MEASURED > 0`), and Phase 3 refuses a
material cancel with accepted receipts while permitting amend only from `issued` (and a material
claim needs `ACCEPTED > 0`, which moves the version off it). The probe now pins all three, because
each belongs to a different task and any one relaxing would open the door silently.

The seal was still wrong and is still fixed. §G asks the **database** to hold the bound
independently of the service, and "another task's guard happens to block the only route" is not the
database holding anything. The probe's second half drives the withdrawal straight at PostgreSQL,
where those guards do not apply, and the seal aborts the commit naming bound 1 — then shows the
paired disposition letting a legitimate withdrawal through.

**A fourth vacuous probe, found the same way.** While fixing F1 the suite's `billedQty` helper
turned out to be material-only, so passing it a labour line folded zero rows and reported `0` for a
claim that was live. My first F1 probe asserted exactly that `0` and would have passed while
proving nothing — the third instance of this failure mode in Phase 5, after Task 3's three. The
helper now requires the kind explicitly rather than defaulting to one.

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
