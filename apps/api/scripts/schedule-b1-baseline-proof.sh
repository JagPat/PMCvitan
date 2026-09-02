#!/usr/bin/env bash
# Schedule B1 — the migration must behave correctly on the P3005 BASELINE PATH it is left pending
# for, in EVERY state that path can present.
#
# `scripts/migrate.sh` lists `20270930000000_schedule_dependency_graph` in ALWAYS_EXECUTE, so on a
# pre-baseline database — one with no `_prisma_migrations` table — every OTHER migration is
# resolved as applied and this one is left PENDING, deliberately, so its raw CHECKs and triggers
# really execute. `schema.prisma` cannot describe a CHECK or a trigger, so recording it as applied
# would claim guards that never existed.
#
# The migration COMPLETES ITS OWN INSTALL and adopts nothing else, so that path has five states
# and this proof executes all five against the REAL production runner:
#
#   A. the table is ABSENT — every deployed database. migrate.sh must install the guards, record
#      the migration as applied because it RAN, leave them binding, and be re-runnable.
#   B. the table is PRESENT and is NOT this migration's work (a `prisma db push`-shaped
#      reconciliation: the columns and the modelled keys, none of the CHECKs and none of the
#      seals). migrate.sh must ABORT, NAMING THE OBJECT it disagrees about and
#      docs/RUNBOOK.md section B1, WITHOUT recording the migration as applied — and the documented
#      last-resort repair (drop the empty table) must let the same runner deploy.
#   C. the table is PRESENT and IS this migration's own PARTIAL APPLY — a run that died after
#      `CREATE TABLE` and before the seals, which is what a caller supplying no transaction leaves
#      behind. migrate.sh must COMPLETE the install and exit 0, with every guard binding. This is
#      the state the unconditional refusal dead-ended on, and it is the reason this file is
#      definition-aware rather than absolute.
#   D. the table is PRESENT, HOLDS A ROW, and its install is INCOMPLETE or foreign. Arming a
#      trigger validates nothing already in the table, so finishing that install would certify
#      those rows by silence: migrate.sh must REFUSE, say how many rows it found, and LEAVE THE
#      ROW ALONE — neither adopting it nor destroying it.
#   E. the table is PRESENT, COMPLETE, and HOLDS A ROW — a finished install that has been in
#      SERVICE, which is the only populated state a real re-deploy ever meets. migrate.sh must
#      exit 0 and change nothing. An earlier head aborted here on the first row it saw, before
#      comparing a single object, which made the migration non-rerunnable over its normal state.
#
# COUPLING is proven rather than asserted (step 8): with the ALWAYS_EXECUTE entry removed from a
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

# Phase 6 unit 4c-iii-r — this proof drives the REAL `scripts/migrate.sh`, whose last step on every
# success path is the one-shot `decisions.inbox` repair. That step REQUIRES its two identity
# variables on any database that holds projects, and this proof plants projects, so it is configured
# here exactly as a deployment is: the anchor is the project this script actually plants
# ('b1-proj'), and the minimum is 1.
#
# Deliberately NOT a bypass value. The step decides "nothing to repair" from the DATABASE (zero
# projects) and never from configuration, so there is no setting that skips it here — the empty
# states below pass as not-applicable on their own, and the populated states really run the repair.
# Configuring it this way keeps THIS proof measuring what it is about while leaving 4c-iii-r
# enforced throughout, which a skip value would not.
export PHASE6_4C_IIIR_ANCHOR_PROJECT_ID="b1-proj"
export PHASE6_4C_IIIR_EXPECTED_MIN_PROJECTS=1


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

# The COMPILED artifacts migrate.sh runs — three preflights before Prisma, and the B1 seal verifier
# after it — have to exist: this is the production path, not a stand-in for it. Built once, up
# front, for every step below.
say "0. the compiled artifacts the production runner requires"
pnpm --filter @vitan/shared build >/tmp/b1-shared.log 2>&1 || { bad "shared build failed"; tail -10 /tmp/b1-shared.log; exit 1; }
pnpm --filter api build >/tmp/b1-api.log 2>&1 || { bad "api build failed"; tail -20 /tmp/b1-api.log; exit 1; }
for a in dist/platform/t45/t45.cli.js dist/labour/t2c/t2c.cli.js dist/labour/t3c/t3c.cli.js \
         dist/activities/b1/b1.cli.js; do
  [ -f "$a" ] || { bad "compiled migrate.sh artifact missing: $a"; exit 1; }
