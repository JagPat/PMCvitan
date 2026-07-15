# Phase 2 — Platform Modularization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Do not begin Task 1 until the independent Codex review of THIS PLAN (as corrected) clears.**

**Goal:** Give the existing modules (activities, decisions, drawings, inspections, daily-log) explicit ownership, typed command/query contracts, a canonical audit/event envelope, command idempotency, per-consumer transactional-outbox delivery, rebuildable projections and module-owned frontend state — **without changing any working user flow** — so the Materials (Phase 3), Labour (Phase 4) and Commercial (Phase 5) modules can later attach to stable connectors and dependable facts instead of restructuring the application each time.

**Architecture:** Preserve the single deployable NestJS/Prisma/PostgreSQL + React/Zustand modular monolith. Phase 2 introduces the *internal* module-boundary machinery the canonical spec §§6–9 describe — a runtime-importable shared contract package, a compile-time module registry with per-module manifests, a standard `DomainEvent` envelope ordered by a **gap-safe per-project stream position**, a **command-idempotency ledger**, a server-side **per-consumer** transactional outbox with an in-process relay + idempotent consumers, a projection framework feeding Inbox/Dashboard/Portfolio, and module-owned frontend query boundaries replacing the single store + full snapshot. **It does not split the application into separate services** (spec §22), and it adds no Phase 3+ business capability. Existing modules are extracted **incrementally**; each extraction preserves observable behavior, proven by characterization tests written first. Cross-module operations that are **atomic today stay atomic** — they become explicit workflow contracts within one unit of work, never asynchronous events.

**Tech Stack:** pnpm workspace, React 19, Zustand 5, Vitest 4, Playwright 1.61, NestJS 11, Prisma 6, PostgreSQL 16, TypeScript. Phase 2 additions (pilot-scale, per spec §22): the outbox **relay runs in-process** as a NestJS lifecycle poller using short **lease-based claim transactions** (not a bare `FOR UPDATE SKIP LOCKED` held across dispatch), so the design is safe to run later as a separate worker or across multiple instances without a rewrite; **Redis is optional** and used only where the spec requires shared coordination (relay leadership / OTP / rate-limit), stubbed to an in-process adapter in the demo and single-instance deploy — the same provider-seam pattern the codebase already uses for OTP/media/storage (`apps/api/src/auth/sms.service.ts`, `apps/api/src/media/storage.service.ts`). No new external service becomes a hard dependency of the running product this phase.

