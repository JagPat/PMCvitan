# Phase 2 Task 10 — Module 2: the DRAWINGS module extraction — Review Packet

**Review stop (one module per PR).** Task 10 extracts the remaining modules ONE PR each, with a review
stop between them. This is **module 2 of 4: `drawings`** — the controlled-drawing register (issue →
publish → revise/supersede → acknowledge), extracted behind its **shared contract**, its
**read-encapsulated persistence**, its **rebuildable projection with per-viewer baking**, its
**idempotent commands (CommandExecution ledger)**, and its **module-owned frontend query under XOR** —
the exact pattern Task 8/9 (decisions) and Module 1 (daily-log) established, now repeated for drawings.
The consolidated Phase-2 review packet is produced only after all four modules
(daily-log → **drawings** → inspections → activities) are merged.

Branch `claude/phase2-task10-drawings` (from `main` @ `1bf4719`). One PR, six commits:

| SHA | Increment |
|---|---|
| `449e4ba` | read-encapsulate drawings behind its query contract + the rebuildable projection (`drawings.inbox`) |
| `2aa1ff9` | contract test + live-PG projection & isolation suites (projection == live == rebuild; project/org/authz/recipient isolation) |
| `187fe43` | drawings commands onto the CommandExecution idempotency ledger (issue/publish/acknowledge/setNode/remove) |
| `f59dc58` | the module-owned frontend query under XOR + honest load states + write-ahead keyed acknowledge |
| `973e20c` | API-backed browser lifecycle e2e (moduleQuery) + `E2E_DRAWINGS_READ` runner wiring |
| `ebfec2b` | align the full API battery with the extraction (empty-batch dispatch guard; delivery-count pin; activities test DI) |

---

## Vision alignment

One project is one site; the controlled-drawing register is a **project operational record** that never
becomes global. Extraction adds no new owner: `drawing`/`drawingRevision`/`drawingRecipient`/`drawingAck`
stay owned by the `drawings` module — no other module reads their persistence any more (the boundary check
enforces it), and every cross-module read goes through the module's query contract. **Human approvals are
preserved and attributable**: a `drawing.acknowledged` fact is one `DrawingAck` row per `(revisionId,
userId)`, audited with the actor's real identity, announced exactly once. The projection is a
**rebuildable read model, never a new source of truth** — its rows derive from canonical drawing state and
are dropped/rebuilt at will. The migration is additive and forward-only; tenant isolation stays
database-enforced (the existing composite FKs on the drawing models); the read cutover is
capability-versioned so the old path keeps working until the flag flips.

**The per-viewer wrinkle (the review-relevant nuance).** Unlike daily-log (every viewer sees the same
log), the drawing register is **per-viewer**: a draft is visible only to its author; `ackedByMe` and
`recipientOfCurrent` depend on the caller; and each revision's `url` is a **time-limited signed token**
(`exp = now + TTL`) that cannot be persisted. So the projection stores a **viewer/signer-INDEPENDENT
base** (revisions without url; the governing revision's frozen recipient/ack user-id sets; the author id),
and the per-viewer fields + a fresh signed url are **baked at read time** for the caller. The projection
therefore cannot leak another viewer's visibility — it can only ever bake what the live path bakes.

---

## 1. The contract + read-encapsulation (`449e4ba`)

**The module is reachable only through its shared contract + its `drawing.*` events.**
`packages/shared/src/contracts/drawings.ts` declares `DRAWINGS_COMMANDS` (`drawings.issue`/`publish`/
`presign`/`acknowledge`/`setNode`/`remove`) and `DRAWINGS_QUERIES` (`drawings.snapshotSlice`/
`projectionSlice`/`existsInProject`/`resolveRef`) plus the ONE shared `DrawingsModuleResult` both sides
import (the register + `source` + `generation`).

**`DrawingsQueryService` is the sole read boundary.** Every cross-module drawing read moves onto it:
- the snapshot's drawings slice — moved VERBATIM (the exact per-viewer shaping lifted from
  `snapshot.service.ts`), so the snapshot stays byte-identical;
- the **activities readiness gate** — `activities.service.loadReadiness` no longer does a direct
  `db.drawing.findMany`; it calls `drawingsQuery.readinessSlice(projectId, {activityId, tx})` INSIDE the
  start command's transaction (read-encapsulation preserved under the lock);
- reference-ownership checks (`existsInProject`/`resolveRefInProject`).

The manifest gains `ownsModels`/`readEncapsulated` = `['drawing','drawingRevision','drawingRecipient',
'drawingAck','drawingsProjection']`; `activities` declares `dependsOn: ['decisions','drawings']`. The
boundary CI check emits a `cross-module-read` finding for any foreign `find*/count/aggregate` on a
read-encapsulated drawing model — none remain.

