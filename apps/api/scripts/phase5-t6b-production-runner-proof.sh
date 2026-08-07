#!/usr/bin/env bash
# Phase 5 Task 6B-i — the CUTOVER BARRIER holds on the REAL production path. EXECUTED against
# PostgreSQL, using the repo-pinned `prisma migrate deploy`, not `psql --single-transaction`.
#
# WHY THIS EXISTS, and why `upgrade-proof.sh` is not enough.
#
# `20270610000000` installs §F's derivation seals, and between its backfill and its triggers there
# is a window: `docs/DEPLOY.md` keeps the previous production container serving until the new deploy
# succeeds, so the OLD `commercial.payment.approve` can lock an already-coherent `certified` bill,
# append a valid `PaymentApproval` and commit with the status unmoved — correct under 6A — and a
# constraint trigger does NOT validate rows written before it existed. That bill would be
# permanently stored `certified` while its folds derive `approved-for-payment`.
#
# The migration closes the window with `BEGIN; LOCK TABLE "VendorBill" IN EXCLUSIVE MODE; …; COMMIT;`.
# A review claimed that `LOCK TABLE` would abort every production deploy because Prisma does not
# wrap migrations in a transaction. That premise is false for the pinned runtime — but "false today"
# is exactly the kind of claim that should be TESTED rather than argued, because it is a property of
# a dependency and not of this repository. `upgrade-proof.sh` cannot test it: it applies migrations
# with `psql --single-transaction`, which supplies the very transaction under question and so would
# pass whether or not the real runner does.
#
# So this asserts three things on the actual command production runs:
#
#   1. `prisma migrate deploy` APPLIES this migration over a database at Task 6A — which it cannot
#      do outside a transaction block, since PostgreSQL rejects `LOCK TABLE` there. The migration
#      succeeding IS the transactional-boundary proof, and it fails LOUDLY if that ever changes.
#   2. While the deploy is in flight, a second session taking the bill-first lock every §F mover
#      starts with (`SELECT … FROM "VendorBill" … FOR UPDATE`) is BLOCKED — observed in `pg_locks`,
#      condition-based, never a sleep — so the old writer cannot commit into the gap.
#   3. After the deploy, the seals are live and every in-family bill satisfies
#      `status = phase5_t6b_derive_bill_status(projectId, id)`.
#
# DESTRUCTIVE for its own scratch database only.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API="$(cd "$HERE/.." && pwd)"
DB="pmcvitan_t6b_runner_test"
ADMIN_URL="postgresql://${PGUSER:-postgres}:${PGPASSWORD:-postgres}@${PGHOST:-localhost}:${PGPORT:-5432}/postgres"
DB_URL="postgresql://${PGUSER:-postgres}:${PGPASSWORD:-postgres}@${PGHOST:-localhost}:${PGPORT:-5432}/${DB}"
PSQL="psql -v ON_ERROR_STOP=1 -X -q $DB_URL"
MIGRATION_DIR="$API/prisma/migrations/20270610000000_phase5_t6b_status_derivation"
# OUTSIDE prisma/migrations, deliberately. The first draft parked it at `<dir>.held`, which is still
# a subdirectory of `migrations/` — Prisma reads every subdirectory there, so it applied the very
# migration the step exists to hold back, and step 1's own guard caught it.
HELD_DIR="$API/prisma/.t6b-held-migration"
# …and every migration that comes AFTER it must be held back too. 6B-ii's `20270620000000` creates
# `PaymentReversal` and installs its derivation seal by calling `phase5_t6b_fold_status_sealed`,
# which is 6B-i's function — so leaving it in place would make step 1 fail on a missing function
# rather than reach Task 6A, and every claim below would be vacuous. This is a LIST because the next
# unit will add to it; a script that held back one migration by name is the same hand-kept set this
# module keeps deriving away.
LATER_DIRS="20270620000000_phase5_t6b_ii_payment_reversal"
HELD_LATER="$API/prisma/.t6b-held-later"
FAIL=0

