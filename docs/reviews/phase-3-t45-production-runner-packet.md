# Phase 3 Tasks 4–5 — production-runner preflight review packet

**One focused HELD fix-forward PR.** Base: `main` @ `15e2699` (the merged PR #200 head).
Does NOT change the accepted repair engine, rewrite migration `20261231`, or begin Task 6.

## Finding

The F3.1 preflight (from PR #200) was documented but **not enforced in the real deploy path**:
production `apps/api/scripts/migrate.sh` invoked `prisma migrate deploy` directly and never ran
`t45:preflight`, so on the Coolify container a dirty F3.1 database would still reach the opaque
`CREATE UNIQUE INDEX` failure. "Enforced preflight" was an operator-memory requirement, not a gate.

## Correction

1. **`scripts/migrate.sh` runs the preflight BEFORE `prisma migrate deploy`.** It uses the
   **compiled production artifact** — `node dist/platform/t45/t45.cli.js preflight` — never `tsx`.
   A non-zero exit aborts the deploy before Prisma is invoked; the P3005 baseline-and-retry path is
   preserved unchanged. `migrate.sh` is the production runner (the API `Dockerfile` CMD; CI uses
   `prisma:migrate` on fresh databases), and the image build always produces `dist`, so a missing
   artifact means a broken build → fail closed.

2. **The preflight is schema-aware** (`T45RepairService.schemaEligible()` + a schema-aware CLI
   branch; `migrationState()` made robust to a missing `_prisma_migrations`):
   - **Not eligible** — a fresh/empty or pre-Task-5 database (no `MaterialIssue` /
     `MismatchResolution` / `StockTransaction.issueId`): reports `"applicable": false` and exits 0,
     so the migrations that CREATE the §C/§E schema run normally.
   - **Already corrected** (`20261231` applied): diagnostics run and must be clean → exit 0.
   - **Eligible + any finding**: prints the named per-finding report (incl. F3.1 with both duplicate
     transaction ids) and exits non-zero **before Prisma starts**.
   - **P3005 pre-baseline**: eligible + clean (the migration-state check tolerates the missing
     ledger), then `migrate deploy` P3005 → the existing baseline path runs.

3. Migration `20261231…` is **untouched** (checksum preserved). The accepted repair engine
   (`repair()` transaction) is **untouched** — this PR only adds `schemaEligible()`, guards the
   read-only `migrationState()`, and makes the CLI's `preflight` branch schema-aware.

## Executable production-runner proof

`apps/api/scripts/t45-production-runner-proof.sh` builds the API once (so `dist/...t45.cli.js`
exists) and runs the **actual `scripts/migrate.sh`** over six database states:

```
Case 1  fresh empty database            → preflight "not applicable"; migrate deploy applies all
Case 2  database older than Task 5      → "not applicable" (no MaterialIssue); Task 5 + correction apply
Case 3  clean through 20261230          → preflight applicable + clean; 20261231 then applies
Case 4  already-corrected database      → applicable + clean, state=applied; migrate deploy no-op
Case 5  P3005 pre-baseline database     → preflight clean; migrate deploy P3005 → baseline → succeeds
Case 6  dirty F3.1 database             → migrate.sh NAMES F3.1 + BOTH tx ids, exits non-zero,
                                          20261231 NEVER started/recorded; explicit repair then a
                                          clean redeploy through the SAME runner
```

Result: **T45 PRODUCTION-RUNNER PROOF PASSED** (all six cases; see `scripts/t45-production-runner-proof.sh`).

## Gates (actual exit codes)

- `pnpm check` — _<to fill: EXIT 0>_.
- Full live-PG integration battery — _<to fill>_.
- `scripts/t45-repair-proof.sh` — _<to fill: PASSED>_ (the accepted engine, unchanged).
- `scripts/t45-production-runner-proof.sh` — **PASSED** (six cases).
- `scripts/upgrade-proof.sh` — _<to fill: PASSED>_.
- `test:e2e:api:allmodules` / `:outbox` — _<to fill: 27/27 each>_.

## Scope / non-goals

No change to the repair engine, no rewrite of `20261231`, no Task 6. Files:
`platform/t45/t45-diagnostics.ts` (referenced-tables + Task-5-column exports),
`platform/t45/t45-repair.service.ts` (`schemaEligible()` + robust `migrationState()`),
`platform/t45/t45.cli.ts` (schema-aware preflight), `scripts/migrate.sh` (enforced preflight),
`scripts/t45-production-runner-proof.sh` (new proof), `docs/RUNBOOK.md` §T45.0, CLAUDE.md, ROADMAP.

## Review protocol

HELD draft PR from `main` @ `15e2699`. STOP for the mechanical re-review. Do not begin Task 6.
