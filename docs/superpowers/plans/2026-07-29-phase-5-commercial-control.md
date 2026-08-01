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
| `LabourPurchaseOrderLine` — frozen `ratePerPersonShift`/`shiftPremium`/`committedAmountBase`, `committedQty` | **labour** — verified against `labourManifest.ownsModels`, which owns the whole labour commercial chain (`labourRequisition` → `labourRfq` → `supplierLabourQuote` → `labourPurchaseOrder`/`Version`/`Line` → `capacityCommitment`/`capacityPromise`). An earlier revision of this row said "procurement", which is where §K's missing labour edges came from | the ordered side for labour bills |
| `StockTransaction` acceptance/rejection rows with evidence; `MaterialIssue`; consumption | inventory | the ACCEPTED side: what physically arrived and passed |
| `LabourWorkFact` (worked minutes), `LabourAttendance` (headcount) | labour | the effort side of a labour measurement |
| `ActivityWorkOutput` (`quantity`, `uom`, evidence media) | activities | the OUTPUT side of a measurement |
| Closing inspection sign-off; `Activity.status = done` | inspections / activities | the gate on measuring work as complete |
| `CommandExecution` ledger, `DomainEvent` envelope, transactional outbox, rebuildable projections, `ProjectCapability`, `lockProjectReadiness`, module registry + boundary analyzer | platform | the same discipline every phase since 2 has used |

## Current-State Revalidation (against `main` @ `a878356`)

Re-verified on this head, not carried forward from the prior draft: 13 module
manifests and none is `commercial`; 100 Prisma models with no budget, bill,
certification or payment model; both `committedAmountBase` columns still
`Decimal(18,2)`. Every claim below survived the re-check.

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
> **Review-unit note (this head).** PR #252 specified all seven tasks' invariants in
> one 1,661-line document and drew twenty rounds of correct findings — 8, 8, 7, 7, 9,
> 5, 10, 7, 7, 11, 7, 6, 12, 6, 11, 7, 8, 10, 7, 7 — that never fell, because every
> round found a real defect in a *different* task. Its own round-13 audit named the
> cause and the owner approved the remedy: keep the settled, cross-cutting, small
> parts here; move each task's mechanism into the PR that implements it, where code
> and probes answer the question instead of prose.
>
> This head executes that split. **No finding is dismissed and no text is rewritten.**
> §B–§I and the per-task probe list are carried VERBATIM into their task PRs; what
> moves is the place of verification, not the answer. The twenty rounds are preserved
> in `docs/reviews/pr-252-convergence.md` on the `claude/phase5-planning` branch and
> summarised in §N below.
>
> Kept here: §0 (canonical evidence sets), §0b (rule → site closure), §A (money
> identity), §K (module graph), §L (pilot), §M (frontend), the task table, the
> verification battery. 362 lines against the owner's 500-line ceiling.


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
| `EFFORT(poLine)` | work facts joined through `WorkerAllocation → CapacityCommitment → LabourPurchaseOrderLine` to THIS line, each unit consumable by at most one PO line, **NORMALISED into billable person-shifts before any comparison** — `LabourWorkFact` is worked-MINUTES (Phase 4), the bill is person-SHIFTS, and comparing them raw lets a 10-person-shift measurement satisfy `10 ≤ 480` from a single worker's one 480-minute day. The conversion is `Σ workedMinutes / shiftMinutes` for that project's shift definition, floored at the §A scale, and it happens INSIDE this set so no call site can forget it | NOT matched on fingerprint and slice alone: two vendors can hold the same `labourSpecFingerprint` on the same activity and day, and A's work fact would then be consumable by B's bill while A stays unbillable. The join must reach the exact PO line through the commitment that funded the allocation. |
| `OUTPUT(poLine)` | the cited `ActivityWorkOutput` rows that EXIST and belong to the measurement's own activity. This set is a **predicate, not a quantity**: it answers "is there recorded progress evidence for this measurement?" and is NOT drawn down. Nothing in Phase 5 caps a quantity against it | NOT a consumable pool. Output-priced pricing is out of scope (§D), so the only remaining role is evidence that progress occurred, and person-shift pricing legitimately measures several lines against ONE output: a mason line and a helper line both worked to produce the same 100 sqm, each capped by its OWN `EFFORT`. Drawing the output down for the first line would block the second, or push a team to fabricate a duplicate output row to bill honest attendance — inventing evidence to satisfy an accounting artefact. The quantity cap for labour is `EFFORT`, which IS conserved. And NOT "live (not superseded)": **Phase 4 shipped `ActivityWorkOutput` append-only at PostgreSQL (`ActivityWorkOutput_append_only`, BEFORE UPDATE OR DELETE) with no supersession path at all** — verified in `20270305000000_phase4_t5_reconciliation`. An earlier revision of this row assumed a lifecycle the owner module does not have, which would have forced Phase 5 to change an Activities operational fact this phase declares out of scope. Existence is the whole test. |
| `PAID(bill)` | Σ amount over that bill's payment rows MINUS Σ amount over its payment-reversal rows | NOT `Σ payment rows`: correcting a paid ₹100 down to ₹50 needs the fold to fall, and every append-only money row in this phase is strictly positive with the row TYPE carrying direction (§H), so a reversal is its own row type that SUBTRACTS here — never a negative payment (which the CHECK refuses) and never a second positive payment (which would read ₹150 paid). |
| `BUDGET(costHead)` | the amount of the LIVE budget version only | not Σ over the immutable revision rows — a ₹100 line revised to ₹120 would forecast ₹220 — and not an arbitrary row, which leaves the forecast at the superseded ₹100 |
| `BILLED_QTY(poLine)` | Σ **quantity** over LIVE claim lines | see the live rule below |
| `BILLED_TAX(poLine)` / `BILLED_FREIGHT(poLine)` | Σ claimed tax / freight over the same LIVE claim lines | see the pro-rata cap in §E — a line-level frozen amount is never compared whole against a partial bill |
| `BILLED_AMOUNT(poLine)` | Σ **money** over the same LIVE claim lines | — |
| `BILLED_AMOUNT(bill)` | Σ money over THIS BILL's live claim lines | a certificate caps against the bill it certifies, never the PO line: with two live ₹100 bills on one line the po-line fold is ₹200, so a ₹150 certificate on a ₹100 bill would pass |
| `CERTIFIED(bill)` | the LIVE certificate only | not Σ over superseded certificates, which double-counts a corrected certification and either blocks a valid correction or overstates the forecast |
| `APPROVED(bill)` | Σ amount over approval rows attached to the bill's LIVE certificate | NOT Σ over every approval row the bill ever collected. A certificate is superseded, not edited (§F), and its approvals were authorisations of THAT amount: certify ₹100, approve ₹100, supersede to ₹50, and a set spanning all rows reports ₹100 approved against a ₹50 net payable — a payable in breach of bound 4 the moment the correction lands, with the approval append-only so nothing walks it back. Scoping approvals to the live certificate makes supersession lower this set automatically and forces the reduced amount to be re-approved by someone with the authority for it. |
| `COMMITTED(costHead)` | the OUTSTANDING obligation: Σ `committedAmountBase` over attributions whose PO version is LIVE, MINUS the portion already consumed AND MINUS the portion released — for a material line the consumed part is the PRORATED LANDED amount for `ACCEPTED` (`committedAmountBase × ACCEPTED / qty`), NOT `rate × ACCEPTED`, because `committedAmountBase` includes tax and freight and rate-only leaves that remainder stranded; for a LABOUR line the measured person-shifts at the frozen rate plus shift premium, since a labour line has measurement rather than acceptance evidence; the RELEASED part is the unreceived remainder of a version closed short (Phase-3 `pos.closeShort` / Phase-4 close-short keeps only the received portion) | not the gross frozen amount — a ₹100 PO accepted but not billed would sit in `committed` AND `received-not-billed` at once, forecasting a ₹200 obligation from a ₹100 order. The §J buckets must partition the money, not overlap it. Not "one active attribution per line": an amendment retains v1's line and issues v2's, so both attributions could be active; an attribution is superseded atomically with the PO version it describes. And a released remainder is subtracted ONCE and never added back: a ₹100 PO closed short before any receipt has ₹0 outstanding, because the practice explicitly cancelled that obligation — carrying the released ₹100 would forecast a payable for work nobody will do and nobody can bill. Closing short to zero is the deliberate way to end an obligation; the fold must honour it. And it is CLAMPED AT ZERO, because `ACCEPTED` may legitimately exceed `qty`: §G permits receiving up to `qty + approvedOverage` while the Phase-3 PO snapshot froze `committedAmountBase` for `qty` alone. On a ₹100 / 100-unit line with 10 overage units accepted the raw consumed part is ₹110, so an unclamped fold reports −₹10 and that negative silently offsets OTHER cost heads' real obligations. Overage is money the practice authorised as QUANTITY, never as a frozen amount: outstanding goes to ₹0 and the overage value appears only in `received-not-billed` and the billed buckets, where it is backed by an actual bill. A negative commitment is not a discount. |