done
ok "the three compiled preflights and the B1 seal verifier are present, so migrate.sh runs its real path"

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

# ══ STATE B — the table is PRESENT and is not this migration's work: the `db push` shape ══════
say "4. a PRE-BASELINE database with a table this migration did NOT install: abort, then repair"
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
# The refusal must NAME THE OBJECT it disagrees about, not merely the table. "It already exists"
# was the old message and it told an operator nothing they could act on; a `db push` shape is
# missing the four CHECKs, so the first disagreement is one of those and the message says which.
case "$OUT3" in
  *'ActivityDependency_attribution_check'*|*'ActivityDependency_revocation_check'*|\
  *'ActivityDependency_no_self_check'*|*'ActivityDependency_lag_nonneg_check'*)
    ok "and NAMES the constraint it disagrees about, in terms an operator can act on" ;;
  *) bad "the abort message does not name a specific object: $(printf '%s' "$OUT3" | tail -5)" ;;
esac
case "$OUT3" in
  *'will not be adopted'*) ok "and states that it completes its own install rather than adopting one" ;;
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

# The documented LAST-RESORT repair, run exactly as docs/RUNBOOK.md section B1 states it: confirm
# the table is empty (it is, on every deployed database), resolve the failed attempt, drop the
# table, re-run. Routine retries never reach this step — state C below is the routine case.
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


# ══ STATE C — the table is PRESENT and IS this migration's own partial apply ═══════════════════
say "5. a PRE-BASELINE database carrying a PARTIAL APPLY of this migration: it must COMPLETE"
prebaseline "$DB2" "$URL2" "$BARE2" || exit 1
# The partial apply is produced the way a real one is: the migration's own text, cut off after the
# statement that creates the table, applied WITHOUT a wrapping transaction — which is exactly the
# caller the repository requires this file to tolerate. Everything `CREATE TABLE` installs
# atomically (the columns, the primary key, four CHECKs, five composite keys) survives; the
# indexes, functions and triggers that come after it never ran.
PARTIAL=/tmp/b1-partial.sql
awk 'BEGIN{done=0} {print} /^\);$/{if(!done){done=1; exit}}' \
    "prisma/migrations/$THIS/migration.sql" > "$PARTIAL"
psql -v ON_ERROR_STOP=1 -X -q "$BARE2" -f "$PARTIAL" >/tmp/b1-partial.log 2>&1 \
  || { bad "the partial-apply fixture did not build"; tail -10 /tmp/b1-partial.log; }
part=$($PSQL2 -tAc "SELECT (SELECT COUNT(*) FROM pg_constraint
                            WHERE conrelid='public.\"ActivityDependency\"'::regclass AND contype='c')::text
                       || '/' || (SELECT COUNT(*) FROM pg_trigger
                                   WHERE tgrelid='public.\"ActivityDependency\"'::regclass AND NOT tgisinternal)::text
                       || '/' || (SELECT COUNT(*) FROM pg_index
                                   WHERE indrelid='public.\"ActivityDependency\"'::regclass)::text" | tr -d '[:space:]')
[ "$part" = "5/0/1" ] \
  && ok "the interrupted run left the table, its four CHECKs and the INSTALL BARRIER, no seal and no index ($part)" \
  || bad "unexpected partial-apply shape: $part (expected 5/0/1 — checks/triggers/indexes)"

# THE FIFTH CHECK IS THE INSTALL BARRIER, and while it stands the half-built table is unwritable —
# which is what closes the interleaving a lock cannot: T1 commits CREATE TABLE on the autocommit
# path, T2 inserts an already-revoked edge before `ActivityDependency_born_live` exists, T1 arms
# the seals and reports success, and trigger creation validates nothing already in the table.
barrier_writes=$($PSQL2 -tAc "INSERT INTO \"ActivityDependency\"(\"id\",\"projectId\",\"predecessorId\",\"successorId\",\"createdById\",\"createdByName\",\"revokedAt\",\"revokedById\",\"revokedByName\") VALUES ('b1-fab','p','a','b','u','U',now(),'u','U')" 2>&1)
case "$barrier_writes" in
  *ActivityDependency_install_incomplete_check*)
    ok "and an unfinished install is UNWRITABLE — the fabricated withdrawal is refused" ;;
  *) bad "the install barrier did not hold: $barrier_writes" ;;
esac

