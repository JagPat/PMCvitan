# apps/api — Vitan PMC backend (Phase 7)

The API is **architected and scaffolded** here; endpoints are built in Phase 7 (see [../../docs/ROADMAP.md](../../docs/ROADMAP.md)). Until then the frontend runs fully against the local `DataGateway` (the seeded Zustand store), so the product is usable and demoable without a server.

## Stack

- **NestJS** (Fastify adapter) — modular DI for the domain (decision/activity/inspection state machines, RBAC guards, audit interceptors, a WebSocket gateway).
- **Prisma + PostgreSQL** — schema is complete at [`prisma/schema.prisma`](./prisma/schema.prisma) and mirrors the frontend enums in `packages/shared`.
- **ts-rest + Zod** contracts (authored in `packages/shared`, shared by handlers and the typed client).
- **Auth**: JWT accounts (PMC/client/contractor) · phone + OTP (MSG91/Twilio) for team/trade · short-lived device tokens for workers (QR/face identity, no account).
- **Storage**: S3-compatible (Cloudflare R2), signed uploads, geo+timestamp metadata.
- **Realtime**: socket.io gateway + Postgres LISTEN/NOTIFY.

## Planned module layout

```
src/
  main.ts
  app.module.ts
  auth/            # accounts + OTP + worker device tokens; RBAC guards
  projects/
  decisions/       # approve→lock (transactional), change requests, DecisionEvent audit
  inspections/     # checklist submit (guarded) + PMC review + re-inspection
  activities/      # start/complete, gate recomputation, auto closing inspection
  daily-log/       # attendance, crew, materials, mismatch→block, offline replay
  media/           # signed uploads, thumbnails
  notifications/   # feed + WS gateway + web push
  common/          # audit interceptor, idempotency, zod pipes
prisma/schema.prisma
```

## Local dev (once implemented)

```bash
docker compose -f ../../infra/docker-compose.yml up -d   # Postgres
cp .env.example .env
pnpm prisma migrate dev
pnpm start:dev
```
