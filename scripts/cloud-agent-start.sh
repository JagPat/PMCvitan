#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=cloud-agent-env.sh
source scripts/cloud-agent-env.sh
pin_cloud_agent_api_env

exec 9>/tmp/vitan-pmc-cloud-agent-start.lock
flock 9

if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  sudo service postgresql start >/dev/null 2>&1 || true
fi

for _ in $(seq 1 30); do
  if pg_isready -h localhost -p 5432 -q 2>/dev/null; then
    break
  fi
  sleep 1
done

if ! pg_isready -h localhost -p 5432 -q 2>/dev/null; then
  echo '[cloud-agent-start] PostgreSQL is not ready on localhost:5432' >&2
  exit 1
fi

if ! sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'vitan'" | grep -qx 1; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -c "CREATE ROLE vitan LOGIN PASSWORD 'vitan' CREATEDB"
fi
if ! sudo -u postgres psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'vitan_pmc'" | grep -qx 1; then
  sudo -u postgres createdb --owner=vitan vitan_pmc
fi

pnpm --filter api prisma:migrate
(
  cd apps/api
  CLOUD_AGENT_SEED_IF_COMPLETE=true ./node_modules/.bin/tsx prisma/seed.ts
)

echo '[cloud-agent-start] Ready (Postgres :5432, API :3000, web :5173)'