OUT5="$(DATABASE_URL="$URL2" sh scripts/migrate.sh 2>&1)"; RC5=$?
[ "$RC5" = "0" ] && ok "the REAL production runner COMPLETES the partial apply (exit 0)" \
                 || { bad "migrate.sh could not complete its own partial apply: exit $RC5"
                      printf '%s\n' "$OUT5" | tail -25; }
done5=$($PSQL2 -tAc "SELECT (SELECT COUNT(*) FROM pg_constraint
                             WHERE conrelid='public.\"ActivityDependency\"'::regclass AND contype='c' AND convalidated)::text
                        || '/' || (SELECT COUNT(*) FROM pg_trigger
                                    WHERE tgrelid='public.\"ActivityDependency\"'::regclass AND NOT tgisinternal AND tgenabled='O')::text
                        || '/' || (SELECT COUNT(*) FROM pg_index ix JOIN pg_class ci ON ci.oid=ix.indexrelid
                                    WHERE ci.relname='ActivityDependency_projectId_successorId_predecessorId_key'
                                      AND ix.indisunique AND ix.indisvalid AND ix.indpred IS NOT NULL)::text" | tr -d '[:space:]')
[ "$done5" = "4/5/1" ] \
  && ok "with four validated CHECKs, five armed triggers and the partial unique index ($done5)" \
  || bad "the completed install is missing guards: $done5 (expected 4/5/1)"
# Four, not five: the install barrier is LIFTED by section 9, and only after it has proved that
# every seal is armed and bound to the function in `public`. A completed install is open for
# business; an unfinished one is not.
lifted=$($PSQL2 -tAc "SELECT COUNT(*)::text FROM pg_constraint WHERE conname='ActivityDependency_install_incomplete_check' AND conrelid='public.\"ActivityDependency\"'::regclass" | tr -d '[:space:]')
[ "$lifted" = "0" ] && ok "and the install barrier is LIFTED, so the table is writable again" \
                    || bad "the install barrier survived a completed install ($lifted)"

# A guard in the catalog is not a guard that binds — the same hostile write state A uses.
$PSQL2 >/dev/null <<'SQL' || bad "the state-C fixture rows did not build"
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
cyc5=$($PSQL2 -c "INSERT INTO \"ActivityDependency\"(\"id\",\"projectId\",\"predecessorId\",\"successorId\",\"createdById\",\"createdByName\") VALUES ('b1-e2','b1-proj','b1-b','b1-a','b1-user','B1 User')" 2>&1)
case "$cyc5" in
  *'dependency cycle'*) ok "and the acyclicity trigger REFUSES a cycle on the completed database" ;;
  *) bad "the cycle guard did not bind after completing the partial apply: $cyc5" ;;
esac
rm -f "$PARTIAL"


# ══ STATE D — the table is PRESENT, HOLDS A ROW, and its install is INCOMPLETE ════════════════
say "6. a PRE-BASELINE database whose table HOLDS A ROW and is INCOMPLETE: refused, row survives"
# The state where refusing protects something real: rows PLUS an install this file did not finish.
# Arming a seal validates nothing already in the table, so completing this one would certify those
# rows by silence. The file will neither adopt them nor destroy them. Asserted through the REAL
# runner rather than through psql, because "the production deploy leaves your data alone" is the
# claim an operator actually needs. Rows on a COMPLETE install are a different state — step 7 below.
prebaseline "$DB2" "$URL2" "$BARE2" || exit 1
$PSQL2 >/dev/null <<'SQL' || { bad "the populated-table fixture did not build"; exit 1; }
CREATE TABLE "ActivityDependency" (
  "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "predecessorId" TEXT NOT NULL,
  "successorId" TEXT NOT NULL, "lagWorkingDays" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdById" TEXT NOT NULL, "createdByName" TEXT NOT NULL,
  "revokedAt" TIMESTAMP(3), "revokedById" TEXT, "revokedByName" TEXT,
  CONSTRAINT "ActivityDependency_pkey" PRIMARY KEY ("id"));
INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName")
  VALUES ('legacy-edge','some-project','some-pred','some-succ','someone','Someone');
SQL
OUT6="$(DATABASE_URL="$URL2" sh scripts/migrate.sh 2>&1)"; RC6=$?
[ "$RC6" != "0" ] && ok "migrate.sh REFUSES a populated table (exit $RC6)" \
                  || bad "migrate.sh exited 0 over a table holding rows"
