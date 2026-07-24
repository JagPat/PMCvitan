# Phase 4 Task 1 — correction review packet (BLOCKED NARROWLY → resolved)

**Base:** `origin/main` @ `296db92` (PR #215 merged — Task 1 delivered; independent review returned BLOCKED NARROWLY with six findings; PR #215 is NOT rolled back — this is additive).
**Branch:** `claude/phase4-task1-correction` (held draft PR).
**Scope:** ONLY the six review findings, reproduced RED at `296db92` before fixing. **Task 2 does not begin.**

---

## Vision alignment

Task 1 lays the labour foundation with the SAME canonical, DB-enforced, read-encapsulated discipline the material spine carries. This correction closes the gaps the review found: the physical-truth invariants the SERVICE already checked are now enforced by PostgreSQL (labour demand + skill references), Activities reads Labour-owned facts through a contract (not a Prisma relation include, now caught structurally by the boundary analyzer), the requirement register is readable by a labour-only pilot, the workforce lifecycle is a CAS with a deterministic loser, and the plan's Task-1 permission/event contract is reconciled to the approved staging.

---

## Findings → resolution → evidence

### F1 — restore true read encapsulation

| Sub-finding | Fix | Evidence (RED → GREEN) |
|---|---|---|
| Activities read the Labour-owned requirement detail via a Prisma relation include (`ActivityRequirement.include: { labourSpec, labourSlices }`) | New **`LabourRequirementQuery.detailsFor(projectId, refs, tx?)`** (labour module, own-module read); `requirements.service.ts` drops the labour includes (keeps only its own `materialSpec`) and hydrates through the contract in create/revise/cancel (in-tx) and list (batch). `activities.dependsOn` gains `labour` (Labour stays a LEAF, so acyclic). | `boundary.test.ts` — the nested-read detection flags `requirements.service.ts` reading `labourSpec` before the fix; GREEN after routing through the query |
| Labour directly hydrated Orgs-owned `WorkerDevice` rows (`worker.include({ devices })`) | Removed — the Task-1 workforce read no longer reads `WorkerDevice` (an orgs-owned model); `WorkerDto.devices` dropped (device display lands in Task 3 through the owner's contract) | `labour.service.ts` `workforce()` no longer includes `devices`; boundary analysis clean |
| The analyzer could not see foreign nested reads | **Extended `boundary-analyzer.ts`**: `scanCallNestedReads`/`scanNestedReads` walk a read's `include`/`select` and flag a relation resolving to a read-encapsulated model owned by another module (mirrors the existing nested-WRITE scan) | `boundary.test.ts` GREEN; it independently caught a pre-existing latent violation — `activities.service.ts start` read `activity.decision.status` via `include: { decision: true }`, now routed through **`DecisionsQueryService.statusOf`** (in-tx, own-module read) |

### F2 — DB-enforce the labour demand seal (was service-only)

Migration `20270115000000_phase4_t1_correction` adds a **DEFERRABLE INITIALLY DEFERRED** constraint trigger `LabourRequirementSpec_demand_sealed` (fires once per labour revision at commit): rejects unless the revision carries **≥1 slice**, `baseUom='person-shift'`, `requiredQty = SUM(personShiftQty)`, `requiredBy = MAX(civilDate)`, and a `labourSpecFingerprint` equal to the **canonical SHA-256** recomputed in SQL (pgcrypto `digest` over the exact `chr(31)`-separated `(trade,skill,shift)` string the shared `computeLabourSpecFingerprint` hashes). Diagnostic-first preamble ABORTS on any pre-existing violation.
Evidence: `phase4-t1-correction.test.ts` **F2 SEAL** — no-slice / wrong-baseUom / wrong-sum / wrong-needed-by / forged-fingerprint each REJECTED at commit; a coherent revision commits. `upgrade-proof.sh` — the same hostile inserts over a migrated legacy DB rejected; the coherent revision accepted.

### F3 — PostgreSQL-enforced skill references (were service-only)

- `LabourRequirementSpec.skillCode` gets a **same-project composite FK** to `LabourSkill` (nullable — a bare-trade demand passes; a present skill must be in the same project's catalog). Schema relation added so the DMMF reflects it.
- `Worker.skillCodes[]` (an array cannot carry a per-element FK) gets an equivalent **DB-enforced relation** — the `Worker_skills_contained` BEFORE INSERT/UPDATE trigger rejects any element absent from the same-project catalog.
Evidence: `phase4-t1-correction.test.ts` **F3 SKILL FK / WORKER SKILLS** — a nonexistent OR cross-project skill is rejected for both the spec FK and the worker array; a valid same-project skill is accepted. `upgrade-proof.sh` F3 hostile inserts rejected.

### F4 — the requirement register reads when materials OR labour is enabled

`RequirementsService.list` now passes when `materials` OR `labour` is enabled and 404s only when NEITHER is. Evidence: `phase4-t1-correction.test.ts` **F4 LIST** — a labour-only pilot (materials OFF) creates then lists its labour requirement; a project with neither capability 404s.

### F5 — complete the workforce lifecycle

- New **`labour.crew.revoke`** command (attributable via `recordAudit`, idempotent via the command ledger; route + manifest + `labour.manage` authority).
- **CAS** `active → revoked` transitions for worker revoke, crew revoke, and membership removal (conditional `UPDATE … WHERE revokedAt/removedAt IS NULL`, affected-count checked): a concurrent second attempt is a truthful **409** (deterministic loser), never a double-stamp.
Evidence: `phase4-t1-correction.test.ts` **F5 CREW REVOKE** (idempotent keyed replay; fresh-key second revoke → 409) + **F5 CAS** (concurrent worker/crew/membership pairs each: exactly one fulfilled, one rejected). The existing labour test's second-revoke assertion updated 400 → 409 to reflect the CAS semantics.

### F6 — reconcile Task-1 plan truth

- **Docs-only staging correction** in the plan (Task-1 line + a dedicated note): Task 1 ships the ONBOARDING permission pair (`labour.manage`/`labour.read`) and NO domain event; the fuller permission set + the labour event family ship WITH their facts in Tasks 2–5 (the acyclic-leaf design already implies this — no permission/event is dropped, each is deferred to the task that introduces its behavior).
- **The packet no longer claims DB enforcement where only service validation existed:** after F2/F3 the labour demand seal, the canonical fingerprint, and both skill references ARE PostgreSQL-enforced (proven above). The Task-1 packet's honest "service-validated" notes for these are superseded by this correction.

---

## Migration — `20270115000000_phase4_t1_correction` (additive, diagnostic-first)

`CREATE EXTENSION IF NOT EXISTS pgcrypto`; a diagnostic `DO` block ABORTS with a per-finding count on any pre-existing labour row that violates the new seals (never invents data); the skill composite FK; the `phase4_worker_skills_contained` trigger; the `phase4_labour_demand_sealed` deferred constraint trigger. Migration `20270110…` (Task 1) is unchanged. Legacy databases upgrade **row-free** (the labour pilot has no rows).

---

## Gate battery (pristine live PostgreSQL 16)

- `pnpm check`: **EXIT 0** — web **432/432**, API unit **634/634**, build OK.
- integration (`vitest.integration.config.ts`): **59 files / 526 tests** on a freshly reset+migrated DB (incl. `phase4-t1-correction.test.ts` 6/6, `phase4-t1-labour.test.ts` 10/10, and the two phase-3 labour fixtures updated for the canonical fingerprint).
- `boundary.test.ts` (F1 structural): GREEN after the nested-read detection + the two routed reads.
- `upgrade-proof.sh`: **PASSED** — all migrations apply over the legacy fixture, labour tables row-free, every labour §H/§B + the new F2/F3 hostile inserts rejected, the coherent labour revision accepted, and every prior-phase forgery rejection survives.
- `test:e2e:api:allmodules`: **31/31** (materials-pilot 4/4; one earlier run flaked on the documented timing-sensitive `daily-log-lost-response` step — unrelated to this read-only change — clean on re-run). `test:e2e:api:allmodules:outbox`: **31/31**.

---

## Residual risks / notes

- The F1 analyzer extension is general: it will flag ANY future foreign nested read of a read-encapsulated model. It surfaced one pre-existing latent violation (activities→decision status), fixed here through the decisions query contract — no behavior change, the same status now read in-tx under the readiness lock.
- The F2 demand seal recomputes the canonical fingerprint in the DB via pgcrypto; the SQL canonical string is kept byte-identical to the shared `computeLabourSpecFingerprint` (the `chr(31)` unit separator + `normalizeLabourCode` = `lower(btrim(regexp_replace(…,'\s+',' ')))`). A change to the shared canonicalization must update the trigger in lockstep (called out for the coverage owner).
- No new domain events, no Team-gate change — those remain Tasks 3–5 per the staged contract (F6).
