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
| 3 | `Measurement` (§D) — immutable, delta corrections, activity sign-off gate, material lines read acceptance instead | **STOP** — narrow review before any bill can consume a measurement |
| 4 | `VendorBill` + lines + immutable versions + the §F CAS lifecycle **up to `under-verification`** + §G bounds 1–2 + **the `disputed` transition AND both withdrawal guards, because this is the task that first creates a LIVE bill: the acceptance side (`InventoryParticipant`-side `assertAcceptanceReversible`) AND the measurement side — Task 3 ships the signed-delta correction route while no `BILLED_QTY` row can exist, so its guard has only the zero floor; the §D live-claim floor (`MEASURED` may not fall below `BILLED_QTY(poLine)`) has to ship HERE or measure 100 → bill 100 live → correct −50 leaves `BILLED_QTY = 100 > MEASURED = 50`. Same rule, both sites (§0b)** | — |
| 5 | Three-way verification (§E) — and therefore the `verified` transition itself — + dispute/resolution + certification + §G bound 3 + §H deduction ledger + **the §I measurer/acceptor-vs-certifier SoD rule AND the `SodException` record with its seals** | **STOP** — narrow review before payment authority exists |
| 6 | Payment approval + payment records + payment reversals + the `advance-recovery` deduction type and its paid-advance fact (§H) + §G bounds 4–5 + the certifier-vs-approver SoD rule and approval limits — the PAYMENT half of §I only | — |
| 7 | Cash-forecast projection (§J) + frontend hub (§M) + pilot acceptance chain + consolidated Phase-5 packet | **FINAL STOP** |

**Where the per-task mechanism lives.** §B, §C, §D, §E, §F, §G, §H, §I and the
per-task probe list are NOT deleted — they travel VERBATIM into the PR for the task
that implements them, per the owner's approved split. Until each task opens, the text
is the twenty-round-corrected draft at `claude/phase5-planning` commit `a4d469b`
(`docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md`), also visible as
the closed PR #252 diff. **A task PR that reaches its section MUST carry that text
forward rather than re-derive it** — re-deriving is precisely what produced twenty
rounds of findings, and §N records why.

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