case "$OUT6" in
  *'already exists and holds 1 row(s)'*) ok "and says how many rows it found, before anything else" ;;
  *) bad "the abort does not name the row count: $(printf '%s' "$OUT6" | tail -5)" ;;
esac
survived=$($PSQL2 -tAc "SELECT COUNT(*)::text FROM \"ActivityDependency\" WHERE \"id\"='legacy-edge'" | tr -d '[:space:]')
[ "$survived" = "1" ] && ok "and THE ROW SURVIVES — the refusal neither adopts it nor destroys it" \
                      || bad "the row did not survive the refusal ($survived)"

# ══ STATE E — the table is PRESENT, COMPLETE, and HOLDS A ROW ════════════════════════════════
say "7. a database whose install is COMPLETE and IN SERVICE: the deploy replays as a no-op"
# THE STATE A REAL RE-DEPLOY ACTUALLY MEETS. Every other populated state in this proof is a
# fixture; this one is production. An earlier head aborted on the first row it saw, before
# comparing a single object, so one accepted edge made the migration permanently non-rerunnable
# and the destructive runbook DROP was the only way forward. A complete install must replay.
prebaseline "$DB2" "$URL2" "$BARE2" || exit 1
OUT7A="$(DATABASE_URL="$URL2" sh scripts/migrate.sh 2>&1)"; RC7A=$?
[ "$RC7A" = "0" ] || { bad "the state-E base install did not deploy: exit $RC7A"
                       printf '%s\n' "$OUT7A" | tail -20; }
$PSQL2 >/dev/null <<'SQL' || { bad "the state-E fixture rows did not build"; exit 1; }
INSERT INTO "Org"("id","name","slug") VALUES ('b1e-org','B1E','b1e-org');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('b1e-proj','b1e-org','B1E Site','B1E','','Planning','B1E-01','01 Jan 2026','31 Dec 2026',0,0,0);
INSERT INTO "User"("id","projectId","name","email","role") VALUES ('b1e-user','b1e-proj','B1E User','b1e@example.com','pmc');
INSERT INTO "Membership"("id","projectId","userId","role","status") VALUES ('b1e-mem','b1e-proj','b1e-user','pmc','active');
INSERT INTO "Activity"("id","projectId","name","zone","plannedStart","plannedEnd")
  VALUES ('b1e-a','b1e-proj','A','Z',0,1),('b1e-b','b1e-proj','B','Z',0,1);
INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName")
  VALUES ('b1e-edge','b1e-proj','b1e-a','b1e-b','b1e-user','B1E User');
SQL
ok "a real edge is accepted by the freshly installed guards, so the table is IN SERVICE"

# Force the deploy to run this unit again over that populated, complete database — the same thing
# `migrate resolve --rolled-back` followed by `migrate deploy` does, and the same thing a direct
# repair does.
$PSQL2 -c "DELETE FROM \"_prisma_migrations\" WHERE migration_name='$THIS'" >/dev/null
OUT7B="$(DATABASE_URL="$URL2" sh scripts/migrate.sh 2>&1)"; RC7B=$?
[ "$RC7B" = "0" ] && ok "the REAL production runner REPLAYS over a populated complete install (exit 0)" \
                  || { bad "migrate.sh refused a populated COMPLETE install: exit $RC7B"
                       printf '%s\n' "$OUT7B" | tail -20; }
alive=$($PSQL2 -tAc "SELECT COUNT(*)::text FROM \"ActivityDependency\" WHERE \"id\"='b1e-edge'" | tr -d '[:space:]')
[ "$alive" = "1" ] && ok "and the edge is untouched — a replay is a no-op, not a rebuild" \
                   || bad "the replay did not leave the edge alone ($alive)"
shape7=$($PSQL2 -tAc "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conrelid='public.\"ActivityDependency\"'::regclass AND contype='c' AND convalidated)::text
                        || '/' || (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid='public.\"ActivityDependency\"'::regclass AND NOT tgisinternal AND tgenabled='O')::text
                        || '/' || (SELECT COUNT(*) FROM pg_constraint WHERE conname='ActivityDependency_install_incomplete_check' AND conrelid='public.\"ActivityDependency\"'::regclass)::text" | tr -d '[:space:]')
[ "$shape7" = "4/5/0" ] \
  && ok "and the replay reintroduced no install barrier over a live table ($shape7)" \
  || bad "the replay left the wrong shape: $shape7 (expected 4/5/0 — checks/seals/barrier)"
cyc7=$($PSQL2 -c "INSERT INTO \"ActivityDependency\"(\"id\",\"projectId\",\"predecessorId\",\"successorId\",\"createdById\",\"createdByName\") VALUES ('b1e-e2','b1e-proj','b1e-b','b1e-a','b1e-user','B1E User')" 2>&1)
case "$cyc7" in
  *'dependency cycle'*) ok "and the guards still bind after the replay" ;;
  *) bad "the cycle guard did not bind after a populated replay: $cyc7" ;;
