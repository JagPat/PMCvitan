#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

DEFAULT_DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public'
SEED_PROJECT_ID='ambli'

set_env_var() {
  local file="$1" key="$2" value="$3"
  touch "$file"
  if grep -q "^${key}=" "$file"; then
    local escaped="${value//\\/\\\\}"
    escaped="${escaped//|/\\|}"
    sed -i "s|^${key}=.*|${key}=\"${escaped}\"|" "$file"
  else
    echo "${key}=\"${value}\"" >>"$file"
  fi
}

export DATABASE_URL="${DATABASE_URL:-$DEFAULT_DATABASE_URL}"
PSQL_URL="${DATABASE_URL%%\?*}"

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
    echo "[cloud-agent-start] Database is not reachable at ${PSQL_URL}" >&2
    exit 1
  fi
fi

if [ ! -f apps/api/.env ]; then
  cp apps/api/.env.example apps/api/.env
fi

# Dev-friendly cloud defaults — empty CORS_ORIGINS lets resolveCorsOrigins() reflect preview origins.
set_env_var apps/api/.env DATABASE_URL "$DATABASE_URL"
set_env_var apps/api/.env JWT_SECRET "dev-secret-change-in-prod"
set_env_var apps/api/.env ALLOW_DEV_AUTH "true"
set_env_var apps/api/.env CORS_ORIGINS ""

if [ ! -f apps/web/.env ]; then
  cat >apps/web/.env <<'EOF'
VITE_API_URL="http://localhost:3000"
VITE_ALLOW_DEV_AUTH="true"
EOF
fi

pnpm --filter api prisma:migrate

# Seed once when demo data is absent (migrations create empty tables).
if ! psql "$PSQL_URL" -tc "SELECT 1 FROM \"Project\" WHERE id = '${SEED_PROJECT_ID}'" 2>/dev/null | grep -q 1; then
  echo "[cloud-agent-start] No seed project '${SEED_PROJECT_ID}' — running seed"
  pnpm --filter api seed
fi

echo "[cloud-agent-start] Ready (Postgres :5432, API :3000, web :5173)"