ok()   { printf 'ok      %s\n' "$1"; }
bad()  { printf 'FAILED  %s\n' "$1"; FAIL=1; }

hold_later() {
  mkdir -p "$HELD_LATER"
  for d in $LATER_DIRS; do
    [ -d "$API/prisma/migrations/$d" ] && mv "$API/prisma/migrations/$d" "$HELD_LATER/$d"
  done
  return 0
}
restore_later() {
  for d in $LATER_DIRS; do
    [ -d "$HELD_LATER/$d" ] && mv "$HELD_LATER/$d" "$API/prisma/migrations/$d"
  done
  rmdir "$HELD_LATER" 2>/dev/null
  return 0
}

cleanup() {
  # the migration directories are moved aside in step 1 — never leave them there
  [ -d "$HELD_DIR" ] && mv "$HELD_DIR" "$MIGRATION_DIR"
  restore_later
  psql -v ON_ERROR_STOP=1 -X -q "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1
}
trap cleanup EXIT

echo "── Phase 5 Task 6B-i: the cutover barrier on the real production path ──────────────────────"

psql -v ON_ERROR_STOP=1 -X -q "$ADMIN_URL" -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)" >/dev/null 2>&1
psql -v ON_ERROR_STOP=1 -X -q "$ADMIN_URL" -c "CREATE DATABASE \"$DB\"" >/dev/null || {
  bad "could not create the scratch database — nothing below would mean anything"; exit 1; }

# ── 1. bring the database to Task 6A, WITHOUT 6B ────────────────────────────────────────────────
#
# The migration under test is moved aside so `migrate deploy` stops at 6A. That is the state a real
# deploy starts from, and it is what makes the race below reachable at all.
mv "$MIGRATION_DIR" "$HELD_DIR" || { bad "could not hold the migration back — every claim below would be vacuous"; exit 1; }
[ -d "$HELD_DIR" ] || { bad "the migration was not held back"; exit 1; }
hold_later
for d in $LATER_DIRS; do
  [ -d "$API/prisma/migrations/$d" ] && { bad "a later migration ($d) was not held back — step 1 would fail on 6B-i's own function and every claim below would be vacuous"; exit 1; }
done
if (cd "$API" && DATABASE_URL="$DB_URL" npx prisma migrate deploy >/tmp/t6b-6a.log 2>&1); then
  ok "the database is at Task 6A (the migration under test held back)"
else
  bad "could not bring the database to Task 6A"; tail -20 /tmp/t6b-6a.log | sed 's/^/          /'; exit 1
fi
mv "$HELD_DIR" "$MIGRATION_DIR"
restore_later

pre=$($PSQL -tAc "SELECT COUNT(*) FROM pg_proc WHERE proname = 'phase5_t6b_derive_bill_status'")
if [ "$pre" = "0" ]; then
  ok "…and the 6B derivation is absent there, so the deploy below really is the cutover"
else
  bad "the 6B derivation already exists at the 6A state (found '$pre') — step 1 did not hold the migration back"; exit 1
fi

# ── 1b. seed a 6A-shaped bill the backfill MUST correct ─────────────────────────────────────────
#
# Without this the proof is vacuous where it matters most: `SELECT … FOR UPDATE` takes a
# relation-level lock on an empty table, so the lock assertions still hold, but the final
# "no bill disagrees with its folds" passes because there are NO bills. That is not the
# rolling-upgrade DATA outcome this script claims to prove.
#
# The row is the exact state 6A legitimately produced and §F must correct: a bill stored `certified`
# with a live ₹100 certificate and a ₹40 approval standing on it. Under 6A that is right — the
# status did not track approvals. Under §F the folds derive `approved-for-payment`, so the backfill
# has to move it, and the assertion at the end names THIS row.
#
# It is inserted with `session_replication_role = 'replica'`, transaction-local, and that is
# deliberate and worth stating plainly: a production 6A row got here through the full application
# chain (purchase order → acceptance → claim → verification → certificate), and rebuilding that
# chain in shell would be a second copy of `upgrade-proof.sh`'s fixture with its own drift. What
# this script is proving is the BACKFILL and the CUTOVER, and both read only the columns below.
$PSQL <<'SQL'
BEGIN;
SELECT set_config('session_replication_role', 'replica', true);
INSERT INTO "Org"("id","name","slug") VALUES ('t6b-org','T6B Org','t6b-org');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('t6b-proj','t6b-org','T6B Site','T6','','Finishing','T6-01','01 Jan 2026','31 Dec 2026',50,30,60);
INSERT INTO "User"("id","projectId","role","name","email","passwordHash")
  VALUES ('t6b-user','t6b-proj','pmc','T6B PMC','t6b@vitan.in','hash');
