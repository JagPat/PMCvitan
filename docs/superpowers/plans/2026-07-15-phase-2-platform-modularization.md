# Phase 2 — Platform Modularization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Do not begin Task 1 until the independent Codex review of THIS PLAN clears.**

**Goal:** Give the existing modules (activities, decisions, drawings, inspections, daily-log) explicit ownership, typed command/query contracts, a canonical audit/event envelope, transactional-outbox delivery, asynchronous idempotent consumers, rebuildable projections and module-owned frontend state — **without changing any working user flow** — so the Materials (Phase 3), Labour (Phase 4) and Commercial (Phase 5) modules can later attach to stable connectors and dependable facts instead of restructuring the application each time.

**Architecture:** Preserve the single deployable NestJS/Prisma/PostgreSQL + React/Zustand modular monolith. Phase 2 introduces the *internal* module-boundary machinery the canonical spec §§6–9 describe — a runtime-importable shared contract package, a compile-time module registry with per-module manifests, a standard `DomainEvent` envelope, a server-side transactional outbox with an in-process relay + idempotent consumers, a projection framework feeding Inbox/Dashboard/Portfolio, and module-owned frontend query boundaries replacing the single store + full snapshot. **It does not split the application into separate services** (spec §22: "Core transactional modules remain together until load or team ownership justifies separation"), and it adds no Phase 3+ business capability. Existing modules are extracted **incrementally**; each extraction preserves observable behavior, proven by characterization tests written first.

**Tech Stack:** pnpm workspace, React 19, Zustand 5, Vitest 4, Playwright 1.61, NestJS 11, Prisma 6, PostgreSQL 16, TypeScript. Phase 2 additions (pilot-scale, per spec §22): the outbox **relay runs in-process** as a NestJS lifecycle poller using a `FOR UPDATE SKIP LOCKED` claim, so the design is safe to run later as a separate worker or across multiple instances without a rewrite; **Redis is optional** and used only where the spec requires shared coordination (relay leadership / OTP / rate-limit), stubbed to an in-process adapter in the demo and single-instance deploy — the same provider-seam pattern the codebase already uses for OTP/media/storage (`apps/api/src/auth/sms.service.ts`, `apps/api/src/media/storage.service.ts`). No new external service becomes a hard dependency of the running product this phase.

