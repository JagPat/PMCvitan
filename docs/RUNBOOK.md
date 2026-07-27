# Production Runbook — outbox cutover + projection repair

The operator procedure for taking a production deployment onto (or back onto)
`OUTBOX_SENDER_MODE=outbox` after ANY release that changes the external-effect catalog
(`apps/api/src/platform/external-effects.ts` — the sealed coverage hash changes with it), and for
repairing projection generations after a correction that changes what a projection base must
contain (e.g. the Module-4 `ON DELETE SET NULL` owner-signal correction, PR #182). Run the steps in
order; every step names the command and the check that gates the next step.

Two operator identities appear below: pass YOUR identity (email) to `--operator` and a short
auditable reason to `--reason` — both are recorded durably (`OutboxOperatorAction`).

## 0. Phase-3 approval-register migration note (one-time, releases ≥ the round-3 correction)

`20261212000000_phase3_approval_provenance` was amended IN PLACE by the Task-1 round-3
correction: its round-2 form backfilled only each decision's LATEST approval and could
falsely abort a legitimate upgrade (a requirement pinning an earlier approved version). There
are THREE possible database states — classify FIRST with the full record, not the name alone
(a failed attempt also leaves a `_prisma_migrations` row):

```sql
SELECT migration_name, finished_at, rolled_back_at, logs
FROM "_prisma_migrations" WHERE migration_name LIKE '20261212%';
```

- **No row — not yet applied** (upgrading straight from a pre-Phase-3-correction release):
  the amended migration backfills EVERY uniquely provable approval;
  `20261216000000_phase3_approval_history` then inserts nothing. No action needed.
- **`finished_at` set — successfully applied** (the defective round-2 form ran — it can only
  have completed on a database with no earlier-version spec references): `prisma migrate
  deploy` skips it by name (applied-migration checksums are not re-verified — the amendment
  is inert there, and this note is the explicit record of it) and
  `20261216000000_phase3_approval_history` idempotently completes the register with the
  missing earlier provable approvals. No action needed.
- **`finished_at IS NULL AND rolled_back_at IS NULL` — a FAILED attempt** (e.g. the defective
  form aborted on a valid earlier-version reference, or either form aborted on genuinely
  forged/unverifiable data). Prisma refuses ALL later migrations until the failed record is
  resolved. Recovery (Prisma's documented failed-migration workflow,
  https://www.prisma.io/docs/orm/prisma-migrate/workflows/patching-and-hotfixing):
  1. Read `logs` for the diagnostic; the migration runs in a single transaction, so verify
     the PostgreSQL transaction rolled back (its objects — e.g. `DecisionApprovalRevision` —
     are absent) and repair the DIAGNOSED data (genuinely forged provenance, orphan approver
     identities); a valid earlier-version reference needs NO data repair — the amended file
     itself is the fix.
  2. Mark the failed record rolled back, then redeploy:
     ```
     pnpm --filter api exec prisma migrate resolve \
       --rolled-back 20261212000000_phase3_approval_provenance
     pnpm --filter api prisma:migrate
     ```

In ALL states the deploy aborts loudly (sampled rows, named repair) on forged/unverifiable
spec provenance or approver identities naming no user — repair the data explicitly and re-run
`prisma migrate deploy`; never null provenance to force it through.

## §T45. Tasks 4–5 integrity-correction migration + repair (one-time, diagnostic-first)

`20261231000000_phase3_t45_integrity_correction` makes PostgreSQL enforce the physical-truth
invariants the inventory + daily-log services already enforce (command provenance F1, receipt/
lot provenance F2, issue canonicity F3, mismatch-resolution guards F4). It runs a **diagnostic
DO block FIRST** and ABORTS — before adding any constraint — if legacy rows already violate an
invariant, listing a per-finding count. It NEVER invents provenance.

On a clean or capability-gated **pilot** database (no production pilot has been activated yet)
there are zero offending rows: the diagnostics pass and the constraints apply. **The preflight runs
AUTOMATICALLY in the production deploy path — you do not have to remember it.**

### §T45.0 Preflight — ENFORCED by the production runner (`scripts/migrate.sh`)

The production container starts by running `scripts/migrate.sh` (see the API `Dockerfile` CMD).
**Before** `prisma migrate deploy`, that script runs the COMPILED preflight (never `tsx`):

```
node dist/platform/t45/t45.cli.js preflight
```

It is **schema-aware** and gates the deploy so the F3.1 gap can never be reached in production:

- **Fresh / empty or pre-Task-5 database** (no `MaterialIssue` / `MismatchResolution` /
  `StockTransaction.issueId`): reports `"applicable": false` and exits 0, so the migrations that
  CREATE the §C/§E schema still run.
- **Eligible database** (Task-5 schema present — including one already corrected): runs EVERY
  diagnostic — `F1.null`, `F1.foreign`, `F2.1`, `F2.2`, `F2.3`, **`F3.1` (more than one canonical
  `issue` movement per MaterialIssue)**, `F3.2`, `F3.3`, `F4` — printing per-finding counts +
  bounded samples and the `20261231…` migration state. Clean ⇒ exit 0, the deploy proceeds. Any
  unrepaired finding ⇒ the named report + a **non-zero exit**, so `migrate.sh` aborts and **Prisma
  is never started — migration 20261231 is never recorded as failed.**
- **P3005 pre-baseline database** (schema present, no `_prisma_migrations`): the preflight runs
  clean (its migration-state check tolerates the missing ledger), then `migrate deploy` hits P3005
  and the existing baseline-and-retry path runs unchanged.

This closes the gap the migration's in-line DO block cannot: the DO block aborts LOUDLY on
F1/F2/F3.2/F3.3/F4, but a **duplicate `issue` movement (F3.1)** passes the DO block and would
otherwise fail OPAQUELY inside `CREATE UNIQUE INDEX "StockTransaction_one_issue_movement_per_issue_key"`.
The enforced preflight names F3.1 explicitly, with the offending `(projectId, issueId)` group and
its transaction ids, so the operator can decide which movement is canonical.

Run the same check by hand at any time (e.g. before a manual `migrate deploy`, or to inspect a
staging database) with `pnpm --filter api t45:preflight` (exit 3 = eligible + dirty).

### §T45.1 Classify the migration record (three states, same as §0)

If a `migrate deploy` was already attempted and aborted, `20261231…` is recorded FAILED and Prisma
refuses every LATER migration until it is resolved. Classify with the full record, not the name:

```sql
SELECT migration_name, finished_at, rolled_back_at, logs
FROM "_prisma_migrations" WHERE migration_name LIKE '20261231%';
```

- **No row** — not yet attempted. Repair (if the preflight is dirty), then `migrate deploy`.
- **`finished_at` set** — already applied; the correction is enforced. No repair needed.
- **`finished_at IS NULL AND rolled_back_at IS NULL`** — a FAILED attempt (its transaction rolled
  back, so NO F1–F4 constraint was added and the append-only triggers from the earlier Task 4/5
  migrations still stand). Repair (§T45.2), then mark the record rolled back and redeploy:
  ```
  pnpm --filter api exec prisma migrate resolve --rolled-back 20261231000000_phase3_t45_integrity_correction
  pnpm --filter api prisma:migrate
  ```

### §T45.2 Repair — the ONE sanctioned path (`t45:repair`)

The offending rows live in append-only tables (`StockLot`, `StockTransaction`, `MaterialIssue`,
`MismatchResolution`), so they cannot be fixed with an ordinary UPDATE/DELETE (`phase3_immutable_row`
forbids it) and an F2/F3 shape cannot be fixed by reversing it (the corrupt row stays and the
diagnostic counts it again). Repair runs through the tool, which does the impossible-by-hand
sequence safely, in ONE bounded transaction:

1. **Back up** the database (or snapshot the pilot) and enter maintenance mode — stop application
   writes to the affected project(s). The repair takes a brief `ACCESS EXCLUSIVE` lock to toggle
   triggers.
2. **Author an explicit plan** — a JSON file naming exactly what to do to each offending row. The
   tool never guesses provenance; you supply the decision. One action per row:

   | finding | op | what it does |
   |---|---|---|
   | `F1.null` / `F1.foreign` | `set-source-command` (`id`, `commandId`) | repoint a stock row to an explicit SAME-PROJECT `CommandExecution` (validated) |
   | `F2.1` / `F2.2` | `delete-stock-lot` (`id`) | delete a structurally corrupt lot (delete its receipt rows first) |
   | `F2.3` / `F3.1` / `F3.3` | `delete-stock-transaction` (`id`) | delete a mis-provenanced, **duplicate-canonical**, or mis-scoped stock row |
   | `F3.2` | `delete-material-issue` (`id`) | delete an orphan MaterialIssue (no canonical movement) |
   | `F4` | `delete-mismatch-resolution` (`id`) | remove an erroneous resolution on a matched observation |
   | `F4` | `set-site-material-unmatched` (`id`) | restore an observation's historical `matched=false` truth |

   For **F1**, first record the reconciliation command the plan points at (an attributable,
   audited row), e.g.:
   ```sql
   INSERT INTO "CommandExecution"
     ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
   VALUES ('recon-<uuid>','project','<orgId>','<projectId>','<you>','ops.t45_reconciliation','<unique>','x','succeeded');
   ```
   For **F3.1**, YOU choose which of the duplicate `issue` movements is canonical (the preflight
   lists their ids); list the OTHERS as `delete-stock-transaction`. The tool never auto-selects.

   Example plan:
   ```json
   { "actions": [
     { "finding": "F1.null",    "op": "set-source-command",          "id": "<txId>", "commandId": "recon-<uuid>" },
     { "finding": "F2.2",       "op": "delete-stock-lot",            "id": "<lotId>" },
     { "finding": "F3.1",       "op": "delete-stock-transaction",    "id": "<duplicateIssueTxId>" },
     { "finding": "F4",         "op": "delete-mismatch-resolution",  "id": "<resolutionId>" }
   ] }
   ```
3. **Run the repair:**
   ```
   pnpm --filter api t45:repair --plan <plan.json> --operator <you@example.com> --reason "<ticket>: T45 legacy reconciliation"
   ```
   In one transaction the tool: writes a complete **before-image + your identity + reason +
   timestamp + row id** for every action into the durable `T45RepairAction` evidence table
   (created idempotently — a later Prisma migration cannot, since `20261231…` is unresolved);
   disables ONLY the four `*_append_only` triggers by name; applies your decisions; **re-enables
   and verifies** every immutability trigger; and **re-runs every diagnostic**. It COMMITS only if
   every diagnostic reads zero AND every trigger is back to enabled — otherwise the whole
   transaction ROLLS BACK (data, evidence, trigger-toggle and all), leaving the database exactly as
   it was with the triggers firing, and exits non-zero. A partial or wrong plan therefore cannot
   half-repair or leave a trigger disabled.
4. **Confirm clean and deploy.** `pnpm --filter api t45:preflight` must now exit `0`; then apply
   the migration record fix from §T45.1 (`migrate resolve --rolled-back` if it had failed) and
   `pnpm --filter api prisma:migrate`. `t45:preflight` a final time to confirm `state: applied`.
5. **Redeploy the app** and leave maintenance mode. Keep `T45RepairAction` — it is the durable,
   operator-attributed record of exactly which rows were changed and their before-images.

The reproduce-first adversarial suite (`test/integration/phase3-t45-integrity.test.ts`, RED at
`b0edc5a`), the boundary-correction repair proof (`scripts/t45-repair-proof.sh` — preflight names
every finding incl. F3.1, the migration aborts over violations, a forced repair failure rolls back
with triggers intact, the explicit repair clears every finding, the correction then deploys), and
the upgrade-proof's executed hostile inserts together prove every seal AND every repair path against
real PostgreSQL.

## §P4LC2. Phase 4 labour durability correction migration + repair (one-time, diagnostic-first)

`20270120000000_phase4_t1_correction2` makes the labour-demand and worker-skill invariants DURABLE
under later mutations. It is DIAGNOSTIC-FIRST: before installing the slice-insert demand seal and the
`LabourSkill` reverse guard, it ABORTS (no partial apply) if any pre-existing labour row already
violates them — never fabricating or silently repairing data. On a database whose labour pilot has
not run, or whose labour rows are coherent, every count is zero and it applies cleanly. Two abort
messages, each self-describing:

- **inconsistent demand aggregate** — a `LabourDemandSlice` was appended to a sealed revision after the
  fact, so `requiredQty`/`requiredBy` no longer match `SUM(personShiftQty)`/`MAX(civilDate)`. **Repair:**
  within a maintenance window, remove the offending slice(s) so the aggregate matches the frozen
  revision. Because slices are append-only, briefly disable the immutability trigger, delete, re-enable:

  ```sql
  BEGIN;
  ALTER TABLE "LabourDemandSlice" DISABLE TRIGGER "LabourDemandSlice_append_only";
  -- delete ONLY the extra slice(s) that were appended after the seal (identify by inspecting the
  -- revision's slices against its ActivityRequirement.requiredQty / requiredBy):
  DELETE FROM "LabourDemandSlice" WHERE "id" = '<the-appended-slice-id>';
  ALTER TABLE "LabourDemandSlice" ENABLE TRIGGER "LabourDemandSlice_append_only";
  COMMIT;
  ```

- **orphaned `Worker.skillCodes` element** — a `LabourSkill` was deleted (or re-keyed) out from under a
  worker still referencing it. **Repair:** restore the catalog row (`INSERT INTO "LabourSkill" …` with
  the original `(projectId, code)`), or remove the dangling code from the worker's `skillCodes` array.

Re-run `prisma migrate deploy` after the repair; the migration then applies cleanly and installs the
two durable triggers. `scripts/upgrade-proof.sh` executes this exact abort → operator repair →
redeploy cycle end-to-end against real PostgreSQL.

## §P4LC3. Phase 4 labour worker-skill NORMALIZATION migration + repair (one-time, diagnostic-first)

`20270125000000_phase4_t1_correction3` normalizes `Worker.skillCodes` into a `WorkerSkill` table with
real composite FKs (to `Worker` and to `LabourSkill`), replacing the two racing triggers with FK
concurrency semantics, then DROPS the `skillCodes` column and those triggers. It is DIAGNOSTIC-FIRST:
before creating the table it ABORTS (no partial apply) if any existing `Worker.skillCodes` element
lacks its same-project `LabourSkill` — the orphan state the un-serialized race could leave — because
the `WorkerSkill` backfill would otherwise fail the new FK, and the migration never fabricates a
catalog row. On a coherent (or labour-pilot-free) database the count is zero and it applies cleanly,
backfilling one `WorkerSkill` row per array element.

Abort message: **`% Worker.skillCodes element(s) reference a LabourSkill absent from their project
catalog`**. **Repair:** restore the missing catalog row (`INSERT INTO "LabourSkill" …` with the
original `(projectId, code)`) so the backfill satisfies the new FK, or remove the dangling code from
the worker's `skillCodes` array (`UPDATE "Worker" SET "skillCodes" = array_remove("skillCodes",
'<code>') WHERE …`). Then re-run `prisma migrate deploy`; the migration applies, `WorkerSkill` is
created and backfilled, the `Worker_skills_contained`/`LabourSkill_referenced_guard` triggers are
dropped, and `skillCodes` is removed. `scripts/upgrade-proof.sh` executes this exact abort → operator
repair → redeploy cycle against real PostgreSQL.

## §P4T2C. Phase 4 labour commercial-INTEGRITY correction migration + repair (one-time, diagnostic-first)

`20270205000000_phase4_t2_correction` seals the labour COMMERCIAL chain against the independent-review
findings (F2 requisition-line frozen identity + DB-bound spec/slice; F3 commitment↔PO-line identity FK;
F4 PO-line rate/premium provenance-bound to the comparison-selected quote line via new
`comparisonId`/`selectedQuoteId`/`selectedQuoteLineId` columns; F5 `0 ≤ committedQty ≤ personShiftQty`).
It is DIAGNOSTIC-FIRST and ADDITIVE — migration `20270201000000` is left byte-for-byte unchanged; the
labour pilot is ROW-FREE in production, so every diagnostic is zero there and the correction applies
cleanly. Where a table COULD hold a violating row the migration ABORTS (single-transaction rollback, no
partial apply) naming the finding + a bounded id sample.

### §P4T2C.0 Preflight — run BEFORE `prisma migrate deploy`

Two of the seals (F2's PO-line↔requisition-line slice FK, and F4's provenance chain) would otherwise
fail OPAQUELY inside `ALTER TABLE … ADD CONSTRAINT` rather than as a named diagnostic. Run the schema-
aware preflight first — it names every finding (F5, F3, F2.spec, F2.slice, F2.poline, F4) with counts +
bounded samples, and is a no-op ("not applicable") on a fresh/empty or pre-Task-2 database:

```
pnpm --filter api t2c:preflight
```

Exit `0` (clean or not-applicable) ⇒ safe to `prisma migrate deploy`. Exit `3` ⇒ repair first (§P4T2C.2).

### §P4T2C.1 Classify the migration record (three states, same as §T45.1)

```sql
SELECT migration_name, finished_at, rolled_back_at, logs
FROM "_prisma_migrations" WHERE migration_name LIKE '20270205%';
```

- **No row** — not yet attempted. Repair (if the preflight is dirty), then `migrate deploy`.
- **`finished_at` set** — already applied; the F2..F5 seals are enforced. No repair needed.
- **`finished_at IS NULL AND rolled_back_at IS NULL`** — a FAILED attempt (its transaction rolled back,
  so NO F2..F5 constraint/column was added and the Task-2 frozen/lifecycle triggers still stand).
  Repair (§P4T2C.2), then mark the record rolled back and redeploy:
  ```
  pnpm --filter api exec prisma migrate resolve --rolled-back 20270205000000_phase4_t2_correction
  pnpm --filter api prisma:migrate
  ```

### §P4T2C.2 Repair — the ONE sanctioned path (`t2c:repair`)

The offending rows live behind the Task-2 frozen/lifecycle triggers (`LabourPurchaseOrderLine_frozen`,
`CapacityCommitment_lifecycle_only`, …), so an F2/F3/F4 identity cannot be fixed with an ordinary
UPDATE, and cancelling/defaulting a bad row does NOT clear the diagnostic (it counts every row
regardless of status). Repair runs through the tool, which does the guarded sequence in ONE bounded
transaction — exactly like `t45:repair`:

1. **Back up** the pilot and enter maintenance mode — stop application writes to the affected
   project(s). The repair briefly toggles named triggers.
2. **Author an explicit plan** — a JSON file naming exactly what to do to each offending row. The tool
   never fabricates provenance; you supply the decision, and an F2/F4 identity is VALIDATED against the
   canonical tables before it is applied. One action per row:

   | finding | op | what it does |
   |---|---|---|
   | `F5` | `f5-set-committed-qty` (`id`, `committedQty`) | set a PO line's committedQty to the ledger truth (`0 ≤ q ≤ personShiftQty`, validated) — no trigger disabled |
   | `F3` | `f3-align-commitment` (`id`) | copy a commitment's slice identity FROM its own PO line (the canonical source) — disables `CapacityCommitment_lifecycle_only` |
   | `F2.spec` / `F2.slice` | `f2-restore-reqline-identity` (`id`, `labourSpecFingerprint`, `shift`, `civilDate`) | restore a requisition line's frozen identity to a REAL pinned spec + demand slice (validated) — no trigger disabled |
   | `F2.poline` | `f2c-align-poline-slice` (`id`) | copy a PO line's slice FROM its requisition line (the canonical source) — disables `LabourPurchaseOrderLine_frozen` |
   | `F4` | `f4-align-poline-terms` (`id`, `ratePerPersonShift`, `shiftPremium`) | set a PO line's rate/premium to the comparison-selected quote line's terms (validated to MATCH a real quote line); `committedAmountBase` is re-derived — disables `LabourPurchaseOrderLine_frozen` |

   To read a line's canonical identity for an F2/F4 plan: the pinned spec is
   `SELECT "labourSpecFingerprint","shift" FROM "LabourRequirementSpec" WHERE "projectId"=… AND
   "requirementId"=… AND "revision"=…`; the selected quote line's terms are
   `SELECT ql."ratePerPersonShift", ql."shiftPremium" FROM "SupplierLabourQuoteLine" ql JOIN
   "LabourQuoteComparison" cmp ON cmp."selectedQuoteId"=ql."quoteId" WHERE cmp."id"=<the PO's
   comparisonId> AND ql."requisitionLineId"=<the PO line's requisitionLineId>`.

   Example plan:
   ```json
   { "actions": [
     { "finding": "F5",       "op": "f5-set-committed-qty",       "id": "<poLineId>", "committedQty": 3 },
     { "finding": "F3",       "op": "f3-align-commitment",        "id": "<commitmentId>" },
     { "finding": "F2.spec",  "op": "f2-restore-reqline-identity","id": "<reqLineId>", "labourSpecFingerprint": "<hex>", "shift": "day", "civilDate": "2026-08-12" },
     { "finding": "F4",       "op": "f4-align-poline-terms",      "id": "<poLineId>", "ratePerPersonShift": "1000", "shiftPremium": "100" }
   ] }
   ```
3. **Run the repair:**
   ```
   pnpm --filter api t2c:repair --plan <plan.json> --operator <you@example.com> --reason "<ticket>: P4T2C labour commercial reconciliation"
   ```
   In one transaction the tool: writes a complete **before-image + your identity + reason + timestamp +
   row id** for every action into the durable `T2CRepairAction` evidence table (created idempotently —
   a later Prisma migration cannot, since `20270205…` is unresolved); disables ONLY the named trigger(s)
   the plan's ops actually require (minimal, "where unavoidable" — an F5 fix disables nothing); applies
   your decisions; **re-enables and verifies** every labour-commercial immutability trigger; and
   **re-runs every diagnostic**. It COMMITS only if every diagnostic reads zero AND every trigger is
   back to enabled — otherwise the whole transaction ROLLS BACK (data, evidence, trigger-toggle and
   all), leaving the database exactly as it was with the triggers firing, and exits non-zero. A partial
   or wrong plan (including one that supplies a fabricated identity, which is refused before it is
   applied) therefore cannot half-repair or leave a trigger disabled.
4. **Confirm clean and deploy.** `pnpm --filter api t2c:preflight` must now exit `0`; then apply the
   migration record fix from §P4T2C.1 (`migrate resolve --rolled-back` if it had failed) and
   `pnpm --filter api prisma:migrate`. `t2c:preflight` a final time to confirm `state: applied`.
5. **Redeploy the app** and leave maintenance mode. Keep `T2CRepairAction` — it is the durable,
   operator-attributed record of exactly which rows were changed and their before-images.

`scripts/phase4-t2-correction2-abort-proof.sh` drives this exact sequence end-to-end against real
PostgreSQL, INDEPENDENTLY for F5, F3, F2 and F4 (each finding alone aborts the migration, is repaired by
`t2c:repair`, and redeploys), and proves a fabricating plan is refused and rolled back. (The round-1
`scripts/phase4-t2-correction-abort-proof.sh` covers the F5 raw-repair path.)

## §P4T3C2. Phase 4 Task-3 correction 2 — blank manual-muster reason (one-time, diagnostic-first)

`20270220000000_phase4_t3_correction2` tightens two seals on facts the Team gate reads. Only ONE of
them can abort a deploy, and only over pre-existing data:

> `phase4 t3 correction2 finding 1: N LabourAttendance row(s) carry a blank manualReason (sample: …)`

**What it means.** A muster was recorded as a manual exception — the pmc-attributable alternative to
device evidence — but its stated reason is empty or whitespace. That is an unevidenced presence claim
with nothing behind it, and the migration refuses to install a constraint that would silently bless it.

**Nothing is deleted, and nothing is invented.** An earlier version of this section told you to
disable `LabourAttendance_append_only` and `DELETE` the offending rows. That was wrong: it erases the
original observation, its recorder, its timestamps and its correction chain — the exact record a
labour audit needs — while the trigger being disabled says in as many words that attendance rows are
never deleted. **No repair path may delete a `LabourAttendance` row.** Equally, no repair may invent
the missing real-world reason: only the person who recorded the muster knows why there was no device,
and a fabricated reason would be worse than a blank one because it would look like evidence.

The sanctioned repair therefore RETIRES the record instead. It writes a reserved marker that states
only what is true — *the original reason was blank and the real justification was never recorded* —
and revokes the row in the same statement, so it can never contribute active presence. The complete
original row, including the blank bytes and the recorder, is preserved in durable repair evidence,
and because revocation frees the live partial unique, a genuine replacement muster is a SEPARATE,
separately-attributable row rather than an edit of this one.

### 1. Back up, then diagnose

Take a backup you can restore from. Then run the preflight, which is READ-ONLY:

```
pnpm --filter api t3c:preflight
```

It prints a per-finding count with up to 20 identifying samples (`id`, project, worker, civil date,
shift, `recordedById`, `recordedAt`) plus the `20270220…`/`20270225…` migration states. Exit 0 means
clean and safe to deploy; exit 3 means findings are present. Two findings exist:

| code | meaning |
|---|---|
| `F1.blank` | a muster whose `manualReason` is blank — the state `20270220` refuses to seal over |
| `F1.marker` | a muster carrying the reserved invalid-legacy marker that is not a real audited repair — not revoked, or with no matching `T3CRepairAction` before-image for the repair id the marker embeds (see §P4T3C3) |

This preflight is also **enforced in production**: `apps/api/scripts/migrate.sh` runs the COMPILED
`dist/labour/t3c/t3c.cli.js preflight` before `prisma migrate deploy` and fails closed, so Prisma
never starts over a dirty database and `20270220` is never recorded as a failed migration. A
fresh/empty or pre-Task-3 database reports "not applicable" and passes.

### 2. Classify the migration record

```
pnpm --filter api t3c:migration-state
```

- `not-applied` — nothing to resolve; go to step 3.
- `failed-pending` — a previous deploy aborted inside `20270220`. After the repair you must run
  `npx prisma migrate resolve --rolled-back 20270220000000_phase4_t3_correction2` before redeploying.
- `applied` — the migration is already in; a `F1.blank` finding is impossible in this state.

### 3. Decide, then repair

Write an explicit plan naming every row and the accountable human who authorizes retiring it. The
repair never guesses: `revokedById` must resolve to a real `User` (enforced by
`LabourAttendance_revokedBy_fkey` — an unknown id is refused, never invented), and `revokeReason` is
your own words about the RETIREMENT (not about why the worker was present, which you do not know).

`finding` is documentary and optional: the classification written to the evidence comes from the
`op`, so a typo cannot record something untrue. If you state one and it disagrees with the op, the
repair refuses rather than reinterpreting your plan.

```json
{
  "actions": [
    {
      "finding": "F1.blank",
      "op": "f1-mark-invalid-legacy",
      "id": "<LabourAttendance id from the preflight sample>",
      "revokedById": "<User id of the person authorizing this>",
      "revokeReason": "original justification was never recorded; raise a replacement muster if this presence is real"
    }
  ]
}
```

```
pnpm --filter api t3c:repair --plan ./t3c-plan.json \
  --operator you@example.com --reason "<release>: retire pre-20270220 blank-reason musters"
```

One bounded maintenance transaction runs: it creates the durable `T3CRepairAction` evidence table,
records the **complete before-image** of every row it touches (with operator, reason, timestamp and
row id), disables ONLY `LabourAttendance_append_only` by name, applies your plan, re-enables and
VERIFIES the full §C immutability trigger set, re-runs every diagnostic, and commits **only** if
everything reads clean. Anything off — a healthy row named by mistake, an unknown `revokedById`, a
finding left uncleared — rolls the whole transaction back: data, evidence rows and trigger toggles
alike, with every seal firing. Exit 0 on a clean commit, 1 on an abort.

### 4. Resolve and redeploy

```
npx prisma migrate resolve --rolled-back 20270220000000_phase4_t3_correction2   # only if step 2 said failed-pending
npx prisma migrate deploy
```

### 5. Verify

```
pnpm --filter api t3c:preflight      # exit 0, both findings zero
```

The retired rows are still queryable, and so is everything about them:

```sql
SELECT a."id", a."workerId", a."civilDate", a."recordedById", a."recordedAt",
       a."revokedAt", a."revokedById", a."revokeReason",
       r."operator", r."reason", r."at", r."beforeImage"
  FROM "LabourAttendance" a
  JOIN "T3CRepairAction" r ON r."rowId" = a."id"
 WHERE a."manualReason" LIKE '[invalid-legacy:blank-manual-reason]%';
```

`beforeImage` holds the original row verbatim — including the blank `manualReason` and the original
recorder — so the fact that a presence was once claimed, by whom and when, is never lost.

**Note on the trim set.** PostgreSQL's one-argument `btrim(text)` strips spaces only, so the explicit
`E' \t\n\x0B\f\r'` set is used everywhere above — a tab-only reason is exactly as blank as a
space-only one.

The migration's other change (the allocation trigger taking the `ActivityRequirementRoot` lock before
reading the head) needs no operator action: it alters a function, touches no rows, and cannot abort.

