# Deploying Vitan PMC

## What deploys today

The **web app** (`apps/web`) is a self-contained static SPA that runs fully against its seeded data — no backend required — so it deploys as a single container and makes a complete live demo. The API (`apps/api`) is Phase 7; add it as a second resource once implemented (see the bottom of this page).

The repo ships a root **`Dockerfile`** (build with pnpm → serve the built SPA with nginx, with client-side-routing fallback) and **`infra/nginx.conf`**. This is the recommended path for Coolify because the monorepo (web imports `packages/shared`) builds most reliably from a Dockerfile.

## Deploy on Coolify

1. **Connect the repo** — in Coolify, add this GitHub repository as a source (GitHub App or a deploy key).
2. **New Application** → choose this repo, branch **`main`**.
3. **Build Pack: Dockerfile.**
   - Base directory: `/`
   - Dockerfile location: `/Dockerfile`
4. **Ports Exposes: `80`** (General → Network). The nginx container listens on **80**. Coolify pre-fills this with `3000` — if you leave it at 3000 the proxy can't reach nginx and you get **`Bad Gateway`** (a 502), even though the container shows *healthy*. Set it to `80` and Save.
5. **Environment variables** — none needed for the frontend (it runs against seeded data).
6. **Deploy.** Coolify builds the image and serves it. Client-side routes (e.g. `/schedule`, `/client/decisions`) resolve via the nginx SPA fallback, and hashed assets are long-cached while `index.html` is `no-cache` so new deploys are picked up immediately.

Every push to the configured branch redeploys (enable auto-deploy in Coolify if you want CD).

## Custom domain with HTTPS (e.g. `pms.vitan.in`)

1. **DNS** — at your DNS provider for `vitan.in`, add an **A record**:
   `pms` → your Coolify server's public IP (the IP shown in the auto-generated `*.sslip.io` domain, e.g. `187.127.151.239`). Wait for it to resolve (`dig pms.vitan.in +short`).
2. **Coolify → Configuration → General → Domains** — set:
   `https://pms.vitan.in`
   (include the `https://` scheme — that's what tells Coolify/Traefik to request a TLS certificate). You can keep or remove the generated `sslip.io` domain. Leave **Direction** as *Allow www & non-www*.
3. **Save**, then **Redeploy**. Traefik obtains a **Let's Encrypt** certificate automatically (HTTP-01 challenge) and adds an HTTP→HTTPS redirect, so `https://pms.vitan.in` goes live.

Requirements for the automatic certificate: the A record must resolve to the server, and ports **80 and 443** must be open on it (they are by default for a standard Coolify install). No app rebuild is needed — the SPA serves at the domain root and makes no absolute-URL calls.

### Verifying a build locally (optional)

```bash
docker build -t vitan-pmc-web .
docker run --rm -p 8080:80 vitan-pmc-web
# open http://localhost:8080
```

## Backend API + PostgreSQL (Phase 7)

The API (`apps/api`, NestJS + Prisma) ships its own `apps/api/Dockerfile`. Deploy it as a second resource:

1. **PostgreSQL** — add a Postgres resource in Coolify (or use a managed DB). Note its connection string.
2. **API Application** — new Application → this repo, branch `main` → **Build Pack: Dockerfile**, Dockerfile location `/apps/api/Dockerfile`, base dir `/`, **Ports Exposes: `3000`**. Set env from `apps/api/.env.example` — at minimum `DATABASE_URL` (the Postgres string) and a strong `JWT_SECRET`. On start the container runs `scripts/migrate.sh` (`prisma migrate deploy`, **fail closed**): a fresh database gets every table from the baseline migration; a failed migration exits non-zero so the deploy fails and the previous container keeps running — there is deliberately **no `db push` fallback** in production (a transient failure must never mutate a live schema outside migration history).
3. **Seed once** — from the API container's terminal (Coolify → Terminal): `pnpm --filter api seed` to load the "Residence at Ambli" sample project. (Re-running the seed wipes and reloads — don't run it on every start.)
4. **Point the web app at the API** — set a build-time env on the *web* application: `VITE_API_URL=https://<your-api-domain>` and redeploy it. On load, the frontend authenticates for the active role and hydrates from `/projects/ambli/snapshot`; with the var unset it stays on the seeded local store (current behaviour). The bridge lives in `apps/web/src/data/apiGateway.ts` — no screen changes.

> The API image and the frontend↔API bridge compile and are unit-tested, but the end-to-end wiring hasn't been exercised in CI (no Postgres in the build sandbox). Validate the first API deploy: check the container Logs for `Vitan PMC API listening on :3000`, then hit `GET /projects/ambli/snapshot` with a token from `POST /auth/session`.

### Cutting over the external providers (MSG91 / R2 / VAPID)

The app ships with dev-stubs for SMS OTP, media storage, and web push; each flips to its real provider by setting env vars on the API app + redeploying — no code change. The full runbook (env vars, human prerequisites, Coolify-API steps for a hands-off cutover, live validation commands with expected output, failure modes, rollback, and the agent-vs-human autonomy boundary) is in **[`PROVIDER_CUTOVER.md`](./PROVIDER_CUTOVER.md)**. Check current live state any time with `bash scripts/validate-live.sh`.

> **Private file delivery (media & drawings).** Files are never public: `GET /media/:id` and `GET /drawings/rev/:id` require a short-lived `?t=` token that the API mints only inside the RBAC-filtered snapshot / on upload. When you cut over to S3/R2, **make the bucket private (disable public read)** — the API presigns a short-lived GET per request, so a public bucket would defeat the point. Optional: `FILE_URL_TTL_SEC` (default `3600`) tunes how long a signed file link stays valid; lower is more secure, but if it's shorter than how long a user views a page without a snapshot refetch, images may need a reload. `S3_PUBLIC_BASE` is no longer used for serving.

### Migrations & the existing (db-push) database

The schema is now tracked by a baseline Prisma migration at `apps/api/prisma/migrations/0_init`. Going forward, schema changes are new migrations applied by `prisma migrate deploy` on deploy.

**Baseline for a pre-migrations live DB** (one created with `db push`, so its tables already exist but Prisma has no migration history): `scripts/migrate.sh` handles this automatically — when `migrate deploy` fails with **P3005** ("database schema is not empty"), it marks every existing migration as applied (`prisma migrate resolve --applied …`) and retries. This runs at most once; afterwards `migrate deploy` is a no-op on the live DB and applies only *new* migrations. Any **other** migration failure exits non-zero and fails the deploy — recovery on a production database is an explicit, operator-reviewed action, never an automatic schema sync. Fresh databases need no baselining — `migrate deploy` creates everything.
