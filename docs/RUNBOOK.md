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
falsely abort a legitimate upgrade (a requirement pinning an earlier approved version). The
strategy for both database states — check first with
`SELECT migration_name FROM "_prisma_migrations" WHERE migration_name LIKE '20261212%';`:

- **Not yet applied** (upgrading straight from a pre-Phase-3-correction release): the amended
  migration backfills EVERY uniquely provable approval; `20261216000000_phase3_approval_history`
  then inserts nothing. No action needed.
- **Already applied** (the defective round-2 form ran — it can only have completed on a
  database with no earlier-version spec references): `prisma migrate deploy` skips it by name
  (applied-migration checksums are not re-verified — the amendment is inert there, and this
  note is the explicit record of it) and `20261216000000_phase3_approval_history` idempotently
  completes the register with the missing earlier provable approvals. No action needed.

In BOTH states the deploy aborts loudly (sampled rows, named repair) on forged/unverifiable
spec provenance or approver identities naming no user — repair the data explicitly and re-run
`prisma migrate deploy`; never null provenance to force it through.

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
