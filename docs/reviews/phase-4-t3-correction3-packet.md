# Phase 4 Task 3 — correction round 3 review packet

**Directive:** `docs/reviews/phase-4-t3-correction3-directive.md`
**Reviewed merge that produced the directive:** `2a6112b` (PR #226)
**Correction base:** `origin/main` `f6af800c47a5383060bd4bfc1766fdde6f750b42`
**Branch:** `claude/phase4-t3-correction3` — ONE held draft PR for all three findings, because they
share one Task-3 integrity boundary.
**Scope:** the three validated findings ONLY. Every accepted Task-3 behaviour is preserved, PR #226
is NOT rolled back, and no deployed migration is altered.

## Vision alignment

Phase 4 fills the "Team" readiness gate with the same canonical, transactional, lock-protected
discipline Phase 3 gave the "Material" gate. All three findings are about that discipline being real
rather than merely documented:

- **One fact has one canonical owner.** Labour is a LEAF module; it may not read Activities'
  persistence, in Prisma or in raw SQL. Finding 2 removes the last such read and makes the boundary
  analyzer able to see raw-SQL crossings at all.
- **Preserve attributable human approvals.** A muster is a site observation of a named worker,
  recorded by a named person, at a named time. Finding 1 replaces a repair that DELETED that record
  with one that retires it — marked, revoked, and preserved with a complete before-image. An
  observation that turned out to be badly recorded is still an observation.
- **Prove tenant/physical invariants against PostgreSQL.** Finding 3 makes the database itself the
  backstop when the services are bypassed: a raw allocation batch now takes the same per-project
  readiness lock the canonical command takes, so two opposite-order batches serialize instead of one
  being destroyed by a deadlock.

## Findings, fixes and RED→GREEN evidence

### Finding 1 (P1) — the runbook deleted attendance evidence

**Was:** `docs/RUNBOOK.md §P4T3C2` told the operator to revoke a blank-`manualReason` muster, then
`ALTER TABLE "LabourAttendance" DISABLE TRIGGER "LabourAttendance_append_only"` and `DELETE` it —
erasing the original observation, its recorder, its timestamps and its correction chain, while the
disabled trigger's own message says attendance rows are never deleted. There was no preflight, no
evidence table and no executable path: the first thing that noticed a dirty database was
`prisma migrate deploy` failing inside migration `20270220000000`.

**Now:**

| Requirement (directive) | Where |
|---|---|
| no repair path may DELETE a `LabourAttendance` row | `src/labour/t3c/t3c-repair.service.ts` — the only op is `f1-mark-invalid-legacy` (an UPDATE); the append-only trigger's DELETE arm is never disabled for any purpose |
| no repair may invent the missing real-world reason | the reserved marker states only that the original was blank and the real justification *is not knowable*; the op refuses a row that carries a real reason, refuses a missing `revokeReason`, and refuses an unknown `revokedById` rather than fabricating one |
| a dirty pre-`20270220` DB has an executable path | `t3c:preflight` → `t3c:migration-state` → `t3c:repair --plan` → `migrate resolve --rolled-back` → `migrate deploy`, all in RUNBOOK §P4T3C2, all exercised by the production-runner proof |
| the invalid row, its complete before-image, recorder, timestamps, revocation, operator and repair reason remain queryable | `T3CRepairAction` (repairId/operator/reason/at/finding/op/table/rowId/**beforeImage**/detail) + the row itself; RUNBOOK §P4T3C2 step 5 gives the join |
| the repaired row cannot contribute active presence; a replacement is a separate row | the marker and the revocation triple are written in ONE statement; `LabourAttendance_marker_is_revoked` CHECK enforces it; revocation frees the live partial unique so a replacement muster is a separate, separately-attributable row |
| reserved marker, unforgeable | `LabourAttendance_reserved_marker` BEFORE INSERT trigger (a CHECK would also fire on the repair's own UPDATE) |
| named triggers only, re-enabled + verified, re-diagnosed, rolled back on any mismatch | `TRIGGERS_FOR_OP` (only `LabourAttendance_append_only`), `assertTriggersEnabled` over the full §C set, in-transaction `runT3CDiagnostics`, commit-or-roll-back |

**RED at `f6af800`:**
1. `git show f6af800:apps/api/src/labour/t3c/t3c.cli.ts` → does not exist (probes 1a–1e cannot import).
2. `git show f6af800:apps/api/scripts/migrate.sh | grep -c t3c` → `0` (no production preflight; the
   dirty state reached the deployed diagnostic as a FAILED migration record).
3. `git show f6af800:docs/RUNBOOK.md | grep -c 'DELETE FROM "LabourAttendance"'` → `1`.
4. No durable before-image record existed anywhere.

**GREEN:** `phase4-t3-correction3.test.ts` probes 1a–1f, and
`scripts/phase4-t3-correction3-production-runner-proof.sh` cases 1–6.

### Finding 2 (P1) — Labour read an Activities-owned table directly

**Was:** `LabourCapacityService.requirementHead` ran
``tx.$queryRaw`SELECT "id" FROM "ActivityRequirementRoot" … FOR UPDATE` `` itself, immediately before
calling `ActivityParticipant.labourRequirementHead`. A synchronous Labour→Activities persistence read
from a LEAF module, in raw SQL against a table Activities owns and read-encapsulates — and one
indivisible operation split into two halves a caller could get wrong.

**Now:** the lock lives in the participant. `ActivityParticipant.labourRequirementHead` takes the
root `FOR UPDATE` and then reads the head, in the caller's transaction, as ONE operation; Labour's
raw SQL is gone. Ordering invariants are preserved exactly: project readiness first, then the
requirement root, then any capacity commitment, with worker rows in stable ascending order — the
worker and commitment sections are untouched.

The boundary analyzer is EXTENDED so this class of violation is visible at all: raw SQL names TABLES,
not delegates, so `analyzePersistence` now resolves every read-encapsulated model to its physical
table (`prismaModelTables()`, `@@map`-aware) and flags a foreign module's raw statement that
references it as `cross-module-read` — the same finding a delegate read produces.

**RED at `f6af800`:**
- Source tripwire: running `analyzeRuntimeBoundaries` over the base source yields exactly one
  finding — `labour/labour-capacity.service.ts (module 'labour', requirementHead) reads
  read-encapsulated model 'activityRequirementRoot' owned by 'activities'`. After the fix: `[]`.
- Participant probe (`2a`): with the base `activity.participant.ts` restored, a session holding the
  requirement root does NOT block `labourRequirementHead` — the probe fails on
  `expect(resolved).toBe(false)`. After the fix it blocks, then returns Activities' truth.

**GREEN:** `boundary.test.ts` (4 new raw-read fixtures, one coupled to the LIVE manifests) and
`phase4-t3-correction3.test.ts` probes 2a–2b.

### Finding 3 (P2) — raw multi-requirement inserts could deadlock

**Was:** `WorkerAllocation_head_live` locks the requirement root per inserted row, in input-row order.
A canonical allocation is safe because `LabourCapacityService.allocate` takes `lockProjectReadiness`
first, but a raw batch had no such preamble: two same-project batches ordered `(A,B)` and `(B,A)` each
took one root and waited for the other until PostgreSQL aborted one with `40P01`.

**Now:** the raw path gets the same preamble from inside the database. A new BEFORE INSERT trigger
`WorkerAllocation_00_project_lock` acquires `pg_advisory_xact_lock(hashtextextended('readiness:' ||
projectId, 0))` — the identical key `lockProjectReadiness` computes — before any requirement-root or
commitment row lock. The same acquisition also opens `phase4_t3c_allocation_head_live` (belt and
braces), and migration `20270225000000` ASSERTS at deploy time that the project-lock trigger is the
first BEFORE-INSERT trigger by name in this database's own collation. `pg_advisory_xact_lock` is
re-entrant, so a canonical command that already holds it pays nothing and behaves exactly as before.

Stated honestly: this serializes same-**project** writers, which is what the readiness protocol is and
what the finding asks for. A single raw statement spanning two projects in opposite order could still
interleave its two advisory acquisitions; that is equally true of the canonical path (one command is
one project) and no claim is made about it. This is written in the migration comment too.

**RED at `f6af800`:** with `WorkerAllocation_00_project_lock` dropped and
`phase4_t3c_allocation_head_live` restored to its `20270220000000` body, probe `3a` fails with
`Raw query failed. Code: 40P01. Message: ERROR: deadlock detected`. After the fix, session B blocks on
the project lock before it can take any root, both sessions commit, and all four rows land.

**GREEN:** `phase4-t3-correction3.test.ts` probes 3a–3d, plus the upgrade-proof trigger-order assertion.

## Changes

| Area | Files |
|---|---|
| operator repair (F1) | `apps/api/src/labour/t3c/{t3c-diagnostics.ts,t3c-repair.service.ts,t3c.cli.ts}` (new), `apps/api/package.json` (`t3c:preflight` / `t3c:migration-state` / `t3c:repair`) |
| production runner (F1) | `apps/api/scripts/migrate.sh` — the COMPILED `dist/labour/t3c/t3c.cli.js preflight` runs after T45 + T2C and before Prisma, failing closed on a missing artifact |
| runbook (F1) | `docs/RUNBOOK.md` §P4T3C2 rewritten executably (no DELETE anywhere); new §P4T3C3 for the marked-but-not-revoked state |
| participant boundary (F2) | `apps/api/src/activities/activity.participant.ts` (lock + head, indivisible), `apps/api/src/labour/labour-capacity.service.ts` (raw SQL removed) |
| analyzer (F2) | `apps/api/src/platform/module-registry/boundary-analyzer.ts` — `prismaModelTables()`, `tablesOf` option, `recordRawReads` |
| migration (F1 seals + F3) | `apps/api/prisma/migrations/20270225000000_phase4_t3_correction3/migration.sql` (new, additive, diagnostic-first) |
| tests | `apps/api/test/integration/phase4-t3-correction3.test.ts` (new, 12 probes), `boundary.test.ts` (+4 fixtures), `phase4-t3-correction2.test.ts` (2 barrier observations follow the new, earlier serialization point — assertions unchanged), `cross-module-graph.test.ts` (new repair service triaged) |
| proofs | `apps/api/scripts/phase4-t3-correction3-production-runner-proof.sh` (new), `apps/api/scripts/upgrade-proof.sh` (+4 round-3 assertions) |

### Migrations — checksums

Every deployed migration is **byte-for-byte unchanged**: `git diff origin/main -- apps/api/prisma/migrations/`
reports only the new directory.

| migration | sha256 of `migration.sql` | state |
|---|---|---|
| `20270210000000_phase4_t3_time_capacity` | `2d6f022273bfd21830ef94168f6c7c1169d89a2d619940581fb5f2b73b85f1de` | unchanged |
| `20270215000000_phase4_t3_correction` | `77394f1f8faa1253c7158032ccd5079443691ca31add84c492a7f19ae17c13f9` | unchanged |
| `20270220000000_phase4_t3_correction2` | `0e1640310936b42bf2a247c37e9e6646d99e80c730920f5dd8399210613a6a7f` | unchanged |
| `20270225000000_phase4_t3_correction3` | `04a5235f90e11eb1a5d408915aeec4354c6cfce87c8761b3fe3e7e8ec796b401` | **new** |

`20270225000000` is diagnostic-first: it ABORTS with a bounded, named sample over any pre-existing
marked-but-not-revoked muster before it installs anything, and its closing DO block fails the deploy
if the project-lock trigger is not the first BEFORE-INSERT trigger on `WorkerAllocation`. It creates
triggers and one CHECK; it edits no row and can abort over data only in the one diagnosed state.

## Gates

| gate | result |
|---|---|
| `pnpm check` | **EXIT 0** — web 432/432, API 663/663, build clean |
| full live-PostgreSQL integration suite (pristine migrated DB) | **69 files / 602 tests passed** |
| `phase4-t3-correction3.test.ts` | **12/12**, and **10 consecutive runs** 12/12 (concurrency probes 3a–3d included) |
| `boundary.test.ts` / `module-registry.test.ts` / `cross-module-graph.test.ts` | GREEN |
| `scripts/upgrade-proof.sh` | **PASSED** — the 4 round-3 assertions plus every prior Phase-1…Phase-4-T3C2 rejection |
| `scripts/phase4-t3-correction3-production-runner-proof.sh` | **PASSED** — fresh / pre-Task-3 / clean / dirty-F1.blank (named, `20270220` never started, fabrication refused, repair, clean redeploy, row preserved) / already-corrected |
| `pnpm test:e2e:api:allmodules` | **31/31** (one run flaked on the documented timing-sensitive `project-scope` browser-history test — no labour surface; clean re-run 31/31) |
| `pnpm test:e2e:api:outbox` | **25/25** |

### Concurrency runs (directive item 5)

`phase4-t3-correction3.test.ts` was run 10 consecutive times, 12/12 each time. The concurrency probes
are barrier-driven, not sleep-driven: `3a` uses two dedicated `PrismaClient` sessions with
`pg_stat_activity` / gate barriers, and `2a` confirms the blocked backend on `pg_stat_activity` before
releasing the holder.

### Honest notes

- Two probes in `phase4-t3-correction2.test.ts` had to move their **observation point** (not their
  assertions): after finding 3, a second same-project writer blocks on the per-project readiness
  advisory lock and never reaches the `ActivityRequirementRoot … FOR UPDATE` those barriers watched.
  The new `waitUntilBlockedOnProjectLock()` requires an UNGRANTED `advisory` lock, so it is a real
  barrier and not a loosened one. Every assertion in both probes is unchanged and still passes.
- The API unit count moved 655 → 663: +4 boundary raw-read fixtures and +4 from the base's own
  intervening commits; no test was deleted or weakened.
- The `T3CRepairAction` table is created by the repair transaction (idempotently) exactly as
  `T45RepairAction` / `T2CRepairAction` are, because a Prisma migration cannot run while `20270220` is
  unresolved. It is NOT a Prisma model and does not appear in the module manifests.

## Review stop

The PR is held as a **draft**. Per the directive it stays draft through every correction round and is
marked ready only after Codex reviews the current head with no blocking finding. On merge,
`docs/STATUS.md` moves Task 3 to `merged`; only then may the runner start Task 4. **Task 4 remains
blocked.**