`scripts/phase4-t3-correction3-production-runner-proof.sh` drives this exact sequence end-to-end
against real PostgreSQL through the REAL `migrate.sh` — fresh, pre-Task-3, clean, dirty F1.blank
(preflight names it → deploy aborts before Prisma starts → `t3c:repair` → clean redeploy), a
fabricating plan refused and rolled back with the row never deleted, a forged marker, an
already-corrected database, and a pre-baseline (P3005) database whose raw-SQL seals are verified and
really executed rather than blanket-resolved as applied.

## §P4T3C3. Phase 4 Task-3 correction 3 — a marked muster that is not a real audited repair (rare)

`20270225000000_phase4_t3_correction3` adds the seals that make the §P4T3C2 repair provably honest.
Only one of them can abort a deploy:

> `phase4 t3 correction3 finding 1: N LabourAttendance row(s) carry the reserved invalid-legacy marker without being a real audited repair — not revoked, or with no matching T3CRepairAction before-image for the embedded repair id (sample: …)`

**What it means.** A row carries `[invalid-legacy:blank-manual-reason] repair=<id>…` in `manualReason`
but is not what that marker claims to be — either it is not revoked, or there is no `T3CRepairAction`
row recording the before-image for that exact attendance row and that exact repair id. Only
`t3c:repair` may write the marker, and it writes the evidence row, the marker and the revocation
triple in ONE transaction — so this state means the marker was forged before the reserving trigger
existed, or a repair was somehow interrupted outside its transaction. Either way a human must look at
it: a marked row that is still live is an unevidenced presence claim wearing something that looks like
an explanation, and a marked row with no before-image is a claim that evidence exists when it does
not.

