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

---

# CORRECTION ROUND — owner-aligned inspection facts (PR #178 independent review: BLOCKED narrowly)

PR #178 merged at `main` `0591d9c160679bfaa60dfaafc9e5e4342867084b` (the reviewed merge; this correction's
base). Verdict: **BLOCKED narrowly** — no rollback, no Activities start, ONE additive fix-forward
correction PR (this change) containing runtime, tests, manifest corrections and this packet update
together, then a stop for one narrow review.

## Root cause (confirmed reproductions A/B)

`computeInspectionsBase` — the ONE serializer both the live slice and the projection share — read
**foreign-owned** data: the `media` relation (item evidence), the `activity` relation (`Activity.name` for
a closing review's label), and `Inspection.nodeId` is changed by a **node deletion's** `ON DELETE SET NULL`
FK. But the `inspections.inbox` consumer dispatches only on `inspection.*`: `media.uploaded/removed`,
`activity.completion_requested`, `activity.updated` and `node.removed` were **no-ops that advanced the
ordered cursor without recomputing the base**. `readServableGeneration` therefore reported "current" while
the projection served stale slices — a silently-stale caught-up projection.

## The owner-aligned fix (rejected quick fix: subscribing to foreign events while keeping foreign reads —
that would hide bidirectional dependencies and contradict the acyclic boundary design)

Every foreign mutation that touches an inspection-owned serialized field now routes through
**`InspectionParticipant`** on the foreign command's OWN transaction, which (a) mutates the
inspection-owned rows and (b) **appends an inspection-owned signal event** — so the ordered cursor
refreshes the base from canonical state. The serializer reads **ONLY inspection-owned facts**.

| # | Mutation | Inspection-owned fact | Participant method (same tx) | Event appended |
|---|---|---|---|---|
| 1 | activities `complete` (closing review) | the closing Inspection row + its `activityName` stamp | `createClosingInspection` | `inspection.closing_created` |
| 2 | activities `update` rename | `Inspection.activityName` re-stamped on linked inspections | `relabelForActivity` | `inspection.relabeled` (only when a row changed) |
| 3 | media `create` (item evidence) | new **`InspectionEvidence`** link row | `addEvidence` (idempotent upsert) | `inspection.evidence_added` |
| 4 | media `remove` | `InspectionEvidence` links deleted BEFORE the media row | `removeEvidence` | `inspection.evidence_removed` (only when a link existed) |
| 5 | nodes `remove` | `Inspection.nodeId` nulled for the deleted subtree (FK stays as backstop) | `unfileForDeletedNodes` | `inspection.unfiled` (only when a row changed) |
| 6 | orgs project-init | init-created inspections materialize the projection | `createForInit(tx, args, emitCtx)` | `inspection.created` (payload `{init:true}`) |

- **Schema (additive, forward-only)** — `20261120000000_phase2_inspections_owned_facts`:
  `Inspection.activityName TEXT` (backfilled from the linked `Activity.name` — exactly the value the
  serializer read live, so the baked slice is identical the instant the column exists) + the standalone
  **`InspectionEvidence`** link model (`(inspectionItemId, mediaId)` unique; project/inspection/item/media
  FK backstops, all CASCADE), backfilled from item-level linked Media (`ON CONFLICT DO NOTHING` —
  idempotent on redeploy). **DIAGNOSTIC ABORT** (never guess a repair): a legacy `Media` row carrying an
  `inspectionItemId` with a NULL `inspectionId` (the one containment gap MATCH SIMPLE lets past the
  composite FK) aborts the migration naming the count; the operator repairs and redeploys. Legacy Media
  linkage columns are RETAINED.
- **Serializer** — `computeInspectionsBase` no longer includes the `activity`/`media` relations: it reads
  `activityName` (own column) and `inspectionEvidence` links (own model, `createdAt asc` — the same stable
  order the Media read had). `inspections-serialize.boundary.test.ts` is the source-scan regression guard
  (no foreign relation/delegate read may return; the inspection-owned reads must remain).
- **Events/catalog** — five new signal-only `DomainEventType`s + external-effect keys (`invalidate: true`,
  `push: null`): `inspection.closing_created` / `evidence_added` / `evidence_removed` / `relabeled` /
  `unfiled`. Socket invalidation stays deduplicated per project; no push. Adding keys changes
  `effectCoverageVersion()` — an outbox-mode deploy resedes per the PR C cutover discipline (the seal is
  operator-applied, not in migrations).
- **Web decide command carries its idempotency key** (exposed by the deterministic browser proof — see
  below): `gateway.decideReview(..., idempotencyKey)`, minted in `approveInspection`/`sendReinspection`,
  persisted on the `decideReview` outbox op (optional, so a pre-upgrade persisted op still replays).

## Manifest truth (acyclic preserved)

The real query/workflow edges are now declared and pinned exactly
(`module-registry.test.ts` pins both maps; `inspections.contract.test.ts` pins ownership + events):

