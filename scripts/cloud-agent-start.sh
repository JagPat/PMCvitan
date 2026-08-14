#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Start PostgreSQL when the cluster exists but is not running (idempotent).
if command -v pg_ctlcluster >/dev/null 2>&1; then
  if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
    sudo pg_ctlcluster 16 main start 2>/dev/null || sudo service postgresql start 2>/dev/null || true
  fi
fi

# Wait for Postgres (bounded).
for _ in $(seq 1 30); do
  if pg_isready -h localhost -p 5432 -q 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  echo "[cloud-agent-start] PostgreSQL is not ready on localhost:5432" >&2
  exit 1
fi

# Dev database role + database (matches infra/docker-compose.yml).
if sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='vitan'" 2>/dev/null | grep -q 1; then
  :
else
  sudo -u postgres psql -c "CREATE USER vitan WITH PASSWORD 'vitan' CREATEDB;"
fi
if sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='vitan_pmc'" 2>/dev/null | grep -q 1; then
  :
else
  sudo -u postgres psql -c "CREATE DATABASE vitan_pmc OWNER vitan;"
fi

# Local env files (never overwrite an existing .env).
if [ ! -f apps/api/.env ]; then
  cp apps/api/.env.example apps/api/.env
  # Dev-friendly defaults for Cloud Agents.
  sed -i 's/^ALLOW_DEV_AUTH=.*/ALLOW_DEV_AUTH="true"/' apps/api/.env
  sed -i 's/^JWT_SECRET=.*/JWT_SECRET="dev-secret-change-in-prod"/' apps/api/.env
fi

if [ ! -f apps/web/.env ]; then
  cp apps/web/.env.example apps/web/.env
  cat > apps/web/.env <<'EOF'
VITE_API_URL="http://localhost:3000"
VITE_ALLOW_DEV_AUTH="true"
EOF
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public}"
PSQL_URL="${DATABASE_URL%%\?*}"

pnpm --filter api prisma:migrate

# Seed once on an empty database (seed wipes and rebuilds — never on every boot).
if ! psql "$PSQL_URL" -tc "SELECT to_regclass('public.\"Project\"')" 2>/dev/null | grep -q Project; then
  echo "[cloud-agent-start] Empty database — running seed"
  pnpm --filter api seed
fi

echo "[cloud-agent-start] Ready (Postgres :5432, API :3000, web :5173)"
