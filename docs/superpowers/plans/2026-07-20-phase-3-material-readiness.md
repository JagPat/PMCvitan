# Phase 3 — Material Readiness Pilot

**Status: PLANNING — this plan requires ONE independent architecture review and explicit
approval before ANY implementation begins.** Canonical spec:
`docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md`
(§10–§13, §17, §24 Phase 3, §25). Planning baseline: `main` @ `13fcf3a` (Phase 2 closed —
final verdict **GREEN SIGNAL — PHASE 2 CLEARED**; evidence:
`docs/reviews/phase-2-consolidated-review-packet.md`).

## Phase Intent (restated per the spec's Phase Intent Map, row 3)

Work on site currently cannot answer: what material is required for which activity and by when,
what was compared and ordered, what a vendor promised, what actually arrived and was accepted,
what is in the store, what is reserved for upcoming work, what was issued and consumed, and what
is short. Phase 3 makes ONE requirement flow through vendor comparison and purchase order to
delivery, stock and Activity readiness — so one entry updates the schedule, store and forecast
views — for **one pilot project**. Labour (Phase 4) and commercial control (Phase 5) need these
trustworthy material demand, commitment, receipt and consumption facts; this order exists so they
inherit facts, not spreadsheets.

## Facts consumed from earlier phases

- **Phase 0–1:** authenticated project identity; project-scoped composite FKs; real civil dates;
  the five-gate readiness truth tables with evidenced/expiring overrides; closing-sign-off
  completion; the attributable decision/drawing/inspection loops (approved specification exists
  and is locked before procurement consumes it).
- **Phase 2 (the connectors this phase plugs into, unchanged):** module manifests + boundary CI
  (ownership, read-encapsulation, no cross-module writes); the canonical audit writer + actor
  attribution; the `DomainEvent` envelope with gap-safe per-project ordering; the
  command-idempotency ledger (`Idempotency-Key` on every mutating command); the per-consumer
  transactional outbox + ordered consumers; rebuildable generation-swapped projections with the
  final activation barrier, the ALL-FIVE operator rebuild registry (`REBUILDABLE_PROJECTIONS`),
  and the gated production runbook (`docs/RUNBOOK.md`); module-owned query contracts + XOR
  frontend read-ownership; org multi-tenancy + memberships; the location tree.

## Current-State Revalidation (against `main` @ `13fcf3a`)

- `SiteMaterial` (owned by **daily-log**) is a delivery OBSERVATION: name/qty(string)/zone,
  optional `decisionId` link, `matched` flag, optional node. It is not demand, not stock, not a
  ledger. It stays exactly what it is — the site actual recorded in the Daily Log — and Phase 3
  does NOT migrate or repurpose it (a receipt-driven prefill references it; task 6).
- Material readiness today (`gm` gate) is mismatch-driven only: `flagMismatch` blocks an activity
  via the owner-aligned `activity.material_blocked` participant event. There is no positive
  "sufficient accepted, reserved stock" evidence — the exact gap §11 defines.
- No requisition, vendor, quote, purchase order, delivery commitment, receipt, stock or
  reservation table exists. `ActivityRequirement` does not exist; activity readiness links are
  the Phase-1 decision/drawing/inspection edges.
- The module registry has seven domain manifests (decisions, drawings, inspections, daily-log,
  activities, nodes, media) + platform surfaces; every Prisma model has exactly one owner
  (boundary CI enforces). New models MUST land in new manifests.

## Architecture (what the reviewer is asked to approve)

### Module boundaries (spec §6)

Two NEW backend modules, matching the spec's target monolith exactly:

- **`procurement`** — owns the demand-to-commitment chain: `MaterialRequisition` (+ lines),
  `Rfq`, `VendorQuote` (+ lines), `QuoteComparison` (+ decision authority/reason),
  `PurchaseOrder` (+ lines, FROZEN specification/rate snapshots at issuance),
  `DeliveryCommitment`. Vendors are org-scoped `Vendor` records owned by procurement in Stage 1
  (promotable to platform `companies` later without migration — the record carries no project
  scope).