Revocation alone is deliberately not accepted. Until this migration installs the reserving trigger, a
direct writer can insert a marked row with the revocation triple already populated; blessing that
would make a forgery permanently indistinguishable from an audited repair.

**What to do.** Run `pnpm --filter api t3c:preflight`. Every `F1.marker` sample carries an **`exit`**
column saying which of the two recoveries applies. Read it — do not re-derive it in hand-written SQL.

An earlier version of this section printed a query that classified evidence by metadata alone, while
the diagnostic also validates the before-image and the attribution. They disagreed exactly where it
mattered: a row citing an action whose `beforeImage` is `{}` was labelled "evidenced", the operator
was told to revoke it and explicitly not to quarantine it, and after revoking, `F1.marker` was still
there and the same query gave the same unusable instruction. There is one classifier now, and it is
the one the finding itself uses.

- **`exit: revoke-through-the-application`** — a real audited repair that was left live (only
  possible if a repair was interrupted outside its transaction; the repair writes the marker and the
  revocation in one statement). Revoke it through the application
  (`POST …/labour/attendance/:id/revoke`) with a reason naming the repair. The row stays, the marker
  stays, and it stops counting as presence. `t3c:repair` refuses to quarantine such a row, precisely
  so a truthful marker is never overwritten with a false accusation.
