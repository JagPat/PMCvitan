# Phase 5 Task 5B — certification review packet

**Branch** `claude/phase5-task5b` · **base** `main` `947e433` · plan
`docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md` (§E/§F/§G/§I)

## Vision alignment

One project is one site, and money follows the site rather than commanding it.
Certification is the first act in Phase 5 that creates money anyone may approve —
so it is the increment where "preserve attributable human approvals" stops being a
principle and becomes a schema. A certificate is a FACT, append-only and
attributable; the bill's `certified` status is its projection, and PostgreSQL
refuses the status without a live certificate behind it.

`commercial` remains a SINK. Nothing reads it, no readiness gate consults it, and
enabling the capability changes no readiness verdict in either direction. The two
new inbound channels are participant edges that were already DECLARED in Task 1's
manifest and named there as arriving with §E — `inventory.lockAcceptedEvidence`
and the activity lock at certification.

## What this increment ships, and what it deliberately does not

| Ships | Deliberately absent |
|---|---|
| `BillCertificate` — append-only, one live per bill, amount frozen | `BillDeduction` / `DeductionRelease` (§H, Task 5C) |
| `CertifiedAcceptanceConsumption` / `CertifiedMeasurementConsumption` — §E's `(rowId, consumedQty)` freeze on both sides | `netPayable` on the DTO (§G bound 4 defines it as certified less unreleased deductions) |
| `SodException` — §I's attributable authority, bound by composite FK to ONE certificate | the approval-side SoD rule and its own reference (Task 6) |
| §G bound 3, sealed at COMMIT from both the certificate and the claim side | bounds 4–5, whose facts are 5C's and Task 6's |
| the `verified → certified → verified` arrows | `approved-for-payment`, `part-paid`, `paid` |
| the REFUSAL arms of both withdrawal guards | — |

`netPayable`'s absence is the sharpest of these. Reporting the gross amount under
that name would be an ANSWER rather than a question: every consumer would read a
computed net that is silently wrong the moment the first deduction row exists. An
absent field forces the caller to wait for the ledger that makes it true.

## Invariant matrix

| # | Invariant | Where it is enforced | Where it is proven |
|---|---|---|---|
| 1 | A certificate exists only behind a MATCHED §E verdict recomputed under the full lock order | `CommercialCertificationService.certify` (status gate + `computeTriple`) | PROBE 2, PROBE 3 |
| 2 | `certified` is the SHADOW of a live certificate, never an asserted status | `phase5_t4_bill_lifecycle` (BEFORE UPDATE) | PROBE 1; upgrade proof, both directions |
| 3 | §G bound 3 — `CERTIFIED(bill) ≤ BILLED_AMOUNT(bill)` | `phase5_t5_certified_bound_check`, fired at COMMIT from `BillCertificate` AND `VendorBillLine` | PROBE 13 (refusal AND acceptance); upgrade proof |
| 4 | Exactly ONE live certificate per bill | `BillCertificate_one_live_key` partial unique | PROBE 11; upgrade proof |
| 5 | A certificate names a version OF THE BILL IT CERTIFIES | `BillCertificate_version_fkey` (composite, incl. `billId`) | upgrade proof |
| 6 | The frozen evidence is `(rowId, consumedQty)` — neither half alone | both consumption tables + their per-`(certificate,row)` uniques | PROBE 4, PROBE 5, PROBE 7 |
| 7 | An acceptance may not be reversed below its consumed quantity | `CommercialParticipant.assertNoCertifiedAcceptance`, ahead of the Task-4 dispute | PROBE 4, PROBE 5 (RED without the arm) |
| 8 | A sign-off may not be withdrawn while a certificate rests on its measured work | `assertWorkEvidenceRevisable`, certificate arm ahead of the measurement arm | PROBE 6 (RED without the arm) |
| 9 | A measurement correction may not take a CONSUMED row below its consumed quantity | `assertNoCertifiedMeasurement`, via `assertMeasurementWithdrawable(correctsId)` | PROBE 7 (RED without the arm) |
| 10 | §I — the evidence recorder may not certify; the exception is named, attributable, and for ONE certificate | service check + `SodException_actor_is_not_approver` + `SodException_names_one_fact` + composite FK | PROBE 8, PROBE 9; upgrade proof |
| 11 | Every new table is append-only; a certificate's ONE transition is the supersession stamp, one-way | `phase5_t5_certificate_append_only`, `phase5_t5_row_immutable` | PROBE 12; upgrade proof |
| 12 | A REPLAY returns the certificate THAT call made | `resultRef` → `certificateById`, never a bill-scoped read | PROBE 10 |
| 13 | Every surface is absent off-pilot | `capabilities.assertEnabled` on all three entry points | PROBE 14 |
| 14 | The four tables upgrade ROW-FREE over a legacy database | migration's closing `DO` block | upgrade proof |

