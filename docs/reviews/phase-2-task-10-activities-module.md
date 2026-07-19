# Phase 2 Task 10 — Module 4: the ACTIVITIES module extraction — Review Packet

**Review stop (one module per PR).** Task 10 extracts the remaining modules ONE PR each, with a review
stop between them. This is **module 4 of 4: `activities`** — the Site Activity spine (activities + phases
+ gate overrides; planned-vs-actual windows; the five-gate readiness derivation; start/complete under the
readiness protocol; the closing-sign-off workflow with inspections), extracted behind its **shared
contract**, its **read-encapsulated persistence**, its **rebuildable projection**, its **idempotent
commands (CommandExecution ledger)**, and its **module-owned frontend query under XOR** — the exact
pattern Task 8/9 (decisions) and Modules 1–3 (daily-log, drawings, inspections) established, now repeated
for the final module. The consolidated Phase-2 review packet is produced only after this module merges
(the Task-10 finalize step follows: Inbox/Dashboard/Portfolio projections + gate sweeps).

Branch `claude/phase2-task10-activities` (from `main` @ `161e574`, the CLEARED PR #180 merge).

| Commit | Increment |
|---|---|
| `91c0d9b` | backend extraction: shared contract, ONE canonical serializer (base/bake), `ActivitiesQueryService` read boundary, `activities.schedule` rebuildable projection + additive migration, participant signal events, all 9 commands onto the ledger, every foreign activity read rerouted |
| `35459f1` | the module-owned frontend query under XOR (`VITE_ACTIVITIES_READ`) + honest load states + command idempotency keys + e2e runner wiring |
| _(this packet's commit)_ | contract/projection/idempotency/XOR tests, pin updates (init fan-out 6 → 7 consumers, 2 → 4 events; nodes participants; boundary ownership), review packet |

---

## Vision alignment

One project is one site; the activity spine — the schedule, its phases, the readiness gates, the manual
overrides, the start/complete lifecycle — is a **project operational record that never becomes global**.
Extraction adds no new owner: `activity` / `gateOverride` / `phase` (+ the new `activitiesProjection`)
stay owned by the `activities` module — no other module reads their persistence any more (the boundary
check enforces it), and every cross-module read goes through the module's query contract. **Human
approvals stay attributable**: `completionRequestedById/Name`, the override's `actorId/actorName/reason/
expiresAt/evidenceMediaId`, and the sign-off audit trail all survive verbatim under the extraction. The
projection is a **rebuildable read model, never a new source of truth** — its rows derive from canonical
activity state and are dropped/rebuilt at will. The migration is additive and forward-only; tenant
isolation stays database-enforced (the existing composite FKs on the activity models); the read cutover
is capability-versioned (`VITE_ACTIVITIES_READ`) so the old snapshot path keeps working until the flag
flips.

**The Module-3 owner-aligned staleness lesson is applied UP FRONT (the review-relevant invariant).** The
activity spine's serialized output contains a heavily FOREIGN-derived conclusion: each activity's
five-gate `readiness` (decision status, inspection chain, drawing acks, active members, overrides). A
projection that stored baked readiness would go silently stale under every foreign mutation — exactly the
defect the Module-3 correction rounds removed. So, by construction:

- `computeActivitiesBase` stores **ONLY activity-owned facts** (every activity's own columns, ALL its
  overrides with expiry, every phase). Nothing foreign-owned enters the base.
- `bakeActivities` derives readiness **FRESH at read time** from the decisions/inspections/drawings query
  contracts + active memberships — on the live path AND the projection path identically, so a projection
  read is never a stale conclusion. Override expiry is time-based and filtered against the read's `now`
  (no event needed to stay truthful).
- Every FOREIGN command that mutates an ACTIVITY-OWNED serialized fact appends an activity-owned signal
  event **on its own transaction through `ActivityParticipant`**, so the ordered projection cursor
  observes every base change: the daily-log material mismatch emits `activity.material_blocked`; a node
  deletion emits `activity.unfiled` (the `ON DELETE SET NULL` FK stays as the DB backstop); project
  initialization emits `activity.created`/`phase.created` `{init:true}` (the projection MATERIALIZES from
  init, not the live fallback); the closing-inspection decide already emits
  `activity.signed_off`/`signoff_rejected` (unchanged — the cause is the inspection decision).

**The atomic edges stay WORKFLOW contracts, not events.** The activity↔inspection edges are unchanged and
remain in-transaction participant calls: edge 1 (`complete` creates the closing inspection through
`InspectionParticipant`), edges 2/3 (the closing decide writes `applySignOff`/`revertSignOff` through
`ActivityParticipant` in the SAME transaction as the inspection CAS). The R2-F2 tx-current-name
discipline is EXTENDED, not weakened: `applySignOff`/`revertSignOff` now **return the tx-current activity
name** (read after the CAS row lock), so the decide's notification/push/event bodies can never stamp a
stale pre-transaction name — and the decide's pre-command activity read moves onto the participant
(`signOffTarget`), so inspections never touches `prisma.activity` at all.

**Cycle-free reference validation (a deliberate design point for the reviewer).** Inspections and
drawings STORE an `activityId` but sit UPSTREAM of activities in `dependsOn` (activities reads their
queries for its readiness bake) — they cannot take an activities query edge without a dependency cycle.
Their stored references are therefore validated by the existing composite `(projectId, activityId)`
tenant FKs (`Inspection` NO ACTION @ `20260930`; `Drawing` SET NULL(activityId) @ `20261025`), with the
P2003 violation translated to the SAME human-readable 400 (`rethrowActivityRefViolation`). The
`project-ref` `'activity'` case is removed; the caller-facing contract is identical.

---

## 1. The contract + read-encapsulation

**The module is reachable only through its shared contract + its `activity.*`/`phase.*` events.**
`packages/shared/src/contracts/activities.ts` declares `ACTIVITIES_COMMANDS` (7 activity + 2 phase
commands) and `ACTIVITIES_QUERIES` (`activities.snapshotSlice`/`projectionSlice`/`existsInProject`/
`resolveRef`) plus the ONE shared `ActivitiesModuleResult` both sides import (`activities` + `phases` +
`source` + `generation`).

**`ActivitiesQueryService` is the sole read boundary.** Every cross-module activity read moves onto it:

| Former direct read | Now routes through |
|---|---|
| `snapshot.service` activity/phase/gateOverride reads + the whole readiness derivation block | `snapshotSlice(projectId, {decisionStatuses})` — the snapshot chains its already-fetched decision status map in, so the decision read never happens twice; the inspection/drawing readiness inputs + active members moved INTO the module's bake |
| `orgs.service` init id-scan | `allIds(tx)` |
| `orgs.service` source-copy + module-extract schedule reads | `scheduleStructures(sourceId, {tx?})` (planned STRUCTURE only — status/actuals/links never travel) |
| `orgs.service` portfolio activity rollup + phase count | `statusCounts(projectId)` (`total` counts every activity — an `awaiting_signoff` claim is in the total but no bucket) |
| `inspections.service.decide` sign-off target (`prisma.activity.findUnique`) | `ActivityParticipant.signOffTarget` (the cycle-exempt workflow channel) + tx-current names returned by `applySignOff`/`revertSignOff` |
| `inspections.service.create` / `drawings.service.issue` activityId validation (`resolveProjectRef('activity', …)`) | the composite tenant FK + `rethrowActivityRefViolation` (see Vision alignment) |

The manifest gains `ownsModels`/`readEncapsulated` = `['activity','gateOverride','phase',
'activitiesProjection']`; `producesEvents` gains `activity.material_blocked` + `activity.unfiled` (both in
`DOMAIN_EVENT_TYPES` and the external-effect catalog as `{invalidate: true, push: null}` signals); the
`nodes` manifest gains the `activities` workflow-participant edge. The boundary CI check emits a
`cross-module-read` finding for any foreign read of a read-encapsulated activity model — **none remain**
(`boundary.test.ts` green).

## 2. The rebuildable projection

**Per-PROJECT read model** (`activities.schedule`). A generation holds **ONE `ActivitiesProjection` row
per project**, keyed `(generationId, projectId)`, storing the serialized ACTIVITY-OWNED base only.

- The ordered `db` projection consumer subscribes by prefix to `activity.*` OR `phase.*` (covering the
  command events, the inspections-emitted sign-off events, AND the new participant signals); on each it
  refreshes the project's single row from CANONICAL state. Every other event is a `noop` that still
  advances the ordered cursor contiguously. Rebuild hooks: `rebuildSeed` + `dropGeneration`; the shared
  `ProjectionGeneration`/rebuilder/final-activation-barrier/`readServableGeneration` machinery is reused
  unchanged (registered in `outbox.bootstrap.ts` — consumer count 6 → 7).
- `projectionSlice` reads the servable generation's base and bakes it **with FRESH foreign inputs** — a
  projection read carries readiness exactly as current as a live read's. `moduleActivities(projectId)`
  serves projection-else-live (`source`/`generation` reported); `GET /projects/:projectId/activities`
  exposes it under `project.read`.
- Additive migration `20261130000000_phase2_activities_projection` (pure `CREATE TABLE`, writes no rows).

## 3. Idempotent commands on the CommandExecution ledger

All NINE activity/phase commands route through `executeCommand` with `peekReplay` short-circuiting BEFORE
validation/id-mint/terminal guards: `activities.create`/`update`/`remove`/`start`/`complete`/`override`/
`revokeOverride` + `phases.create`/`remove`, each accepting the `Idempotency-Key` header. The complete()
concurrent-inspection-id `P2002` is converted to its domain 409 **inside** `run` (the decide-reject
pattern), so the ledger's reservation-P2002 handling never misreads it. remove()'s FK-blocked delete is
translated to its domain 409 at the delete call, not by a blanket catch. The R2-F2 in-transaction
re-read in `complete()` and the readiness-lock protocol in every readiness-affecting command are
preserved verbatim inside `run`.

## 4. The module-owned frontend query under XOR

Mirrors the Module-1/2/3 cutover. `activitiesReadMode()` reads `VITE_ACTIVITIES_READ` (default
`'snapshot'`). `'moduleQuery'` flips ownership of `s.activities` AND `s.phases` (one spine, one owner) to
`gateway.activities()`, fetched under the SAME snapshot scope lease; a failure yields `null` → an explicit
`activitiesLoad='error'` that keeps the last-good spine; `moduleReadsOk` includes the activities read, so
a committed command's reconcile obligation is retained until the module read actually succeeds.
`activitiesLoad`/`activitiesSource` tear down on every scope change via `emptyModuleReadState()`. All nine
store command actions mint ledger keys; `startActivity`/`completeActivity` share ONE key between the
online call and the queued offline op (optional on the op type so pre-upgrade persisted ops still
replay). The ScheduleScreen gains honest loading / unavailable+Retry boundaries (finding-4 discipline),
inert in snapshot mode.

---

## Behavior-preservation evidence

- **Snapshot byte-identical.** The Task-1 per-role snapshot-shape characterization is green unchanged; the
  activity/phase serialization moved verbatim into `computeActivitiesBase`/`bakeActivities` (the same
  status remap, readiness derivation, unexpired-override filter, and phase rollup).
- **projection == live == rebuild + never-stale readiness.** `test/integration/activities-projection.test.ts`
  (live PG): projection slices byte-identical to live; live == rebuild; finding-1 servability fallbacks;
  the FOREIGN-mutation refreshes (material-block → `activity.material_blocked`, node delete →
  `activity.unfiled`, closing-decide → `activity.signed_off`) each land in the projection after relay
  drain; project-init materializes the projection from `activity.created`/`phase.created` `{init:true}`;
  two-project isolation.
- **Idempotency.** `test/integration/activities-idempotency.test.ts` (live PG): same-key create/start/
  complete/override/phase-create apply exactly once and replay cleanly past the terminal guards; same key
  + different payload is a 409.
- **Frontend XOR.** `apps/web/tests/activities-module-query.test.ts` (snapshot vs moduleQuery ownership of
  activities+phases; command-snapshot leaves the module slices untouched; failed read keeps last-good;
  scope teardown; snapshot-mode unchanged).
- **Contract pinned.** `activities.contract.test.ts`: manifest commands/queries EQUAL the shared contract;
  `readEncapsulated === ownsModels` (incl. `activitiesProjection`); the events are exactly the activity/
  phase lifecycle + the participant signals; the inspections edge stays a `workflowParticipants` entry.
- **Boundary + graph + fan-out.** `boundary.test.ts` (DMMF ownership includes `activitiesProjection`; no
  cross-module activity read) green; `module-registry.test.ts` pins the new `nodes: ['inspections',
  'activities']` participant edge; the init fan-out pin rose to **4 events × 7 consumers = 28 deliveries**
  in `project-initialization-atomicity.test.ts`.

## Deliberate scoping (flagged for the reviewer)

- **The atomic workflow-participant transactions with Decisions, Drawings and Inspections are preserved**,
  per the directive: edge 1 (complete → closing inspection), edges 2/3 (decide → sign-off/revert), edge 4
  (material mismatch → block), the init participants, and the node-delete unfile all remain single-
  transaction participant calls. No edge is loosened into an event; the new events are SIGNALS appended in
  those same transactions.
- **`signOffTarget` is a participant read, not a query edge.** The inspections decide needs the sign-off
  target's identity + recorded completer BEFORE its command runs; taking `ActivitiesQueryService` would
  create the dependsOn cycle above, so the read lives in the cycle-exempt participant (physically inside
  the activities module) — same rationale as the participant writes.
- **No mutation-readiness store guard** (the drawings-only C3 hardening): activities follows the base
  decisions/daily-log/inspections XOR pattern — honest screen states + post-command reconcile.
- **Cross-cutting projections (Inbox/Dashboard/Portfolio) are NOT in this PR.** They complete in the
  Task-10 finalize step; this PR delivers the activities module's OWN projection only.
- **Local E2E is environmentally flaky in this container; CI is authoritative.** The gated e2e spec
  (`apps/web/tests/e2e-api/activities-module-query.spec.ts`, `test:e2e:api:activities`) proves the
  module-owned GET serves the spine under the real stack; it `test.skip`s outside
  `E2E_ACTIVITIES_READ=moduleQuery`, so it never destabilizes the default run.

---

## Verification (all green)

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + test + build, web + api) | TBD |
| API unit suite | TBD |
| Web unit suite | TBD |
| Full integration suite (live PostgreSQL) | TBD |
| `activities-projection` + `activities-idempotency` (live PG) | TBD |
| `apps/api/scripts/upgrade-proof.sh` (all migrations over the legacy fixture) | TBD |
| Abort proofs (`inspections-owned-facts` + `inspection-evidence-tenant-fk`) | TBD |

_(CI runs the API e2e in both `legacy` and `outbox` sender modes and in the module-query read modes; the
new `test:e2e:api:activities(:outbox)` scripts add the activities read mode to that matrix.)_
