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

## Round 3e — the current-head Codex review of `03d0e0f` (6 findings)

Three are the same class round 3d addressed — **a state that can be diagnosed but not exited** — and
one of those (F6) is a trap the round-3d fix itself introduced. All six are closed here.

| # | sev | finding | fix | RED evidence at `03d0e0f` |
|---|---|---|---|---|
| A | P1 | the diagnostic READS `T3CRepairAction` but locked only `LabourAttendance`, and the evidence seal was a later statement — so a concurrent `DELETE` committing in between left the migration sealing an emptied table and succeeding over a marker whose before-image was gone | both tables are locked `ACCESS EXCLUSIVE`, and the evidence triggers + attribution CHECK are installed inside the SAME statement as the diagnostic that validated them | `R5-A` |
| B | P1 | the before-image shape check accepted `{"id": …, "manualReason": " "}` — it recorded none of the observation it claimed to preserve, so a direct writer could mint one, cite it from a pre-revoked marker, and have preflight AND the migration bless fabricated provenance | every immutable `LabourAttendance` column must be PRESENT (`jsonb_exists`, so an explicit null still counts) and EQUAL to the marked row. Correspondence is checkable precisely because `phase4_t3_attendance_append_only` freezes those columns; `manualReason` stays excluded from equality (rewriting it is the repair) but its shape is still checked per op | `R5-B` (incomplete), `R5-C` (complete but contradicting — and a complete, corresponding image is still accepted, so the rule is precise, not merely strict) |
| C | P2 | on the preserved-revocation path `revokedById` is not written (the `COALESCE` keeps the original) so the FK never validated it — yet it was recorded in append-only evidence under a contract saying it is validated; a nonexistent user sailed through, covered for by the row's own valid key | the plan must NAME the revoker already on the row (a statement the operator can make truthfully after reading it), and the evidence records the REAL preserved attribution — `revokedById`/`revokedAt`/`revokeReason` read back from the before-image, with the operator's own words kept separately as `repairNote` | `R5-D` |
| D | P1 | the migration's create-if-absent guards accepted a matching NAME, so a DISABLED or decoy same-named trigger made it skip creation and record itself applied over an unprotected table; the only postcondition checked trigger name ORDERING | every guard now checks `tgenabled = 'O'` + the bound function (and for the CHECK, `contype`, `convalidated` and the definition), and ABORTS on an invalid same-named object rather than silently replacing it — replacing would erase the evidence that someone put it there. Independent postconditions restate all three seals | `R5-E` |
| E | P1 | the runbook's classify query labelled evidence from metadata alone while the diagnostic validated shape and attribution: a row citing an action with `beforeImage = {}` read as "evidenced", the operator was told to revoke and explicitly not quarantine, and afterwards the finding was still there with the same unusable instruction | the `F1.marker` sample now carries an **`exit`** column derived from the same predicate as the finding, and §P4T3C3 tells the operator to read it. The hand-written SQL is gone — there is one classifier | `R5-B` also asserts the sample's `exit` |
| F | P1 | round 3d's own non-blank attribution CHECK aborted every repair when a legacy blank-attribution action existed. The evidence is append-only so the row cannot be edited away, the quarantine appends good evidence without removing the bad action, and an ORPHAN malformed action blocked every deploy without even producing an `F1.marker` | the rule is installed **NOT VALID** when such rows exist (a `WARNING`, not an abort): every FUTURE insert is rejected, the legacy rows are preserved verbatim, nothing is blocked. On a clean table it is VALIDATED — the stronger claim, still pinned by `R4-C`. Any marker relying on such an action is an `F1.marker` with `exit: quarantine` | `R5-F` |

## Round 3f — the current-head Codex review of `12190c0` (3 findings)

All three are in code rounds 3d/3e introduced, and the first is the "no exit" class one more time —
this time created by round 3e's own correspondence check.

| # | sev | finding | fix | RED evidence at `12190c0` |
|---|---|---|---|---|
| A | P1 | `(beforeImage->>'civilDate')::date` and the `::timestamptz` cast RAISE on a malformed value instead of evaluating false. The preflight would exit with an opaque PostgreSQL conversion error, and the quarantine — which calls the same predicate — would fail identically, so the very row that needs filing could not be filed and the deploy stayed blocked | every comparison is now TOTAL. `civilDate` is compared as text against `to_char(…, 'YYYY-MM-DD')`, exactly how `row_to_json` renders a DATE. `recordedAt` drops to PRESENCE-only: its rendering is session-dependent (DateStyle/TimeZone), so a text comparison would be a false negative across settings and no cast of it can be made total. Identity is still pinned by eight exact string comparisons including `id`, `sourceCommandId` and `recordedById` | `R6-A` |
| B | P1 | `correctionSeals` accepted any validated constraint with the right name, so a same-named `CHECK (TRUE)` reported the database as fully sealed — and on the P3005 baseline path `migrate.sh` would resolve correction 3 as applied without ever executing its real guard | the DEFINITION is checked too (`contype='c'`, `convalidated`, and `pg_get_constraintdef` mentioning both the reserved prefix and `revokedAt`) — the same test the migration's own guard applies | `R6-B` |
| C | P1 | the evidence-seal create-guards accepted any same-named trigger regardless of function, events or enabled state, and `assertTriggersEnabled` checked only name + enabled. An enabled same-named no-op meant a repair committed while the before-image it had just written stayed freely updateable | the guards check the bound function AND the firing events (`tgtype`) and ABORT on a decoy rather than skipping it; `assertTriggersEnabled` additionally verifies the bound function for the two triggers this engine owns (`EXPECTED_TRIGGER_FUNCTION`) | `R6-C` |