- **`exit: quarantine`** — the marker is not backed by genuine evidence: no matching action at all,
  or one whose before-image is absent, incomplete, or about a different row, or whose attribution
  names nobody. The row claims operator provenance that has never existed. This is the state with no
  application exit — a forged marker is typically written with the revocation triple already filled
  in, and a revoked muster is terminal, so there is nothing left to revoke. Use the quarantine op
  below.

**Do not** hand-write a `T3CRepairAction` row to make the diagnostic pass. An invented before-image is
worse than a named forgery, and the evidence table is append-only, so the invention would itself be
permanent.

### Quarantine a forged marker

The quarantine preserves everything and invents nothing. The forged row is recorded VERBATIM as its
own before-image — it is not blank, and is not recorded as though it were — and `manualReason` is
rewritten to a quarantine marker embedding THIS repair id, so the row finally points at evidence that
genuinely exists. That is the one thing the original marker falsely claimed. The forgery is not
erased; it is filed, and its text stays readable in `beforeImage`.

`revokedById` must resolve to a real `User` (`LabourAttendance_revokedBy_fkey` — an unknown id is
refused, never invented). `revokeReason` is your own words about **what you found**, not about why the
worker was present, which the forged row gives you no basis to state. An already-present `revokedAt`
is kept (`COALESCE`), so a genuine earlier timestamp is never overwritten; a live forged row is
revoked as part of the same statement.