`BILLED_QTY` and `BILLED_AMOUNT` are separate names on purpose. One "billed" set used as
both would be compared against `qty + approvedOverage` in one bound and against a
certificate in another, and whichever unit the implementation picked, the other bound would
silently compare rupees to units. A set carries exactly one unit.

**LIVE**, for both billed sets: the bill version is not superseded, the bill status is
neither `draft` nor `rejected`, AND it is not an unresolved `disputed` version. NOT "every
earlier non-rejected line" (double-counts a retained amended version as 200). NOT
"`submitted` only" — a first claim that advances to `verified` would drop out of the fold and
a second claim for the same quantity would pass. Live otherwise spans the whole
post-submission lifecycle.

**Why `disputed` is excluded.** §E's own exception path is what creates it: 100 accepted, a
120-unit bill submitted, verification records `qty-over-accepted` and moves the bill to
`disputed`. If that version stayed live it would violate `BILLED_QTY ≤ ACCEPTED` on the spot
and reserve 120 of 100 units, so the honest corrected 100-unit claim could never be
submitted — the dispute would block its own resolution. A disputed version is a rejected
CLAIM whose history is retained, not an outstanding one. It re-enters the fold only when
resolved into a new live version. (The alternative — hard-rejecting an over-bound submission
before it becomes live — was considered and refused: it destroys the record of what the
vendor actually claimed, which is the evidence the dispute is about.)

### §0b. Rule → site closure (read this before writing any task)

Six rounds of review on this plan produced one repeated failure that is worth naming
structurally, because it will recur in the implementation otherwise: **a rule was stated
correctly and then applied at one site while an identical sibling site was left alone.** Five
of round 6's ten findings are exactly that — the amendment channel without the issuance
channel, the measurement lock without the certification lock, the zero floor without the
live-consumption floor, the SoD rule one task ahead of its own exception record, the consumed
formula without the overage clamp.

So each rule below is stated once with its COMPLETE site list. A task that touches any site in
a row owes every site in that row, and the row is the acceptance criterion.

| Rule | Every site that must obey it |
|---|---|
| Exactly one live attribution per live PO line version | `pos.issue` **and** labour PO issue (atomic with the version becoming live) · amend · cancel · close-short — all four through `CommercialParticipant`, none deferred to a later commercial command |
| A status a guard depends on is read under that row's lock | measurement (activity/root) · certification (activity/root **and** the contributing lots **and** the PO line) · payment approval (the bill) |
| Evidence cannot be withdrawn while a live payable fact consumes it | acceptance reversal (refuse vs a live certificate, DISPUTE a live uncertified claim) · sign-off revert · measurement correction · **deduction insertion after approval** — every one asks the commercial participant, or serializes on the bill, first. **These are the withdrawal paths that EXIST, and the list is exhaustive by construction.** An earlier revision also named `ActivityWorkOutput` supersession, which is not a path: §D verified against `20270305000000_phase4_t5_reconciliation` that the table is append-only (`ActivityWorkOutput_append_only`, BEFORE UPDATE OR DELETE) with no supersession transition, and §K's edge row says the participant edge is NOT for it. Keeping the row would have made this closure row the acceptance criterion for a guard that cannot be written — forcing either an out-of-scope Activities lifecycle added for Phase 5's benefit, or a permanently unsatisfiable check in a required participant surface. A closure list naming an impossible site is worse than a short one: it cannot be closed, so it silently converts the row from a criterion into an excuse |
| A fold that consumes a frozen amount is clamped and overage-aware | `COMMITTED` (clamp at 0) · `BILLED_TAX`/`BILLED_FREIGHT` pro-rata cap (never scale past the frozen authority) |
| An append-only amount column is constrained to its sign — **positive where a zero is meaningless, NON-NEGATIVE where the ordered side permits zero** | STRICTLY POSITIVE: certification · **approval** · payment · payment reversal · every deduction and release row · a claim line's QUANTITY. Approvals were the missed site of this very rule: `APPROVED(bill)` is an append-only money fold, so a negative approval could offset a later over-limit positive row under the cumulative-limit guard, or be appended after payment to drop `APPROVED` below `PAID` and break bound 5 with immutable evidence on both sides. NON-NEGATIVE (`>= 0`): a claim line's TAX and FREIGHT, because `PurchaseOrderLine`'s own CHECK is `"taxAmount" >= 0 AND "freightAmount" >= 0` — a zero-tax or zero-freight PO is legitimate, and a strictly-positive claim check would refuse a bill that matches the ordered evidence EXACTLY. Verified against `20261220000000_phase3_purchase_orders`; an earlier revision of this row said positive for all three, which would have made honest bills unrepresentable. What the sign rule actually forbids is a NEGATIVE amount: the row TYPE carries direction, so a live −100-unit claim plus a 200-unit bill would leave cumulative `BILLED_QTY` at 100 and pass bounds 1–2 against 100 accepted while the second bill certifies against its own bill-scoped amount. A credit is a separate document with its own semantics, NOT a negative line inside a conservation fold; Phase 5 has no credit note, so a negative claim is refused. |
| A participant edge is declared in BOTH directions it is used | §K's edge table is the single source and this row deliberately does NOT copy it — a copy here would be a second declaration to keep in sync, which is exactly how round 8's §K disagreement happened. Any §-section that describes a transaction-bound call adds its row to that table in the same change. |
| Every declared enum member appears in the fold that uses it | `NET_PAYABLE` covers retention · advance-recovery · penalty · **`other`** |
| Non-blank text discipline | every reason column **and** `CostHead.code`/`name`, with the complete ASCII set `btrim(x, E' \t\n\x0B\f\r')` |
| A rule and the record that authorises its exception ship together | §I SoD **and** `SodException` both in Task 5 for certification; Task 6 adds only the payment-approval half |
| A key that groups facts is FROZEN after write | `CostHead.code` (a column-freeze trigger, not merely non-blank) · **`CommitmentAttribution` — append-only, superseded rather than edited, `reason` frozen after write (§C)** · every frozen PO-line snapshot column Phase 3/4 already seals. Reclassification is a NEW head plus an attributable superseded attribution and a budget revision — never an in-place edit, which moves recorded history with no evidence that it moved. |
| Superseding a fact carries its downstream facts, in the same transaction | a superseded certificate takes its approvals out of `APPROVED(bill)` and requires the reduced amount to be RE-approved · cash already paid is reversed by its own row type inside `PAID(bill)` · a superseded PO version takes its attribution (row 1) · a superseded bill version takes its claim lines out of the billed sets. Lowering a parent without its children leaves an authorisation or a payment standing at an amount nobody certified. |
| **A rule is stated at exactly ONE site; every other place REFERENCES it** | §K's edge list lives only in the §K table (not in §0b, not in a §K prose bullet, not in probe 5x) · a §0 set's definition lives only in the §0 table (no fold restates its filter) · a probe names a scenario and cites its section, never restating the rule · no count of anything is written twice. This row is the meta-rule the other rows depend on, and it is here because round 8's §K disagreement, its stale output-priced probes and its refuse-vs-dispute probe were ALL second declarations that went stale while looking authoritative. A second statement of a rule is not redundancy — it is a fact with two owners, which is the one thing this project's architecture forbids everywhere else. |

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
- **All arithmetic in an EXACT decimal type end to end, never float64.** No `Number()` on a
  money value at any point, including read projections and the frontend. Server-side that type
  is `Prisma.Decimal`; **browser-side it is the web package's existing exact helpers
  (`apps/web/src/lib/decimal.ts`), NOT `Prisma.Decimal`** — the web package has no Prisma
  dependency and pulling the client into the bundle to do arithmetic would be the wrong fix for
  a rule about precision. The invariant is exactness, not a library. A full-scale probe that
  float64 demonstrably corrupts is required on BOTH sides.
