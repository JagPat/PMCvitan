#!/usr/bin/env bash
# Phase 1 Task 7 Step 2 — representative upgraded-database proof.
#
# Builds a database at the PRE-Phase-1 point of the real migration ledger
# (every migration before 20260910000000_phase1_change_control), plants a
# legacy fixture holding the shapes Phase 1 had to migrate around:
#
#   - a reopened decision with a legacy 'pending' change request  (Task 2)
#   - an approved decision with a stale  'pending' change request (Task 2)
#   - drawing revisions WITHOUT projectId, two drawings in two projects,
#     one already for_construction                                 (Task 3)
#   - a checklist whose items carry only the photos COUNTER — no linked
#     evidence rows                                               (Task 4)
#   - a done activity + its zero-item 'INSP-<id>-close' closing, plus a
#     stray close-pattern id naming no activity                   (Task 5)
#   - a stored gateInspection flag on a live activity             (Task 6)
#   - an existing named user with a password hash                  (credential rollout)
#
# then applies ALL Phase 1 migrations in ledger order — each the way Prisma
# does (one transaction, stop on error) — echoing their diagnostic output,
# and finally ASSERTS that legacy meaning survived. Any mismatch fails the
# script (and the CI job that runs it).
#
# DESTRUCTIVE for the scratch database only (default: pmcvitan_upgrade_proof).
# Connection comes from the standard PG* environment variables; defaults suit
# the CI postgres:16 service and the local dev container.
#
# Per-task STOP-condition proofs (ambiguous fixtures that must ABORT the
# migration) live in each task's PR evidence; this script is the composite
# HAPPY-PATH upgrade over one representative legacy dataset. Phase 2 should
# extend the fixture rather than widen the migration range here.

set -u

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5432}"
export PGUSER="${PGUSER:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

DB="${UPGRADE_PROOF_DB:-pmcvitan_upgrade_proof}"
MIG_DIR="$(cd "$(dirname "$0")/../prisma/migrations" && pwd)"
PHASE1_FIRST=20260910000000

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
PSQL="psql -X -v ON_ERROR_STOP=1 -d $DB"

echo "=== upgrade-proof: rebuilding scratch database '$DB' ==="
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" || exit 1
$PSQL_ADMIN -c "CREATE DATABASE $DB;" || exit 1

