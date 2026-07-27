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
| `20270225000000_phase4_t3_correction3` | `999fc820b9c5476022316709ecc0ed1abd6df4e0ab5d65640c02d8a83269b7b1` | **new** (amended in round 3b — see below; not deployed, so its bytes are not yet frozen) |

`20270225000000` is diagnostic-first: it ABORTS with a bounded, named sample over any pre-existing
marked-but-not-revoked muster before it installs anything, and its closing DO block fails the deploy
if the project-lock trigger is not the first BEFORE-INSERT trigger on `WorkerAllocation`. It creates
triggers and one CHECK; it edits no row and can abort over data only in the one diagnosed state.

## Round 3b — the current-head Codex review of `0832c7d` (10 findings)

Codex reviewed head `0832c7d` and raised ten findings. All ten are fixed here, on the same held draft
PR; nothing from the three directive findings is rolled back.

| # | sev | finding | fix | RED evidence at `0832c7d` |
|---|---|---|---|---|
| 1 | P1 | the migration could not be retried after a partial apply | `DROP TRIGGER IF EXISTS` / `DROP CONSTRAINT IF EXISTS` before each created object; the two functions were already `CREATE OR REPLACE` | re-running the migration over a partly-applied schema failed with "trigger already exists" |
| 2 | P1 | §P4T3C3 never told the operator to resolve a `failed-pending` `20270225` | §P4T3C3 gains the `migrate resolve --rolled-back 20270225000000_phase4_t3_correction3` step + a verify block, exactly as §P4T3C2 has | the section had no resolve step; a post-abort redeploy would refuse |
| 3 | P2 | the raw-read analyzer saw only inline literals, so `const sql = '…'; $queryRawUnsafe(sql)` escaped | `collectSqlText` resolves identifiers/property accesses to their declarations (and a `for…of` binding to the iterated expression), with a `seen` set for cycles | `boundary.test.ts` const / alias / const-array fixtures → 3 failures at `0832c7d`, GREEN after; the own-module negative passes in both |
| 4 | P1 | the P3005 baseline path marked `20270225` applied without executing it | new `t3c seals` command + `migrate.sh` leaves that ONE migration pending when the seals are absent, then re-checks and fails closed | production-runner Case 7: a `db push` database has the tables and none of the seals |
| 5 | P1 | `docs/STATUS.md` said `in_progress` while the PR was open and awaiting review | `task_state: in_review` in the YAML **and** the Task-3 table row | — (state, not behaviour) |
| 6 | P1 | the repair engine read the Orgs-owned `User` table directly from a leaf | the read is deleted; `LabourAttendance_revokedBy_fkey`'s `23503` violation is translated into the same named `RepairAbortedError` | `R6` probe asserts no `FROM "User"` remains and the refusal message is unchanged |
| 7 | P1 | a forged marker with the revocation triple pre-filled passed as an audited repair | the marker embeds `repair=<uuid>`; diagnostic **and** migration demand a matching `T3CRepairAction` before-image for that row AND that repair id (no evidence table ⇒ every marker is a finding) | `R7` probes: a revoked forgery, and one citing a real repair id for another row, both pass at `0832c7d` and are findings after |
| 8 | P1 | `T3CRepairAction` was an ordinary mutable table | `T3CRepairAction_append_only` created in the same transaction that creates the table, re-asserted by the migration, and added to the verified `IMMUTABILITY_TRIGGERS` set (never disableable) | `R8` probe: `UPDATE`/`DELETE` on the evidence succeeded at `0832c7d` |
| 9 | P2 | an operator plan could record a false finding classification permanently | `FINDING_OF_OP` decides what the evidence records; a stated `finding` that disagrees is refused *before* any trigger is disabled | `R-plan` probe: `finding: 'F1.marker'` ran the blank repair and wrote that classification |
| 10 | P2 | the advisory-lock barrier counted ANY ungranted advisory lock globally | `waitUntilBlockedOnProjectLock(projectId)` reconstructs `hashtextextended('readiness:' || projectId, 0)` from `pg_locks.classid/objid`, excludes itself and requires `state='active'` | an unrelated waiter elsewhere could open the gate before the racing session arrived |