- Rounding is stated once: half-up at 2 decimals, applied only where a value is persisted,
  never mid-computation.

### §K. Module graph — `commercial` is a SINK, and never gates operations

**The manifest declaration is the table at the END of this section, and it is the only place
in this plan that lists the edges.** No bullet below restates the list — the bullets say WHY
each edge exists and the table says WHAT Task 1 generates. This is deliberate: an earlier
revision of this section opened with a `workflowParticipants` list AND closed with one, a
later correction added `procurement` to the closing list only, and the two then disagreed
inside one section while both looked authoritative. One rule, one site; a new edge is a new
table row and a new justification bullet, never a second list.

- Every transaction-bound call must be DECLARED or Task 1 ships a manifest saying the call
  cannot happen — an undeclared one is a boundary escape the analyzer is built to catch, and
  taking the fallback plain read instead would reopen the very race the participant exists to
  close. Each outbound edge is load-bearing:
  - `inventory` — certification invokes `InventoryParticipant.lockAcceptedEvidence` (§E), or
    the stale-acceptance race reopens.
  - `activities` — a measurement validates `Activity.status = done` **under the activity/root
    row lock** through `ActivityParticipant` (§D). This edge is not optional: the fallback is
    an unlocked `ActivitiesQuery` status read, and §D already gives the interleaving that
    breaks it (measurement reads `done`, `revertSignOff` commits on a rejected closing
    inspection, the immutable measurement commits anyway). §E adds the same requirement for
    locking cited `ActivityWorkOutput` rows during certification. Declaring only `inventory`
    would leave §D and §E describing calls the manifest forbids.
- **INBOUND participant edges, because foreign transactions must write or check commercial
  facts atomically with their own.** The COUNT and the exact set are declared ONCE, in the
  manifest edge table below — this paragraph gives the reasoning per edge and deliberately
  states no total. An earlier revision said "two" while the table required four; that is
  §0b's own defect class (a rule with two written statements), and the fix is subtraction.
  Neither is a `dependsOn` edge — nobody READS commercial
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
    reverting a sign-off asks `CommercialParticipant.assertWorkEvidenceRevisable` first.
    Sign-off revert is the ONLY Activities path this covers — a cited output cannot be
    superseded at all (§0).
  - `procurement` is ALSO an outbound participant, because certification takes the PO-line
    lock (§E step 3) and a lock is a transaction-bound call, not a query. Reading the ordered
    side through `ProcurementQuery` instead would let certification see a live 100-unit line
    while `pos.closeShort`/amend moves that version under procurement's own lock, and commit a
    certificate against ordered authority that no longer stands.
  - `inventory` is ALSO an INBOUND participant, because §E requires `stock.reverse` to call
    `CommercialParticipant.assertAcceptanceReversible` before withdrawing accepted material.
    Without the edge, accept 100 → certify → reverse the acceptance commits with no commercial
    check, leaving the certificate payable against evidence that was withdrawn.
**The manifest edge table — the single declaration.** Task 1 generates exactly this, and a
Task-1 acceptance test asserts this exact edge set plus a successful topological sort of the
`dependsOn` graph:

| Manifest field | Value | Justified by |
|---|---|---|
| `commercial.dependsOn` | `['procurement', 'inventory', 'labour', 'activities']` | the four modules commercial READS (§0 sets) |
| `commercial.workflowParticipants` | `['inventory', 'activities', 'procurement', 'labour']` | inventory: `lockAcceptedEvidence` (§E) · activities: the locked `status` read (§D) · procurement: the material PO-line lock at certification (§E step 3) · **labour: the LABOUR PO-line lock, because `labourPurchaseOrderLine` is labour-owned (§0) and certifying a labour bill against an unlocked `LabourQuery` read lets `labour.po.closeShort`/amend move the ordered line underneath it — the identical race, in the module that actually owns the row** |
| `procurement.workflowParticipants` | gains `commercial` | `replaceAttribution` in the material PO amendment transaction (§C) |
| `labour.workflowParticipants` | gains `commercial` | `replaceAttribution` in the LABOUR PO amendment transaction (§C). Without it, issuing or amending a ₹100 labour PO cannot create or supersede its attribution atomically, so `COMMITTED` drops the whole obligation until some later commercial command — the exact invariant §C states. **AND `assertOrderedNotBelowMeasured` on the labour close-short/amend path**, because §D lets Task 3 record IMMUTABLE measurements that consume ordered person-shift authority before any bill exists: measure 100 shifts on a 100-shift labour PO, then `labour.po.closeShort` to 40, and the ordered cap moves underneath measurements that were valid when taken — Task 4 then disputes the vendor's honest 100-shift bill against an authority reduced after the work was measured. The certification lock alone does not cover this: it serializes a bill against the ordered line, and here there is no bill yet. So reducing the ordered quantity below `MEASURED(poLine)` is REFUSED naming the measured floor, the same shape as every other §G bound, and closing short to the measured quantity or above is permitted. Labour stops being a leaf in the PARTICIPANT graph only, which is cycle-exempt, so the acyclicity test is unaffected |
| `activities.workflowParticipants` | gains `commercial` | `assertWorkEvidenceRevisable` before `revertSignOff` withdraws a sign-off a measurement rests on (§E). NOT for output supersession — `ActivityWorkOutput` is append-only in Phase 4 and Phase 5 does not change it (§D) |
| `inventory.workflowParticipants` | gains `commercial` | `assertAcceptanceReversible` before `stock.reverse` withdraws accepted material (§E) |
| any module's `dependsOn` | gains **nothing** | nobody reads commercial — that is what makes it a SINK |
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

**Activation must ATTRIBUTE what already exists.** Capability-off means no commercial rows, and
that is exactly why enabling is not a no-op: a pilot project can already hold live material and
labour POs, and §C only writes the initial `CommitmentAttribution` during FUTURE issuance. Flipping
the capability on would leave those obligations unattributed, so `COMMITTED(costHead)` reads ₹0 and
the budget-vs-committed exception silently misses every existing vendor commitment. So
`capability:enable` for `commercial` runs a required in-transaction initialization that attributes
every live PO line, and REFUSES to complete if any line cannot be attributed (it names them rather
than inventing a cost head — the operator picks). This is the same rule as Task 4's vendor-pinning
backfill, at the site where the capability itself turns on: existing rows need a backfill, not only
forward writes.

