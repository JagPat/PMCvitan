# Phase 4 Task 1 — Labour capability + type-routed demand + trusted workforce identity (review packet)

**Base:** `main` @ `4602d5f7b00e675f5a4c137e9e9b0f4de9206718` (PR #214 merged — Phase 4 architecture plan CLEARED).
**Branch:** `claude/phase4-task1` (held draft PR).
**Scope:** Task 1 only, per `docs/superpowers/plans/2026-07-23-phase-4-labour-readiness.md` §§B/D/H and the "Required Execution Order" item 1. **Task 2 does not begin until Task 1 is CLEARED.**

Task 1 fills none of the readiness verdict yet — it lays the labour *foundation*: the pilot capability, the type-routed demand contract over the existing type-neutral `ActivityRequirement`, and the trusted `Worker`/`Crew`/`CrewMembership`/`WorkerDevice` identity — every physical-truth invariant enforced by PostgreSQL, not convention. The Team gate itself (coverage + `deriveTeamReading`) is Task 4 and is unchanged here (a non-pilot project is byte-for-byte identical).

---

## Vision alignment

Phase 4 gives the **Team** readiness gate the same canonical, transactional, lock-protected discipline Phase 3 gave the **Material** gate — over *expiring, time-bounded capacity* instead of *stock*. Task 1 is the foundation: labour demand is authored through the SAME type-neutral requirement spine (one fact, one owner — Activities owns the requirement root/revisions/events; Labour owns the labour detail + the workforce identity), the pilot is provably inert off-capability (§D), and the labour module is a LEAF (`dependsOn: []`, `activities → labour` the only new edge) so the cleared acyclic architecture is preserved by construction.

---

## §D — the labour pilot capability + type-based capability routing

| Decision | Where | Evidence |
|---|---|---|
| `'labour'` capability, same per-project `ProjectCapability` mechanism as `materials`; the SAME `capability:enable` CLI turns it on (no code change — the CLI is capability-agnostic) | `apps/api/src/platform/capabilities.service.ts` (`LABOUR_CAPABILITY`) | `phase4-t1-labour.test.ts` §D INERTNESS |
| Type-based routing: a `type='material'` requirement asserts `materials`; a `type='labour'` requirement asserts `labour` — the command asserts the capability matching the row's immutable `type` | `requirements.service.ts` `capabilityForType` (create/revise assert `input.type`; cancel resolves the row's own type) | §D TYPE ROUTING (material OK / labour 404 with materials-only; labour OK / material 404 with labour-only) |
| Capability-off byte identity: off-pilot there is no labour route, no rows, no event, and the project snapshot is byte-for-byte identical | shell `capabilities: string[]` gains `'labour'` iff enabled (`project.controller.ts`) | §D INERTNESS: `snapshot.build(other)` equal before/after; zero workers, zero events on the non-pilot project |

---

## §B — labour demand identity + units + type routing + fingerprint

