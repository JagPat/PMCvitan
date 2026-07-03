# Vitan PMC

**Vitan PMC** is a project-management console for an architect-led Project Management Consultancy (Vitan Architecture, Ahmedabad) — the single source of truth between the architect/PMC, the client, the contractor, and the site engineer on construction projects the practice has designed.

Built from a hi-fi design handoff into a **production-responsive** web app, with a full-stack architecture the greenfield product grows on. Sample project throughout: **"Residence at Ambli, Ahmedabad"** (G+2 private residence, finishing stage).

## The three pillars

1. **Client Decision Log** — every client decision is recorded with options, the approved choice, cost impact and approver, then **locked**; changes go through a formal Change Request.
2. **Stage-wise Quality Inspections** — the site engineer fills a photo checklist; the architect approves/rejects remotely; rejections auto-create re-inspection tasks.
3. **Site Activity spine** — every activity has planned-vs-actual dates and four **readiness gates** (Decision · Material · Team · Inspection); attendance ("the phone is the attendance device"), materials and progress photos all resolve to activities.

## Monorepo

```
apps/web         React + TS + Vite SPA — production-responsive, offline-capable   (built)
apps/api         NestJS + Prisma REST/ts-rest API                                  (Phase 7)
packages/shared  domain types · design tokens · i18n (en/hi/gu) · helpers · seed
infra            docker-compose (Postgres) for local dev
docs             ARCHITECTURE · DATA_MODEL · ROADMAP
```

The web app runs against a typed **`DataGateway`** — today the seeded in-memory store (works offline, no backend needed); Phase 7 swaps in the API implementation without touching the screens. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

## Getting started

```bash
pnpm install
pnpm dev            # web app at http://localhost:5173
```

All 9 screens, 4 roles (PMC / Client / Engineer / Contractor via the "Viewing as" persona switch), 3 languages (English / हिंदी / ગુજરાતી) and every core flow are live against seeded data — resize the window to see the layout adapt from bottom-tabs (mobile) to left-rail (tablet/desktop).

## Scripts

| Command | What |
|---|---|
| `pnpm dev` | Vite dev server (web) |
| `pnpm build` | Typecheck + production build (web) |
| `pnpm test` | Vitest — helpers + core-loop selectors/reducers |
| `pnpm test:e2e` | Playwright — approve→lock→dashboard + offline flow |
| `pnpm typecheck` / `pnpm lint` | Types / lint |

## Tech

React 18 · TypeScript · Vite · Zustand (+ immer) · React Router · i18next · lucide-react · CSS-variable design tokens + CSS Modules · Vitest + Playwright. Backend (Phase 7): NestJS · Prisma · PostgreSQL · ts-rest. See [docs/ROADMAP.md](./docs/ROADMAP.md) for phase status.