```json
{
  "actions": [
    {
      "finding": "F1.marker",
      "op": "f1-quarantine-forged-marker",
      "id": "<LabourAttendance id from the preflight sample>",
      "revokedById": "<User id of the person authorizing this>",
      "revokeReason": "marker claimed an audited repair; no repair evidence for it exists — quarantined pending incident review"
    }
  ]
}
```

```
pnpm --filter api t3c:repair --plan ./t3c-plan.json \
  --operator you@example.com --reason "<release>: quarantine forged invalid-legacy markers"
```

Same bounded maintenance transaction as §P4T3C2 step 3: durable before-image evidence, ONLY
`LabourAttendance_append_only` disabled by name, apply, re-enable and VERIFY the full §C immutability
trigger set, re-run every diagnostic, commit only if clean. Anything off rolls the whole transaction
back — data, evidence and trigger toggles alike.

Then record the incident outside the database (who had write access, when), and if the presence was
genuine, re-record it as a NEW separately-attributable muster. Revocation frees the live partial
unique, so the replacement is a distinct row rather than an edit of the quarantined one.

A quarantined row reads back with its own history intact:

```sql
SELECT a."id", a."manualReason" AS quarantine_marker,
       a."revokedAt", a."revokedById", a."revokeReason",
       r."operator", r."reason", r."at",
       r."detail"->>'forgedManualReason' AS what_the_forger_wrote,
       r."beforeImage"
  FROM "LabourAttendance" a
  JOIN "T3CRepairAction" r ON r."rowId" = a."id" AND r."op" = 'f1-quarantine-forged-marker';
```

