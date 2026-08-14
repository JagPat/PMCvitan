#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

corepack enable
corepack prepare pnpm@10.33.3 --activate

pnpm install --frozen-lockfile

pnpm build:shared
pnpm --filter api prisma:generate
pnpm --filter api build

# Browser for Playwright e2e (demo + API acceptance).
cd apps/web
pnpm exec playwright install --with-deps chromium
cd ../..