| Decision | Where | Evidence |
|---|---|---|
| The demand row is the SAME append-only, root-anchored, CAS-guarded `ActivityRequirement { type:'labour' }`; the labour detail is `LabourRequirementSpec` + explicit `(civilDate, personShiftQty)` slices written THROUGH `LabourRequirementParticipant.writeRequirementSpec` in the requirement transaction (the cycle-exempt activities → labour edge) | `labour.participant.ts`; `requirements.service.ts` `writeDetail` | §B DETAIL |
| Neutral row DERIVED from slices: `baseUom='person-shift'`, `qty=Σ personShiftQty`, `requiredBy=max(civilDate)` (not caller-authored for labour) | `requirements.service.ts` `neutralColumns` (labour branch) | §B DETAIL: two slices (3+4) → qty `7`, requiredBy `2026-08-12` |
| `type` defaults to `'material'` in the discriminated create/revise contract, so every existing material caller is byte-for-byte unchanged | `contracts.ts` `withDefaultMaterialType` + `z.discriminatedUnion('type', …)` | `phase3-requirements.test.ts` 24/24 unchanged (material path preserved) |
| `labourSpecFingerprint` = SHA-256 over normalized `(tradeCode, skillCode, shift)`, ONE shared `@vitan/shared` pure function; provenance stored, never hashed | `packages/shared/src/domain/labour-spec.ts` | §B FINGERPRINT POOLING (two decisions → one fingerprint; night ≠ day); the served fingerprint equals `computeLabourSpecFingerprint(...)` |
| DB type↔detail correspondence: `type='labour'` ⟺ exactly one `LabourRequirementSpec` + zero `MaterialRequirementSpec` (and the material arm unchanged); a demand slice attaches ONLY to a labour revision | `20270110000000_phase4_t1_labour/migration.sql` (`phase3_requirement_spec_pairing` made labour-aware; `phase4_labour_slice_typed`) | §B TYPE↔DETAIL (labour w/o detail refuses; labour+material refuses; slice on material refuses) |
| Immutable ROOT type: a revision cannot change a requirement's type (service refuses an explicit change early; a BEFORE INSERT trigger is the backstop) | `requirements.service.ts` (revise guard + `type: head.type`); migration `phase4_requirement_type_immutable` | §B IMMUTABLE ROOT TYPE |
| Labour detail + slices are database append-only (same rule as `MaterialRequirementSpec`) | migration append-only triggers over `LabourRequirementSpec`/`LabourDemandSlice` | §B IMMUTABILITY (UPDATE/DELETE both rejected) |
| revise/cancel copy the labour detail verbatim onto the new revision (type↔detail holds on the cancellation revision too) | `requirements.service.ts` `writeDetail` (revise) + `labourParticipant.copyRequirementSpecForCancel` (cancel) | §B DETAIL (revise append + cancel copy) |

---

## §H — trusted workforce identity + containment + uniqueness + concurrency

| Decision | Where | Evidence |
|---|---|---|
| First-class project-contained `LabourTrade`/`LabourSkill`/`Worker`/`Crew`/`CrewMembership`; onboarding is `pmc` authority (`labour.manage`), capability-gated | `labour.service.ts`; `labour.controller.ts`; `policy.ts` | §H ONBOARDING (trade FK + skill validation + reads); read is pmc/engineer (`labour.read`), client refused |
| `WorkerDevice`→`Worker` composite-FK binding (nullable — anonymous QR/tap onboarding unchanged; the bind COMMAND is deferred to Task 3 to keep labour from writing an orgs-owned table) | `schema.prisma` `WorkerDevice.worker` (composite `(projectId, workerId)` FK); migration | §H CONTAINMENT (a device cannot bind a cross-project worker; a same-project bind is accepted) |
| Cross-project worker/crew/device references are UNREPRESENTABLE in PostgreSQL (same-project composite FKs) | migration composite FKs | §H CONTAINMENT (crew cannot enroll a cross-project worker; device cannot bind one) |
| One ACTIVE crew membership per `(crew, worker)` (partial unique WHERE `removedAt IS NULL`) — a re-add after removal is allowed | migration `CrewMembership_active_member_key` | §H ONBOARDING (second add refuses; remove-then-re-add allowed) |
| Worker active window (`activeTo >= activeFrom`) + revoke stamps both columns exactly once | migration CHECKs | §H WORKER LIFECYCLE (revoke stamps `revokedAt`/`revokedById`; a second revoke refuses); §H upgrade-proof CHECK |
| One demand slice per `(requirement revision, civilDate)` — the service dedupes, the DB partial unique is the backstop | `requirements.service.ts` `parseLabourSlices` + migration `LabourDemandSlice_one_per_date_key` | §H WORKER LIFECYCLE (duplicate slice refused) |

---

## §G — acyclic module graph (labour is a LEAF)