esac


# ══ STATE F — the ledger is COMPLETE and the guards have since been switched off ══════════════
say "8. a LEDGER-BACKED database whose B1 guards have been tampered with: the runner must refuse"
# NOT a baseline state — the opposite one, and the reason this step exists. States A to E are all
# about a database that still has the migration to run. This is about every database that already
# ran it: once `20270930000000` is recorded, `prisma migrate deploy` has nothing pending and never
# re-reads the file, so the file's own proof — thorough as it is — is a ONE-TIME event.
#
# MEASURED at the previous head, on exactly the database this step builds: with
# `ActivityDependency_frozen` and `ActivityDependency_no_delete` DISABLED, `scripts/migrate.sh`
# exited 0, after which an UPDATE rewrote the immutable evidence row and a DELETE removed it. The
# runner now runs the compiled B1 verifier on its ordinary success path, and that verifier
# re-executes the MIGRATION'S OWN inventory rather than a second list kept alongside it.
#
# Three shapes, because the two findings this round closes are two different ways an object can
# read as installed while not enforcing, and the third is the one `migrate.sh` already documents
# for T3C one table over:
#   F1  a seal DISABLED by `ALTER TABLE ... DISABLE TRIGGER` (what a failed restore leaves).
#   F2  a single internal FOREIGN-KEY trigger LOST, with its siblings intact — the shape a
#       side-level "is there a trigger here" accepts and this round's per-trigger inventory does not.
#   F3  a seal's BODY hollowed by `CREATE OR REPLACE FUNCTION`, which preserves the OID, the name,
#       the volatility, the security context and the search_path pin, and replaces what it does.
ledgered() {
  local db="$1" url="$2"
  psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "DROP DATABASE IF EXISTS \"$db\"" >/dev/null
  psql -v ON_ERROR_STOP=1 -X -q "$ADMIN" -c "CREATE DATABASE \"$db\"" >/dev/null
  DATABASE_URL="$url" npx prisma migrate deploy >/tmp/b1-ledgered.log 2>&1 || {
    bad "the full migration set did not apply to $db"; tail -20 /tmp/b1-ledgered.log; return 1; }
  return 0
}
ledgered "$DB2" "$URL2" || exit 1
BASE_OUT="$(DATABASE_URL="$URL2" sh scripts/migrate.sh 2>&1)"; BASE_RC=$?
[ "$BASE_RC" = "0" ] && ok "an untampered ledger-complete database still deploys clean (exit 0)" \
                     || { bad "the runner refused an intact database (exit $BASE_RC)"; printf '%s\n' "$BASE_OUT" | tail -12; }

tamper_and_expect_refusal() {
  local label="$1" needle="$2"
  local out rc
  out="$(DATABASE_URL="$URL2" sh scripts/migrate.sh 2>&1)"; rc=$?
  if [ "$rc" = "0" ]; then
    bad "$label: the runner exited 0 over a tampered database — the deploy would have been reported good"
    return
  fi
  ok "$label: the runner REFUSED (exit $rc)"
  printf '%s\n' "$out" | grep -q "$needle" \
    && ok "$label: and named the object — $needle" \
    || { bad "$label: the refusal did not name '$needle'"; printf '%s\n' "$out" | tail -12; }
}

$PSQL2 -c 'ALTER TABLE "ActivityDependency" DISABLE TRIGGER "ActivityDependency_frozen"' >/dev/null
tamper_and_expect_refusal "F1 disabled seal" 'ActivityDependency_frozen'
$PSQL2 -c 'ALTER TABLE "ActivityDependency" ENABLE TRIGGER "ActivityDependency_frozen"' >/dev/null