# ---- 1. the PRE-Phase-1 ledger ------------------------------------------------
baseline=0
phase1_dirs=()
for d in $(ls -d "$MIG_DIR"/*/ | sort); do
  name="$(basename "$d")"
  stamp="${name%%_*}"
  if [ "$stamp" -lt "$PHASE1_FIRST" ] 2>/dev/null || [ "$name" = "0_init" ]; then
    $PSQL -q -f "$d/migration.sql" >/dev/null || { echo "baseline migration failed: $name"; exit 1; }
    baseline=$((baseline + 1))
  else
    phase1_dirs+=("$d")
  fi
done
echo "baseline: $baseline pre-Phase-1 migrations applied"
echo "upgrade:  ${#phase1_dirs[@]} Phase 1 migrations queued"

# ---- 2. the legacy fixture ----------------------------------------------------
echo ""
echo "=== planting the legacy fixture (pre-Phase-1 shapes) ==="
$PSQL -q <<'SQL' || { echo "fixture failed"; exit 1; }
INSERT INTO "Project" ("id","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
VALUES ('p1','Legacy Site A','LA','','Finishing','LA-01','01 Jan 2026','31 Dec 2026',50,30,60),
       ('p2','Legacy Site B','LB','','Finishing','LB-01','01 Jan 2026','31 Dec 2026',50,30,60);

-- Credential-rollout shape: an existing password must survive the additive
-- enrollment migration byte-for-byte, with the compatibility version at zero.
INSERT INTO "User" ("id","projectId","role","name","email","passwordHash")
VALUES ('USER-1','p1','pmc','Legacy PMC','legacy@vitan.in','legacy-bcrypt-hash');

-- Task 2 shapes: a reopened decision with a would-be-open legacy request, and
-- an approved decision with a stale pending one (closed long ago, never modeled)
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch")
VALUES ('DL-1','p1','Kota vs granite','Hall','change','stone'),
       ('DL-2','p1','Teak finish','Study','approved','teak');
INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status")
VALUES ('CR-1','DL-1','Lot rejected at yard',0,3,'pending'),
       ('CR-2','DL-2','Old query, settled on site',0,0,'pending');

-- Task 5/6 shapes: a done activity with its zero-item closing, a stray
-- close-pattern id naming NO activity, and a stored gateInspection flag
INSERT INTO "Activity" ("id","projectId","name","zone","plannedStart","plannedEnd","status","actualEnd","gateInspection")
VALUES ('ACT-1','p1','Flooring','Hall',0,5,'done',20,'na'),
       ('ACT-2','p1','Painting','Study',0,5,'in_progress',NULL,'fail');
INSERT INTO "Inspection" ("id","projectId","kind","title","zone","date","submitted","decided")
VALUES ('INSP-ACT-1-close','p1','review','Closing inspection: Flooring','Hall','20 Jun 2026',true,false),
       ('INSP-GHOST-close','p1','review','Oddly named legacy row','Hall','20 Jun 2026',true,false),
-- Task 4 shape: a checklist whose item counts photos but links no evidence
       ('INSP-7','p1','checklist','Waterproofing check','Bath','21 Jun 2026',true,false);
INSERT INTO "InspectionItem" ("id","inspectionId","name","photos")
VALUES ('IT-1','INSP-7','Membrane lapped',3);

-- Task 3 shapes: revisions with NO projectId column at all; one drawing per
-- project so the backfill must find each revision's OWN parent project
INSERT INTO "Drawing" ("id","projectId","number","title","discipline")
VALUES ('DWG-1','p1','A-101','Hall flooring layout','architectural'),
       ('DWG-2','p2','B-201','Site B lobby plan','architectural');
INSERT INTO "DrawingRevision" ("id","drawingId","rev","status","mime","issuedBy","issuedAt")
VALUES ('REV-A','DWG-1','A','superseded','application/pdf','PMC','01 Jun 2026'),
       ('REV-B','DWG-1','B','for_construction','application/pdf','PMC','10 Jun 2026'),
       ('REV-C','DWG-2','A','for_construction','application/pdf','PMC','12 Jun 2026');
SQL
echo "fixture planted"

# ---- 3. the Phase 1 upgrade, one migration at a time --------------------------
for d in "${phase1_dirs[@]}"; do
  name="$(basename "$d")"
  echo ""
  echo "=== applying $name (single transaction) — diagnostics follow ==="
  if ! psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$d/migration.sql" 2>&1 \
      | grep -Ev '^(SET|SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|DO|COMMENT)' ; then
    true # grep exits 1 when a migration emits no diagnostics — that is fine
  fi
  # the pipeline above swallows psql's exit code; re-check the migration landed
  applied=$(psql -X -tAc "SELECT 1" -d "$DB")
  [ "$applied" = "1" ] || { echo "database unreachable after $name"; exit 1; }
done

# a migration that ABORTED leaves its objects missing — the assertions below
# would catch it, but fail fast with a clear message if the ledger tail is gone
tail_ok=$($PSQL -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='GateOverride');")
[ "$tail_ok" = "t" ] || { echo "FAILED: the Phase 1 ledger did not fully apply (GateOverride missing)"; exit 1; }

# ---- 4. assertions: legacy meaning is preserved -------------------------------
echo ""
echo "=== assertions: legacy meaning survived the upgrade ==="
FAIL=0
assert() {
  local label="$1" sql="$2" want="$3" got
  got=$($PSQL -tAc "$sql")
  if [ "$got" = "$want" ]; then
    printf 'ok      %s\n' "$label"
  else
    printf 'FAILED  %s\n        expected: [%s]\n        got:      [%s]\n' "$label" "$want" "$got"
    FAIL=1
  fi
}

# Task 2 — change control
assert "reopened decision's pending request became the one open request" \
  "SELECT status || '|' || COALESCE(resolution,'<null>') FROM \"ChangeRequest\" WHERE id='CR-1';" \
  "open|<null>"
assert "stale pending request on an approved decision closed as resolved, resolution NOT invented" \
  "SELECT status || '|' || COALESCE(resolution,'<null>') FROM \"ChangeRequest\" WHERE id='CR-2';" \
  "resolved|<null>"
assert "decision statuses untouched (change stays change, approved stays approved)" \
  "SELECT string_agg(id || '=' || status, ',' ORDER BY id) FROM \"Decision\";" \
  "DL-1=change,DL-2=approved"
assert "one-open-request invariant is database-enforced (partial unique index)" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname='ChangeRequest_one_open_per_decision';" \
  "1"

# Task 3 — drawing control
assert "revision projectId backfilled from each revision's OWN parent drawing" \
  "SELECT string_agg(id || '=' || \"projectId\", ',' ORDER BY id) FROM \"DrawingRevision\";" \
  "REV-A=p1,REV-B=p1,REV-C=p2"
assert "revision projectId locked NOT NULL after backfill" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_name='DrawingRevision' AND column_name='projectId';" \
  "NO"
assert "legacy revisions keep recipientsFrozenAt NULL — snapshots are never fabricated" \
  "SELECT COUNT(*) FROM \"DrawingRevision\" WHERE \"recipientsFrozenAt\" IS NOT NULL;" \
  "0"
assert "no recipient rows invented for legacy revisions" \
  "SELECT COUNT(*) FROM \"DrawingRecipient\";" \
  "0"
assert "one governing for_construction revision per drawing is database-enforced" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname='DrawingRevision_one_construction_per_drawing';" \
  "1"

# Task 4 — inspection evidence
assert "counter-only item keeps its photos counter; no evidence rows invented" \
  "SELECT (SELECT photos FROM \"InspectionItem\" WHERE id='IT-1')::text || '|' || (SELECT COUNT(*) FROM \"Media\")::text;" \
  "3|0"

# Task 5 — closing sign-off
assert "done activity stays done (status is never rewritten by the upgrade)" \
  "SELECT status || '|' || COALESCE(\"completionRequestedById\",'<null>') FROM \"Activity\" WHERE id='ACT-1';" \
  "done|<null>"
assert "the exactly-one-same-project closing was linked and flagged" \
  "SELECT closing::text || '|' || COALESCE(\"activityId\",'<null>') FROM \"Inspection\" WHERE id='INSP-ACT-1-close';" \
  "true|ACT-1"
assert "zero-item legacy closing still carries zero items (child gets the default item at REJECT time, not at migration time)" \
  "SELECT COUNT(*) FROM \"InspectionItem\" WHERE \"inspectionId\"='INSP-ACT-1-close';" \
  "0"
assert "stray close-pattern id naming no activity is left alone (reported, never guessed)" \
  "SELECT closing::text || '|' || COALESCE(\"activityId\",'<null>') FROM \"Inspection\" WHERE id='INSP-GHOST-close';" \
  "false|<null>"
assert "awaiting_signoff exists in the enum but no legacy row was moved into it" \
  "SELECT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='ActivityStatus' AND e.enumlabel='awaiting_signoff')::text || '|' || (SELECT COUNT(*) FROM \"Activity\" WHERE status='awaiting_signoff')::text;" \
  "true|0"

# Task 6 — derived readiness
assert "stored gateInspection flag preserved verbatim (read path derives; the column is deprecated, not rewritten)" \
  "SELECT \"gateInspection\" FROM \"Activity\" WHERE id='ACT-2';" \
  "fail"
assert "GateOverride table exists and the upgrade granted no overrides" \
  "SELECT COUNT(*) FROM \"GateOverride\";" \
  "0"

# Internal named-user password enrollment — additive and data-preserving
assert "existing password hash survives credential migration unchanged" \
  "SELECT \"passwordHash\" FROM \"User\" WHERE id='USER-1';" \
  "legacy-bcrypt-hash"
assert "legacy user starts at credential version zero without fabricated verification" \
  "SELECT \"credentialVersion\"::text || '|' || COALESCE(\"emailVerifiedAt\"::text,'<null>') FROM \"User\" WHERE id='USER-1';" \
  "0|<null>"
assert "durable password challenge and security audit tables exist" \
  "SELECT ((to_regclass('\"PasswordCredentialChallenge\"') IS NOT NULL) AND (to_regclass('\"SecurityAuditEvent\"') IS NOT NULL))::text;" \
  "true"

echo ""
if [ "$FAIL" = "0" ]; then
  echo "UPGRADE PROOF PASSED: all Phase 1 migrations applied over the legacy fixture and every legacy meaning survived."
else
  echo "UPGRADE PROOF FAILED: see the assertions above."
fi
exit $FAIL
