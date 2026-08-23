#!/usr/bin/env bash
# Schedule B1 — the migration must behave correctly on the P3005 BASELINE PATH it is left pending
# for, in BOTH of the two states that path can present.
#
# `scripts/migrate.sh` lists `20270930000000_schedule_dependency_graph` in ALWAYS_EXECUTE, so on a
# pre-baseline database — one with no `_prisma_migrations` table — every OTHER migration is
# resolved as applied and this one is left PENDING, deliberately, so its raw CHECKs and triggers
# really execute. `schema.prisma` cannot describe a CHECK or a trigger, so recording it as applied
# would claim guards that never existed.
#
# The migration CREATES "ActivityDependency" and does not adopt one, so that path has two states
# and this proof executes both against the REAL production runner:
#
#   A. the table is ABSENT — every deployed database. migrate.sh must install the guards, record
#      the migration as applied because it RAN, leave them binding, and be re-runnable.
#   B. the table is PRESENT (a `prisma db push`-shaped reconciliation). migrate.sh must ABORT,
#      naming the table and docs/RUNBOOK.md section B1, WITHOUT recording the migration as
#      applied — and the documented repair (drop the empty table) must let the same runner deploy.
#
# COUPLING is proven rather than asserted (step 5): with the ALWAYS_EXECUTE entry removed from a
# copy of migrate.sh, state A's guards do not arrive. So a mutation to the baseline path fails this
# script, and this script runs in the required `api` job — the wiring itself is pinned by
# `scripts/ci-baseline-proof-wiring.test.mjs`, which is in `pnpm test:automation`.
#
# DESTRUCTIVE for the scratch databases only.
set -u

DB="${B1_PROOF_DB:-pmcvitan_b1_baseline}"
DB2="${DB}_adopt"
HOST="${PGHOST:-localhost}"; PORT="${PGPORT:-5432}"; USER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"
ADMIN="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/postgres"
BARE="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/$DB"
BARE2="postgresql://$USER:$PGPASSWORD@$HOST:$PORT/$DB2"
URL="$BARE?schema=public"
URL2="$BARE2?schema=public"
PSQL="psql -v ON_ERROR_STOP=1 -X -q $BARE"
PSQL2="psql -v ON_ERROR_STOP=1 -X -q $BARE2"
API="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THIS="20270930000000_schedule_dependency_graph"
FAIL=0

cd "$API" || exit 1
say() { printf '\n=== %s ===\n' "$1"; }
ok()  { printf 'ok      %s\n' "$1"; }
bad() { printf 'FAILED  %s\n' "$1"; FAIL=1; }

# Build a pre-baseline database: every deployed unit applied through `prisma migrate deploy` (so
# the raw guards from every earlier unit are really in force), then the ledger dropped. Built with
# the runner rather than by piping each file through psql, because several deployed migrations use
# LOCK TABLE, which psql cannot run outside a transaction block. This unit's own migration is moved
# aside for the base build and restored immediately afterwards.
HOLD=""
restore_migration() {
  [ -n "$HOLD" ] && [ -d "$HOLD/$THIS" ] && mv "$HOLD/$THIS" "prisma/migrations/$THIS"
  [ -n "$HOLD" ] && rmdir "$HOLD" 2>/dev/null
  HOLD=""
  return 0
}
# `url` is Prisma's (it carries `?schema=public`); `bare` is psql's. They are NOT interchangeable:
# psql rejects the query string outright — `invalid URI query parameter: "schema"` — and takes the
# invocation down with it, which is silent enough to leave a ledger in place and make the whole
# proof measure the wrong path.
prebaseline() {
  local db="$1" url="$2" bare="$3"
  psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$db\"" >/dev/null
  psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$db\"" >/dev/null
  HOLD="$(mktemp -d)"
  mv "prisma/migrations/$THIS" "$HOLD/$THIS"
  trap restore_migration EXIT
  DATABASE_URL="$url" npx prisma migrate deploy >/tmp/b1-base.log 2>&1 || {
    restore_migration; trap - EXIT
    bad "the base migration set did not apply to $db"; tail -20 /tmp/b1-base.log; return 1; }
  restore_migration; trap - EXIT
  psql -v ON_ERROR_STOP=1 -X -q "$bare" -c 'DROP TABLE IF EXISTS "_prisma_migrations"' >/dev/null
  return 0
}

# The three COMPILED preflights migrate.sh runs before Prisma have to exist — this is the
# production path, not a stand-in for it. Built once, up front, for every step below.
say "0. the compiled artifacts the production runner requires"
pnpm --filter @vitan/shared build >/tmp/b1-shared.log 2>&1 || { bad "shared build failed"; tail -10 /tmp/b1-shared.log; exit 1; }
pnpm --filter api build >/tmp/b1-api.log 2>&1 || { bad "api build failed"; tail -20 /tmp/b1-api.log; exit 1; }
for a in dist/platform/t45/t45.cli.js dist/labour/t2c/t2c.cli.js dist/labour/t3c/t3c.cli.js; do
  [ -f "$a" ] || { bad "compiled preflight artifact missing: $a"; exit 1; }
