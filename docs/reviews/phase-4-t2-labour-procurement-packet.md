# Phase 4 Task 2 — labour commercial chain (§F) review packet

**Base:** `origin/main` @ `b080e2e` (PR #219 merged — Phase 4 Task 1 CLEARED: the labour capability + type-routed demand + trusted-workforce identity, with the full six-correction lineage #215→#219, returned an independent **GREEN SIGNAL**).
**Branch:** `claude/phase4-task2` (ONE held draft PR).
**Scope:** ONLY Phase 4 Task 2 from the cleared plan — the labour COMMERCIAL chain (`docs/superpowers/plans/2026-07-23-phase-4-labour-readiness.md` §F, Task 2). **Task 1 is NOT redesigned; Task 3 does NOT begin inside this PR.** The `20270110`/`20270115`/`20270120`/`20270125` Task-1 migrations, the Prisma Task-1 schema, and every cleared Task-1 decision are UNTOUCHED.

---

## Vision alignment

Phase 4 fills the **Team** readiness gate (today a stored stub) with the same canonical, transactional, lock-protected discipline Phase 3 gave the **Material** gate. Task 2 delivers the labour **commercial chain** — the labour-specific supplier declaration + the separate labour commitment documents — reusing the platform spine verbatim: the reused procurement-owned `Vendor`/`ProjectVendor` party (F7 — no `LabourSupplier`), the `ActivityRequirement`/`LabourRequirementSpec`/`LabourDemandSlice` demand contract, `lockProjectReadiness`, the CAS command machines, the command ledger + outbox + event catalog, frozen-snapshot + append-only PostgreSQL seals, the status-pinned provenance FK, and the cycle-exempt workflow-participant channels. Every document line carries the SAME explicit `(civilDate, shift, personShiftQty)` demand slices as the requirement — never a bare headcount — so quantities are unambiguous per slice AND in total person-shifts. **Labour stays a LEAF** (`dependsOn: []`): the requirement→requisition bound reads Labour-owned tables only, and the vendor binding is validated through `ProcurementParticipant` — a workflow edge, not a read dependency.

The §F allocation bounds are **service-enforced under `FOR UPDATE` + the readiness lock** (mirroring material procurement), NOT DB triggers; the DB seals here are the CAS/frozen-snapshot/append-only/provenance physical-integrity invariants. §F bound 3 (committed/allocated ≤ ordered + overage) and the allocation/attendance/work facts are **Task 3** — deliberately absent.

---

## What shipped (§F, Task 2)

### Supplier reuse
- `VendorLabourProfile` on the existing procurement-owned `Vendor` — **org-admin** authority (like vendor CRUD), org-scoped, idempotent upsert per `(orgId, vendorId)`, composite FK `(orgId, vendorId) → Vendor(orgId, id)`. The vendor identity/name are read **through `ProcurementParticipant.resolveOrgVendor`/`orgVendorNames`** (procurement-owned reads) so Labour never touches `Vendor` directly (read-encapsulation; Labour stays a LEAF).
- `vendors.bind`/`listForProject` now accept **materials OR labour** (the reused party must be bindable on a labour-only pilot — the same shape as the Task-1 F4 `requirements.list` fix), 404 only when NEITHER capability is on.

### The separate labour commercial documents
`LabourRequisition(+lines) → LabourRfq → SupplierLabourQuote(+lines) → LabourQuoteComparison → LabourPurchaseOrder(+version+lines) → CapacityCommitment(+append-only CapacityPromise)`. Every line carries the explicit `(requirementId, revision, civilDate, shift, personShiftQty)` demand slice; the line's `shift` + `labourSpecFingerprint` are **DERIVED by the service from `LabourRequirementSpec`**, never caller-authored.

- **CAS machines** (`updateMany(id, projectId, status)`, deterministic 409): requisition `draft→submitted→approved|rejected`, `approved→closed`; RFQ `issued→closed`; quote `recorded→superseded|expired`; comparison `draft→approved`; PO version `draft→issued→amended|cancelled|closed_short`; commitment `committed→revised→defaulted`.
- **§F bound 1** (requirement → labour requisition): under `lockProjectReadiness` + a `FOR UPDATE` lock on the pinned `LabourRequirementSpec` row, `Σ active requisition-line allocations + add ≤ the demand slice's personShiftQty` — **per `(requirementId, revision, civilDate)` slice** — plus a labour-head-currency check (a stale revision is refused). Reads ONLY Labour-owned `LabourRequirementSpec`/`LabourDemandSlice`, never `ActivityRequirement`.
- **§F bound 2** (labour requisition → labour PO): under `FOR UPDATE` on the requisition line, `Σ live PO-line allocations + add ≤ the line's personShiftQty` per slice; the requisition line flips `open ↔ ordered` as its live allocation crosses its qty.
- **Frozen rate snapshot**: a PO line freezes `ratePerPersonShift + shiftPremium` from the comparison-approved SELECTED quote; `committedAmountBase = round((rate + premium) × personShiftQty, 2)` (a DB CHECK re-derives it). Amendment issues a NEW version retaining the prior VERBATIM (`supersedesVersion` lineage; frozen-column trigger). Cancel only with zero live commitments (else close-short with a reason).
- **Complete-coverage + lowest-landed comparison**: only a quote covering every open requisition line is eligible; a non-matching-spec selection is refused; a non-lowest **landed total** (`Σ landedPerPersonShift × the line's personShiftQty`) selection demands an explicit justification; quote validity is settled against the **project's** civil today (injected clock + `Project.timeZone`).
- **CapacityCommitment**: one per PO line (partial unique), its slice COPIED from the line; the append-only `seq`-monotone `CapacityPromise` register (`CHECK seq=1 OR reason NOT NULL`).

### Events, provenance, tenancy, idempotency, authorization
- The labour event family (signal-only, `invalidate:true, push:null`): `labour.requisition.submitted|approved`, `labour.comparison.approved`, `labour.po.issued|amended|cancelled|closed_short`, `capacity.committed|revised|defaulted` — in `DOMAIN_EVENT_TYPES` + `EXTERNAL_EFFECTS`; dispatched post-commit through the single `ExternalEffectDispatcher`.
- **Provenance FK** (status-pinned): `LabourPurchaseOrder(projectId, comparisonId, vendorId, requisitionId, comparisonStatus='approved') → LabourQuoteComparison(projectId, id, selectedVendorId, requisitionId, status)` — a draft-comparison order is unrepresentable. Requisition containment sealed through every quote/PO line via denormalized `requisitionId` + composite FKs.
- **Tenancy**: every operational row project-contained; cross-project/cross-org references unrepresentable (same-project/same-org composite FKs). Capability-gated (`labour`, 404 off-pilot).
- **Idempotency**: every command through `executeCommand` with a client key; a keyed replay appends NOTHING.
- **Authorization**: `labour.requisition.request` (pmc/engineer) drafts/submits; `labour.requisition.approve` (pmc) is the requisition sign-off + the RFQ/quote/comparison/PO machine; `labour.commit.manage` (pmc) is the CapacityCommitment lifecycle; the commercial reads mirror `labour.read`. `VendorLabourProfile` is org-admin.
- **The `§F disposition` guard**: cancelling a labour requirement with open/ordered labour requisition lines is refused (`LabourRequirementParticipant.assertRequirementDisposable`, type-routed from `requirements.cancel`).

### Leaf preservation + the module graph
`labour.dependsOn: []` (LEAF, unchanged); `labour.workflowParticipants: ['procurement']` (the cycle-exempt `assertVendorBound`/`resolveOrgVendor` edge, NOT a read dependency — the composite FK is the DB backstop); `producesEvents` = the 10 new labour events; `ownsModels`/`readEncapsulated` gain the 12 commercial models. The module graph stays acyclic.

---

## Additive, diagnostic-first migration

`20270201000000_phase4_t2_labour_procurement` — 12 BRAND-NEW labour-owned tables (no backfill of any existing table). Diagnostic-first guard: aborts if `LabourRequisition` already holds rows (impossible on a valid DB — the labour pilot has no commercial rows). A legacy database upgrades ROW-FREE. Every §F CAS status CHECK, `personShiftQty>0`, `shift IN ('day','night')`, `committedAmountBase = round((rate+premium)×qty,2)`, `comparisonStatus='approved'`, `seq=1 OR reason NOT NULL`; the partial uniques (`one recorded quote per (rfq,vendor)`, `one commitment per PO line`); the composite provenance/containment FKs; the frozen-snapshot + append-only triggers (`phase4_lp_*`; the append-only ones reuse `phase3_immutable_row`).

---

## Reproduce-first evidence

**`apps/api/test/integration/phase4-t2-labour-procurement.test.ts` — 11/11 (live PG).** These probes exercise brand-new tables, routes, events and a new service that **do not exist at `b080e2e`** — reproduce-first by construction (the suite cannot even run there). On the migrated DB they are GREEN:
- §F VendorLabourProfile (org-admin upsert idempotent; a project role refused 403).
- §F full CHAIN: requisition → submit → approve → RFQ → quote → comparison → PO → issue → commitment — states + the exact event sequence (`labour.requisition.submitted`,`…approved`,`labour.comparison.approved`,`labour.po.issued`,`capacity.committed`), the DERIVED line shift/fingerprint, the frozen `committedAmountBase = (1200+100)×10 = 13000`, `open→ordered`, one-commitment-per-line 409.
- §F CAS: only a draft submits / only a submitted approves — a deterministic 409 for the loser.
- §F BOUND 1: per-slice overflow refused (6+5 > 10); a nonexistent slice refused; a stale (post-revise) revision refused.
- **§F BOUND 1 (barrier RACE)**: two requisitions racing one 100-person-shift slice under the held readiness advisory lock — the first-enqueued wins (60), the second is a deterministic 409, total 60.
- §F DISPOSITION: a labour requirement cancel refused with an open labour requisition line; frees after the line is cancelled.
- §F BOUND 2: ordering 11 of a 10-line refused; the frozen PO-line rate / append-only PO root / append-only quote line reject hostile raw UPDATEs.
- §F PO LIFECYCLE: amend issues v2 retaining v1 (8) verbatim as `amended`; close-short → `closed_short` + event.
- §F COMPARISON: a non-lowest-landed selection refused without justification, accepted with it.
- IDEMPOTENCY: a keyed submit replay appends no second event.
- §D INERTNESS: the whole commercial chain 404s on a non-pilot project; zero rows.

---

## Gate battery

- **`pnpm check` — EXIT 0** (web 432/432; API 642/642, +5 over Task-1's 637 for the new labour-procurement probes; API build clean).
- **Tripwires GREEN** (133/133 across `boundary.test`, `module-registry.test`, `cross-module-graph.test`, `route-policy.test`, `readiness-lock-coverage.test`): mutating routes 116→**136** (+20 labour commercial); external-effect dispatch sites 60→**70** (+10); dispatching services 13→**14**; `MODEL_OWNER` +12 labour models; the labour manifest `readEncapsulated` complete set + `workflowParticipants: ['procurement']`; `LabourProcurementController` role policy; the 3 new `labour.*` policy actions exercised. (One harness-correctness fix: the crude `WRITE` regex in `cross-module-graph.test.ts` now ignores string-literal + comment contents so a three-segment command-name literal like `'labour.comparison.create'` is not mis-read as a Prisma write — the real boundary analyzer already ignores strings.)
- **Full integration suite** — **62 files / 542 tests, all PASSING** on a pristine migrated DB (all 62 migrations applied; +11 for `phase4-t2-labour-procurement.test.ts`). All 48 shared-DB TRUNCATE lists were extended with `CASCADE` so the new commercial tables' FKs to `ProjectVendor`/`LabourRequirementSpec`/`LabourDemandSlice` never block a sibling suite's per-test reset.
- **`upgrade-proof.sh` — PASSED** — the 12 commercial tables upgrade ROW-FREE over the legacy fixture; a coherent labour commercial chain is accepted; the out-of-machine requisition status / frozen-snapshot rate / append-only PO root / append-only capacity promise / one-commitment-per-line / committed-amount CHECK / status-pinned NON-approved provenance forgeries are ALL rejected on the migrated DB (and every prior Phase-1..Phase-4-T1 forgery rejection survives).
- **`test:e2e:api:allmodules` 31/31 and `:outbox` 31/31** — the outbox run seals the external-effect catalog first (`outbox:seal-external`, coverage `2836b0e8…`, 0 legacy deliveries neutralized — the labour event family joins the sealed set); the materials-pilot browser chain is 4/4 in both. (One `:outbox` run flaked on the three documented timing-sensitive `pillar-chain.spec.ts` inspection/reinspection steps — `getByTestId('submit-inspection')` had not yet flipped to "submitted" within the 10s wait; wholly unrelated to labour, which touches no inspection surface — and a clean re-run was 31/31.)

---

## Files

- **Shared** (`packages/shared`): `contracts/labour.ts` (+20 commands, +5 queries, +DTOs incl. `LabourRfqDto`/`SupplierLabourQuote(Line)Dto`/`LabourQuoteComparisonDto`/`LabourPurchaseOrder*Dto`/`CapacityCommitment(Promise)Dto`/`VendorLabourProfileDto`), `platform/events.ts` (+10 events), `domain/policy.ts` (+3 actions).
- **API** (`apps/api`): `prisma/schema.prisma` (+12 models); `prisma/migrations/20270201000000_phase4_t2_labour_procurement`; `src/contracts.ts` (+zod); `src/labour/labour-procurement.service.ts` + `…controller.ts` (NEW); `src/labour/labour.manifest.ts`; `src/labour/labour.participant.ts` (+`assertRequirementDisposable`); `src/activities/requirements.service.ts` (type-routed disposition); `src/procurement/procurement.participant.ts` (+`assertVendorBound`/`resolveOrgVendor`/`orgVendorNames`); `src/procurement/vendors.service.ts` (materials-OR-labour); `src/platform/external-effects.ts` (+10); `src/app.module.ts`; tripwires (`cross-module-graph.test.ts`, `boundary.test.ts`, `module-registry.test.ts`, `route-policy.test.ts`); `scripts/upgrade-proof.sh`; `test/integration/phase4-t2-labour-procurement.test.ts`.
- **Web** (`apps/web`): `tests/policy.test.ts` (+3 labour actions in the mirror literal).

**Next review stop is NOW.** Task 3 (§F bound 3 + the allocation/attendance/work facts) does not begin.
