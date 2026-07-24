# Phase 4 Task 1 — correction 3 review packet (BLOCKED NARROWLY → resolved)

**Base:** `origin/main` @ `ecde661` (PR #217 merged — correction 2 delivered; independent re-review returned BLOCKED NARROWLY with ONE remaining P1: the Worker-skill forward trigger and the LabourSkill reverse trigger race — two concurrent transactions (a worker insert and a skill delete/re-key) can each pass its own check and BOTH commit, orphaning the reference. PR #217 is NOT rolled back — this is additive).
**Branch:** `claude/phase4-task1-correction3` (held draft PR).
**Scope:** ONLY the remaining P1, reproduced RED at `ecde661` first. The already-cleared demand-seal and nested-read-analyzer changes are untouched. The earlier migrations (`20270115`, `20270120`) are left byte-for-byte unchanged. **Task 2 does not begin.**

---

## Vision alignment

The re-review's objective: the worker-skill referential invariant must be concurrency-safe, not merely valid at initial insertion. Two separate row-level triggers reading each other's table without a shared lock are a textbook TOCTOU: neither transaction sees the other's uncommitted row, so both pass and both commit. This correction takes the reviewer's **preferred** path — normalize skills into a `WorkerSkill` table with real composite FKs — because **PostgreSQL supplies real FK concurrency semantics**: inserting a `WorkerSkill` takes a KEY-SHARE lock on the referenced `LabourSkill` row, so a concurrent skill delete/re-key blocks then fails (or the insert fails if the delete won). Exactly one side commits; the database is always referentially valid — correct by construction, matching the material spine's FK discipline.

---

## Finding (P1) → resolution → evidence

### The race, reproduced first (RED at `ecde661`)

A deterministic two-session barrier: session A inserts a `Worker` with `skillCodes ['tiling']` (the forward trigger validates against the committed catalog — `tiling` exists), session B deletes the `tiling` `LabourSkill` (the reverse guard sees no *committed* worker referencing it), both reach the barrier, both commit → **1 orphan** (`Worker.skillCodes` references a deleted `LabourSkill`). The invariant "always referentially valid" is broken. (Reproduced live; the throwaway probe is not shipped — the permanent GREEN suite is `phase4-t1-correction3.test.ts`.)

### The fix — normalize into `WorkerSkill` with composite FKs

- **Schema:** a new `WorkerSkill(projectId, workerId, skillCode)` model — PK `(projectId, workerId, skillCode)` (the reviewer's `unique(projectId, workerId, skillCode)`), a composite FK to `Worker(projectId, id)` (ON DELETE CASCADE — skills belong to the worker), and a composite FK to `LabourSkill(projectId, code)` (ON DELETE/UPDATE NO ACTION — a referenced skill cannot be deleted or re-keyed). `Worker.skillCodes` is removed.
- **Service:** `onboardWorker` creates the `Worker` then its `WorkerSkill` rows inside the command transaction — the FK is the concurrency-safe guard (the retained in-service catalog check only supplies a friendlier message). `serializeWorker` / `workforce` DERIVE the DTO's `skillCodes[]` from the `WorkerSkill` rows (sorted). The `WorkerDto`/input contracts are unchanged (still `skillCodes: string[]`).
- **Migration** (`20270125000000_phase4_t1_correction3`, additive + data-preserving + diagnostic-first): ABORTS on any pre-existing orphaned `Worker.skillCodes` element; creates `WorkerSkill`; backfills one row per array element; adds the two composite FKs; **drops the racing `Worker_skills_contained` + `LabourSkill_referenced_guard` triggers** (superseded by the FKs) and the `skillCodes` column.

### Evidence (GREEN)

- `phase4-t1-correction3.test.ts` — **ORDERING 1** (worker first; concurrent skill delete loses), **ORDERING 2** (skill delete first; concurrent worker referencing it loses), **MULTI-SKILL** (a worker referencing several skills races concurrent deletes of each, in a different order — no deadlock). Each ordering runs **10 consecutive times** and asserts the final database is always referentially valid (zero orphans) and exactly one side commits.
- `phase4-t1-correction.test.ts` **F3** and `phase4-t1-correction2.test.ts` **DURABLE SKILL REF** are re-homed onto the `WorkerSkill` composite FK (a nonexistent/cross-project skill, and a delete/re-key of a referenced skill, are rejected by PostgreSQL).
- `upgrade-proof.sh` — the `WorkerSkill` FK rejects a nonexistent/cross-project element and a referenced-skill delete/re-key; the **abort → operator repair → redeploy** cycle for `20270125` runs end-to-end on a fresh scratch DB (simulate the race orphan → migration aborts naming the finding → operator restores the skill → migration redeploys: `WorkerSkill` backfilled, `skillCodes` dropped, racing triggers gone). The correction-2 abort/repair cycle still runs on the pre-`20270125` array schema.

---

## Gate battery (pristine live PostgreSQL 16)

- `pnpm check`: **EXIT 0** — web **432/432**, API unit **637/637**, build OK.
- Focused race suite: `phase4-t1-correction3.test.ts` **3/3** (both orderings + multi-skill, **10× each**, always referentially valid).
- integration (`vitest.integration.config.ts`): **61 files / 531 tests** on a freshly reset+migrated DB (incl. the updated F3/DURABLE-SKILL-REF suites re-homed on the FK; the demand-seal + analyzer suites unchanged).
- `boundary.test.ts` / `cross-module-graph.test.ts`: GREEN — `workerSkill` added to the labour manifest `ownsModels` + the `MODEL_OWNER` map; route count unchanged (WorkerSkill adds no route).
- `upgrade-proof.sh`: **PASSED** — the WorkerSkill FK hostile inserts rejected, and BOTH the correction-2 and the new correction-3 abort→operator-repair→redeploy cycles run end-to-end.
- `test:e2e:api:allmodules`: **31/31**; `:outbox`: **31/31**.

---

## Residual risks / notes

- Dropping `Worker.skillCodes` is a schema change, but data-preserving (backfilled into `WorkerSkill` first) and diagnostic-first (aborts rather than dropping data it cannot migrate FK-cleanly). Operator repair for the abort state is documented in `docs/RUNBOOK.md §P4LC3`.
- The `WorkerDto.skillCodes` / `OnboardWorkerInput.skillCodes` contracts are unchanged — the array is now derived, not stored. No shared-contract change, no web change.
- The already-cleared demand-seal (`LabourDemandSlice_demand_sealed`) and nested-read-analyzer changes are untouched.
