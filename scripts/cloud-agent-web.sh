#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=cloud-agent-env.sh
source scripts/cloud-agent-env.sh
pin_cloud_agent_web_env

pnpm --filter web dev
