# Vitan PMC — Architecture

**Vitan PMC** is a project-management console for an architect-led Project Management Consultancy (Vitan Architecture, Ahmedabad). It is the single source of truth between the architect/PMC, the client, the contractor, and the site engineer on construction projects the practice has designed.

This document is the overall technical framework. The product is being built forward from it in phases (see [ROADMAP.md](./ROADMAP.md)); the data model is in [DATA_MODEL.md](./DATA_MODEL.md).

## Product pillars

1. **Client Decision Log** — every client decision (flooring, veneer, sanitaryware, layout) is recorded with the options presented, the approved choice, photos, cost impact, and approver, then **locked**. Later changes go through a formal **Change Request** re-approved by the client.
2. **Stage-wise Quality Inspections** — the site engineer fills a checklist with mandatory photos; the architect approves or rejects remotely; rejected items auto-create re-inspection tasks.
3. **Site Activity spine** — every unit of work has planned-vs-actual dates and four **readiness gates** (Decision locked · Material on site · Team present · Inspection passed). An activity can only *Start* when its gates are green, and only be marked *Done* after its closing inspection. Attendance ("the phone is the attendance device"), material presence, and progress photos all resolve to activities and dates.

## System shape

A **decoupled SPA + API** in a **pnpm + (optional) Turborepo monorepo**, with a shared TypeScript package as the single source of truth for domain types, design tokens, i18n, and (Phase 7) the API contract.

```
apps/web      React + TS + Vite SPA (production-responsive)   ← built
apps/api      NestJS + Prisma REST/ts-rest API                 ← Phase 7 (schema + plan in place)
packages/shared  BUILT runtime pkg — domain types · tokens · i18n · civil-date/format helpers · readiness truth tables · authz policy · seed  ← built (Phase 2 Task 2)
infra         docker-compose (Postgres) for local dev
```

## Frontend (`apps/web`) — built

| Concern | Choice |
|---|---|
| Framework | React 18 + TypeScript + **Vite** |
| Navigation | In-store active screen synced to the URL (`RouteBridge`), role-guarded; production nav = **bottom tabs (mobile) ↔ persistent left rail (tablet/desktop)** |
| State | **Zustand + immer** — a faithful port of the prototype's single logic class; cross-slice flows expressed directly. Derived values live in **pure selectors**, never stored |
| Data seam | A typed **`DataGateway`** interface (`src/data/gateway.ts`). Today the store is the local gateway (offline-capable, seeded). Phase 7 adds an `apiGateway` (ts-rest + TanStack Query) implementing the same contract — screens don't change |
| Design system | Design tokens as **CSS variables** (`styles/tokens.css`) + TS constants (`packages/shared/tokens`, authoritative for JS-computed styles); **CSS Modules** for responsive layout + inline styles for fine visual detail; **lucide-react** icons (functional glyphs, per the handoff) |
| i18n | **i18next** synced to the store + a `useT()` hook over the shared dictionaries (en / hi / gu), live-switching |
| Fonts | Self-hosted via `@fontsource` (Archivo / IBM Plex Mono / Newsreader) — no network dependency, works offline and in CI |
| Offline-first | The store's mutation outbox (`syncQueue`) queues while offline and flushes on reconnect. Phase 5/8 promotes this to a Dexie/IndexedDB outbox + a PWA service worker |
| Testing | **Vitest** (helpers + store/selectors, headless) and **Playwright** (core loop + offline flow, Chromium) |

_Note: the styling layer uses CSS Modules + design-token CSS variables rather than a utility framework — the deliberate choice for a pixel-precise recreation of the hi-fi design with a minimal dependency surface. Tailwind can be layered on later without disturbing the token layer._

### Responsive strategy (mobile-first, adaptive)

- **< 640px** — single column; **bottom tab bar**; sticky bottom actions.
- **640–1024px** — navigation moves to a **persistent left rail**; content gains columns where useful.
- **> 1024px** — left rail + multi-column grids (dashboard 2×2, full-width schedule timeline).
- Engineer/Worker stay single-column and large-target even on tablet. **Client screens "grow up" on large screens** (larger type, capped reading measure, enlarged photos). 44px+ touch targets; hover affordances behind `@media (hover: hover)`.

## Backend (`apps/api`) — Phase 7 (architected now)

