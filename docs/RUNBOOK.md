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

No `--project` and no `--consumer` flag: every project is rebuilt for **ALL FIVE production
projection consumers** — `decisions.inbox`, `daily-log.inbox`, `drawings.inbox`,
`inspections.inbox`, `activities.schedule`. This step MUST complete (gated by step 4) **before**
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
  on a spot-check project — covers all five consumers; expect `corruptBefore: 0` and `after.state`
  of `current-match` (or `lagging` that clears on the next status check). The run is idempotent and
  non-disruptive.

Done. Any deviation at a gate: stay (or return to) legacy/shadow mode — it is always safe — and
investigate with the audit trail (`OutboxOperatorAction`, ordered by `at`).