## 2. The rebuildable projection with per-viewer baking (`449e4ba`, proven `2aa1ff9`)

**Per-PROJECT read model** (`drawings.inbox`). A generation holds **ONE `DrawingsProjection` row per
project**, keyed `(generationId, projectId)`, storing the serialized viewer-independent BASE.

- `drawings-serialize.ts` splits the read into `computeDrawingsBase(client, projectId)` (viewer/signer
  independent: revisions without url; `governing: {revId, frozen, ackUserIds, recipientUserIds}|null`;
  `authorId`) and `bakeDrawings(base, {userId, drawingUrl})` (filters drafts to the author; mints a fresh
  signed `url = drawingUrl(r.id)`; computes `ackedByMe`/`recipientOfCurrent`). The SAME base+bake is used
  by the live `snapshotSlice` AND the projection consumer — so **projection == live by construction**.
- The `drawings.inbox` ordered `db` projection consumer subscribes to `drawing.*`; on each it refreshes
  the project's single row's base from CANONICAL state. Every other event is a `noop` that still advances
  the ordered cursor contiguously. Rebuild hooks: `rebuildSeed` + `dropGeneration`. It reuses the shared
  `ProjectionGeneration` table, `dispatchProjection`, `lockActiveGeneration`, the `ProjectionRebuilder` +
  final-activation barrier, and `readServableGeneration`'s servability gate unchanged (registered in
  `outbox.bootstrap.ts`).
- `moduleDrawings(projectId, userId)` serves the projection base **baked for the caller**, with a **live
  fallback** while the projection warms up (finding-1 servability gate → `source:'live'`, `generation:
  null`). `GET /projects/:projectId/drawings` exposes it under `project.read`.
- Additive migration `20261104000000_phase2_drawings_projection` (pure `CREATE TABLE`, writes no rows).

## 3. Idempotent commands on the CommandExecution ledger (`187fe43`)

Every drawing command routes through `executeCommand(prisma, {scope, actor, commandType,
idempotencyKey, requestHash, run})` (Task 5): a keyed retry (a network retry / the offline write-ahead
replay) replays the SAME success; the SAME key with a DIFFERENT payload is a `409`; the receipt is
ACTOR-scoped; an UNKEYED command keeps working (additive rollout). Per the resolved contract, **payload
dedup is NOT used** — two legitimately-distinct issues are two records; only a same-key replay collapses.
The `issue` request hash excludes the base64 file bytes (uses `dataLen` only). Domain-level idempotency is
preserved alongside ledger idempotency: a same-user re-acknowledge (existing `(revisionId,userId)` row)
records nothing new and — per `ebfec2b` — **announces nothing** (the dispatch is guarded on a non-empty
committed batch across all five command sites).

## 4. The module-owned frontend query under XOR + write-ahead acknowledge (`f59dc58`)

Mirrors the Module-1 daily-log cutover. `drawingsReadMode()` reads `VITE_DRAWINGS_READ` (default
`'snapshot'` — the snapshot slice owns `s.drawings`, unchanged). `'moduleQuery'` flips ownership to
`gateway.drawings()` (`ModuleDrawings`), fetched **under the SAME snapshot scope lease** (`Promise.all`
in `requestFreshSnapshot`, inheriting the identical scope/newest-owner ordering checks in
`acceptSnapshot`); a failure yields `null` → an explicit `drawingsLoad='error'` that keeps the last-good
register. `drawingsLoad`/`drawingsSource` are torn down on every scope change (switch / re-auth /
sign-out) via `emptyModuleReadState()`.

- **Honest load states** (finding-4 discipline): the DrawingsScreen shows loading / an unavailable+Retry
  boundary / a stale-banner+paused-actions instead of a fabricated "No drawings issued yet"; Issue +
  acknowledge are locked until the module read settles.
- **Write-ahead keyed acknowledge** (finding-1 discipline): the acknowledge op + its stable idempotency
  key are persisted to the durable outbox BEFORE any network call (online too), so a lost/uncertain
  response replays under the SAME key and the ledger records the ack exactly once. `issue`/`publish`/
  `setNode` carry keys on their direct calls.

---

## Behavior-preservation evidence

- **Snapshot byte-identical.** The Task-1 per-role snapshot-shape characterization is green unchanged; the
  drawing reads route through the query service with the per-viewer serialization moved verbatim.
