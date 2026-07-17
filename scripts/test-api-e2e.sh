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

# The suite performs 13+ real sign-ins from one IP — over the login limiter's
# 15-per-10-minutes budget. Disable rate limiting for the harness run; the guard
# honors this ONLY outside production (see src/common/throttle.ts + its tests).
export THROTTLE_DISABLED=true

# PR C Task 5 — dual-mode acceptance. The suite runs in one of two SENDER modes, both proving the
# same user-visible consequences (the browser/API reads come from the DB snapshot, which is
# synchronous in either mode):
#
#   legacy (default) — the in-request ExternalEffectDispatcher is the SOLE external sender; the
#                      background relay runs for RECOVERY but never claims external deliveries in
#                      legacy mode (relayOwnsExternal=false), so there is no double-send.
#   outbox           — the external-effect cutover is SEALED first (in legacy mode, before the API
#                      starts), then the API runs with the background relay as the SOLE external
#                      sender. The startup gate refuses outbox mode without a matching seal.
#
# No fixed sleeps anywhere: the harness polls /health (Playwright webServer `url`) and the specs
# poll user-visible server conditions with bounded `expect.poll`.
E2E_SENDER_MODE="${E2E_SENDER_MODE:-legacy}"
export OUTBOX_RELAY_AUTOSTART=true

# Phase 2 Task 10 (finding 5) — the daily-log module read-ownership mode the web app runs under. The
# default 'snapshot' keeps the daily-log slice on the full snapshot (old behaviour); 'moduleQuery'
# flips the web app onto the module-owned GET …/daily-log read (XOR). The Playwright config forwards
# this to the vite webServer as VITE_DAILYLOG_READ; the daily-log module-query spec runs only under it.
export E2E_DAILYLOG_READ="${E2E_DAILYLOG_READ:-snapshot}"

pnpm --filter api prisma:migrate
pnpm --filter api seed
# the Playwright config serves the COMPILED api (node dist/main.js) — the same
# artifact production runs — so build it first. @vitan/shared is a built runtime
# dependency the compiled API `require()`s, so build it before the API (Phase 2 Task 2).
pnpm --filter @vitan/shared build
pnpm --filter api build

if [ "$E2E_SENDER_MODE" = "outbox" ]; then
  # Cut over BEFORE the API starts: seal the external-effect catalog in legacy mode (the CLI defaults
  # to legacy; OUTBOX_SENDER_MODE is exported only afterwards). The freshly-seeded DB has no domain
  # events, so the seal neutralizes nothing and just pins the compiled coverage the outbox startup
  # gate then requires.
  echo "cutover: sealing the external-effect catalog for outbox-mode acceptance"
  pnpm --filter api outbox:seal-external --operator ci@vitan.in --reason "PR C dual-mode e2e cutover"
  export OUTBOX_SENDER_MODE=outbox
else
  export OUTBOX_SENDER_MODE=legacy
fi

echo "API acceptance — sender mode: $E2E_SENDER_MODE · daily-log read: $E2E_DAILYLOG_READ (relay autostart: $OUTBOX_RELAY_AUTOSTART)"
pnpm --filter web exec playwright test --config playwright.api.config.ts