- `inspections.ownsModels`/`readEncapsulated` **+= `inspectionEvidence`**; `producesEvents` += the five
  signal events. `dependsOn` stays `[]`.
- `activities.dependsOn` += `inspections` (reads `readinessSlice`/`nextInspectionId`);
  `media.dependsOn` += `inspections` (reads `assertEvidenceTarget`); `orgs.dependsOn` += `inspections`
  (reads `allIds` at init). Every X→inspections edge is one-directional (inspections depends on nothing),
  so **dependsOn stays acyclic**.
- The reverse (inspection-owned consequence) edges are **workflowParticipants** (cycle-exempt):
  `media.workflowParticipants = ['inspections']`, `nodes.workflowParticipants = ['inspections']`
  (activities/orgs already declared theirs). The structural boundary analyzer stays green — the
  participant writes only inspection-owned tables.

## Red-at-base → green evidence (`test/integration/inspections-owned-facts.test.ts`, live PostgreSQL, real
services end-to-end)

Each probe drives the REAL command path, drains the `inspections.inbox` deliveries, and asserts the
projection is **current AND equal to the live read** (evidence tokens normalized) — at the PR #178 base the
generation stayed "current" while `slices ≠ live` (the exact defect):

1. activity completion → the closing review (with `activityName`) is visible in the caught-up projection;
2. evidence upload is visible; evidence removal disappears; projection == live throughout;
3. node deletion → the projected `nodeId` is null; projection == live;
4. activity rename → the projected `activityName` tracks the rename (title stays stored); projection == live;
5. project init (template module) → the projection MATERIALIZES (active generation + row) without live fallback;
6. two-project isolation across foreign-driven refreshes;
7. rebuild == live after a mix of all foreign mutations.

Migration proof — `apps/api/scripts/inspections-owned-facts-abort-proof.sh` (exit 0): builds the pre-fix
DB, plants the un-linkable containment row (dropping the app-era CHECK to model a legacy DB), proves the
migration **ABORTS** with the diagnostic (single-transaction rollback leaves no half-applied schema),
repairs ONLY the offending row, **redeploys successfully**, and asserts the `activityName` +
`InspectionEvidence` backfills.

## Deterministic browser acceptance (the conditional is GONE)

`inspections-module-query.spec.ts` now runs the decision flow **unconditionally** against the seeded
pending review (`SEED_INSPECTIONS` INSP-21 — the only pending review on project A), asserting ALL of:
module-owned GET executed · decide POST executed · **`Idempotency-Key` present** · post-command module
refetch under the same scope · the decided review **leaves the queue without a reload** (the empty state
renders). Removing the `if (approve.count())` guard immediately exposed **two real defects** the
conditional had been hiding:
1. the web `decideReview` command sent **no idempotency key** (fixed above);
2. the destructive e2e seed truncated events/cursors but **left `ProjectionGeneration` + the projection
   rows behind** — a stale generation from the previous run (appliedPosition beyond the fresh, shorter
   stream head) claimed to be CURRENT and served the PREVIOUS run's slices (a stale-served projection by
   construction). The seed now truncates `ProjectionGeneration` + all four projection tables with the
   event store, so every run rebuilds its read models from its own data.

## Correction gates (actual exit codes, this container; CI re-runs everything)

| Gate | Exit | Detail |
|---|---|---|
| Focused inspections + registry + boundary + graph unit tests | **0** | 118 passed (incl. the new serializer source-boundary suite) |
| `pnpm check` (web lint/typecheck/test/build + api typecheck/test/build) | **0** | web 388 · api 567 |
| Full live-PostgreSQL integration suite | **0** | 37 files, 327 passed (incl. the 7 new owned-facts probes; init pin now 2 events × 6 consumers = 12 deliveries) |
| `upgrade-proof.sh` (all migrations incl. `20261120000000` over the legacy fixture) | **0** | PASSED |
| `inspections-owned-facts-abort-proof.sh` (abort → repair → redeploy) | **0** | PASSED |
| `pnpm test:e2e` (demo Playwright) | **0** | 21 passed |
| `pnpm test:e2e:api:inspections` (deterministic decide lifecycle, moduleQuery) | **0** | 22 passed |
| `pnpm test:e2e:api` (default snapshot mode) | **0** | 21 passed (one prior run hit the known pillar-chain picker-navigation env flake — untouched by this PR; CI authoritative) |
| Race/idempotency battery ×3 (`inspections-idempotency` + `closing-signoff` + `inspection-evidence` + `start-readiness-race`) | **0 / 0 / 0** | 31 passed each run |

**HELD for narrow review — do not merge.** Activities (module 4) stays blocked until this correction
clears the narrow Codex review.

---

# CORRECTION ROUND 2 — PR #179 narrow re-review (BLOCKED on exactly two findings)

PR #179 merged at `main` `2feab59` (this round's base). Verdict: BLOCKED on two findings; one focused
fix-forward correction PR (this change); the owner-aligned architecture is NOT reopened; the merged
`20261120000000` migration checksum is NOT modified; Activities stays blocked.