**Planning baseline:** `main` at `cff18c4` (Phase 1 gate cleared — the independent review issued **GREEN SIGNAL — READY FOR INTERNAL LIVE DEPLOYMENT**, effective runtime head `302b24a`, recorded on [PR #144](https://github.com/JagPat/PMCvitan/pull/144#issuecomment-4977218191)). This plan implements the canonical spec's **Phase 2** row (§§6–9, §17, §19–21) only.

---

## Phase Intent (restated per the canonical spec's Phase Intent Map, row 2)

Continued growth inside one Zustand store, one full-project snapshot and direct cross-module service calls will make every new capability (materials, labour, commercial) harder to add safely. Phase 2 exists so the existing modules gain explicit ownership, commands, events, outbox delivery, projections and independently testable boundaries **while remaining one deployable application**. It consumes the Phase 0 facts (trustworthy project identity, live authorization, same-project references, real civil dates) and the Phase 1 facts (locked/re-approved specifications, governing drawing revisions with acknowledged recipients, evidence-backed inspection outcomes linked to the work they accept, completion that means "accepted") and produces the facts Phase 3+ need: **stable connectors** — published domain events with a versioned envelope, queryable module contracts, and rebuildable read-model projections — so that Materials/Labour/Commercial subscribe to "decision approved", "inspection passed", "activity ready" instead of joining another module's tables.

At phase completion this plan must identify the canonical facts and events unlocked for Phase 3 (the Material Readiness pilot): the `decision.reapproved`, `drawing.issued`, `inspection.decided`, `activity.readiness_changed` and `activity.completed` events, each carrying the envelope Phase 3's requirement/requisition consumers bind to.

## Current-State Revalidation (against `main` @ `cff18c4`)

Every Phase 2 concept was revalidated against current code before this plan was written (three read-only reconnaissance passes over `apps/api`, `apps/web`, `packages/shared` + CI). Verdicts: **COMPLETE** (works and is pinned by tests), **PARTIAL** (exists with material gaps), **INCORRECT** (exists but violates the target), **ABSENT** (does not exist). The headline is that the Phase 2 boundary machinery is **essentially greenfield** — the application is one flat module with direct cross-module coupling — so the risk is not building new plumbing but **not breaking the working flows while the plumbing is inserted**.

### Backend module boundaries (`apps/api`)

| Concept | Verdict | Evidence |
|---|---|---|
| NestJS feature modules / encapsulation | ABSENT | One flat `AppModule` (`apps/api/src/app.module.ts:46-102`) registers **15 controllers + 24 providers**; only `PrismaModule` is separate. "Modules" today = directory grouping, not encapsulated Nest modules. |
| Cross-module calls via contracts/events | ABSENT (calls are DIRECT) | `SnapshotService` and `RealtimeGateway` are each injected into the 8 mutating services (constructors e.g. `decisions.service.ts:17-21`, `activities.service.ts:21-26`); cross-domain writes go straight through the shared `PrismaService` — `activities.service.ts:302` (`tx.inspection.create` — completing an activity creates a closing Inspection directly, bypassing `InspectionsService`), `inspections.service.ts:169` (`tx.activity.updateMany` — approving a closing inspection writes `Activity.status='done'` directly), `nodes.service.ts:99-103` (a node delete nulls FKs across activity/inspection/media/drawing/siteMaterial), `orgs.service.ts` `createProject` (writes `projectNode`/`phase`/`activity`/`inspection` rows directly). No inter-module contract layer exists (`apps/api/src/contracts.ts` is HTTP request-validation only). |
| Audit envelope + shared writer | PARTIAL | `AuditLog` model exists with a real `actorId` column (`prisma/schema.prisma:785-796`, `actorId` `:789`), but writes are ~20 ad-hoc inline `.create` calls (`decisions.service.ts:70,94,170,200,244`; `activities.service.ts:100,145,165,251,325,358,378`; `drawings.service.ts:212,269,286,317,360`; `daily-log.service.ts:46,66,88,103`; `phases.service.ts:45,58`; `inspections.service.ts:58,121,180,183,287,290`) with **two coexisting conventions** — newer sites use `resolveActor()` (`common/actor.ts:21-28`, real `{actorId,actorName,actorRole}`), older sites still pass `actor: user.role` with no `actorId` (e.g. `activities.service.ts:100,145,165,251`, all of `phases`/`daily-log`). **No shared audit helper/interceptor and no audit READ API** (no controller references `auditLog`). |
| Domain-event envelope + bus | ABSENT | No events table, event bus, `@nestjs/event-emitter`, or `DomainEvent` type; no `eventId`/`eventType`/`payloadVersion`/`correlationId`/`causedByEventId` anywhere. The only "events" are per-entity `DecisionEvent` append rows (`schema.prisma:517-528`, decisions only) and the **content-free** realtime `changed` socket ping — `realtime.gateway.ts:38` emits `{projectId}` "go refetch", from 30 call sites; it is a signal, not a domain event. |
| Server-side transactional outbox | ABSENT | No outbox table/relay/worker; the sole "outbox" mention is a comment about the *frontend* offline queue (`drawings.service.ts:298`). |
| Background worker / scheduled jobs | ABSENT | No `@nestjs/schedule`/`bull`/`bullmq`/`ioredis`/`@Cron`/`Queue`/`setInterval` (none in `apps/api/package.json`); bare `main.ts` bootstrap; throttling is in-memory per-IP, explicitly not Redis (`common/throttle.ts:26`). |
| Projection framework / read models | ABSENT (one live-join snapshot) | The entire read path is `GET /projects/:id/snapshot` → `SnapshotService.build()` (`snapshot/project.controller.ts:14-18`), **453 lines, one method**: a 13-way `Promise.all` of live `findMany` joins (`snapshot.service.ts:34-91`) + in-memory RBAC filtering + readiness derivation; **every mutation rebuilds it live** and returns it. No checkpointed/rebuildable read model. |
| Module registry / manifest / per-org enablement | ABSENT | No `ModuleInstallation`, registry, capability manifest, or feature enablement. The `TemplateModule`/`ProjectTemplate` models (`schema.prisma:123-159`) are org-owned **content presets** (structure payloads instantiated at project creation), version fields "informational in v1" — unrelated to platform modularization. |
| Command idempotency key + optimistic version | PARTIAL | Only **Media** upload is idempotent — project-scoped `clientKey` `@@unique([projectId, clientKey])` (`schema.prisma:261,267`, `media.service.ts:37-99`). No idempotency key on decision/inspection/activity/drawing/daily-log commands; **no optimistic `version` column** on any state entity (the only `version` fields are the informational template ones). Concurrency is handled by CAS-guarded `updateMany` + `count===0` conflict + partial unique indexes + `FOR UPDATE` locks (e.g. `decisions.service.ts:130,191,230`; `inspections.service.ts:116,160,169,248`; `activities.service.ts:241,282-289`) — robust, but not a version scheme. |

### Shared contracts, build & CI (`packages/shared`, tooling)

| Concept | Verdict | Evidence |
|---|---|---|
| Shared domain layer usable by the API at runtime | ABSENT (source-only package) | `@vitan/shared` is source-only ESM with **no build step** (`packages/shared/package.json:7-11`, exports raw `./src/*`). Web consumes it via Vite alias + tsconfig paths (`apps/web/vite.config.ts:10`, `tsconfig.app.json:20-24`) — 34+ files. **The API does not import it at all** ("the API cannot import this source-only ESM package", `packages/shared/src/domain/readiness.ts:8-9`, `policy.ts:10-12`). **This single fact forces the mirrored-literals convention and blocks a shared contract/event layer — it is the pivotal Phase 2 enabler.** |
| Mirrored-literals convention (drift-guarded) | COMPLETE (and load-bearing) | Four source-only mirror pairs, each drift-tested because the API can't import shared: readiness (`packages/shared/src/domain/readiness.ts` ↔ `apps/api/src/domain/transitions.ts`, pinned by `apps/api/src/domain/transitions.test.ts` + `apps/web/tests/readiness.test.ts`), authorization (`policy.ts` `ROLE_POLICY` ↔ `@Roles` decorators, pinned by `apps/api/src/common/route-policy.test.ts:141-207` `EXPECTED_ROLES`), seed (`domain/seed.ts` ↔ `apps/api/src/domain/seed-data.ts`, pinned by `seed-data.test.ts`), civil-date (`lib/dates.ts` ↔ `apps/api/src/common/civil-date.ts`). Every mirror note states the intended exit: "once it's promoted to a built package the API should … straight from this map and the duplication disappears" (`policy.ts:11-14`, `route-policy.test.ts:146-147`, `dates.ts:28-29`). |
| Command/query contracts (shared, ts-rest) | PARTIAL / ABSENT | Real Zod **request** schemas exist but per-app in the API (`apps/api/src/contracts.ts`, 595 lines: `approveSchema`, `submitInspectionSchema`, `issueDrawingSchema`, `createProjectSchema`, …); **response/query** shapes are hand-written DTO interfaces (`apps/api/src/snapshot/types.ts`), structurally duplicated from the web types, not shared and not runtime-validated. **ts-rest was never built** (only prose in `docs/ARCHITECTURE.md:52`, `DATA_MODEL.md:139`). |
| Shared event contracts | ABSENT | No event-type union or envelope schema anywhere in `packages/shared`. |
| Monorepo build orchestration | PARTIAL | pnpm workspaces cover `apps/*` + `packages/*` (`pnpm-workspace.yaml`); **no Turborepo, no `tsconfig.base.json`, no root tsconfig**, and `packages/shared` is unbuilt — no dependency-graph tooling for module extraction. `pnpm check` = `check:web` (lint+typecheck+test+build) `&&` `check:api` (prisma:generate+typecheck+test+build); it does **not** run the integration suite (CI-only). |
| CI: start PG, migrate from zero, boot API, run browser flows | COMPLETE | `.github/workflows/ci.yml` — 5 jobs: `web`, `e2e` (demo Playwright), `api-e2e` (postgres:16, migrate+seed+compiled-API boot `node dist/main.js` + API-backed Playwright), `upgrade-proof` (postgres:16, all migrations from `0_init` over a planted legacy fixture — `apps/api/scripts/upgrade-proof.sh`, whose header says **"Phase 2 should extend the fixture rather than widen the migration range here"** `:29-30`), `api` (postgres:16, `prisma:migrate` + integration suite + typecheck + build). Gap for Phase 2 to note: jobs are coarse whole-app filters — no per-module sharding or build cache. |

### Frontend state boundaries (`apps/web`)

| Concept | Verdict | Evidence |
|---|---|---|
| Module-owned store slices | ABSENT (one monolith) | `store.ts` is **2801 lines**, one `create<Store>()(immer(...))` (`store.ts:555`); flat `AppState` (`store.ts:145-229`) holds every domain's collections; `AppActions` is one bag of ~100 actions. No slice/`StateCreator` pattern. `projectScope.ts` enumerates the project collections for the scope-empty lifecycle (`ProjectDataState`, `projectScope.ts:36-53`) but that is a lifecycle helper, not an ownership split. |
| Full snapshot vs project-shell + paginated queries | ABSENT (one full snapshot) | Hydration is one `ApiSnapshot` carrying every collection (`apiGateway.ts:40-77`); `applySnapshotCore` (`store.ts:638-716`) replaces every project field wholesale in one `set()`; every mutation returns the full snapshot (`apiGateway.ts:562-571`); there is **no** paginated or per-module project query — `snapshot()` is the only project read. |
| Atomic-switch / stale-response guard (reusable seam) | COMPLETE | The snapshot-ordering coordinator (`store.ts:575-861`: `beginSnapshotLease` `:628`, `acceptSnapshot` `:726`, `requestFreshSnapshot` `:753`, `scheduleReconcile` `:822`, `scopeCoordinators` `:606`) — the Codex-gate-hardened piece — plus the `(projectId, generation)` scope lifecycle (`projectScope.ts`) are the **only reusable seams**; the per-module query layer (Task 8) must carry their guarantees. |
| Data seam (gateway) | PARTIAL | Two mismatched artifacts: an aspirational `DataGateway` interface explicitly "not wired into the components yet" (`data/gateway.ts:10-12,32-55`) and the real `ApiGateway` class (~50 typed methods, `apiGateway.ts:297-682`) that does not implement it. local-vs-api is env-flag based (`VITE_API_URL`, `apiGateway.ts:244`) — there is no `localGateway` class; the "local gateway" is the seeded store itself. `useApiSync.ts` injects the gateway + opens the socket and calls `requestFreshSnapshot()` on `changed`. |
| Manifest-driven navigation | ABSENT (static map) | Nav is a static role→screens literal — `SCREEN_META` (`lib/screens.ts:30-46`) + `screensFor(role)` (`screens.ts:49-63`) consumed by `useNavItems.ts:20`; authorization via `ROLE_POLICY`/`can()` (`policy.ts`). Adding a screen edits these literals; no module contributes routes/nav. |
| Inbox/Dashboard/Portfolio as projections | PARTIAL (pure selectors over the monolith) | Derived purely in `selectors.ts` (`selectActionItems` `:252-318` for the Inbox; dashboard counts `selectSchToday`/`selectPending`/`selectReviewPending`/`selectFailedCount` `:161-167,20,68,81`); Portfolio is fetched separately (`s.portfolio`, `ApiGateway.getPortfolio()` `apiGateway.ts:377`). Correct today, but coupled to the whole store — the read models Task 4 makes rebuildable. |

**Drift notice vs. older docs:** `docs/ARCHITECTURE.md:19,52` and `DATA_MODEL.md:139` still describe a "ts-rest + Zod contracts in `packages/shared`" API contract that was never built — request contracts live in `apps/api/src/contracts.ts` (Zod) and responses are DTO interfaces in `apps/api/src/snapshot/types.ts`. Phase 2 Task 2 makes that description true; until then the plan treats it as aspiration, not current state.

---

## Global Constraints

- Read `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md` first; it is the canonical product/architecture specification. This plan implements its **Phase 2** row only (§§6–9, §17, §19–21).
- **Preserve every working user flow.** Phase 2 is a refactor of internal structure, not of behavior. No screen the user relies on changes its observable outcome; the Phase 0 two-project acceptance suite (`apps/web/tests/e2e-api/project-scope.spec.ts`) and the Phase 1 pillar-chain acceptance suite (`apps/web/tests/e2e-api/pillar-chain.spec.ts`) must stay green **unchanged** through every task — they are the behavioral contract the extraction must not break. Any user-visible change requires explicit product approval and its own PR.
- **Characterization before extraction (spec §21).** The decision-change, inspection-reinspection, closing-signoff, project-switch and multi-tenant authorization paths — plus the exact current snapshot shape and the realtime `changed` signal — are pinned by characterization tests **before** any module is moved (Task 1). A refactor PR proves an intentional structural change, never an accidental behavioral one.
- **Module dependency rules (spec §6) are enforced, not aspirational.** Modules may depend on the platform kernel and other modules' **declared public contracts** only; a module must not import another module's persistence internals or write its tables; cyclic module dependencies are prohibited; synchronous cross-module calls are limited to queries/validations that must complete in the initiating transaction; all other cross-module consequences use domain events and idempotent consumers; reporting reads projections, never arbitrary transactional joins. A CI check (Task 6) fails the build when a boundary is violated, measured against the Task 1 call-graph baseline.
- **One canonical write path (spec §9).** Every state-changing command: validated → owning-module transaction → canonical record + audit entry → **transactional outbox event written in the same transaction** → asynchronous idempotent consumers → projections/Inbox/notifications. The outbox row and the canonical mutation commit or roll back together — no cross-module consequence is fire-and-forget from inside the request.
- **Every event carries the full envelope (spec §9):** `eventId, eventType, payloadVersion, organizationId, projectId, siteId?, actorId, entityId, occurredAt, correlationId, causedByEventId, payload`. Consumers record processed `eventId`s (idempotency); retries use backoff; exhausted failures enter an operator-visible dead-letter queue; projections expose rebuild status and regenerate from canonical records/events. This is **canonical state + append-only events, not event sourcing** — current state stays in normal relational tables (spec §9).
- **Idempotency & optimistic version on commands (spec §20).** Every state-changing command requires a client-generated idempotency key, project/actor scope, an explicit transition (the existing CAS pattern satisfies "optimistic version" where a `version` column is not added), an audit entry and a transactional event. Optimistic UI is used ONLY for retry-safe commands carrying idempotency keys (spec §19).
- **Additive migrations only; diagnostic-first** (abort on ambiguous legacy data — never guess); backfill and verify before enforcing constraints; never `prisma db push`. New migrations start at slot `20261015000000_phase2_*`. Every migration is proven against a fresh database AND a representative upgraded copy carrying pre-Phase-2 rows — **extend the `upgrade-proof.sh` fixture, do not widen its migration range** (per its own header, `apps/api/scripts/upgrade-proof.sh:29-30`).
- **Authorization is unchanged and still server-enforced (spec §18, §20).** Module manifests declare permissions/capabilities but manifests / `ModuleInstallation` **must not hide a missing authorization check** — every server route still enforces authorization; UI visibility stays convenience, never enforcement. The `ROLE_POLICY`/`EXPECTED_ROLES` drift guard (`route-policy.test.ts`) is preserved and extended per module.
- **Tenant isolation stays database-enforced.** Every event, outbox row, projection row and module-owned table carries `projectId` (and `organizationId` where the envelope needs it); cross-project isolation tests run against live PostgreSQL for every new table.
- **Frontend evolution keeps shell state atomic (spec §19).** Replacing the single store + full snapshot with module-owned queries + a project-shell summary must **preserve the Phase 0/1 atomic project-switch and stale-response guards** — the coordinator's scope-lease/supersession/bounded-reconcile invariants (`store.ts:575-861`) carry into the per-module query layer; a late module query can never paint the wrong project. Explicit loading/empty/offline/stale/error states; **never substitute demo records in API mode** (spec §19).
- **Out of scope (explicitly):** any Phase 3+ business capability (procurement, requisitions, vendor comparison, purchase orders; inventory/stock/reservations/issues; labour demand/attendance-to-readiness; commercial/budget/bills/payment); supplier/contractor portals and the full `Company`/`ProjectParty`/guest-company hybrid-tenancy split (spec §8 — that substrate belongs to Phase 6; Phase 2 keeps the existing `Org`/`OrgMembership`/`Membership` model and only aligns event-envelope vocabulary); RedBracket/accounting integrations (spec §23); runtime third-party plugins (spec §6 — designed "only after internal module contracts have proven stable"); extracting any module into its own deployable service (spec §22 — the outbox relay stays in-process; extraction on measured need is deferred); broad UI redesign; unrelated cleanup.

## Product Intent Claude Must Preserve

Before each PR, include a five-line vision-alignment statement with concrete values:

```text
User decision improved: <role> can <decision> because <fact chain> — UNCHANGED this phase; name the flow that stays identical.
Canonical fact owner: <module/record> — now behind its explicit contract.
Information flow: <source> -> <event/envelope> -> <consumers/projection>.
Human work removed: none this phase (structural); OR the automation the event now enables downstream.
Trust invariant: <what can no longer silently happen> — e.g. a cross-module consequence can no longer bypass audit/outbox.
```

Reject a design in self-review when it: changes a working user flow without product approval; lets a module read or write another module's tables directly; fires a cross-module consequence outside the transactional outbox; introduces an event without the full versioned envelope; stores a projection as an independently-editable source of truth rather than a rebuildable read model; or adds a manifest capability that substitutes for a real server-side authorization check.

## Required Execution Order and Review Stops

Tasks 1–9 in order; each task is one PR unless noted. **Review stops (wait for independent review before continuing): after Task 1, Task 4, Task 6 and Task 9.** The order follows the spec §9 write path (shared contracts → envelope → outbox → consumers → projections) before the boundary formalization (registry → contracts → extraction) and the frontend last, so each layer rests on a proven one.

```text
Task 1 (characterization baseline: snapshot shape, call graph, changed-signal, audit sites, Inbox/Dashboard/Portfolio outputs)  ⟵ REVIEW STOP
  -> Task 2 (promote @vitan/shared to a buildable runtime package; retire the mirrored-literals convention behind it)  [depends on 1]
  -> Task 3 (platform kernel: canonical AuditLog writer + DomainEvent envelope in shared + append-only event store)   [depends on 2]
  -> Task 4 (transactional outbox + in-process relay + idempotent consumers + dead-letter; migrate the notify fan-out) [depends on 3]  ⟵ REVIEW STOP
  -> Task 5 (projection framework; Inbox/Dashboard/Portfolio become rebuildable projections)                          [depends on 4]
  -> Task 6 (module registry + per-module manifests + boundary CI check)                                              [depends on 3,4,5]  ⟵ REVIEW STOP
  -> Task 7 (command/query contracts in shared; extract the FIRST module fully behind its contract)                   [depends on 6]
  -> Task 8 (module-owned frontend state: project-shell summary + paginated module queries + manifest-driven nav)     [depends on 6,7]
  -> Task 9 (extract remaining modules incrementally + modular acceptance suite + Phase 2 review packet)              [depends on all]  ⟵ REVIEW STOP
```

Review stops are placed where a wrong foundation would be expensive to unwind: after the characterization baseline (Task 1), after the write-path backbone (Task 4), after the boundary is formally declared and CI-enforced (Task 6), and at the final gate (Task 9).

## File Structure (primary touch points)

| File / dir | Responsibility |
|---|---|
| `apps/api/test/integration/phase2-characterization.test.ts` + `apps/web/tests/snapshot-shape.test.ts` | NEW — Task 1 characterization of the snapshot shape, cross-module call graph, per-mutation consequence set, and Inbox/Dashboard/Portfolio outputs. |
| `packages/shared/package.json` + `tsconfig` + build | Task 2 — add a build (tsup/tsc) so `@vitan/shared` is a runtime dependency the API imports; add it to `apps/api/package.json`. |
| `apps/api/src/domain/transitions.ts`, `common/civil-date.ts`, `domain/seed-data.ts`, `common/roles.ts` | Task 2 — retire the mirrored copies in favor of the built shared source once equivalence is proven; keep the drift tests until the single source is live. |
| `packages/shared/src/platform/events.ts` (NEW) | The `DomainEvent` envelope type + event-type registry + payload schemas (shared by api emit + web consume). |
| `apps/api/src/platform/{audit,events,outbox,registry}/` (NEW) | The platform kernel: `recordAudit()` writer, `emit()` event writer, `Outbox` relay + consumers + dead-letter, the module registry + manifest validator. |
| `apps/api/prisma/migrations/20261015*–2026103*` | One additive diagnostic-first migration per schema-changing task (`DomainEvent`, `Outbox`/`ProcessedEvent`/`DeadLetter`, projection tables), named per task. |
| `apps/api/src/**/{module}.manifest.ts` (NEW per module) | Per-module manifest (id/version/deps/capabilities/permissions/commands/queries/events/subscriptions/routes/projections/jobs/migrations/health). |
| `apps/api/src/snapshot/snapshot.service.ts` | Read via module queries + projections instead of a 13-way live join; a project-shell summary path. |
| `apps/api/src/realtime/realtime.gateway.ts` | The `changed` fan-out becomes an outbox consumer (Task 4). |
| `apps/web/src/store/*` + `apps/web/src/data/*` | Task 8 — module-owned query slices, project-shell summary, per-module queries carrying the coordinator's switch guarantees; retire the stale `data/gateway.ts` stub. |
| `apps/web/src/lib/screens.ts` + `layout/useNavItems.ts` | Task 8 — navigation generated from enabled-module manifests + effective permissions. |
| `apps/api/scripts/upgrade-proof.sh` | Extend the legacy fixture per Phase 2 tables (do not widen the migration range). |
| `.github/workflows/ci.yml` | Add the boundary check (Task 6), event-contract/projection-rebuild jobs (Tasks 3–5), worker boot in `api-e2e`. |
| `docs/reviews/phase-2-review-packet.md` | The independent review packet (Task 9). |
| `docs/{ARCHITECTURE,DATA_MODEL,TENANCY}.md` + `docs/ROADMAP.md` | Update per task (Phase 2 becomes implemented; the ts-rest description made true). |

---

## Task 1: Characterization Baseline for the Refactor Surface

**Business outcome:** Every structural boundary Phase 2 will introduce is pinned against today's observable behavior, so each extraction proves an intentional refactor rather than an accidental behavior change — and the revalidation table above stays true in CI.

**Canonical fact owner:** none (test-only task — no schema, no runtime change).

**Commands/events:** none added. Characterizes the CURRENT `GET /projects/:id/snapshot` shape per role, the direct cross-module call graph, the `changed` emission points, every audit write site, and the Inbox/Dashboard/Portfolio derivations.

- [ ] **Step 1: Record the baseline.** `git fetch origin && git rev-parse origin/main` (expect `cff18c4`), clean tree, `pnpm check` green, integration suite green, both acceptance suites green. Record SHAs in the PR.
- [ ] **Step 2: Snapshot-shape characterization** (`apps/web/tests/snapshot-shape.test.ts` + an API integration variant): serialize the seeded project's snapshot for each role and pin the exact top-level key set and per-key shape — the frontend↔API contract Task 8 may not silently break.
- [ ] **Step 3: Cross-module call-graph characterization** (a source-scan tripwire like `route-policy.test.ts`): enumerate today's direct cross-module service injections and cross-domain `PrismaService` writes (the `activities→inspection`, `inspections→activity`, `nodes→5 domains`, `orgs.createProject→*` sites from the revalidation table) and the 30 `changed` emit sites, so Task 6's boundary check has a documented, diffable starting point.
- [ ] **Step 4: Per-mutation consequence characterization** (live-PostgreSQL integration): pin, per pillar mutation, the full set of consequences it produces today (audit rows, notifications, gate recomputations, `changed` signal) — the exact set the outbox+consumers (Tasks 4–5) must reproduce, no more and no fewer.
- [ ] **Step 5: Inbox/Dashboard/Portfolio derivation characterization:** pin `selectActionItems`/dashboard-count/portfolio outputs for the seeded fixtures, so Task 5's projections are proven equivalent.
- [ ] **Step 6: Verify and commit.**

Run: `pnpm check` · full PostgreSQL integration suite · both acceptance suites (`api-e2e`).

**Tests:** as above (unit + integration + structural). **Rollback:** revert the PR (test-only). **Risks:** none beyond CI time.

**Done criteria:** all gates green; the snapshot shape, call graph, per-mutation consequence set, and Inbox/Dashboard/Portfolio outputs are each pinned by a test that will FAIL if a later task changes observable behavior, forcing an explicit reviewed update in the PR that changes it. **REVIEW STOP.**

## Task 2: Promote `@vitan/shared` to a Buildable Runtime Package (Retire the Mirrored-Literals Convention)

**Business outcome:** The API can import shared domain code at runtime, so the `DomainEvent` envelope, command/query contracts and readiness/policy logic have **one source of truth** consumed by both web and api — retiring the four hand-mirrored drift-tested copies that exist only because today's package is source-only. This is the enabling substrate for every later Phase 2 contract.

**Canonical fact owner:** `packages/shared` becomes the single runtime source for the four mirrored domains (readiness, policy, civil-date, seed) and, going forward, contracts/events.

**Commands/events:** none. Pure build/packaging + dependency change; behavior identical.

**Schema and migration:** none.

- [ ] **Step 1: Add a build** to `packages/shared` (tsc or tsup → ESM+CJS or the format the CommonJS API needs; the API is CommonJS per `apps/api/tsconfig.json`), a `main`/`exports`/`types` that resolves for both `apps/web` (keep the Vite alias for dev speed) and `apps/api` (a real workspace dependency in `apps/api/package.json`). Wire the build into `pnpm check`/CI ahead of api typecheck.
- [ ] **Step 2: Consume from the API, one mirror at a time, equivalence-guarded.** For each of civil-date, readiness (`transitions.ts`), policy (`@Roles`/`route-policy` `EXPECTED_ROLES`) and seed (`seed-data.ts`): switch the API to import the shared source, and **keep the existing drift test green until the import is live**, then convert the drift test into an "imported-identity" assertion (the API value IS the shared value) rather than a mirror comparison. Do civil-date first (smallest, purely functional), policy last (touches the route-authz guard).
- [ ] **Step 3: STOP condition.** If any consumer cannot import the built package at runtime (ESM/CJS interop, decorator-metadata, or Nest DI constraints), stop and record the blocker; do not delete a mirror until its shared import is proven in the integration suite. A half-retired mirror (deleted copy, unresolved import) is not acceptable.
- [ ] **Step 4: Docs.** Update `ARCHITECTURE.md`/`DATA_MODEL.md` so the "ts-rest + Zod in packages/shared" description becomes accurate about the now-built package (contracts land in Task 7).
- [ ] **Step 5: Verify.**

Run: `pnpm check` · full integration suite (real Nest boot proves the runtime import) · both acceptance suites · `upgrade-proof`.

**Tests:** the converted drift/identity tests; a boot test that the API loads shared at runtime. **Rollback:** revert to the alias + mirrors (kept in git until Task 3 builds on them). **Risks:** build-interop friction — mitigated by the one-mirror-at-a-time equivalence guard and doing the functional mirrors before the DI-coupled policy one.

**Done criteria:** the API imports `@vitan/shared` at runtime; each retired mirror is proven identical to its shared source by an imported-identity test; all gates green.

## Task 3: Platform Kernel — Canonical Audit Writer + Domain-Event Envelope

**Business outcome:** Every consequential state change writes one canonical audit entry and one append-only domain event with the full versioned envelope, so downstream modules and projections have a single ordered attributable source of "what happened" instead of ad-hoc per-entity rows and a content-free ping.

**Canonical fact owner:** `platform/audit` owns `AuditLog` (attribution) via one `recordAudit(tx, …)` writer; `platform/events` owns the append-only `DomainEvent` store (the envelope). Per-entity `DecisionEvent` rows remain the module's own lifecycle history; the `DomainEvent` store is the cross-module record. The envelope TYPE lives in `packages/shared/src/platform/events.ts` (importable by both sides, Task 2).

**Commands/events:** no user-facing command change. Introduces the `DomainEvent` envelope type + a kernel `emit(tx, event)` that writes the event row inside the caller's transaction, and routes the ~20 ad-hoc audit `.create` sites through one `recordAudit(tx, …)` (finishing the Phase 1 `actorId` migration for the older `actor: user.role` sites).

**Schema and migration** (`20261015000000_phase2_event_envelope`, additive, diagnostic-first): a `DomainEvent` table with the full envelope columns (`eventId` PK, `eventType`, `payloadVersion`, `organizationId?`, `projectId`, `siteId?`, `actorId?`, `entityType`, `entityId`, `occurredAt`, `correlationId`, `causedByEventId?`, `payload` JSONB) + indexes on `(projectId, occurredAt)` and `(eventType, occurredAt)`. Forward-only: no history backfill (events start now — documented). AuditLog unchanged structurally.

- [ ] **Step 1: Failing tests first** — envelope completeness (every field populated), same-transaction write (event rolls back with its mutation), correlation/causation threading, per-event-type payload schema + version.
- [ ] **Step 2: Envelope + schema** in shared + the migration.
- [ ] **Step 3: Kernel writers** — `recordAudit`, `emit`; route all audit sites through `recordAudit` (older sites gain `actorId`).
- [ ] **Step 4: Dual-write the four pillars' events** alongside existing consequences — existing behavior unchanged, events now ALSO recorded (`decision.reapproved`/`drawing.issued`/`inspection.decided`/`activity.completed`/`activity.readiness_changed`).
- [ ] **Step 5: STOP condition** — if any mutation cannot produce a complete envelope (missing actorId/entity), abort and surface it rather than emitting a partial event.
- [ ] **Step 6: Verify.**

Run: `pnpm check` · integration suite (envelope + same-transaction, live PG) · both acceptance suites unchanged · `upgrade-proof` (extended fixture).

**Done criteria:** every pillar mutation writes a complete correlated `DomainEvent` in the same transaction as its canonical write; all audit sites carry `actorId`; existing flows/tests unchanged; event-contract tests pin each type's payload schema and version.

## Task 4: Transactional Outbox + In-Process Relay + Idempotent Consumers

**Business outcome:** A committed state change reliably drives its downstream consequences even across a crash or restart — delivered at-least-once, processed exactly-once by idempotent consumers, retried with backoff, and surfaced to an operator when exhausted — instead of a best-effort in-request side effect.

**Canonical fact owner:** `platform/events` owns the `Outbox` table + relay; each consumer owns its `ProcessedEvent` idempotency record and its `DeadLetter` rows.

**Commands/events:** no user-facing change. `emit()` now ALSO writes an `Outbox` row in the same transaction; an in-process relay (NestJS lifecycle poller, `FOR UPDATE SKIP LOCKED` claim so it is multi-instance-safe by design) dispatches to registered consumers.

**Schema and migration** (`20261020000000_phase2_outbox`, additive): `Outbox` (event ref, `status pending|dispatched|failed`, attempts, nextAttemptAt, lockedBy/lockedAt), `ProcessedEvent` (`@@unique([consumer, eventId])`), `DeadLetter` (event ref, consumer, error, attempts, createdAt). Redis optional for relay leadership; the default in-process adapter needs none.

**Pilot consumer:** migrate the **notification/realtime `changed` fan-out** (`realtime.gateway.ts:38`, today an in-request call) to an outbox consumer. The synchronous behavior is preserved as the fallback path until the async consumer is proven equivalent by the acceptance suite; then the in-request call is removed in the same PR that proves the consumer. No other consequence moves this task.

- [ ] **Step 1: Failing tests first** — outbox row committed atomically with the mutation; relay dispatches each event once; consumer idempotency under duplicate delivery; retry/backoff; dead-letter on exhaustion; **crash-recovery replays undispatched rows** (simulate a process restart with pending rows).
- [ ] **Step 2: Schema + relay + consumer registration + worker/lifecycle bootstrap.**
- [ ] **Step 3: Pilot consumer** (notify fan-out) with the synchronous fallback retained.
- [ ] **Step 4: STOP condition** — if the pilot consumer is not observably equivalent to the synchronous path (a notification missing or duplicated in the acceptance suite), do not remove the synchronous path.
- [ ] **Step 5: Verify** against live PostgreSQL + a simulated restart.

Run: `pnpm check` · integration suite (outbox atomicity + idempotency + crash-recovery, live PG) · both acceptance suites (notifications still arrive exactly once) · `upgrade-proof`.

**Done criteria:** notifications flow through the outbox with at-least-once delivery + exactly-once processing, proven under a simulated crash/restart; retries, dead-letters and relay lag are observable; both acceptance suites green unchanged. **REVIEW STOP.**

## Task 5: Projection Framework — Inbox, Dashboard, Portfolio as Rebuildable Read Models

**Business outcome:** The cross-cutting read surfaces (the "For You" Inbox, Dashboard counts, Portfolio rollup) are fed by module events into rebuildable projections, so they stay correct without ad-hoc joins across transactional tables and can be regenerated from canonical records after any bug or gap (spec §19, §21).

**Canonical fact owner:** each projection owns its read-model table + checkpoint; canonical records/events remain the source it rebuilds from.

**Commands/events:** no user-facing change; new event subscriptions per projection. Projection tables expose rebuild status/lag.

**Schema and migration** (`20261025000000_phase2_projections`, additive): projection tables + a `ProjectionCheckpoint` (consumer, lastEventAt, status).

- [ ] **Step 1: Projection base** — checkpoint, apply(event), rebuild-from-canonical, lag reporting.
- [ ] **Step 2: Move Inbox/Dashboard/Portfolio** derivations to projections fed by Task 3/4 events, proven equivalent to the Task 1 characterization (the frontend still reads via the snapshot/queries this task; Task 8 rewires the client).
- [ ] **Step 3: Projection-rebuild tests** — drop + rebuild = identical output to the live derivation and to the Task 1 characterization.
- [ ] **Step 4: STOP condition** — a projection whose rebuild output differs from the live-derived output aborts the task; equivalence is the contract.
- [ ] **Step 5: Verify.**

Run: `pnpm check` · integration suite (projection apply + rebuild equivalence, live PG) · both acceptance suites unchanged.

**Done criteria:** Inbox/Dashboard/Portfolio are projections; a rebuild reproduces the Task 1 characterization exactly; lag/rebuild status observable.

## Task 6: Module Registry + Per-Module Manifests + Boundary CI Check

**Business outcome:** The application's module boundaries become explicit, declared and machine-checked: each module states its id/version/dependencies/capabilities/permissions/commands/queries/events/subscriptions/routes/projections/jobs/migrations/health, and the registry validates uniqueness, dependencies, cycles, event compatibility, permissions and route contributions at startup and in CI (spec §7), so a boundary violation fails the build instead of rotting silently.

**Canonical fact owner:** `platform/module-registry` owns the compile-time registry + validation; each module owns its manifest.

**Commands/events:** no user-facing change. Adds the manifest declaration + registry validation + a CI boundary check (no cross-module persistence import; no cycles; cross-module consequences only via events — enforced against the Task 1 call-graph baseline, driven toward zero direct calls except spec-permitted same-transaction queries/validations).

- [ ] **Step 1: `ModuleManifest` type + registry validator** (uniqueness, dependencies, cycles, event compatibility, permissions, route contributions).
- [ ] **Step 2: A manifest per existing module** (activities, decisions, drawings, inspections, daily-log; the platform kernel modules too), declaring their real commands/queries/events/routes/permissions.
- [ ] **Step 3: Wire the registry into startup + a CI job** that fails on any manifest/boundary violation. `ModuleInstallation` (per-org/project enablement) is introduced as a **declaration only** this phase, explicitly NOT a substitute for an authorization check (spec §7).
- [ ] **Step 4: STOP condition** — a declared boundary the current code violates must be fixed (route the call through an event/contract) in this PR or explicitly waived with a recorded reason; the check may not be weakened to pass. The known violations to resolve or waive: `activities→inspection` (closing-inspection creation), `inspections→activity` (done write), `nodes→5-domain` FK nulling, `orgs.createProject→*` instantiation.
- [ ] **Step 5: Verify.**

Run: `pnpm check` · the new boundary CI check · integration + both acceptance suites unchanged.

**Done criteria:** every module has a validated manifest; the registry rejects duplicates/cycles/incompatible events at startup and in CI; the boundary check is green with remaining direct cross-module calls reduced to the spec-permitted synchronous queries/validations only (or explicitly waived with reasons). **REVIEW STOP.**

## Task 7: Command/Query Contracts + Extract the First Module Fully

**Business outcome:** A module's consumers reach it only through typed commands, typed queries and its published events — never its tables or service internals — proven by fully extracting one module (recommended first: **decisions**, the most contract-shaped after Phase 1 and the upstream of the readiness chain Phase 3 consumes) behind its contract with its working user flow unchanged.

**Canonical fact owner:** `packages/shared` owns the command/query contract schemas (the ts-rest+Zod layer the architecture always intended, now buildable per Task 2); the extracted module owns its private persistence.

**Commands/events:** the first module's existing commands/queries are formalized as shared contracts (request + response, runtime-validated); no user-facing change.

- [ ] **Step 1: Define the command/query contract shape in shared** (consolidating the API's `contracts.ts` request schemas + the `snapshot/types.ts` response DTOs into shared, runtime-validated on both sides).
- [ ] **Step 2: Route every other module's use of the first module through its query/command/events** — remove direct service/table access; the snapshot serializer reads it via its query, not its repository.
- [ ] **Step 3: Prove the Phase 1 decision-change acceptance flow unchanged.**
- [ ] **Step 4: STOP condition** — any consumer that still needs a direct call names the exact query/validation it requires in the same transaction (spec §6 permits only that); anything else is refactored to an event.
- [ ] **Step 5: Verify.**

Run: `pnpm check` · contract tests (commands/queries/events) · integration + both acceptance suites unchanged.

**Done criteria:** the first module is reachable only via its contract + events; no other module imports its persistence; its user flow and acceptance chain unchanged; contract tests pin its commands/queries/events.

## Task 8: Module-Owned Frontend State — Project-Shell Summary + Paginated Module Queries

**Business outcome:** The frontend replaces the single monolithic Zustand store + one full snapshot with module-owned query/state boundaries: a small project-shell summary loads first (identity, nav, projection counts) and each module fetches its own data via paginated queries, so a large project no longer serializes everything into one payload and each module's screens own their state — while the atomic project-switch and stale-response guarantees are preserved.

**Canonical fact owner:** each module's frontend slice owns its query cache; the shell owns project identity + navigation + projection-fed counts.

**Commands/events:** a new project-shell summary query + per-module queries; the full snapshot remains available during migration and is retired per module.

- [ ] **Step 1: Project-shell summary** endpoint/query (identity, enabled modules from manifests, projection counts).
- [ ] **Step 2: Manifest-driven navigation** from enabled-module manifests + effective permissions (replacing the static `screensFor`/`SCREEN_META` literals, `lib/screens.ts:30-63`).
- [ ] **Step 3: Move ONE module's screens** (matching Task 7's extracted module) to its own query boundary, **carrying the coordinator's scope-lease/supersession/bounded-reconcile guarantees** (`store.ts:575-861`) into the per-module fetch so a late query can't cross project boundaries; retire the stale `data/gateway.ts` stub.
- [ ] **Step 4: Explicit loading/empty/offline/stale/error states; no demo substitution in API mode** (spec §19).
- [ ] **Step 5: STOP condition** — if the per-module query layer cannot reproduce the atomic-switch guarantees the coordinator proved, the switch invariants win; do not ship a weaker guard.
- [ ] **Step 6: Verify** with the Phase 0 project-switch acceptance scenarios (must stay green) + the moved module's flow.

Run: `pnpm check` · `api-e2e` (project-scope + the moved module's chain) · the coordinator's `snapshot-ordering` unit suite.

**Done criteria:** the shell + first module run on module-owned queries; navigation is manifest-driven; project-switch and stale-response acceptance scenarios green unchanged; the full snapshot is no longer the only read path.

## Task 9: Extract Remaining Modules + Modular Acceptance Suite + Phase 2 Review Packet

**Business outcome:** The remaining existing modules (activities, drawings, inspections, daily-log) are extracted incrementally behind their contracts and frontend query boundaries with their user flows unchanged, and the whole modular platform is proven by a per-module test matrix and an end-to-end acceptance run, captured in an independent review packet.

**Canonical fact owner:** each extracted module; `docs/reviews/phase-2-review-packet.md` owns the evidence.

**Commands/events:** each remaining module's commands/queries formalized as shared contracts; its cross-module consequences moved to events; no user-facing change.

- [ ] **Step 1: Extract each remaining module in its own sub-PR** (contract + events + frontend query, characterization-guarded — this task MAY be several PRs, each independently reviewable).
- [ ] **Step 2: Per-module test matrix (spec §21)** — domain, permission-matrix, PostgreSQL integration, event-contract, projection-rebuild, cross-project/company isolation, migration, browser — for every module.
- [ ] **Step 3: Full modular acceptance chain** — the Phase 1 pillar chain, now over extracted modules + outbox + projections, green unchanged; CI boots the API + relay and runs the API-backed browser flows.
- [ ] **Step 4: Phase 2 review packet** (spec §27 format) — base/head/merge SHAs, files by module, schema/migration summary, new event/contract definitions, authorization changes, tests + exact commands/results, manual browser scenarios, known limitations, rollback, security/perf impact, ADR updates.
- [ ] **Step 5: Verify + docs** — `ARCHITECTURE.md`/`DATA_MODEL.md`/`ROADMAP.md` updated to record Phase 2 as implemented; the facts/events unlocked for Phase 3 stated.

Run: `pnpm check` · full integration suite · both acceptance suites · `upgrade-proof` · the per-module matrix.

**Done criteria:** all existing modules extracted behind contracts + events + frontend queries with flows unchanged; the spec §21 test matrix green per module; CI starts PostgreSQL, applies migrations from zero, boots the API + relay, and runs the API-backed browser flows; the review packet records the full evidence. **REVIEW STOP — Phase 2 gate.**

---

## Facts and Events Unlocked for Phase 3 (stated at phase completion, spec §24)

Phase 2 completes when the following are dependable connectors for the Material Readiness pilot: the runtime-importable shared contract package; the versioned `DomainEvent` envelope; published events `decision.reapproved`, `drawing.issued`, `inspection.decided`, `activity.readiness_changed`, `activity.completed`; the transactional-outbox at-least-once delivery + idempotent-consumer contract; the projection framework (a Material Readiness projection is a new consumer, not a new join); and the module registry a `procurement`/`inventory` module registers against. Phase 3 adds modules and consumers — it does not restructure the application.