**Which fixes where the attribution table lands: Task 1, not Task 2.** This rule and Task 2's
placement of `CommitmentAttribution` were written independently and contradict each other — Task 1
ships the capability, so on a pilot project that already holds a live PO, Task 1 must attribute
that line in the activation transaction, and it cannot without the table and its participant.
Neither escape is acceptable: implementing activation without the backfill leaves a
capability-on project whose forecast silently omits every commitment predating enablement — the
"observational not operational" defect Phase 3 Task 7 was blocked for — and deferring activation
to Task 2 means Task 1 ships a capability nothing may turn on, so its own §D inertness proof has
nothing to prove. So **Task 1 owns the `CommitmentAttribution` table, its XOR/uniqueness seals, the
`CommercialParticipant` write path, the activation backfill AND the forward issue/amend/cancel/
close-short participant hooks**; Task 2 owns what READS them — the §C `COMMITTED` fold, the
budget-vs-committed exception and its Inbox action.

The forward hooks belong with the backfill for the same reason the backfill belongs with the
capability, and splitting them repeats this section's own mistake one step later: with the table
and backfill in Task 1 but the hooks in Task 2, enabling `commercial` on an EMPTY project and then
issuing a PO creates a live line with no attribution, so §C's "a live line can never be
unattributed" is false for a whole task — the same hole as the missing backfill, entered forward
instead of backward. This section's closing sentence already says it: existing rows need a
backfill, NOT ONLY forward writes. Both halves, one task.

That is still one architectural concern per task: Task 1 is "every live PO line is attributed, from
whenever the capability is on", Task 2 is "budget authority exists and is compared against committed
obligation". Probes 5ai/5ar/5aj and the ROW half of 5bd run at the Task-1 tree.

**And `BudgetLine` moves to Task 2 with them, which is the other half of this seam.** An earlier
revision left the versioned budget in Task 1 while the `COMMITTED` fold and the over-budget exception
stayed in Task 2 — so a Task-1 deployment could enable a project holding a ₹90 attributed PO, revise
the live budget from ₹100 to ₹50, and produce −₹40 of headroom with no fold, no exception and no
Inbox writer in the tree to say so. A budget you can revise but whose breach nothing reports is a
worse state than no budget at all, because the number looks authoritative. The fix is not to add a
Task-1 reader — it is to notice that BUDGET and its exception are one concern: authority is only
meaningful against the obligation it measures. So Task 1 ships `CostHead` (attribution needs somewhere
to point) and no budget; Task 2 ships the budget, the fold, and the exception together, and its own
probes can verify all three. Task 1 consequently has no headroom to be silent about.

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
| 1 | `commercial` capability + module skeleton + `CostHead` + the `CommitmentAttribution` TABLE with its XOR/uniqueness seals + `CommercialParticipant` + the activation backfill AND the forward issue/amend/cancel/close-short hooks with supersession, so no live PO line is ever unattributed while the capability is on (§C/§L) + SINK manifest + acyclicity test + §D/§L inertness proof. **No `BudgetLine`, so no headroom and nothing to except** | — |
| 2 | Versioned immutable `BudgetLine` + the §C `COMMITTED` fold over the EXISTING frozen committed amounts + the budget-vs-committed exception and its Inbox action, raised from commitments AND budget revisions AND re-attributions (§B) | — |
| 3 | `Measurement` (§D) — immutable, delta corrections, activity sign-off gate, material lines read acceptance instead + **the `revertSignOff` withdrawal guard (`activities.workflowParticipants` gains `commercial`, `CommercialParticipant.assertWorkEvidenceRevisable`), because THIS task is the one that first creates a measurement resting on a sign-off.** §K assigns the guard to §E, which lands in Task 5 — but a measurement exists from Task 3, so in the Task-3 tree a closing-inspection rejection can return a signed-off activity to `in_progress` and leave a LIVE measurement whose evidence was withdrawn, with nothing to adjudicate it until two tasks later. The guard ships with the fact that needs it, exactly as Task 4 ships both of its withdrawal guards (§0b: same rule, every site) | **STOP** — narrow review before any bill can consume a measurement |
| 4 | `VendorBill` + lines + immutable versions + the §F CAS lifecycle **up to `under-verification`** + §G bounds 1–2 + **the `disputed` transition AND both withdrawal guards, because this is the task that first creates a LIVE bill: the acceptance side (`InventoryParticipant`-side `assertAcceptanceReversible`) AND the measurement side — Task 3 ships the signed-delta correction route while no `BILLED_QTY` row can exist, so its guard has only the zero floor; the §D live-claim floor (`MEASURED` may not fall below `BILLED_QTY(poLine)`) has to ship HERE or measure 100 → bill 100 live → correct −50 leaves `BILLED_QTY = 100 > MEASURED = 50`. Same rule, both sites (§0b)** | — |
| 5 | Three-way verification (§E) — and therefore the `verified` transition itself — + dispute/resolution + certification + §G bound 3 + §H deduction ledger + **the §I measurer/acceptor-vs-certifier SoD rule AND the `SodException` record with its seals** | **STOP** — narrow review before payment authority exists |
| 6 | Payment approval + payment records + payment reversals + the `advance-recovery` deduction type and its paid-advance fact (§H) + §G bounds 4–5 + the certifier-vs-approver SoD rule and approval limits — the PAYMENT half of §I only | — |
| 7 | Cash-forecast projection (§J) + frontend hub (§M) + pilot acceptance chain + consolidated Phase-5 packet | **FINAL STOP** |

**Where the per-task mechanism lives.** §B, §C, §D, §E, §F, §G, §H and §I are NOT
deleted — they travel VERBATIM into the PR for the task that implements them, per the
owner's approved split. Until each task opens, that text is the twenty-round-corrected
draft at `claude/phase5-planning` commit `a4d469b`, also visible as the closed PR #252
diff. **A task PR that reaches its section MUST carry that text forward rather than
re-derive it** — re-deriving is precisely what produced twenty rounds of findings, and
§N records why.

**The probe list stays HERE, and that is a correction to this head's first revision.**
An earlier revision moved it out with the mechanism sections to hold the plan under the
owner's 500-line ceiling. That was wrong, for a reason worth recording: the probes are
the SCHEDULE for the deferred questions. With them outside the reviewed tree and pinned
only to a closed branch, the plan does not define what adjudicates each still-open
question, Task 1 could begin with them unmapped, and a reviewer has no way to verify the
deferred findings are scheduled rather than quietly re-derived or dropped. A deferral
that cannot be audited is indistinguishable from a deletion. The list is therefore
restored below, verbatim, and the plan exceeds the 500-line guidance as a consequence —
stated plainly rather than met by dropping the evidence that makes the deferral honest.

Task 4 deliberately stops SHORT of `verified`. `verified` is the state whose safety is the
§E verdict, so shipping the transition in Task 4 while §E lands in Task 5 would let a bill
reach `verified` before the ordered/accepted/billed comparison exists — and pulling §E
forward into Task 4 would bypass the Task-5 review stop that guards it. The transition
belongs to the task that produces its evidence.

A control ships in the task that creates the transition it guards. The certification SoD
rule cannot wait for Task 6: a certificate is append-only and is already the payable basis,
so a self-certified one written in Task 5 could not be invalidated by a rule added later.
The same reasoning puts `verified` in Task 5 rather than Task 4.

**And a rule's exception record ships with the rule, not one task later.** §I permits a
stronger authority to override, and that override is only legitimate because it writes a
sealed `SodException`. Leaving the record in Task 6 gives Task 5 two bad options: silently
ban the override — which a two-person practice cannot operate under, and which §I explicitly
refuses — or write an unsealed authority row before its seals exist, which is the very state
§I's seals were added to prevent. So Task 5 ships the certification SoD rule AND the
`SodException` table, CHECKs, append-only trigger and FK; Task 6 adds only the
payment-approval half of the same rule, reusing the record. This is the last row of §0b, and
the same reasoning as `verified` belonging to Task 5.

Task 3 and Task 5 stops are mandatory: measurement is the fact every downstream amount
rests on, and certification is the last point before money becomes payable.