## F1 — cross-project InspectionEvidence media reference

The original backstop was the id-only FK `InspectionEvidence(mediaId) → Media(id)`, which accepted a link
whose `projectId` was project A while its `mediaId` belonged to project B. New forward migration
**`20261125000000_phase2_inspection_evidence_tenant_fk`**:

1. **Diagnose** — JOIN links to media on `mediaId`; any `ie.projectId <> m.projectId` **ABORTS** the
   migration naming the count AND the affected `InspectionEvidence` ids (no guessed repair).
2. **Drop** `InspectionEvidence_media_fkey` (the id-only backstop).
3. **Add** `FOREIGN KEY ("projectId","mediaId") REFERENCES "Media"("projectId","id") ON DELETE CASCADE
   ON UPDATE NO ACTION` — backed by the existing `Media_projectId_id_key` unique identity (the same
   composite shape GateOverride already uses).

Evidence:
- **Adversarial live-PG raw-SQL probes** (`test/integration/inspections-correction-r2.test.ts` F1): a
  project-A link naming project-B's media is REJECTED by PostgreSQL (`violates foreign key constraint`);
  a same-project link succeeds; zero cross-project rows persist. **RED at PR #179** (the id-only FK
  accepted the forgery), green now.
- **Abort → repair → redeploy proof** (`apps/api/scripts/inspection-evidence-tenant-fk-abort-proof.sh`,
  exit 0): builds the pre-round-2 DB, plants the forged cross-project link (which the id-only FK permits),
  proves the migration ABORTS naming `IE-forged` (single-transaction rollback leaves the original FK
  intact), repairs ONLY the forged row, redeploys successfully, then proves the composite FK rejects a
  fresh forgery and accepts a same-project link.
- The round-1 abort proof (`inspections-owned-facts-abort-proof.sh`) now holds back its target migration
  **and every successor** when building its baseline (the round-2 migration presumes the round-1 table),
  and still passes.

## F2 — activity completion used stale pre-transaction values

`ActivitiesService.complete` read the Activity BEFORE its transaction and passed that stale
name/zone/nodeId to `createClosingInspection` (and into the notification text + push body). Fix, exactly
per the finding:

1. the early read stays as **fast validation only** (404/409 fast paths);
2. **inside** the completion transaction, **after** the status CAS took the row lock, the Activity is
   **re-read through the transaction** (`tx.activity.findUniqueOrThrow`);
3. the transaction-current `name`/`zone`/`nodeId` go to `InspectionParticipant.createClosingInspection`;
4. the **same** transaction-current name is used for the notification text and the completion event's
   push body (the audit/event payloads carry ids only, unchanged);
5. the membership `FOR UPDATE` lock and the completion CAS are untouched.

**Deterministic barrier tests, both orderings** (`inspections-correction-r2.test.ts` F2; run ×5 + the
battery ×3):
- **A** — a barrier holds `complete()` at the moment its pre-transaction read returns; a real
  rename + re-zone + re-file (`activities.update`) COMMITS in the window; released, the completion
  transaction continues. The closing inspection carries the NEW name/zone/nodeId and the notification uses
  the NEW name. **RED at PR #179** (the stale pre-read values were stamped), green now.
- **B** — a `$transaction`-wrapper barrier holds the completion transaction OPEN at its in-tx re-read
  (row lock held); the rename dispatched in that window blocks behind the lock and applies AFTER the
  commit. Final facts converge: `Activity.name` = new, status `awaiting_signoff` (the CAS survived), the
  closing keeps its as-created title while its inspection-owned `activityName` is RELABELED to the new
  name by the participant.
- Both prove **projection == live** (token-normalized) after the relay drain.

## Round-2 gates (actual exit codes, this container; CI re-runs everything)

| Gate | Exit | Detail |
|---|---|---|
| `pnpm check` (web lint/typecheck/test/build + api typecheck/test/build) | **0** | web 388 · api 567 (the activities unit mock gained `findUniqueOrThrow` for the F2 in-tx re-read) |
| Full live-PostgreSQL integration suite | **0** | 38 files, 330 passed (incl. the 3 new round-2 probes) |
| Round-2 correction tests repeated | **0 ×5** | 3 passed each run |
| Race/idempotency battery ×3 (idempotency + closing-signoff + evidence + start-race + round-2) | **0 / 0 / 0** | 34 passed each run |
| `upgrade-proof.sh` (all migrations incl. `20261125000000` over the legacy fixture) | **0** | PASSED |
| `inspections-owned-facts-abort-proof.sh` (round 1, tail-aware baseline) | **0** | PASSED |
| `inspection-evidence-tenant-fk-abort-proof.sh` (round 2) | **0** | PASSED |
| `pnpm test:e2e:api:inspections` (deterministic decide lifecycle, moduleQuery) | **0** | 22 passed |

**HELD for the mechanical narrow review — do not merge.** Activities (module 4) stays blocked until that
review clears.