- **`inventory`** — owns the physical-truth chain: `GoodsReceipt` (+ lines + quality acceptance
  result + evidence media links), `StockLot`, the IMMUTABLE `StockTransaction` ledger (receipt,
  acceptance, rejection, transfer, reservation, issue, return, vendor-return, consumption,
  wastage, audited adjustment — no module ever overwrites a current-quantity column;
  `onHand`/`reserved`/`available`/`projected(date)` are derivations), `ActivityReservation`,
  `MaterialIssue`.
- **`activities`** (existing) gains ownership of **`ActivityRequirement`** — the §11 demand
  contract (type `material` in this phase; the enum carries the other types for Phases 4+ but no
  other type is produced or consumed yet). Activities does NOT contain procurement or stock
  internals; requirements reference specifications (approved decisions) by id through the
  decisions query contract.

Dependency direction (acyclic): `procurement` depends on activities (requirement refs) +
decisions (approved specification refs) via their query contracts; `inventory` depends on
procurement (PO/commitment refs) the same way; nothing depends back. Cross-module consequences
ride domain events through the outbox — never foreign writes (boundary CI is the enforcement, as
in Phase 2).

### Events, commands, projections

- **Events (versioned, enveloped, per-project ordered):** `requirement.*` (created, updated,
  satisfied, at_risk), `requisition.*` (submitted, approved), `rfq.issued`, `quote.recorded`,
  `comparison.approved` (records selection authority + reason incl. non-lowest justification),
  `po.issued` (freezes snapshots), `delivery.committed`, `delivery.delayed`, `receipt.recorded`,
  `receipt.accepted` / `receipt.rejected`, `stock.transaction_appended`, `reservation.created` /
  `released`, `issue.recorded`. Every event appends on the SAME transaction as its write (the
  established emit discipline).
- **Commands:** every mutation is a ledgered command (Idempotency-Key), attributably audited.
  Human authority stays where §17 puts it: requisition approval, vendor selection, physical
  receipt acceptance/rejection, wastage/adjustment are HUMAN commands; propagation (needed-by
  recalculation, readiness flips, prefills, forecast updates) is automatic via consumers.
- **Material readiness becomes evidence-derived:** a new ordered projection consumer
  **`materials.readiness`** (module-owned by inventory) maintains, per activity, the §11 verdict
  — `ready` (accepted, reserved stock covers the planned work window), `at-risk` (covered only by
  confirmed inbound before the needed-by date, or delayed commitments), `blocked` (shortfall or
  mismatch), `not-required` — with owner, needed-by, evidence refs and forecast impact. The
  Phase-1 `gm` gate consumes this verdict through the truth tables; the existing mismatch block
  and evidenced/expiring overrides keep working unchanged. The projection joins
  `REBUILDABLE_PROJECTIONS` (making it SIX) **in the same PR that creates the consumer**, with a
  stored/canonical diagnostic through the module's own serializer, and `docs/RUNBOOK.md` is
  updated in that PR — the Phase-2 final-review lesson (P1, packet §10) is a standing rule:
  no projection ships without its operator repair path.
- **Frontend:** new module-owned queries + screens (Requirements on the activity panel,
  Procurement pipeline, Store/stock view, shortage Inbox actions) under the established
  module-query pattern from day one (no legacy-snapshot expansion; the snapshot gains NO new
  top-level keys). Shortages/delays surface as Inbox actions and dashboard tiles fed by the
  readiness projection — no manually entered counts (§25).

### Tenancy, isolation, migrations

Additive migrations only, in dated slots `20261205+_phase3_*`. Every new table carries
`projectId` with composite same-project FKs to everything it references (the Phase-0 discipline);
`Vendor` is org-scoped with membership-checked access; tenant isolation for every new read/write
is proven against live PostgreSQL (two-project + two-org probes). Issued POs keep FROZEN
snapshots (spec §10) — a later decision/rate change never mutates an issued document.

