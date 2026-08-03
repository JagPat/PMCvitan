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
| 15 | A live certificate exists for a bill IF AND ONLY IF that bill is `certified` | `phase5_t5_certificate_projection_check` at COMMIT, from BOTH tables | R1-F2 (both directions); upgrade proof |
| 16 | A frozen acceptance row is an `acceptance` on a PO line this bill claims | `phase5_t5_consumption_evidence_check` at COMMIT | R1-F3/F4; upgrade proof (a real receipt refused) |
| 17 | A frozen measurement is an ORIGINAL on a labour PO line this bill claims | …the same function, second caller | R1-F4 |
| 18 | §I asks about the rows this certificate DRAWS on, not every row on the line | `drawAcceptances` decided once, read by §I and written by the freeze | R1-F5 |
| 19 | Approver standing is the ORGS module's question | `OrgsParticipant.hasProjectRoleStanding` (`forUpdate`) | R1-F6 |
| 20 | Certification cannot deadlock against a concurrent acceptance reversal | the lock order below | R1-F1 (RED = PG `40P01`) |
| 21 | A live certificate FREEZES evidence covering every line its claim states | `phase5_t5_certificate_complete_check` at COMMIT, from `BillCertificate` AND `VendorBillVersion` | R2-F1 |
| 22 | A certificate by an evidence RECORDER carries an attributable `SodException` | …the same function — §I asked of the frozen set, at the database | R2-F2 |
| 23 | Frozen `consumedQty` never exceeds the evidence that exists | `phase5_t5_consumption_evidence_check`, both arms | R2-F3 |
| 24 | A live certificate names the bill's LIVE claim version | `phase5_t5_certificate_complete_check` | R2-F4 |
| 25 | Certification cannot deadlock against a concurrent measurement CORRECTION either | the labour half of the evidence lock, below | R3-F1 (RED = PG `40P01`) |
| 26 | An SoD exception overrides the rule it NAMES, granted by an approver with standing | `phase5_t5_certificate_complete_check`, mirroring the orgs standing predicate in SQL | R3-F2/F3 |
| 27 | The frozen set is CLOSED — a certificate rests on EXACTLY what it claimed | the completeness check is an equality, re-run on every consumption insert | R3-F4 |
| 28 | Withdrawing evidence re-checks every live freeze on that row | `StockTransaction`/`Measurement` fire the same quantity predicate | R3-F5 |
| 29 | The author of a POSITIVE correction is an evidence actor for §I | `assertSegregation` folds corrections addressed to the frozen rows | R3-F6 |

## §E's lock order, implemented literally

1. `lockProjectReadiness(projectId)`
2. ALL the contributing EVIDENCE, before the bill:
   - every contributing stock LOT, ascending by id — `InventoryParticipant.lockAcceptedEvidence`
   - the contributing measurements — `CommercialMeasurementQuery.lockMeasurementsFor`
   - the ACTIVITY each measurement rests on — `ActivityParticipant.measurableTarget`
3. the BILL, and every side re-read under it
4. EVERY PO line the bill touches, material and labour together, in ONE ascending
   order taken BEFORE any per-line work — inside `computeTriple`
5. the DRAWS — which acceptance and measurement rows this certificate consumes, decided
   over rows step 2 already holds

Step 2 before steps 3–4 is not a free choice. Every inventory write already runs
`lockProjectReadiness → lockLot → applyReceiptProgress`, and `applyReceiptProgress`
is what takes the PO line; inverting the order would let certification hold a PO
line waiting for a lot while a concurrent rejection holds that lot waiting for the
PO line. Commercial adopts the established order rather than asking four cleared
modules to migrate to a new one.

**The BILL moved BELOW the lots in Codex round 1, and this is the deeper version of
the same rule.** §0b says "the BILL is taken FIRST, before any foreign row", and
that is right for every other commercial write — but `stock.reverse` locks the LOT
and then disputes the bill through `CommercialParticipant`, so a bill-first
certifier deadlocks against it exactly: certification holds bill B waiting for lot
L while the reversal holds L waiting to dispute B. The price of moving the bill down
is that the evidence set is chosen from an UNLOCKED read, so the claim is re-derived
once the bill is held and a divergence is a 409 rather than a late lock — locking late
is how the deadlock returns.

**Round 3 found the same defect on the LABOUR side**, because round 1's fix moved the
material lots and left the measurements where they were: the measurement-correction path
locks the activity, inserts the correction (an FK row lock on the original `Measurement`)
and then disputes the bill, so a bill-first certifier deadlocks against it exactly as it
did against `stock.reverse`. The rule is now stated over EVIDENCE rather than over lots,
which is why step 2 above is one step covering both families rather than two steps at
different altitudes.

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

## Codex round 1 — six findings, all fixed forward

| # | Sev | What was wrong | Where the fix lives |
|---|---|---|---|
| 1 | P1 | Certification took the BILL before the LOTS, while `stock.reverse` takes the LOT and then disputes the bill — a real deadlock, not a theoretical one | `certify` adopts the reversal's order; the unlocked plan is re-derived under the bill lock and a divergence is a 409 |
| 2 | P1 | A standalone supersession left `VendorBill.status = 'certified'` with no live certificate — a bill claiming to be payable whose `readCertificate` 404s | `phase5_t5_certificate_projection_check`, a BICONDITIONAL fired at COMMIT from BOTH `BillCertificate` and `VendorBill` |
| 3 | P2 | The consumption FK proved the stock row existed, not that it was an `acceptance` on a line this bill claims | `phase5_t5_consumption_evidence_check`, one function |
| 4 | P2 | Same on the labour side: a CORRECTION row could be frozen as evidence | …the same function, second caller |
| 5 | P2 | §I read every positive accepted row on the line, so a store user whose acceptance an earlier certificate had already consumed was refused for evidence this act does not rest on | `drawAcceptances` decides once; §I reads the draw and the freeze writes it |
| 6 | P2 | Approver standing was a direct read of the orgs-owned `Membership`, missing the org owner/admin PMC fallback | `OrgsParticipant.hasProjectRoleStanding` with `forUpdate` |

**Every one is RED before its fix**, and finding 1's probe had to be fixed twice before it was
evidence: the first draft used a 300 ms sleep and passed against the *old* order, because
certification had not yet reached its lock when the holder released. The barrier is now
condition-based (`pg_stat_activity`) with an explicit acquisition signal, and against the old order
it fails in 2.7 s with PostgreSQL error **40P01, deadlock detected** — the exact defect, named by
the database.

Two of these are the roots this phase keeps paying for. Finding 1 is root A pointing outward: a
total lock order is a property of the SYSTEM, and the module arriving later adopts it rather than
asserting its own §0b rule locally. Finding 5 is the gap between a docblock and its code — the
method's own comment already said "the rows consulted are exactly the ones this certificate is
about to freeze", and it consulted a strictly larger set. Fixing it by computing the draw ONCE and
having three readers share it is root H.

## Codex round 2 — four findings, one root

All four are the same defect at four angles: **a row seal cannot see an absence.** Round 1's
findings 3/4 asked "does this prove the row is the right row", I built a per-row validator that
answered exactly that, and every question about the CERTIFICATE as a whole stayed unaskable in the
place I had put the check — is it complete (F1), is it attributable (F2), is it about the current
claim (F4) — while identity said nothing about quantity (F3).

The closure is ONE deferred `phase5_t5_certificate_complete_check`, fired from `BillCertificate` and
from `VendorBillVersion`, plus the quantity bound added to both arms of the per-row seal. The full
reasoning, and the diagnostic that would have caught it in round 1, is in
`docs/reviews/pr-279-convergence.md`.

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
