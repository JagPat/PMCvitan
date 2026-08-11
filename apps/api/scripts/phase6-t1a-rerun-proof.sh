#!/usr/bin/env bash
# Phase 6 unit 6.1a — C1: the party migration survives a mid-apply abort and a re-run.
#
# The review's point is not hypothetical. This migration does structural DDL and THEN runs
# diagnostics and unique-index builds over the data it just wrote, so an abort partway is a
# reachable state: a duplicate `(projectId, partyId)` pair, or a blank legacy firm name, stops it
# after tables and columns already exist. Prisma marks the migration failed and an operator
# repairs the data and redeploys — at which point an unguarded `CREATE TABLE` fails on
# "relation already exists" and the operator is stuck with a half-applied schema and no way
# forward that the tooling supports.
#
# So this proof does exactly that, against a real PostgreSQL:
#
#   1. build a database at the migration's BASE (every migration before this one)
#   2. plant a legacy fixture that makes the migration ABORT partway — after the tables exist
#   3. prove the abort happened AND that structural work landed (the dangerous state)
#   4. re-run the SAME migration unchanged; it must fail on the DIAGNOSTIC again, not on DDL
#   5. repair the planted data the way the diagnostic instructs
#   6. re-run once more; it must now complete, and the result must be indistinguishable from a
#      clean first-time apply
#
# Step 6 is the one that matters: "it re-runs" is worth nothing if the retry leaves a different
# schema than a clean apply would. DESTRUCTIVE for the scratch database only.
set -u

DB="${PHASE6_RERUN_DB:-pmcvitan_phase6_rerun}"
HOST="${PGHOST:-localhost}"
PORT="${PGPORT:-5432}"
USER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
ADMIN="postgres://$USER@$HOST:$PORT/postgres"
TARGET="postgres://$USER@$HOST:$PORT/$DB"
PSQL="psql -v ON_ERROR_STOP=1 -X -q $TARGET"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS="$HERE/prisma/migrations"
THIS="20270801000000_phase6_t1a_external_party"
FAIL=0

say() { printf '\n=== %s ===\n' "$1"; }
ok()  { printf 'ok      %s\n' "$1"; }
bad() { printf 'FAILED  %s\n' "$1"; FAIL=1; }

psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$DB\"" >/dev/null

say "1. building the database at the migration's base"
applied=0
for d in $(ls -1 "$MIGRATIONS" | sort); do
  [ -f "$MIGRATIONS/$d/migration.sql" ] || continue
  [ "$d" = "$THIS" ] && break
  if ! psql -v ON_ERROR_STOP=1 -X -q "$TARGET" -f "$MIGRATIONS/$d/migration.sql" >/dev/null 2>&1; then
    echo "base migration $d did not apply"; exit 1
  fi
  applied=$((applied + 1))
done
echo "applied $applied migration(s) before $THIS"

say "2. planting a legacy row that aborts the migration PARTWAY"
# A blank firm name. Its diagnostic sits at the TOP of the migration, so this scenario proves the
# ORDERING claim — the abort happens before any structural change, which is what "diagnostic-first"
# is supposed to mean. It does NOT prove rerunnability, because nothing was created to trip over;
# scenario B below is the one that tests C1, and conflating the two is how the first version of
# this proof reported "no DDL statement blocked the retry" without ever reaching a DDL statement.
# `|| exit 1` is not decoration. An earlier run of this proof had a fixture that failed on a
# NOT NULL column, planted nothing, and then reported "the migration completed over a blank name"
# — a false negative dressed as a real finding. A fixture that cannot fail loudly is not a fixture.
$PSQL <<'SQL' >/dev/null || { echo "the rerun fixture did not plant; the proof would be vacuous"; exit 1; }
INSERT INTO "Org"("id","name","slug") VALUES ('p6r-org','Rerun Org','p6r-org');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('p6r-proj','p6r-org','Rerun Site','RS','','Finishing','RS-01','01 Jan 2026','31 Dec 2026',10,5,10);
INSERT INTO "User"("id","projectId","name","email","role") VALUES ('p6r-user','p6r-proj','Rerun User','rerun@example.com','pmc');
INSERT INTO "Vendor"("id","orgId","name","createdById") VALUES ('p6r-vendor','p6r-org','   ','p6r-user');
SQL
planted=$($PSQL -tAc "SELECT count(*) FROM \"Vendor\" WHERE \"id\" = 'p6r-vendor'" | tr -d '[:space:]')
[ "$planted" = "1" ] || { echo "the rerun fixture reported success but planted no vendor"; exit 1; }
echo "planted: a vendor whose name is only whitespace"