## Gates

All figures below are from the post-round-3f tree.

| gate | result |
|---|---|
| `pnpm check` | **EXIT 0** — web 432/432, API 667/667, build clean |
| all 67 migrations over an empty database | **applied cleanly** (the merged finding-A block is valid SQL on a fresh schema) |
| full live-PostgreSQL integration suite (recreated DB) | **69 files / 623 tests passed** |
| `phase4-t3-correction3.test.ts` | **33/33** (12 directive + 6 round-3b + 2 round-3c + 4 round-3d + 6 round-3e + 3 round-3f) |
| `phase4-t3-correction2.test.ts` | **6/6** with the project-scoped advisory barrier |
| `boundary.test.ts` / `module-registry.test.ts` / `cross-module-graph.test.ts` | GREEN (114 tests; +4 indirect-SQL fixtures) |
| `scripts/upgrade-proof.sh` | **PASSED** — the 4 round-3 assertions plus every prior Phase-1…Phase-4-T3C2 rejection |
| `scripts/phase4-t3-correction3-production-runner-proof.sh` | **PASSED** — fresh / pre-Task-3 / clean / dirty-F1.blank (named, `20270220` never started, fabrication refused, repair, clean redeploy, row preserved) / already-corrected / **forged marker refused (Case 8)** / **pre-baseline P3005 seals verified and really executed (Case 7)** |
| `pnpm test:e2e:api:allmodules` | **31/31** (materials-pilot 4/4; one run failed and a clean re-run was 31/31 — the documented timing-sensitive flake, no labour surface) |
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
- **`recordedAt` value equality was REMOVED, not merely relaxed.** Round 3e checked it; round 3f
  checks only that the key is present. That is a real reduction in what the predicate proves, made
  because no total comparison of a session-rendered timestamptz exists. It is stated here rather than
  presented as equivalent.
