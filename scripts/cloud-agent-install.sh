#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=cloud-agent-env.sh
source scripts/cloud-agent-env.sh
pin_cloud_agent_api_env

corepack enable
corepack prepare pnpm@10.33.3 --activate

if ! command -v psql >/dev/null 2>&1 || ! command -v pg_isready >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo '[cloud-agent-install] PostgreSQL is missing and this image has no apt-get installer' >&2
    exit 1
  fi
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-client
fi

pnpm install --frozen-lockfile
pnpm build:shared
pnpm --filter api prisma:generate
pnpm --filter api build
pnpm --filter web exec playwright install --with-deps chromium
