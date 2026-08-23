#!/usr/bin/env bash
# Schedule B1 — F1: the migration must SURVIVE the P3005 baseline path it is left pending for.
#
# `scripts/migrate.sh` lists `20270930000000_schedule_dependency_graph` in ALWAYS_EXECUTE, so on a
# pre-baseline database — one created by `prisma db push`, with no `_prisma_migrations` table —
# every OTHER migration is resolved as applied and this one is left PENDING, deliberately, so its
# raw CHECKs and triggers really execute. `schema.prisma` cannot describe a CHECK or a trigger, so
# recording it as applied would claim guards that never existed.
#
# That entry and a whole-table object refusal cannot both be right. On exactly this database the
# table EXISTS (Prisma models it) and is NOT what the migration installs (a push produces no CHECK
# and no trigger), so a migration that refused any table it did not create would abort on the one
# path the entry exists to serve. This proof runs the REAL production runner over the REAL shape
# and requires the deploy to complete with the guards in force.
#
# Reproduce-first: step 3 runs the closed PR #363's recognition predicate against the same database
# and requires it to RAISE, so the failure is demonstrated rather than described.
#
# DESTRUCTIVE for the scratch database only.
set -u

DB="${B1_PROOF_DB:-pmcvitan_b1_baseline}"
HOST="${PGHOST:-localhost}"; PORT="${PGPORT:-5432}"; USER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
ADMIN="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/postgres"
URL="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/$DB?schema=public"
PSQL="psql -v ON_ERROR_STOP=1 -X -q postgresql://$USER:$PGPASSWORD@$HOST:$PORT/$DB"
API="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THIS="20270930000000_schedule_dependency_graph"
FAIL=0

cd "$API" || exit 1
say() { printf '\n=== %s ===\n' "$1"; }
ok()  { printf 'ok      %s\n' "$1"; }
bad() { printf 'FAILED  %s\n' "$1"; FAIL=1; }

say "1. a PRE-BASELINE database whose ActivityDependency has the TABLE and none of the guards"
# This is the state the ALWAYS_EXECUTE entry exists for, built the way it really arises: a database
# that RAN the deployed migrations (so the raw guards from every earlier unit are in force) but has
# no `_prisma_migrations` ledger, and whose schema has since been reconciled against the current
# `schema.prisma` — which models `ActivityDependency` and therefore produces the table, its columns,
# its foreign keys and its two modelled indexes, but no CHECK, no partial unique and no trigger.
#
# A database with no ledger AND no raw guards at all is a different case, and `migrate.sh` already
# refuses it by name (`prerequisite-seals-missing`, docs/RUNBOOK.md §P4T3C3): reconciling that shape
# is a human judgement about which objects are really missing. This proof is about the shape the
# runner does proceed on.
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$DB\"" >/dev/null
# Built with `prisma migrate deploy`, not by piping each file through psql: several deployed
# migrations use LOCK TABLE, which psql cannot run outside a transaction block. This unit's own
# migration is moved aside for the base build and restored immediately afterwards.
HOLD="$(mktemp -d)"
mv "prisma/migrations/$THIS" "$HOLD/$THIS"
restore_migration() { [ -d "$HOLD/$THIS" ] && mv "$HOLD/$THIS" "prisma/migrations/$THIS"; rmdir "$HOLD" 2>/dev/null; }
trap restore_migration EXIT
DATABASE_URL="$URL" npx prisma migrate deploy >/tmp/b1-base.log 2>&1 \
  || { bad "the base migration set did not apply"; tail -20 /tmp/b1-base.log; exit 1; }
restore_migration; trap - EXIT
ok "applied every deployed unit except $THIS, so their raw guards are in force"

# The db-push-shaped table: exactly what `schema.prisma` models, and nothing it cannot express.
$PSQL >/dev/null <<'SQL' || { echo "the pre-baseline fixture did not build"; exit 1; }
CREATE TABLE "ActivityDependency" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "predecessorId" TEXT NOT NULL,
  "successorId" TEXT NOT NULL, "lagWorkingDays" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL, "createdByName" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3), "revokedById" TEXT, "revokedByName" TEXT,
  CONSTRAINT "ActivityDependency_pkey" PRIMARY KEY ("id"));
