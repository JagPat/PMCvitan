# Phase 3 Tasks 4–5 — integrity-correction review packet

**One focused HELD correction PR.** Base: `main` @ `b0edc5a` (the merged Tasks 4+5 head).
Does NOT roll back PR #197 or #198; does NOT begin Task 6. Preserves the existing services,
contracts, routes and frontend behavior — every change makes PostgreSQL enforce an invariant the
inventory + daily-log services already enforce in application code, so that immutable records
that feed future readiness calculations cannot be forged, mis-ordered, or left incoherent.

## Objective

Make the database representation enforce the same physical-truth invariants as the code. Four
findings, each now enforced by declarative constraints and/or triggers:

| # | Finding | Enforcement added |
|---|---------|-------------------|
| **F1** | command provenance | `StockTransaction.sourceCommandId` **NOT NULL** + **project-contained composite FK** `(projectId, sourceCommandId) → CommandExecution(projectId, id)`. Unkeyed inventory calls now reserve a **server one-shot** `CommandExecution` (`platform/commands.ts` `synthesizeKeyWhenAbsent`), so provenance exists even without a client `Idempotency-Key`; keyed calls keep exactly-once replay unchanged. |
| **F2.1** | receipt/lot chain | `StockLot` commitment↔PO-line and PO-line↔requirement-pin bound by composite FKs onto new candidate keys `DeliveryCommitment(projectId,id,poLineId)` and `PurchaseOrderLine(projectId,id,requirementId,revision)` — an incoherent chain is unrepresentable. |
| **F2.2** | frozen spec-copy fidelity | BEFORE INSERT trigger `phase3_stocklot_spec_fidelity` — every copied §B field must equal the pinned `MaterialRequirementSpec`; `baseUom` must equal the requirement revision's single-source UOM (nullable decision provenance makes a full composite FK impractical, per the finding). |
| **F2.3** | receipt ↔ lot | composite FK `(projectId,lotId,poLineId,commitmentId) → StockLot(projectId,id,poLineId,commitmentId)` — a receipt row's provenance must match its lot (MATCH SIMPLE skips non-receipt rows automatically). |
| **F3.1** | one issue movement | partial unique `StockTransaction(projectId,issueId) WHERE type='issue'`. |
| **F3.2** | every issue has its movement | **deferred** constraint trigger `MaterialIssue_requires_movement` — an orphan `MaterialIssue` is rejected at COMMIT (order-independent). |
| **F3.3** | issue-scope match | BEFORE INSERT trigger `phase3_issue_scope_match` — every issue-scoped row matches its `MaterialIssue` lot/location/activity; the `issue` movement's qty must equal the `MaterialIssue` qty (partial consumption/return/wastage keep their own smaller quantities). |
| **F4.1** | resolution needs a mismatch | BEFORE INSERT trigger `phase3_resolution_requires_mismatch` — inserts only while the observation is `matched=false`; `SELECT … FOR UPDATE` serializes against concurrent matched changes. |
| **F4.2** | resolved stays mismatched | BEFORE UPDATE trigger `phase3_resolved_stays_mismatched` — a resolved observation can never revert to `matched=true`. |

## Migration — diagnostic-first, forward-only

`20261231000000_phase3_t45_integrity_correction` runs a diagnostics DO block FIRST and **ABORTS
with a per-finding count** — before adding any constraint — if legacy rows already violate an
invariant (null/cross-project source commands, broken lot chains/spec copies, receipt≠lot,
orphan/mis-scoped issues, matched observations with resolutions). It never invents provenance.
On a clean/pilot database (no production pilot has been activated) the diagnostics pass and the
constraints apply. Operator repair for each finding is documented in `docs/RUNBOOK.md §T45`.

## Reproduce-first evidence (RED at `b0edc5a` → GREEN after correction)

`apps/api/test/integration/phase3-t45-integrity.test.ts` — 11 live-PG tests. Captured against a
scratch database migrated **only through `b0edc5a`** (the correction migration withheld):