done
ok "the three compiled preflights are present, so migrate.sh runs its real path"

# ══ STATE A — the table is ABSENT, which is every deployed database ═══════════════════════════
say "1. a PRE-BASELINE database with no ActivityDependency and no migration ledger"
prebaseline "$DB" "$URL" "$BARE" || exit 1
ok "applied every deployed unit except $THIS, then dropped the ledger"
absent=$($PSQL -tAc "SELECT (to_regclass('public.\"ActivityDependency\"') IS NULL)::text
                        || '/' || (to_regclass('public._prisma_migrations') IS NULL)::text" | tr -d '[:space:]')
[ "$absent" = "true/true" ] \
  && ok "the table is absent and there is no ledger — migrate deploy will answer P3005 ($absent)" \
  || bad "unexpected state-A shape: $absent (expected true/true)"

say "2. the REAL production runner installs the guards on that database"
OUT="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC=$?
[ "$RC" = "0" ] && ok "migrate.sh exited 0 on the pre-baseline database" \
                || { bad "migrate.sh exited $RC"; printf '%s\n' "$OUT" | tail -25; }
printf '%s\n' "$OUT" | grep -q "leaving $THIS pending" \
  && ok "and left $THIS PENDING rather than resolving it as applied" \
  || bad "the ALWAYS_EXECUTE entry did not take effect"

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
$PSQL >/dev/null <<'SQL' || { bad "the state-A fixture rows did not build"; }
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
  *'dependency cycle'*) ok "and the acyclicity trigger REFUSES a cycle on this database" ;;
  *) bad "the cycle guard did not bind after the baseline deploy: $cyc" ;;
esac

say "3. and the deploy is re-runnable over its own result"
# The ledger now records the migration, so Prisma has nothing pending and never re-reads the file.
# That is what re-runnability means on this path — not that the file is idempotent.
OUT2="$(DATABASE_URL="$URL" sh scripts/migrate.sh 2>&1)"; RC2=$?
[ "$RC2" = "0" ] && ok "a second migrate.sh over the same database exits 0" \
                 || { bad "the second migrate.sh exited $RC2"; printf '%s\n' "$OUT2" | tail -15; }
edges=$($PSQL -tAc "SELECT COUNT(*) FROM \"ActivityDependency\"" | tr -d '[:space:]')
[ "$edges" = "1" ] && ok "and left the one legitimate edge untouched" || bad "the re-run disturbed the rows ($edges)"

# ══ STATE B — the table is PRESENT, the `db push` shape ═══════════════════════════════════════
say "4. a PRE-BASELINE database that ALREADY HAS the table: abort, then the documented repair"
prebaseline "$DB2" "$URL2" "$BARE2" || exit 1
# Exactly what `schema.prisma` models, and nothing it cannot express: the columns, the primary key,
# the foreign keys and the two modelled indexes — no CHECK, no partial unique, no trigger.
$PSQL2 >/dev/null <<'SQL' || { bad "the db-push-shaped fixture did not build"; exit 1; }
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
SQL
shape=$($PSQL2 -tAc "SELECT (to_regclass('public.\"ActivityDependency\"') IS NOT NULL)::text
                        || '/' || (SELECT COUNT(*) FROM pg_constraint
                                    WHERE conrelid = 'public.\"ActivityDependency\"'::regclass AND contype = 'c')::text
                        || '/' || (SELECT COUNT(*) FROM pg_trigger
                                    WHERE tgrelid = 'public.\"ActivityDependency\"'::regclass AND NOT tgisinternal)::text" | tr -d '[:space:]')
[ "$shape" = "true/0/0" ] \
  && ok "the TABLE is present and none of its guards are (table/checks/triggers = $shape)" \
  || bad "unexpected state-B shape: $shape (expected true/0/0)"

OUT3="$(DATABASE_URL="$URL2" sh scripts/migrate.sh 2>&1)"; RC3=$?
[ "$RC3" != "0" ] && ok "migrate.sh REFUSES this database (exit $RC3) rather than baselining over it" \
                  || bad "migrate.sh exited 0 over a table it did not create"
case "$OUT3" in
  *'CREATES that table and does not adopt one'*) ok "and says so in terms an operator can act on" ;;
  *) bad "the abort message is not the B1 refusal: $(printf '%s' "$OUT3" | tail -5)" ;;
esac
case "$OUT3" in
  *'docs/RUNBOOK.md section B1'*) ok "and names the runbook section carrying the procedure" ;;
  *) bad "the abort does not name the runbook section" ;;