## Required plan probes (reproduce-first, live PG unless noted)

**A probe names a SCENARIO and the section whose rule it exercises; it does not restate the
rule.** Three of round 8's findings were probes still asserting a rule the sections had
already changed — an output-priced measurement after §D removed output pricing, a hard refusal
after §E chose disputes — so a probe that restates a rule becomes a second declaration that
goes stale silently and, worse, an implementer following it writes behaviour the plan forbids.
Each probe below therefore points at its authority. If a probe and its section disagree, the
SECTION is right and the probe is the defect.

1. §D byte-identity: two projects in one org, commercial off on one — response bytes,
   nav and routes unchanged; the commercial tables hold zero rows.
2. §K no-gate: enabling the commercial capability changes NO readiness verdict, in either
   direction, for material or team.
3. §A decimal: a full-scale `Decimal(18,2)` money chain that float64 provably corrupts.
4. §G bound 2 with the §E over-bound disposition: a 101-unit claim against 100 accepted is
   recorded as a `qty-over-accepted` DISPUTE, not refused at submission — the vendor's actual
   claim stays readable and §0's LIVE rule keeps the unresolved disputed version out of the
   billed fold, so nothing certifies against it. (A hard rejection would destroy the evidence
   §0/§E/5ac depend on and make the resolution path untestable; that is the model §E chose and
   this probe follows it.) An 80-accepted / 20-rejected receipt supports a legitimate 80-unit
   bill with no dispute — `ACCEPTED` per §0 is the acceptance-event fold, not
   `accepted − rejected`, which would understate it as 60. Reversing an acceptance after a
   bill is submitted moves that bill to `disputed` rather than silently passing.
5. §G bound 2 race: two concurrent bill submissions against one PO line with capacity for
   one — deterministic barrier, exactly one commits.
5b. §E certification vs `stock.reverse`, BOTH orderings under a deterministic barrier: a
   reversal committing mid-certification can never leave a certified bill with no accepted
   material behind it, and the stated lock order never deadlocks.
5c. §D measurement bound — person-shift-priced labour only, which is the ONE contract shape
   §D keeps in scope: a measurement citing no live `ActivityWorkOutput` is refused (the output
   is required as progress EVIDENCE per §0's `OUTPUT` predicate); one citing a physical-unit
   output IS accepted with no same-unit cap; the quantity cap is `EFFORT(poLine)` and a
   measurement beyond it is refused; effort matched to trade A cannot fund a trade-B line on
   the same activity/day; and the same effort cannot be consumed by two PO lines. NOT
   "superseding the cited output blocks certification" — `ActivityWorkOutput` is append-only
   with no supersession path (§0), so that probe could only pass by adding an Activities
   lifecycle transition this phase declares out of scope. What IS probed is the existence
   test §0 defines, plus the sign-off withdrawal path that Activities really has
   (`assertWorkEvidenceRevisable`, probe 5k).
5h. §0 unit discipline: a ₹10,000 bill for 100 units satisfies bound 1 against
   `qty + approvedOverage` in UNITS and bound 3 against the certificate in RUPEES — neither
   comparison ever mixes the two.
5i. §0 `OUTPUT` is a predicate, not a pool: a mason line and a helper line on the same
   activity both measure legitimately against ONE 100 sqm output, each bounded by its OWN
   `EFFORT` — the second is NOT blocked by the first and no duplicate output row is needed.
   A ₹100 certification with ₹10 retention approves at most ₹90; a certified bill cannot be
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
   NOT in `committed`, and the SIX EXPOSURE buckets sum to exactly the total exposure — `budget` is
   reported separately as authority plus headroom and is never an addend (§J, probes 5bc/5bm). An
   earlier spelling summed seven buckets "to no more than budget + committed obligations", which
   both counts budget as exposure and states an inequality where the invariant is an equality.
5p. §0 `BUDGET`: a ₹100 line revised to ₹120 forecasts ₹120, never ₹220 and never ₹100.
5q. §E evidence identity: certify 100 against acceptance A, accept another 100, then reverse
   A — REFUSED naming the certificate, because the frozen consumption set holds A, not a
   quantity. The same for a sign-off reverted after certification. NOT for output
   supersession, which PostgreSQL already makes impossible (§0).
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
5x. §K edge set: the Task-1 manifest matches the §K edge table EXACTLY — every row, both
   directions, asserted against the table rather than against a list repeated here (this probe
   previously carried its own subset and went stale when the table gained `procurement`; the
   table is the authority). RED against any strict subset: dropping `activities` forbids §D's
   locked status read, dropping `procurement` forbids §E's PO-line lock so certification would
   fall back to an unlocked `ProcurementQuery` read and could certify against ordered authority
   that `pos.closeShort`/amend has already moved, and dropping any inbound edge forbids §C's
   atomic re-attribution or §E's withdrawal checks. A topological sort of the `dependsOn` graph
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
5ab. §0b closure — one probe per row, because five of round 6's ten findings were a rule
   applied at one site with an identical sibling left alone:
   - **attribution at all four sites**: `pos.issue` and labour PO issue each leave exactly one
     live attribution and `COMMITTED` equal to the order the instant the version is live
     (never ₹0 pending a later command); amend/cancel/close-short as probe 5y already covers.
   - **overage clamps at both sites**: a ₹100 / 100-unit line with 10 overage units accepted
     leaves `COMMITTED` at ₹0, never −₹10, and no other cost head's obligation moves; the same
     line's tax cap stays at the frozen ₹1,800, never ₹1,980, and overage tax raises an
     exception instead of certifying.
   - **the sign-off lock at both sites**: probe 5k covers measurement; the certification twin
     runs the same barrier — a rejection committing mid-certification can never leave a
     certified bill resting on a withdrawn sign-off, and the lock order matches `revertSignOff`
     so neither ordering deadlocks.
   - **withdrawal checks at all FOUR paths that exist**: acceptance reversal (5j), sign-off
     revert (5q), a measurement correction — measure 100, certify 100, then
     −50 is REFUSED naming the certificate; superseding the certificate first permits it; a
     −50 with no live claim succeeds and floors at zero (5n) — **and deduction insertion after
     approval**. That fourth site is named in the §0b row and was missing from this probe, so a
     Task-5 implementation could pass the closure test while certify ₹100 → approve ₹100 → append
     a ₹10 penalty left `APPROVED = 100` against `NET_PAYABLE = 90`, both facts append-only and
     neither correctable: a payable authorised above what the certificate can pay, with immutable
     evidence on both sides. The probe therefore drives exactly that sequence and asserts the
     serialized outcome: under the bill lock the ₹10 deduction is REFUSED while an approval that
     it would invalidate is live, naming the approval; the representable path is to supersede the
     certificate (which drops the approval with it, per §F), append the deduction on the new
     certificate, and re-approve the reduced `NET_PAYABLE`; and a deduction appended BEFORE any
     approval succeeds and lowers the cap, so the guard is precise rather than a blanket ban on
     late deductions. A concurrent approval and deduction admit exactly one, in both orderings,
     under a deterministic barrier.
   - **positive amounts on every append-only money row**: a `-10` deduction and a `-10` release
     are both rejected by PG; `NET_PAYABLE` on a ₹100 certificate with a ₹10 retention is ₹90,
     never ₹110.
   - **every enum member in its fold**: a ₹10 `other` deduction reduces the approval cap to
     ₹90, exactly like retention, advance-recovery and penalty.
   - **non-blank at both sites**: a `CostHead` coded `'   '` (and one named `'\t'`) is rejected
     by PG, alongside the reason columns of 5v.
   - **rule and exception record in one task**: the Task-5 acceptance test exercises an
     org-admin override end to end — refusal without authority, success with it, and the sealed
     `SodException` present — with no Task-6 code in the tree.
5ac. §0 `disputed`: 100 accepted, a 120-unit bill submitted → `qty-over-accepted` and
   `disputed`, and that version leaves the live fold, so an honest corrected 100-unit claim
   submits and passes; the disputed version is still readable as history and its claimed 120
   is still visible on the dispute.
5ad. §F supersession carries its downstream facts: certify ₹100, approve ₹100, supersede the
   certificate to ₹50 with a reason → `APPROVED(bill)` reads ₹0 (the ₹100 row survives on the
   superseded certificate as history), bound 4 holds, and the ₹50 requires a FRESH attributable
   approval by someone holding the limit for it. With ₹100 already paid, the same supersession
   is REFUSED until the FULL ₹100 is reversed — a ₹50 reversal is NOT enough, because
   supersession takes `APPROVED` to ₹0 while `PAID` would still read ₹50, so bound 5
   (`PAID ≤ APPROVED`) would be false the instant the correction landed. The complete legal
   sequence is: reverse ₹100 (`PAID` → ₹0) → supersede to ₹50 → fresh ₹50 approval → pay up
   to ₹50. This is the §F full-reversal rule, probed here rather than restated.
5ae. §0 `PAID` netting: a ₹50 payment-reversal on a ₹100-paid bill leaves `PAID` at ₹50, never
   ₹150; PG rejects a NEGATIVE payment row and a negative reversal row; a reversal exceeding
   `PAID` is refused; PG rejects UPDATE/DELETE of a reversal.
5af. §B cost-head key immutability: PG REFUSES an UPDATE of `CostHead.code` on a head that has
   any budget line or attribution — and refuses it on a bare head too, since the freeze is on
   the column, not on usage. The legitimate reclassification path works end to end: create the
   new head, supersede the attribution with a reason, revise the budget — and `BUDGET`/
   `COMMITTED` move heads with full append-only evidence of both steps. `name` remains editable.
5ag. §0b sign discipline is per-column: a claim line with `tax = 0` and `freight = 0` against a
   zero-tax / zero-freight PO is ACCEPTED (the ordered side permits zero, so the claim must
   too); a NEGATIVE quantity, tax or freight is rejected by PG; a zero QUANTITY is rejected.
5ah. §F paid-certificate supersession ORDER: with ₹100 certified, approved and paid,
   superseding to ₹50 is REFUSED and the refusal names the outstanding ₹100 paid; a ₹50
   reversal alone still refuses (₹50 remains); the FULL ₹100 reversal then permits the
   supersession, after which `APPROVED` and `PAID` are both ₹0, a fresh ₹50 approval is
   required, and bound 5 holds at every step.
5ai. §C attribution seals: PG rejects DELETE of ANY `CommitmentAttribution` and rejects UPDATE
   of an ACTIVE row's `costHead`/PO-line target/`reason` (there is no `amount` column to update —
   §C forbids one, so a probe demanding its rejection would force Task 2 to add the very column
   the plan bans) — the hostile `CIVIL → MEP`
   in-place edit of the LIVE row is refused, not merely the edit of a superseded one — while the
   single permitted transition (stamping an ACTIVE row superseded) succeeds and a second stamp of
   an already-superseded row is refused; a re-attribution from `CIVIL` to `MEP` INSERTS a new row
   and stamps the prior superseded, and `COMMITTED(CIVIL)` / `COMMITTED(MEP)` move together with
   immutable evidence of the reclassification. RED against a trigger written to fire only on
   superseded rows.