- **projection == live == rebuild.** `test/integration/drawings-projection.test.ts` (live PG): the baked
  projection register is byte-identical to the live baked register (`stripUrls` compares the signer-
  independent base); live == rebuild; the finding-1 servability fallbacks; the HTTP module read serves.
- **Isolation.** `test/integration/drawings-isolation.test.ts` (live PG): cross-project / cross-org /
  removed-membership all `403`; **recipient isolation is baked per-viewer from ONE projection row**;
  rebuild-while-writing; a legacy pre-projection project upgrades via its first drawing event.
- **Idempotency.** `test/integration/drawings-idempotency.test.ts` (live PG): same-key issue applies
  exactly once and replays the same ids; same-key + different-payload is a `409`; two distinct issues are
  two records; acknowledge replay is exactly-once and ACTOR-scoped; publish replay; an unkeyed command
  still works.
- **Frontend XOR.** `apps/web/tests/drawings-module-query.test.ts` (snapshot vs moduleQuery ownership;
  live fallback; failed read keeps last-good; project-switch stale-response protection; post-command
  module reconcile) and `drawings-load-states.test.tsx` (loading / unavailable+Retry / stale-banner /
  honest empty; Issue+ack locking; scope-change teardown).
- **Browser lifecycle (real stack).** `apps/web/tests/e2e-api/drawings-module-query.spec.ts` (NestJS +
  PostgreSQL + web, moduleQuery): the register is served by the module-owned GET; **acknowledge** carries
  an `Idempotency-Key` and the module read reconciles to the "building to Rev A" confirmation; **issue**
  carries an `Idempotency-Key` and the new register entry surfaces. `E2E_DRAWINGS_READ` is forwarded to
  `VITE_DRAWINGS_READ` (default `snapshot`); `test:e2e:api:drawings[:outbox]` scripts added.
- **Contract pinned.** `drawings.contract.test.ts`: manifest commands/queries EQUAL the shared contract;
  `readEncapsulated === ownsModels`; the events are exactly the controlled-drawing lifecycle events; the
  query service implements every declared query; every command accepts the idempotency key as its trailing
  argument; the API `moduleDrawings` return conforms to the ONE shared `DrawingsModuleResult`.
- **Boundary + graph.** `boundary.test.ts` (DMMF ownership includes `drawingsProjection`; no cross-module
  drawing read) green. The `project.created` delivery count rose **4 → 5** (a `drawings.inbox` projection
  noop now materializes alongside socket/push/decisions.inbox/daily-log.inbox) — pin updated in
  `project-initialization-atomicity.test.ts`.

## Deliberate scoping (flagged for the reviewer)

- **`issue` is NOT write-ahead persisted.** The issue command carries a large base64 file payload, so it
  is a direct keyed call (a network-layer retry reuses the key), not persisted to the durable outbox like
  the small field commands (acknowledge). Automatic retries reuse the command's key; a fresh user-initiated
  issue mints a fresh key (two distinct issues = two records, by design).
- **No shell count for drawings.** Drawings has no analogous pending-count nav badge, so `shellSummary` is
  unchanged. The module read is the frontend surface.
- **Cross-cutting projections (Inbox/Dashboard/Portfolio) are NOT in this PR.** They complete in the
  Task-10 finalize step after all four modules; this PR delivers the drawings module's OWN projection only.
- **Three battery-alignment fixes (`ebfec2b`) surfaced by the FULL battery**, all consequences of the
  extraction the backend-only pass missed: (1) never dispatch an empty committed batch (a duplicate unkeyed
  acknowledge returned `events:[]` but still called `dispatchCommitted([])`); (2) the `project.created`
  delivery-count pin 4 → 5; (3) `activities.service.test` now constructs a real `DrawingsQueryService` in
  the shifted constructor position (the readiness gate reads through the query).

---

## Verification (all green)

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + test + build, web + api) | **exit 0** |
| API unit suite | **556 passed** |
| Web unit suite | **359 passed** |
| Full integration suite (live PostgreSQL) | **304 passed** |
| `drawings-projection` + `drawings-isolation` + `drawings-idempotency` (live PG) | **22 passed** |
| `apps/api/scripts/upgrade-proof.sh` (all migrations over the legacy fixture) | **PASSED** |
| `pnpm test:e2e:api:drawings` (API + relay boot, controlled-drawing browser lifecycle — moduleQuery) | **2 passed** |

_(CI runs the API e2e in both `legacy` and `outbox` sender modes; this extraction touches neither sender
path. Local acceptance ran in `legacy` mode.)_

**HELD for review — do not merge.** Per the one-module-per-PR review stop, the inspections module (module
3) does not start until this module's contract, boundary, tenant, projection, idempotency and browser
evidence clears Codex review.