One further inaccuracy was found while fixing #2 and corrected here: §P4T3C2 cited
`scripts/phase4-t3-correction3-abort-proof.sh`, **which does not exist**. The section now cites the
real script (`phase4-t3-correction3-production-runner-proof.sh`), which performs that exact sequence.

## Round 3c — the current-head Codex review of `6d17949` (6 findings)

Four were closed in `b053d1d`; the last two are closed in `5ff226c`.

| # | sev | finding | fix |
|---|---|---|---|
| 1 | P1 | §P4T3C3 told the operator to revoke a forged marker — but a forged marker is written pre-revoked, so the instruction was unperformable and `F1.marker` could never clear | a new `f1-quarantine-forged-marker` op (files the forgery verbatim as its own before-image, rewrites the marker to embed a repair id that genuinely exists) **plus** the operator-facing §P4T3C3 rewrite: a classify query, the evidenced-but-live case routed to the application revoke, and the quarantine flow documented end to end |
| 2 | P1 | the migration dropped-and-recreated objects, opening a window on retry | create-if-absent DO blocks for all three created objects |
| 3 | P1 | the evidence seals were not re-asserted when `T3CRepairAction` exists | conditional re-assert block in the migration |
| 4 | P1 | the marker predicate accepted evidence of the wrong SHAPE | the before-image must be the row itself and match the op's expected shape |
| 5 | P1 | `correctionSeals` accepted a disabled trigger or an unvalidated CHECK | `tgenabled='O'` + bound function + `convalidated` |
| 6 | P2 | probe 3a's barrier matched insert TEXT globally, so a sibling suite's insert on another project could open it | the barrier names the two backends and asks `pg_blocking_pids`; probe 2a's two equivalent weaknesses (a global `pg_locks` scan and a query-text match) are fixed the same way — the lock-held signal now comes from inside the holding transaction |

## Round 3d — the current-head Codex review of `02bbeff` (4 findings)

Every one is a state the correction could DIAGNOSE but not EXIT — a deploy blocked with no repair
path — or the gap that made such a state reachable. All four are closed here.

| # | sev | finding | fix | RED evidence at `02bbeff` |
|---|---|---|---|---|
| A | P1 | the diagnostic committed, then the seals were installed in later statements. This migration has no transaction wrapper, so that gap is real: a concurrent writer could insert a pre-revoked marked row into it, the later CHECK accepts it, nothing re-diagnoses, and the migration succeeds over forged provenance | the diagnostic and BOTH `LabourAttendance` seals are now ONE `DO` block — one statement, one transaction — opening with `LOCK TABLE … IN ACCESS EXCLUSIVE MODE`, so the table is read and sealed without any writer in between | `R4-A` — the three were separate top-level statements |
| B | P1 | a legacy muster whose blank reason was revoked **before** correction 2 shipped is still counted by `F1.blank`, but `f1-mark-invalid-legacy` refused it as terminal and the quarantine op only accepts marked rows. Neither op could clear the finding: the deploy was blocked permanently short of an undocumented trigger bypass | the op accepts an already-revoked blank row and PRESERVES its revocation verbatim (`COALESCE` on all three columns) — that revocation is real history, made by a named person at a known time. Only a still-live row takes the operator's attribution; the operator's words are recorded in the evidence either way, and `detail.revocationPreserved` says which shape the repair took. The marker predicate's blank shape no longer requires an unrevoked before-image | `R4-B` — `RepairAbortedError: … already revoked — a revoked muster is terminal` |
| C | P2 | `T3CRepairAction.operator`/`reason` were `NOT NULL` and nothing more, and `NOT NULL` is satisfied by a space. A raw insert could store attribution naming nobody, and the append-only seal makes it permanent | a `T3CRepairAction_attribution_non_blank` CHECK using the repository's complete ASCII-whitespace trim set, added diagnostic-first (a pre-existing blank row is named, not surfaced as an opaque violation) and re-asserted by the migration. The evidence predicate also requires non-blank attribution, so a marker backed by such a row is reported as `F1.marker` and can be quarantined | `R4-C` — three whitespace variants all inserted successfully |
| D | P1 | the quarantine's refusal was a metadata-only `count(*)` on `(rowId, repairId)` while the diagnostic validated the before-image SHAPE. A malformed evidence row was therefore reported by the preflight and declined by the repair — and with the evidence append-only and the row already revoked, nothing could clear it | one exported predicate, `t3cGenuineEvidenceSql`, used by both. Report and repair now ask the identical question by construction | `R4-D` — `already has repair evidence … not a forgery` while the preflight listed the same row |

