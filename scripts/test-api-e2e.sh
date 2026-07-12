#!/usr/bin/env bash
# Phase 0 Task 8 — the API-backed two-project acceptance gate.
#
# DESTRUCTIVE ON PURPOSE: the seed WIPES the database and rebuilds the
# deterministic two-project fixture, so DATABASE_URL must point at a DISPOSABLE
# PMCvitan test database. It must NEVER point at production — the script refuses
# to run when it is absent rather than guess a default.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point to a disposable PMCvitan test database (the seed WIPES it)}"
: "${JWT_SECRET:=api-e2e-test-secret}"
export JWT_SECRET

pnpm --filter api prisma:migrate
pnpm --filter api seed
# the Playwright config serves the COMPILED api (node dist/main.js) — the same
# artifact production runs — so build it first
pnpm --filter api build
pnpm --filter web exec playwright test --config playwright.api.config.ts