5aj. §K labour edges: certifying a LABOUR bill takes the labour PO-line lock through the
   labour participant — under a deterministic barrier a concurrent `labour.po.closeShort`
   cannot move the ordered line mid-certification — and every one of the FOUR labour lifecycle
   sites writes or supersedes its attribution in the SAME transaction: issue, amend, **cancel**
   and **close-short**. The §0b attribution row names all four and the labour twin owes all four;
   an earlier revision of this probe covered issue/amend only, which a Task-2 implementation
   could pass while `labour.po.closeShort` on a live ₹100 labour order left the attribution
   active and `COMMITTED` still reporting ₹100 against an obligation that no longer exists.
   So: cancelling a live labour PO supersedes its attribution and `COMMITTED` returns to ₹0
   (never −₹100, per the clamp), closing one short to ₹40 supersedes and re-attributes so
   `COMMITTED` reads ₹40, and `COMMITTED` never reads ₹0 for a still-live labour order. RED
   against a manifest carrying only the material edges, and RED against a labour implementation
   that attributes on issue only.
5ak. §F/§G Task-4 boundary: at the Task-4 tree, a 101-unit claim against 100 accepted lands
   `disputed` (never live, never refused), and `stock.reverse` of an acceptance under a live
   uncertified claim moves that claim to `disputed` rather than committing silently — both
   guards present in the task that first creates a live bill.
5al. §I write authority: a member holding only `commercial.read` is REFUSED on cost-head
   creation, budget-line create/revise and re-attribution; `commercial.budget` /
   `commercial.attribute` permit their own routes and nothing else.
5am. §B cost-head key: PG refuses a SECOND `CostHead` with the same `(projectId, code)`; two
   projects may each hold `CIVIL`; a budget line and an attribution under one project's `CIVIL`
   always meet in the same head, so the budget exception compares like with like.
5an. §E reversal disposition is driven by the AGGREGATE fold and disputes the minimum needed:
   accept 100, bill 80, reverse 20 leaves that bill LIVE (fold 80 ≤ 80); reverse 30 disputes it.
   And the case a per-claim rule gets wrong — accept 100, bill 60 AND 40, reverse 20: neither
   claim is individually over 80, the fold is 100, so the newest claim (40) is disputed and the
   older (60) is left live, ending at 60 ≤ 80. RED against BOTH a path that disputes every claim
   and a path that tests each claim individually against `ACCEPTED`.
5ao. §F vendor pinning is PG-enforced: after Task 4 freezes `vendorId` on the PO-line snapshot,
   Vendor A's bill line naming Vendor B's PO line in the SAME project is rejected by PostgreSQL,
   not by the service.
5ap. §0b reason coverage is COMPLETE: a whitespace-only reason is rejected by PG on every reason
   column this phase introduces — deduction, rejection, budget revision, attribution, override,
   measurement correction, certificate supersession and payment reversal — enumerated from the
   schema rather than from a list written by hand.
5aq. §B budget scope is single-valued at PG: a second live `BudgetLine` chain for the same
   `(projectId, costHead)` is REFUSED by the partial unique, and a negative amount by the CHECK,
   so `BUDGET(costHead)` can never be ambiguous or nonsensical.
5ar. §C attribution authority follows the WRITE, not the route: a user with PO-issue authority
   but without `commercial.attribute` is refused when `pos.issue` (and labour PO issue) tries to
   write the initial `CommitmentAttribution` through the participant.
5as. §D measurement is bounded by ORDERED authority too: 120 worked person-shifts against a
   100-shift PO measures at most 100, and a PO amendment ordering 120 then permits the rest.
5at. §E consumption is `(rowId, consumedQty)` on BOTH sides: with one 100-unit acceptance row and
   an 80-unit certified bill, reversing the unused 20 is PERMITTED and reversing 21 is REFUSED;
   the measurement twin — measure 100 by A, certify, add 100 by B, correct −100 — is REFUSED
   even though the aggregate still covers the bill.
5au. §E a labour bill line's tax and freight are refused at PG (`CHECK = 0`), because the
   `LabourPurchaseOrderLine` snapshot freezes no ordered tax or freight to compare against; a
   material line's prorated tax/freight is unaffected.
5av. §F a `disputed` version never returns to live: resolution issues a NEW version and the
   disputed one stays terminal, so a 120-unit dispute against 100 accepted can never re-enter
   `BILLED_QTY` and block its own corrected 100-unit claim.
