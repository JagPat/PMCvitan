# Vitan PMC API — NestJS + Prisma, built from the repo root (workspace install).
# Deploy target: Coolify (Build Pack = Dockerfile, Dockerfile location
# /apps/api/Dockerfile, base directory /). Uses debian-slim (not alpine) to
# avoid Prisma's musl/openssl engine pitfalls. See docs/DEPLOY.md.

# ---- build ----
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.33.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter api prisma:generate
RUN pnpm --filter api build

# ---- run ----
FROM node:22-slim AS run
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@10.33.0
WORKDIR /app
COPY --from=build /app ./
WORKDIR /app/apps/api
ENV PORT=3000
# Mark the runtime as production so the auth hardening engages (see config.ts):
# JWT_SECRET + CORS_ORIGINS become REQUIRED (the API refuses to start without
# them), and phone-OTP self-signup defaults OFF. Set both env vars on the app
# before deploying, or boot fails fast. See docs/AUTH_LOCKDOWN.md.
ENV NODE_ENV=production
EXPOSE 3000
# On start: apply Prisma migrations via scripts/migrate.sh — `migrate deploy`,
# FAIL CLOSED (DEP-02). A pre-baseline database (P3005) is baselined once and
# retried; any other migration failure exits non-zero so the deploy fails
# instead of mutating the schema outside migration history. There is no
# `db push` fallback in production. Seed once, separately: `pnpm --filter api seed`.
#
# Go-live helper: with AUTO_ENSURE_ACCOUNTS=true, boot also runs the
# CREATE-ONLY `ensure-accounts` (creates missing office accounts + org/phase
# backfill; never resets an existing password or resurrects a removed member —
# DEP-01) so real sign-in works and the dev-auth lockdown can't lock anyone
# out. Failure-tolerant and a no-op when the flag is unset. See docs/GO_LIVE.md.
CMD ["sh", "-c", "sh scripts/migrate.sh && { if [ \"$AUTO_ENSURE_ACCOUNTS\" = \"true\" ]; then echo '[boot] ensuring accounts...'; pnpm ensure-accounts || echo '[boot] ensure-accounts failed (non-fatal), continuing'; fi; node dist/main.js; }"]
