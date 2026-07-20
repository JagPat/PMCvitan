# Phase 3 — Material Readiness Pilot

**Status: CLEARED — the final mechanical verification returned GREEN SIGNAL: PHASE 3 PLAN
CLEARED (all five round-2 corrections pass; lineage `6fa019b → 9a84442 → 88a29fe`, all CI
green) with explicit GO for Task 1. Task 1 is MERGED (PR #189 @ `main` `24ee03f`); its
independent review returned BLOCKED NARROWLY (four findings), corrected in PR #190 (merged @
`main` `d0897a6`: ActivityRequirementRoot lineage + append-only triggers; server-resolved
`decisions.approvedRef`; type-neutral revisions + revision-owned MaterialRequirementSpec;
DATE `requiredBy` + membership/identity FKs; shared contracts; explicit `requirement.read`
policy). The narrow re-review of #190 returned SIX further findings, resolved by the round-2
correction (PR #191, merged @ `main` `7d3b29d`). The #191 narrow re-review returned BLOCKED
NARROWLY (one P1: the current-only backfill falsely rejected a valid earlier-version
provenance reference; a P2 sequential membership probe; a P3 docs staleness), resolved by
the round-3 correction (PR #192, merged @ `main` `4cc759a`: full provable-history backfill
amended in place, the idempotent `20261216000000_phase3_approval_history` migration with the
three-state operator strategy in `docs/RUNBOOK.md` §0, the reviewer's exact upgrade
reproduction in the upgrade-proof, and deterministic barrier-controlled member-removal vs
requirement-create races in both orderings). **The Task-1 narrow review returned GREEN
SIGNAL: PHASE 3 TASK 1 IS CLEARED** (lineage `7d3b29d → 27e461a → 4cc759a`; no P0/P1/P2
findings remain). **Task 2 (procurement: §H vendor tenancy + matrix, §F transitions through
comparison approval, quote normalization, the §F bound-1 requirement→requisition allocation
chain under concurrency) is MERGED** (PR #193 @ `main` `697aa18`). **Task 3 (purchase
orders + delivery commitments: §F PO versioning with PostgreSQL-frozen line snapshots incl.
UOM conversion + `committedAmountBase`, amendment/cancel/close-short, append-only promise
history, `po.*`/`delivery.*` events, the §F bound-2 requisition→PO allocation chain under
concurrency, `approvedOverage` only at issuance/amendment with reason) is DELIVERED on a
held PR from `main` @ `697aa18`, **merged (PR #194 @ `main` `7ca1fc0`)**. The Tasks 2–3
independent review returned **BLOCKED NARROWLY with seven findings** (P1: off-spec material
recorded as compliant; P1: dimensionally incorrect purchase-UOM arithmetic; P1: incomplete
quotes winning as "lowest"; P1: unsealed commercial evidence/PO provenance; P2: concurrent
double-recorded quotes; P2: multiple live commitments per PO line; P2: UTC quote expiry) —
**one focused correction PR from `main` @ `7ca1fc0` is DELIVERED on a held PR**: match-only
selection (+ material-only pipeline), the explicit purchaseUom/purchaseQty/conversionToBase
triple with derived base qty + prorated partial-order tax/freight, complete-coverage-only
comparison eligibility, PG-sealed quotes/comparisons + the four-FK provenance chain, one
recorded quote per (rfq, vendor) + one commitment per PO line, and project-timezone civil
expiry via the injected clock — merged (PR #195 @ `main` `bffd7c9`). **The narrow re-review
CLEARED six of the seven findings; only F4 database provenance remained incomplete** (two
P1s: a PO could reference a DRAFT comparison at PostgreSQL — the provenance FK omitted
status; requisition containment was not enforced through quote/PO lines). **The F4-completion
correction from `main` @ `bffd7c9` is DELIVERED on a held PR**: `comparisonStatus`
CHECK-pinned to 'approved' joins the five-column PO provenance FK (draft references
unrepresentable), and immutable denormalized `requisitionId` columns + composite FKs seal
every quote line AND PO line to their parent RFQ/PO requisition — the reviewer's three
probes RED at `bffd7c9`, GREEN at the correction head — merged (PR #196 @ `main`
`9520cd4`). **The mechanical re-review returned GREEN SIGNAL: PHASE 3 TASKS 2–3 ARE CLEARED
at `9520cd4`** (all 51 migrations apply; the three provenance probes pass; correction suite
14/14; Task 2–3 suites 24/24; upgrade proof PASSED; no remaining P0/P1/P2 findings — the
Tasks 2–3 review cycle is CLOSED; F1–F7 are not reopened absent a direct Task-4 regression).
**Task 4 (inventory: receipts + acceptance, `StockLot`, the immutable §C ledger, §F bound-3
receipt enforcement, the `ProcurementParticipant` PO-line lock) is DELIVERED on a held PR
from `main` @ `9520cd4`: the inventory module owns `StockLot` (each batch freezing the
pinned revision's full §B `MaterialSpecificationRef`) + the append-only `StockTransaction`
ledger — buckets derive by ONE generic fold per stock key, no current-quantity column exists
anywhere, and PostgreSQL CHECKs pin every §C movement equation while the append-only +
reversal-inverse triggers seal rule iii; every command re-derives buckets under the lot
`FOR UPDATE` and refuses any negative bucket; receipts run in purchase units through the
PO's frozen conversion with §F bound 3 (`Σ accepted+quarantined ≤ ordered +
approvedOverage`; rejection frees headroom) enforced through the transaction-bound
`ProcurementParticipant` PO-line lock that also appends the procurement-owned
received-progress fact; every ledger row records its source `CommandExecution` id (§C rule
ii — keyed replays append nothing); `stock.transacted` events per row; both-orders
acceptance-vs-adjustment and both bound-3 race shapes proven under the deterministic
barrier. The next review stop follows Task 5.** Three non-blocking guardrails
from the GO are recorded in §A for Tasks 5–6. Canonical spec:
`docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md`
(§10–§13, §17, §24 Phase 3, §25). Planning baseline: `main` @ `13fcf3a`; round-1 correction
merged @ `9a84442` (lineage `6fa019b → 9e33227 → 9a84442`); round-2 correction baseline:
`main` @ `9a84442`.

## Independent Architecture Review Corrections (round 1 — how each finding is resolved)

1. **[P1] Projection cannot authorize Activity start** → §A (readiness authority + lock
   protocol): `activities.start` evaluates canonical inventory coverage INSIDE its transaction
   under `lockProjectReadiness`; the projection serves UI/Inbox/Dashboard/forecast only;
   both-ordering race probes named in Tasks 5–6.
2. **[P1] Material identity + unit conversion missing** → §B: immutable
   `MaterialSpecificationRef` with normalized fingerprint + base UOM; decimal quantities with
   explicit purchase→base conversions; fingerprint-exact satisfaction or attributable approved
   substitution.
3. **[P1] Ledger conservation undefined** → §C: bucket/movement equations for every transaction
   type; per-stock-key locking, no-negative-balance, source-action idempotency, append-only
   reversals.
4. **[P1] No pilot activation mechanism** → §D: project-scoped `ProjectCapability` activation
   record; non-pilot projects provably inert (navigation, APIs, stored `gateMaterial`
   unchanged); two-projects-one-org proof in Task 1.
5. **[P1] Daily-Log semantics contradiction** → §E: an issue is NOT a delivery; issued material
   is displayed/prefilled through the inventory query contract referencing the canonical
   `MaterialIssue`; no `SiteMaterial` is fabricated or duplicated; consumption/return/wastage
   are defined against the issue; historical mismatch resolution never edits the original
   observation.
6. **[P2] Incomplete state machines** → §F: requirement revision immutability + allocation
   rules; RFQ/quote/comparison/PO/commitment transition tables with CAS rules; PO
   amendment/cancel/reissue; delivery-promise revision history; quote normalization; frozen
   base-currency commitments.
7. **[P2] Dependency/event cycle** → §G: activities owns `ActivityRequirement`, material
   readiness and the `gm` mapping; inventory owns physical coverage and exposes
   `coverageFor(requirements, tx)`; PO-line validation via a transaction-bound procurement
   participant; requirement events shrink to created/revised/cancelled; full
   producer/consumer/payload/rebuild table. (Round 2 supersedes the round-1
   `material.readiness_changed` event: derived verdicts produce NO domain event at all — §G.)
8. **[P2] Vendor tenancy + authorization unresolved** → §H: `Vendor(orgId, id)` + project
   assignment records with composite containment; org-admin vs project-procurement permission
   matrix on existing roles; removed-member and cross-scope probes; the "promotion without
   migration" claim is REPLACED by the stable-party/additive-binding design.

## Round-2 Mechanical Review Corrections (five inconsistencies — how each is resolved)

1. **[P1] Fingerprint mixed identity with provenance** → §B: `specFingerprint` hashes ONLY the
   normalized TECHNICAL identity (material/category, make, grade, attributes, base UOM);
   decision/version/option remain on `MaterialSpecificationRef` as un-hashed PROVENANCE —
   identical material approved by two decisions pools as one stock identity.
2. **[P1] Allocation double-counting** → §F: three SEPARATE allocation chains, each with its
   own bound (requirement→requisition ≤ required; requisition→PO ≤ requisition remaining;
   receipts ≤ ordered + bounded `approvedOverage`); over-ordering demands a requirement
   revision or the bounded overage field — never a generic override.
3. **[P1] Bucket math inconsistent** → §C: explicit buckets `quarantine`, `acceptedOnHand`,
   `reserved`, derived `freeAvailable = acceptedOnHand − reserved`, `rejected`,
   `issuedToActivity`, with per-transaction equations (acceptance increases `acceptedOnHand`;
   issue decreases `acceptedOnHand` and `reserved` while increasing `issuedToActivity`;
   consumption reduces only `issuedToActivity`).
4. **[P1] Projection producing a canonical event** → §G: `material.readiness_changed` is
   REMOVED. Inbox, Dashboard and the readiness projection consume the canonical
   requirement/procurement/inventory/mismatch events directly and recompute; projection
   rebuilds emit NO domain events and NO notifications; user notifications are an idempotent
   consumer effect keyed to the original source event and suppressed during rebuild.
5. **[P2] Task sequencing vs lock coverage** → §A lock-coverage table + tripwire; probes
   re-homed: Task 1 = capability/revisions/identity/decimal-UOM only; Task 2 =
   requirement→requisition allocation; Task 3 = requisition→PO allocation; Task 4 = receipt
   overage bound; Task 5 = ledger/reservation/issue/mismatch; Task 6 = ALL `start()`
   concurrency races. §E: a mismatch resolution closes exactly ONE observation and unblocks
   only when no unresolved mismatch remains.

§§D (pilot activation) and H (vendor tenancy/permissions) cleared review and are unchanged.
The modular-monolith strategy, additive migrations, the seven-task execution sequence and all
Phase-2 infrastructure are preserved unchanged. Nothing in Phases 0–2 is redesigned.

## Phase Intent (restated per the spec's Phase Intent Map, row 3)

Work on site currently cannot answer: what material is required for which activity and by when,
what was compared and ordered, what a vendor promised, what arrived and was accepted, what is in
the store, what is reserved, what was issued and consumed, and what is short. Phase 3 makes ONE
requirement flow through vendor comparison and purchase order to delivery, stock and Activity
readiness — for **one pilot project** — so labour (Phase 4) and commercial control (Phase 5)
inherit dependable demand, commitment, receipt and consumption facts.

## Facts consumed from earlier phases

Phases 0–1: authenticated project identity; composite same-project FKs; real civil dates; the
five-gate readiness truth tables (`ok | wait | fail | na`, worst-wins, first-match rows) with
evidenced/expiring overrides; `lockProjectReadiness` (the per-project advisory xact lock every
readiness-affecting write takes); closing-sign-off completion; locked approved decisions.
Phase 2: module manifests + boundary CI; the audit writer + actor attribution; the `DomainEvent`
envelope with gap-safe per-project ordering; the command-idempotency ledger; the per-consumer
transactional outbox; rebuildable generation-swapped projections + the operator rebuild registry
+ runbook; module-owned query contracts + XOR frontend read-ownership; org tenancy; the location
tree; transaction-bound owner-aligned participant methods (the Module-3/4 pattern).

## Current-State Revalidation (against `main` @ `13fcf3a`)

- `SiteMaterial` (daily-log-owned) is a DELIVERY OBSERVATION (name/qty-string/zone, optional
  `decisionId`, `matched` flag, optional node). It is retained exactly as-is; Phase 3 neither
  migrates nor repurposes it (§E).
- The material gate `gm` derives today from mismatch state only (`activity.material_blocked`
  owner-aligned participant event + stored `gateMaterial`); there is no positive coverage
  evidence. `activities.start` evaluates all five gates inside one transaction under
  `lockProjectReadiness` (Phase-1 gate PR i) — the invariant §A extends, not replaces.
- No requirement, vendor, requisition, quote, PO, commitment, receipt, stock or reservation
  table exists. Every Prisma model has exactly one manifest owner (boundary CI).

## Architecture (the eight decisions, explicit)

### §A. Material-readiness truth + lock protocol (finding 1)

**Command authority is canonical, transactional and locked — never the projection.**
`activities.start` (and any command whose guard consults `gm`) calls inventory's
`coverageFor(requirements, tx)` on the SAME transaction client, after taking
`lockProjectReadiness(tx, projectId)` — the identical protocol every readiness-affecting write
already follows. The rebuildable readiness projection (§G) feeds UI, Inbox, Dashboard and
forecast ONLY.

**Lock-coverage table** — every command below takes `lockProjectReadiness` in its own
transaction; the existing lock-coverage tripwire
(`apps/api/src/common/readiness-lock-coverage.test.ts`) is EXTENDED to enumerate exactly this
set, so an uncovered new command is a failing test, not a review finding:

| Coverage-affecting command | Module | Lock |
|---|---|---|
| `activities.start` (reads coverage in-tx) | activities | ✓ |
| requirement create / revise / cancel | activities | ✓ |
| substitution approve / revoke | activities | ✓ |
| delivery-commitment commit / revise / default | procurement | ✓ |
| receipt acceptance / rejection | inventory | ✓ |
| transfer | inventory | ✓ |
| reservation create / release | inventory | ✓ |
| issue / site-return / consumption / wastage | inventory | ✓ |
| audited adjustment | inventory | ✓ |
| mismatch resolution | daily-log | ✓ |

Truth mapping (extends the Phase-1 first-match truth tables; worst-wins across an activity's
material requirements; existing evidenced/expiring overrides apply unchanged):

| Coverage verdict (canonical, per requirement) | Definition (evaluated in-tx) | `gm` |
|---|---|---|
| `ready` | accepted, reserved stock (exact fingerprint or approved substitution) ≥ required qty for the planned work window | `ok` |
| `at-risk` | shortfall covered only by confirmed inbound commitments dated before `requiredBy`, or a commitment revised later than `requiredBy` | `wait` |
| `blocked` | shortfall with no covering commitment, or an unresolved mismatch flag | `fail` |
| `not-required` | no material requirement exists for the activity | `na` |

An activity with zero material requirements maps to `na`; the legacy mismatch block remains a
`fail` row evaluated BEFORE coverage (first-match). Race probes (ALL in Task 6 — after Task 6
connects canonical coverage to `start()`; live PG, both orderings under concurrency):
reservation release vs `start`; audited stock adjustment vs `start`; requirement revision vs
`start`; substitution revocation vs `start`; **issue vs `activities.start`** (the Task-1 GO
corrected this pair — not issue vs reservation-release) — each proves either order serializes
under the lock and the losing transaction observes the winner's state.

**Guardrails recorded at the Task-1 GO (non-blocking; binding on Tasks 5–6):**
- Material already ISSUED to an activity (`issuedToActivity`, §C) COUNTS AS COVERAGE for that
  activity — issuing reserved stock must never make the activity artificially unready.
- Readiness recomputation reacts to substitution approval AND revocation, and to BOTH mismatch
  flagging and mismatch resolution.
- The Task-6 concurrency probe pair is `issue vs activities.start`.

### §B. Canonical material identity + units (finding 2)

| Element | Definition |
|---|---|
| `MaterialSpecificationRef` (immutable value object, stored on every demand/supply row) | TECHNICAL IDENTITY `{ materialCategory, make, grade, normalizedAttributes, baseUom, specFingerprint }` + PROVENANCE `{ decisionId, decisionVersion, optionKey }` — written once at row creation, never updated; a spec change produces a NEW ref via a requirement revision (§F) |
| `specFingerprint` | SHA-256 over ONLY the normalized technical identity tuple (materialCategory + make + grade + normalizedAttributes + baseUom) — computed by ONE shared pure function in `@vitan/shared`, identical on API and web. Provenance (decision/version/option) is NOT hashed: identical material approved by two different decisions has ONE fingerprint and pools as one stock identity, while every row still carries which decision approved it |
| Quantities | `Decimal` (Prisma `Decimal`/PostgreSQL `numeric(18,6)`) everywhere — never strings, never floats |
| UOM | every quantity column carries its UOM; each material has ONE `baseUom`; purchase rows store `purchaseUom` + `conversionToBase: Decimal` fixed at PO issuance (frozen with the PO snapshot); ledger and coverage arithmetic run in base UOM only |
| Satisfaction rule | stock satisfies a requirement ONLY when `specFingerprint` matches exactly, OR an ACTIVE `ApprovedSubstitution { requirementId, fromFingerprint, toFingerprint, approvedById, reason, at, revokedAt?, revokedById?, revokeReason? }` exists (pmc authority, audited, event-bearing). Revocation is an audited, lock-covered command (§A) that never deletes the record — coverage re-derives without the substitution from that point on |

### §C. Stock ledger conservation (finding 3)

Stock key = `(projectId, storeLocation, stockLotId)`; every lot carries its
`MaterialSpecificationRef`. Buckets per stock key — ALL derivations over the append-only
`StockTransaction` ledger, no current-quantity column exists anywhere:

| Bucket | Meaning |
|---|---|
| `quarantine` | received, quality decision pending |
| `acceptedOnHand` | accepted stock physically in the store/staging location |
| `reserved` | the portion of `acceptedOnHand` claimed for upcoming activities |
| `freeAvailable` | **derived, never stored:** `freeAvailable = acceptedOnHand − reserved` |
| `rejected` | failed quality, awaiting vendor return |
| `issuedToActivity` | custody left the store for an activity, not yet consumed/returned/written off |

| Transaction | Equation | Guards / notes |
|---|---|---|
| `receipt` | `quarantine ↑` | references PO line + delivery commitment; qty in base UOM via the PO's frozen conversion; `Σ accepted+quarantined per PO line ≤ ordered + approvedOverage` (§F) |
| `acceptance` | `quarantine ↓ → acceptedOnHand ↑` | quality result + evidence required; partial acceptance allowed |
| `rejection` | `quarantine ↓ → rejected ↑` | evidence required |
| `vendor-return` | `rejected ↓` → (vendor) | closes the rejection |
| `transfer` | `acceptedOnHand@A ↓ → acceptedOnHand@B ↑` | same project, store↔staging; guard `freeAvailable@A ≥ qty` (reservations do not travel) |
| `reservation` | `reserved ↑` | guard `freeAvailable ≥ qty`; `acceptedOnHand` unchanged |
| `reservation-release` | `reserved ↓` | on cancel/revise/consumed-start |
| `issue` | `acceptedOnHand ↓`, `reserved ↓` (by the activity's reserved portion, floor 0), `issuedToActivity ↑` | must reference activity + location; guard `qty ≤ freeAvailable + reservedForThisActivity`; the ONLY transaction that decreases store on-hand for work |
| `consumption` | `issuedToActivity ↓` | ONLY `issuedToActivity` — never a store bucket (the double-count guard) |
| `site-return` | `issuedToActivity ↓ → acceptedOnHand ↑` | material physically back in store |
| `wastage` | `issuedToActivity ↓` | written off; pmc authority + reason + evidence |
| `adjustment` | any → any | audited, reasoned, pmc authority; the ONLY free-form movement |

Rules: (i) every balance-affecting command re-derives the affected key's buckets inside its
transaction while holding a per-stock-key `SELECT … FOR UPDATE` on the lot row, and REFUSES any
transaction that would drive ANY bucket (including derived `freeAvailable`) negative — so
`reserved ≤ acceptedOnHand` always holds; (ii) each ledger row records its source action
(`commandId` from the idempotency ledger) — replays are idempotent by construction; (iii) no
row is ever updated or deleted — corrections append explicit reversal transactions referencing
the reversed row.

### §D. Pilot activation (finding 4)

New platform-owned record `ProjectCapability { projectId, capability: 'materials', enabledAt,
enabledById }` (additive table; composite FK to the project). Every Phase-3 route guard, module
manifest surface, navigation entry and snapshot/query behavior checks it:

| Surface | Capability OFF (non-pilot — MUST equal today's behavior) | Capability ON (pilot) |
|---|---|---|
| Navigation / screens | unchanged; no Materials/Procurement/Store entries | new module screens |
| Phase-3 APIs | 404/403 as if the routes' feature does not exist for the project | active |
| `gm` derivation | stored `gateMaterial` + mismatch flags, byte-identical to today | §A truth table (mismatch rows retained) |
| Events/outbox | no Phase-3 events emitted for the project | full catalog |

Task 1 proves it: two projects in ONE organization, capability enabled on one — the other's
characterization pins (snapshot shape, gm behavior, navigation manifest) are byte-identical
before/after the migration and with the module code deployed.

### §E. Daily-Log reconciliation (finding 5)

An issue is NOT a delivery. `SiteMaterial` remains the daily-log-owned observation of what
ARRIVED; the canonical record of what LEFT THE STORE for an activity is inventory's
`MaterialIssue`. The Daily Log SCREEN shows issued-today material by READING inventory's query
contract (module-owned read referencing `MaterialIssue` ids) alongside its own observations —
nothing is copied into `SiteMaterial`, no row is fabricated, and deleting/correcting an issue
can never orphan a daily-log row. Consumption, site-return and wastage are recorded AGAINST the
referenced `MaterialIssue` (§C buckets). A historical mismatch (`matched: false` observation)
is resolved by an explicit, audited `MismatchResolution { siteMaterialId, resolution,
resolvedById, reason, at }` record + event — the original observation row is never edited.
A resolution closes EXACTLY ONE observation (`siteMaterialId` is UNIQUE on the resolution
table); the activity's mismatch block clears ONLY when NO unresolved mismatch observation
remains for it — §A's `fail` row evaluates "any unresolved mismatch", not "a resolution
exists".

### §F. Requirement + procurement state machines (finding 6)

**Requirement revisions:** an `ActivityRequirement` referenced by any requisition/PO line is
immutable — a change appends a new `revision` (monotone int; same requirement id) with the
prior revision retained; downstream lines pin `(requirementId, revision)`. Cancelling a
revision with open downstream lines demands an explicit disposition (cancel lines or re-point
to the new revision — pmc authority, audited). **Allocation — three SEPARATE chains, each with its own bound** (a requisition and its PO
never count against the same ceiling, so requisition 100 followed by PO 100 is allocation 100,
not 200). Each guard is enforced in-transaction with FOR UPDATE on the parent row; splits and
partial orders are the normal case:

| Chain | Bound (in base UOM, per fingerprint) |
|---|---|
| requirement revision → requisition lines | `Σ requisition-line allocations ≤ required qty` of that revision |
| approved requisition line → PO lines | `Σ PO-line allocations ≤ requisition-line remaining qty` |
| PO line → receipts | `Σ received qty ≤ ordered qty + approvedOverage` — `approvedOverage` is a bounded `Decimal` field on the PO line (default 0), set only by pmc at issuance/amendment with reason |

Ordering more than these bounds allow requires a REQUIREMENT REVISION (which raises the first
ceiling attributably) or the bounded `approvedOverage` — never a generic override.

Transitions (CAS on `(id, status)` — the Phase-1 concurrency discipline; every transition is a
ledgered, audited command):

| Entity | Transitions |
|---|---|
| Requisition | `draft → submitted → approved \| rejected`; `approved → closed` (all lines ordered or cancelled) |
| RFQ | `issued → closed` (quotes in or expired) |
| VendorQuote | `recorded → superseded \| expired` (validity date) |
| QuoteComparison | `draft → approved` (records authority + reason; non-lowest selection demands explicit justification) |
| PurchaseOrder | `draft → issued → partially-received → completed`; `issued → amended` (new PO VERSION row, prior frozen snapshot retained) `\| cancelled` (only with zero accepted receipts; otherwise close-short with reason); reissue = new version referencing the amended one |
| DeliveryCommitment | `committed → revised* → fulfilled \| defaulted` — every revision APPENDS a dated promise row (full history; nothing overwritten); the latest promise drives §A at-risk |

**Quote normalization (comparison inputs, stored per quote line):** base rate, tax, freight,
landed cost (all `Decimal`, project base currency INR in Stage 1), make/specification vs the
requirement's fingerprint, sample compliance, vendor stock, lead time, delivery promise, quote
validity, payment terms, warranty, historical delivery/quality score. PO issuance freezes the
line snapshot (specification ref, make, UOM conversion, rate, taxes, landed amount) — the
frozen `committedAmountBase: Decimal` is the Phase-5 commitment fact.

### §G. Module edges + event catalog (finding 7 — acyclic by construction)

Ownership: **activities** owns `ActivityRequirement`, the material-readiness derivation and the
`gm` mapping (§A). **inventory** owns physical truth (receipts, lots, ledger, reservations,
issues) and exposes the transaction-bound query `coverageFor(requirements, tx)`. **procurement**
owns vendors, requisitions, RFQs, quotes, comparisons, POs, commitments.

Dependency edges (queries/validations in the initiating transaction; all acyclic):
`procurement → activities` (requirement refs) · `procurement → decisions` (approved
specification) · `inventory → procurement` via a **transaction-bound `ProcurementParticipant`**
(validates + FOR-UPDATE-locks the PO line during receipt, appends the procurement-owned
received-progress fact on the same tx — the Module-3/4 owner-aligned pattern, not a dependency
edge for reads) · `activities → inventory` (`coverageFor`) · daily-log screen `→ inventory`
(issued-material read, §E). No module writes another's tables (boundary CI).

Event catalog (every event enveloped, per-project ordered, versioned; "rebuild query" = the
canonical read a projection replays from):

| Event | Producer | Consumers | Payload (keys) | Rebuild query |
|---|---|---|---|---|
| `requirement.created` / `revised` / `cancelled` | activities | readiness projection, procurement pipeline projection | requirementId, revision, activityId, specRef, qty, uom, requiredBy | activities: requirements by project |
| `requisition.submitted` / `approved` | procurement | pipeline projection, Inbox | requisitionId, lines[(requirementId, revision, qty)] | procurement: requisitions by project |
| `comparison.approved` | procurement | pipeline projection, audit surface | comparisonId, selectedVendorId, authority, reason | procurement: comparisons |
| `po.issued` / `amended` / `cancelled` | procurement | pipeline + readiness projections | poId, version, lines[frozen snapshot refs] | procurement: PO versions |
| `delivery.committed` / `revised` / `defaulted` | procurement | readiness projection (at-risk), forecast | commitmentId, poLineId, promisedDate history tail | procurement: commitment promises |
| `stock.transacted` | inventory | readiness projection, store view, forecast | txId, type (§C), stockKey, qty, sourceCommandId | inventory: ledger by project |
| `issue.recorded` | inventory | daily-log screen read model, readiness projection | issueId, activityId, locationId, qty | inventory: issues by project |
| `mismatch.resolved` | daily-log | readiness projection, notification consumer | siteMaterialId, resolution, authority | daily-log: resolutions |

**There is NO `material.readiness_changed` (or `requirement.satisfied`) domain event.** A
derived verdict is not a canonical fact, and a rebuildable projection must never produce
domain events, notifications or loops when rebuilt. Instead:

- The UI readiness projection (activities-owned consumer), Inbox and Dashboard each consume
  the CANONICAL events above (`requirement.*`, `po.*`, `delivery.*`, `stock.transacted`,
  `issue.recorded`, `mismatch.resolved`) and RECOMPUTE verdicts via the §A truth over
  `coverageFor` — recomputation is idempotent and rebuild-safe by construction.
- Projection rebuilds emit NO domain events and NO notifications: the rebuild replay drives
  `db`-effect projection consumers only (the established Phase-2 rebuild discipline — external
  sends ride persisted external-effect intents, which replays never dispatch).
- Any user notification for a readiness change is an IDEMPOTENT effect of the separate
  notification consumer, keyed to the ORIGINAL source event id (effectively-once via the
  processed-event record) and therefore suppressed during any rebuild.

The readiness projection joins `REBUILDABLE_PROJECTIONS` + `docs/RUNBOOK.md` in the SAME PR
that creates it (standing rule from Phase-2 packet §10), with a stored/canonical diagnostic
through the owning module's serializer.

### §H. Vendor tenancy + authorization (finding 8)

`Vendor` is org-scoped — `{ orgId, id, … }` with `@@unique([orgId, id])` — and is the ONE
exception to the every-table-carries-projectId rule, because a vendor is an organization-level
party. Project reach is an explicit additive binding: `ProjectVendor { projectId, orgId,
vendorId }` with a composite FK to `Vendor(orgId, id)` AND the project's org — so a vendor is
visible/usable in a project ONLY through a binding whose org provably matches both sides.
Every procurement row references `(projectId, vendorId)` through `ProjectVendor`, making
cross-org vendor use unrepresentable in PostgreSQL. The former "promotion without migration"
claim is WITHDRAWN and replaced by this stable-party design: `Vendor` is the durable party
record; a future Phase-6 promotion ADDS a binding from the vendor to its own organization —
additive, no row migration, no claim beyond that.

Pilot permission matrix (existing roles; enforced by the existing route-authz policy + guards):

| Action | pmc | client | engineer | contractor/consultant |
|---|---|---|---|---|
| Requirement create/revise/cancel | ✓ | — | — | — |
| Requisition submit / approve | ✓ / ✓ | — | ✓ / — | — |
| Quote record, comparison approve, PO issue/amend, substitution approve, adjustment, wastage | ✓ | — | — | — |
| Receipt record + acceptance/rejection, reservation, issue, site-return, consumption | ✓ | — | ✓ | — |
| Read: store, pipeline, readiness | ✓ | readiness summary only | ✓ | — |

Probes (live PG): removed-member refusal on every command; cross-project and cross-org refusal
for every new table (two orgs × two projects); org-admin vendor CRUD vs project-level
procurement access separation.

## Required Execution Order and Review Stops (unchanged sequence, amended content)

One task = one held PR; the full battery gates every PR. **Review stops after Tasks 1, 3, 5
and 7.** Migration slots `20261205+_phase3_*`, additive only.

1. **Task 1 — pilot activation + ActivityRequirement + characterization baseline.**
   `ProjectCapability` (§D) + `ActivityRequirement` with revisions + `MaterialSpecificationRef`
   (§B) + requirement events (§G). Acceptance (capability, revisions, identity and decimal/UOM
   ONLY — allocation probes live with the tasks that build allocations): the §D OFF-column
   proof (two projects, one org, byte-identical non-pilot pins); requirement revision
   immutability; specification-identity probes (identical material from two decisions → ONE
   fingerprint, pooled; provenance retained per row); decimal/UOM round-trip probes. STOP if
   any existing surface changes for a non-pilot project.
2. **Task 2 — procurement module: vendors, requisitions, RFQs, quotes, comparison.** §H tenancy
   tables + matrix; §F transitions through comparison approval with CAS probes; quote
   normalization fields. Acceptance: non-lowest selection demands justification; removed-member
   + cross-scope refusals; the requirement→requisition allocation chain (§F bound 1) under
   concurrency (two requisitions racing one revision cannot exceed the required qty).
3. **Task 3 — purchase orders + delivery commitments.** §F PO versioning (frozen snapshots incl.
   UOM conversion + `committedAmountBase`), amendment/cancel/close-short, appended promise
   history; `po.*`/`delivery.*` events. Acceptance: amendment preserves the prior frozen
   snapshot verbatim; promise history is append-only; the requisition→PO allocation chain
   (§F bound 2) under concurrency; `approvedOverage` recorded only at issuance/amendment with
   reason. **Review stop.**
4. **Task 4 — inventory module: receipts, acceptance, StockLot, immutable ledger.** §C buckets +
   equations + per-key locking + reversal transactions; the `ProcurementParticipant` PO-line
   lock (§G). Acceptance: adversarial probes — concurrent receipts on one PO line; the receipt
   bound (§F bound 3: `Σ received ≤ ordered + approvedOverage`) under concurrency; acceptance
   vs adjustment both-orders; a negative-balance attempt REFUSES; a replayed command appends
   nothing. STOP if any code path mutates a quantity outside a ledger append.
5. **Task 5 — reservations, issues, consumption/returns/wastage, Daily-Log read.** §C
   reservation/issue/consumption rows (consumption never touches store buckets); §E daily-log
   integration (inventory query read; no SiteMaterial writes) + `MismatchResolution`.
   Acceptance (ledger, reservation, issue and mismatch BEHAVIOR — the `start()` races belong
   to Task 6, after canonical coverage connects to `start`): §C bucket equations for
   reservation/issue/consumption/site-return/wastage incl. the double-count guard
   (consumption never touches store buckets) and `freeAvailable ≥ 0` refusals; a mismatch
   resolution closes exactly ONE observation and never edits it; the block clears only when
   no unresolved mismatch remains. **Review stop.**
6. **Task 6 — canonical coverage authority + readiness projection + operator rebuild.**
   `coverageFor(requirements, tx)`; `activities.start` in-tx integration under
   `lockProjectReadiness` with the §A mapping (worst-wins, overrides unchanged); the UI
   readiness projection (recompute-only, §G — no derived domain events) + SIXTH
   `REBUILDABLE_PROJECTIONS` entry + runbook in the same PR. Acceptance: ALL §A both-ordering
   races (reservation release, stock adjustment, requirement revision, substitution
   revocation, issue — each vs `start`); the §A lock-coverage tripwire extension
   (`readiness-lock-coverage.test.ts` enumerates every §A command); projection lag NEVER
   changes a start verdict (probe: stale projection + current canonical → start follows
   canonical); a projection REBUILD emits zero domain events and zero notifications; live ==
   projection == rebuild + the packet-§10 legacy-generation upgrade probe pattern.
7. **Task 7 — frontend surfaces + pilot acceptance suite + Phase-3 review packet.** Module-owned
   screens (pilot-gated), shortage Inbox actions + forecast impact, the e2e pilot chain
   (requirement → requisition → comparison → PO → commitment → receipt → acceptance → stock →
   reservation → issue → readiness flip → daily-log read → consumption) in a real browser over
   live PG, in BOTH capability states; the packet maps the §25 material criteria + all eight
   review decisions to evidence. **Final review stop.**

## Out of scope (unchanged)

Labour readiness (Phase 4); budgets, vendor bills, measurement, certification, payments (Phase
5); supplier/contractor portals and vendor-org promotion beyond the §H binding design (Phase 6);
accounting/RedBracket (Phase 7); organization warehouses; multi-currency (base INR frozen
amounts only); payroll; any change to existing module user flows beyond the named integration
points.

## Verification battery (every PR)

`pnpm check`; full live-PG integration suite (isolation, ledger conservation/negative-balance/
idempotency, CAS transitions, §A race probes, capability OFF-state pins); `scripts/
upgrade-proof.sh`; `test:e2e:api:allmodules(:outbox)`; boundary/module-registry checks; from
Task 6 on, the projection rebuild suite covers all SIX consumers. Every PR carries the
vision-alignment statement + review packet section.

## Vision alignment

One fact keeps one canonical owner: demand and readiness judgment with activities, commitments
with procurement, physical truth with inventory, observations with the daily log — and command
authority reads canonical facts under the project readiness lock, never a projection. Human
authority stays attributable at every judgment point; automation only propagates. Migrations
stay additive; issued documents stay frozen; tenant containment (org, project, vendor) is
database-enforced and adversarially proven against live PostgreSQL. The pilot leaves one site
running without a separate material spreadsheet — on facts Phases 4 and 5 inherit.
