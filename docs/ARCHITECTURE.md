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
packages/shared  domain types · design tokens · i18n · helpers · seed
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
| API contract | **ts-rest + Zod** contracts in `packages/shared` | End-to-end types like tRPC but durable REST — mobile/future-client friendly |
| ORM/DB | **Prisma + PostgreSQL** | Strong relationships, transactional locking, append-only audit, enum state machines. Schema: `apps/api/prisma/schema.prisma` |
| Auth | JWT accounts (PMC/client/contractor) · **phone + OTP** (MSG91/Twilio) for team/trade · short-lived device tokens for **workers** (QR/face identity, no account) | Mirrors the product principle: *separate identity from accounts* — only managers get accounts; builders are recognised and handed the right picture |
| Media | **S3-compatible object storage** (Cloudflare R2) + signed uploads; geo + timestamp metadata; thumbnails | Photos are first-class and zoomable everywhere |
| Realtime | **WebSocket gateway** (socket.io) + Postgres LISTEN/NOTIFY; web push (FCM) later | Notification bell + "live from site" strip |

## Cross-cutting invariants

- **Locked decisions are server-authoritative** — once approved, immutable; changes are append-only Change Requests. Every approval is time-stamped and attributed ("Approved by Mr. Shah · 12 Jun 2026").
- **Readiness gates are derived, not stored** — the Decision gate is computed live from the linked decision's status, so approving a decision immediately flips the relevant activity gate.
- **Offline-first** — daily-log mutations apply locally and queue when offline; reconnect flushes with idempotency keys.
- **Permission-filtered data** — contractor & engineer never see pending decisions; each role sees only its screens.

## Deployment (target)

Web → Cloudflare Pages / Vercel · API → Fly.io / Render · DB → Neon / Supabase · storage → Cloudflare R2 · CI → GitHub Actions.