CREATE INDEX "ActivityDependency_projectId_predecessorId_idx" ON "ActivityDependency"("projectId","predecessorId");
CREATE INDEX "ActivityDependency_projectId_successorId_idx" ON "ActivityDependency"("projectId","successorId");
ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_projectId_predecessorId_fkey"
  FOREIGN KEY ("projectId","predecessorId") REFERENCES "Activity"("projectId","id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_projectId_successorId_fkey"
  FOREIGN KEY ("projectId","successorId") REFERENCES "Activity"("projectId","id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_createdBy_fkey"
  FOREIGN KEY ("projectId","createdById") REFERENCES "Membership"("projectId","userId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_revokedBy_fkey"
  FOREIGN KEY ("projectId","revokedById") REFERENCES "Membership"("projectId","userId") ON DELETE NO ACTION ON UPDATE NO ACTION;
DROP TABLE IF EXISTS "_prisma_migrations";
SQL
ledger=$($PSQL -tAc "SELECT to_regclass('public._prisma_migrations') IS NULL" | tr -d '[:space:]')
[ "$ledger" = "t" ] && ok "no _prisma_migrations table — migrate deploy will answer P3005" \
                    || bad "the fixture has a migration ledger; it is not a pre-baseline database"

shape=$($PSQL -tAc "SELECT (to_regclass('public.\"ActivityDependency\"') IS NOT NULL)::text
                        || '/' || (SELECT COUNT(*) FROM pg_constraint
                                    WHERE conrelid = 'public.\"ActivityDependency\"'::regclass
                                      AND contype = 'c')::text
                        || '/' || (SELECT COUNT(*) FROM pg_trigger
                                    WHERE tgrelid = 'public.\"ActivityDependency\"'::regclass
                                      AND NOT tgisinternal)::text" | tr -d '[:space:]')
[ "$shape" = "true/0/0" ] \
  && ok "the TABLE is present and none of its guards are (table/checks/triggers = $shape)" \
  || bad "unexpected pre-baseline shape: $shape (expected true/0/0)"

say "2. PR #363's recognition predicate, run against that database"
# Verbatim in substance: recognize the four triggers by name, relid, enabled state, bound function
# and exact tgtype, and RAISE if any is absent. Nothing about it is wrong in isolation — it is the
# COMBINATION with the ALWAYS_EXECUTE entry that cannot work.
red=$($PSQL 2>&1 <<'SQL'
DO $$
DECLARE v_wrong TEXT;
BEGIN
  IF to_regclass('public."ActivityDependency"') IS NULL THEN RETURN; END IF;
  SELECT string_agg(x, ', ' ORDER BY x) INTO v_wrong FROM (
    SELECT 'trigger ' || e.name AS x
      FROM (VALUES ('ActivityDependency_acyclic',     'activity_dependency_acyclic',      7),
                   ('ActivityDependency_frozen',      'activity_dependency_frozen',      19),
                   ('ActivityDependency_no_delete',   'activity_dependency_no_delete',   11),
                   ('ActivityDependency_no_truncate', 'activity_dependency_no_truncate', 34))
             AS e(name, fn, tgtype)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_trigger g
        WHERE g.tgname = e.name AND g.tgrelid = 'public."ActivityDependency"'::regclass
          AND NOT g.tgisinternal AND g.tgenabled = 'O'
          AND g.tgfoid::regproc::text = e.fn AND g.tgtype = e.tgtype)) q;
  IF v_wrong IS NOT NULL THEN
    RAISE EXCEPTION 'schedule: "ActivityDependency" already exists but is not the table this migration installs — % absent or not in force.', v_wrong;
  END IF;
END $$;
SQL
)
case "$red" in
  *'already exists but is not the table this migration installs'*)
    ok "REPRODUCED: the object refusal fires on the very database the ALWAYS_EXECUTE entry serves" ;;
  *) bad "the object refusal did NOT fire — this proof would be vacuous. Output: $red" ;;
esac

say "3. the REAL production runner over that database"
# migrate.sh runs three COMPILED preflights before Prisma, so the build has to exist — this is the
# production path, not a stand-in for it.
pnpm --filter @vitan/shared build >/tmp/b1-shared.log 2>&1 || { bad "shared build failed"; tail -10 /tmp/b1-shared.log; exit 1; }
pnpm --filter api build >/tmp/b1-api.log 2>&1 || { bad "api build failed"; tail -20 /tmp/b1-api.log; exit 1; }
for a in dist/platform/t45/t45.cli.js dist/labour/t2c/t2c.cli.js dist/labour/t3c/t3c.cli.js; do
  [ -f "$a" ] || { bad "compiled preflight artifact missing: $a"; exit 1; }
done

OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 on the pre-baseline database" \
                || { bad "migrate.sh exited $RC"; printf '%s\n' "$OUT" | tail -25; }
printf '%s\n' "$OUT" | grep -q "leaving $THIS pending" \
  && ok "and left $THIS PENDING rather than resolving it as applied" \
  || bad "the ALWAYS_EXECUTE entry did not take effect"

say "4. the guards are really there, and really bind"
after=$($PSQL -tAc "SELECT (SELECT COUNT(*) FROM pg_constraint
                             WHERE conrelid = 'public.\"ActivityDependency\"'::regclass
                               AND contype = 'c' AND convalidated)::text
                        || '/' || (SELECT COUNT(*) FROM pg_trigger
                                    WHERE tgrelid = 'public.\"ActivityDependency\"'::regclass
                                      AND NOT tgisinternal AND tgenabled = 'O')::text
                        || '/' || (SELECT COUNT(*) FROM pg_index ix JOIN pg_class ci ON ci.oid = ix.indexrelid
                                    WHERE ci.relname = 'ActivityDependency_projectId_successorId_predecessorId_key'
                                      AND ix.indisunique AND ix.indisvalid AND ix.indpred IS NOT NULL)::text" \
        | tr -d '[:space:]')
[ "$after" = "4/5/1" ] \
  && ok "four validated CHECKs, five armed triggers, the partial unique index ($after)" \
  || bad "guards missing after the baseline deploy: $after (expected 4/5/1)"
recorded=$($PSQL -tAc "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '$THIS' AND finished_at IS NOT NULL" | tr -d '[:space:]')
[ "$recorded" = "1" ] && ok "and the ledger records it as APPLIED because it ran, not because it was resolved" \
                      || bad "the migration is not recorded as applied ($recorded)"

# A guard in the catalog is not a guard that binds. One hostile write proves the difference.
$PSQL >/dev/null 2>&1 <<'SQL'
INSERT INTO "Org"("id","name","slug") VALUES ('b1-org','B1','b1-org');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('b1-proj','b1-org','B1 Site','B1','','Planning','B1-01','01 Jan 2026','31 Dec 2026',0,0,0);
INSERT INTO "User"("id","projectId","name","email","role") VALUES ('b1-user','b1-proj','B1 User','b1@example.com','pmc');
INSERT INTO "Membership"("id","projectId","userId","role","status") VALUES ('b1-mem','b1-proj','b1-user','pmc','active');
INSERT INTO "Activity"("id","projectId","name","zone","plannedStart","plannedEnd")
  VALUES ('b1-a','b1-proj','A','Z',0,1),('b1-b','b1-proj','B','Z',0,1);
INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName")
  VALUES ('b1-e1','b1-proj','b1-a','b1-b','b1-user','B1 User');
SQL
cyc=$($PSQL -c "INSERT INTO \"ActivityDependency\"(\"id\",\"projectId\",\"predecessorId\",\"successorId\",\"createdById\",\"createdByName\") VALUES ('b1-e2','b1-proj','b1-b','b1-a','b1-user','B1 User')" 2>&1)
case "$cyc" in
  *'dependency cycle'*) ok "the acyclicity trigger REFUSES a cycle on this database" ;;
  *) bad "the cycle guard did not bind after the baseline deploy: $cyc" ;;
esac

say "5. and the deploy is re-runnable over its own result"
OUT2="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC2=$?
[ "$RC2" = "0" ] && ok "a second migrate.sh over the same database exits 0" \
                 || { bad "the second migrate.sh exited $RC2"; printf '%s\n' "$OUT2" | tail -15; }
edges=$($PSQL -tAc "SELECT COUNT(*) FROM \"ActivityDependency\"" | tr -d '[:space:]')
[ "$edges" = "1" ] && ok "and left the one legitimate edge untouched" || bad "the re-run disturbed the rows ($edges)"

psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null
printf '\n'
[ "$FAIL" = "0" ] && { echo "schedule B1 baseline proof: PASSED"; exit 0; }
echo "schedule B1 baseline proof: FAILED"; exit 1