5aw. §F supersession re-states DEDUCTIONS on the new certificate: certify ₹100 with ₹10
   retention, supersede to ₹50 → `NET_PAYABLE` reads ₹40 against the LIVE certificate's own
   restated row, never ₹40 from a row attached to the superseded ₹100, and the retained balance
   never silently disappears.
5ax. §F Task 4's vendor-pinning migration BACKFILLS existing PO lines from the PO chain and
   ABORTS on any line it cannot resolve, so a project with lines predating Task 4 upgrades with
   every line pinned and none invented.
5ay. §A exact-decimal discipline holds on BOTH sides of the wire: the API probe uses
   `Prisma.Decimal` and the WEB probe uses `apps/web/src/lib/decimal.ts`, each at a full-scale
   value float64 demonstrably corrupts, and neither imports the other's type.
5az. §H approval rows are strictly positive at PG: a negative approval is REFUSED, so it can
   neither offset a later over-limit positive row nor drop `APPROVED` below `PAID` after payment.
5ba. §F payment status is DERIVED, never stale: pay a ₹100 approved bill to `paid`, reverse the
   full ₹100 → the status re-derives to `approved-for-payment` with `PAID = 0` in the SAME
   transaction; a ₹40 reversal from `paid` re-derives to `part-paid`. RED against a lifecycle
   that only moves forward.
5bb. §E certification takes ONE ascending lock order over every PO line the bill touches: a
   two-line bill certified concurrently from both orderings COMMITS EXACTLY ONE and never
   deadlocks, under a deterministic barrier (the Phase-4 overlapping-crews probe shape).
5bc. §J buckets are residual and partition the money at BOTH ends of the chain: a ₹100 approved
   bill with ₹40 paid reports ₹60 in `approved` and ₹40 in `paid` — never ₹140 across the two;
   ₹100 accepted with a ₹40 submitted-uncertified bill reports ₹60 `received-not-billed` and ₹40
   `awaiting-certification`, never ₹140 for one ₹100 delivery; and a ₹100 certificate carrying
   ₹10 retention reports ₹90 `certified-payable` before approval — never ₹100 — then ₹0 after the
   ₹90 is approved, with no phantom ₹10 payable, and ₹5 once a ₹5 release is appended. The SIX
   EXPOSURE buckets sum to the total exposure exactly at every step, and `budget` is asserted
   SEPARATELY as authority plus headroom — never as a seventh addend, which would put the money
   back in two places (§J, probe 5bm). RED against the round-13 spelling, where only the
   post-certification buckets were residuals, AND against the round-16 spelling of this probe,
   which still summed seven buckets after §J had made budget authority.
5bd. §D enabling the `commercial` capability on a project that ALREADY holds live material and
   labour POs attributes every one of them in the enabling transaction — asserted at the TASK-1 tree
   on the ROWS, because that is what Task 1 ships: after activation every live PO line (material and
   labour) has exactly one active `CommitmentAttribution`, and a line that cannot be attributed
   REFUSES the activation naming it rather than inventing a cost head. An earlier revision asserted
   `COMMITTED(costHead)` here, which Task 1 has no fold to answer with; that half is 5bu below, at
   the tree that ships the reader.
5bu. §C at the TASK-2 tree, `COMMITTED(costHead)` reads the real obligation for exactly those
   backfilled rows: enable on a project with a live ₹100 material PO and a live ₹40 labour PO
   attributed to two heads, and the fold reports ₹100 and ₹40 with no commercial command run since
   activation — the backfill is not merely present, it is READ.
5be. §L both structural tables parse: `docs/STATUS.md`'s named source of task numbering yields
   exactly Tasks 1–7 from ONE contiguous execution table; §0's set table is ONE contiguous block
   with no prose split; and the §J bucket table has one row per bucket the §J list names, so a
   bucket cannot be listed without a definition. The §0 assertion is stated WITHOUT a row count,
   deliberately — probe 5g gives the reason (a written count is one more thing that goes stale
   when a set is added, which is how round 8 happened), and an earlier revision of this probe
   ignored its own sibling and hardcoded "fourteen", which does not even equal the row count
   because one row defines `BILLED_TAX` and `BILLED_FREIGHT` together. The check is therefore
   NAME-based, from the document: every `SET(arg)` name any §-section references resolves to a row
   in that one block, and every row is referenced somewhere. That fails when a set is added and
   left undefined, or defined and never used, and it never needs updating when the count changes.
5bf. §F a bill line names EXACTLY ONE PO line at PostgreSQL: a line with NEITHER a material nor a
   labour PO-line reference is REJECTED (so a ₹100 claim can never enter `BILLED_AMOUNT` with
   bounds 1–2 unable to run), a line with BOTH is REJECTED (so no fold has two owners), a `type`
   discriminator disagreeing with the reference present is REJECTED, and each of the two valid
   shapes is ACCEPTED — the seal is precise, not merely strict. RED against nullable alternatives
   guarded only by per-column FKs.
5bg. §F `duplicate-claim` has a key: `vendorBillNumber` and its document date are non-blank and
   column-frozen after write (an UPDATE is refused); a SECOND live bill under the same
   `(projectId, vendorId, vendorBillNumber)` is refused by the partial unique index, and two
   CONCURRENT submissions of it admit exactly one under a deterministic barrier — the Task-2
   one-quote-per-`(rfq, vendor)` shape; a superseding VERSION of the same bill reuses the
   reference and is accepted; a resubmission after the first was REJECTED is accepted, and the same
   for a `resolved` bill — the lifecycle's own terminal states, never a `cancelled` one §F does not
   define, so this acceptance case cannot force Task 4 to invent a cancel path to satisfy it — and
   the same units claimed under a DIFFERENT vendor number raises the service-side `duplicate-claim`
   verdict rather than passing every bound silently.
5bm. §J the SIX exposure buckets partition the money and `budget` is authority, not exposure: with
   a ₹100 budget and a ₹100 PO fully accepted and unbilled, the six sum to exactly ₹100 with the
   ₹100 in `received-not-billed` — never also in a `budget` bucket — and the reported headroom is
   ₹0; over-commit to ₹150 of exposure and the headroom is −₹50, surfaced as the §B exception
   rather than clamped. RED against `BUDGET − COMMITTED`, which reports ₹100 headroom for that
   fully-accepted order because `COMMITTED` is already zero.
5bn. §F the status derivation never invents an approval: on a ₹100 certificate with ₹10 retention,
   releasing ₹5 with `APPROVED = 0` leaves the bill `certified`, NOT `approved-for-payment`;
   approving ₹90 then paying ₹90 gives `paid`; releasing ₹5 after that returns it to `certified`
   (approved portion settled, remainder unapproved) and NOT to `paid` or `approved-for-payment`;
   and `PAID = APPROVED = NET_PAYABLE` is the only route to `paid`. RED against a derivation that
   maps any `NET_PAYABLE > APPROVED` to `approved-for-payment`.
5bv. §F every UNCERTIFIED live state can be disputed: a claim at `submitted`, at
   `under-verification` and at `verified` each moves to `disputed` when an acceptance reversal or
   measurement correction withdraws its evidence — never left live with `BILLED_QTY` above the
   available evidence, and never `rejected` (which would judge the claim rather than record that its
   evidence moved). RED against a lifecycle offering the arrow from only some of the three.
5bw. §C `COMMITTED` reads each PO line through its OWNING module: a live ₹100 material PO and a live
   ₹40 labour PO attributed to one cost head fold to ₹140, the material amount read through
   `ProcurementQuery` and the labour amount through `LabourQuery`; the boundary analyzer reports NO
   cross-module read for either. RED against a spelling where procurement is the universal owner,
   which either drops the labour ₹40 or makes procurement read labour-owned rows.
