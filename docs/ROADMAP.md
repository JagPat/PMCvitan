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
| **7 — Backend build-out** | NestJS + Postgres/Prisma + auth (accounts + OTP + worker tokens) + storage + realtime; swap `DataGateway` → `apiGateway`; server-side RBAC + audit + locked-decision authority | ⏳ Next (schema + contract sketch in place) |
| **8 — Media pipeline + notifications/push + deployment + hardening** | Real photo upload (geo/time), zoomable viewers, web push, PWA service worker + Dexie outbox, CI/CD deploy | ⏳ Planned |

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
