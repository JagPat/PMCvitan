# Vitan PMC — Roadmap

Phased delivery, building forward from the [architecture](./ARCHITECTURE.md). Status reflects the current branch.

| Phase | Scope | Status |
|---|---|---|
| **0 — Foundations** | Monorepo (pnpm workspaces), `packages/shared` (types, tokens, i18n, helpers, seed), tsconfig/lint, docs | ✅ Done |
| **1 — Design system + responsive shell** | Tokens → CSS vars; self-hosted fonts; primitives + lucide icons; responsive nav (bottom tabs ↔ left rail); URL-synced routing; session/role + language; Zustand store + `DataGateway`/local gateway seeded with "Residence at Ambli" | ✅ Done |
| **2 — Core decision loop** | Decision Log + Client Decisions + approve → confirm modal → lock → log update + dashboard count + notification | ✅ Done |
| **3 — Inspections** | Engineer checklist (guarded) → PMC review (photo-forward, reject toggles) → re-inspection tasks + failed-count | ✅ Done (UI + logic; checklist↔review wiring is a data-phase item, see below) |
| **4 — Site schedule + gates** | Activities, planned/actual timeline, 4 gate dots, Start (gate-guarded)/Mark-complete → auto closing inspection | ✅ Done |
| **5 — Daily site log + attendance + offline outbox** | Check-in (GPS/selfie), crew steppers, QR worker check-in, materials + mismatch → block, progress photos, connectivity/queue/flush | ✅ Done (UI + in-store outbox; Dexie/PWA outbox is Phase 8) |
| **6 — Team access + i18n + worker job card** | Who-are-you → phone+OTP / trade picker → mistri home; worker no-login "tap photo" → job card; en/hi/gu live toggle | ✅ Done |
| **7 — Backend build-out** | NestJS + Postgres/Prisma API implementing the snapshot + core mutations (approve→lock, change, start/complete, flag-mismatch, inspection submit/decide, daily-log submit) with server-side locked-decision authority, gate recomputation, audit events + notifications; dev auth + RBAC read-filtering; `apiGateway` bridge (hydrate from snapshot, `VITE_API_URL`-gated); Dockerfiles + seed | 🟡 Slice 1 done — see below |
| **7b — Auth, media, realtime** | Real auth (accounts + phone OTP + worker device tokens) replacing dev auth; S3/R2 media upload (geo/time, zoomable); WebSocket notifications / "live from site"; full frontend write-cutover through `apiGateway` | ⏳ Next |
| **8 — Media pipeline + notifications/push + deployment + hardening** | web push, PWA service worker + Dexie outbox, migrations (replace `db push`), CI/CD deploy | ⏳ Planned |

### Phase 7 Slice 1 — what's built vs. deferred

**Built** (`apps/api`, NestJS + Prisma): full Prisma schema + seed for "Residence at Ambli"; `GET /projects/:id/snapshot` (RBAC-filtered); mutations for decisions (approve/change), activities (start/complete → closing inspection), inspections (submit/decide → re-inspection), daily-log (submit, flag-mismatch → block). Locked-decision authority, gate-readiness enforcement, audit events and notifications are server-side. Dev auth (`POST /auth/session` → scoped JWT). Frontend `apiGateway` + snapshot hydration, gated by `VITE_API_URL` (default build unchanged). Domain logic unit-tested; typecheck + build green in CI.

**Deferred to 7b**: real authentication (the current auth is passwordless dev auth); routing the frontend's *write* actions through the gateway (reads hydrate today); media upload; realtime. Also: the sandbox has no Postgres, so the DB-backed paths (snapshot query, mutations, seed) compile and are typed but were not run end-to-end here — validate on first deploy (`docs/DEPLOY.md`).

## Known product gaps (carried forward, not bugs)

- **Checklist ↔ Review are decoupled** in the seeded demo (the submitted `INSP-22` Pre-Tiling checklist does not feed the seeded `INSP-21` Waterproofing review). This mirrors the design prototype exactly; wiring a submitted checklist into the PMC review queue is a Phase 3/7 data task.
- **Swatches are CSS-placeholder gradients** standing in for real materials; Phase 8 replaces them with real geo/time-stamped site photos (photos are first-class, tap/click to zoom).
- **Persona switcher** ("Viewing as") is the temporary session control until auth lands in Phase 7.

## Verify locally

```bash
pnpm install
pnpm --filter web dev         # http://localhost:5173
pnpm --filter web test        # Vitest: helpers + core-loop selectors/reducers
pnpm --filter web test:e2e    # Playwright: approve→lock→dashboard, offline flow
pnpm --filter web build       # tsc -b && vite build
```
