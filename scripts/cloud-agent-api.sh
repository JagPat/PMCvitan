#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=cloud-agent-env.sh
source "$(dirname "$0")/cloud-agent-env.sh"

apply_api_env_defaults
pnpm --filter api start
