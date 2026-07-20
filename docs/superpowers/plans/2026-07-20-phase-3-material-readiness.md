# Phase 3 — Material Readiness Pilot

**Status: PLANNING — corrected per the round-1 independent architecture review (CONDITIONAL
NO-GO, eight findings). Implementation remains BLOCKED until the narrow re-review of the eight
decisions clears with explicit approval; Task 1 is then immediately cleared to begin.**
Canonical spec: `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md`
(§10–§13, §17, §24 Phase 3, §25). Planning baseline: `main` @ `13fcf3a`; correction baseline:
`main` @ `6fa019b` (the merged plan PR #186 the review examined).

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
   participant; requirement events shrink to created/revised/cancelled; derived satisfaction is
   `material.readiness_changed`; full producer/consumer/payload/rebuild table.
8. **[P2] Vendor tenancy + authorization unresolved** → §H: `Vendor(orgId, id)` + project
   assignment records with composite containment; org-admin vs project-procurement permission
   matrix on existing roles; removed-member and cross-scope probes; the "promotion without
   migration" claim is REPLACED by the stable-party/additive-binding design.

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
already follows. Every Phase-3 write that can change coverage takes the same lock in its own
transaction: reservation create/release, stock acceptance/adjustment/issue/return/wastage,
requirement create/revise/cancel, delivery-commitment revise. The rebuildable readiness
projection (§G) feeds UI, Inbox, Dashboard and forecast ONLY.

Truth mapping (extends the Phase-1 first-match truth tables; worst-wins across an activity's
material requirements; existing evidenced/expiring overrides apply unchanged):

| Coverage verdict (canonical, per requirement) | Definition (evaluated in-tx) | `gm` |
|---|---|---|
| `ready` | accepted, reserved stock (exact fingerprint or approved substitution) ≥ required qty for the planned work window | `ok` |
| `at-risk` | shortfall covered only by confirmed inbound commitments dated before `requiredBy`, or a commitment revised later than `requiredBy` | `wait` |
| `blocked` | shortfall with no covering commitment, or an unresolved mismatch flag | `fail` |
| `not-required` | no material requirement exists for the activity | `na` |

An activity with zero material requirements maps to `na`; the legacy mismatch block remains a
`fail` row evaluated BEFORE coverage (first-match). Race probes (Tasks 5–6, live PG, both
orderings under concurrency): reservation release vs `start`; audited stock adjustment vs
`start`; requirement revision vs `start`; issue vs reservation release — each proves either
order serializes under the lock and the losing transaction observes the winner's state.

### §B. Canonical material identity + units (finding 2)

| Element | Definition |
|---|---|
| `MaterialSpecificationRef` (immutable value object, stored on every demand/supply row) | `{ decisionId, decisionVersion, optionKey, specFingerprint, make, grade, baseUom }` — written once at row creation, never updated; a spec change produces a NEW ref via a requirement revision (§F) |
| `specFingerprint` | SHA-256 over the normalized specification tuple (decision id + version + option + make + grade + normalized attribute text) — computed by ONE shared pure function in `@vitan/shared`, identical on API and web |
| Quantities | `Decimal` (Prisma `Decimal`/PostgreSQL `numeric(18,6)`) everywhere — never strings, never floats |
| UOM | every quantity column carries its UOM; each material has ONE `baseUom`; purchase rows store `purchaseUom` + `conversionToBase: Decimal` fixed at PO issuance (frozen with the PO snapshot); ledger and coverage arithmetic run in base UOM only |
| Satisfaction rule | stock satisfies a requirement ONLY when `specFingerprint` matches exactly, OR an `ApprovedSubstitution { requirementId, fromFingerprint, toFingerprint, approvedById, reason, at }` exists (pmc authority, audited, event-bearing) |

### §C. Stock ledger conservation (finding 3)

Stock key = `(projectId, storeLocation, stockLotId)`; every lot carries its
`MaterialSpecificationRef`. Buckets per stock key: `quarantine`, `available`, `reserved`
(a claim WITHIN available, never additive to it), `issuedToActivity` (custody left the store,
not yet consumed). All bucket values are DERIVATIONS over the append-only `StockTransaction`
ledger — no current-quantity column exists anywhere.

| Transaction | Source bucket | Destination bucket | Invariants |
|---|---|---|---|
| `receipt` | — (vendor) | `quarantine` | references PO line + delivery commitment; qty in base UOM via the PO's frozen conversion |
| `acceptance` | `quarantine` | `available` | quality result + evidence required; partial acceptance allowed |
| `rejection` | `quarantine` | — (rejected custody, awaiting vendor return) | evidence required |
| `vendor-return` | rejected custody | — (vendor) | closes the rejection |
| `transfer` | `available`@A | `available`@B | same project, store↔staging |
| `reservation` | — | `reserved` ↑ | `reserved ≤ available`; no on-hand change |
| `reservation-release` | `reserved` ↓ | — | on cancel/revise/start-consumed |
| `issue` | `available` ↓ (and `reserved` ↓ by the reserved portion) | `issuedToActivity` ↑ | must reference activity + location; store on-hand decreases HERE and only here |
| `consumption` | `issuedToActivity` ↓ | — (consumed) | NEVER touches store buckets — the double-count guard |
| `site-return` | `issuedToActivity` ↓ | `available` ↑ | material physically back in store |
| `wastage` | `issuedToActivity` ↓ | — (written off) | pmc authority + reason + evidence |
| `adjustment` | any | any | audited, reasoned, pmc authority; the ONLY free-form movement |

Rules: (i) every balance-affecting command re-derives the affected key's buckets inside its
transaction while holding a per-stock-key `SELECT … FOR UPDATE` on the lot row, and REFUSES any
transaction that would drive a bucket negative; (ii) each ledger row records its source action
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
resolvedById, reason, at }` record + event that clears the block — the original observation row
is never edited.

### §F. Requirement + procurement state machines (finding 6)

**Requirement revisions:** an `ActivityRequirement` referenced by any requisition/PO line is
immutable — a change appends a new `revision` (monotone int; same requirement id) with the
prior revision retained; downstream lines pin `(requirementId, revision)`. Cancelling a
revision with open downstream lines demands an explicit disposition (cancel lines or re-point
to the new revision — pmc authority, audited). **Allocation:** requisition/PO lines allocate
quantities against a requirement revision; `Σ allocations ≤ required qty` per revision is
enforced in-transaction (FOR UPDATE on the requirement row); splits and partial orders are the
normal case, over-allocation demands an audited override.

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
| `material.readiness_changed` | activities (derived — NOT `requirement.satisfied`) | Inbox, Dashboard, Notifications | activityId, requirementId, verdict, forecastImpact | derived: §A truth over `coverageFor` |
| `mismatch.resolved` | daily-log | activities participant (unblock), readiness projection | siteMaterialId, resolution, authority | daily-log: resolutions |

The UI readiness projection (activities-owned consumer) replays these to maintain the
Inbox/Dashboard/forecast view; it joins `REBUILDABLE_PROJECTIONS` + `docs/RUNBOOK.md` in the
SAME PR that creates it (standing rule from Phase-2 packet §10), with a stored/canonical
diagnostic through the owning module's serializer.

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
   (§B) + requirement events (§G). Acceptance: the §D OFF-column proof (two projects, one org,
   byte-identical non-pilot pins); revision immutability + allocation-guard probes; decimal/UOM
   round-trip probes. STOP if any existing surface changes for a non-pilot project.
2. **Task 2 — procurement module: vendors, requisitions, RFQs, quotes, comparison.** §H tenancy
   tables + matrix; §F transitions through comparison approval with CAS probes; quote
   normalization fields. Acceptance: non-lowest selection demands justification; removed-member
   + cross-scope refusals.
3. **Task 3 — purchase orders + delivery commitments.** §F PO versioning (frozen snapshots incl.
   UOM conversion + `committedAmountBase`), amendment/cancel/close-short, appended promise
   history; `po.*`/`delivery.*` events. Acceptance: amendment preserves the prior frozen
   snapshot verbatim; promise history is append-only. **Review stop.**
4. **Task 4 — inventory module: receipts, acceptance, StockLot, immutable ledger.** §C buckets +
   equations + per-key locking + reversal transactions; the `ProcurementParticipant` PO-line
   lock (§G). Acceptance: adversarial probes — concurrent receipts on one PO line; acceptance
   vs adjustment both-orders; a negative-balance attempt REFUSES; a replayed command appends
   nothing. STOP if any code path mutates a quantity outside a ledger append.
5. **Task 5 — reservations, issues, consumption/returns/wastage, Daily-Log read.** §C
   reservation/issue/consumption rows (consumption never touches store buckets); §E daily-log
   integration (inventory query read; no SiteMaterial writes) + `MismatchResolution`.
   Acceptance: the §A race probes involving reservations/issues; the double-count guard; a
   mismatch resolution never edits the observation. **Review stop.**
6. **Task 6 — canonical coverage authority + readiness projection + operator rebuild.**
   `coverageFor(requirements, tx)`; `activities.start` in-tx integration under
   `lockProjectReadiness` with the §A mapping (worst-wins, overrides unchanged); the UI
   readiness projection + `material.readiness_changed` + SIXTH `REBUILDABLE_PROJECTIONS` entry
   + runbook in the same PR. Acceptance: the remaining §A both-ordering races (requirement
   revision vs start, adjustment vs start); projection lag NEVER changes a start verdict
   (probe: stale projection + current canonical → start follows canonical); live == projection
   == rebuild + the packet-§10 legacy-generation upgrade probe pattern.
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
