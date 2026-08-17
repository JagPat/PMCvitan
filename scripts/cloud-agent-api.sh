#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=cloud-agent-env.sh
source scripts/cloud-agent-env.sh
pin_cloud_agent_api_env

# Nest needs emitDecoratorMetadata. `tsx watch src/main.ts` (package start:dev)
# cannot emit it, so this terminal compiles watched source into dist and restarts
# the compiled entry when either the TypeScript graph or dist/main.js changes.
pnpm --filter api exec tsc -p tsconfig.json --watch --preserveWatchOutput &
tsc_pid=$!
trap 'kill "$tsc_pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if [[ -f apps/api/dist/main.js ]]; then
    break
  fi
  sleep 0.2
done
if [[ ! -f apps/api/dist/main.js ]]; then
  echo '[cloud-agent-api] dist/main.js was not produced by the watched compiler' >&2
  exit 1
fi

pnpm --filter api exec node --watch dist/main.js
