#!/usr/bin/env bash
# Phase 2 fix-forward PR B Task 5 — the durable-outbox migration ABORT → REPAIR → REDEPLOY proof.
#
# Builds a database at the point JUST BEFORE the PR B migration (every migration except
# 20261026000000_phase2_outbox_reliability), plants a DomainEvent and an OutboxDelivery whose
# copied coordinates DISAGREE with that event, then:
#   1. applies the PR B migration            → the diagnostic must ABORT (never guess a repair);
#   2. corrects ONLY the forged delivery coordinate (the append-only event is authoritative);
#   3. re-applies the PR B migration          → must SUCCEED;
#   4. asserts the repaired delivery survived with the deliveryAction default 'dispatch'.
#
# DESTRUCTIVE for the scratch database only (default: pmcvitan_outbox_abort_proof). Connection comes
# from the standard PG* variables; defaults suit the CI postgres:16 service and the dev container.
set -u

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

DB="${OUTBOX_ABORT_PROOF_DB:-pmcvitan_outbox_abort_proof}"
MIG_DIR="$(cd "$(dirname "$0")/../prisma/migrations" && pwd)"
PRB="20261026000000_phase2_outbox_reliability"

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
PSQL="psql -X -q -v ON_ERROR_STOP=1 -d $DB"

echo "=== outbox-abort-proof: rebuilding scratch database '$DB' ==="
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" || exit 1
$PSQL_ADMIN -c "CREATE DATABASE $DB;" || exit 1

echo "=== applying every migration EXCEPT PR B ($PRB) ==="
applied=0
for d in $(ls -d "$MIG_DIR"/*/ | sort); do
  name="$(basename "$d")"
  [ "$name" = "$PRB" ] && continue
  $PSQL -f "$d/migration.sql" >/dev/null || { echo "baseline migration failed: $name"; exit 1; }
  applied=$((applied + 1))
done
echo "applied $applied migrations (PR B held back)"

echo "=== planting an event + a FORGED-coordinate delivery ==="
$PSQL <<'SQL' || { echo "fixture failed"; exit 1; }
INSERT INTO "Org" ("id","name","slug") VALUES ('o-abort','Abort Org','abort-org');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('p-abort','o-abort','Abort Site','AB','','Finishing','AB-01','01 Jan 2026','31 Dec 2026',0,0,0);
-- a valid append-only event (system attribution) at stream position 0
INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","occurredAt")
  VALUES ('ev-abort','decision.approved',1,'o-abort','p-abort',0,'system','system','Decision','D-1',now());
-- a delivery whose copied (projectId, streamPosition) DISAGREE with the event above
INSERT INTO "OutboxDelivery" ("id","eventId","projectId","consumer","consumerKind","streamPosition","status","attempts","nextAttemptAt","createdAt","updatedAt")
  VALUES ('del-abort','ev-abort','WRONG-PROJECT','socket.invalidation','unordered',999,'pending',0,now(),now(),now());
SQL
echo "planted (delivery del-abort claims WRONG-PROJECT/999 vs event p-abort/0)"

echo ""
echo "=== 1. applying PR B over the forged coordinate — expect ABORT ==="
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$MIG_DIR/$PRB/migration.sql" >/tmp/prb-abort.log 2>&1; then
  echo "FAILED: PR B migration should have ABORTED on the forged coordinate but succeeded"; exit 1
fi
if grep -q "coordinates that disagree with their DomainEvent" /tmp/prb-abort.log; then
  echo "ok  the diagnostic aborted with the coordinate-mismatch diagnostic (no guessed repair)"
else
  echo "FAILED: PR B aborted for the WRONG reason:"; cat /tmp/prb-abort.log; exit 1
fi

echo ""
echo "=== 2. correcting ONLY the fixture coordinate (the event is never rewritten) ==="
$PSQL -c "UPDATE \"OutboxDelivery\" SET \"projectId\"='p-abort', \"streamPosition\"=0 WHERE \"id\"='del-abort';" || exit 1

echo "=== 3. re-applying PR B — expect SUCCESS ==="
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$MIG_DIR/$PRB/migration.sql" >/tmp/prb-redeploy.log 2>&1; then
  echo "ok  redeploy succeeded after the fixture was corrected"
else
  echo "FAILED: redeploy failed after correction:"; cat /tmp/prb-redeploy.log; exit 1
fi

echo ""
echo "=== 4. asserting the repaired delivery survived with deliveryAction default 'dispatch' ==="
got=$($PSQL -tAc "SELECT \"deliveryAction\" || '|' || \"projectId\" || '|' || \"streamPosition\" FROM \"OutboxDelivery\" WHERE \"id\"='del-abort';")
if [ "$got" = "dispatch|p-abort|0" ]; then
  echo "ok  delivery survived: deliveryAction=dispatch, coordinates now match the event"
else
  echo "FAILED: expected [dispatch|p-abort|0] got [$got]"; exit 1
fi

echo ""
echo "OUTBOX ABORT PROOF PASSED: the migration aborts on a forged coordinate, and a corrected fixture redeploys cleanly with history preserved."