- **Two probes changed their expected values, deliberately.** `R4-B` now names the row's actual
  revoker (finding C makes a mismatched id a refusal) and asserts the corrected `detail` shape
  (`revokeReason` = the preserved original, `repairNote` = the operator's words). Neither assertion
  was weakened; both describe the new, more truthful contract.
- **What `R5-A`/`R5-E` prove, and what they do not.** They prove the migration's own text: that both
  tables are locked before the diagnostic reads them, that the seals are installed in that same
  statement, that no second statement re-creates them, and that every guard tests enablement and
  function binding. They do not simulate a concurrent writer or a planted decoy against a live
  deploy. `R5-E` additionally asserts the running database is in the enforcing state via
  `correctionSeals()`, and the production-runner proof exercises the real `migrate.sh` over seven
  database states.
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

## Round 3g — the current-head Codex review of `170bcd6` (13 findings)

Eleven findings on the merge head `170bcd6`, most sharing one shape: an object was accepted on the
strength of its NAME (at best plus its bound function) while what it actually DECIDES — which events
it fires on, which rows its expression rejects — went unasked. Each was reproduced RED at `170bcd6`
before the fix; probes `R7-A…R7-M` in `phase4-t3-correction3.test.ts` (12 RED at the base runtime,
`R7-G2` deliberately green there as the unchanged-behaviour complement) plus two RED analyzer
fixtures in `boundary.test.ts`.

| # | finding (P) | fix |
|---|---|---|
| A | `correctionSeals()` never checked `tgtype` — an enabled, correctly-bound trigger declared `BEFORE UPDATE` passed, and on P3005 the baseline recorded correction 3 applied over an unprotected table (P1) | one shared seal specification (`T3C_TGTYPE`, `T3C_CORRECTION3_TRIGGER_SEALS`, `T3C_TRIGGER_SEAL_SQL` in `t3c-diagnostics.ts`): name + enabled + function + required/forbidden event bits, used by the verifier AND mirrored in the migration's guards and POST-CONDITIONS (`R7-A`, `R7-A2`) |
| B | the migration's evidence-trigger guards checked function+enabled but not EVENTS — an UPDATE-only `T3CRepairAction_append_only` passed while DELETE erased before-images; no evidence postcondition existed (P1) | the same event-bit test in every migration guard (append-only ROW+BEFORE+UPDATE+DELETE, no-truncate BEFORE+TRUNCATE and NOT row-level, repair-path ROW+BEFORE+INSERT) + a NEW conditional evidence POST-CONDITIONS block (`R7-F`) |
| C | `t3c seals` returned exit 0 with `ok: true` when the §C schema was ABSENT; `migrate.sh` read that as "seals present", baselined every migration, re-checked, got the same false success and exited 0 — Prisma's ledger claiming a schema the app does not have (P1) | "not applicable" is exit 4 / `prerequisite-schema-absent`, never a success; `migrate.sh` fails closed on it, refusing to baseline (`R7-C` runs the real CLI against a scratch pre-Task-3 database) |
| D | the marker CHECK was accepted by SUBSTRING — `CHECK ("manualReason" LIKE '<prefix>%' OR "revokedAt" IS NULL)` contains both tokens, is validated, and permits every live marked row (P1) | the constraint's own `pg_get_expr` expression is EVALUATED over a four-row truth table (`T3C_MARKER_CHECK_PROBES`; `COALESCE(expr,true)` models CHECK semantics; an erroring decoy is fail-closed "not sealed") in both `correctionSeals()` and the migration guard (`R7-D` plants the reviewer's decoy and `CHECK (TRUE)`) |
| E | `T3CRepairAction` accepted arbitrary inserts — a direct writer could compose a correctly-shaped action naming a chosen repair id plus a pre-revoked marker citing it, and both preflight and migration accepted the pair; shape was all they could ask (P1) | `T3CRepairAction_repair_path_only` (BEFORE INSERT): `NEW."repairId"` must be non-blank AND equal the transaction-local GUC `phase4.t3c_repair_id`, which only `repair()` sets — every ordinary path is refused at insert time. Stated honestly in code and migration: an actor with direct DB access can impersonate the protocol; what the seal buys is that shaping a row is no longer enough, and legacy rows remain quarantinable (`R7-E`) |
| F | the baseline expected-object list stopped after the two primary triggers + marker CHECK — a restored database with a disabled/UPDATE-only evidence trigger answered "sealed" and correction 3 was resolved as applied with before-images freely erasable (P1) | `correctionSeals()` conditionally verifies the evidence seals (all three triggers by full seal + the attribution CHECK by truth table) whenever `T3CRepairAction` exists (`R7-F`) |
| G | quarantining a pre-revoked marker kept `revokedAt` (COALESCE) while overwriting `revokedById`/`revokeReason` — committing "B revoked this at T1 for reason Q", a triple that never happened, over the attribution consumers read (P1) | a pre-revoked row keeps ALL THREE fields verbatim (the plan must name the revoker actually on the row — same rule as the retirement op); the operator's words go to the append-only evidence `detail.quarantineNote`; a live row takes the complete self-consistent triple (`R7-G`, `R7-G2`) |
| H | the attribution constraint was accepted by NAME — a same-named `CHECK (TRUE)` or operator-only CHECK passed the migration guard and the seal report, and whitespace attribution admitted through that hole is permanent on an append-only table (P2) | the same truth-table evaluation (`T3C_ATTRIBUTION_CHECK_PROBES`, full ASCII trim set) in `correctionSeals()` (validated NOT required — the NOT VALID legacy form is the intended state) and in the migration + `EVIDENCE_SEAL_SQL` guards (`R7-H`) |
| I | the repair verified only name+enabled for the `20270210`/`20270215` triggers (function+events only for its own evidence seals) — an enabled same-named no-op `LabourAttendance_append_only` was disabled, restored, and the repair COMMITTED, leaving the repaired row editable while its marker claimed preservation (P1) | `T3C_PREREQUISITE_TRIGGER_SEALS` pins all nine prerequisite triggers' functions + events from the deployed migrations' own definitions; `assertTriggersEnabled` verifies the FULL seal for every trigger before commit (`R7-I`: no-op decoy and UPDATE-only variant both abort with the row untouched; the real seals commit) |
| J | the boundary analyzer's raw-SQL walker followed initializers and `for…of` sources but not IMPORT aliases — moving a detected `SELECT … FROM "Decision"` into a shared constant produced zero findings (P2) | alias symbols are resolved through `checker.getAliasedSymbol` before walking declarations; two new fixtures (named import + renamed import, both RED at `170bcd6`) pin it (`boundary.test.ts`, 41/41) |
| K | on the documented P3005 db-push path the runner resolved `20270210`/`20270215` as applied though their raw-SQL triggers do not exist — correction 3 `CREATE OR REPLACE`s `phase4_t3c_allocation_head_live`'s FUNCTION but never creates the TRIGGER, and the final seals check did not require it, so the runner exited 0 with allocations able to cite a cancelled requirement unchecked (P1) | the prerequisite seals join the baseline answer as their own state: `prerequisitesMissing` in `correctionSeals()`, exit 5 / `prerequisite-seals-missing` from the CLI, and `migrate.sh` REFUSES to baseline (those migrations `CREATE TABLE` and cannot be left pending; recording them applied is a lie a runner may not tell) (`R7-K`) |
| L | the repair accepted any `revokedById` that existed ANYWHERE — the global FK was the only test, so project A's revocation could be permanently attributed to project B's user (P1) | `assertRevokerEntitled`: an ACTIVE membership on the row's project, or owner/admin of its org (exactly `ProjectAccessService.authorize`'s rule, via the non-read-encapsulated `Membership`/`Project`/`OrgMembership` — the same in-tx validation `activities.service.ts` uses for `responsibleId`). Asserted ONLY where the revocation is being WRITTEN: the preserved path merely names the row's existing revoker, so a revoker who has since left the project does not strand the row (`R7-L`; `1c`/`R6`/`R5-D` re-pinned) |
| M | the before-image predicate required `recordedAt` by PRESENCE only and never required `revokedAt`/`revokedById`/`revokeReason` — evidence with a fabricated timestamp and no revocation history authenticated a pre-revoked marker (P1) | `t3cRenderTs` renders `timestamptz` canonically (explicit UTC `to_char`) on BOTH sides so the comparison is pure text — total, session-independent, cannot raise on attacker-supplied strings; `captureBefore` switches to `to_jsonb` + canonical overrides; the predicate requires the full 13-key image, `recordedAt` by VALUE, and a recorded revocation to still be EXACTLY the one on the row (recording none = the row was live; the repair's own revocation is attributed in `detail`) — mirrored verbatim in the migration (`R7-M`, `R5-C` re-homed onto `completeBeforeImage`) |

**Deliberate behaviour changes to earlier probes**, each re-pinned rather than silently adapted:
`1c`/`R6` now expect the standing refusal (which fires before the FK and subsumes "names no User");
`R1`/`R4-D`/`R6-A` quarantine plans name the revoker actually on the row (finding G's coherence
rule); `R1` asserts the whole preserved triple; `R5-C`'s honest evidence is built by the new
server-side `completeBeforeImage` (canonical timestamps + the revocation triple — client
`toISOString()` cannot render PostgreSQL's microseconds); `R7-M`'s two quarantines ride ONE repair
because the engine commits only when its in-transaction re-diagnose reads clean.

Two further current-head findings arrived during the round and are part of it:

| # | finding (P) | fix |
|---|---|---|
| N | `DROP TABLE "T3CRepairAction"` fired NO trigger — not the append-only pair, not the TRUNCATE seal — so one DDL statement erased every before-image while the markers claimed preservation (P1) | the `phase4_t3c_evidence_drop_guard` EVENT trigger (on `sql_drop`) refuses any drop of the evidence table, incl. CASCADE; created by the repair AND re-asserted by the migration (both abort if they cannot — superuser is required and the deploy role is one), verified in `correctionSeals()` and the migration POST-CONDITIONS; removing it is a separate, loud DDL act after which `t3c seals` reports NOT sealed (`R7-N`; the suite's own teardown now performs exactly that deliberate removal) |
| O | the preflight exposed only 20 sample ids per finding while the repair is all-or-nothing — on a database with more rows the supported recovery repaired the visible 20, rolled back over the undisclosed rest, and showed the same 20 forever (P1) | `runT3CPlanRows` (unbounded, ids + exit only) + `T3CRepairService.planSkeleton` + the `t3c plan` CLI subcommand export ONE complete plan skeleton naming every finding row (with the untouchable genuine-live rows in `manual`); the report's samples stay bounded on purpose (`R7-O`: 25 blanks → sample 20, plan 25, one committed repair clears all) |

Honest notes: the repair-path seal (E) is enforcement against every ordinary write path, not against
an actor who owns the database — that actor can read the source and set the GUC, and one who can
disable triggers needs less; rows written before the seal existed stay indistinguishable, which is
what the quarantine exit is for. The R6 boundary position is REVISED, not reopened: `User` is still
never read; standing is validated against `Membership`/`Project`/`OrgMembership`, which are
orgs-owned but not read-encapsulated — the boundary rule the analyzer actually enforces and the
pattern every module already uses for in-tx membership validation.

**Gates (round 3g):** reproduce-first — 12 of the 13 `R7-*` probes and both boundary fixtures RED
at `170bcd6` runtime (`R7-G2` is deliberately green: it pins the unchanged-behaviour complement of
G), all GREEN after; the focused `phase4-t3-correction3.test.ts` **48/48**; `boundary.test.ts`
41/41. `pnpm check` EXIT 0 (web 432/432, API **669/669**, `check:automation` included). Full
integration suite on a pristine migrated DB: **69 files / 638 tests**, EXIT 0. `upgrade-proof.sh`
PASSED (re-run after N/O). `t3c seals` on the migrated DB → `sealed`, exit 0.
`phase4-t3-correction3-production-runner-proof.sh` PASSED — **65 assertions**, including the
rewritten Case 7 (db-push refusal: `prerequisite-seals-missing`, nothing resolved) and the NEW Case
7b (prerequisites present → `20270225` left pending, really executed, verified enforcing, repeat
run a no-op). Two proof-script fixture re-pins were needed for the round's deliberate behaviour
changes — the Case 7b fixture installs `phase3_immutable_row` VERBATIM from the deployed
`20261230000000` migration before replaying (a db-push database has no functions) and asserts ALL
nine prerequisite guards rather than one, and the Case 4/5 fixture grants the plan's revoker an
active membership and expects the standing refusal (finding L) — script-side pins only, zero
runtime change. `test:e2e:api` (allmodules) and `test:e2e:api:outbox`: **25 passed / 6
sender-mode-skipped, EXIT 0 each, clean on the FIRST run** (no documented-flake retries needed).

## Round 3h — the current-head Codex review of `cd7b30c` (7 findings)

Seven findings on the head `cd7b30c` (6 P1, 1 P2), the P1s all one theme sharpened a step further
than round 3g: a seal is accepted only when it **is** the canonical object — approximating it
(a truth table an attacker can satisfy, an event bitmask a stricter trigger can pass, an inventory
that stops at the triggers, a rendering that consults the session) is still accepting something
else. Each was reproduced RED at `cd7b30c` before the fix: seven focused probes (the extended
`R5-E`/`R7-D`/`R7-H`/`R7-I` plus new `R3h-C`/`R3h-D`/`R3h-F`), two `boundary.test.ts` fixtures, and
one `module-registry.test.ts` manifest pin — **10 RED at the base runtime**, all GREEN after.

| # | finding (P) | fix |
|---|---|---|
| A | the round-3g truth-table CHECK verification can be approximated into: `<canonical> OR "manualReason" LIKE '%permit'` passes all four probe rows while admitting rows the canonical CHECK refuses — the table tests points, not the predicate (P1) | CHECKs are verified by **canonical-expression identity**: the canonical text is applied to a session-local `CREATE TEMP TABLE … (LIKE "X") ON COMMIT DROP` probe and `pg_get_expr(conbin)` of probe and actual are compared as text — total, cannot raise on attacker-supplied SQL, and cannot be approximated into. The truth-table machinery is REMOVED; the same probe-identity test runs in `correctionSeals()` and the migration's marker/attribution guards (`R7-D` third decoy block; `R7-H`) |
| B | trigger seals tested required/forbidden event bits, not exact `tgtype` — a same-named trigger with EXTRA event bits on an unconditionally-raising function reads "sealed" while BLOCKING legitimate operations (an UPDATE-firing repair-path seal refuses every legal update) (P1) | every trigger seal pins the EXACT `tgtype` (27 append-only, 34 no-truncate, 7 row-before-insert); `T3C_TRIGGER_SEAL_SQL` compares `t.tgtype = $4`, `assertTriggersEnabled` reports `expected exactly N`, and the migration's five own-trigger guards + POST-CONDITIONS use the same equality (`R5-E`, `R7-I`) |
| C | the prerequisite inventory stopped at the nine triggers — the 12 raw-SQL CHECKs, 6 unique keys (3 partial) and 10 composite FKs from `20270210`/`20270215` went unverified, so a db-push-shaped database missing `LabourAttendance_revoke_attribution_check` (a raw update could set `revokedAt` alone, permanently unattributed) or `WorkerAllocation_live_slice_key` could still baseline; `20270220`'s CHECK was not part of the seals answer at all (P1) | `correctionSeals()` verifies the WHOLE raw-SQL prerequisite inventory — 9 triggers by exact seal, 12 CHECKs by probe identity, 6 uniques by probe-index identity (`indisunique` + ordered columns + `indpred` deparse), 10 FKs by catalog structure (`conkey`/`confkey` attname arrays + `confrelid` + `convalidated`) — and layers `20270220`'s CHECK as its own answer: `correction2Installed` + `pendingMigrations` name exactly the re-runnable corrections to leave pending; `migrate.sh` skips resolve for BOTH when named (leaving only `20270225` pending while `20270220`'s CHECK was missing resolved that migration over a database without its constraint). The migration gains an in-file PREREQUISITES block asserting presence-by-name (`R3h-C`) |
| D | `t3cRenderTs` appended `AT TIME ZONE 'UTC'` to `recordedAt`/`revokedAt` — but those are `TIMESTAMP(3)` WITHOUT time zone, so the cast produces a `timestamptz` that `to_char` renders in the SESSION TimeZone: evidence captured by an Asia/Kolkata session is diagnosed FORGED by a UTC deploy session, for the same stored value (P1) | the render is naive and total: `to_char(expr, 'YYYY-MM-DD"T"HH24:MI:SS.US')` — no `AT TIME ZONE`, no `Z`, consults no session setting; both capture and comparison sides use it (`R3h-D` proves Kolkata === UTC on the same row; `completeBeforeImage` in the suite re-homed onto it) |
| E | the repair engine validated revoker standing by reading `Membership`/`Project`/`OrgMembership` directly — orgs-owned tables read from labour code; the round-3g honest note defended it as "not read-encapsulated", but the OWNER should answer the standing question (P1) | a new orgs-owned participant channel: `OrgsParticipant.hasProjectStanding(tx, projectId, userId)` (active membership OR owner/admin of the project's org — exactly `ProjectAccessService.authorize`'s rule); `assertRevokerEntitled` calls it, `labour.workflowParticipants` gains `'orgs'` (cycle-exempt; labour stays a LEAF, the graph stays acyclic), and `module-registry.test.ts` pins the edge |
| F | the evidence table was erasable by DDL the drop guard never saw: `ALTER TABLE … DROP COLUMN "beforeImage"` reports object_type `table column` (the guard matched `table` only) and erased every before-image in one statement; `RENAME COLUMN` drops nothing at all, so no `sql_drop` trigger can see it (P1) | the drop guard matches `'table','table column'` via `address_names`; a NEW `phase4_t3c_evidence_alter_guard` (on `ddl_command_end`) refuses every other `ALTER TABLE` of the evidence table; the audited sealing paths scope it down (`ALTER EVENT TRIGGER … DISABLE/ENABLE` in the same transaction) around their own canonical `ADD CONSTRAINT` — without that scoping a re-created evidence table could be diagnosed but never sealed; removing either guard is a separate loud DDL act after which `t3c seals` reports NOT sealed (`R3h-F`) |
| G | the boundary analyzer's raw-SQL walker followed variable initializers and aliases but not FUNCTION BODIES — SQL `return`ed by a local or imported function declaration (`function decisionSql() { return 'SELECT … FROM "Decision"' }`) produced zero findings (P2) | the declarations walk adds `decl.body` for `FunctionDeclaration`/`MethodDeclaration` (arrow/function-expression initializers were already covered); two new fixtures — local function declaration and imported function — both RED at `cd7b30c`, pin it |

**Deliberate behaviour changes, each re-pinned rather than silently adapted:** the seal-refusal
messages are now `is not the canonical marker rule` / `is not the canonical attribution rule`
(identity, not truth-table wording) and `expected exactly N` (exact tgtype); `R5-E` pins the
`tgtype <>` guard by a windowed source match; the suite's `completeBeforeImage` builds evidence via
`t3cRenderTs` (finding D's render); every evidence-manipulating fixture now FIRST drops the alter
guard — the loud act — before touching the table, and teardowns drop both event-trigger guards;
tests that plant `LabourAttendance_manual_reason_non_blank` `NOT VALID` (the `legacyBlankMuster`
fixture) must `VALIDATE CONSTRAINT` after the repair before asserting `installed`, because the seals
answer now (correctly) demands what `20270220` really produces — a VALIDATED constraint.

**The production-runner proof's Case 7b is REWRITTEN, not re-pinned.** Its old fixture replayed
`20270210`/`20270215` over a db-push schema — but those migrations' 12 CHECKs are inline in
`CREATE TABLE`, which fails over existing tables, so the replayed fixture physically cannot carry
them, and round 3h's full-inventory seals check (rightly) answers 5 for it. The legitimate shape the
leave-pending path exists for is a really-migrated database restored without its ledger, and the
fixture is now exactly that: a CLONE of the migrated pre-correction base minus `_prisma_migrations`
— nothing hand-installed. The case now asserts the full-inventory premise (inline CHECK, partial
unique, composite FK present), that BOTH re-runnable corrections are left pending
(`skipping resolve --applied` for `20270220` AND `20270225`), that `20270220`'s CHECK lands
VALIDATED and both are recorded applied because they actually ran, and the forged-marker rejection
now cites rows that all exist so the ONLY refusing object is the reserved-marker trigger.

**Honest notes.** (1) Probe-deparse comparison is IDENTITY, not semantic equivalence: a
differently-written but logically equivalent constraint is refused, deliberately — the canonical
objects come from the migrations, and anything else on that name is by definition not them; the
operator recovery is to drop the decoy and redeploy, documented in `docs/RUNBOOK.md §P4T3C3`.
(2) The alter-guard scoping means the audited sealing paths themselves disable the guard for one
statement inside their transaction; that window is exactly as trustworthy as the sealing code, which
is the code being audited here — nothing else may use it silently, and the seals answer verifies the
guard is enabled afterwards. (3) The migration's in-file PREREQUISITES block asserts
presence-by-name only; the full structural semantics (deparse identity, exact tgtype, index/FK
structure) live in `t3c seals`, which `migrate.sh` enforces on every baseline path — stated in the
migration comment rather than duplicating ~400 lines of verifier SQL into it. (4) The round-3g R6
note defended direct `Membership`/`Project`/`OrgMembership` reads as "not read-encapsulated"; that
position is now retired in favour of the owner answering through `OrgsParticipant` — the analyzer
did not force this (the tables are still not read-encapsulated), the review did.

**Gates (round 3h):** reproduce-first — 7 focused probes (`R5-E`, `R7-D` third decoy, `R7-H`,
`R7-I`, `R3h-C`, `R3h-D`, `R3h-F`), 2 `boundary.test.ts` function-body fixtures and 1
`module-registry.test.ts` participant pin RED at the `cd7b30c` runtime, all GREEN after; the focused
`phase4-t3-correction3.test.ts` **51/51**. `pnpm check` EXIT 0 (web 432/432, API **671/671**,
`check:automation` included). Full integration suite on a pristine migrated DB: **69 files / 641
tests**, EXIT 0. `upgrade-proof.sh` PASSED, EXIT 0. `t3c seals` on the migrated DB → `sealed`,
exit 0. `phase4-t3-correction3-production-runner-proof.sh` PASSED — **73 assertions** with the
REWRITTEN Case 7b (restored-dump fixture; both corrections left pending, executed, landing
VALIDATED; the db-push Case 7 refusal unchanged). `test:e2e:api` (allmodules) and
`test:e2e:api:outbox`: **25 passed / 6 sender-mode-skipped, EXIT 0 each, clean on the FIRST run**
(no documented-flake retries needed).

**Review-controller state, stated honestly:** the autonomous controller that requests the exact-head
Codex review allows a maximum of **2 attempts, and both are now consumed** (attempt 2/2 was spent on
the `cd7b30c` push). This push will therefore NOT trigger another automated Codex review by itself.
JagPat has marked PR #230 ready-for-review with auto-merge armed behind the required
`codex-current-head` exact-head gate, which fails closed — so nothing can merge until a HUMAN
re-arms the controller or requests a fresh Codex review of the new head (e.g. an `@codex review`
comment). Surfacing that is part of this round's deliverable; pretending another automated round
will arrive is not.

## Round 3i — the current-head Codex review of `8585d44` (3 findings)

A Codex review DID run on `8585d44` — the round-3h section anticipated the exhausted controller cap
would prevent one; in fact the Codex GitHub app reviews pushes to a ready PR on its own, so the cap
governs only the trusted workflow's promotion loop. Stated for the record rather than silently
revised. Three findings (2 P1, 1 P2), each reproduced RED at `8585d44` before the fix (probes
`R3i-A/B/C` in `phase4-t3-correction3.test.ts` — all three fail against the base runtime, pass
after).

| # | finding (P) | fix |
|---|---|---|
| 1 | trigger seals verified the bound function's NAME, not its BODY — `CREATE OR REPLACE FUNCTION` preserves a function's identity, so an exact-name/exact-tgtype `LabourAttendance_append_only` still bound to the PRE-`20270220` body (which does not freeze `manualReason`) read "sealed", `t3c:seals` answered success, and the P3005 path resolved correction 2 as applied while a live justification stayed rewritable (P1) | every trigger seal carries the canonical `prosrc` BODIES of its function, machine-extracted from the migration files into `t3c-canonical-fn-bodies.generated.ts` (`scripts/generate-t3c-fn-bodies.mjs`; prosrc stores the dollar-quoted text VERBATIM, so byte equality is exact) and verified LAYERED: a prerequisite seal accepts EVERY deployed layer's body (a pre-correction body is the legitimate leave-that-correction-pending state), `correction2Installed` additionally requires the `20270220` bodies (`phase4_t3_attendance_append_only`; `phase4_t3c_allocation_head_live` at ≥ its layer), correction 3 requires the `20270225` head-live body as its own named object, the evidence + event-trigger-guard functions are body-verified too, `assertTriggersEnabled` refuses a non-canonical body before a repair commits, and a body matching NO deployed layer is a prerequisite REFUSAL (exit 5 — a human looks). Re-running the pending correction heals the body: its `CREATE OR REPLACE` is its own repair, which is why pending — not abort — is the right answer for the layer states. `EVIDENCE_SEAL_SQL` now composes its function bodies from the SAME generated texts the migration writes, so `prosrc` is byte-identical whichever writer ran last (`R3i-A`: real 20270210 body → correction 2 pending; decoy body → prerequisite refusal; 20270215 head-live body → BOTH corrections pending, healed by the replay) |
| 2 | for a STILL-LIVE row both repair ops recorded `detail.revokedAt: null` while the same transaction's UPDATE wrote `now()` — the append-only evidence permanently contradicted the attendance row under a contract that says the detail is the triple actually written (P2) | ONE canonically-rendered timestamp (`t3cRenderTs` over `now()::timestamp(3)` — ms-truncated first, exactly what the naive column stores) is captured BEFORE the evidence is written and used VERBATIM in both the evidence detail and the row update (the update parses the same string back, so correspondence is by construction); both the retirement op and the quarantine op's live branch share the captured value (`R3i-B`: evidence `detail->>'revokedAt'` === the row's rendered `revokedAt`) |
| 3 | unique-index seals tested `indisunique` but not `indisvalid`/`indisready` — a failed `CREATE UNIQUE INDEX CONCURRENTLY` leaves a shell with the right name, columns and predicate that enforces NOTHING for existing rows and may already coexist with the duplicates the conservation key forbids; the P3005 path baselined over it and the migration's own prerequisite block deployed over it (P1) | `t3cUniqueIdentitySql` AND the migration `20270225`'s in-file prerequisite index loop require `indisvalid AND indisready` (`R3i-C`: catalog-forced invalid and not-ready states each report the index in `prerequisitesMissing` and abort the migration replay by name) |

**Deliberate re-pin:** `R4`'s exact `present` set gains
`phase4_t3c_allocation_head_live@20270225000000_phase4_t3_correction3` — the correction-3 layer now
names the function body it `CREATE OR REPLACE`s as its own object (its trigger remains a
prerequisite seal). The seals JSON also gains `correction2Missing` (exact absent correction-2
objects) alongside the existing boolean, and the CLI's exit-3 listing prints it.

**Honest notes.** (1) Body verification is the same identity-not-equivalence trade as the CHECK
seals — a reformatted but logically identical function is refused, deliberately; the canonical
bodies come from the migrations, extraction is mechanical (no hand transcription), and fidelity is
proven by the suite (`installed: true` on a fully migrated database fails if any pinned body
differs from what `prisma migrate deploy` produces). (2) The migration's in-file PREREQUISITES
block still asserts presence/binding by name — full body semantics live in `t3c seals`, which gates
every `migrate.sh` path; duplicating ~16 function bodies into the migration would make it
unauditable, and the comment states the split. (3) The quarantine op's live branch is fixed by the
same captured `revocationStamp` variable the probed retirement op uses — one mechanism, one probe;
a live forged-marker fixture would require disabling correction-3's own seals to plant, and the
probe pins the mechanism both branches share. (4) The round-3h claim that no automated review
would run on the new head was WRONG in a useful direction — the Codex app reviews ready-PR pushes
independently of the promotion controller; this section corrects the record.

**Gates (round 3i):** reproduce-first — `R3i-A`, `R3i-B`, `R3i-C` all RED at the `8585d44` runtime,
GREEN after; the focused `phase4-t3-correction3.test.ts` **54/54** (incl. the deliberate `R4`
re-pin). The pinned canonical bodies are validated two ways: mechanically at generation (md5 of
every pinned final-layer body equals the live `prosrc` on a fully migrated database) and
continuously by the suite (`installed: true` fails on any divergence). `pnpm check` EXIT 0 (web
432/432, API **671/671**, `check:automation` included). Full integration suite on a pristine
migrated DB: **69 files / 644 tests**, EXIT 0.
`phase4-t3-correction3-production-runner-proof.sh` PASSED — **73 assertions**, EXIT 0, with the
layered body seals live (the restored-dump Case 7b reports both corrections pending through the
body-aware answer and heals on deploy; the db-push Case 7 refusal unchanged). `upgrade-proof.sh`
PASSED, EXIT 0. `test:e2e:api` (allmodules) and `test:e2e:api:outbox`: **25 passed / 6
sender-mode-skipped, EXIT 0 each, clean on the FIRST run** (no documented-flake retries needed).

## Round 3j — the current-head Codex review of `a113cce` (3 findings)

Three findings (all P1), each reproduced RED at `a113cce` before the fix — the first is a defect in
round 3i's own healing attribution, named as such.

| # | finding (P) | fix |
|---|---|---|
| 1 | round 3i attributed a stale correction-2 function BODY to `20270220000000`'s pending set — but that DEPLOYED migration's `ALTER TABLE … ADD CONSTRAINT` is UNCONDITIONAL, so on a P3005 database where the CHECK already exists the retried `migrate deploy` fails immediately ("already exists") and the baseline path is a trap (P1) | the healing layer is decided by what a re-run actually DOES: `20270225000000` (editable, re-runnable) now re-asserts the canonical `phase4_t3_attendance_append_only` body — spliced byte-for-byte from `20270220000000`'s text, never transcribed — and `correctionSeals()` leaves `20270220000000` pending ONLY when its CHECK is genuinely absent; body-only staleness pends `20270225000000`. Whenever `20270220000000` IS pending, `20270225000000` is pending WITH it (the older replay rewrites the head-live body back a layer; the newer re-run restores it). The re-pinned `R3i-A` asserts the new attribution AND demonstrates the trap directly (a `psql -f` replay of `20270220000000` over its own CHECK exits non-zero with "already exists") AND proves the attributed migration heals (`runMigration()` → `correction2Installed: true`); `R3h-C` re-pinned for the pending-together rule |
| 2 | the repair treated any non-null `revokedAt` as a COMPLETE pre-existing revocation — on a restored database missing `LabourAttendance_revoke_attribution_check`, an incoherent triple (timestamp set, revoker or reason NULL) rode the preserved path and the repair COMMITTED, backfilling the operator's reason onto someone else's timestamp: a triple that never happened, written into a table whose attribution rule was unenforced (P1) | two independent halves: `repair()` verifies the canonical revocation CHECK by probe-deparse IDENTITY (validated) before writing ANY history — an unenforced or decoy rule is a named abort with the whole transaction rolled back — and `applyAction` refuses an incoherent pre-existing triple row-by-row (defense in depth behind the structural check; unreachable while the validated canonical CHECK stands, stated plainly) (`R3j-B`: the exact hostile fixture — CHECK dropped, `revokedAt`+`revokedById` planted, reason NULL — is refused with nothing committed and no reason invented) |
| 3 | `ALTER TABLE "T3CRepairAction" RENAME TO x` bypassed the alter guard: the rename commits its new name BEFORE `ddl_command_end` fires, so `to_regclass` of the OLD name is already NULL and the `objid` comparison never matches — every marker orphaned from the register its diagnostics and runbook query, while a later repair would mint a fresh empty table under the original name (P1) | the guard identifies the register TWO ways: by current name (covers every in-place ALTER and any window before the marker exists) OR by the `T3CRepairAction_attribution_non_blank` CHECK riding the command's own `objid` — a constraint survives a rename, and removing the marker is itself `ALTER TABLE`, refused while the guard stands (self-protecting; the remaining bypass is the documented loud `DROP EVENT TRIGGER`). The canonical body is edited in the (undeployed) migration and flows to every writer/verifier through the generated module (`R3j-C`: the rename is refused, evidence intact, seals still installed; the probe's own RED-run hygiene had to drop the guard first to rename BACK — the guard refuses that direction too, which is itself confirmation) |

**Deliberate re-pins:** `R3i-A` (pending attribution + the two healing demonstrations) and `R3h-C`
(20270220-pending now always brings 20270225 with it). `t3c_smuggled` note for reproducers: running
`R3j-C` against the `a113cce` runtime leaves the register renamed (the OLD guard also blocked the
rename-back), so the RED demonstration is followed by a one-line `DROP TABLE "t3c_smuggled"`
cleanup before re-running the suite on the fixed runtime.

**Honest notes.** (1) Finding 1 is a correction OF round 3i's fix — the "re-running the pending
migration heals the body" claim was true only when the CHECK was also absent; the round-3i packet
text stands as the historical record of what `a113cce` did, and this section is the correction.
(2) The rename guard's marker is the attribution CHECK, not a name — a database where that CHECK
never existed (evidence table created but never sealed) falls back to the name arm, which covers
every non-rename ALTER; a rename in that unsealed window remains possible and is exactly the state
`t3c seals` already reports as NOT sealed. (3) The 20270225 re-assertion of a 20270220 body is the
one place a later migration writes an earlier layer's text — spliced mechanically from the deployed
file so the bytes cannot drift, and the generated-module fidelity checks (md5 vs live `prosrc`, the
suite's `installed: true`) hold it there.

**Gates (round 3j):** reproduce-first — `R3j-B` and `R3j-C` RED at the `a113cce` runtime, GREEN
after; the deliberately re-pinned `R3i-A` (healing attribution: 20270220-pending now implies
20270225-pending, and the 20270220 replay trap is demonstrated by `psql -f` failing "already
exists" over an existing CHECK) and `R3h-C`/`R4` re-pins hold. The focused
`phase4-t3-correction3.test.ts` **56/56**. `pnpm check` EXIT 0 (web 432/432, API **671/671**,
`check:automation` included). Full integration suite on a pristine migrated DB: **69 files / 646
tests**, EXIT 0. `upgrade-proof.sh` PASSED, EXIT 0 (every prior forgery rejection surviving under
the re-asserted attendance body and the rename-proof alter guard).
`phase4-t3-correction3-production-runner-proof.sh` PASSED — **73 assertions**, EXIT 0.
`test:e2e:api:allmodules` **31/31** (one first-run failure in the legacy
`cross-cutting-surfaces` spec — the poll proving all five module reads own their surfaces passed
but the intercepted decisions JSON payload read `null`, a response-capture race on a surface this
round does not touch; clean re-run 31/31) and `test:e2e:api:outbox` **25 passed / 6
sender-mode-skipped**, EXIT 0, clean on the first run.

The PR is held per the directive: pushed normally, threads left for Codex, no self-promotion of
draft state, no self-merge. On merge, `docs/STATUS.md` moves Task 3 to `merged`; only then may the
runner start Task 4. **Task 4 remains blocked.**