| Edge | Value | Where |
|---|---|---|
| `labour.dependsOn` | `[]` (a sink, exactly like `inventory`) | `labour.manifest.ts` |
| `labour.workflowParticipants` | `[]` (Task 1 — labour invokes no other module's participant here; Task 4 adds `activities`/`procurement`) | `labour.manifest.ts` |
| `labour.producesEvents` | `[]` (onboarding is a roster surface — NO domain event; the capacity-fact event family arrives in Tasks 3–5) | `labour.manifest.ts` |
| `activities.workflowParticipants` | gains `labour` (requirements.service writes the labour detail through `LabourRequirementParticipant`) | `activities.manifest.ts` |
| Ownership | `labour` owns the 7 labour models; `MODEL_OWNER`, boundary-analyzer `DEFAULT_DIR_TO_MODULE`, registry `MODULE_MANIFESTS` all updated | tripwires below |

The ONLY new graph edge is `activities → labour` (a participant edge, cycle-exempt). No cycle is introduced.

---

## Tripwire updates (same PR that changes the boundary)

- `cross-module-graph.test.ts`: `MODEL_OWNER` gains the 7 labour models → `'labour'`; `SERVICES` gains `labour/labour.service.ts` (`dispatch: 0`); `CONTROLLER_ROUTES` gains `labour/labour.controller.ts` (7 mutating routes); route total `108 → 115` (×2 assertions). Dispatch total (60) and emitter count (13) unchanged — labour dispatches 0.
- `module-registry.test.ts`: enablement list gains `'labour'`; `expectedParticipants['activities']` gains `'labour'` (ordered). `labour.dependsOn = []` is the `?? []` default.
- `boundary.test.ts`: declared-route total `108 → 115`.
- `route-policy.test.ts`: `LabourController` added to `CONTROLLERS` (satisfies the no-dead-policy check for `labour.manage`/`labour.read`).
- `boundary-analyzer.ts`: `DEFAULT_DIR_TO_MODULE` gains `labour: 'labour'` (so labour.service/participant writes attribute to the labour module).
- `apps/web/tests/policy.test.ts`: `labour.manage`/`labour.read` in the EXPECTED map (parity with shared `ROLE_POLICY`).

---

## Migration — `20270110000000_phase4_t1_labour` (additive, diagnostic-first)

- **Diagnostic-first preamble** ABORTS if any pre-existing labour-typed `ActivityRequirement` exists (impossible on a valid legacy DB — the requirement command only ever wrote `type='material'`; never fabricates a labour spec).
- Base DDL: the `WorkerDevice.workerId` column + the 7 labour tables + indexes + same-project composite FKs.
- Partial uniques: `CrewMembership_active_member_key`, `LabourDemandSlice_one_per_date_key`.
- CHECKs: Worker/Crew active-window + revoke-all-or-none; CrewMembership remove-all-or-none; LabourRequirementSpec shift ∈ {day,night} + provenance all-or-none; LabourDemandSlice personShiftQty > 0.
- Triggers: labour-detail append-only (reuse `phase3_requirements_append_only`); labour-aware `phase3_requirement_spec_pairing` (material semantics preserved EXACTLY); `phase4_labour_slice_typed`; `phase4_requirement_type_immutable`.

Legacy databases upgrade **row-free** (proven by `upgrade-proof.sh`).

---

## Verification battery

- `pnpm check` — **EXIT 0** (build:shared + prisma:generate + web/api typecheck + unit tests + build).
- Live-PostgreSQL integration — the reproduce-first `phase4-t1-labour.test.ts` (10 tests) + the full suite (material path preserved).
- `apps/api/scripts/upgrade-proof.sh` — labour tables exist + wrote ZERO rows over the legacy DB; hostile inserts (cross-project worker/device/crew, duplicate active membership, active-window CHECK, type↔detail forgery, slice-on-material) rejected by the DB seals.

### Gate results (against a pristine live PostgreSQL 16)

- `pnpm check`: **EXIT 0** — web **432/432**, API unit **634/634**, build OK.
- integration (`vitest.integration.config.ts`): **58 files / 520 tests, all passing** on a freshly reset+migrated DB (includes `phase4-t1-labour.test.ts` 10/10 and the full material path). *(Baseline check: pristine `main` @ `4602d5f` runs 57/57 & 510/510 green; this PR adds the labour file and 10 tests.)*
- `upgrade-proof.sh`: **PASSED** — all migrations apply over the legacy fixture, the 7 labour tables wrote **zero** rows, every labour hostile-insert seal rejects (cross-project crew/device, duplicate active membership, active-window CHECK, type↔detail forgery, slice-on-material), and every prior-phase F1–F4 forgery rejection survives.
- `test:e2e:api:allmodules`: **31/31** (one first-run flake on the unrelated `project-scope` browser-history test; clean re-run 31/31).
- `test:e2e:api:allmodules:outbox`: **31/31** (one first-run flake on the unrelated `drawings-module-query` reconciliation test; clean re-run 31/31).

### Test-harness correction (visible in the diff)

`LabourRequirementSpec` carries the same authoritative decision provenance FK to `DecisionApprovalRevision` (the immutable approval register) as `MaterialRequirementSpec`, and FKs the `(projectId, requirementId, revision)` requirement triple. PostgreSQL refuses to `TRUNCATE` a table that ANY table references — even with zero rows — so six pre-existing reset statements that did `TRUNCATE "MaterialRequirementSpec", "DecisionApprovalRevision"` had to list the labour child tables too. Each now reads `TRUNCATE "LabourDemandSlice", "LabourRequirementSpec", "MaterialRequirementSpec", "DecisionApprovalRevision"` (change-control, command-ledger, derived-readiness, phase1-baseline, phase2-consequences, start-readiness-race). The 13 phase-3 requirement suites (which truncate `ActivityRequirement`) were extended the same way. This is a cleanup-list correction only — no test assertion changed.

---

## Residual risks / notes

- The `WorkerDevice.workerId` **binding column + FK** ship in Task 1 (the structural foundation, proven by the cross-project forgery probe); the attendance/binding **command** is deferred to Task 3 (it would set a value on the orgs-owned `WorkerDevice` row — a foreign write labour must not do until the owning module or a participant channel carries it).
- No labour **domain events** and no **coverage/Team-gate** change in Task 1 — those are Tasks 3–5. The `requirement.*` events gain a discriminated `type`/`labourSpecRef` payload (Activities-owned), consumed by nobody new here.
- The Prisma `migrate diff` benign FK-name churn (custom-named provenance FK) follows the established Phase-3 hand-written-migration convention; runtime behaviour is unaffected.

## Done / Pending

**Done (Task 1):** labour capability + capability-off byte identity; type-routed demand + immutable root type + DB type↔detail correspondence + `LabourRequirementParticipant`; `LabourRequirementSpec` + slices + `labourSpecFingerprint` + append-only; `LabourTrade`/`LabourSkill`/`Worker`/`Crew`/`CrewMembership` + `WorkerDevice`→`Worker` FK + containment + uniqueness + lifecycle; labour LEAF manifest + `activities → labour` participant edge; `labour.manage`/`labour.read` policy + 7 commands + 2 reads; additive diagnostic-first migration; reproduce-first tests; tripwire + upgrade-proof updates; docs.

**Pending (later tasks, NOT this PR):** the `WorkerDevice` bind command + attendance (Task 3); `CapacityCommitment`/`WorkerAllocation`/`Attendance`/`LabourWorkFact` (Tasks 2–3/5); `LabourService.coverageFor` + `deriveTeamReading` + the Team gate + the 7th projection + the acyclic-graph acceptance test + `activities.dependsOn` gaining `labour` (Task 4); the Labour hub frontend (Task 6).
