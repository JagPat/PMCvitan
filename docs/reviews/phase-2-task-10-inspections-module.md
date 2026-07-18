# Phase 2 Task 10 — Module 3: the INSPECTIONS module extraction — Review Packet

**Review stop (one module per PR).** Task 10 extracts the remaining modules ONE PR each, with a review
stop between them. This is **module 3 of 4: `inspections`** — the stage-wise quality-inspection pillar
(issue checklist → engineer submits photo checklist → PMC approves/rejects → auto re-inspection; a closing
inspection's decision signs off / reopens its activity), extracted behind its **shared contract**, its
**read-encapsulated persistence**, its **rebuildable projection**, its **idempotent commands
(CommandExecution ledger)**, and its **module-owned frontend query under XOR** — the exact pattern Task 8/9
(decisions) and Modules 1–2 (daily-log, drawings) established, now repeated for inspections. The
consolidated Phase-2 review packet is produced only after all four modules
(daily-log → drawings → **inspections** → activities) are merged.

Branch `claude/phase2-task10-inspections` (from `main` @ `3a1cbf3`). One PR, eight commits:

| SHA | Increment |
|---|---|
| `2bd22cd` | read-boundary + rebuildable projection foundation (`inspections.inbox`, `InspectionsProjection` + additive migration, serializer split, query/consumer, manifest ownership) |
| `5536110` | route every foreign inspection read through the module boundary (media evidence check, orgs init/copy/portfolio, `project-ref`); `INSPECTIONS_QUERIES` aligned to drawings |
| `c9199c2` | inspection commands (create/submit/decide) onto the CommandExecution idempotency ledger + `Idempotency-Key` header + the module-owned `GET …/inspections` read route |
| `8b2025b` | `inspections.contract.test.ts` + activities characterization fix (inject `InspectionsQueryService`) |
| `512278c` | the module-owned frontend query under XOR + honest load states (InspectionReview + EngineerChecklist) |
| `c8d723b` | `inspections-module-query.test.ts` (XOR ownership / live fallback / failed-read / stale-response / post-command reconcile) |
| `97f836b` | live-PG projection & idempotency suites (projection == live == rebuild; finding-1 servability; create/submit/decide idempotency) |
| `fc07748` | update the project-init fan-out pin (5 → 6) for the `inspections.inbox` consumer |

_(plus this packet + the E2E `inspections-module-query.spec.ts` / `E2E_INSPECTIONS_READ` runner wiring.)_

---

## Vision alignment

One project is one site; the inspection record — checklists, the PMC review queue, re-inspections, and a
closing inspection's sign-off of its activity — is a **project operational record that never becomes
global**. Extraction adds no new owner: `inspection` / `inspectionItem` / `inspectionsProjection` stay
owned by the `inspections` module — no other module reads their persistence any more (the boundary check
enforces it), and every cross-module read goes through the module's query contract. **Human approvals stay
attributable**: `submittedById/Name`, `decidedById/Name`, the `activity.signed_off` / `signoff_rejected`
facts, and the assignee-eligibility check all survive verbatim under the extraction. The projection is a
**rebuildable read model, never a new source of truth** — its rows derive from canonical inspection state
and are dropped/rebuilt at will. The migration is additive and forward-only; tenant isolation stays
database-enforced (the existing composite FKs on the inspection models); the read cutover is
capability-versioned (`VITE_INSPECTIONS_READ`) so the old snapshot path keeps working until the flag flips.

**The atomic edges stay WORKFLOW contracts, not events (the review-relevant invariant).** The three
activity↔inspection edges are unchanged and remain in-transaction participant calls, NOT loosened into
events:
- **edge 1** — the activities `complete` workflow creates the linked *closing inspection* through this
  module's `InspectionParticipant` (and mints its id through `InspectionsQueryService.nextInspectionId`);
- **edges 2/3** — a *closing* inspection's `decide` writes the activity `applySignOff` / `revertSignOff`
  through the activities participant in the SAME transaction as the inspection CAS.

The `activity.signed_off` / `activity.signoff_rejected` events are still emitted *here* because the CAUSE is
the inspection decision (the append to the shared DomainEvent store is a platform write, not a cross-module
persistence edge). No projection change relaxes any of that.

---

## 1. The contract + read-encapsulation (`2bd22cd`, `5536110`)

**The module is reachable only through its shared contract + its `inspection.*` events.**
`packages/shared/src/contracts/inspections.ts` declares `INSPECTIONS_COMMANDS`
(`inspections.create`/`submit`/`decide`) and `INSPECTIONS_QUERIES` (`inspections.snapshotSlice`/
`projectionSlice`/`existsInProject`/`resolveRef`) plus the ONE shared `InspectionsModuleResult` both sides
import (the five role-gated slices + `source` + `generation`).

**`InspectionsQueryService` is the sole read boundary.** Every cross-module inspection read moves onto it —
the six foreign reads the structural boundary analyzer now flags are all rerouted:

| Former direct read | Now routes through |
|---|---|
| `snapshot.service` inspection slices + inspection-gate readiness | `snapshotSlice(projectId, role)` + `readinessSlice(projectId)` |
| `activities.service.loadReadiness` inspection gate | `readinessSlice(projectId, {activityId, tx})` (inside the start command's lock) |
| `activities.service.complete` closing-inspection id mint | `nextInspectionId()` |
| `media.service` evidence-upload tenant + item-ownership check | `assertEvidenceTarget(projectId, inspectionId, inspectionItemId?)` |
| `orgs.service` init id-scan / source-copy / module-extract / portfolio open-count | `allIds(tx)` / `checklistStructures(projectId,{nodeIds?,tx?})` / `openInspectionCount(projectId)` |
| `common/project-ref` `'inspection'` case | removed — validated via `resolveRefInProject` (like `decision`/`dailyLog`) |

The manifest gains `ownsModels`/`readEncapsulated` = `['inspection','inspectionItem',
'inspectionsProjection']`. The boundary CI check emits a `cross-module-read` finding for any foreign
`find*/count/aggregate` on a read-encapsulated inspection model — **none remain** (`boundary.test.ts`
green).

## 2. The rebuildable projection (`2bd22cd`, proven `97f836b`)

**Per-PROJECT read model** (`inspections.inbox`). A generation holds **ONE `InspectionsProjection` row per
project**, keyed `(generationId, projectId)`, storing the serialized viewer-INDEPENDENT base.

- `inspections-serialize.ts` splits the read into `computeInspectionsBase(client, projectId)` (viewer/
  signer-independent: every inspection with its items, the media-evidence LINKAGE as row-ids per item, and
  the activity name a closing inspection is labelled with) and `bakeInspections(base, {role, evidencePath})`
  (the five role-gated slices — `checklist` all roles; `reviews`/`review`/`reinspectionCreated` PMC-only;
  `placedInspections` pmc/engineer — with each item's evidence minted as FRESH short-lived signed serve
  paths at read time). The SAME base+bake is used by the live `snapshotSlice` AND the projection consumer —
  so **projection == live by construction**.
- The `inspections.inbox` ordered `db` projection consumer subscribes to `inspection.*`; on each it
  refreshes the project's single row's base from CANONICAL state. Every other event is a `noop` that still
  advances the ordered cursor contiguously. Rebuild hooks: `rebuildSeed` (reads max committed position
  first, then the base) + `dropGeneration`. It reuses the shared `ProjectionGeneration` table,
  `dispatchProjection`, the `ProjectionRebuilder` + final-activation barrier, and `readServableGeneration`'s
  servability gate unchanged (registered in `outbox.bootstrap.ts`).
- `moduleInspections(projectId, role)` serves the projection base **baked for the caller's role**, with a
  **live fallback** while the projection warms up (finding-1 servability gate → `source:'live'`,
  `generation:null`). `GET /projects/:projectId/inspections` exposes it under `project.read` (role-gated at
  bake time, so it is never an RBAC bypass).
- Additive migration `20261110000000_phase2_inspections_projection` (pure `CREATE TABLE`, writes no rows).

## 3. Idempotent commands on the CommandExecution ledger (`c9199c2`)

Every inspection command routes through `executeCommand(prisma, {scope, actor, commandType,
idempotencyKey, requestHash, run})` (Task 5): a keyed retry (a network retry / a double-tap) replays the
SAME success; the SAME key with a DIFFERENT payload is a `409`; the receipt is ACTOR-scoped; an UNKEYED
command keeps working (additive rollout). `peekReplay` short-circuits **BEFORE** the terminal state-machine
guards, so a retried submit/decide replays the current snapshot instead of hitting "already submitted" /
"already decided". The decide-reject one-reinspection-child `P2002` is converted to its domain `409`
**inside** `run`, so the ledger's own reservation-`P2002` handling (a different index) can never misread it.
Per the resolved contract, **payload dedup is NOT used** — two legitimately-distinct creates are two
records; only a same-key replay collapses.

## 4. The module-owned frontend query under XOR (`512278c`)

Mirrors the Module-1/2 cutover. `inspectionsReadMode()` reads `VITE_INSPECTIONS_READ` (default `'snapshot'`
— the snapshot slices own the inspection state, unchanged). `'moduleQuery'` flips ownership to
`gateway.inspections()` (`ModuleInspections`), fetched **under the SAME snapshot scope lease**
(`Promise.all` in `requestFreshSnapshot`, inheriting the identical scope/newest-owner ordering checks in
`acceptSnapshot`); a failure yields `null` → an explicit `inspectionsLoad='error'` that keeps the last-good
slices. The engineer's unsubmitted per-field marks + the submission freeze are re-applied to whatever
checklist owns the slot, so **mark preservation is source-independent**. `inspectionsLoad`/
`inspectionsSource` are torn down on every scope change (switch / re-auth / sign-out) via
`emptyModuleReadState()`; a committed command schedules a follow-up module refresh
(`anyModuleOwnedRead()` + the retained obligation until `moduleReadsOk`).

- **Honest load states** (finding-4 discipline): the InspectionReview screen shows loading / an
  unavailable+Retry boundary instead of a fabricated "No inspections awaiting review"; the
  EngineerChecklist screen shows loading / unavailable+Retry instead of a fabricated "No checklist issued".
  Both are inert in snapshot mode (`inspectionsLoad` stays `'idle'`).

---

## Behavior-preservation evidence

- **Snapshot byte-identical.** The Task-1 per-role snapshot-shape characterization is green unchanged; the
  inspection reads route through the query service with the serialization moved verbatim (the local
  `ChecklistDto`/`ReviewDto`/`PlacedInspectionDto` shape-pins are retained while `SnapshotDto` references
  the shared `Checklist`/`Review`/`PlacedInspection` types — exactly the drawings pattern).
- **projection == live == rebuild.** `test/integration/inspections-projection.test.ts` (live PG): the baked
  projection slices are byte-identical to the live baked slices; live == rebuild; the finding-1 servability
  fallbacks (legacy canonical + only a no-op; a lagging checkpoint; a blocked generation); two-project
  isolation; the HTTP module read serves (live fallback pre-generation).
- **Idempotency.** `test/integration/inspections-idempotency.test.ts` (live PG): same-key create applies
  exactly once and replays; same-key + different-payload is a `409`; the receipt is ACTOR-scoped (two PMCs,
  same key = two inspections); submit/decide replay short-circuit the terminal guards; an unkeyed command
  still works.
- **Frontend XOR.** `apps/web/tests/inspections-module-query.test.ts` (snapshot vs moduleQuery ownership;
  live fallback; failed read keeps last-good; project-switch stale-response protection; post-command module
  reconcile).
- **Contract pinned.** `inspections.contract.test.ts`: manifest commands/queries EQUAL the shared contract;
  `readEncapsulated === ownsModels` (incl. `inspectionsProjection`); the events are exactly the inspection
  lifecycle + the caused sign-off events; the activity↔inspection edge is a `workflowParticipants` entry
  (not a `dependsOn` read); the query service implements every declared query + the boundary read surface;
  every command accepts the idempotency key as its trailing argument; the API `moduleInspections` return
  conforms to the ONE shared `InspectionsModuleResult`.
- **Boundary + graph.** `boundary.test.ts` (DMMF ownership includes `inspectionsProjection`; no cross-module
  inspection read) green. The `project.created` delivery count rose **5 → 6** (an `inspections.inbox`
  projection noop now materializes alongside socket/push/decisions.inbox/daily-log.inbox/drawings.inbox) —
  pin updated in `project-initialization-atomicity.test.ts`.

## Deliberate scoping (flagged for the reviewer)

- **The atomic activity↔inspection edges stay workflow participants, not events** (see Vision alignment).
  This PR touches neither the `InspectionParticipant` (edge-1 closing-inspection create) nor the
  `activities` participant calls (edges 2/3 sign-off/revert) — they run in the same transaction as before.
- **No mutation-readiness store guard** (the drawings-only C3 hardening). The base decisions/daily-log XOR
  pattern gates the honest screen states but does not block mutations while the module read is unsettled;
  inspections follows that base pattern. The post-command reconcile handles eventual consistency; a
  reviewer wanting the stricter drawings-style guard can request it as a follow-up.
- **No shell count for inspections.** The project-shell summary already carries the pending-decision tile
  only; inspections has no analogous nav badge, so `shellSummary` is unchanged. The module read is the
  frontend surface.
- **Cross-cutting projections (Inbox/Dashboard/Portfolio) are NOT in this PR.** They complete in the Task-10
  finalize step after all four modules; this PR delivers the inspections module's OWN projection only.
- **Local E2E is environmentally flaky in this container; CI is authoritative.** The gated e2e spec
  (`apps/web/tests/e2e-api/inspections-module-query.spec.ts`, `test:e2e:api:inspections`) proves the
  module-owned GET serves the slices under the real stack and — when a review is seeded — that decide
  carries an `Idempotency-Key` and reconciles; it `test.skip`s outside `E2E_INSPECTIONS_READ=moduleQuery`,
  so it never destabilizes the default run.

---

## Verification (all green)

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + test + build, web + api) | **exit 0** |
| API unit suite | **563 passed** |
| Web unit suite | **388 passed** |
| Full integration suite (live PostgreSQL) | **320 passed** |
| `inspections-projection` + `inspections-idempotency` (live PG) | **14 passed** |
| `apps/api/scripts/upgrade-proof.sh` (all migrations over the legacy fixture) | **PASSED** |

_(CI runs the API e2e in both `legacy` and `outbox` sender modes and in the module-query read modes; this
extraction touches neither sender path.)_

**HELD for review — do not merge.** Per the one-module-per-PR review stop, the activities module (module 4)
does not start until this module's contract, boundary, tenant, projection, idempotency and frontend
evidence clears independent review.
