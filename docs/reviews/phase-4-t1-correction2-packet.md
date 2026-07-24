# Phase 4 Task 1 — correction 2 review packet (BLOCKED NARROWLY → resolved)

**Base:** `origin/main` @ `b627359` (PR #216 merged — Task-1 correction delivered; independent re-review returned BLOCKED NARROWLY: findings F1/F4/F5/F6 CLOSED, but the F2 demand seal and F3 skill references were valid only at INITIAL insertion, plus the nested-read analyzer fixture was unpinned. PR #216 is NOT rolled back — this is additive).
**Branch:** `claude/phase4-task1-correction2` (held draft PR).
**Scope:** ONLY the three re-review findings, each reproduced RED at `b627359` before fixing. The deployed migration `20270115000000` is left byte-for-byte unchanged. **Task 2 does not begin.**

---

## Vision alignment

The re-review's objective: make the labour-demand and worker-skill invariants durable under EVERY later database mutation, not merely valid at their initial insertion. This correction closes both gaps at PostgreSQL — a slice appended in a later transaction is re-validated against the whole frozen aggregate, and a `LabourSkill` a worker still references can no longer disappear — and permanently pins the nested-read analyzer detection the previous packet claimed. The physical-truth invariants are now enforced by the database at all times, matching the material spine's discipline.

---

## Findings → resolution → evidence

### Finding 1 (P1) — the demand seal is now DURABLE

The `20270115` seal fired only on `LabourRequirementSpec` INSERT, so a `LabourDemandSlice` appended in a later transaction was never re-validated and the sealed aggregate silently drifted (requiredQty ≠ SUM, requiredBy ≠ MAX).

**Fix:** the validator is refactored into a **key-based** `phase4_labour_demand_check(project, requirement, revision)` that reads the neutral `ActivityRequirement`, its one `LabourRequirementSpec`, and EVERY `LabourDemandSlice`, and re-derives the whole aggregate (≥1 slice, `baseUom='person-shift'`, `requiredQty = SUM(personShiftQty)`, `requiredBy = MAX(civilDate)`, canonical SHA-256 fingerprint). It is fired at **DEFERRED COMMIT** from BOTH the existing spec-insert constraint trigger AND a **new `LabourDemandSlice_demand_sealed` DEFERRABLE INITIALLY DEFERRED constraint trigger on slice INSERT**. Because `requiredQty`/`requiredBy` are frozen on the immutable revision row, any slice appended later breaks SUM/MAX and the commit fails. (Slices are already append-only — INSERT is the only mutation that can change the aggregate.)

**Evidence (RED at `b627359` → GREEN):** `phase4-t1-correction2.test.ts` **DURABLE DEMAND** — a valid 7-person-shift requirement commits, then appending a 1-unit slice on a new date FAILS at commit and the original two-slice/sum-7 aggregate is unchanged. `upgrade-proof.sh` — the same later-append is rejected over the migrated legacy DB, the sealed revision unchanged.

### Finding 2 (P2) — worker-skill referential integrity is now BIDIRECTIONAL

The `Worker.skillCodes[]` containment fired only on worker INSERT/UPDATE, so a `LabourSkill` could be DELETEd (or re-keyed) out from under a worker still referencing it — an orphaned reference, not the FK-backed relation the packet claimed.

**Fix:** a **`LabourSkill_referenced_guard` BEFORE DELETE OR UPDATE trigger** rejects deleting, or changing the `(projectId, code)` of, a `LabourSkill` while any same-project `Worker.skillCodes` element still references it. (An UPDATE that leaves `(projectId, code)` unchanged is allowed — it dangles nothing.) The forward containment trigger + this reverse guard together make a nonexistent, cross-project, OR subsequently-deleted skill unrepresentable. `LabourRequirementSpec.skillCode` was already protected by its composite FK.

**Evidence (RED at `b627359` → GREEN):** `phase4-t1-correction2.test.ts` **DURABLE SKILL REF** — deleting OR re-keying a worker-referenced `LabourSkill` FAILS, both rows unchanged; a non-referenced skill still deletes (the guard is precise). `upgrade-proof.sh` — the delete/re-key of a worker-referenced skill is rejected; a non-referenced skill still deletes.

### Finding 3 (P3) — the nested-read analyzer detection is permanently pinned

The analyzer already detects nested `include`/`select` foreign reads (added in PR #216, which caught the latent `activities.service.ts → activity.decision.status` include), but the adversarial suite pinned only the direct foreign-delegate read.

**Fix:** `boundary.test.ts` gains three fixtures — a nested `include: { decision: true }` and a nested `select: { decision: {…} }` from an activities file each produce ONE `cross-module-read` on the read-encapsulated `decision`, and a decisions file pulling its OWN `decision` through a nested include produces NONE. The fixture relation map gains the real `activity → decision` relation these exercise. (Analyzer code unchanged — this is a permanent regression pin, GREEN at `b627359`.)

---

## Migration — `20270120000000_phase4_t1_correction2` (additive, diagnostic-first)

`CREATE EXTENSION IF NOT EXISTS pgcrypto`; a `DO` block ABORTS with a per-finding count on any pre-existing inconsistent labour-demand aggregate OR orphaned `Worker.skillCodes` element (never edits/fabricates a labour row); the refactored key-based `phase4_labour_demand_check` + its two wrapper functions; the new slice-insert deferred constraint trigger; the `LabourSkill` reverse guard. Migration `20270115…` is unchanged. Legacy databases upgrade **row-free** (the labour pilot has no rows). Operator repair for the abort states is documented in `docs/RUNBOOK.md §P4LC2`.

---

## Gate battery (pristine live PostgreSQL 16)

- `pnpm check`: **EXIT 0** — web **432/432**, API unit **637/637** (+3 nested-read fixtures), build OK.
- integration (`vitest.integration.config.ts`): **60 files / 528 tests** on a freshly reset+migrated DB (incl. `phase4-t1-correction2.test.ts` 2/2; the prior `phase4-t1-correction.test.ts` 6/6 and `phase4-t1-labour.test.ts` 10/10 unchanged — the refactored validator preserves every message).
- `boundary.test.ts` (finding 3): **28/28** — the three nested-read fixtures pin the detection.
- `upgrade-proof.sh`: **PASSED** — the two durable hostile inserts (later slice; skill delete/re-key) are rejected over the migrated legacy DB, and the **abort → operator repair → redeploy** cycle runs end-to-end on a fresh scratch DB (the migration aborts naming the demand finding; operator removes the appended slice; the migration aborts naming the worker-skill finding; operator restores the skill; the migration then redeploys cleanly and installs both durable triggers). Every prior-phase forgery rejection survives.
- `test:e2e:api:allmodules`: **31/31**; `:outbox`: **31/31**.

---

## Residual risks / notes

- The key-based demand check reuses the exact canonical fingerprint SQL (pgcrypto `digest` over the `chr(31)`-separated `(trade,skill,shift)` string) — a change to the shared `computeLabourSpecFingerprint` must update it in lockstep (already called out for the coverage owner in correction 1).
- Operator repair of an inconsistent demand aggregate briefly toggles the `LabourDemandSlice_append_only` trigger inside a maintenance transaction (documented in `§P4LC2`) — the only sanctioned way to remove an illegitimately-appended slice from an append-only table.
- No schema/DMMF change, no new domain events, no Team-gate change — those remain Tasks 2–5 per the staged contract. NO web change.