### A warning you may see: legacy blank repair attribution

> `WARNING: phase4 t3 correction3: N legacy T3CRepairAction row(s) carry a blank operator or reason; the non-blank rule is installed NOT VALID …`

This is a **warning, not an abort**, and no action is required to deploy. It is only reachable on a
database where something wrote directly into `T3CRepairAction` — `t3c:repair` refuses a plan with a
blank `--operator` or `--reason` before it does anything.

The rule is installed `NOT VALID` in that case, deliberately. The evidence table is append-only, so
the emptiness cannot be edited away, and it should not be: an audit row that names nobody is still
the record that it was written, and back-filling a name would be inventing one. `NOT VALID` gives the
honest outcome — every FUTURE insert is rejected, the legacy rows are preserved verbatim, and nothing
is blocked. An earlier draft aborted here instead, which was a trap: the row could not be repaired,
the quarantine appends good evidence without removing the bad action, and an orphan malformed action
blocked every deploy without even producing an `F1.marker` to explain itself.

Any marker relying on such an action is diagnosed as `F1.marker` with `exit: quarantine`, because the
finding-1 predicate requires non-blank attribution. That is where the recovery happens.

```sql
SELECT "id", "repairId", "rowId", "at", "operator", "reason"
  FROM "T3CRepairAction"
 WHERE btrim("operator", E' \t\n\x0B\f\r') = '' OR btrim("reason", E' \t\n\x0B\f\r') = '';
```

