#!/bin/bash
# SessionStart hook — make `pnpm check` and the live-PostgreSQL suites runnable the moment a
# Claude Code on the web session opens.
#
# This repo's tests are not just unit tests: the integration suite runs a REAL Nest app against a
# REAL PostgreSQL database, and `apps/api` imports `@vitan/shared` as a BUILT package plus a
# GENERATED Prisma client. A fresh clone has none of that, and the container's PostgreSQL ships
# stopped — so without this hook the first `pnpm --filter api test:integration` fails on a missing
# module, a missing client, or a refused connection.
#
# Conventions match CI and the repo's own proof scripts exactly (`.github/workflows/ci.yml`,
# `apps/api/scripts/upgrade-proof.sh`): postgres/postgres on localhost:5432, `pmcvitan_test` for the
# integration suite and `pmcvitan_e2e` for the API acceptance suite. Local sessions therefore behave
# the way CI does rather than against some invented setup.
#
# Idempotent and non-interactive: safe to re-run on resume/clear/compact.
set -euo pipefail

# Local machines manage their own toolchain and database; this only provisions the remote container.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  echo "session-start: not a remote session — skipping (set CLAUDE_CODE_REMOTE=true to force)"
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=postgres
INTEGRATION_DB=pmcvitan_test          # `pnpm --filter api test:integration`
E2E_DB=pmcvitan_e2e                   # `pnpm test:e2e:api*` (the seed WIPES this one)
export PGPASSWORD

say() { echo "session-start: $*"; }

# ── 1. workspace dependencies ────────────────────────────────────────────────────────────────
# Pin the SAME pnpm major CI uses (`pnpm/action-setup@v4` with `version: 10`). A bare
# `corepack enable` floats to whatever is latest on npm; when that crosses a major it decides the
# existing store was built by a different pnpm and tries to PURGE node_modules — which in a hook
# has no TTY to confirm, so the install aborts and the session starts with nothing installed.
# Pinning also keeps a local session resolving dependencies exactly the way CI does.
say "pinning pnpm 10 (matching CI)"
corepack prepare pnpm@10 --activate >/dev/null 2>&1 || true

# Non-interactive by construction: pnpm treats CI=true as "never prompt".
export CI=true

# `install` rather than `--frozen-lockfile`: the container image is cached after this hook, and a
# plain install reuses the pnpm store on later sessions.
say "installing workspace dependencies"
pnpm install

# ── 2. artefacts apps/api needs before it can even typecheck ─────────────────────────────────
# @vitan/shared is a real build artefact the compiled API `require()`s, and the Prisma client is
# generated code. Both are gitignored, so a fresh clone has neither.
say "building @vitan/shared"
pnpm build:shared
say "generating the Prisma client"
pnpm --filter api prisma:generate

# ── 3. PostgreSQL ────────────────────────────────────────────────────────────────────────────
# The cluster is installed but ships DOWN, and a reclaimed container can leave a stale pid file.
if ! pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
  say "starting PostgreSQL"
  pg_ctlcluster 16 main start >/dev/null 2>&1 || sudo pg_ctlcluster 16 main start >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1 && break
    sleep 1
  done
fi
if ! pg_isready -h "$PGHOST" -p "$PGPORT" >/dev/null 2>&1; then
  echo "session-start: PostgreSQL did not become ready — the live-PG suites will not run" >&2
  exit 1
fi

# Password auth over TCP, because that is what DATABASE_URL uses. `psql` as the postgres superuser
# goes through the unix socket, which is peer-authenticated and always available to root here.
as_super() { sudo -u postgres psql -v ON_ERROR_STOP=1 -tAc "$1"; }
say "ensuring the postgres role and the two test databases"
as_super "ALTER ROLE postgres WITH PASSWORD '$PGPASSWORD'" >/dev/null
for db in "$INTEGRATION_DB" "$E2E_DB"; do
  exists=$(as_super "SELECT 1 FROM pg_database WHERE datname = '$db'")
  [ "$exists" = "1" ] || as_super "CREATE DATABASE \"$db\" OWNER postgres" >/dev/null
done

# ── 4. schema on the integration database ────────────────────────────────────────────────────
# `migrate deploy` is idempotent — already-applied migrations are skipped — so a resumed session
# costs nothing. The e2e database is migrated + seeded by `scripts/test-api-e2e.sh` at run time
# (that script WIPES it on purpose), so it is deliberately left empty here.
say "applying migrations to $INTEGRATION_DB"
DATABASE_URL="postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$INTEGRATION_DB?schema=public" \
  pnpm --filter api prisma:migrate

# ── 5. session environment ───────────────────────────────────────────────────────────────────
# Every command in the session inherits these, so `pnpm --filter api test:integration` just works.
# JWT_SECRET is a throwaway for this disposable container — never a production value.
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  say "exporting DATABASE_URL + JWT_SECRET for the session"
  {
    echo "export DATABASE_URL=\"postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$INTEGRATION_DB?schema=public\""
    echo "export JWT_SECRET=\"dev-session-secret-not-used-in-production\""
  } >> "$CLAUDE_ENV_FILE"
fi

# `apps/api/.env` is gitignored, so a fresh clone has none and anything reading it directly (rather
# than the exported session env) would fail. Written only when absent — never overwrite a real one.
if [ ! -f apps/api/.env ]; then
  say "writing a development apps/api/.env (gitignored, disposable container only)"
  cat > apps/api/.env <<ENVEOF
# Written by .claude/hooks/session-start.sh for this disposable web-session container.
# Gitignored. Development values only — production config comes from the deploy environment.
DATABASE_URL=postgresql://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$INTEGRATION_DB?schema=public
JWT_SECRET=dev-session-secret-not-used-in-production
PORT=3000
ENVEOF
fi

say "ready — pnpm check, pnpm --filter api test:integration and pnpm test:e2e:api are runnable"