```
=== RED run @ b0edc5a (correction withheld) ===
 ❯ phase3-t45-integrity.test.ts (11 tests | 10 failed)
   × F1: a §C ledger row with a NULL sourceCommandId is rejected      (resolved "1" instead of rejecting)
   × F1: a §C ledger row citing a source command in ANOTHER project   (resolved instead of rejecting)
   × F2.1: a stock lot with a mixed procurement chain is rejected      (resolved instead of rejecting)
   × F2.1: a stock lot whose requirement pin differs from its PO line  (resolved instead of rejecting)
   × F2.2: a stock lot whose §B spec copy is forged is rejected        (resolved instead of rejecting)
   × F2.3: a receipt row whose PO-line/commitment differs from its lot (resolved instead of rejecting)
   × F3.2: an orphan MaterialIssue is rejected at commit               (resolved "undefined" instead of rejecting)
   × F3.3: an issue-scoped movement with a different lot/location/act. (resolved instead of rejecting)
   × F4: a resolution on a matched=true observation is rejected        (resolved instead of rejecting)
   × F4: a resolved observation cannot revert to matched=true          (resolved instead of rejecting)
```

The 11th test (positive) passes at `b0edc5a` too — it proves the app-side synthesize records a
same-project source command on an unkeyed receipt (a positive proof, not a red probe).

After the correction: **11/11 GREEN**, and **10/10 consecutive** runs of the focused suite.

## Upgrade-proof — EXECUTED hostile inserts (not merely constraint-name inspection)

`apps/api/scripts/upgrade-proof.sh` now plants a coherent minimal §C chain over the migrated
legacy fixture (requirement→spec→requisition→RFQ→quote→approved comparison→PO→line→commitment→
lot→receipt + a valid MaterialIssue and its movement + a matched=false observation and its
resolution), asserts the correction **ACCEPTS** it (happy path survives), then EXECUTES seven
hostile inserts and confirms each is rejected by PostgreSQL:

```
ok  integrity correction accepts a coherent lot + receipt + issue + resolution over the legacy DB
ok  F1: a §C ledger row with a NULL sourceCommandId (rejected by PostgreSQL)
ok  F1: a §C ledger row citing a source command in another project (rejected by PostgreSQL)
ok  F2.2: a stock lot with a forged §B spec fingerprint (rejected by PostgreSQL)
ok  F3.2: an orphan MaterialIssue is rejected at commit (rejected by PostgreSQL)
ok  F3.3: an issue-scoped movement mis-scoped against its MaterialIssue (rejected by PostgreSQL)
ok  F4: a resolution on a matched=true observation (rejected by PostgreSQL)
ok  F4: a resolved observation cannot revert to matched=true (rejected by PostgreSQL)
UPGRADE PROOF PASSED
```

## Gates (all green at the correction head)

- `pnpm check` — API **605/605**, web **396/396** (typecheck + lint + unit; every tripwire pin
  including the existing inventory/daily-log seal probes updated to carry a valid source command).
- Focused adversarial suite `phase3-t45-integrity.test.ts` — **11/11**, **10 consecutive runs**.
- Full live-PG integration battery — **468/468** across 51 files (the pre-correction suites + the new `phase3-t45-integrity.test.ts`).
- Upgrade proof — **PASSED** over the legacy fixture (executed hostile inserts + the renamed
  provenance-FK assertions).
- e2e `test:e2e:api:allmodules` — **27/27**; `test:e2e:api:allmodules:outbox` — **27/27**.

## Files

- `apps/api/prisma/schema.prisma` — F1 NOT NULL + composite `sourceCommand` relation; `CommandExecution @@unique([projectId,id])`.
- `apps/api/src/platform/commands.ts` — `synthesizeKeyWhenAbsent` (opt-in; inventory only).
- `apps/api/src/inventory/inventory.service.ts` — pass the flag on all 13 commands; guard the non-null commandId.
- `apps/api/prisma/migrations/20261231000000_phase3_t45_integrity_correction/migration.sql` — diagnostics + F1–F4 constraints/triggers.
- `apps/api/test/integration/phase3-t45-integrity.test.ts` — the reproduce-first adversarial suite.
- `apps/api/test/integration/phase3-inventory.test.ts`, `phase3-t5-stock-flows.test.ts` — seal probes carry a real source command.
- `apps/api/scripts/upgrade-proof.sh` — executed hostile inserts + renamed FK assertions.
- `docs/RUNBOOK.md` — §T45 operator repair.

## Review protocol

This is a HELD draft PR from `main` @ `b0edc5a`. STOP for the narrow Codex re-review of the
integrity correction. Do not begin Task 6.
