#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=cloud-agent-env.sh
source "$(dirname "$0")/cloud-agent-env.sh"

resolve_database_url
PSQL_URL="$(psql_database_url "$DATABASE_URL")"
DB_LABEL="$(database_url_log_label "$DATABASE_URL")"

if [ "$DATABASE_URL" = "$DEFAULT_DATABASE_URL" ]; then
  # Local compose-equivalent Postgres on the VM.
  if command -v pg_ctlcluster >/dev/null 2>&1; then
    if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
      sudo pg_ctlcluster 16 main start 2>/dev/null || sudo service postgresql start 2>/dev/null || true
    fi
  fi

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

  if ! psql "$PSQL_URL" -tc "SELECT 1" >/dev/null 2>&1; then
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
  fi
else
  # Cursor secret / external Postgres — connect to the configured URL only.
  for _ in $(seq 1 30); do
    if psql "$PSQL_URL" -tc "SELECT 1" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done

  if ! psql "$PSQL_URL" -tc "SELECT 1" >/dev/null 2>&1; then
    echo "[cloud-agent-start] Database is not reachable at ${DB_LABEL}" >&2
    exit 1
  fi
fi

ensure_api_env

if [ ! -f apps/web/.env ]; then
  cat >apps/web/.env <<'EOF'
VITE_API_URL="http://localhost:3000"
VITE_ALLOW_DEV_AUTH="true"
EOF
fi

pnpm --filter api prisma:migrate

if seed_permitted; then
  if ! psql "$PSQL_URL" -tc "SELECT 1 FROM \"Project\" WHERE id = '${SEED_PROJECT_ID}'" 2>/dev/null | grep -q 1; then
    echo "[cloud-agent-start] No seed project '${SEED_PROJECT_ID}' — running seed"
    pnpm --filter api seed
  fi
else
  echo "[cloud-agent-start] Skipping seed (external DATABASE_URL; set CLOUD_AGENT_ALLOW_SEED=true to opt in)"
fi

echo "[cloud-agent-start] Ready (Postgres :5432, API :3000, web :5173)"
