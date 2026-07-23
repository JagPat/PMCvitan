# Phase 3 Tasks 4–5 — BOUNDARY-correction review packet

**One focused HELD fix-forward PR.** Base: `main` @ `7cae97f` (the merged PR #199 head).
Does NOT remove, roll back, or redesign PR #199's accepted F1–F4 database integrity constraints;
does NOT begin Task 6. It makes PR #199 *operationally* complete by closing the three boundary
defects the narrow Codex re-review found: an enforcement bypass, a runbook whose repairs PostgreSQL
forbids, and a duplicate-issue shape the migration could only fail on opaquely.

## The three findings

| # | Finding (P) | Resolution |
|---|-------------|------------|
| **F1** | **P1 — idempotency enforcement bypass.** When `synthesizeKeyWhenAbsent=true`, a missing client `Idempotency-Key` slipped past `COMMAND_KEY_ENFORCED=true` and got a fresh `srv-*` key, so a lost-response retry could execute an inventory movement again under a second server key. | `executeCommand` now decides in the required order: (1) normalize the client key; (2) if there is NO client key AND `commandKeyEnforced()` → **throw `BadRequestException` before any transaction / receipt / audit / event / ledger write**, regardless of `synthesizeKeyWhenAbsent`; (3) no key + synthesis off → the legacy `commandId:null` path; (4) otherwise the client key, or a synthesized `srv-*` key. Server synthesis chooses *provenance*; it can no longer substitute for the client key enforcement requires. Keyed exactly-once behaviour and every other module's legacy behaviour are unchanged. |
| **F2** | **P1 — runbook repairs PostgreSQL forbids.** RUNBOOK §T45 told operators to `stock.reverse` / UPDATE / DELETE append-only rows to clear a diagnostic — impossible (`phase3_immutable_row` blocks it) and, for F2/F3, ineffective (the corrupt row remains and the diagnostic re-counts it). | A real operator tool (`t45:preflight` + `t45:repair`) plus a rewritten §T45. `t45:repair` runs ONE bounded maintenance transaction that: writes a complete before-image + operator/reason/timestamp/row-id to the durable idempotent `T45RepairAction` evidence table; disables ONLY the four `*_append_only` triggers by name; applies an **explicit** operator plan (never guesses provenance); **re-enables + verifies** every immutability trigger; **re-runs every diagnostic**; and COMMITS only if the database is clean and all triggers are enabled — otherwise it rolls everything back. §T45 documents backup → maintenance mode → preflight → `_prisma_migrations` classify → repair → `migrate resolve --rolled-back` → `migrate deploy` → verify. |
| **F3** | **P2 — duplicate issue movements not diagnosed.** More than one `type='issue'` row per `(projectId, issueId)` passed the migration's DO block and then failed OPAQUELY inside `CREATE UNIQUE INDEX "StockTransaction_one_issue_movement_per_issue_key"`. | A **new F3.1 diagnostic** — count of `(projectId, issueId)` groups with >1 canonical issue movement, plus a bounded sample listing the offending transaction ids — is part of the unified diagnostics used by BOTH the preflight and the repair's in-transaction re-diagnose. The operator explicitly chooses which movement is canonical (`delete-stock-transaction` on the others); the rejected duplicate's before-image is preserved in the repair evidence. The migration `20261231…` file is left byte-for-byte unchanged (its checksum is not silently rewritten). |

## Why the migration file was not edited (F2/F3 checksum caution)

`20261231000000_phase3_t45_integrity_correction` is already recorded in some databases. Editing its
`migration.sql` would silently change its checksum and drift `migrate status`. Instead the F3.1
diagnostic lives in the **preflight**, the enforced pre-`migrate deploy` gate (`t45:preflight`), which
reports F3.1 *before* the migration ever runs — exactly the "preflight reports F3.1 before CREATE
UNIQUE INDEX" behaviour the finding asks for — and in the repair. The migration is untouched.

## New / changed files

- `apps/api/src/platform/commands.ts` — F1 enforcement-before-synthesis decision order.
- `apps/api/src/platform/t45/t45-diagnostics.ts` — the unified read-only diagnostics (F1.null,
  F1.foreign, F2.1, F2.2, F2.3, **F3.1**, F3.2, F3.3, F4) with counts + bounded samples.
- `apps/api/src/platform/t45/t45-repair.service.ts` — the controlled, transactional,
  operator-attributed repair engine (trigger disable/verify, evidence, re-diagnose, rollback).
- `apps/api/src/platform/t45/t45.cli.ts` — `t45:preflight` / `t45:migration-state` / `t45:repair`.
- `apps/api/package.json` — the three `t45:*` scripts.
- `apps/api/test/integration/command-ledger.test.ts` — the F1 reproduce-first probe.
- `apps/api/scripts/t45-repair-proof.sh` — the executed repair proof (probes 2–6 + F3.1 preflight).
- `apps/api/scripts/upgrade-proof.sh` — the F3.1 State-A seal probe (a second canonical issue
  movement is rejected by the partial unique index).
- `docs/RUNBOOK.md` — §T45 rewritten as the executable repair procedure.
- `apps/api/src/common/cross-module-graph.test.ts` — the new infra service documented (tripwire).

## Reproduce-first evidence (RED at `7cae97f` → GREEN after the correction)

### Probe 1 (F1) — enforcement is not bypassed by synthesis (Vitest, live PG)
`command-ledger.test.ts` › *"synthesizeKeyWhenAbsent does NOT bypass enforcement…"*. Captured with
the `commands.ts` fix withheld (the `7cae97f` behaviour):
```
AssertionError: promise resolved "{ replayed: false, resultRef: 'synth-on', … }" instead of rejecting
 ❯ test/integration/command-ledger.test.ts  (1 failed | 10 skipped)
```
With the fix: **11/11 GREEN** (the command-ledger suite). The probe also asserts zero side effects
on the rejected call (no receipt with `resultRef='synth-on'`, no effect row) and that a client key
still works under enforcement.

### Probes 2–6 + the F3.1 preflight — the repair path, EXECUTED against PostgreSQL
`scripts/t45-repair-proof.sh` builds a database with every Tasks 4–5 migration applied EXCEPT the
correction (append-only triggers present; F1–F4 constraints absent), plants one row per finding, and
drives the real tooling. Result: **T45 REPAIR PROOF PASSED**, covering —

```
DB1 (every finding):
  preflight names F1.null / F1.foreign / F2.2 / F3.1 / F3.2 / F3.3 / F4      (probe 5: F3.1 named)
  migrate deploy ABORTS over the violations; the F1 provenance FK is absent
  FORCED repair failure (partial plan) → rolls back: V-MI3 intact, every       (probe 6)
    append-only trigger still enabled, zero evidence rows persisted
  the full explicit repair commits: 8 before-image evidence rows, triggers      (probes 2/3/4)
    re-enabled; preflight now clean; migrate resolve --rolled-back + migrate
    deploy applies the correction; the F1 provenance FK is now present
DB2 (F3.1 alone):
  preflight names F3.1 with both duplicate transaction ids in the sample        (probe 5)
  migrate deploy fails OPAQUELY at the partial unique index (the gap)
  the explicit repair (keep F31-A, delete F31-B) commits; the rejected
    duplicate's before-image is preserved; migrate deploy then applies cleanly
```

### F3.1 State-A seal (upgrade-proof)
`scripts/upgrade-proof.sh` now also asserts a SECOND canonical issue movement for an existing
MaterialIssue is rejected by `StockTransaction_one_issue_movement_per_issue_key` over the fully
migrated legacy database.

## Gates (record actual exit codes)

- `pnpm check` — **EXIT 0** (API unit 605/605 across 55 files; web unit 396/396 across 37 files;
  typecheck + lint + build).
- `command-ledger.test.ts` — **11/11** (incl. the F1 probe; RED→GREEN captured by stashing the
  `commands.ts` fix).
- `scripts/t45-repair-proof.sh` — **PASSED** (both databases, every assertion — see above).
- Full live-PG integration battery — **EXIT 0, 469/469 across 51 files** (the pre-existing suites
  + the new F1 probe; `phase3-inventory.test.ts`, `phase3-t5-stock-flows.test.ts`,
  `phase3-t45-integrity.test.ts` all included).
- `scripts/upgrade-proof.sh` — **EXIT 0, UPGRADE PROOF PASSED** (incl. the new F3.1 State-A seal).
- `test:e2e:api:allmodules` — **27/27** (EXIT 0). Two earlier runs each had ONE non-deterministic
  browser-navigation flake (`project-scope.spec.ts` and one daily-log visibility wait — DIFFERENT
  tests each run, both passing on the next run); the specs are unrelated to the changed code
  (the diff touches no routing/daily-log/browser path).
- `test:e2e:api:allmodules:outbox` — **27/27** (EXIT 0, clean first run — the same specs green
  under the outbox sender mode, corroborating the flake diagnosis).
- Race suites 10× — **10/10 consecutive** (`-t "RACE"` over `phase3-inventory.test.ts` +
  `phase3-t5-stock-flows.test.ts`: the 50+50 concurrent-receipt race and the two-60-issues-one-100-
  pool barrier race, 4 passed / 20 skipped each iteration).

## Scope / non-goals

No rollback of PRs #197–#199. No unrelated refactoring. No Task 6. The correction adds an operator
tool + a probe + docs and one focused `executeCommand` decision-order change; it touches no module
domain table, no route, no event, no external-effect catalog entry.

## Review protocol

HELD draft PR from `main` @ `7cae97f`. STOP for the narrow Codex re-review of the boundary
correction. Do not begin Task 6.
