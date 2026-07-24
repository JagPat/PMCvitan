# Phase 4 Task 2 — correction ROUND 2 review packet (labour requisition lifecycle + executable repair)

**Directive:** fix-forward the round-1 re-review's lifecycle-consistency finding and its four attached
requirements — reproduce the defect first, fix `defaultCapacity`/`closeRequisition` transactionally,
replace the non-executable F2/F3/F4 runbook repairs with an audited operator mechanism, expand the
abort/repair proof to F2/F3/F4/F5 independently, and replace the probabilistic race loops with
deterministic barriers. Do NOT roll back PR #221; do NOT modify migrations `20270201000000` or
`20270205000000`; do NOT begin Task 3.

- **Base / merged `main`:** `81e43ed` (merge of PR #221)
- **Correction branch:** `claude/phase4-task2-correction2` (from `main` `81e43ed`)
- **No migration change** — this round is a SERVICE-logic correction + an ADDITIVE operator tool +
  test/doc changes. `20270201000000` and `20270205000000` are byte-for-byte unchanged. The `t2c`
  repair engine's `T2CRepairAction` evidence table is created idempotently at repair time (never a
  schema migration), exactly like `T45RepairAction`.

## The lifecycle defect (reproduced RED at `81e43ed`)

A defaulted commitment left the requisition line's `status` column STALE, and `closeRequisition`
trusted that column, so a requisition with an uncovered line could be closed:

- `defaultCapacity` cleared `committedQty` + recomputed the PO version, but never refreshed the
  requisition line — a defaulted commitment on a terminal (closed_short) version left the line stuck
  `ordered` with ZERO live allocation.
- `closeRequisition` counted `status='open'` rows instead of deriving live allocation, so it accepted
  a requisition whose `ordered` line was in truth uncovered.

`test/integration/phase4-t2-correction2.test.ts` PROBE (RED at `81e43ed`): a two-slice approved
requisition → two-line PO → commit line A → close the PO short → default A's commitment → cancel line
B; the line reads `ordered` (should be `open`) and `closeRequisition` succeeds (should 409). GREEN
after: line `open`, `closeRequisition` → 409.

## The fix (transactional lifecycle consistency)

| element | change |
|---|---|
| `liveAllocation` | now returns 0 for a PO line carrying a **defaulted** commitment (the source reneged — the line can never be re-committed, so its slice must be re-sourced), even on a still-live version; closed_short → `committedQty`; any other live version → the full ordered qty (an uncommitted issued line is a real open order). |
| `defaultCapacity` | after clearing `committedQty` + recomputing the version, now calls `refreshOrderedFlag` for the affected requisition line — the freed slice reopens to `open` (unless another live PO still covers it). |
| `closeRequisition` | DERIVES `liveAllocation` per non-cancelled line and REFUSES (409) any line not fully covered by live allocation, reconciling `status` as it goes — never trusts the stored column. A line still covered by another live PO keeps it closeable. |

### Required lifecycle tests (`phase4-t2-correction2.test.ts`, 7/7 GREEN)

1. completed one-line PO → default → the requisition line reopens (`open`) and blocks closure;
2. partially committed → close-short → default of the committed line → that line reopens;
3. requisition closure REFUSED while a non-cancelled line lacks live allocation, PERMITTED once every
   line is ordered or cancelled;
4. a re-sourced live PO keeps the line ordered after the first PO's commitment defaults (the freed
   slice is re-ordered and the requisition closes);
5. a per-line default leaves a sibling line covered by its own live commitment `ordered`;
6. a line split across two live POs is fully allocated by their SUM; losing one PO reopens it;
7. the reproduce PROBE above.

## Executable audited operator repair (replaces the non-executable F2/F3/F4 runbook prose)

`src/labour/t2c/` — modelled EXACTLY on the cleared `platform/t45` engine:

- `t2c-diagnostics.ts` — the F5/F3/F2.spec/F2.slice/F2.poline/F4 read-only diagnostics, mirroring
  migration `20270205000000`'s DO blocks and ADDING the two the migration surfaces only OPAQUELY as a
  raw FK failure (F2.poline PO-line↔reqline slice; F4 quote-line resolvability). Schema-aware: a
  fresh/empty or pre-Task-2 database is "not applicable" and passes.