## §E's lock order, implemented literally

1. `lockProjectReadiness(projectId)`
2. every contributing stock LOT, ascending by id — `InventoryParticipant.lockAcceptedEvidence`
3. EVERY PO line the bill touches, material and labour together, in ONE ascending
   order taken BEFORE any per-line work — inside `computeTriple`
4. the contributing measurements — `CommercialMeasurementQuery.lockMeasurementsFor`
5. the ACTIVITY each measurement rests on — `ActivityParticipant.measurableTarget`

Step 2 before step 3 is not a free choice. Every inventory write already runs
`lockProjectReadiness → lockLot → applyReceiptProgress`, and `applyReceiptProgress`
is what takes the PO line; inverting the order would let certification hold a PO
line waiting for a lot while a concurrent rejection holds that lot waiting for the
PO line. Commercial adopts the established order rather than asking four cleared
modules to migrate to a new one.

Step 5 is not covered by step 4, and the reason is in §E: a measurement can be old
and entirely valid while the sign-off underneath it is withdrawn concurrently.
PROBE 6 exercises both directions of that pair.

## Roots carried in from the 5A convergence audit

| Root | How it is applied here |
|---|---|
| **A — fix the SET, not the member** | The TRUNCATE lists were edited by a DERIVED sweep over every `TRUNCATE TABLE` statement in the repo, not by hand. `truncate-closure.test.ts` was found to match only the FIRST of `seed.ts`'s two statements and is fixed (proven RED by removing a name from statement 2 only). PROBE 15 covers the raw-SQL FKs the DMMF cannot see. |
| **B — a replay owes the caller what THAT call concluded** | `certify` and `supersede` both return by `resultRef`, never by a bill-scoped read. PROBE 10 is the scenario that separates them. |
| **C — presence is not provenance, and a chain is as strong as its floor** | The certificate's `sourceCommandId` rests on the platform receipt seal merged as PR #277; this branch does not re-derive it. |
| **D — a workaround outlives its cause** | The §E triple is CALLED, not copied. `claimLines`/`computeTriple` became public in 5A's service with a docblock naming the three sites §E lists. |
| **H — one rule, one function** | `netOf` moved to `CommercialMeasurementQuery` (§D's correction floor and §E's freeze need the same number); the per-row `ACCEPTED` arithmetic moved to `InventoryQuery.acceptedPerRow`, with the participant adding only the lock. |

The boundary analyzer caught the first draft of `assertSegregation` reading the
inventory-owned `StockTransaction` directly. The fix is not a waiver: the
acceptance recorder now travels WITH the evidence the participant already
returned, so §I never reads a foreign ledger at all.

## Gate results

| Gate | Result |
|---|---|
| `pnpm check` | **EXIT 0** — web 543/543, API 724/724, both builds clean |
| `phase5-t5b-certification.test.ts` | **15/15** on live PostgreSQL |
| Reproduce-first | with the three Task-5B refusal arms disabled: **probes 4, 5, 6, 7 RED**, the other 11 green |
| Full integration suite, pristine migrated DB | see below |
| `upgrade-proof.sh` | **PASSED** — 22 new assertions, every refusal paired with its acceptance |
| Tripwires | route count 158 → 160, `MODEL_OWNER` +4, contract-closure table +3, service inventory +1, `readEncapsulated`/`ownsModels` +4, 37 TRUNCATE lists |

## Scope

| | |
|---|---|
| Files | 54 |
| Changed lines | ~1,500 |

37 of those files are the one-line TRUNCATE-list sweep, which is mechanical and
derived rather than authored. The reviewable surface is the migration, the schema
models, the certification service, the three participant arms, the two moved
folds, the contracts, and the probe suite.