**Planning baseline:** `main` at `cff18c4` (Phase 1 gate cleared — the independent review issued **GREEN SIGNAL — READY FOR INTERNAL LIVE DEPLOYMENT**, effective runtime head `302b24a`, recorded on [PR #144](https://github.com/JagPat/PMCvitan/pull/144#issuecomment-4977218191)). This plan implements the canonical spec's **Phase 2** row (§§6–9, §17, §19–21) only. **Plan corrected** per the [independent Phase 2 plan review](https://github.com/JagPat/PMCvitan/pull/145#issuecomment-4977445137) (round 1, 8 findings: gap-safe event order + safe rebuild; per-consumer outbox delivery; keep DB notifications transactional; atomic cross-module workflow boundaries; a command-idempotency ledger; the full projection event/authorization matrix; one frontend state owner + resolved module-enablement; added review stops + no hardcoded base SHA) and the [round-2 narrow re-review](https://github.com/JagPat/PMCvitan/pull/146#issuecomment-4978092252) (4 narrowed findings inside 1/2/5/6: same-transaction delivery materialization + explicit delivery state machine + ordered-per-project consumers; actor-scoped idempotency key + full command inventory + enforcement as a completion criterion; the rebuild final-activation barrier + all three cross-cutting projections; `Project.orgId NOT NULL` + the attribution truth table + stale Task-6→Task-9 reference fixes). The follow-up review is narrower again: these four textual corrections, merge lineage and CI.

## Independent Review Corrections (round 1 — how each finding is resolved)

| # | Sev | Finding | Resolution (task) |
|---|---|---|---|
| 1 | P1 | Event order (`occurredAt`) + `lastEventAt` checkpoint are not a total order; a bare `BIGSERIAL` can be skipped past an uncommitted lower sequence | **Task 4**: a per-project stream counter row (`ProjectEventStream`) locked + incremented **inside** the owning mutation transaction; `DomainEvent(projectId, streamPosition)` unique; `occurredAt` is display/audit only; non-null `organizationId` + composite tenant constraint; explicit attribution (`actorKind human\|system` + CHECK); **DB-level** append-only trigger + restricted writer; **Task 9** generation-swap rebuild protocol with per-project high-water marks. Live-PG probes enumerated. |
| 2 | P1 | One global outbox `status` cannot represent multiple consumers; held `SKIP LOCKED` is not a crash-safe claim | **Task 6**: immutable event vs per-consumer `OutboxDelivery(eventId, consumer, status, attempts, nextAttemptAt, leaseOwner, leaseExpiresAt, lastError)` `UNIQUE(eventId, consumer)`; short lease-claim transactions, expiry/reclaim, backoff, terminal dead-letter. Contract renamed **at-least-once delivery with effectively-once database effects**; WS/push are at-least-once with `eventId` dedupe. |
| 3 | P1 | The notify pilot conflates a DB row, a socket invalidation and a push | **Task 6**: the canonical `Notification` row stays **in the command transaction** (response/snapshot identical); only post-commit socket invalidation + Web Push become outbox consumers; a cutover truth table + shadow mode; exactly one active sender at cutover/rollback. |
| 4 | P1 | Atomic Activity↔Inspection (and project-creation) edges cannot be events or indefinite waivers | **Task 1** edge decision table (query/validation \| atomic workflow contract \| FK action \| async event) for **every** cross-module edge; **Task 7** models completion/sign-off as one atomic workflow contract (transaction-bound participants), node unfiling as declared FK actions, project-creation via module initializer contracts in one unit of work; **no indefinite waivers** — any temporary waiver names owner/edge/expiry/removal-task and **fails the final gate** if present. |
| 5 | P1 | Global command idempotency is required but has no implementation task | **Task 5**: a `CommandExecution` receipt ledger + the reserve→execute→receipt one-transaction protocol (same key+payload replays the result; same key+different payload → 409; failures stay retryable); the key enters every shared command contract; existing offline op IDs map in; additive rollout (accept → clients send → enforce). |
| 6 | P1 | Five pillar events cannot maintain Inbox/Dashboard/Portfolio or their authorization | **Task 1** produces a **projection dependency matrix** (row/key/subject × source mutation × event/version × consumer × authorization rule × rebuild query); **Task 4** publishes the **full** event catalog (incl. archive/restore, membership/role/discipline, draft ownership, revision recipient/ack, readiness change) **before Task 9** switches any read path; every projection carries tenant/subject keys + a **query-time authorization check**; removal/role-change invalidates user-specific rows. |
| 7 | P1 | Frontend cutover + module enablement have no single source of truth (declaration-only `ModuleInstallation` vs "enabled modules"; two possible writers per module) | **Task 7** picks the enablement model explicitly (**Phase 2 `enabledModules` = all compiled registry modules; per-tenant `ModuleInstallation` deferred**, not used as runtime truth); **Task 9** defines per-module read ownership as `legacySnapshot` **XOR** `moduleQuery` (once switched, snapshot application **ignores** that module's slice even if a legacy mutation response still carries it); capability-versioned cutover (backend-additive-first, old-frontend-compatible, physical field removal deferred); query state partitioned/purged by user/session/project/scope-generation under the same stale-response coordinator. |
| 8 | P2 | Review stops too sparse for the riskiest cutovers; Task 1 hardcodes a stale base SHA | Added **review stops after Task 8 (first backend extraction) and Task 9 (first frontend migration)**; every Task 10 module is its own PR that must clear review before the next starts; Task 1 records the **actual** `origin/main` SHA at PR time instead of a hardcoded value. |

Round 1 cleared findings 3 (notification split), 4 (atomic workflow contracts), 7 (frontend XOR ownership + enablement) and 8 (review stops + dynamic base SHA), and accepted the gap-safe per-project stream as the right replacement for timestamp ordering. **Those sections are unchanged below.** The [round-2 re-review](https://github.com/JagPat/PMCvitan/pull/146#issuecomment-4978092252) narrowed four issues that remained inside findings 1, 2, 5 and 6:

| # (r1 origin) | Sev | Round-2 issue | Resolution (task) |
|---|---|---|---|
| A (f2/f6) | P1 | Delivery rows can be lost (materialized in a "follow-on" txn); the `failed` status is contradictory (claim selects only `pending`); concurrent workers can apply an ordered projection's position N+1 before N | **Task 6**: for post-cutover events the `OutboxDelivery` rows commit in the **same owning mutation transaction** as the `DomainEvent` (pre-cutover events get a one-time backfill; any follow-on expansion carries a durable `dispatchExpandedAt`/`catalogVersion` obligation + a scanner deriving missing deliveries); an **explicit state-transition table** (`pending→leased→succeeded`; retryable→clear lease/`attempts++`/`nextAttemptAt`, back to `pending`; exhausted→`dead`) — `failed` removed; **each consumer is declared `ordered-per-project` or `unordered`** — projection consumers checkpoint by `(consumer, projectId, streamPosition)` and cannot apply N+1 before N (a `dead` earlier position blocks that projection until operator resolution); socket/push are `unordered`. New live-PG probes. |
| B (f5) | P1 | The idempotency key isn't actor-scoped (`(projectId, commandType, key)` → cross-user collision/disclosure); Task 5 covers only "pillar commands"; enforcement is deferred beyond Phase 2, contradicting the global rule | **Task 5**: `UNIQUE(projectId, actorId, commandType, idempotencyKey)` with replay authorized against the **same current actor/project**, a `scopeKind + organizationId + projectId?` truth table + CHECKs for org-scoped commands; **Task 1** adds a **command inventory** of every mutating route (type/scope/key-source/request-hash/result-ref/migrating-task); Task 5 starts with pillars but **Task 10's final gate fails if any inventory row is unmigrated** without an approved exception; **enforcement (reject missing key) is a Phase-2 completion criterion** (capability/version-gated after old-client drain telemetry), not deferred; `resultRef` replay proven to never return another actor's response. |
| C (f1/f6) | P1 | The rebuild has a final catch-up→activate race; the plan never explicitly completes all three cross-cutting projections | **Task 9**: a **final activation barrier** — per project, hold the `ProjectEventStream` lock, read final position H, apply through H into the replacement generation, activate the generation + checkpoint **atomically before releasing the lock** (events allocated after are `>H` and target the new generation); Portfolio activates per project / a documented deadlock-safe order; relay-vs-rebuild dedupe on `(consumer, generation, streamPosition)`; a held-write-at-handoff + concurrent relay/rebuild probe. **Task 10** gains an explicit step + done criterion that **Inbox, Dashboard AND Portfolio** are all served from complete rebuildable projections matching the Task-1 characterization (author-private drafts + current-membership authz preserved; live == rebuild while writes continue). |
| D (f1) | P2 | Constraints/refs don't fully express the contract: `Project.orgId` isn't made `NOT NULL`; the attribution CHECK permits any `actorKind` when `actorId` is set and doesn't store the system actor; stale "Task 6" projection/rebuild references | **Task 4**: after diagnostic backfill the migration enforces **`Project.orgId NOT NULL`** + the composite `(orgId, id)` key `DomainEvent` references, and project creation cannot commit without the org and its `ProjectEventStream` row; a `actorKind IN ('human','system')` CHECK + an **exact attribution truth table** (human ⇒ non-null `actorId`; system ⇒ non-null stable system-actor reference) with adversarial SQL probes. All stale **Task 6 → Task 9** projection/rebuild references corrected (round-1 table, global constraints, Task-1 outcome, explanatory note). |

---

## Phase Intent (restated per the canonical spec's Phase Intent Map, row 2)

Continued growth inside one Zustand store, one full-project snapshot and direct cross-module service calls will make every new capability (materials, labour, commercial) harder to add safely. Phase 2 exists so the existing modules gain explicit ownership, commands, events, outbox delivery, projections and independently testable boundaries **while remaining one deployable application**. It consumes the Phase 0 facts (trustworthy project identity, live authorization, same-project references, real civil dates) and the Phase 1 facts (locked/re-approved specifications, governing drawing revisions with acknowledged recipients, evidence-backed inspection outcomes linked to the work they accept, completion that means "accepted") and produces the facts Phase 3+ need: **stable connectors** — published domain events with a versioned, gap-safe-ordered envelope, queryable module contracts, and rebuildable read-model projections — so that Materials/Labour/Commercial subscribe to "decision approved", "inspection passed", "activity ready" instead of joining another module's tables.

At phase completion this plan identifies the canonical facts and events unlocked for Phase 3 (the Material Readiness pilot). Note the **event catalog is not five events** — the pillar events (`decision.reapproved`, `drawing.issued`, `inspection.decided`, `activity.readiness_changed`, `activity.completed`) are the Phase-3 consumption highlights, but the full Phase-2 catalog (Task 1 matrix + Task 4) also carries project archive/restore, membership/role/discipline changes, draft publish/ownership, and revision recipient/ack events required to keep the existing projections equivalent.

## Current-State Revalidation (against `main` @ `cff18c4`)

Every Phase 2 concept was revalidated against current code before this plan was written (three read-only reconnaissance passes over `apps/api`, `apps/web`, `packages/shared` + CI). Verdicts: **COMPLETE** (works and is pinned by tests), **PARTIAL** (exists with material gaps), **INCORRECT** (exists but violates the target), **ABSENT** (does not exist). The headline is that the Phase 2 boundary machinery is **essentially greenfield** — the application is one flat module with direct cross-module coupling — so the risk is not building new plumbing but **not breaking the working flows while the plumbing is inserted**.

### Backend module boundaries (`apps/api`)

| Concept | Verdict | Evidence |
|---|---|---|
| NestJS feature modules / encapsulation | ABSENT | One flat `AppModule` (`apps/api/src/app.module.ts:46-102`) registers **15 controllers + 24 providers**; only `PrismaModule` is separate. "Modules" today = directory grouping, not encapsulated Nest modules. |
| Cross-module calls via contracts/events | ABSENT (calls are DIRECT) | `SnapshotService` and `RealtimeGateway` are each injected into the 8 mutating services (constructors e.g. `decisions.service.ts:17-21`, `activities.service.ts:21-26`); cross-domain writes go straight through the shared `PrismaService` — `activities.service.ts:302` (`tx.inspection.create` — completing an activity creates a closing Inspection directly), `inspections.service.ts:169` (`tx.activity.updateMany` — approving a closing inspection writes `Activity.status='done'` directly), `nodes.service.ts:99-103` (a node delete nulls FKs across activity/inspection/media/drawing/siteMaterial), `orgs.service.ts` `createProject` (writes `projectNode`/`phase`/`activity`/`inspection` rows directly). No inter-module contract layer (`apps/api/src/contracts.ts` is HTTP request-validation only). **The activities↔inspections edges are ATOMIC workflows today (one transaction) and must remain so — see Task 1's edge decision table and Task 7.** |
| Audit envelope + shared writer | PARTIAL | `AuditLog` model with a real `actorId` column (`prisma/schema.prisma:785-796`, `actorId` `:789`), but writes are ~20 ad-hoc inline `.create` calls with **two coexisting conventions** — newer sites use `resolveActor()` (`common/actor.ts:21-28`), older sites still pass `actor: user.role` with no `actorId` (e.g. `activities.service.ts:100,145,165,251`, all of `phases`/`daily-log`). No shared audit helper/interceptor, no audit READ API. |
| Domain-event envelope + bus | ABSENT | No events table, event bus, or `DomainEvent` type; no `eventId`/`payloadVersion`/`correlationId`/`streamPosition` anywhere. The only "events" are per-entity `DecisionEvent` append rows (`schema.prisma:517-528`, decisions only) and the **content-free** realtime `changed` socket ping — `realtime.gateway.ts:38` emits `{projectId}`, from 30 call sites; a signal, not a domain event. |
| Command idempotency + optimistic version | PARTIAL | Only **Media** upload is idempotent — project-scoped `clientKey` `@@unique([projectId, clientKey])` (`schema.prisma:261,267`, `media.service.ts:37-99`). No idempotency key on other commands; **no optimistic `version` column**; concurrency is CAS-guarded `updateMany` + `count===0` + partial unique indexes + `FOR UPDATE` (e.g. `decisions.service.ts:130,191,230`; `inspections.service.ts:116,160,169,248`; `activities.service.ts:241,282-289`). |
| Server-side outbox / worker / projections / registry | ABSENT | No outbox table/relay/worker (only a comment about the *frontend* queue, `drawings.service.ts:298`); no `@nestjs/schedule`/`bull`/`ioredis`; the read path is one 453-line 13-way live-join snapshot (`snapshot.service.ts:34-91`); no `ModuleInstallation`/registry (the `TemplateModule`/`ProjectTemplate` models are content presets, `schema.prisma:123-159`). |

### Shared contracts, build & CI

| Concept | Verdict | Evidence |
|---|---|---|
| Shared domain layer usable by the API at runtime | ABSENT (source-only) | `@vitan/shared` is source-only ESM, no build (`packages/shared/package.json:7-11`); web consumes via Vite alias; **the API does not import it at all** ("the API cannot import this source-only ESM package", `readiness.ts:8-9`, `policy.ts:10-12`). **The pivotal Phase 2 enabler (Task 2).** |
| Mirrored-literals convention | COMPLETE (load-bearing) | Four drift-tested mirror pairs: readiness (`readiness.ts` ↔ `transitions.ts`), authorization (`policy.ts` `ROLE_POLICY` ↔ `@Roles`, `route-policy.test.ts:141-207`), seed (`seed.ts` ↔ `seed-data.ts`), civil-date (`dates.ts` ↔ `civil-date.ts`). Every note states the intended exit — a built package retires the duplication (`policy.ts:11-14`). |
| Command/query contracts (shared, ts-rest) | PARTIAL / ABSENT | Zod **request** schemas per-app in `apps/api/src/contracts.ts` (595 lines); **response** shapes are hand DTOs (`apps/api/src/snapshot/types.ts`), not shared, not runtime-validated; **ts-rest never built** (prose only). |
| CI: PG + migrate-from-zero + boot + browser | COMPLETE | `.github/workflows/ci.yml` — `web`, `e2e` (demo), `api-e2e` (postgres:16, migrate+seed+compiled-API boot + API-backed Playwright), `upgrade-proof` (all migrations from `0_init` over a planted legacy fixture — `upgrade-proof.sh:29-30` says "Phase 2 should extend the fixture rather than widen the migration range"), `api` (integration suite). Gap: coarse whole-app filters, no per-module sharding. |

### Frontend state boundaries (`apps/web`)

| Concept | Verdict | Evidence |
|---|---|---|
| Module-owned store slices | ABSENT (one monolith) | `store.ts` is **2801 lines**, one `create<Store>()(immer(...))` (`store.ts:555`); flat `AppState` (`store.ts:145-229`); ~100 actions. `projectScope.ts` is a lifecycle helper, not an ownership split. |
| Full snapshot vs shell + paginated queries | ABSENT (one full snapshot) | `applySnapshotCore` (`store.ts:638-716`) replaces every project field wholesale; every mutation returns the full snapshot (`apiGateway.ts:562-571`); no per-module query. |
| Atomic-switch / stale-response guard (reusable seam) | COMPLETE | The snapshot-ordering coordinator (`store.ts:575-861`) + the `(projectId, generation)` scope lifecycle (`projectScope.ts`) — the Codex-hardened seam Task 9 must carry into the per-module query layer. |
| Manifest-driven navigation | ABSENT (static map) | `SCREEN_META` + `screensFor(role)` literals (`lib/screens.ts:30-63`), `useNavItems.ts:20`; authorization via `ROLE_POLICY`. |
| Inbox/Dashboard/Portfolio as projections | PARTIAL (selectors over the monolith) | `selectActionItems` `:252-318`, dashboard counts `:161-167,20,68,81`, portfolio fetched separately (`apiGateway.ts:377`). **Inbox depends on drafts, decisions/change requests, drawing governing revisions + recipient acks, inspections, daily logs, activities/readiness/overrides, membership role/discipline and the active user; Portfolio depends on memberships, project archive state, activities, inspections, decisions — hence the Task 1 dependency matrix and the full event catalog (finding 6).** |

**Drift notice vs. older docs:** `docs/ARCHITECTURE.md:19,52` and `DATA_MODEL.md:139` still describe a "ts-rest + Zod contracts in `packages/shared`" that was never built. Task 2 makes that description true.

---

## Global Constraints

- Read `docs/superpowers/specs/2026-07-12-modular-construction-control-platform-design.md` first; this plan implements its **Phase 2** row only (§§6–9, §17, §19–21).
- **Preserve every working user flow.** No screen changes its observable outcome; the Phase 0 two-project acceptance suite (`apps/web/tests/e2e-api/project-scope.spec.ts`) and the Phase 1 pillar-chain acceptance suite (`apps/web/tests/e2e-api/pillar-chain.spec.ts`) stay green **unchanged** through every task. A mutation's HTTP response and the returned snapshot remain behaviorally identical — in particular the canonical `Notification` row it creates today is still present in that response (finding 3). Any user-visible change needs explicit product approval and its own PR.
- **Characterization before extraction (spec §21).** Task 1 pins the snapshot shape, the cross-module call graph, the `changed` signal, every audit site, the per-mutation consequence set, and — new per finding 6 — the **projection dependency matrix** before any module moves.
- **Gap-safe event order (finding 1).** Event order is a **durable per-project stream position** assigned inside the owning mutation transaction (`ProjectEventStream` counter locked + incremented; `DomainEvent(projectId, streamPosition)` unique). `occurredAt` is display/audit only and is **never** a checkpoint or ordering key. Projection checkpoints are `(consumer, projectId, streamPosition)`; cross-project projections (Portfolio) keep one checkpoint per project. An **ordered-per-project** consumer applies positions in order and may **not** apply N+1 before N — a `dead` earlier position blocks that consumer's project until an operator resolves it, never a silent skip. No projector may advance past a position it has not durably applied, and rebuild uses the **generation-swap + final-activation-barrier protocol (Task 9)**, never "replay since a timestamp".
- **Complete, tenant-safe envelope (finding 1, round-2 D).** Every event carries `eventId, eventType, payloadVersion, organizationId (NON-NULL), projectId, streamPosition, siteId?, actorId?, actorKind (human|system), entityType, entityId, occurredAt, correlationId, causedByEventId?, payload`. A composite constraint ties `(organizationId, projectId)` to the project's real org; **after the Task-4 diagnostic backfill the migration enforces `Project.orgId NOT NULL`** and the composite `Project(orgId, id)` key the event FK references, and project creation cannot commit without the org and its `ProjectEventStream` row — so no future project can exist without a tenant. **Attribution truth table** (a CHECK, not a convention): `actorKind IN ('human','system')`; a `human` event **requires** a non-null `actorId` (a real user identity); a `system` event **requires** a non-null stable system-actor reference (a named constant persisted, not an implicit null). The event store is **append-only enforced at the database level** (a `BEFORE UPDATE OR DELETE` trigger that raises + a restricted writer role), not by convention.
- **One canonical write path (spec §9), idempotent (finding 5, round-2 B).** Every state-changing command: validated → **reserve/resolve its idempotency receipt** (`CommandExecution`, keyed `(projectId, actorId, commandType, idempotencyKey)`) → owning-module transaction writing the canonical record + audit entry + `DomainEvent` (with its stream position) + its per-consumer `OutboxDelivery` rows + the successful receipt, all in **one transaction** → asynchronous idempotent consumers → projections/WS-invalidation/push. Replay is authorized against the **same current actor and project** — a `resultRef` is returned only to the actor/project that produced it, never another. Same key + same `requestHash` replays the committed result; same key + different `requestHash` → 409; a failed transaction leaves the key safely retryable. The key covers **every** state-changing command (the Task-1 command inventory); missing-key **enforcement is a Phase-2 completion criterion** (capability/version-gated after old-client-drain telemetry), not deferred past the phase.
- **At-least-once delivery, effectively-once effects (finding 2, round-2 A).** Delivery state is **per consumer** (`OutboxDelivery`, `UNIQUE(eventId, consumer)`), whose rows commit in the **same owning mutation transaction** as the event for post-cutover events (pre-cutover events get a one-time backfill; any follow-on expansion carries a durable `dispatchExpandedAt`/`catalogVersion` obligation + a scanner that derives missing deliveries from `DomainEvent`). The status machine is explicit — `pending → leased → succeeded`; a retryable failure clears the lease, increments `attempts`, sets `nextAttemptAt` and returns to `pending`; exhaustion → `dead` (there is no ambiguous `failed`). A database consumer commits its side effect **and** its `ProcessedEvent` idempotency row in one transaction (effectively-once). Each consumer is declared **`ordered-per-project`** (projections — checkpoint `(consumer, projectId, streamPosition)`, never apply N+1 before N; a `dead` earlier position blocks that consumer's project until operator resolution) or **`unordered`** (socket/push). WebSocket and Web Push are **at-least-once** — a crash after an external send but before acknowledgement may duplicate; `eventId` is the dedupe key where the provider supports it, and the residual is documented, never claimed away as "exactly once".
- **Atomic cross-module workflows stay atomic (finding 4).** Cross-module consequences that are one transaction today do **not** become asynchronous events. Task 1 assigns every cross-module edge exactly one mechanism — **public synchronous query/validation**, **public atomic workflow contract** (transaction-bound participants, one unit of work), **database FK action**, or **asynchronous event** — and Task 7 enforces it. The activity-completion → closing-inspection creation, the closing-inspection-approval → activity `done`, and project-creation → module initialization all remain single atomic commits via workflow contracts. **No indefinite boundary waivers**: any temporary waiver names owner, exact edge, expiry and removal task, and the **final gate fails if a waiver is still present**.
- **Projections carry query-time authorization (finding 6).** A projection is a rebuildable read model **plus** a mandatory current-membership/authorization check at query time — never a bypass of RBAC. Rows carry explicit tenant + subject keys (project-, user-, role- or org-scoped as the matrix declares); a membership removal or role change invalidates/replaces the affected user-specific rows without leaking the prior view.
- **One frontend state owner during migration (finding 7).** Each module's read path is `legacySnapshot` **XOR** `moduleQuery` at any moment — never both. Once a module is switched to its query, snapshot application **ignores that module's slice** even when a legacy mutation response still includes it, so the Phase-1 stale-overwrite class cannot reopen. Cutover is capability-versioned: additive backend endpoints deploy first, the old frontend keeps working against the new backend, and snapshot fields/routes are **not physically removed** until compatibility telemetry + a later reviewed cleanup. Module query state is partitioned/purged by user/session/project/scope-generation under the existing coordinator.
- **Module enablement has one source of truth (finding 7).** Phase 2 defines `enabledModules` as **all compiled registry modules**; per-tenant `ModuleInstallation` is **deferred** (not introduced as a declaration-only entity used as runtime truth). Manifests/`enabledModules` **never** substitute for a server-side authorization check (spec §7, §18).
- **Additive, diagnostic-first migrations; never `db push`.** New slots start at `20261015000000_phase2_*`. Proven against a fresh DB **and** a representative upgraded copy — **extend the `upgrade-proof.sh` fixture, do not widen its range** (`apps/api/scripts/upgrade-proof.sh:29-30`).
- **Tenant isolation stays database-enforced** for every new table (event, stream counter, command ledger, outbox delivery, projection). Cross-project isolation + forgery-refusal probes run against live PostgreSQL.
- **Out of scope (explicitly):** any Phase 3+ business capability; supplier/contractor portals and the full `Company`/`ProjectParty` hybrid-tenancy split (spec §8 → Phase 6); RedBracket integrations (§23); runtime third-party plugins (§6); extracting any module into its own deployable service (§22); per-tenant module installation (deferred); broad UI redesign; unrelated cleanup.

## Product Intent Claude Must Preserve

Before each PR, include a five-line vision-alignment statement with concrete values:

```text
User decision improved: <role> can <decision> because <fact chain> — UNCHANGED this phase; name the flow that stays identical.
Canonical fact owner: <module/record> — now behind its explicit contract.
Information flow: <source> -> <event@streamPosition/envelope> -> <consumer/projection>.
Human work removed: none this phase (structural); OR the automation the event now enables downstream.
Trust invariant: <what can no longer silently happen> — e.g. a cross-module consequence can no longer bypass audit/outbox; an atomic workflow can no longer half-commit.
```

Reject a design in self-review when it: changes a working user flow without product approval; lets a module read or write another module's tables directly; converts an atomic cross-module workflow into an asynchronous event; fires a cross-module consequence outside the transactional outbox; orders or checkpoints events by wall-clock time; introduces an event without the full versioned, tenant-consistent envelope; promises exactly-once external (WS/push) delivery; stores a projection as an independently-editable source of truth rather than a rebuildable read model; serves a projection without a query-time authorization check; or adds a manifest/enablement flag that substitutes for a real server-side authorization check.

## Required Execution Order and Review Stops

Tasks 1–10 in order; each task is one PR unless noted. **Review stops (wait for independent review before continuing): after Task 1, Task 6, Task 7, Task 8, Task 9 and Task 10.** The order follows the spec §9 write path (shared runtime package → envelope+stream → idempotency → outbox+consumers → projections) before the boundary formalization (registry+workflow contracts → contracts+first extraction → frontend) and the remaining extraction last, so each layer rests on a proven one. The later stops (8, 9) are **narrow pattern reviews** of the first backend extraction and the first frontend migration — intended to catch a wrong pattern before it is multiplied across all modules, not to re-audit the whole phase.

```text
Task 1  (characterization baseline + projection dependency matrix + edge decision table; record actual origin/main SHA)  ⟵ REVIEW STOP
  -> Task 2  (promote @vitan/shared to a buildable runtime package; retire the mirrored-literals convention)   [1]
  -> Task 3  (platform kernel: canonical AuditLog writer + shared audit/actor helpers)                          [2]
  -> Task 4  (DomainEvent envelope + per-project gap-safe stream position + DB-level append-only + tenant CHECK) [3]
  -> Task 5  (command-idempotency ledger: CommandExecution + reserve/execute/receipt protocol)                  [4]
  -> Task 6  (per-consumer transactional outbox + relay + consumers + dead-letter; notification split + cutover) [5]  ⟵ REVIEW STOP
  -> Task 7  (module registry + manifests + boundary CI check + edge workflow contracts; enablement resolved)    [4,6]  ⟵ REVIEW STOP
  -> Task 8  (command/query contracts in shared; extract the FIRST backend module fully behind its contract)     [7]  ⟵ REVIEW STOP
  -> Task 9  (projection framework switch-over + module-owned frontend state for the FIRST module)               [6,8]  ⟵ REVIEW STOP
  -> Task 10 (extract remaining modules — one PR each, stop between — + modular acceptance suite + review packet)[all]  ⟵ REVIEW STOP
```

_(Note: the **full event catalog** is published in Task 4; the **projection framework + rebuild/activation protocol** are built in **Task 9**, where the first read path is switched to a projection paired with that module's frontend migration, so the projection cutover and the frontend cutover are reviewed together for one module before Task 10 repeats the pattern and completes all three cross-cutting projections.)_

## File Structure (primary touch points)

| File / dir | Responsibility |
|---|---|
| `apps/api/test/integration/phase2-characterization.test.ts` + `apps/web/tests/snapshot-shape.test.ts` + `docs/reviews/phase2-projection-matrix.md` | Task 1 — characterization + the projection dependency matrix + the cross-module edge decision table. |
| `packages/shared/package.json` + build + `apps/api/package.json` | Task 2 — `@vitan/shared` becomes a built runtime dependency the API imports. |
| `packages/shared/src/platform/{events,commands}.ts` (NEW) | The `DomainEvent` envelope + event-type catalog + command-contract + idempotency-key types (shared api+web). |
| `apps/api/src/platform/{audit,events,commands,outbox,projections,registry}/` (NEW) | The kernel: `recordAudit()`, `emit()` (+ `ProjectEventStream`), `CommandExecution` ledger, `OutboxDelivery` relay + consumers, projection base + rebuild, module registry + manifest validator. |
| `apps/api/prisma/migrations/20261015*–2026104*` | Additive diagnostic-first migrations: event stream + envelope + append-only trigger, command ledger, outbox delivery, projection tables + checkpoints (named per task). |
| `apps/api/src/**/{module}.manifest.ts` + `apps/api/src/platform/workflows/*` (NEW) | Per-module manifests; the atomic workflow contracts (completion/sign-off, project-init). |
| `apps/api/src/snapshot/snapshot.service.ts` + `realtime/realtime.gateway.ts` | Read via module queries/projections; the `changed` fan-out + push become outbox consumers (Notification row stays transactional). |
| `apps/web/src/store/*`, `apps/web/src/data/*`, `lib/screens.ts`, `layout/useNavItems.ts` | Task 9 — module-owned query slices, project-shell summary, XOR read-ownership, manifest-driven nav; retire the stale `data/gateway.ts` stub. |
| `apps/api/scripts/upgrade-proof.sh` + `.github/workflows/ci.yml` | Extend the legacy fixture; add boundary-check + event-contract + projection-rebuild jobs + worker boot. |
| `docs/reviews/phase-2-review-packet.md` | The independent review packet (Task 10). |

---

## Task 1: Characterization Baseline + Projection Dependency Matrix + Edge Decision Table

**Business outcome:** Every structural boundary and every projection Phase 2 will touch is pinned against today's observable behavior and its exact data dependencies, so each later task proves an intentional change and Task 9 cannot switch a read path onto an incomplete event set.

**Canonical fact owner:** none (analysis + test-only; no schema, no runtime change).

- [ ] **Step 1: Record the baseline.** `git fetch origin && git rev-parse origin/main` — **record the actual SHA in the PR** (do not hardcode a value in the plan). Clean tree, `pnpm check` green, integration + both acceptance suites green.
- [ ] **Step 2: Snapshot-shape characterization** (`apps/web/tests/snapshot-shape.test.ts` + API variant): pin the exact top-level key set and per-key shape per role — the contract Task 9 may not silently break.
- [ ] **Step 3: Cross-module call-graph + edge decision table** (`docs/reviews/phase2-projection-matrix.md` + a source-scan tripwire): enumerate every direct cross-module service injection and cross-domain `PrismaService` write (the `activities→inspection`, `inspections→activity`, `nodes→5-domain`, `orgs.createProject→*` sites) and every `changed` emit site, and assign **each edge one mechanism** — public synchronous query/validation, public atomic workflow contract, database FK action, or asynchronous event — with the reason. The activity-completion and closing-sign-off edges are **atomic workflow contracts**; node unfiling is a **FK action** (`ON DELETE SET NULL`); project-creation is a **workflow contract** (module initializers). This table is the contract Task 7 enforces.
- [ ] **Step 4: Per-mutation consequence characterization** (live PG): pin, per pillar mutation, the full consequence set today (DB `Notification` rows, `changed` signal, push, gate recomputations, audit rows) — the set Tasks 5/6 must reproduce exactly.
- [ ] **Step 5: Projection dependency matrix** (finding 6). For Inbox, Dashboard and Portfolio, produce a table: **projection row / key / subject**, every **canonical source mutation**, the **event (type + version)** that must be emitted, the **consumer**, the **authorization rule** (project/user/role/org scope + query-time check), and the **rebuild query**. This enumerates the FULL event catalog Task 4 must publish (incl. project archive/restore, membership/role/discipline change, draft publish/ownership, revision recipient/ack, readiness change) — not just the five pillar events.
- [ ] **Step 6: Command inventory** (round-2 B). Enumerate **every** mutating route across all controllers — activities/phases, decisions, drawings, inspections, daily log, nodes, media, project/team/org operations, and any other mutation — as a table: **command type**, **scope** (`scopeKind` = project | org, with `organizationId` + optional `projectId`), **client key source** (the existing offline op id / `Media.clientKey` / a new key), **request-hash inputs**, **result reference**, and **the task that migrates it onto the `CommandExecution` ledger**. Task 5 migrates the pillar commands; the rest are scheduled here so Task 10's gate can verify none is left unmigrated.
- [ ] **Step 7: Verify and commit.**

Run: `pnpm check` · full integration suite · both acceptance suites.

**Tests/Rollback/Risks:** analysis + tests only; revert to undo; no runtime risk. **Done criteria:** all gates green; the snapshot shape, call graph + edge decisions, per-mutation consequences and the projection dependency matrix are each pinned/recorded; the actual base SHA is in the PR. **REVIEW STOP.**

## Task 2: Promote `@vitan/shared` to a Buildable Runtime Package

**Business outcome:** The API imports shared domain code at runtime, giving the envelope, command/query contracts and readiness/policy logic **one source of truth** consumed by both web and api — retiring the four hand-mirrored drift-tested copies.

**Canonical fact owner:** `packages/shared` becomes the single runtime source for readiness, policy, civil-date and seed, and going forward for contracts/events.

- [ ] **Step 1: Add a build** (tsc/tsup → the format the CommonJS API needs), `main`/`exports`/`types` resolving for web (keep the Vite alias for dev) and api (a real workspace dependency); wire into `pnpm check`/CI before api typecheck.
- [ ] **Step 2: Consume from the API, one mirror at a time, equivalence-guarded** — civil-date first (functional), then readiness, then seed, then policy (touches route-authz). Keep each drift test green until the import is live, then convert it to an imported-identity assertion.
- [ ] **Step 3: STOP condition** — if any consumer can't import the built package at runtime (ESM/CJS interop, Nest DI/decorators), stop and record the blocker; never delete a mirror before its shared import is proven in the integration suite.
- [ ] **Step 4: Docs** — make the "ts-rest + Zod in packages/shared" description accurate about the now-built package (contracts land in Task 8). **Step 5: Verify.**

Run: `pnpm check` · full integration suite (real Nest boot proves runtime import) · both acceptance suites · `upgrade-proof`.

**Done criteria:** the API imports `@vitan/shared` at runtime; each retired mirror is proven identical by an imported-identity test; all gates green.

## Task 3: Platform Kernel — Canonical Audit Writer + Shared Actor Helpers

**Business outcome:** Every consequential state change writes one canonical audit entry through a single writer with real attribution, closing the two-convention gap and giving the event kernel (Task 4) a uniform actor.

**Canonical fact owner:** `platform/audit` owns `AuditLog` via one `recordAudit(tx, …)`; `common/actor.ts` resolves `{actorId, actorName, actorRole, actorKind}` for every site.

- [ ] **Step 1: Failing tests first** — every audit site carries `actorId` (or a named system actor with `actorKind='system'`); one writer; no behavior change.
- [ ] **Step 2: `recordAudit` + actor helper**; route the ~20 ad-hoc sites through it (older `actor: user.role` sites gain `actorId`). No schema change beyond what Phase 1 already added.
- [ ] **Step 3: Verify.**

Run: `pnpm check` · integration suite · both acceptance suites unchanged.

**Done criteria:** all audit writes go through `recordAudit` with real attribution; flows/tests unchanged. (Kept separate from Task 4 so the attribution cleanup is reviewable independently of the event store.)

## Task 4: Domain-Event Envelope + Gap-Safe Per-Project Stream Position

**Business outcome:** Every consequential state change appends one immutable, tenant-consistent, **totally ordered** domain event, so consumers and projections have a gap-safe ordered source of "what happened" that can never be skipped past an uncommitted write.

**Canonical fact owner:** `platform/events` owns the append-only `DomainEvent` store, the `ProjectEventStream` counter and the shared envelope type (`packages/shared/src/platform/events.ts`).

**Schema and migration** (`20261015000000_phase2_event_envelope`, additive, diagnostic-first):

```text
ProjectEventStream   projectId (PK, FK Project.id), nextPosition BIGINT NOT NULL DEFAULT 0
                     -- one row per project; SELECT ... FOR UPDATE + increment INSIDE the mutation txn

DomainEvent          eventId (uuid PK), eventType TEXT, payloadVersion INT,
                     organizationId TEXT NOT NULL, projectId TEXT NOT NULL, streamPosition BIGINT NOT NULL,
                     siteId TEXT NULL, actorId TEXT NULL, actorKind TEXT NOT NULL,  -- 'human' | 'system'
                     entityType TEXT, entityId TEXT, occurredAt timestamptz,        -- occurredAt = DISPLAY ONLY
                     correlationId TEXT, causedByEventId uuid NULL, payload JSONB
  @@unique([projectId, streamPosition])
  -- tenant consistency: after backfill, Project.orgId is set NOT NULL; Project gains @@unique([orgId, id]);
  --   composite FK (organizationId, projectId) -> Project(orgId, id). Project creation cannot commit
  --   without the org AND its ProjectEventStream row (both in the create transaction).
  -- attribution CHECK (truth table, round-2 D):
  --   actorKind IN ('human','system')
  --   AND (actorKind <> 'human' OR actorId IS NOT NULL)          -- human => a real user identity
  --   AND (actorKind <> 'system' OR systemActor IS NOT NULL)     -- system => a named stable system-actor ref
  --   (systemActor is a small NOT-NULL-when-system text/enum column naming the constant system actor)
  -- append-only: raw-SQL BEFORE UPDATE OR DELETE trigger RAISES; a restricted writer role owns inserts only
```

- [ ] **Step 1: Failing tests first (live PG)** — the envelope is complete; the event + its stream position + the canonical mutation commit in ONE transaction; **equal `occurredAt` values still get distinct ordered positions**; an event committed by a transaction that started later but committed earlier gets a later position and is not skipped; a projector cursor never advances over an uncommitted lower position; a cross-project/forged `(organizationId, projectId)` is rejected; **adversarial attribution probes** — an invalid `actorKind`, a `human` event with null `actorId`, and a `system` event with null `systemActor` are all rejected; `UPDATE`/`DELETE` on `DomainEvent` is refused; **project creation without an org or without its `ProjectEventStream` row cannot commit**.
- [ ] **Step 2: Schema + migration** (stream counter, envelope, `Project.orgId` set NOT NULL after backfill, `Project` composite unique + composite FK, the attribution truth-table CHECK + `systemActor` column, append-only trigger + role). **STOP condition:** a project with a null `orgId` aborts the migration diagnostics — backfill org first (ensure-accounts already can) — and the migration then **enforces `Project.orgId NOT NULL`** so no future project can exist without a tenant; never emit an event with a null organizationId.
- [ ] **Step 3: `emit(tx, event)`** — locks/increments `ProjectEventStream`, assigns `streamPosition`, threads `correlationId`/`causedByEventId`, writes inside the caller's transaction.
- [ ] **Step 4: Publish the FULL Task-1 event catalog** dual-write alongside existing consequences (pillar events + archive/restore, membership/role/discipline, draft publish/ownership, revision recipient/ack, readiness change) — existing behavior unchanged, events now ALSO recorded.
- [ ] **Step 5: Verify** (+ extend `upgrade-proof` fixture with a legacy pre-event project).

Run: `pnpm check` · integration suite (the Step-1 probes) · both acceptance suites unchanged · `upgrade-proof`.

**Done criteria:** every catalog event appends a complete, tenant-consistent, gap-safe-ordered `DomainEvent` in the mutation transaction; append-only enforced by the database; the probes pass; existing flows/tests unchanged.

## Task 5: Command-Idempotency Ledger

**Business outcome:** A retried or duplicated command (offline replay, network retry, double-tap) executes its effect exactly once and returns the same result, so at-least-once clients and the offline outbox are safe by construction.

**Canonical fact owner:** `platform/commands` owns `CommandExecution`; the key enters every shared command contract (Task 8 formalizes the contracts; the ledger + protocol land here).

**Schema and migration** (`20261016000000_phase2_command_ledger`, additive):

```text
CommandExecution  id, scopeKind ('project'|'org'), organizationId, projectId (NULL for org-scoped),
                  actorId, commandType, idempotencyKey, requestHash,
                  status ('reserved'|'succeeded'|'failed'), resultRef, createdAt, completedAt
  @@unique([projectId, actorId, commandType, idempotencyKey])         -- project-scoped commands
  @@unique([organizationId, actorId, commandType, idempotencyKey])    -- org-scoped commands (projectId NULL)
  -- scope CHECK: (scopeKind='project' AND projectId IS NOT NULL) OR (scopeKind='org' AND projectId IS NULL)
```

**Protocol (round-2 B):** the key is **actor-scoped** — reserve/resolve concurrent duplicates (insert the `reserved` row; a duplicate insert → `P2002` → the loser waits for/reads the winner's committed result); the canonical mutation + audit + `DomainEvent` + its `OutboxDelivery` rows + the `succeeded` receipt commit in **one transaction**; **replay is authorized against the same current actor + scope** — `resultRef` resolves to the stored result **only** for the actor/project(or org) that produced it, so no response belonging to another actor can be returned; **same key + same `requestHash`** replays that result/effect; **same key + different `requestHash`** → **409**; a failed transaction leaves the key safely retryable (no `succeeded` receipt, `reserved` expires/cleared).

- [ ] **Step 1: Failing tests first (live PG)** — two concurrent identical commands → one execution + one event, the other returns the same result; **the same key across two different actors does NOT collide and never returns one actor's result to the other**; **the same actor + same key across two projects does not collide**; same-key/different-payload → 409; a mid-transaction failure leaves the command retryable; the receipt commits atomically with the mutation; missing-key behavior is exercised both **before** and **after** the enforcement gate.
- [ ] **Step 2: Schema + the reserve/execute/receipt wrapper** applied to the pillar commands (the rest of the Task-1 command inventory is migrated across Tasks 8–10); **map the existing offline outbox op IDs into `idempotencyKey`** (the frontend already generates client op ids — they become the key; `Media.clientKey` folds in).
- [ ] **Step 3: Additive rollout — enforcement is a Phase-2 completion criterion.** Backend accepts-and-honors keys now; a missing key falls back to today's CAS behavior (no regression) so old clients keep working; the current web starts sending keys; once compatibility telemetry proves old clients have drained, **missing-key enforcement is enabled behind a capability/version gate** — this is a Phase-2 done state, not deferred past the phase.
- [ ] **Step 4: Verify** (+ API/browser retry probe: replay a submit/approve twice → one effect).

Run: `pnpm check` · integration suite (concurrency + cross-actor + cross-project probes) · both acceptance suites (offline replay still idempotent) · `upgrade-proof`.

**Done criteria:** duplicate/concurrent commands are effectively-once with deterministic replay/conflict semantics and no cross-actor result disclosure; offline replay maps onto the ledger; missing-key enforcement is enabled (capability-gated) by phase end; old clients drain safely. The **Task-1 command inventory** is the checklist Task 10's gate verifies fully migrated.

## Task 6: Per-Consumer Transactional Outbox + Relay + Notification Split

**Business outcome:** A committed state change reliably drives each of its downstream consequences independently — a projection failure can't mask a delivered notification and vice-versa — delivered at-least-once, processed effectively-once by database consumers, retried with backoff, and dead-lettered when exhausted; while the user-visible notification stays instant.

**Canonical fact owner:** `platform/events` owns the immutable event and `OutboxDelivery` (per-consumer delivery state); each consumer owns its `ProcessedEvent` idempotency record.

**Schema and migration** (`20261020000000_phase2_outbox`, additive):

```text
OutboxDelivery  id, eventId (FK DomainEvent), projectId, consumer, consumerKind ('ordered'|'unordered'),
                streamPosition BIGINT,  -- copied from the event; ordered consumers checkpoint on it
                status ('pending'|'leased'|'succeeded'|'dead'),   -- NO ambiguous 'failed'
                attempts INT, nextAttemptAt, leaseOwner, leaseExpiresAt, lastError, createdAt, updatedAt
  @@unique([eventId, consumer])          -- one delivery row per (event, consumer)
ProcessedEvent  consumer, eventId, processedAt   @@unique([consumer, eventId])
ProjectionCursor consumer, projectId, appliedPosition BIGINT, status ('live'|'blocked'), updatedAt
  @@unique([consumer, projectId])        -- ordered consumers advance this only contiguously
```

**Delivery materialization (round-2 A).** For events emitted **after the Task-6 cutover**, the `OutboxDelivery` rows for every registered consumer are written in the **same owning mutation transaction** as the `DomainEvent` (so a crash cannot leave an event with no durable delivery work). Events that predate the cutover get a **one-time diagnostic backfill** that derives their deliveries from the `DomainEvent` rows. If a later catalog change makes same-transaction expansion impractical, it is allowed only with a durable obligation — an event carries `dispatchExpandedAt`/`catalogVersion` and a **scanner** derives every missing delivery from `DomainEvent` until expansion completes — and a crash in that gap is tested.

**Delivery state machine (round-2 A).** `pending` (unleased or lease expired) → **claim** → `leased`; on success → `succeeded`; on a **retryable failure** → clear the lease, `attempts++`, set `nextAttemptAt` (backoff), return to `pending`; on **exhaustion** → `dead`. The relay claim is a **short lease transaction** (`status='pending' AND nextAttemptAt<=now`, set `leaseOwner`/`leaseExpiresAt`, commit) — never a lock held across dispatch — and an expired `leased` row is reclaimable. There is no `failed` status.

**Ordering (round-2 A).** Each consumer is declared **`ordered-per-project`** or **`unordered`**. An **ordered** consumer (every projection) advances its `ProjectionCursor(consumer, projectId, appliedPosition)` **contiguously** — it may not apply `streamPosition` N+1 before N even if two workers claim adjacent positions — so a slow/failed earlier position holds the cursor; a `dead` earlier position sets the cursor `blocked` and the projection is **visibly degraded until an operator resolves it**, never a silent skip. **Unordered** consumers (socket invalidation, Web Push) may process in any order.

**A database consumer commits its side effect AND its `ProcessedEvent` row in one transaction** (effectively-once). The contract is **at-least-once delivery with effectively-once database effects**. **WebSocket and Web Push are at-least-once** — a crash after send but before ack may duplicate; `eventId` is the dedupe key where the provider supports it; the residual is documented, never claimed as exactly-once.

**Notification split (finding 3):** the canonical `Notification` **row stays written in the owning command transaction** (the mutation response/snapshot is unchanged). Only **post-commit socket invalidation** and **Web Push** move to outbox consumers.

**Cutover truth table (per command × effect):**

| Effect | Owner during rollout | At cutover | Rollback |
|---|---|---|---|
| `Notification` DB row | command transaction (unchanged, always) | command transaction | command transaction |
| socket `changed` invalidation | old in-request call **or** outbox consumer — exactly one active (shadow mode may record+compare intents but must not send) | outbox consumer only | old in-request call only |
| Web Push | old in-request call **or** outbox consumer — exactly one active | outbox consumer only | old in-request call only |

- [ ] **Step 1: Failing tests first (live PG)** — delivery rows committed in the SAME transaction as the event; **a crash between event commit and delivery creation leaves work the backfill/scanner repairs** (no lost consumer); a retryable failure returns the row to `pending` and is **reclaimed** on the next pass; two consumers with mixed success (one succeeds, one dies → per-row truth, neither masks the other); duplicate dispatch → one effect for a DB consumer; crash before/after effect; stale-lease reclaim; **two workers racing adjacent positions N and N+1 for an ordered projection consumer cannot advance the cursor past N until N is applied**; **a `dead` earlier position blocks that projection's cursor rather than skipping it**; one consumer exhausting retries without blocking another; the `Notification` row is visible in the mutation's immediate response; exactly one active socket/push sender across rollout→cutover→rollback; socket refetch is correct under duplicate invalidations.
- [ ] **Step 2: Schema + relay + consumer registration + lifecycle bootstrap** (in-process; lease-based; ordered consumers advance `ProjectionCursor` contiguously; the pre-cutover delivery backfill runs once).
- [ ] **Step 3: Split the notify path** — Notification row transactional; socket + push as consumers behind the cutover table; shadow mode first. **STOP condition:** two active external senders, or a Notification row not in the immediate response, blocks cutover.
- [ ] **Step 4: Verify** under a simulated restart.

Run: `pnpm check` · integration suite (the Step-1 probes, live PG) · both acceptance suites (notifications arrive, response identical) · `upgrade-proof`.

**Done criteria:** per-consumer delivery with independent leases/retries/dead-letters; DB effects effectively-once, WS/push at-least-once-with-dedupe; the Notification row stays instant; exactly one active external sender at all times; both acceptance suites green unchanged. **REVIEW STOP.**

## Task 7: Module Registry + Manifests + Boundary CI Check + Edge Workflow Contracts

**Business outcome:** The module boundaries become explicit, declared and machine-checked, and the cross-module edges the Task-1 table classified as atomic workflows are modeled as **transaction-bound workflow contracts** — so completion/sign-off/project-init stay single atomic commits while every other cross-module consequence goes through events.

**Canonical fact owner:** `platform/module-registry` owns the registry + validation; `platform/workflows` owns the atomic workflow contracts; each module owns its manifest.

- [ ] **Step 1: `ModuleManifest` type + registry validator** (uniqueness, dependencies, cycles, event compatibility, permissions, route contributions; validated at startup + CI).
- [ ] **Step 2: A manifest per module** (activities, decisions, drawings, inspections, daily-log + platform modules), declaring real commands/queries/events/routes/permissions.
- [ ] **Step 3: Atomic workflow contracts for the Task-1 atomic edges.** Model activity-completion (activity + closing inspection) and closing-sign-off (inspection + activity) as one workflow/aggregate boundary: each module exposes a **transaction-bound public participant** the workflow invokes within one unit of work, so both records commit or roll back together — no half-created closing inspection, no half-approved sign-off. Replace `nodes`→5-domain FK nulling with declared **`ON DELETE SET NULL`** FK semantics. Make `orgs.createProject` call each module's **initializer contract** within one unit of work instead of writing module tables directly (no partially-initialized project).
- [ ] **Step 4: Enablement model (finding 7).** Define `enabledModules` = all compiled registry modules; **do not** introduce `ModuleInstallation` as runtime truth. Manifests never replace a server authorization check.
- [ ] **Step 5: Boundary CI check** against the Task-1 baseline — no cross-module persistence import; no cycles; cross-module consequences only via the declared mechanism. **STOP condition / no indefinite waivers:** a violated boundary is fixed here or gets a waiver naming owner, exact edge, expiry and removal task; **the Phase-2 final gate (Task 10) fails if any waiver is still present.**
- [ ] **Step 6: Verify** (concurrency/rollback probes: no half-created closing inspection, half-approved sign-off, or partially initialized project).

Run: `pnpm check` · the boundary CI check · integration (workflow atomicity + rollback) · both acceptance suites unchanged.

**Done criteria:** validated manifests; registry rejects duplicates/cycles/incompatible events; atomic edges are workflow contracts proven atomic under concurrency; node/project edges use FK actions / initializer contracts; `enabledModules` is the single enablement source; the boundary check is green with no indefinite waivers. **REVIEW STOP.**

## Task 8: Command/Query Contracts + Extract the First Backend Module

**Business outcome:** A module's consumers reach it only through typed commands (carrying the idempotency key), typed queries and its published events — proven by fully extracting one module (recommended first: **decisions**, the most contract-shaped after Phase 1) with its user flow unchanged.

**Canonical fact owner:** `packages/shared` owns the command/query contract schemas (now runtime-importable, Task 2); the extracted module owns its private persistence.

- [ ] **Step 1: Define the command/query contract shape in shared** (consolidating `contracts.ts` requests + `snapshot/types.ts` responses; runtime-validated on both sides; every command carries the Task-5 idempotency key).
- [ ] **Step 2: Route every other module's use of decisions through its query/command/events** — remove direct service/table access; the snapshot serializer reads it via its query, not its repository.
- [ ] **Step 3: Prove the Phase-1 decision-change acceptance flow unchanged.** **STOP condition:** a consumer needing a direct call names the exact same-transaction query/validation it requires (spec §6 permits only that); anything else becomes an event or a workflow participant.
- [ ] **Step 4: Verify.**

Run: `pnpm check` · contract tests · integration + both acceptance suites unchanged.

**Done criteria:** decisions is reachable only via its contract + events; no other module imports its persistence; its flow + acceptance chain unchanged; contract tests pin its commands/queries/events. **REVIEW STOP (first backend extraction — a narrow pattern review).**

## Task 9: Projection Switch-Over + Module-Owned Frontend State (First Module)

**Business outcome:** The first module's read path moves from the full live-join snapshot to a rebuildable projection + a module-owned frontend query, with a project-shell summary loading first and the atomic-switch guarantees preserved — the pattern the rest of the modules will follow.

**Canonical fact owner:** the module's projection owns its rebuildable read model (with query-time authz); the module's frontend slice owns its query cache; the shell owns identity + nav + projection counts.

- [ ] **Step 1: Projection base + rebuild protocol with a final activation barrier (finding 1, round-2 C).** Checkpoint per `(consumer, projectId, appliedPosition)`; **online rebuild** builds a **replacement generation** from a consistent canonical snapshot and replays events, then closes the handoff race with an explicit barrier: **per project**, acquire the `ProjectEventStream` lock, read the final position **H**, apply through **H** into the replacement generation, and **activate the generation + set its checkpoint to H atomically before releasing the lock** — every event allocated afterward is `> H` and targets the new generation, so nothing commits into the retired one. Cross-project **Portfolio** activates **per project** (or a documented deadlock-safe lock ordering). Relay delivery and rebuild replay **deduplicate on `(consumer, generation, streamPosition)`** so an event applied by both is idempotent. Projection rows carry tenant + subject keys; **serving requires a current-membership/authorization check** (finding 6); membership removal/role change invalidates the affected user-specific rows.
- [ ] **Step 2: Move the first module's read path** (Inbox slice for decisions, or the module's own query) onto its projection, proven equivalent to the Task-1 characterization live-vs-rebuild.
- [ ] **Step 3: Project-shell summary** query (identity, `enabledModules`, projection counts) + **manifest-driven navigation**.
- [ ] **Step 4: Per-module read ownership XOR (finding 7)** — the module is `legacySnapshot` **or** `moduleQuery`, never both; once switched, snapshot application **ignores that module's slice** even if a legacy mutation response still carries it; carry the coordinator's scope-lease/supersession/bounded-reconcile guarantees into the per-module fetch; partition/purge query state by user/session/project/scope-generation. Capability-versioned cutover: additive backend endpoints first, old frontend still works, no physical snapshot-field removal yet.
- [ ] **Step 5: Explicit loading/empty/offline/stale/error states; no demo substitution in API mode.** **STOP condition:** if the per-module query layer can't reproduce the atomic-switch guarantees, the switch invariants win.
- [ ] **Step 6: Verify** with the Phase-0 project-switch scenarios + the module's flow + role/removal/two-project/two-org authz probes + **a held-write exactly at the final activation handoff** (an event committed while the barrier lock is held lands in the new generation `> H`, never the retired one) + **a concurrent relay-vs-rebuild probe** — the activated generation contains every event **exactly once** and its checkpoint **equals** the barrier position H.

Run: `pnpm check` · `api-e2e` (project-scope + the module's chain) · the coordinator's `snapshot-ordering` suite · projection rebuild + activation-barrier + authz probes.

**Done criteria:** the first module runs on a rebuildable projection + module-owned query with query-time authz; shell + nav are manifest-driven; read ownership is XOR; project-switch/stale-response scenarios green unchanged; live == rebuild, and the activation barrier holds every event exactly once with checkpoint == H. **REVIEW STOP (first frontend migration — a narrow pattern review).**

## Task 10: Extract Remaining Modules + Modular Acceptance Suite + Phase 2 Review Packet

**Business outcome:** The remaining modules (activities, drawings, inspections, daily-log) are extracted behind their contracts + projections + frontend queries with flows unchanged, and the whole platform is proven by a per-module test matrix and an end-to-end acceptance run.

**Canonical fact owner:** each extracted module; `docs/reviews/phase-2-review-packet.md` owns the evidence.

- [ ] **Step 1: Extract each remaining module in its OWN PR** (contract + events + projection + frontend query, characterization-guarded). **Do not start the next module until the previous module's contract, boundary, tenant, idempotency and browser evidence clears review** — this bounds late remediation loops.
- [ ] **Step 2: Per-module test matrix (spec §21)** — domain, permission-matrix, PostgreSQL integration, event-contract, projection-rebuild (live==rebuild + rebuild-while-writing), cross-project/organization isolation, migration, browser — for every module.
- [ ] **Step 3: Complete all three cross-cutting projections (round-2 C).** **Inbox, Dashboard AND Portfolio** are each served from their complete rebuildable projections built from the Task-1 dependency matrix — not "one module's query". Each must **match every Task-1 role/user characterization** (author-private drafts preserved, current-membership authorization enforced at query time, two-projects-in-one-org and two-orgs isolation) and **rebuild identically while writes continue** (via the Task-9 activation barrier).
- [ ] **Step 4: Full modular acceptance chain** — the Phase-1 pillar chain over extracted modules + outbox + projections, green unchanged; CI boots the API + relay and runs the API-backed browser flows.
- [ ] **Step 5: Gate sweeps** — the final gate **fails** if any boundary waiver from Task 7 is still present, **or** if any Task-1 command-inventory row is unmigrated onto the `CommandExecution` ledger without an explicitly approved compatibility exception.
- [ ] **Step 6: Phase 2 review packet** (spec §27) + docs (`ARCHITECTURE`/`DATA_MODEL`/`ROADMAP` record Phase 2 implemented; facts/events unlocked for Phase 3 stated). **Step 7: Verify.**

Run: `pnpm check` · full integration suite · both acceptance suites · `upgrade-proof` · the per-module matrix.

**Done criteria:** all modules extracted behind contracts + events + projections + frontend queries with flows unchanged; **Inbox, Dashboard and Portfolio all served from complete rebuildable projections matching the Task-1 characterization**; the §21 matrix green per module; no outstanding boundary waivers and no unmigrated command-inventory rows; CI starts PostgreSQL, applies migrations from zero, boots the API + relay, runs the API-backed browser flows; the packet records the full evidence. **REVIEW STOP — Phase 2 gate.**

---

## Facts and Events Unlocked for Phase 3 (stated at phase completion, spec §24)

Phase 2 completes when the following are dependable connectors for the Material Readiness pilot: the runtime-importable shared contract package; the versioned `DomainEvent` envelope ordered by a gap-safe per-project stream position; the command-idempotency ledger; the per-consumer at-least-once outbox with effectively-once DB effects; the full event catalog (the pillar events `decision.reapproved`/`drawing.issued`/`inspection.decided`/`activity.readiness_changed`/`activity.completed` **plus** archive/restore, membership/role/discipline, draft, recipient/ack and readiness events); the projection framework with the safe rebuild protocol and query-time authorization; and the module registry a `procurement`/`inventory` module registers against. Phase 3 adds modules and consumers — it does not restructure the application.