### If a seal already exists but does not enforce

> `phase4 t3 correction3: … exists but does not enforce … (enabled=D, function=…)`

The migration accepts an existing trigger or CHECK only if it is ENABLED, bound to the right
function, and (for the CHECK) validated. A same-named object that is disabled or points somewhere
else is a decoy: accepting it would have Prisma record the migration applied over a table with no
protection at all. This aborts rather than silently replacing it, because replacing it would destroy
the evidence that someone put it there. Investigate who created it, then drop it deliberately and
redeploy.

### Resolve the migration record, then redeploy

If the abort happened inside `prisma migrate deploy` (a direct deploy, or a write that raced the
production preflight), `20270225000000` is left `failed-pending` and the next deploy refuses to start
until that record is resolved — exactly as for correction 2 in §P4T3C2:

```
pnpm --filter api t3c:migration-state                                            # classify first
npx prisma migrate resolve --rolled-back 20270225000000_phase4_t3_correction3    # only if failed-pending
npx prisma migrate deploy
```

### Verify

```
pnpm --filter api t3c:preflight   # exit 0, both findings zero
pnpm --filter api t3c:seals       # exit 0, all three physical objects present
```

After this migration applies, the state is unreachable: a BEFORE INSERT trigger reserves the marker
prefix (no ordinary write can claim it) and a CHECK requires any marked row to be revoked. The
`T3CRepairAction` evidence table is append-only from the same moment — a repair's before-image can
never be rewritten or deleted, which is what makes "Original row preserved in T3CRepairAction" a
guarantee rather than a sentence.