INSERT INTO "Vendor"("id","orgId","name","createdById") VALUES ('t6b-vendor','t6b-org','T6B Vendor','t6b-user');
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status","resultRef","completedAt")
  VALUES ('t6b-cmd','project','t6b-org','t6b-proj','t6b-user','commercial.bill.certify','t6b-key','x','succeeded','t6b-cert',now());
INSERT INTO "VendorBill"("id","projectId","vendorId","vendorBillNumber","documentDate","status","createdById","sourceCommandId")
  VALUES ('t6b-bill','t6b-proj','t6b-vendor','T6B-001','2026-08-01','certified','t6b-user','t6b-cmd');
INSERT INTO "VendorBillVersion"("id","projectId","billId","vendorIdPin","version","claimedAmount","lineCount","createdById")
  VALUES ('t6b-ver','t6b-proj','t6b-bill','t6b-vendor',1,100.00,1,'t6b-user');
-- a claim LINE: `phase5_t4_bill_status_sealed` refuses a bill in a live status with nothing
-- claimed, and the backfill's own UPDATE fires it. The `poLineId` is dangling — the FK trigger is
-- suppressed for this seeding transaction — because what the line has to satisfy here is the XOR
-- CHECK (exactly one of material/labour) and the line COUNT, neither of which reads the target.
INSERT INTO "VendorBillLine"("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
  VALUES ('t6b-line','t6b-proj','t6b-ver','t6b-bill','t6b-vendor','material','t6b-poline',1,100,0,0,100.00);
INSERT INTO "BillCertificate"("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
  VALUES ('t6b-cert','t6b-proj','t6b-bill','t6b-ver',100.00,'t6b-user','t6b-cmd');
INSERT INTO "PaymentApproval"("id","projectId","certificateId","billId","amount","approvedById","sourceCommandId")
  VALUES ('t6b-appr','t6b-proj','t6b-cert','t6b-bill',40.00,'t6b-user','t6b-cmd');
COMMIT;
SQL
seeded=$($PSQL -tAc "SELECT \"status\" FROM \"VendorBill\" WHERE \"id\" = 't6b-bill'")
[ "$seeded" = "certified" ] \
  && ok "a 6A-shaped bill is seeded: stored \`certified\` with a live 100.00 certificate and a 40.00 approval" \
  || { bad "could not seed the 6A-shaped bill (status '$seeded') — the data claim below would be vacuous"; exit 1; }

# ── 2. the cutover and the OLD writer are MUTUALLY EXCLUSIVE on the real path ────────────────────
#
# The claim is that the two cannot overlap. It is demonstrated from the side that can be held open.
#
# The first draft tried the other direction — start the deploy, then race a writer into it — and
# could not establish the overlap: the migration's transaction is milliseconds long and a bash poll
# spawning `psql` cannot reliably observe a window that short. That is a limitation of the OBSERVER,
# not evidence of a barrier, so reporting it as a pass would have been a lie. This direction has no
# such problem: session B holds the bill-first lock for as long as the proof needs, and the deploy's
# wait is observed in `pg_locks` as an UNGRANTED request rather than inferred from timing.
#
# Session B does exactly what every §F mover does first (§0b bill-first): `SELECT … FROM "VendorBill"
# … FOR UPDATE`, which takes ROW SHARE. It selects a COLUMN, not `count(*)`: PostgreSQL rejects
# `FOR UPDATE` with an aggregate, and the first draft's `SELECT count(*) … FOR UPDATE` therefore
# errored instead of locking — which, in the abandoned direction above, would have been read as
# "the writer was blocked" and passed. A probe that passes because its own SQL is invalid is worse
# than no probe. `EXCLUSIVE` conflicts with it, so the cutover must WAIT —
# which is the same conflict that makes the reverse (a writer slipping into the cutover) impossible.
psql -X -q "$DB_URL" >/tmp/t6b-holder.log 2>&1 <<'SQL' &
BEGIN;
SELECT "id" FROM "VendorBill" FOR UPDATE;
SELECT pg_sleep(45);
COMMIT;
SQL
HOLDER_PID=$!

# condition-based: wait until session B's ROW SHARE lock is actually GRANTED
HELD=0
for _ in $(seq 1 200); do
  n=$($PSQL -tAc "SELECT COUNT(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
                   WHERE c.relname = 'VendorBill' AND l.mode = 'RowShareLock' AND l.granted" 2>/dev/null || echo 0)
  if [ "${n:-0}" -ge 1 ]; then HELD=1; break; fi
  sleep 0.05
done
[ "$HELD" = "1" ] \
  && ok "an OLD-version bill-first writer holds its lock (observed granted in pg_locks)" \
  || bad "could not establish the old writer's lock — claim 2 would be vacuous"

(cd "$API" && DATABASE_URL="$DB_URL" npx prisma migrate deploy >/tmp/t6b-deploy.log 2>&1; echo "$?" >/tmp/t6b-deploy.rc) &
DEPLOY_PID=$!

# …and the cutover BLOCKS on it: an ExclusiveLock request on VendorBill that is NOT granted
WAITING=0
for _ in $(seq 1 600); do
  n=$($PSQL -tAc "SELECT COUNT(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
                   WHERE c.relname = 'VendorBill' AND l.mode = 'ExclusiveLock' AND NOT l.granted" 2>/dev/null || echo 0)
  if [ "${n:-0}" -ge 1 ]; then WAITING=1; break; fi
  if ! kill -0 "$DEPLOY_PID" 2>/dev/null; then break; fi
  sleep 0.05
done

if [ "$WAITING" = "1" ]; then
  ok "the cutover WAITS for the in-flight old writer — the two are mutually exclusive, so neither can commit into the other"
  # and the seals are still absent while it waits: the cutover has not half-applied
  mid=$($PSQL -tAc "SELECT COUNT(*) FROM pg_trigger WHERE tgname LIKE '%_t6b_status_sealed' AND NOT tgisinternal")
  [ "$mid" = "0" ] \
    && ok "…and nothing of the cutover is visible while it waits — no half-installed seal set" \
    || bad "$mid seal(s) were visible mid-cutover — the migration is not atomic"
else
  bad "the cutover did not wait for the in-flight writer — the barrier is not excluding it"
fi

# release the old writer; the cutover then proceeds
kill "$HOLDER_PID" 2>/dev/null
wait "$HOLDER_PID" 2>/dev/null
wait "$DEPLOY_PID" 2>/dev/null
RC=$(cat /tmp/t6b-deploy.rc 2>/dev/null || echo 1)

# ── 3. the real runner applied it, which is the transactional-boundary proof ─────────────────────
if [ "$RC" = "0" ]; then
  ok "the repo-pinned 'prisma migrate deploy' APPLIED the migration — LOCK TABLE was inside a transaction block"
else
  bad "'prisma migrate deploy' failed on the real path (rc=$RC); see /tmp/t6b-deploy.log"
  sed 's/^/          /' /tmp/t6b-deploy.log | tail -20
fi

applied=$($PSQL -tAc "SELECT COUNT(*) FROM _prisma_migrations WHERE migration_name = '20270610000000_phase5_t6b_status_derivation' AND finished_at IS NOT NULL AND rolled_back_at IS NULL")
[ "$applied" = "1" ] \
  && ok "…and the ledger records it as finished, not rolled back" \
  || bad "the migration is not recorded as applied (found '$applied')"

# ── 4. the seals are live, and every in-family bill agrees with its own folds ────────────────────
#
# DERIVED from the migrations, not written down. This assertion was a hardcoded six-name string
# until 6B-ii added `PaymentReversal_t6b_status_sealed` and it failed for saying so — root A one
# more time, in the third place this module has enumerated the same set (the upgrade proof, the
# contract closure, and here). The closure in `commercial.contract.test.ts` already derives WHICH
# TABLES need a seal from what the folds read; this asks a narrower question the closure cannot —
# is every seal the migrations DECLARE actually installed on this database, after a real
# `prisma migrate deploy` rather than a `psql --single-transaction` apply.
expected_seals=$(grep -ho '^CREATE CONSTRAINT TRIGGER "\w*_t6b_status_sealed"' "$API"/prisma/migrations/*/migration.sql \
  | sed 's/.*"\(.*\)_t6b_status_sealed"/\1/' | sort -u | paste -sd/ -)
seals=$($PSQL -tAc "SELECT string_agg(c.relname, '/' ORDER BY c.relname) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname LIKE '%_t6b_status_sealed' AND NOT t.tgisinternal")
if [ -z "$expected_seals" ]; then
  bad "no derivation seals were found in the migrations — this assertion would pass vacuously"
elif [ "$seals" = "$expected_seals" ]; then
  ok "every derivation seal the migrations declare is installed after the cutover ($expected_seals)"
else
  bad "the seal set after the cutover is '$seals', but the migrations declare '$expected_seals'"
fi

# ── 5. THE DATA OUTCOME — the seeded row, by name, not a count over an empty table ───────────────
after=$($PSQL -tAc "SELECT \"status\" FROM \"VendorBill\" WHERE \"id\" = 't6b-bill'")
derived=$($PSQL -tAc "SELECT phase5_t6b_derive_bill_status('t6b-proj', 't6b-bill')")
[ "$after" = "approved-for-payment" ] && [ "$derived" = "approved-for-payment" ] \
  && ok "the backfill CORRECTED the 6A-shaped bill: stored '$after' equals what its folds derive" \
  || bad "the seeded bill is stored '$after' while its folds derive '$derived' — the backfill did not correct it"

# …and the same statement over every bill, which is the general claim. It is asserted BESIDE the
# named row rather than instead of it: alone it would pass on an empty table, which is exactly how
# the first version of this script reported a data outcome it had not tested.
bills=$($PSQL -tAc "SELECT COUNT(*) FROM \"VendorBill\" WHERE phase5_t6b_derived_bill_status(\"status\")")
incoherent=$($PSQL -tAc "SELECT COUNT(*) FROM \"VendorBill\" b WHERE phase5_t6b_derived_bill_status(b.\"status\") AND b.\"status\" <> phase5_t6b_derive_bill_status(b.\"projectId\", b.\"id\")")
[ "${bills:-0}" -ge 1 ] \
  && ok "…and the sweep below is over $bills in-family bill(s), so it is not passing on an empty table" \
  || bad "there are no in-family bills — the sweep would pass vacuously"
[ "$incoherent" = "0" ] \
  && ok "no bill is stored at a status its own folds contradict" \
  || bad "$incoherent bill(s) are stored at a status their folds contradict"

echo ""
if [ "$FAIL" = "0" ]; then
  echo "T6B PRODUCTION RUNNER PROOF PASSED: the cutover barrier holds under the real 'prisma migrate deploy'."
else
  echo "T6B PRODUCTION RUNNER PROOF FAILED: see the assertions above."
fi
exit $FAIL
