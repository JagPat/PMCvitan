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

## §T45. Tasks 4–5 integrity-correction migration note (one-time, diagnostic-first)

`20261231000000_phase3_t45_integrity_correction` makes PostgreSQL enforce the physical-truth
invariants the inventory + daily-log services already enforce (command provenance F1, receipt/
lot provenance F2, issue canonicity F3, mismatch-resolution guards F4). It runs a **diagnostic
DO block FIRST** and ABORTS — before adding any constraint — if legacy rows already violate an
invariant, listing a per-finding count. It NEVER invents provenance.

On a clean or capability-gated **pilot** database (no production pilot has been activated yet)
there are zero offending rows: the diagnostics pass and the constraints apply. If the deploy
aborts with `Phase 3 Tasks 4–5 integrity correction ABORTED …`, the transaction rolled back and
NO constraint was added; classify and repair each listed finding, then re-run `prisma migrate
deploy`:

- **F1 — NULL / cross-project `sourceCommandId`.** Only legacy UNKEYED inventory calls made
  before this release could have left a null (keyed calls always recorded one; the app now
  synthesizes a server one-shot command for unkeyed calls too). These rows cannot be
  auto-repaired — the appending command is unknowable. The operator records an explicit,
  audited reconciliation `CommandExecution` (scopeKind `project`, the row's `projectId`,
  `commandType='ops.t45_reconciliation'`, a unique `idempotencyKey`, `status='succeeded'`) and
  sets the offending rows' `sourceCommandId` to it — an attributable operator action, logged in
  the change record. A cross-project `sourceCommandId` is a real defect: identify the correct
  same-project command from the audit log; do not repoint blindly.
- **F2.1 / F2.2 / F2.3 — broken lot chain, forged spec copy, or receipt≠lot.** A lot whose
  procurement chain or frozen §B copy does not match its pinned requirement revision, or a
  receipt row whose PO-line/commitment differs from its lot, indicates corrupted provenance.
  Because `StockLot`/`StockTransaction` are append-only, reverse the affected receipt through
  `stock.reverse` (attributable) and re-record it against the correct chain; do NOT edit the
  frozen columns.
- **F3.2 / F3.3 — orphan or mis-scoped issue.** An orphan `MaterialIssue` (no canonical `issue`
  movement) or an issue-scoped row disagreeing with its issue is a broken §E record. Append the
  missing/ correcting movement through the normal issue command, or reverse the mis-scoped row;
  the register itself is never edited.
- **F4 — a resolution on a matched=true observation.** The observation was re-matched after
  resolution (impossible once this migration is in place). Confirm which state is correct from
  the audit log and reconcile: either the resolution stands (set the observation back to
  `matched=false`, its historical truth) or the resolution was erroneous and is removed by an
  operator action recorded in the change log.

The reproduce-first adversarial suite (`test/integration/phase3-t45-integrity.test.ts`, RED at
`b0edc5a`) and the upgrade-proof's executed hostile inserts prove every seal rejects the shapes
above; this note is the operator's repair path if a legacy database presents them.

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