The migration's other change (the `WorkerAllocation` project-readiness lock trigger) needs no operator
action: it creates a trigger, touches no rows, and cannot abort over data.

**Pre-baseline (`prisma db push`) databases.** Everything this migration creates is raw SQL, which
`db push` does not reproduce, so such a database can look eligible and row-clean while carrying none
of the seals. `scripts/migrate.sh` therefore runs `t3c seals` on the P3005 baseline path and, when the
seals are absent, leaves `20270225000000` **pending** rather than resolving it as applied — the
retried `migrate deploy` executes it for real — then re-checks and fails closed if the objects are
still missing. If you ever baseline by hand, do the same: never
`migrate resolve --applied 20270225000000_phase4_t3_correction3` without first confirming
`pnpm --filter api t3c:seals` exits 0.

## 1. Drain all OLD application instances

Stop routing to and shut down every instance running the PREVIOUS build. The single-sender
guarantee and the coverage seal are per-catalog: an old instance still sending under the old
catalog while a new seal is recorded would race the cutover. Zero old instances before step 2.

## 2. Deploy the new build in LEGACY/SHADOW sender mode

Deploy with `OUTBOX_SENDER_MODE` unset (legacy default) or `shadow`. In these modes the
in-request dispatcher remains the sole external sender and startup does NOT require a coverage
seal — the new build serves traffic while the operator steps below run.

## 3. Rebuild ALL projections from canonical

```
pnpm --filter api projection:rebuild --operator <you@example.com> --reason "<release>: repair pre-correction generations"
```

No `--project` and no `--consumer` flag: every project is rebuilt for **ALL SIX production
projection consumers** — `decisions.inbox`, `daily-log.inbox`, `drawings.inbox`,
`inspections.inbox`, `activities.schedule`, and `activities.material-readiness` (Phase 3 Task 6 —
the pilot's recompute-only UI material-readiness projection; on a non-pilot project it rebuilds to
an empty verdict set). This step MUST complete (gated by step 4) **before**
enabling all module-query reads on the web deployment (`VITE_*_READ=moduleQuery`) and before
switching to outbox sender mode (step 7): a database upgraded from a pre-#183 build can carry a
legacy `decisions.inbox` generation that is active and caught-up but holds only a SUBSET of the
canonical decision register — the read path serves it as authoritative, and only this rebuild (or
the next decision event on that project) repairs it. The run audits the invocation BEFORE any work
and records a per-(project, consumer) outcome row, so an interrupted run is attributable and safely
re-runnable (idempotent: each run builds a fresh generation from canonical and swaps behind the
activation barrier — reads keep serving throughout).

## 4. Inspect the diagnostics

The command prints a JSON report. Gate on:

- `ok: true` — REQUIRED. `ok: false` means `corruptAfter > 0` or `failures > 0`; do not proceed.
  Re-run for the named pairs (`--project <id> --consumer <name>`) after fixing the recorded error.
- `corruptBefore` — informational: how many SERVED generations contradicted canonical before repair.
- `after.state` per pair — `current-match` (served and equal to canonical) or `lagging`
  (a write landed after the barrier; the relay catches it up and reads fall back to live meanwhile).
  **`lagging` is ordinary and healthy** — it is never corruption; do not re-run for it.

## 5. Verify the outbox is clean

```
pnpm --filter api outbox:status
```

Gate: `dead: 0` and `blocked: 0`. A dead-lettered delivery blocks its consumer's project — resolve
with `outbox:retry --delivery <uuid> --operator <you> --reason <text>` before sealing.

## 6. Seal the external-effect coverage

Still in legacy/shadow mode:

```
pnpm --filter api outbox:seal-external --operator <you@example.com> --reason "<release>: catalog changed (<summary>)"
```

Records the audited seal for the NEW catalog's coverage hash (and neutralizes any legacy-mode
external deliveries so nothing double-sends after the switch). The printed `coverageVersion` must
match the build you are about to switch — it is computed from the running code.

## 7. Switch to outbox sender mode

Set `OUTBOX_SENDER_MODE=outbox` on the deployment and restart the API. Startup VALIDATES the seal
against the catalog and refuses to boot on a mismatch (which means step 6 was skipped or an
unexpected build is deployed — go back to step 2).

## 8. Verify health and projection readiness

- `GET /health` — must be healthy.
- `pnpm --filter api outbox:status` — `dead: 0`, `blocked: 0`, `oldestPendingSeconds` low/falling
  (the relay is the sole external sender now and must be draining).
- `pnpm --filter api projection:rebuild --operator <you> --reason "post-cutover readiness check" --project <spot-check id>`
  on a spot-check project — covers all six consumers; expect `corruptBefore: 0` and `after.state`
  of `current-match` (or `lagging` that clears on the next status check). The run is idempotent and
  non-disruptive.

Done. Any deviation at a gate: stay (or return to) legacy/shadow mode — it is always safe — and
investigate with the audit trail (`OutboxOperatorAction`, ordered by `at`).