## Gates

All figures below are from the post-round-3d tree.

| gate | result |
|---|---|
| `pnpm check` | **EXIT 0** — web 432/432, API 667/667, build clean |
| all 67 migrations over an empty database | **applied cleanly** (the merged finding-A block is valid SQL on a fresh schema) |
| full live-PostgreSQL integration suite | **69 files / 614 tests passed** |
| `phase4-t3-correction3.test.ts` | **24/24** (12 directive + 6 round-3b + 2 round-3c quarantine + 4 round-3d) |
| `phase4-t3-correction2.test.ts` | **6/6** with the project-scoped advisory barrier |
| `boundary.test.ts` / `module-registry.test.ts` / `cross-module-graph.test.ts` | GREEN (114 tests; +4 indirect-SQL fixtures) |
| `scripts/upgrade-proof.sh` | **PASSED** — the 4 round-3 assertions plus every prior Phase-1…Phase-4-T3C2 rejection |
| `scripts/phase4-t3-correction3-production-runner-proof.sh` | **PASSED** — fresh / pre-Task-3 / clean / dirty-F1.blank (named, `20270220` never started, fabrication refused, repair, clean redeploy, row preserved) / already-corrected / **forged marker refused (Case 8)** / **pre-baseline P3005 seals verified and really executed (Case 7)** |
| `pnpm test:e2e:api:allmodules` | **31/31** |
| `pnpm test:e2e:api:outbox` | **25/25** (6 skipped by mode) |

### Concurrency runs (directive item 5)

`phase4-t3-correction3.test.ts` was run 10 consecutive times, green each time. The concurrency probes
are barrier-driven, not sleep-driven, and as of round 3c the barriers are scoped to the two backends
under test: `3a` and `2a` each capture both sessions' `pg_backend_pid()` and wait on
`pg_blocking_pids`, so no other suite's contention on the shared database can open them. `2a` also
signals "the lock is held" directly from inside the holding transaction rather than inferring it from
a table-wide `pg_locks` scan.

### Honest notes

- Two probes in `phase4-t3-correction2.test.ts` had to move their **observation point** (not their
  assertions): after finding 3, a second same-project writer blocks on the per-project readiness
  advisory lock and never reaches the `ActivityRequirementRoot … FOR UPDATE` those barriers watched.
  The new `waitUntilBlockedOnProjectLock()` requires an UNGRANTED `advisory` lock, so it is a real
  barrier and not a loosened one. Every assertion in both probes is unchanged and still passes.
- **What `R4-A` proves, and what it does not.** It proves the diagnostic, the lock and both seals are
  one statement in the migration file, and that no second statement re-creates either seal. It does
  not simulate a concurrent writer arriving mid-migration; the argument that no such window remains is
  structural (one statement is one transaction, opened by an `ACCESS EXCLUSIVE` lock) rather than
  observed. The migration applying cleanly over all 67 migrations on an empty database is separate
  evidence that the merged block is valid SQL.
- The API unit count moved 655 → 667: +4 boundary raw-read fixtures and +4 from the base's own
  intervening commits; no test was deleted or weakened.
- The `T3CRepairAction` table is created by the repair transaction (idempotently) exactly as
  `T45RepairAction` / `T2CRepairAction` are, because a Prisma migration cannot run while `20270220` is
  unresolved. It is NOT a Prisma model and does not appear in the module manifests.

## Review stop

The PR is held as a **draft**. Per the directive it stays draft through every correction round and is
marked ready only after Codex reviews the current head with no blocking finding. On merge,
`docs/STATUS.md` moves Task 3 to `merged`; only then may the runner start Task 4. **Task 4 remains
blocked.**
