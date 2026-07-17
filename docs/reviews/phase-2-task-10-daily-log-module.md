# Phase 2 Task 10 — Module 1: the DAILY-LOG module extraction — Review Packet

**Review stop (one module per PR).** Task 10 extracts the remaining modules ONE PR each, with a review
stop between them. This is **module 1 of 4: `daily-log`** — chosen first as the least-entangled remaining
module (its only cross-module reader is media's linked-`dailyLogId` check; no inbound writes). It is
extracted behind its **shared contract**, its **read-encapsulated persistence**, its **rebuildable
projection**, and its **module-owned frontend query under XOR** — the exact pattern Task 8 (decisions
contract/read-encapsulation) and Task 9 (decisions projection + frontend cutover) established, now
repeated for daily-log. The consolidated Phase-2 review packet is produced only after all four modules
(daily-log → drawings → inspections → activities) are merged.

Branch `claude/phase2-task10-daily-log` (from `main` @ `70b224e`, the PR #168 merge). One PR, three
commits:

| SHA | Increment |
|---|---|
| `3a44343` | read-encapsulate daily-log behind its query contract |
| `c9432d9` | the rebuildable read-model projection (`daily-log.inbox`) |
| `b98f4cc` | the module-owned frontend query under XOR |

---

## Vision alignment

One project is one site; the daily-log slice (attendance, crew, materials, progress) is a **project
operational record** that never becomes global. Extraction adds no new owner: `dailyLog`/`crewRow`/
`siteMaterial` stay owned by the `daily-log` module — no other module reads their persistence any more
(the boundary check enforces it), and every cross-module read goes through the module's query contract.
The projection is a **rebuildable read model, never a new source of truth** — its rows derive from the
canonical daily-log state and are dropped/rebuilt at will. Unlike decisions, the daily-log slice carries
**no per-viewer visibility** (every project viewer sees the same daily log), so the projection has no
authz rule to preserve or bypass — it can only ever show what the live path shows. The audit trail, the
`DomainEvent` history, the outbox deliveries and receipts are untouched — the projection is layered
additively. The migration is additive and forward-only; tenant isolation stays database-enforced (the
existing composite FKs on `siteMaterial`); the read cutover is capability-versioned so the old path keeps
working until the flag flips.

---

## 1. The contract + read-encapsulation (`3a44343`)

**The module is reachable only through its shared contract + its events.** `packages/shared/src/contracts/
daily-log.ts` declares `DAILY_LOG_COMMANDS` (`daily-log.start`/`addMaterial`/`flagMismatch`/`submit`) and
`DAILY_LOG_QUERIES` (`daily-log.snapshotSlice`/`projectionSlice`/`existsInProject`/`resolveRef`) plus the
command-input and query-I/O data types both sides import.

**`DailyLogQueryService` is the sole read boundary.** Every cross-module daily-log read moves onto it:
- the snapshot's daily-log slice (latest log core + project-wide materials) — moved VERBATIM via the one
  canonical serializer, so the snapshot stays byte-identical;
- media's linked-`dailyLogId` tenant-ownership check (`resolveRefInProject`), replacing the dropped
  `resolveProjectRef('dailyLog', …)` case in `common/project-ref.ts`.

The manifest gains `readEncapsulated: ['dailyLog','crewRow','siteMaterial','dailyLogProjection']`; media
declares `dependsOn: ['decisions','daily-log']`. The boundary CI check emits a `cross-module-read` finding
for any foreign `find*/count/aggregate` on a read-encapsulated daily-log model — none remain.

**The media-photo wrinkle (deliberate).** The `dailyLog` DTO is a COMPOSITE: log/crew/materials are
daily-log-owned, but `photos` are progress MEDIA (signed at build time). The read-encapsulation covers
log/crew/materials only; the snapshot keeps composing `photos: progressPhotos` from media onto the core.
So the module's `DailyLogCore = Omit<DailyLogDto, 'photos'>`.

## 2. The rebuildable projection (`c9432d9`)

**Per-PROJECT read model** (`daily-log.inbox`). Unlike decisions (one row per decision), the daily-log
slice is a per-project composite, so a generation holds **ONE `DailyLogProjection` row per project**,
keyed `(generationId, projectId)`, storing the whole serialized `{ dailyLog, materials }` slice.

- `daily-log-serialize.ts` (`computeDailyLogSlice`) is the ONE serializer shared by the live
  `snapshotSlice` AND the projection consumer — so **projection == live by construction**.
- The `daily-log.inbox` ordered `db` projection consumer subscribes to `dailylog.*`/`material.*`; on each
  it refreshes the project's single row from CANONICAL state (a same-module read). Every other event is a
  `noop` that still advances the ordered cursor contiguously. Rebuild hooks: `rebuildSeed` (read max
  position first, then the slice — no gap) + `dropGeneration`. It reuses the shared `ProjectionGeneration`
  table, the relay's `dispatchProjection`, `lockActiveGeneration`, and the `ProjectionRebuilder` +
  final-activation-barrier unchanged (registered in `outbox.bootstrap.ts`).
- `projectionSlice` serves the active generation's row (the empty slice when no row yet — a project with
  no daily log — matching live); `moduleDailyLog` serves the projection with a **live fallback** while it
  warms up. `GET /projects/:projectId/daily-log` exposes it.
- Additive migration `20261103000000_phase2_daily_log_projection` (pure `CREATE TABLE`, writes no rows).

## 3. The module-owned frontend query under XOR (`b98f4cc`)

Mirrors the Task-9 decisions cutover. `dailyLogReadMode()` reads `VITE_DAILYLOG_READ` (default
`'snapshot'` — the snapshot slice owns `dailyLog` + `materials`, unchanged). `'moduleQuery'` flips
ownership to `gateway.dailyLog()` (`ModuleDailyLog`), fetched **under the SAME snapshot scope lease**
(`Promise.all` in `requestFreshSnapshot`, so it inherits the identical scope/newest-owner ordering checks
in `acceptSnapshot`); a failure yields `null` → an explicit `dailyLogLoad='error'` that keeps the
last-good slice, never failing the whole pull. The media progress **photos are composed from the snapshot
in BOTH modes** (media owns them), so only the log core + materials switch ownership.

---

## Behavior-preservation evidence

- **Snapshot byte-identical.** `phase2-snapshot-shape.test.ts` (the Task-1 per-role characterization) is
  green unchanged; the daily-log reads route through the query service with the serialization moved
  verbatim.
- **projection == live == rebuild.** `test/integration/daily-log-projection.test.ts` (live PG): the
  projection slice equals the live snapshot slice; the empty slice matches; a rebuild activates a new
  generation at the barrier position H whose slice matches live; two projects are isolated; the HTTP
  module read serves (live fallback).
- **Frontend XOR.** `apps/web/tests/daily-log-module-query.test.ts`: snapshot mode owns the slice with no
  module fetch; moduleQuery mode's module read owns the core + materials while photos stay
  snapshot-composed; a failed module read exposes error + keeps last-good; manifest-driven nav hides the
  daily-log screen when its module is disabled.
- **Contract pinned.** `daily-log.contract.test.ts`: manifest commands/queries EQUAL the shared contract;
  `readEncapsulated === ownsModels`; the events are exactly the four daily-log lifecycle events; the query
  service implements every declared query.
- **Boundary + graph.** `boundary.test.ts` (DMMF ownership totals `dailyLogProjection`; no cross-module
  daily-log read) and `cross-module-graph.test.ts` green. The `project.created` delivery count rose 3 → 4
  (a `daily-log.inbox` projection noop now materializes) — pin updated in
  `project-initialization-atomicity.test.ts`.

## Deliberate scoping (flagged for the reviewer)

- **No shell count for daily-log.** Decisions drives a `pendingDecisions` nav badge from its projection;
  daily-log has no analogous pending-count semantics, so `shellSummary` is unchanged. The module read is
  the frontend surface.
- **Cross-cutting projections (Inbox/Dashboard/Portfolio) are NOT in this PR.** Plan Task 10 Step 3
  completes those in the finalize step after all four modules; this PR delivers the daily-log module's OWN
  projection only.
- **Command idempotency keys.** The daily-log commands do not yet carry a Task-5 idempotency key (their
  POST handlers take none) — unchanged by this extraction; the command-inventory migration is tracked for
  the Task-10 final gate, not this module.

---

## Verification (all green)

| Gate | Result |
|---|---|
| `pnpm check` (lint + typecheck + test + build, web + api) | **exit 0** |
| API unit suite | **548 passed** |
| Web unit suite | **308 passed** |
| Full integration suite (live PostgreSQL) | **261 passed** |
| `daily-log-projection.test.ts` (live PG) | **5 passed** |
| `apps/api/scripts/upgrade-proof.sh` (all migrations over the legacy fixture) | **PASSED** |
| `pnpm test:e2e:api` (API + relay boot, browser flows — legacy mode) | **20 passed** |

_(CI runs the API e2e in both `legacy` and `outbox` sender modes; this extraction touches neither sender
path.)_

**HELD for review — do not merge.** Per the one-module-per-PR review stop, the drawings module (module 2)
does not start until this module's contract, boundary, tenant, projection and browser evidence clears
review.
