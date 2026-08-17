#!/usr/bin/env bash
# Phase 6 unit 4b-i, round 15 — DOES `prisma migrate deploy` apply a migration file atomically?
#
# This exists because a review finding (round 15, F2) argued that `20270815000000`'s opening
# `LOCK TABLE` is released at the next statement boundary, leaving a window between its audit and
# the seals it installs. The finding cited this repository's OWN prose as evidence: a comment in
# `20270225000000_phase4_t3_correction3` asserting "Prisma runs the file statement by statement, so
# every statement boundary is a commit". That comment was wrong, and being wrong it cost a review
# round — so the answer is settled here by execution instead of by another comment.
#
# The mechanism is PostgreSQL's, not Prisma's: a multi-statement string sent through the simple
# query protocol runs in an IMPLICIT transaction, so either all of it commits or none of it does.
# The probe below is the direct test — a migration whose first statement creates a table and whose
# second divides by zero. If the table survives, statements commit independently and the finding is
# right. If it does not, the file is atomic and every `LOCK TABLE` in it is held to the end.
#
# Usage: bash apps/api/scripts/prisma-migration-atomicity-proof.sh
set -euo pipefail

cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL must be set}"
PGURL="${DATABASE_URL%%\?*}"
BASE="${PGURL%/*}"
# the harness refuses a scratch database whose name does not say what it is
DB_NAME="pmcvitan_migration_atomicity_test"
SCRATCH="$BASE/$DB_NAME"
PROBE="prisma/migrations/29990101000000_zz_atomicity_probe"

cleanup() {
  rm -rf "$PROBE"
  psql "$BASE/postgres" -qc "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== building a scratch database ($DB_NAME) ==="
psql "$BASE/postgres" -qc "DROP DATABASE IF EXISTS $DB_NAME WITH (FORCE)" >/dev/null 2>&1 || true
psql "$BASE/postgres" -qc "CREATE DATABASE $DB_NAME" >/dev/null

echo "=== planting a two-statement migration whose SECOND statement fails ==="
mkdir -p "$PROBE"
cat > "$PROBE/migration.sql" <<'SQL'
CREATE TABLE "zz_atomicity_probe" ("id" INT);
SELECT 1/0;
SQL

echo "=== applying the whole ledger, ending with the probe (the failure is expected) ==="
if DATABASE_URL="$SCRATCH?schema=public" pnpm prisma migrate deploy >/dev/null 2>&1; then
  echo "FAILED: the probe migration was expected to fail on its second statement and did not"
  exit 1
fi

SURVIVED=$(psql "$SCRATCH" -tAc "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='zz_atomicity_probe';")
if [ "$SURVIVED" != "0" ]; then
  echo "FAILED: statement 1 COMMITTED even though statement 2 aborted."
  echo "        Prisma applies migration files statement by statement, so a LOCK TABLE taken at the"
  echo "        top of a file is NOT held through the rest of it. Round 15's F2 is CORRECT and"
  echo "        20270815000000 must be restructured. See docs/reviews/pr-344-convergence.md."
  exit 1
fi

echo "ok      statement 1 rolled back with statement 2 — the migration file is ONE transaction"
echo "ok      therefore 20270815000000's LOCK TABLE is held from line 40 through the last seal,"
echo "        and the window round 15's F2 describes does not exist under 'prisma migrate deploy'"
echo ""
echo "ATOMICITY PROOF PASSED"