- `t2c-repair.service.ts` — `T2CRepairService.repair(plan)` runs ONE bounded transaction: idempotent
  `T2CRepairAction` before-image evidence; disables ONLY the named frozen/lifecycle trigger(s) the
  plan's ops require (minimal — an F5 fix disables nothing); applies the explicit operator plan
  (own-module labour tables only); re-enables + verifies every labour-commercial immutability trigger;
  re-runs every diagnostic; COMMITS only if clean AND every trigger enabled, else ROLLS BACK
  everything (data, evidence, trigger-toggle). Ops: `f5-set-committed-qty`, `f3-align-commitment`,
  `f2-restore-reqline-identity`, `f2c-align-poline-slice`, `f4-align-poline-terms`. It NEVER fabricates
  provenance — an F2/F4 identity is VALIDATED against the canonical tables before it is applied (a
  forged fingerprint/rate is refused), and the "align" ops copy an EXISTING upstream truth.
- `t2c.cli.ts` + `t2c:preflight`/`t2c:migration-state`/`t2c:repair` package scripts (mirroring the
  T45 CLI: exit 0 clean / 3 preflight-dirty / 1 repair-abort).
- `docs/RUNBOOK.md §P4T2C` REWRITTEN executably: preflight-before-deploy, three-state migration
  classify, the op table, an example plan, the bounded-transaction guarantees, and confirm-clean +
  redeploy — replacing the raw-SQL prose that hit frozen triggers (and the F2 "cancel" that never
  cleared the diagnostic).

## Per-finding abort → repair → redeploy proof (`scripts/phase4-t2-correction2-abort-proof.sh` — PASSED)

Builds a coherent base (every migration except `20270205`, via `prisma migrate deploy`) + a coherent
labour commercial chain, then clones it and runs an INDEPENDENT cycle for EACH of F5, F3, F2, F4:
`t2c:preflight` names the finding (exit 3) → `prisma migrate deploy` ABORTS naming it → `t2c:repair`
applies the operator plan (evidence recorded, minimal trigger disable, re-verify) → `t2c:preflight`
clean → `migrate resolve --rolled-back` + `migrate deploy` installs the F2..F5 seals → the repaired
row is asserted coherent. Plus an F-neg cycle: a plan supplying a FORGED fingerprint is REFUSED and
rolls back (row unchanged, zero evidence rows). (The round-1 `phase4-t2-correction-abort-proof.sh`
still covers the F5 raw-repair path.)

## Deterministic race barriers (replace the probabilistic 10× loops)

`phase4-t2-correction.test.ts` now uses the readiness-lock barrier (hold `lockProjectReadiness`, park
both commands in the advisory-lock wait queue verified via `pg_stat_activity`, release; FIFO grant
order = enqueue order) to prove BOTH lock orderings deterministically:

- **commit vs close-short** — A: commit wins → version COMPLETED, close-short refused (nothing short),
  committed slice retained; B: close-short wins → line released, commit refused. Exactly one wins each.
- **commit vs amend** — A: commit wins → the live commitment BLOCKS the amend; B: amend wins → the old
  version is amended, committing its line is refused. A live commitment is never orphaned.
- **default vs closeRequisition** (new) — A: default wins → line reopens → closeRequisition REFUSES
  (req stays `approved`); B: closeRequisition wins → line still covered → it closes, the default is a
  legitimate post-closure event.

## Gate battery

- `pnpm check` — EXIT 0 (web 432/432, API 642/642 — +1 documented service in the auto-discovery
  tripwire; build clean).
- Full PostgreSQL integration — **64 files / 558 tests** on a clean migrated DB (+7 for
  `phase4-t2-correction2.test.ts`). (An interleaved run over a DB polluted by earlier manual
  smoke-testing of `t2c:preflight` showed 4 leftover-singleton collisions in the unrelated
  outbox/cutover suites; those suites pass in isolation and the suite is 558/558 on a clean DB.)
- `scripts/upgrade-proof.sh` — PASSED (no migration changed; every prior Phase-1..Phase-4-T2 seal
  survives, including the F2..F5 correction constraints).
- `scripts/phase4-t2-correction-abort-proof.sh` — PASSED (round-1 F5 path).
- `scripts/phase4-t2-correction2-abort-proof.sh` — PASSED (F5/F3/F2/F4 independent + fabrication
  refusal).
- `test:e2e:api:allmodules` — 31/31; `:outbox` — 25/25 (6 skipped, the documented outbox-mode set).

## Scope

Service-logic correction (`liveAllocation`/`defaultCapacity`/`closeRequisition`) + an ADDITIVE
operator tool (`src/labour/t2c/`, `T2CRepairAction` created at repair time) + test/doc changes only.
Migrations `20270201000000` and `20270205000000` are byte-for-byte unchanged. Task 3 (§F bound-3 +
allocation/attendance/work facts) remains blocked.