| Concern | Choice | Rationale |
|---|---|---|
| Runtime/framework | **Node 22 + NestJS** (Fastify adapter) | Modular DI fits a domain-rich app: state machines (decision/activity/inspection lifecycles), RBAC guards, audit interceptors, a WebSocket gateway |
| Shared runtime package | `@vitan/shared` is a **BUILT dual CJS/ESM package** (Phase 2 Task 2) — the single runtime source of domain types, tokens, i18n, civil-date/format helpers, the derived-readiness truth tables, the authorization policy and seed, imported by **both** web and the CommonJS API (the former hand-mirrored copies are retired). | One source of truth, no drift |
| API contract | **ts-rest + Zod** command/query contracts — authored in `@vitan/shared` at **Phase 2 Task 8** (the package is already a built runtime dependency as of Task 2) | End-to-end types like tRPC but durable REST — mobile/future-client friendly |
| ORM/DB | **Prisma + PostgreSQL** | Strong relationships, transactional locking, append-only audit, enum state machines. Schema: `apps/api/prisma/schema.prisma` |
| Auth | JWT accounts (PMC/client/contractor) · **phone + OTP** (MSG91/Twilio) for team/trade · short-lived device tokens for **workers** (QR/face identity, no account) | Mirrors the product principle: *separate identity from accounts* — only managers get accounts; builders are recognised and handed the right picture |
| Media | **S3-compatible object storage** (Cloudflare R2) + signed uploads; geo + timestamp metadata; thumbnails | Photos are first-class and zoomable everywhere |
| Realtime | **WebSocket gateway** (socket.io) + Postgres LISTEN/NOTIFY; web push (FCM) later | Notification bell + "live from site" strip |

## Cross-cutting invariants

- **Locked decisions are server-authoritative** — once approved, immutable; changes are append-only Change Requests. Every approval is time-stamped and attributed ("Approved by Mr. Shah · 12 Jun 2026").
- **Readiness gates are derived, not stored** — decision, inspection and drawing gates are computed at read time from explicit links by first-match truth tables (see Phase 1 below); approving a decision immediately flips the relevant activity gate.
- **Offline-first** — daily-log mutations apply locally and queue when offline; reconnect flushes with idempotency keys.
- **Permission-filtered data** — contractor & engineer never see pending decisions; each role sees only its screens.

## Phase 0 trust foundation (implemented)

The contract behind the [Phase 0 plan](./superpowers/plans/2026-07-12-phase-0-trust-foundation.md) — current behavior, not aspiration:

- **Modular monolith.** One NestJS application (`apps/api`) with feature modules behind one `AppModule`; one PostgreSQL database; no microservices. `configureApp()` (`src/app-setup.ts`) is shared by the production bootstrap and the integration harness so tests exercise the shipped proxy/CORS/body-limit behavior. `GET /health` is a public process-health probe (no auth, no database).
- **Frontend project-scope lifecycle.** All project data lives behind an explicit state machine — `idle → switching → loading → ready | error` (`apps/web/src/store/projectScope.ts`). A switch **clears project data before** the `/auth/switch` request, adopts the **server-returned** project verbatim, and stamps every snapshot request with a `(projectId, generation)` scope; a response whose scope no longer matches is discarded. `RouteBridge` treats an actual URL change as a navigation request (deep link / back-forward) and a store change as authority for the URL — never the reverse, so a completed switch is not "corrected" back by its own stale path. `ProjectLoadBoundary` renders screens only when their data is trustworthy.
- **PostgreSQL integration gate.** CI's `api` job runs the integration suite (`apps/api/test/integration`) against a real PostgreSQL 16 service — live membership authorization, composite-FK reference integrity and real-date behavior are proven on the real engine, never mocked.
- **Two-project acceptance gate.** CI's `api-e2e` job seeds a deterministic two-project fixture and drives the browser through the eight Phase 0 scenarios (`apps/web/tests/e2e-api/project-scope.spec.ts`) against the compiled API — auth landing, atomic switch, deep links, history, non-member 403, live revocation, cross-project reference rejection, and empty-project truthfulness. Run locally with `DATABASE_URL=<disposable> pnpm test:e2e:api`.

## Phase 1 pillar completion (implemented)

The contract behind the [Phase 1 plan](./superpowers/plans/2026-07-13-phase-1-existing-pillars.md) — current behavior, not aspiration:

- **Locked decisions and the change loop.** An approved decision is immutable except through a `ChangeRequest`; the database allows at most ONE open request per decision (partial unique index `ChangeRequest_one_open_per_decision`), and re-approval resolves the open request and the decision atomically in one transaction, attributed to the actor (id + name + role, `onBehalfOf` recorded when the PMC acts for the client). While a request is open, the decision's readiness reading is `wait` — construction never proceeds on a reopened choice.
- **One governing revision, frozen distribution.** Exactly one `for_construction` revision can be live per drawing (partial unique index `DrawingRevision_one_construction_per_drawing`; issue/publish serialize on the parent Drawing row). Issuing `for_construction` freezes the recipient set as `DrawingRecipient` rows (`recipientsFrozenAt` is the persisted discriminator; legacy revisions keep it NULL) — acknowledgements are counted against that frozen set, never against the live team roster. A new revision of an existing drawing keeps the drawing's recorded activity/decision/node linkage unless the issue explicitly names one.
- **Evidence containment chain.** A failed checklist item requires linked photo evidence: `Media(projectId, inspectionId)` proves the inspection belongs to the project, `Media(inspectionId, inspectionItemId)` proves the item belongs to THAT inspection, and a CHECK closes PostgreSQL's MATCH SIMPLE escape — a forged cross-project or cross-inspection evidence row is rejected by the database itself (raw-SQL proven). Uploads are idempotent per project-scoped `clientKey`; offline captures are durably queued in IndexedDB, never reported saved before they are, and non-dedupe terminal failures dead-letter with Retry/Delete instead of silently deleting bytes.
- **Rejection produces owned corrective work.** A PMC rejection creates exactly one linked reinspection (unique on the predecessor edge), assigned with a due date to an active, role-eligible assignee — validated INSIDE the lifecycle transaction with a `FOR UPDATE` row lock on the membership so a concurrent removal/role change cannot slip through.
- **Done means signed off.** Marking work complete is a CAS claim `in_progress → awaiting_signoff` that records the completer and opens a linked closing inspection; ONLY approving that closing inspection writes `done` (+ `doneAt`), and rejecting it reverts the activity and routes corrective work to the recorded completer while that identity is still active and eligible.
- **Readiness derives from explicit links; overrides are attributable.** The five gates (decision / inspection / drawing / material / team) are derived at read time by first-match truth tables over explicit edges only — an unrelated inspection in the same room never moves a gate; drawing readiness aggregates worst-wins across every linked drawing; an open reinspection chain fails the inspection gate until its tip is decided clean. The canonical derivation lives in `packages/shared/src/domain/readiness.ts` and is **imported at runtime by both** the web and the API (`apps/api/src/domain/transitions.ts` re-exports it from the built `@vitan/shared` — Phase 2 Task 2; the former pinned copy is retired), so there is one implementation and one set of table tests. A `GateOverride` is PMC-only with actor, reason, optional same-project evidence and a mandatory future expiry, audited on grant and revoke; `start()` requires every gate `ok|na` after overrides.
- **One canonical audit writer, uniformly attributed.** Every consequential state change records its `AuditLog` row through a single kernel function, `recordAudit(db, entry)` in `apps/api/src/platform/audit.ts` — there is no longer a second convention where older sites wrote a bare `actor: user.role` with a null `actorId`. Attribution comes from a resolved `Actor` (`apps/api/src/common/actor.ts`): `resolveActor` for a signed-in human (`actorKind: 'human'`, real `actorId`/`actorName`/`actorRole`), `systemActor` for a named system process (`actorKind: 'system'`), so an audit row and the Task-4 `DomainEvent` that shares the same `Actor` always agree on who acted. A source tripwire (`apps/api/src/platform/audit.test.ts`) fails CI if any file other than `platform/audit.ts` calls `auditLog.create` (Phase 2 Task 3). No schema change beyond Phase 1 — `actorKind` is persisted with the event envelope in Task 4.
- **Every consequential change appends one immutable, tenant-consistent, gap-safe-ordered domain event.** Alongside its canonical write, each mutation calls `emitEvent(tx, …)` (`apps/api/src/platform/events.ts`) INSIDE the same transaction, appending a `DomainEvent` whose `streamPosition` comes from locking + incrementing the project's `ProjectEventStream` counter — so ordering is `(projectId, streamPosition)`, never `occurredAt` (display/audit only), and two concurrent commits on one project get distinct, contiguous positions that can never be skipped. The tenant `organizationId` is DERIVED from the project (a composite `(organizationId, projectId) → Project(orgId, id)` FK rejects a forged org); attribution is a database CHECK (a `human` event needs a real `actorId`, a `system` event a named `systemActor`); and the store is **append-only enforced by a `BEFORE UPDATE OR DELETE` trigger** that raises for every role. The shared envelope + catalog live in `packages/shared/src/platform/events.ts`; `Project.orgId` is NOT NULL and every project auto-gets its stream counter via an `AFTER INSERT` trigger. This is the project-scoped event store (Phase 2 Task 4) — org-scoped events, projections and the transactional outbox are later tasks. Events are dual-written: existing responses/snapshots are byte-for-byte unchanged.
- **Upgrade evidence.** `apps/api/scripts/upgrade-proof.sh` (CI job `upgrade-proof`) rebuilds a pre-Phase-1 database from the real ledger, plants legacy shapes (pending change requests, revisions without projectId, counter-only items, zero-item closings, stored gate flags), applies all Phase 1 migrations the way Prisma does and asserts every legacy meaning survived. Each migration is diagnostic-first and ABORTS on ambiguous legacy data rather than guessing.
- **Pillar-chain acceptance gate.** CI's `api-e2e` job drives the full chain in a real browser against the compiled API and seeded PostgreSQL (`apps/web/tests/e2e-api/pillar-chain.spec.ts`): decision → approval → frozen drawing distribution → linked checklist → fail-with-photo → rejection → Inbox reinspection → pass with evidence → start → complete → closing sign-off → done, plus the change loop, negative/isolation probes and offline evidence survival.

## Deployment (target)

Web → Cloudflare Pages / Vercel · API → Fly.io / Render · DB → Neon / Supabase · storage → Cloudflare R2 · CI → GitHub Actions.