esac
# The abort is inside the caller's transaction, so nothing partial is left and the ledger does not
# claim the migration succeeded. Both matter: a recorded-but-unrun migration is the exact failure
# the ALWAYS_EXECUTE entry exists to prevent. What the ledger DOES hold is a started-and-failed
# attempt, which is why RUNBOOK section B1 step 2 resolves it before redeploying.
left=$($PSQL2 -tAc "SELECT (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid='public.\"ActivityDependency\"'::regclass AND NOT tgisinternal)::text
                       || '/' || COALESCE((SELECT COUNT(*)::text FROM _prisma_migrations WHERE migration_name='$THIS' AND finished_at IS NOT NULL), '0')
                       || '/' || COALESCE((SELECT COUNT(*)::text FROM _prisma_migrations WHERE migration_name='$THIS' AND finished_at IS NULL AND rolled_back_at IS NULL), '0')" 2>/dev/null | tr -d '[:space:]')
[ "$left" = "0/0/1" ] \
  && ok "the aborted run installed nothing, recorded nothing as applied, and left one failed attempt ($left)" \
  || bad "unexpected post-abort state: $left (expected 0/0/1 — triggers/applied/failed-attempt)"

# The documented repair, run exactly as docs/RUNBOOK.md section B1 states it: confirm the table is
# empty (it is, on every deployed database), resolve the failed attempt, drop the table, re-run.
rows=$($PSQL2 -tAc "SELECT COUNT(*) FROM \"ActivityDependency\"" | tr -d '[:space:]')
[ "$rows" = "0" ] && ok "the pre-existing table holds no rows, which is why the repair is a DROP" \
                  || bad "the fixture table unexpectedly holds $rows rows"
DATABASE_URL="$URL2" npx prisma migrate resolve --rolled-back "$THIS" >/tmp/b1-resolve.log 2>&1 \
  && ok "RUNBOOK B1 step 2: the failed attempt resolves as rolled back" \
  || { bad "migrate resolve --rolled-back failed"; tail -10 /tmp/b1-resolve.log; }
$PSQL2 -c 'DROP TABLE "ActivityDependency"' >/dev/null
OUT4="$(DATABASE_URL="$URL2" sh scripts/migrate.sh 2>&1)"; RC4=$?
[ "$RC4" = "0" ] && ok "and after the repair the SAME runner deploys (exit 0)" \
                 || { bad "the repaired database still fails: exit $RC4"; printf '%s\n' "$OUT4" | tail -20; }
after2=$($PSQL2 -tAc "SELECT (SELECT COUNT(*) FROM pg_constraint
                              WHERE conrelid='public.\"ActivityDependency\"'::regclass AND contype='c' AND convalidated)::text
                         || '/' || (SELECT COUNT(*) FROM pg_trigger
                                     WHERE tgrelid='public.\"ActivityDependency\"'::regclass AND NOT tgisinternal AND tgenabled='O')::text" | tr -d '[:space:]')
[ "$after2" = "4/5" ] && ok "with every guard in force ($after2)" \
                      || bad "the repaired deploy did not install the guards: $after2 (expected 4/5)"

# ══ COUPLING — a mutation to the baseline path must fail this proof ═══════════════════════════
say "5. the coupling: without the ALWAYS_EXECUTE entry, state A's guards do not arrive"
# Evidence that cannot fail is not evidence. This mutates the thing under test — migrate.sh's
# baseline path — on a COPY, and requires the outcome step 2 asserts to stop holding. Because this
# script runs in the required `api` job, that mutation turns a required job red.
MUT=/tmp/b1-migrate-mutated.sh
sed "s|^  ALWAYS_EXECUTE=\"$THIS\$|  ALWAYS_EXECUTE=\"|" scripts/migrate.sh > "$MUT"
if grep -q "ALWAYS_EXECUTE=\"$THIS" "$MUT"; then
  bad "the mutation did not remove the $THIS entry — step 5 would be vacuous"
else
  prebaseline "$DB2" "$URL2" "$BARE2" || exit 1
  MOUT="$(DATABASE_URL="$URL2" sh "$MUT" 2>&1)"; MRC=$?
  [ "$MRC" = "0" ] && ok "the mutated runner still exits 0 — the regression is SILENT, which is the point" \
                   || ok "the mutated runner exits $MRC"
  mut=$($PSQL2 -tAc "SELECT COALESCE((SELECT COUNT(*)::text FROM pg_trigger
                                       WHERE tgrelid = to_regclass('public.\"ActivityDependency\"')
                                         AND NOT tgisinternal), '0')
                        || '/' || COALESCE((SELECT COUNT(*)::text FROM _prisma_migrations
                                             WHERE migration_name='$THIS' AND finished_at IS NOT NULL), '0')" | tr -d '[:space:]')
  case "$mut" in
    0/1) ok "REPRODUCED: the ledger records $THIS as applied while ZERO guards exist ($mut) — step 2's assertion fails under the mutation" ;;
    *)   bad "the mutation did not reproduce the regression: $mut (expected 0/1)" ;;
  esac
fi
rm -f "$MUT"

psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB\"" >/dev/null
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$DB2\"" >/dev/null
printf '\n'
[ "$FAIL" = "0" ] && { echo "schedule B1 baseline proof: PASSED"; exit 0; }
echo "schedule B1 baseline proof: FAILED"; exit 1
