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
EXPOSE 3000
# On start: sync the schema to the database, then boot. (Seed once, separately:
# `pnpm --filter api seed`.)
CMD ["sh", "-c", "pnpm prisma:push --accept-data-loss --skip-generate && node dist/main.js"]
