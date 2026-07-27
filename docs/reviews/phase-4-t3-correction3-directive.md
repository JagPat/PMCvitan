# Phase 4 Task 3 Correction Round 3 Directive

**Reviewed merge:** `2a6112b` (PR #226)

**Correction base:** latest `origin/main`

**Status:** BLOCKED — Task 4 must not begin

**Scope:** three validated findings only; preserve all accepted Task 3 behavior

## Objective

Fix the evidence-preservation, module-boundary, and raw-write serialization defects found after PR #226 merged. This is fix-forward work: deployed migrations remain byte-for-byte unchanged.

## Finding 1 — P1: The Runbook Deletes Attendance Evidence

`docs/RUNBOOK.md §P4T3C2` revokes a blank-reason attendance and then disables `LabourAttendance_append_only` to delete it. That erases the original observation, recorder attribution, revocation, and correction chain while the installed trigger states that attendance rows are never deleted.

### Required result

- No repair path may delete a `LabourAttendance` row.
- No repair may invent the missing real-world reason for attendance.
- A dirty pre-`20270220000000` database must have an executable path through preflight, audited repair, and migration deployment.
- The invalid original row, its complete before-image, recorder, timestamps, revocation, operator, and repair reason remain queryable.
- The repaired row cannot contribute active presence. A replacement attendance, when justified, is a separate attributable row.

### Required implementation shape

Follow the existing T45/T2C operator pattern: a compiled schema-aware preflight before Prisma deploy and a bounded repair transaction with a durable repair-action table containing the complete before-image. The repair may use a reserved, truthful invalid-legacy marker needed to satisfy the already-deployed migration, but it must never pretend to know why the worker was present and must retain the original bytes in repair evidence. Disable only named triggers, re-enable and verify them before commit, re-run diagnostics, and roll back everything on any mismatch.

Replace the delete instructions in the runbook with this executable operator flow. Do not edit `20270220000000_phase4_t3_correction2`.

### RED probes at `2a6112b`

1. The documented repair removes the original attendance row.
2. No production preflight blocks Prisma before the Task-3 dirty state reaches the deployed diagnostic.
3. No durable before-image repair record exists for the original blank value and attribution.

## Finding 2 — P1: Labour Reads An Activities-Owned Table Directly

`LabourCapacityService.requirementHead` executes raw SQL against `ActivityRequirementRoot` before calling `ActivityParticipant`. This is a synchronous Labour-to-Activities persistence read and contradicts the leaf-module boundary.

### Required result

- Labour source contains no direct read or lock of `ActivityRequirementRoot` or `ActivityRequirement`.
- Activities owns one participant operation that locks the root `FOR UPDATE` and returns the authoritative labour requirement head in the same caller transaction.
- Lock acquisition and head read are indivisible from Labour's perspective.
- Preserve the established ordering invariants: project readiness is always
  first, the requirement root is acquired before any capacity-commitment lock,
  and worker rows are acquired in stable ascending order. Do not reorder the
  worker and commitment sections merely for this correction.
- Cancellation versus allocation and raw versus canonical races preserve their current invariants.

### RED probes at `2a6112b`

1. The boundary analyzer/source tripwire finds `ActivityRequirementRoot` in Labour source.
2. A participant test proves the existing `labourRequirementHead` reads without acquiring the root lock.

## Finding 3 — P2: Raw Multi-Requirement Inserts Can Deadlock

The row trigger locks requirement roots in input-row order. Two same-project raw batches ordered `(A,B)` and `(B,A)` can each hold one root and wait for the other until PostgreSQL aborts one with `40P01`.

### Required result

- Every raw `WorkerAllocation` insert acquires the existing per-project readiness advisory transaction lock before any requirement-root or commitment row lock.
- Canonical commands keep project readiness first, use the Activities participant
  for the root, preserve stable worker ordering, and never acquire a commitment
  before the requirement root.
- Two valid same-project batches using opposite requirement order serialize; neither fails with `40P01` and all non-conflicting rows commit.
- Raw allocation versus cancellation and raw versus canonical allocation remain coherent.
- The database remains the backstop when services are bypassed.

### RED probe at `2a6112b`

Use two real PostgreSQL sessions and explicit `pg_stat_activity` barriers. Session A inserts valid rows for requirements `(A,B)` while session B inserts distinct, non-conflicting rows for `(B,A)`. Prove the base can deadlock, then prove the correction serializes at the project lock with no `40P01`.

## Delivery And Gates

1. Start from latest `origin/main`; do not roll back PR #226.
2. Add one diagnostic-first forward migration if schema or trigger changes are required. Do not alter any deployed migration.
3. One held draft PR for all three findings because they share one Task-3 integrity boundary.
4. Include the vision-alignment statement, base/head SHAs, migration checksums, and RED→GREEN evidence.
5. Run focused probes 10 consecutive times where concurrency is involved.
6. Run `pnpm check`, the full live-PostgreSQL integration suite, `upgrade-proof.sh`, the production-runner abort→repair→redeploy proof, and both API-backed Playwright sender modes.
7. Keep the PR draft through every correction. Mark it ready only after Codex reviews the current head with no blocking finding.
8. On merge, update `docs/STATUS.md` to Task 3 `merged`; only then may the runner start Task 4.