5bx. §H a deduction INSERTION re-derives payment status: on a ₹100 certified bill with no approval,
   inserting a ₹100 retention makes `NET_PAYABLE = PAID = 0` and the status re-derives to `paid`
   under CAS in the insertion's own transaction — not left at `certified`, which no positive approval
   or payment row could ever advance. RED against a plan that names only the release and the payment
   reversal as re-deriving writers.
5br. §H `NET_PAYABLE` never goes negative: on a ₹100 certificate, a ₹150 penalty is REFUSED naming
   the withholdable balance, ₹100 is PERMITTED (`NET_PAYABLE = 0`), a further ₹1 is REFUSED, and
   after releasing ₹40 a ₹40 deduction is PERMITTED again — the cap is on unreleased deductions, not
   on the lifetime total. RED against a plan where only bound 4 guards the approval, which a
   negative `NET_PAYABLE` satisfies.
5bs. §F a zero-net certificate reaches a TERMINAL status: certify ₹100 and offset it entirely with
   a ₹100 advance-recovery → `NET_PAYABLE = APPROVED = PAID = 0` derives `paid` (nothing remains
   payable), NOT `certified`; and since approval and payment rows are strictly positive there is no
   legal row that could have advanced it, so the ordering is the only thing that can. RED against a
   table whose first arm is `APPROVED = 0`, which strands the bill permanently.
5bt. §F a VERIFIED uncertified claim can be disputed: with a 100-unit bill at `verified` and no
   certificate, reversing the acceptance moves the bill to `disputed` (never left live with
   `BILLED_QTY > ACCEPTED`, and never `rejected`, which would drop it out of the correction path);
   the same reversal against a CERTIFIED bill is REFUSED naming the certificate. RED against a
   lifecycle offering only `under-verification → disputed`.
5bp. §H advance recovery cannot exceed the advance PAID: with a ₹100 advance paid, a cumulative
   ₹150 `advance-recovery` is REFUSED naming the recoverable balance, ₹100 is PERMITTED, and a
   further ₹1 after that is REFUSED — the fold is `Σ advance − Σ advance-recovery` with no stored
   balance, re-derived under the bill lock. Without this the sign, fold and status probes all pass
   while the vendor is underpaid by ₹50: the row is positive, the enum member folds, and the status
   derives correctly from a `NET_PAYABLE` that is simply too low.
5bq. §B the over-budget exception fires from every input that moves headroom: with a ₹100 budget
   and a ₹90 attributed PO, (a) a further ₹20 commitment raises it, (b) revising the live budget
   DOWN to ₹50 raises it with no commitment write, and (c) re-attributing the ₹90 onto a ₹50 head
   raises it on the target AND clears it on the source — each in the raising write's own
   transaction, each producing exactly one Inbox action. RED against a commitment-only trigger,
   where (b) and (c) are silent.
5bo. §D labour close-short cannot move the ordered line below MEASURED: measure 100 shifts on a
   100-shift labour PO with no bill anywhere, then `labour.po.closeShort` to 40 → REFUSED naming
   the measured floor; closing short to 100 or above is PERMITTED; and after the refusal the
   vendor's honest 100-shift bill still certifies against the unreduced authority. RED against a
   plan where only certification holds the labour PO-line lock, which cannot help when no bill
   exists yet.
5bi. §C an attribution names EXACTLY ONE PO line at PostgreSQL and carries NO amount: a row with
   NEITHER a material nor a labour target is REJECTED (so issuance cannot satisfy the
   never-unattributed unique with a fact that attributes nothing), a row with BOTH is REJECTED
   (so superseding the material side cannot silently un-attribute a live labour line), each valid
   shape is ACCEPTED, and the table has no `amount` column — `COMMITTED` is asserted to change
   when the PO line's frozen `committedAmountBase` is the only thing that moved.
5bj. §F the duplicate-document index releases on the lifecycle's OWN terminal states: submit
   vendor bill `V-1`, REJECT it, resubmit a corrected `V-1` → ACCEPTED; the same for a `resolved`
   bill; while a second `V-1` against a `submitted`, `under-verification`, `verified`, `certified`
   or `disputed` bill is REFUSED, and two concurrent first submissions admit exactly one under a
   deterministic barrier. RED against a `WHERE NOT cancelled` predicate, which names no state §F
   defines and so never releases.
5bk. §F a retention release re-derives payment status: certify ₹100 with ₹10 retention, approve
   and pay ₹90 (status `paid`), then release ₹5 → the status re-derives under CAS in the release's
   own transaction to **`certified`**, because `PAID = APPROVED = ₹90 < NET_PAYABLE = ₹95` and the
   remaining ₹5 is UNAPPROVED, not unpaid — the same row of §F's derivation table probe 5bn pins,
   never `approved-for-payment` (which would claim an approval covering ₹95 when ₹90 was approved)
   and never `paid` (which would claim ₹5 of cash left the practice). §J reports ₹5 in
   `certified-payable` at the same instant, so the stored status and the forecast agree. RED
   against a derivation that compares only `PAID` to `APPROVED`, and RED against the round-16
   spelling of this probe, which expected `approved-for-payment` and so contradicted the table
   written in the same round.
5bl. §D a reducing measurement correction DISPUTES uncertified claims and refuses only against a
   certificate: measure 100, submit an uncertified 100-shift labour bill, correct to 50 → the
   correction LANDS and the claim is disputed (newest-first, stopping when the bound holds);
   certify that bill first and the same correction is REFUSED naming the certificate; superseding
   the certificate then permits it. RED against a floor that blocks on live `BILLED_QTY`
   regardless of certification — the material side's §G disposition at the measurement site.
5bh. §E supersession re-scopes deductions AND releases atomically: certify ₹100, retain ₹10,
   release ₹5, then supersede to ₹50 — the live certificate reads ₹10 retained and ₹5 released
   (`NET_PAYABLE` ₹45), never ₹10 retained with ₹0 released, so no released rupee is clawed back;
   both row kinds are read from the SAME certificate the fold reads; and the superseded
   certificate keeps its own rows as history. RED against a supersession that re-states deductions
   only.
5g. §0 set identity: for EVERY row of the §0 table (no count is written here — a count is one
   more thing that goes stale when a set is added, which is how round 8 happened), the
   "must NOT be" column is a probe — the
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


## §N. What the twenty rounds established (do not re-derive)

The prior review is the most valuable artefact this phase has. Its findings are all
FIXED — in §0, §0b and the per-task text now travelling with each task. What follows
is the *method* that produced them, so a future head does not reopen settled ground.

**The root defect, named in round 1 and never contradicted:** thirteen of sixteen
early findings were one question — *which rows count?* — asked at a different site and
answered locally each time. The plan described **where to look** instead of defining
**what constitutes evidence**. §0 is the remedy: every set defined once, referenced by
name, and no fold may restate a filter inline.

Two sub-shapes recur, both inherited from the platform beneath this phase:

1. **Amendments retain history.** POs, bills, certificates and budget lines all
   supersede rather than overwrite. So *"every row"* is never the answer for any of
   them — and it was written independently for bills, certificates and commitments.
2. **A bucket balance is current state, not evidence of a past event.** The §C ledger's
   `acceptedOnHand` moves on issue and on adjustment, so it cannot answer *"what was
   delivered"*. Acceptance is an EVENT.

**The recurrence mechanism, named in round 8:** the repeating defect was *a rule with
two written statements*, and every duplicate was created by a previous correction
adding a copy instead of moving the single source. §0b targets that by SUBTRACTION.

**What prose could not close (round 9):** false claims about other modules' code, task
sequencing, and an incomplete site list. These are exactly the classes a task PR
settles with a probe and a plan cannot settle at all — which is the second argument
for this split, independent of size.

A reviewer of this head should aim at §0 and §0b. If a set is wrong there, it is wrong
everywhere by construction; if it is right, the task PRs inherit it.

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