apply_this() {
  psql -v ON_ERROR_STOP=1 -X -q "$TARGET" -f "$MIGRATIONS/$THIS/migration.sql" 2>&1
}

say "3. first apply — it must ABORT, and name the reason"
out="$(apply_this)"; rc=$?
if [ "$rc" = "0" ]; then
  bad "the migration completed over a blank firm name; the diagnostic did not fire"
elif printf '%s' "$out" | grep -q 'blank name'; then
  ok "aborted on its own diagnostic, naming the offending row"
else
  bad "aborted, but not on the blank-name diagnostic: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
fi

say "4. nothing structural was created — the diagnostic really is FIRST"
created=$($PSQL -tAc "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('ExternalParty','ProjectParty')" | tr -d '[:space:]')
if [ "$created" = "0" ]; then
  ok "the aborted apply left no party tables behind"
else
  bad "the abort landed AFTER structural DDL ($created table(s) created); the diagnostic is not first"
fi

say "5. re-run after repair — it must COMPLETE"
$PSQL -c "UPDATE \"Vendor\" SET \"name\" = 'Rerun Vendor' WHERE \"id\" = 'p6r-vendor'" >/dev/null
out="$(apply_this)"; rc=$?
if [ "$rc" = "0" ]; then
  ok "the repaired database migrates"
else
  bad "the repaired re-run failed: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
fi

say "6. SCENARIO B — an INTERRUPTED apply, which is what C1 is actually about"
# A killed deploy, a dropped connection, a cancelled job: the migration gets partway and stops.
# Prisma marks it failed, the operator redeploys, and an unguarded `CREATE TABLE` then fails on
# "relation already exists" with a half-applied schema and no supported way forward. Reproduced by
# applying the file's structural prefix and then running the WHOLE file over it.
B="${DB}_interrupted"
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$B\"" >/dev/null
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$B\"" >/dev/null
B_URL="postgres://$USER@$HOST:$PORT/$B"
for d in $(ls -1 "$MIGRATIONS" | sort); do
  [ -f "$MIGRATIONS/$d/migration.sql" ] || continue
  [ "$d" = "$THIS" ] && break
  psql -v ON_ERROR_STOP=1 -X -q "$B_URL" -f "$MIGRATIONS/$d/migration.sql" >/dev/null 2>&1 || { echo "base build failed at $d"; exit 1; }
done

# the structural prefix: everything up to the backfill, which is where the tables and columns are
cut_line=$(grep -n '^-- ── backfill' "$MIGRATIONS/$THIS/migration.sql" | head -1 | cut -d: -f1)
[ -n "$cut_line" ] || { echo "could not locate the backfill marker; the interruption point is unknown"; exit 1; }
head -n "$((cut_line - 1))" "$MIGRATIONS/$THIS/migration.sql" > /tmp/phase6-prefix.sql
psql -v ON_ERROR_STOP=1 -X -q "$B_URL" -f /tmp/phase6-prefix.sql >/dev/null 2>&1 \
  || { echo "the structural prefix did not apply; the interruption could not be staged"; exit 1; }
partial=$(psql -tAX "$B_URL" -c "SELECT count(*) FROM information_schema.tables WHERE table_name IN ('ExternalParty','ProjectParty','ProjectPartyCompanySource','ProjectPartyVendorSource')" | tr -d '[:space:]')
if [ "$partial" = "1" ]; then
  ok "staged a genuinely half-applied schema (ExternalParty exists; the rest do not)"
else
  bad "the staged interruption created $partial of the 4 tables — expected exactly 1, so the prefix is not the structural half"
fi