## Required Execution Order and Review Stops

One task = one held PR; the battery (focused tests + `pnpm check` + live-PG integration + e2e +
upgrade-proof) gates every PR. **Review stops after Tasks 1, 3, 5 and 7** (independent review;
corrections fix-forward from the reviewed head, as in Phase 2).

1. **Task 1 — ActivityRequirement demand contract + characterization baseline.** Schema +
   migration for `ActivityRequirement` (activities-owned); `requirement.*` events; requirement
   CRUD commands (pmc authority) + activity-panel query; characterization pins proving no
   existing surface changed. STOP if any existing snapshot key changes shape.
2. **Task 2 — procurement module: requisition → RFQ → quotes → comparison.** New manifest +
   models + migration; ledgered commands; `Vendor` records; comparison approval records
   authority + reason (non-lowest justification mandatory). Boundary CI green with the new
   manifest; isolation probes.
3. **Task 3 — purchase orders + delivery commitments.** PO issuance freezes
   specification/rate/vendor snapshots; `delivery.committed`/`delivery.delayed`;
   needed-by-vs-commitment risk derivation. **Review stop** (the demand→commitment chain is the
   contract Phases 4–5 build on).
4. **Task 4 — inventory module: receipts, quality acceptance, StockLot, immutable ledger.**
   Receipt against PO lines; acceptance/rejection with evidence; `StockTransaction`
   append-only ledger + derivation functions (`onHand`/`reserved`/`available`/`projected`);
   audited adjustments. STOP if any code path mutates a quantity outside a ledger append.
5. **Task 5 — reservations, issues, Daily-Log prefill.** `ActivityReservation` against available
   stock; `MaterialIssue` reduces stock via ledger transactions and PREFILLS a Daily-Log material
   observation (daily-log participant method — owner-aligned, never a foreign write); returns +
   consumption + wastage. **Review stop.**
6. **Task 6 — the `materials.readiness` projection + gate integration + operator rebuild.**
   The evidence-derived verdict per activity; truth-table integration with `gm`; SIXTH entry in
   `REBUILDABLE_PROJECTIONS` + runbook update in the SAME PR; live == projection == rebuild
   proofs incl. the legacy/partial-generation upgrade probe pattern from packet §10.
7. **Task 7 — frontend surfaces + pilot acceptance suite + Phase-3 review packet.** Module-owned
   screens; shortage Inbox actions + forecast impact; an e2e pilot chain (requirement →
   requisition → comparison → PO → commitment → receipt → stock → reservation → issue → readiness
   flip → daily-log prefill) against live PG in a real browser; the consolidated packet mapping
   the §25 material criteria to evidence. **Final review stop.**

## Out of scope (Phase 3)

Labour readiness (Phase 4); budgets, vendor bills, measurement, certification, payments (Phase
5); supplier/contractor portals (Phase 6); accounting/RedBracket (Phase 7); organization
warehouses (the transfer model accommodates them later); multi-currency; payroll; any change to
the decisions/drawings/inspections/daily-log/activities user flows beyond the named integration
points.

## Verification battery (every PR)

`pnpm check`; full live-PG integration suite (incl. new isolation + ledger-immutability +
idempotency probes); `scripts/upgrade-proof.sh` over the migration chain;
`test:e2e:api:allmodules(:outbox)`; boundary/module-registry checks; from Task 6 on, the
projection rebuild suite covers all SIX consumers. Every PR carries the vision-alignment
statement + review packet section per the standing protocol.

## Vision alignment

One fact keeps one canonical owner: demand lives with activities, commitments with procurement,
physical truth with inventory, and every derived view (readiness, forecast, dashboards) is a
rebuildable projection — never a source of truth. Human authority stays attributable at every
judgment point (approval, selection, acceptance, adjustment); automation only propagates. All
migrations are additive; tenant isolation is proven against PostgreSQL; issued commercial
documents are frozen. The pilot leaves one site running without a separate material spreadsheet
— on dependable facts Phases 4 and 5 inherit.
