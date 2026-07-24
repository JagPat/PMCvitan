# Phase 4 Task 1 — correction 4 review packet (narrow test-and-manifest correction)

**Base:** `origin/main` @ `25a5ad5` (PR #218 merged — correction 3 delivered: worker-skill integrity normalized into `WorkerSkill` with composite FKs; PostgreSQL FK concurrency serializes the worker-insert vs skill-delete race). The final mechanical re-review of PR #218 ACCEPTED the four correction-3 fixes but raised **five narrow follow-ups**, all in the boundary/manifest wiring and the concurrency-test *evidence* — not the runtime, not the schema, not the migration.
**Branch:** `claude/phase4-task1-correction4` (held draft PR).
**Scope:** ONLY the five follow-ups. **No migration. No runtime/domain behaviour change.** PR #218 is NOT rolled back — this is additive. The `WorkerSkill` migration (`20270125000000`), the Prisma schema, the FKs, `LabourService`, the demand seal, and every previously cleared correction are UNTOUCHED. **Task 2 does not begin.**

---

## Vision alignment

The re-review's objective: the boundary analyzer must actually *flag* a foreign read of the normalized `WorkerSkill` table (correction 3 added the model to `ownsModels` but forgot `readEncapsulated`, so a cross-module read of it would have been invisible), the manifest contract must be pinned so this cannot silently regress, and the concurrency evidence must demonstrate a *genuine* two-session overlap rather than a sequential referential-integrity check dressed up as a race. This correction makes the read-encapsulation real and coupled to a test, and rewrites the two ordering probes as true overlaps that hold one session's transaction open and confirm the other session is *blocked on the FK lock* before releasing — so the evidence claims only what it proves.

---

## Findings → resolution → evidence

### F1 (P2) — `workerSkill` was owned but not read-encapsulated

`labour.manifest.ts` listed `workerSkill` in `ownsModels` but omitted it from `readEncapsulated`. The boundary analyzer only flags a foreign READ of a model that is read-encapsulated (`readEncapsulation(manifests)`), so a foreign module reading `prisma.workerSkill.*` produced **no** `cross-module-read` finding.

- **Fix:** added `'workerSkill'` to `labourManifest.readEncapsulated` (its `ownsModels` already contained it; `readEncapsulated ⊆ ownsModels` still holds, and Labour stays a LEAF so the module graph is still acyclic).

### F2 (P2) — the Labour manifest contract was unpinned

- **Fix:** `module-registry.test.ts` gains a test that pins the Labour manifest: `moduleModelOwnership().get('workerSkill') === 'labour'`, and the **complete** expected `readEncapsulated` set (`crew, crewMembership, labourDemandSlice, labourRequirementSpec, labourSkill, labourTrade, worker, workerSkill`). A model added to `ownsModels` but forgotten in `readEncapsulated` (the exact F1 regression) now fails here.

### F3 (P2) — no adversarial analyzer fixture for `workerSkill`

- **Fix:** `boundary.test.ts` gains an adversarial fixture: a foreign module (`activities/…`) calls `prisma.workerSkill.findMany(...)`. Analyzed against the **live** `readEncapsulation(MODULE_MANIFESTS)` (a new optional third parameter of `analyzeFixture`, defaulting to the existing synthetic map), it must produce **exactly one** `cross-module-read` finding whose `model` is `workerSkill` and whose message attributes owner `labour`. Because the fixture is coupled to the live manifest, **removing `workerSkill` from `readEncapsulated` makes this test fail** (proven: temporarily dropping it turns the fixture RED — the sanity assertion `readEncapsulation(MODULE_MANIFESTS).get('workerSkill') === 'labour'` fails and the finding count drops to 0). The stub `PrismaLike` gains a `workerSkill` delegate; the analyzer code is UNCHANGED.

### F4 (P1, test-evidence) — the concurrency probes were sequential, not overlapping

The correction-3 `phase4-t1-correction3.test.ts` ordering probes committed session A's transaction *before* session B began — a sequential referential-integrity check, not a race. The re-review asked for a **real two-session overlap** with condition/barrier-based synchronization (no fixed sleeps).

- **Fix — the two ORDERING probes are now genuine overlaps:**
  - A dedicated `PrismaClient` (`raceDb`) hosts the two independent sessions.
  - **ORDERING 1 (insert holds, delete waits):** session A opens an interactive transaction, `INSERT`s a `WorkerSkill` referencing the skill (taking a `FOR KEY SHARE` lock on the `LabourSkill` row) and **holds the transaction open** (uncommitted). Session B then `DELETE`s that skill and **blocks on the FK lock**. The test **confirms B is waiting** by polling `pg_stat_activity` (`wait_event_type='Lock' AND state='active'` matching the DELETE) on the separate `t.prisma` observer client — condition-based, NOT a fixed sleep. Only then is A committed; B unblocks and is **rejected** (FK `NO ACTION`); orphan count is `0`.
  - **ORDERING 2 (delete holds, insert waits):** the symmetric overlap — A holds a `DELETE FROM "LabourSkill"` open, B's `INSERT INTO "WorkerSkill"` referencing it blocks (confirmed via `pg_stat_activity`), A commits, B is rejected, orphan count `0`.
  - Both orderings run **10×** internally, and the whole file passes **10 consecutive runs**.
  - Implementation note: Prisma raw-query promises are LAZY (not dispatched until a continuation is attached), so session B is dispatched via a `reflect` helper that both starts the statement and captures its settled outcome for the post-commit assertion.
- **MULTI-SKILL is now labelled HONESTLY** as a **sequential referential-integrity + no-deadlock** test (per the re-review's explicit option): a worker referencing several skills is onboarded and **committed first**, then concurrent reverse-order `DELETE`s of each referenced skill are **all rejected** by the composite FK — proving FK protection across many references and that reverse-order concurrent deletes cannot deadlock or orphan. It no longer claims to be a concurrent overlap.

### F5 (P3) — the review packet over-claimed the concurrency

- **Fix:** this packet, and a correction to the correction-3 packet's evidence section, state only the concurrency actually tested (two genuine two-session overlaps + one sequential referential-integrity/no-deadlock check).

---

## Gate battery (pristine live PostgreSQL 16)

- `module-registry.test.ts` + `boundary.test.ts`: **GREEN** (37/37) — the F2 manifest-contract pin and the F3 adversarial `workerSkill` fixture pass; removing `workerSkill` from `readEncapsulated` turns the F3 fixture RED (coupling proven).
- `phase4-t1-correction3.test.ts`: **3/3**, and **10/10 consecutive runs** green — the two genuine two-session overlaps (block confirmed via `pg_stat_activity`) + the sequential multi-skill referential-integrity/no-deadlock check.
- `pnpm check`: **EXIT 0**.
- **No migration** (upgrade-proof not applicable); **no runtime/domain behaviour change** (manifest read-encapsulation metadata + tests only).

---

## Residual risks / notes

- The only production-artifact change is one string added to `labourManifest.readEncapsulated`; everything else is tests. The analyzer, schema, FKs, migration, `LabourService`, and demand seal are byte-for-byte unchanged.
- The genuine-overlap probes depend on PostgreSQL row-lock semantics (`FOR KEY SHARE` on an FK-referenced row conflicts with a concurrent delete/insert of that row), verified live; the observation is condition-based (`pg_stat_activity`), not timing-based.