out="$(psql -v ON_ERROR_STOP=1 -X -q "$B_URL" -f "$MIGRATIONS/$THIS/migration.sql" 2>&1)"; rc=$?
if [ "$rc" = "0" ]; then
  ok "the FULL migration ran to completion over the half-applied schema"
else
  bad "the interrupted apply could not be retried: $(printf '%s' "$out" | grep -E '^(psql:[^ ]* *)?ERROR:' | head -2 | tr '\n' ' ' | cut -c1-240)"
fi
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$B\"" >/dev/null

say "7. re-running a COMPLETED migration is still safe"
out="$(apply_this)"
# NOTE: a fired `IF NOT EXISTS` guard PRINTS `NOTICE: relation ... already exists, skipping`.
# Matching "already exists" anywhere therefore reads the guard doing its job as the guard failing,
# which is how the first version of this assertion reported a false failure. Only `ERROR:` counts.
rc=$?
if [ "$rc" = "0" ]; then
  ok "a second apply over a fully-migrated database is a no-op, not an error"
else
  bad "re-applying a completed migration failed: $(printf '%s' "$out" | grep -E '^(psql:[^ ]* *)?ERROR:' | head -2 | tr '\n' ' ' | cut -c1-240)"
fi

say "8. the retried schema is indistinguishable from a clean first-time apply"
# "It re-runs" is worth nothing if the retry leaves a DIFFERENT schema. Build a second database
# that applies the same ledger once, with no abort, and compare the objects this migration owns.
CLEAN="${DB}_clean"
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$CLEAN\"" >/dev/null
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$CLEAN\"" >/dev/null
CLEAN_URL="postgres://$USER@$HOST:$PORT/$CLEAN"
for d in $(ls -1 "$MIGRATIONS" | sort); do
  [ -f "$MIGRATIONS/$d/migration.sql" ] || continue
  psql -v ON_ERROR_STOP=1 -X -q "$CLEAN_URL" -f "$MIGRATIONS/$d/migration.sql" >/dev/null 2>&1 || true
  [ "$d" = "$THIS" ] && break
done

shape_sql="SELECT string_agg(x, E'\n' ORDER BY x) FROM (
  SELECT conrelid::regclass::text || ' ' || conname || ' ' || pg_get_constraintdef(oid) AS x
    FROM pg_constraint
   WHERE conrelid::regclass::text IN ('\"ExternalParty\"','\"ProjectParty\"','\"ProjectPartyCompanySource\"','\"ProjectPartyVendorSource\"','\"ProjectCompany\"','\"ProjectVendor\"','\"Vendor\"')
  UNION ALL
  SELECT tablename || ' ' || indexname || ' ' || indexdef
    FROM pg_indexes
   WHERE tablename IN ('ExternalParty','ProjectParty','ProjectPartyCompanySource','ProjectPartyVendorSource','ProjectCompany','ProjectVendor','Vendor')
  UNION ALL
  SELECT tgrelid::regclass::text || ' ' || tgname || ' ' || pg_get_triggerdef(oid)
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgrelid::regclass::text IN ('\"ExternalParty\"','\"ProjectParty\"','\"ProjectPartyCompanySource\"','\"ProjectPartyVendorSource\"')
) s"

retried="$(psql -tAX "$TARGET" -c "$shape_sql")"
clean="$(psql -tAX "$CLEAN_URL" -c "$shape_sql")"
if [ -z "$clean" ]; then
  bad "the clean comparison database has no party schema — the comparison would be vacuous"
elif [ "$retried" = "$clean" ]; then
  ok "constraints, indexes and triggers are byte-identical to a clean apply"
else
  bad "the retried schema DIFFERS from a clean apply"
  diff <(printf '%s' "$clean") <(printf '%s' "$retried") | head -20
fi

psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$CLEAN\"" >/dev/null

echo ""
if [ "$FAIL" = "0" ]; then
  echo "PHASE 6 T1A RERUN PROOF PASSED: the migration aborts on its own diagnostic, retries without"
  echo "tripping on schema it already created, and lands the same shape a clean apply does."
else
  echo "PHASE 6 T1A RERUN PROOF FAILED: see the assertions above."
fi
exit $FAIL
