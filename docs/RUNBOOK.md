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

**Why there is no automatic repair.** Only the person who recorded the muster knows why there was no
device. Inventing a reason would be worse than the blank: it would look like evidence. So:

1. **List them** (the abort message samples up to 20; this is the full set):
   ```sql
   SELECT "id", "projectId", "workerId", "civilDate", "shift", "recordedById", "recordedAt"
     FROM "LabourAttendance"
    WHERE "manualReason" IS NOT NULL AND btrim("manualReason", E' \t\r\n') = ''
    ORDER BY "projectId", "civilDate";
   ```
2. **Revoke each one through the application**, not with SQL — `POST …/labour/attendance/:id/revoke`
   with a real reason. Attendance is append-only: a revocation is the sanctioned correction and it
   keeps the original row as history. (A revoked row still trips the diagnostic, because its blank
   `manualReason` is still recorded; see step 3.)
3. **Re-record the presence** for each revoked muster with its true justification (or with the
   worker's bound device, if one exists). Then remove the blank rows — these are pre-correction rows
   that never carried meaning, and this is the ONE sanctioned deletion, performed under maintenance
   with the append-only trigger disabled by name, exactly as §T45 does:
   ```sql
   BEGIN;
   ALTER TABLE "LabourAttendance" DISABLE TRIGGER "LabourAttendance_append_only";
   DELETE FROM "LabourAttendance"
    WHERE "manualReason" IS NOT NULL AND btrim("manualReason", E' \t\r\n') = '';
   ALTER TABLE "LabourAttendance" ENABLE TRIGGER "LabourAttendance_append_only";
   -- verify the trigger is enabled again BEFORE committing
   SELECT tgenabled FROM pg_trigger WHERE tgname = 'LabourAttendance_append_only';  -- must be 'O'
   COMMIT;
   ```
4. **Redeploy.** The diagnostic now finds nothing and the migration applies.

**Note on the trim set.** PostgreSQL's one-argument `btrim(text)` strips spaces only, so the explicit
`E' \t\r\n'` set is used everywhere above — a tab-only reason is exactly as blank as a space-only one.

The migration's other change (the allocation trigger taking the `ActivityRequirementRoot` lock before
reading the head) needs no operator action: it alters a function, touches no rows, and cannot abort.

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
