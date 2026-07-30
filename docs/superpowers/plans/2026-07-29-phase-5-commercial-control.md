# Phase 5 — Commercial Control

Budget, commitment, measurement, vendor bills, three-way verification, certification,
payment approval, payment status and cash forecast — every amount traceable to
operational evidence Phases 1–4 already made canonical.

## Phase Intent (restated per the spec's Phase Intent Map, row 5)

**Why it exists.** Vendor bills and payments cannot be trusted without approved orders,
accepted delivery, measured work and certification. Today the project has all of the
operational evidence and none of the commercial conclusion: a PO line knows its frozen
rate and its `receivedQty`, a stock ledger knows what was physically accepted, a labour
PO line knows its committed person-shifts and `LabourWorkFact` knows the minutes actually
worked — and nothing joins them to what a vendor has claimed, what a PMC has certified, or
what has been paid. That join is currently a spreadsheet, and a spreadsheet cannot be
audited against the site.

**Operational outcome.** Budget, commitment, measurement, bill verification, certification,
payment approval, payment status and cash forecast all trace to operational evidence. A
commercial manager can answer "what is committed, billed, certified, payable and paid?"
(spec §21) from records, per PO line, with the evidence attached.

**Why this order matters.** External parties must not receive self-service commercial
access until internal controls and authority are proven. Phase 6 (supplier/contractor
portals) exposes exactly these records to the counterparty; they must be correct and
authority-bound first.

**Facts unlocked for Phase 6.** A vendor-scoped commercial record set — the bills that
vendor submitted, their verification exceptions, their certification status, their payment
status — plus the SoD and approval-limit machinery that decides what a guest may do.

## Facts consumed from earlier phases (never rebuilt)

Phase 5 owns no operational fact. Every input below is already canonical, already
independently cleared, and is read through its owner's query contract or participant —
never by a Prisma read across a module boundary.

| Fact | Owner | What Phase 5 takes from it |
|---|---|---|
| `PurchaseOrderLine` — frozen `rate`/`taxAmount`/`freightAmount`/`landedAmount`/`committedAmountBase`/`approvedOverage`, `receivedQty`, four-FK provenance to the approved comparison's selected quote line | procurement | the ORDERED side of three-way verification, and the committed amount (read, never copied into a second ledger) |
| `LabourPurchaseOrderLine` — frozen `ratePerPersonShift`/`shiftPremium`/`committedAmountBase`, `committedQty` | procurement (labour commercial documents) | the ordered side for labour bills |
| `StockTransaction` acceptance/rejection rows with evidence; `MaterialIssue`; consumption | inventory | the ACCEPTED side: what physically arrived and passed |
| `LabourWorkFact` (worked minutes), `LabourAttendance` (headcount) | labour | the effort side of a labour measurement |
| `ActivityWorkOutput` (`quantity`, `uom`, evidence media) | activities | the OUTPUT side of a measurement |
| Closing inspection sign-off; `Activity.status = done` | inspections / activities | the gate on measuring work as complete |
| `CommandExecution` ledger, `DomainEvent` envelope, transactional outbox, rebuildable projections, `ProjectCapability`, `lockProjectReadiness`, module registry + boundary analyzer | platform | the same discipline every phase since 2 has used |

## Current-State Revalidation (against `main` @ `e5b6bd9`)

Verified directly, not from narrative:

1. **No commercial module exists.** `apps/api/src/*/​*.manifest.ts` lists 13 modules; none
   is `commercial`. There is no budget, bill, certification, or payment model in
   `prisma/schema.prisma` (100 models).