# The dependency bookkeeping goes with the row: a partially-restored catalog leaves neither, and
# a dangling `pg_depend` entry would be a different, self-announcing kind of damage.
$PSQL2 -c 'SET allow_system_table_mods = on;
           DELETE FROM pg_depend d USING pg_trigger g, pg_constraint c
            WHERE d.classid = '"'"'pg_trigger'"'"'::regclass AND d.objid = g.oid
              AND g.tgconstraint = c.oid
              AND c.conname = '"'"'ActivityDependency_revokedBy_fkey'"'"'
              AND g.tgfoid = '"'"'pg_catalog."RI_FKey_check_upd"'"'"'::regproc;
           DELETE FROM pg_trigger g USING pg_constraint c
            WHERE g.tgconstraint = c.oid
              AND c.conname = '"'"'ActivityDependency_revokedBy_fkey'"'"'
              AND g.tgfoid = '"'"'pg_catalog."RI_FKey_check_upd"'"'"'::regproc' >/dev/null
# TWO gates refuse this shape now, and they are asserted separately because they answer different
# questions. `migrate.sh` runs the WHOLE-SCHEMA enforcement preflight BEFORE Prisma, and a lost
# internal foreign-key trigger is exactly what its clause 3 asks about — so the runner stops there
# and never reaches the post-deploy B1 verifier. What it names is the KEY and the slot that does not
# fire, which is the object an operator repairs (the DROP/ADD below IS that repair; PostgreSQL
# refuses `DROP TRIGGER` on an internal one, so there is nothing smaller to name). The B1 seal
# inventory — which this state was written for, and which the preflight now shadows — is then asked
# DIRECTLY and must still name the internal trigger. Nothing this state used to prove is dropped.
tamper_and_expect_refusal "F2 lost internal FK trigger" 'ActivityDependency_revokedBy_fkey'
B1OUT="$(DATABASE_URL="$URL2" node dist/activities/b1/b1.cli.js seals 2>&1)"; B1RC=$?
[ "$B1RC" != "0" ] \
  && ok "F2 lost internal FK trigger: the B1 seal inventory, asked directly, also refuses (exit $B1RC)" \
  || bad "F2 lost internal FK trigger: the B1 seal inventory reported the guards intact"
printf '%s\n' "$B1OUT" | grep -q 'RI_FKey_check_upd' \
  && ok "F2 lost internal FK trigger: and names the internal trigger — RI_FKey_check_upd" \
  || { bad "F2 lost internal FK trigger: the B1 inventory did not name 'RI_FKey_check_upd'"; printf '%s\n' "$B1OUT" | tail -6; }
# Re-added by dropping and re-adding the key, which is the repair the refusal names.
$PSQL2 -c 'ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_revokedBy_fkey";
           ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_revokedBy_fkey"
             FOREIGN KEY ("projectId", "revokedById") REFERENCES public."Membership"("projectId", "userId")
             ON DELETE NO ACTION ON UPDATE NO ACTION' >/dev/null

$PSQL2 -c 'CREATE OR REPLACE FUNCTION public.activity_dependency_frozen() RETURNS TRIGGER LANGUAGE plpgsql VOLATILE
             SET search_path = pg_catalog, public AS $hollow$
BEGIN
  RETURN NEW;
END $hollow$' >/dev/null
tamper_and_expect_refusal "F3 hollowed seal body" 'does not have the body this migration installed'

# And the repair really clears it: the migration file is the canonical body, so re-running it over
# a database whose only fault is the hollowed function restores nothing — it ABORTS, because
# section 4 refuses to overwrite a function it did not install. The supported repair is to drop the
# function and let the file recreate it, which is what section B1 of the runbook says.
$PSQL2 -c 'DROP TRIGGER "ActivityDependency_frozen" ON "ActivityDependency";
           DROP FUNCTION public.activity_dependency_frozen()' >/dev/null
psql -v ON_ERROR_STOP=1 -X -q "$BARE2" -f "prisma/migrations/$THIS/migration.sql" >/tmp/b1-reinstall.log 2>&1 \
  && ok "F3 repair: dropping the hollowed function lets the migration file reinstall it" \
  || { bad "F3 repair: the migration file did not reinstall the dropped function"; tail -6 /tmp/b1-reinstall.log; }
FIX_OUT="$(DATABASE_URL="$URL2" sh scripts/migrate.sh 2>&1)"; FIX_RC=$?
[ "$FIX_RC" = "0" ] && ok "and the runner then reports the deploy good again (exit 0)" \
                    || { bad "the runner still refuses after the repair (exit $FIX_RC)"; printf '%s\n' "$FIX_OUT" | tail -12; }

# ══ COUPLING — a mutation to the baseline path must fail this proof ═══════════════════════════
say "9. the coupling: without the ALWAYS_EXECUTE entry, state A's guards do not arrive"
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
