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

## When the Phase 7 API lands

- Add a **PostgreSQL** resource in Coolify (or use the managed DB of your choice).
- Add a second **Application** for `apps/api` (its own Dockerfile), set `DATABASE_URL` and the secrets from `apps/api/.env.example`, expose its port.
- Give the web app a build-time `VITE_API_URL` env pointing at the API, and switch the `DataGateway` from the local store to the `apiGateway`. No screen changes are required — that seam is already in place (`apps/web/src/data/gateway.ts`).