2. **Committed amounts already exist and are frozen.** `PurchaseOrderLine.committedAmountBase`
   and `LabourPurchaseOrderLine.committedAmountBase` are `Decimal(18,2)`, column-freeze
   triggered, and provenance-bound to the approved comparison's selected quote line
   (Phase-3 F4 completion, PR #196; Phase-4 Task-2 correction F4, PR #221). **Phase 5 must
   not create a second committed-amount ledger.**
3. **Received progress already exists.** `PurchaseOrderLine.receivedQty` is appended by the
   inventory receipt path through `ProcurementParticipant` under the PO-line lock (Phase-3
   Task 4). `LabourPurchaseOrderLine.committedQty` is the labour analogue.
4. **The module graph is a DAG with `inventory`, `labour`, `decisions` as leaves,
   `activities` depending on them, and `procurement` depending on `activities`.** A
   `commercial` module that reads procurement, inventory, labour and activities is a SINK —
   nothing depends on it — so the graph stays acyclic by construction. `module-registry.test.ts`
   enforces this and must be extended, not weakened.
5. **Decimal discipline is established, not assumed.** Phase-4 Task 5 finding F-E required
   `Prisma.Decimal` end-to-end for productivity because float64 corrupts a full-scale
   `Decimal(18,6)`. Money arithmetic inherits that requirement without argument.
6. **No drift found.** Every anchor cited above was read at `e5b6bd9`.

## Architecture

### §0. Canonical evidence sets — defined once, referenced by name

Every quantity and amount in this phase is a fold over rows, and the review of the first
two heads found the same defect at six different sites: each fold described *where to look*
and re-derived *which rows count* locally, so each got it wrong in its own way. The sets
below are therefore defined once, here, and **every bound in §G and every side of the §E
triple references them by name. No fold restates a filter inline.**

| Set | Definition | What it must NOT be |
|---|---|---|
| `ACCEPTED(poLine)` | Σ qty of `acceptance` movements on that line's lots, MINUS Σ qty of reversals whose target is an acceptance row | NOT `accepted − rejected` (disjoint arms; understates an 80/20 split as 60). NOT the `acceptedOnHand` bucket balance: issuing moves `acceptedOnHand → issuedToActivity`, so accept-100-then-issue-100 reads 0 and fails an honest bill, while a cycle-count `stock.adjust` INTO that bucket would read as billable delivery with no receipt behind it. Acceptance is an EVENT, not a balance. |
| `MEASURED(poLine)` | Σ quantity of live `Measurement` rows for that line (corrections are signed deltas, so they fold in), and the fold may never go NEGATIVE — a correction taking it below zero is refused under the same lock as the positive cap | not a stored total, and never negative: recording 100 then correcting −150 leaves −50 and permanently fails `BILLED_QTY ≤ MEASURED` for work that was actually done |
| `EFFORT(poLine)` | work facts joined through `WorkerAllocation → CapacityCommitment → LabourPurchaseOrderLine` to THIS line, each unit consumable by at most one PO line | NOT matched on fingerprint and slice alone: two vendors can hold the same `labourSpecFingerprint` on the same activity and day, and A's work fact would then be consumable by B's bill while A stays unbillable. The join must reach the exact PO line through the commitment that funded the allocation. |
| `OUTPUT(poLine)` | the cited `ActivityWorkOutput` quantity REMAINING after every other line's measurements have drawn it down — output is consumable exactly once across all lines and all measurements | NOT the activity's total output: with one 100 sqm output and two output-priced lines in sqm, each line passes a per-line cap of 100 and 200 sqm gets certified from one 100 sqm fact |
| `BUDGET(costHead)` | the amount of the LIVE budget version only | not Σ over the immutable revision rows — a ₹100 line revised to ₹120 would forecast ₹220 — and not an arbitrary row, which leaves the forecast at the superseded ₹100 |
| `BILLED_QTY(poLine)` | Σ **quantity** over LIVE claim lines | see the live rule below |
| `BILLED_TAX(poLine)` / `BILLED_FREIGHT(poLine)` | Σ claimed tax / freight over the same LIVE claim lines | see the pro-rata cap in §E — a line-level frozen amount is never compared whole against a partial bill |
| `BILLED_AMOUNT(poLine)` | Σ **money** over the same LIVE claim lines | — |
| `BILLED_AMOUNT(bill)` | Σ money over THIS BILL's live claim lines | a certificate caps against the bill it certifies, never the PO line: with two live ₹100 bills on one line the po-line fold is ₹200, so a ₹150 certificate on a ₹100 bill would pass |

`BILLED_QTY` and `BILLED_AMOUNT` are separate names on purpose. One "billed" set used as
both would be compared against `qty + approvedOverage` in one bound and against a
certificate in another, and whichever unit the implementation picked, the other bound would
silently compare rupees to units. A set carries exactly one unit.

**LIVE**, for both billed sets: the bill version is not superseded AND the bill status is
neither `draft` nor `rejected`. NOT "every earlier non-rejected line" (double-counts a
retained amended version as 200). NOT "`submitted` only" — a first claim that advances to
`verified` would drop out of the fold and a second claim for the same quantity would pass.
Live spans the whole post-submission lifecycle.

| `CERTIFIED(bill)` | the LIVE certificate only | not Σ over superseded certificates, which double-counts a corrected certification and either blocks a valid correction or overstates the forecast |
| `COMMITTED(costHead)` | the OUTSTANDING obligation: Σ `committedAmountBase` over attributions whose PO version is LIVE, MINUS the portion already consumed AND MINUS the portion released — for a material line the consumed part is the PRORATED LANDED amount for `ACCEPTED` (`committedAmountBase × ACCEPTED / qty`), NOT `rate × ACCEPTED`, because `committedAmountBase` includes tax and freight and rate-only leaves that remainder stranded; for a LABOUR line the measured person-shifts at the frozen rate plus shift premium, since a labour line has measurement rather than acceptance evidence; the RELEASED part is the unreceived remainder of a version closed short (Phase-3 `pos.closeShort` / Phase-4 close-short keeps only the received portion) | not the gross frozen amount — a ₹100 PO accepted but not billed would sit in `committed` AND `received-not-billed` at once, forecasting a ₹200 obligation from a ₹100 order. The §J buckets must partition the money, not overlap it. Not "one active attribution per line": an amendment retains v1's line and issues v2's, so both attributions could be active; an attribution is superseded atomically with the PO version it describes. And a released remainder is subtracted ONCE and never added back: a ₹100 PO closed short before any receipt has ₹0 outstanding, because the practice explicitly cancelled that obligation — carrying the released ₹100 would forecast a payable for work nobody will do and nobody can bill. Closing short to zero is the deliberate way to end an obligation; the fold must honour it. |

The shared shape: **an amendment retains history, so "every row" is never the answer; and a
bucket balance is a current state, so it is never evidence of a past event.** A new fold
that cannot be expressed with one of these names is a signal that a set is missing, not a
licence to write a local filter.

### §A. Money identity and arithmetic

- One currency for the pilot (INR). No currency column, because a nullable/defaulted one
  invites a second currency without the conversion machinery to make it correct. Adding
  multi-currency is a later phase with its own rate-source and rounding decisions.
- Every amount is `Decimal(18,2)`. Every quantity keeps its own scale (`Decimal(18,6)` for
  material base units, `Int` for person-shifts) — the Phase-4 rule that distinct fact
  families keep distinct units applies to money too.
- **All arithmetic in `Prisma.Decimal` end to end.** No `Number()` on a money value at any
  point, including in read projections and the frontend. A full-scale probe that float64
  demonstrably corrupts is a required plan probe.
- Rounding is stated once: half-up at 2 decimals, applied only where a value is persisted,
  never mid-computation.

### §B. Budget (`BudgetLine`)

- A budget line is a project-scoped PLAN with an amount and a scope key. Scope is
  `(projectId, costHead)` where `costHead` is a project-contained code from a
  commercial-owned `CostHead` table — NOT the activity id and NOT the location node.
  Binding budget to an activity would make a schedule edit a budget edit; the two must be
  able to move independently.
- Budget lines are **versioned and immutable** (spec §97). A revision APPENDS a new version
  retaining the prior verbatim, with an attributable reason. There is no in-place edit.
- A budget line does not gate anything. Exceeding budget produces a flagged exception on the
  commitment and an Inbox action; it never blocks a PO, because stopping site supply over a
  planning number is the wrong failure mode. Whether an over-budget commitment requires a
  stronger authority is a §I approval-limit decision, not a hard block.

### §C. Commitment — consumed, never rebuilt

The committed amount for a PO line already exists, frozen, with provenance. Phase 5 reads
it through `ProcurementQuery` and attributes it to a cost head through a commercial-owned
`CommitmentAttribution` row: `(poLineId | labourPoLineId) → costHead`, re-attributable with
an attributable reason — but **never revocable to nothing**. A bare revocation would drop a
live vendor obligation out of every budget and forecast: revoke Head A as miscoded, and
`COMMITTED(A)` falls to zero while no other head picks the payable up. Re-attribution is
therefore an ATOMIC REPLACEMENT in one transaction, and a partial unique enforces exactly
one active attribution per live PO line version, so a live line can never be unattributed. The attribution is the ONLY new fact; the amount is not copied.

One active attribution per LINE is not sufficient, because a PO amendment retains v1's line
and issues v2's: both attributions stay active and the committed total reads ₹200 for a
₹100 order. The fold is `COMMITTED(costHead)` (§0) — restricted to attributions whose PO
version is live — and an amendment supersedes the prior attribution in the SAME transaction
that issues the new version, so the two can never both be live.

This is the Phase-4 §C lesson applied to money: a second ledger holding the same number is
a second truth, and the two will diverge under amendment.

### §D. Measurement — a billing fact, distinct from the operational work fact

`ActivityWorkOutput` records what was physically produced. `LabourWorkFact` records minutes
worked. Neither is a measurement for payment: a measurement is a **contractually agreed
quantity at a contract rate, taken by a named person on a named date, against a named PO
line**. It has a different unit, a different authority and a different lifecycle.

- `Measurement` is commercial-owned, immutable once taken, and carries: the PO line, the
  measured quantity in the PO line's UOM, the measurement date, the taker, evidence media,
  and — for work measured against an activity — the activity reference validated through
  `ActivityParticipant`.
- A measurement against an activity requires that activity to be `done` with its closing
  sign-off. Measuring incomplete work for payment is exactly the failure Phase 1 existed to
  prevent. **The status must be read under the activity/root row lock, not by a plain
  query.** `ActivityParticipant.revertSignOff` can move `done → in_progress` when a closing
  inspection is rejected, so an unlocked read admits: measurement sees `done`, the rejection
  commits, the immutable measurement commits anyway, and a bill later rests on work whose
  sign-off was withdrawn. The guard runs inside the locked participant — the same discipline
  §E uses for the accepted side.
- **A measurement is BOUNDED BY operational evidence, not merely permitted by a status.**
  Sign-off alone would let a commercial actor author the only quantity evidence in the
  chain — a 100-unit measurement against an activity with no recorded output — and
  verification would then certify from commercial input rather than from the Phase-1–4
  facts this phase exists to consume. So:
  - a measurement MUST cite at least one `ActivityWorkOutput` for that activity, read
    through `ActivitiesQuery`. What that citation BOUNDS depends on how the line is priced,
    because the two contract shapes measure different things:
    - **priced by output quantity** (a rate per sqm, per rm, per unit): the cap is
      `MEASURED(poLine) ≤ OUTPUT(poLine)` (§0) in the SAME UOM — the cited output NET of
      what other lines' measurements have already drawn, because one 100 sqm output must
      not fund two lines' 100 sqm claims; a UOM mismatch is a refusal, never a silent
      conversion;
    - **priced per person-shift**: the billable unit is person-shifts and the output is
      recorded in a physical unit, so a same-unit cap is not merely wrong but unsatisfiable
      — it would refuse a valid attended shift whenever progress is recorded in sqm, or
      push teams to fabricate person-shift outputs to bill. Here the cited output is
      REQUIRED AS EVIDENCE that work happened, and the QUANTITY cap is
      `MEASURED(poLine) ≤ EFFORT(poLine)` (§0) — effort matched to that line's own
      `labourSpecFingerprint` and slices, each unit consumable once, so one trade's
      attendance can never fund another trade's bill on the same day;
  - the bound is re-derived under lock at measurement time AND re-checked at certification,
    because an output can be superseded after a measurement is taken.
- A correction is a new measurement carrying a signed delta and a reason, never an edit.
  The measured total is a fold, with no stored balance — the Phase-3 §C rule.
- **Material lines are not measured.** For a material PO line the accepted quantity IS the
  measurement: `ACCEPTED(poLine)` per §0 — acceptance movements net of acceptance reversals,
  read through `InventoryQuery`. A parallel manual measurement of delivered material would
  be a second truth about the same physical event.

### §E. Three-way verification — derived, never stored

`verifyBill(tx, billId)` computes, per bill line, the triple:

| Side | Material line | Labour line |
|---|---|---|
| ORDERED | PO line frozen `qty` + `approvedOverage`, at frozen `rate` / `taxAmount` / `freightAmount` | PO line `personShiftQty` at frozen `ratePerPersonShift` + `shiftPremium` |
| ACCEPTED / MEASURED | `ACCEPTED(poLine)` (§0) via `InventoryQuery` | `MEASURED(poLine)` (§0) |
| BILLED | this bill line's quantity × rate + its claimed tax and freight, plus `BILLED_QTY(poLine)` / `BILLED_AMOUNT(poLine)` (§0) for the rest | same |

Each side is the §0 set by name. Restating any of those filters here is exactly the drift
that produced two rounds of findings.

**Tax and freight are prorated, never compared whole.** The PO line freezes a LINE-level
`taxAmount` and `freightAmount` for the full ordered quantity, so a 50-unit bill against a
100-unit PO carrying ₹1,800 tax and ₹500 freight legitimately claims ₹900 and ₹250.
Comparing either against the full frozen figure disputes an honest partial bill; comparing
neither lets two 50-unit bills each claim the whole ₹1,800. The cap is cumulative and
pro-rata: `BILLED_TAX(poLine)` and `BILLED_FREIGHT(poLine)` (§0) may not exceed the frozen
amount scaled by `BILLED_QTY / qty`, with §A's rounding applied once at the line.

The verdict is `matched | exception`, with each exception naming its own kind
(`qty-over-ordered`, `qty-over-accepted`, `rate-mismatch`, `tax-mismatch`,
`freight-mismatch`, `duplicate-claim`). Freight is compared, not merely carried: the
ordered side freezes `freightAmount`, so a bill matching on quantity, rate and tax while
inflating freight would otherwise reach certification unexamined.

The triple is **recomputed at every state transition that depends on it** — submission,
verification and certification — never read from a stored column. A stored verdict is a
stale verdict the moment a receipt is reversed.

**Recomputation must lock the evidence it reads, not only the PO line.** The accepted side
lives in the inventory ledger, and `stock.reverse` locks the stock LOT — it never takes the
PO-line lock. Locking only the PO line therefore admits: certification reads 100 accepted,
a concurrent reversal commits the acceptance to 0, certification commits on the stale 100,
and a bill becomes payable with no accepted material behind it. So certification acquires,
in this stable order to stay deadlock-free:

1. `lockProjectReadiness(projectId)`
2. every contributing stock lot, ascending by id, through a new
   `InventoryParticipant.lockAcceptedEvidence(tx, poLineId)`
3. the PO line (`FOR UPDATE`)
4. for labour, the contributing measurements and their cited work outputs

and re-reads every side inside that lock before deciding.

**The converse direction needs a channel too.** Recomputing on bill-side transitions cannot
see an inventory correction that lands AFTER certification: inventory does not depend on
commercial, so `stock.reverse` commits freely and leaves a certified, payable bill whose
`ACCEPTED(poLine)` is now zero. The reversal must therefore ask, in its own transaction,
through a new `CommercialParticipant.assertAcceptanceReversible(tx, poLineId, acceptanceTxIds)`
— the TARGET ROWS, not an aggregate quantity. Certification freezes WHICH acceptance rows it
consumed (a `CertifiedAcceptanceConsumption` set, append-only), and the participant refuses a
reversal of any row in a live certificate's set. An aggregate check would let the evidence be
swapped after the fact: certify 100 against acceptance A recorded by store user X, accept
another 100 by user Y, then reverse A — the aggregate is still 100 so the reversal passes, and
the payable certificate now rests on different rows, by a different actor, than the §E triple
and the §I SoD rule ever evaluated. Identity, not quantity —
`inventory.workflowParticipants` gains `commercial`, a participant edge, cycle-exempt
exactly as the media-delete and receipt-progress edges already are. The participant REFUSES
a reversal that would drop `ACCEPTED` below the live certified quantity, naming the
certificate; the operator path is to supersede that certificate first (and reverse the
payment where money moved), then reverse the acceptance. This is the `assertMediaDisposable`
precedent applied to money: evidence a payable fact rests on cannot be withdrawn while that
fact stands.

**The labour side needs the identical channel, for the identical reason.** A measurement cites
an `ActivityWorkOutput` and rests on a closing sign-off, and both can move after
certification: Activities can supersede the cited output, and `revertSignOff` can withdraw the
sign-off when a closing inspection is rejected. Either would leave an append-only certificate
payable against evidence that no longer stands. So `activities.workflowParticipants` gains
`commercial` too, and superseding a cited output or reverting a sign-off asks
`CommercialParticipant.assertWorkEvidenceRevisable(tx, activityId, outputIds)`, which refuses
while a live certificate consumes that evidence and names the certificate. The frozen
consumption set covers cited outputs exactly as it covers acceptance rows — one rule, both
sides. Fixing the material direction alone was the omission this finding names.

**That order is not a free choice — it must match what inventory already does.** Every
inventory write today runs `lockProjectReadiness → lockLot → applyReceiptProgress`, and
`applyReceiptProgress` is what takes the PO line; `receipts.reject` and receipt reversals
included. Locking the PO line first would invert that: certification holds the PO line and
waits for a lot while a concurrent rejection holds that lot and waits for the PO line, and
both hang. Commercial adopts the established order rather than asking four cleared modules
to migrate to a new one. The barrier probe therefore covers rejection and receipt reversal,
not only acceptance reversal.

An exception does not auto-reject. It moves the bill to `disputed` and requires a
responsible review with an attributable reason to proceed — spec §16, "Exceptions require
responsible review."

### §F. Bill lifecycle and immutable versions

```text
draft → submitted → under-verification → { verified | disputed }
disputed → under-verification            (after a resolved exception)
verified → certified → approved-for-payment → { part-paid → paid }
draft | submitted | under-verification |
  disputed | verified → rejected            (attributable reason required)
```

Rejection stops at `verified`. A certified bill has produced append-only payable facts — the
certificate, and possibly an approval or a part payment — and §0 removes every `rejected`
bill from the billed sets, so rejecting one would free its accepted quantity for a second
bill while the certificate that consumed it still stands. Past certification the correction
path is a superseding certificate (and, where money moved, a reversing payment record), each
attributable, never a status flip that makes the prior facts orphans.

- Every transition is a CAS `updateMany(id, projectId, expectedStatus)` — a deterministic
  409 on a concurrent second attempt, the Phase-3/4 machine.
- A `VendorBill` carries immutable versions exactly like `PurchaseOrder`: an amendment
  issues a NEW version retaining the prior verbatim with `supersedesVersion` lineage.
  Certificates are immutable versions in the same sense — a certificate is never edited,
  only superseded with a reason.
- **An amendment is admissible only BEFORE certification** — `submitted`, `verified` or
  `disputed`, and never once a live certificate exists. CAS-guarded on that status set, so a
  concurrent certification and amendment cannot both commit. §0 removes a superseded version
  from `BILLED_AMOUNT(bill)`, so amending a certified bill orphans every payable fact that
  rests on it: certify a live ₹100 bill, amend to a ₹50 version, and the ₹100 claim lines are
  no longer live while the ₹100 certificate, its approval and any payment row still stand —
  the bill is simultaneously in breach of bound 3 and payable against a claim that has been
  withdrawn. The correction path after certification is the one §F already states for every
  post-certification change: supersede the certificate with a reason (reversing the payment
  where money moved), which returns the bill to an amendable status, and only then amend. One
  rule, so the append-only chain is never left resting on a retired claim.
- `certified`, `approved-for-payment` and every payment row are **append-only at PG**, with
  the same trigger discipline the §C ledger and the promise registers already use.
- A bill line is FK-bound to its PO line by a composite FK carrying **both `projectId` and
  `vendorId`**. A same-project FK alone only stops a cross-project line: both PO roots carry
  their own `vendorId`, so within one project Vendor A's bill could name Vendor B's PO line,
  pass the ordered and accepted checks, and attribute a payable amount to the wrong
  counterparty. Binding the vendor makes that unrepresentable rather than merely unlikely.

### §G. Conservation bounds (the §F-bounds analogue, one per hand-off)

Each is re-derived in-service under `FOR UPDATE` on the constraining row AND sealed by a
PostgreSQL constraint — the Phase-4 Task-3 F3 lesson: a trigger that counts without
serializing is not an invariant.

1. `BILLED_QTY(poLine)` ≤ `qty + approvedOverage` (materials) / `personShiftQty` (labour)
2. `BILLED_QTY(poLine)` ≤ `ACCEPTED(poLine)` (materials) / `MEASURED(poLine)` (labour)
3. `CERTIFIED(bill)` ≤ `BILLED_AMOUNT(bill)` — the BILL-scoped set (§0), never the po-line one
4. `Σ approved-for-payment` ≤ `NET_PAYABLE(bill)` = `CERTIFIED(bill)` − unreleased deductions
   (§H fold: retention + advance recovery + penalties, minus releases)
5. `Σ paid` ≤ `Σ approved-for-payment`

Bound 4 is NET, not gross. Capping approval at the gross certificate would let a ₹100
certification carrying a ₹10 retention approve and pay the full ₹100, which makes the §H
deduction ledger decorative — it would record a withholding that never withheld anything.

Every left- and right-hand side is a §0 set. Bounds 3–5 use the LIVE certificate for the
same reason the billed side uses live claim lines: a superseded certificate is retained
history, and summing it would read a corrected ₹100 certification as ₹200 — blocking the
correction or overstating the forecast.

Bound 2 is the one that makes the phase worth building: it is structurally impossible to
bill for material that never arrived or work never measured.

### §H. Deductions — retention, advance recovery, variations

- A deduction is a **ledger row against a certification**, never a column on it. Types:
  `retention`, `advance-recovery`, `penalty`, `other`. Each carries an attributable actor, an
  amount, and — for `other` and every penalty — a reason.
- **Deduction rows are append-only at PostgreSQL, exactly like certificates, approvals and
  payments**, and they join §F's append-only list. They determine `NET_PAYABLE` directly, so
  a row that could be updated or deleted is a withholding that never withheld anything: on a
  ₹100 certification with a ₹10 retention, quietly dropping that row raises net payable to
  ₹100 with no attributable release. A correction is a release row, never an edit.
- **Every reason column carries the repository's non-blank discipline** — `btrim` over the
  complete ASCII whitespace set (`E' \t\n\x0B\f\r'`), the rule Phase-4 Task 5 established
  after `btrim` alone let whitespace through. Presence is not justification: a deduction of
  type `other` with `reason = '   '`, or a whitespace bill rejection, would otherwise satisfy
  every stated check and leave append-only evidence with no usable reason. This applies to
  deduction reasons, rejection reasons, budget revision reasons, attribution reasons and
  override reasons alike.
- Retention release is its own append-only row with its own authority; the retained balance
  is a FOLD over `retention` minus `retention-release`, with **no stored balance column** —
  the Phase-3 §C rule that produced a correct stock model.
- Advance recovery folds against an `advance` row created when the advance is paid, and can
  never recover more than was advanced (a bound, enforced like §G).
- A variation is a PO amendment (procurement's existing machine), not a commercial fact.
  Phase 5 reads the amended PO version; it does not invent a parallel variation document.

### §I. Authority, segregation of duties, approval limits

- New permissions: `commercial.read`, `commercial.measure`, `commercial.verify`,
  `commercial.certify`, `commercial.approve-payment`, `commercial.record-payment`.
  Certification and payment approval are deliberately separate.
- **SoD is a rule, evaluated server-side, with a named exception path** (spec §422). The
  rule ships as: the actor who took a measurement may not certify the bill that consumes it,
  and the actor who certified may not approve payment. **For a material bill there is no
  `Measurement` row (§D), so the ACCEPTANCE actor is the measurer** — the store user who
  recorded `receipts.accept` for a delivery may not certify the bill consuming that
  acceptance. Without this the rule would bind labour bills and silently exempt material
  ones, which is the larger spend. An exception requires a stronger
  authority (org admin) AND writes an attributable `SodException` record naming the rule,
  the actor, the approver and the reason. Silently allowing it is not an option; silently
  banning it is not either, because a two-person practice must still be able to operate.
- **A `SodException` is trusted evidence, so it carries the trusted-evidence seals**, not
  merely a requirement that the row be written. It IS the thing that makes an otherwise
  forbidden certification or payment approval valid, and an override whose justification can
  be rewritten afterwards is indistinguishable from no override at all. So: append-only at PG
  (UPDATE and DELETE both rejected, the same trigger discipline as the certificate and payment
  rows); `rule`, `actorId`, `approverId` and `reason` immutable after write with `reason`
  under the complete non-blank CHECK (`btrim(x, E' \t\n\x0B\f\r')`); written in the SAME
  transaction as the override it authorizes; and bound to that exact fact by a composite FK
  carrying `projectId` — an exception is authority for ONE certificate or ONE approval, never
  a standing waiver a later override can point at. Without these, the material case is:
  the acceptance actor certifies under an override, then the approver or reason is edited or
  the row deleted, and the append-only certificate stays payable with no immutable authority
  evidence behind it — the exact shape the Phase-4 `T3CRepairAction` seals exist to prevent.
- Approval limits are per-membership amount ceilings applied to the **cumulative** approved
  total for the bill, not to each approval row. A per-row check lets a ₹50-limit approver
  authorize a ₹100 payable as two ₹50 rows — each within limit, bound 4 satisfied, the
  ceiling defeated. The guard serializes on the bill, folds what is already approved, and
  compares the actor's limit to the resulting total; crossing it escalates to a higher-limit
  holder and never silently succeeds.
- Every route enforces authorization server-side. UI visibility is convenience (spec §18).

### §J. Cash forecast — the EIGHTH rebuildable projection

`commercial.cash-forecast`, recompute-only, deriving NO domain events (a rebuild emits zero
events and zero notifications — the established projection contract). Buckets, exactly as
spec §16 names them and distinct by construction:

`budget` (= `BUDGET`) · `committed` (= `COMMITTED`, OUTSTANDING) · `received-not-billed` ·
`awaiting-certification` · `certified-payable` · `approved` · `paid`

The buckets PARTITION the money — no rupee appears in two of them. That is why `COMMITTED`
is defined as outstanding rather than gross (§0): a received-but-unbilled ₹100 order belongs
in `received-not-billed` and must not also be reported as `committed`.

`live == projection == rebuild` through ONE shared compute function, the discipline that
made the material and labour readiness projections correct.

### §K. Module graph — `commercial` is a SINK, and never gates operations

- `commercial.dependsOn: ['procurement', 'inventory', 'labour', 'activities']`;
  `workflowParticipants: ['inventory', 'activities']`. Every transaction-bound call must be
  DECLARED or Task 1 ships a manifest saying the call cannot happen — an undeclared one is a
  boundary escape the analyzer is built to catch, and taking the fallback plain read instead
  would reopen the very race the participant exists to close. Both outbound edges are
  load-bearing:
  - `inventory` — certification invokes `InventoryParticipant.lockAcceptedEvidence` (§E), or
    the stale-acceptance race reopens.
  - `activities` — a measurement validates `Activity.status = done` **under the activity/root
    row lock** through `ActivityParticipant` (§D). This edge is not optional: the fallback is
    an unlocked `ActivitiesQuery` status read, and §D already gives the interleaving that
    breaks it (measurement reads `done`, `revertSignOff` commits on a rejected closing
    inspection, the immutable measurement commits anyway). §E adds the same requirement for
    locking cited `ActivityWorkOutput` rows during certification. Declaring only `inventory`
    would leave §D and §E describing calls the manifest forbids.
- **Two INBOUND participant edges, because two foreign transactions must write commercial
  facts atomically with their own.** Neither is a `dependsOn` edge — nobody READS commercial
  — and participant channels are cycle-exempt (the cleared `activities → labour`,
  `media → inventory` precedent), so the acyclicity acceptance test still extends without a
  new exemption. `commercial` is a sink in the READ graph; it is not unreachable.
  - `procurement.workflowParticipants` gains `commercial`. §C requires an amendment to
    supersede the prior attribution in the SAME transaction that issues the new PO version,
    and that is a commercial-owned write performed from procurement's transaction:
    `CommercialParticipant.replaceAttribution(tx, poLineId, fromVersion, toVersion)`. Without
    the edge, amending a live ₹100 PO leaves the old attribution superseded with its version
    and the new live version unattributed until some later commercial command — so
    `COMMITTED` silently drops the whole vendor obligation out of every budget and forecast,
    which is exactly the "a live line can never be unattributed" invariant §C states. Cancel
    and close-short use the same channel to release.
  - `activities.workflowParticipants` gains `commercial` (already stated in §E) so that
    superseding a cited output or reverting a sign-off asks
    `CommercialParticipant.assertWorkEvidenceRevisable` first.
  - The manifest table Task 1 must produce is therefore: `commercial.dependsOn` = those four;
    `commercial.workflowParticipants` = `['inventory', 'activities']`;
    `procurement.workflowParticipants` and `activities.workflowParticipants` each gain
    `commercial`; nothing gains `commercial` in any `dependsOn`. A Task-1 acceptance test
    asserts that exact edge set and that a topological sort of the `dependsOn` graph
    succeeds.
- **No readiness gate consults commercial.** An unpaid bill, a breached budget and a
  disputed certification must never stop an activity from starting or a receipt from being
  accepted. Money follows the site; it does not command it. This is stated as an invariant
  and pinned by a test: enabling the commercial capability changes no readiness verdict.
- Foreign reads go through `ProcurementQuery` / `InventoryQuery` / `LabourQuery` /
  `ActivitiesQuery`; the boundary analyzer's nested-read detection (PR #216 F1) already
  catches an `include` that reaches a read-encapsulated foreign model.

### §L. Pilot activation

A `commercial` per-project `ProjectCapability`, the same mechanism as `materials` and
`labour`. Capability-off projects are byte-identical: no nav entry, no routes (404), no
rows, no events. The two-projects-one-org byte-identity proof is required, as it was for
both prior pilots.

### §M. Frontend surfaces

ONE capability-gated Commercial hub cloning the cleared Materials/Labour discipline: tabs
for budget · commitments · measurements · bills · certification · payments · cash forecast;
honest loading/unavailable/stale states; latest-request ownership; write-ahead durable
outbox with the two-key lifecycle (`idempotencyKey` for replay identity, `coalesceKey` for
pending dedupe) from PR #208/#209; per-action disable-while-pending; project-scope teardown.

## Required Execution Order and Review Stops

One PR per task, each within the 20-file / 1,500-line review budget, each riding the
draft → CI → exact-head Codex gate.

| Task | Scope | Review stop |
|---|---|---|
| 1 | `commercial` capability + module skeleton + `CostHead` + versioned immutable `BudgetLine` + SINK manifest + acyclicity test + §D/§L inertness proof | — |
| 2 | `CommitmentAttribution` over the EXISTING frozen committed amounts (§C) + budget-vs-committed exception + Inbox action | — |
| 3 | `Measurement` (§D) — immutable, delta corrections, activity sign-off gate, material lines read acceptance instead | **STOP** — narrow review before any bill can consume a measurement |
| 4 | `VendorBill` + lines + immutable versions + the §F CAS lifecycle **up to `under-verification`** + §G bounds 1–2 | — |
| 5 | Three-way verification (§E) — and therefore the `verified` transition itself — + dispute/resolution + certification + §G bound 3 + §H deduction ledger + **the §I measurer/acceptor-vs-certifier SoD rule** | **STOP** — narrow review before payment authority exists |

Task 4 deliberately stops SHORT of `verified`. `verified` is the state whose safety is the
§E verdict, so shipping the transition in Task 4 while §E lands in Task 5 would let a bill
reach `verified` before the ordered/accepted/billed comparison exists — and pulling §E
forward into Task 4 would bypass the Task-5 review stop that guards it. The transition
belongs to the task that produces its evidence.
| 6 | Payment approval + payment records + §G bounds 4–5 + the certifier-vs-approver SoD rule, approval limits and the exception record | — |

A control ships in the task that creates the transition it guards. The certification SoD
rule cannot wait for Task 6: a certificate is append-only and is already the payable basis,
so a self-certified one written in Task 5 could not be invalidated by a rule added later.
The same reasoning puts `verified` in Task 5 rather than Task 4.
| 7 | Cash-forecast projection (§J) + frontend hub (§M) + pilot acceptance chain + consolidated Phase-5 packet | **FINAL STOP** |

Task 3 and Task 5 stops are mandatory: measurement is the fact every downstream amount
rests on, and certification is the last point before money becomes payable.

## Required plan probes (reproduce-first, live PG unless noted)

1. §D byte-identity: two projects in one org, commercial off on one — response bytes,
   nav and routes unchanged; the commercial tables hold zero rows.
2. §K no-gate: enabling the commercial capability changes NO readiness verdict, in either
   direction, for material or team.
3. §A decimal: a full-scale `Decimal(18,2)` money chain that float64 provably corrupts.
4. §G bound 2: billing 101 units against 100 accepted is refused; an 80-accepted /
   20-rejected receipt supports a legitimate 80-unit bill (the bucket fold, not
   `accepted − rejected`, which would understate it as 60); reversing an acceptance after a
   bill is submitted moves that bill to `disputed` rather than silently passing.
5. §G bound 2 race: two concurrent bill submissions against one PO line with capacity for
   one — deterministic barrier, exactly one commits.
5b. §E certification vs `stock.reverse`, BOTH orderings under a deterministic barrier: a
   reversal committing mid-certification can never leave a certified bill with no accepted
   material behind it, and the stated lock order never deadlocks.
5c. §D measurement bound, both contract shapes: an output-priced measurement citing no
   `ActivityWorkOutput` is refused, one exceeding the recorded output is refused, and a UOM
   mismatch is refused rather than converted; a person-shift-priced measurement is accepted
   with a physical-unit output cited (no same-unit cap) but refused beyond
   `EFFORT(poLine)`; effort matched to trade A cannot fund a trade-B line on the same
   activity/day; the same effort cannot be consumed by two PO lines; and superseding the
   cited output after measurement blocks certification.
5h. §0 unit discipline: a ₹10,000 bill for 100 units satisfies bound 1 against
   `qty + approvedOverage` in UNITS and bound 3 against the certificate in RUPEES — neither
   comparison ever mixes the two.
5i. one 100 sqm output cannot fund two output-priced lines' 100 sqm measurements; a ₹100
   certification with ₹10 retention approves at most ₹90; a certified bill cannot be
   rejected to free its accepted quantity.
5j. §E post-certification reversal: after a 100-unit bill is certified, `stock.reverse` of
   that acceptance is REFUSED naming the certificate; superseding the certificate first
   permits the reversal. Both orderings under a deterministic barrier.
5k. §D measurement vs sign-off revert, both orderings under a barrier: a closing-inspection
   rejection committing mid-measurement can never leave a measurement standing against an
   activity whose sign-off was withdrawn.
5l. §E pro-rata: a 50-unit bill of a 100-unit PO with ₹1,800 tax / ₹500 freight passes at
   ₹900 / ₹250 and is disputed at ₹1,800 / ₹500; two 50-unit bills cannot each claim the
   full amounts.
5m. §I cumulative limit: a ₹50-limit approver cannot authorize a ₹100 payable as two ₹50
   rows; the second escalates.
5n. §0 `MEASURED` floor: recording 100 then correcting −150 is REFUSED, and the fold stays
   at 100 so later honest bills still pass.
5o. §J partition: a received-but-unbilled ₹100 order appears in `received-not-billed` and
   NOT in `committed`; the seven buckets sum to no more than budget + committed obligations.
5p. §0 `BUDGET`: a ₹100 line revised to ₹120 forecasts ₹120, never ₹220 and never ₹100.
5q. §E evidence identity: certify 100 against acceptance A, accept another 100, then reverse
   A — REFUSED naming the certificate, because the frozen consumption set holds A, not a
   quantity. The same for a cited `ActivityWorkOutput` superseded after certification and for
   a sign-off reverted after certification.
5r. §G bound 3 scope: two live ₹100 bills on one PO line — a ₹150 certificate on either is
   refused, because the cap is `BILLED_AMOUNT(bill)` and not the ₹200 po-line fold.
5s. §0 `EFFORT` vendor identity: two vendors with the same `labourSpecFingerprint` on one
   activity/day — A's work fact cannot support B's bill, and A stays billable.
5t. §J partition after tax/freight: a ₹1,000 line with ₹100 tax and ₹50 freight fully
   accepted leaves ₹0 in `COMMITTED`, not ₹150; a fully measured labour line likewise.
5u. §C attribution: re-attribution moves the whole obligation atomically, and a live PO line
   version can never be left unattributed (COMMITTED never silently drops to zero).
5v. §H seals: PG rejects UPDATE and DELETE of a deduction row; a whitespace-only reason is
   rejected on every reason column named in §H.
5w. §0 `COMMITTED` close-short: a ₹100 PO closed short before ANY receipt leaves ₹0
   outstanding — the released remainder is subtracted once and never added back, so no
   forecast bucket carries a cancelled obligation; a ₹100 PO with ₹40 accepted then closed
   short leaves ₹0 outstanding and ₹40 in `received-not-billed`, and the buckets still
   partition. The labour twin behaves identically.
5x. §K edge set: the Task-1 manifest matches the §K table exactly —
   `commercial.workflowParticipants` contains BOTH `inventory` and `activities`, and
   `procurement`/`activities` each list `commercial`. RED against a manifest declaring only
   `['inventory']`, which is the state in which §D's locked status read and §C's atomic
   re-attribution are calls the manifest forbids. A topological sort of the `dependsOn` graph
   still succeeds (participant edges are exempt).
5y. §C amendment channel: amending a live ₹100 PO through procurement replaces the
   attribution in the SAME transaction — `COMMITTED` reads ₹100 before and ₹100 after, never
   ₹0 in between and never ₹200; a cancel and a close-short release through the same channel.
   Under a deterministic barrier, a concurrent forecast read never observes an unattributed
   live line.
5z. §F amendment lifecycle: a `submitted`/`verified`/`disputed` bill amends; a CERTIFIED bill
   REFUSES to amend, naming the certificate; superseding the certificate first permits the
   amendment. Under a barrier, concurrent certify-and-amend admits exactly one, and neither
   ordering leaves a live certificate on a superseded claim version.
5aa. §I exception seals: PG rejects UPDATE and DELETE of a `SodException`; a whitespace-only
   reason is rejected; an exception written outside the override's transaction, or pointed at
   a second certificate, is refused — one exception authorizes one fact.
5g. §0 set identity: for each of the six sets, the "must NOT be" column is a probe — the
   80/20 acceptance, the accept-then-issue, the adjust-into-bucket, the amended bill, the
   advanced-lifecycle bill, the superseded certificate and the amended PO commitment each
   yield the stated correct total.
5d. §E billed side: an amended bill (v1 100 → v2 100) yields 100 billed, not 200 — a
   retained version is not a live claim.
5e. §E freight: a bill matching quantity, rate and tax while inflating freight raises
   `freight-mismatch`.
5f. §F vendor pinning: Vendor A's bill line naming Vendor B's PO line in the SAME project
   is rejected by PostgreSQL, not merely by the service.
6. §E recomputation: a stored verdict cannot authorize certification — a hostile stored
   `verified` on a bill whose acceptance was reversed still refuses to certify.
7. §F append-only: PG rejects an UPDATE/DELETE of a certification, a payment row and a
   superseded bill version.
8. §H fold: retention withheld then partially released nets correctly with no stored
   balance; over-release is refused.
9. §I SoD: the measurer cannot certify; for a MATERIAL bill the acceptance actor cannot
   certify either; an org admin may override; the override writes an attributable
   `SodException` naming rule, actor, approver and reason.
10. §J projection: `live == projection == rebuild`; a rebuild emits zero events and zero
    notifications; a stale forecast cannot authorize a payment.
11. Upgrade proof: every new table upgrades ROW-FREE over the legacy fixture; a coherent
    commercial chain is ACCEPTED (so the seals are precise, not merely strict); each
    hostile insert is rejected.

## Out of scope (Phase 5)

- Statutory accounting, GST returns, bank reconciliation, the general ledger (spec §65).
- Multi-currency.
- Supplier/contractor self-service access to these records — that is Phase 6.
- Accounting/RedBracket adapters — Phase 7, after their contracts are separately approved.
- Any change to a readiness gate, a Phase-1–4 migration, or an existing operational flow.

## Verification battery (every PR)

`pnpm check` EXIT 0 · full integration suite on a pristine migrated DB ·
`boundary.test.ts` + `module-registry.test.ts` + `cross-module-graph.test.ts` ·
`upgrade-proof.sh` · `test:e2e:api:allmodules` and `:outbox` · the task's reproduce-first
probes RED at the base commit before the fix.

## Vision alignment

**Real user problem.** A PMC pays vendors from a spreadsheet that no one can check against
the site. Nobody can answer, per order, what is committed, billed, certified, payable and
paid — so overbilling is found late or not at all, and honest vendors wait.

**Canonical fact owner.** The commercial module owns budget, attribution, measurement,
bills, certification, deductions and payment. It owns NO operational fact: ordered amounts
stay with procurement, accepted quantities with inventory, worked effort with labour,
produced output with activities.

**Downstream information flow.** Operational evidence → verification triple → certification
→ payable amount → cash forecast → (Phase 6) the vendor's own view of their claim.

**Human action removed.** The clerical join — copying order rates, receipt quantities and
measured work into a bill-checking sheet, and re-deriving the payable balance after every
deduction. Certification and payment approval remain human, and become harder to do
carelessly.

**Trust invariant protected.** No amount becomes payable without operational evidence that
it was ordered, delivered or measured, and certified by someone authorized to certify it —
and adding money to the system can never stop the site from working.
