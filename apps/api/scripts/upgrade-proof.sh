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
# The Phase-3 round-2 provenance migration gets its own stop: a REAL PR-189-era fixture is
# planted at the pre-round-2 point, the migration is REHEARSED against forged provenance
# (it must ABORT), the operator repairs, and only then does it apply.
PHASE3_R2=20261212000000

PSQL_ADMIN="psql -X -q -v ON_ERROR_STOP=1 -d postgres"
PSQL="psql -X -v ON_ERROR_STOP=1 -d $DB"

echo "=== upgrade-proof: rebuilding scratch database '$DB' ==="
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB;" || exit 1
$PSQL_ADMIN -c "CREATE DATABASE $DB;" || exit 1

# ---- 1. the PRE-Phase-1 ledger ------------------------------------------------
baseline=0
phase1_dirs=()
phase3_r2_dirs=()
for d in $(ls -d "$MIG_DIR"/*/ | sort); do
  name="$(basename "$d")"
  stamp="${name%%_*}"
  if [ "$stamp" -lt "$PHASE1_FIRST" ] 2>/dev/null || [ "$name" = "0_init" ]; then
    $PSQL -q -f "$d/migration.sql" >/dev/null || { echo "baseline migration failed: $name"; exit 1; }
    baseline=$((baseline + 1))
  elif [ "$stamp" -ge "$PHASE3_R2" ] 2>/dev/null; then
    phase3_r2_dirs+=("$d")
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
-- Tenancy shape (Phase 2 Task 4): the event envelope requires every project to have an org,
-- so its migration ABORTS on a null orgId. This legacy DB is one the operator has already
-- tenant-backfilled (ensure-accounts) before upgrading — the projects carry their org, and
-- they predate the event store (they hold NO DomainEvent rows, asserted below).
INSERT INTO "Org" ("id","name","slug") VALUES ('org-legacy','Legacy Org','legacy-org');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
VALUES ('p1','org-legacy','Legacy Site A','LA','','Finishing','LA-01','01 Jan 2026','31 Dec 2026',50,30,60),
       ('p2','org-legacy','Legacy Site B','LB','','Finishing','LB-01','01 Jan 2026','31 Dec 2026',50,30,60);

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

# ---- 3b. the PR-189-era fixture at the PRE-round-2 point --------------------------------
# Real Task-1 rows as PR #189/#190 wrote them: an approved decision with a recorded approval
# event, a requirement whose spec carries the event-count-derived provenance triple, PLUS a
# spec whose triple was FORGED (names an approval that never happened). The round-2 migration
# must backfill the register from the provable history, ABORT on the forged row until an
# operator explicitly repairs it, and never null anything silently.
echo ""
echo "=== planting the PR-189-era fixture (pre-round-2 shapes) ==="
$PSQL -q <<'SQL' || { echo "PR-189 fixture failed"; exit 1; }
-- DL-3: approved once, option provable ('Option A' -> key 'a'), approver recorded
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","approvedOption","approvedById","publishedAt","createdAt")
VALUES ('DL-3','p1','Cement make','Hall','approved','grey','Option A','USER-1',NOW(),'2026-05-01');
INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch")
VALUES ('OPT-31','DL-3','Option A','a','UltraTech OPC 53',0,'grey'),
       ('OPT-32','DL-3','Option B','b','Ambuja OPC 53',500,'grey');
INSERT INTO "DecisionEvent" ("id","decisionId","type","actor","actorId","at","payload")
VALUES ('EV-31','DL-3','approved','Legacy PMC','USER-1','2026-06-01','{"option":"Option A"}');

-- DL-4: approved then reapproved — the CURRENT approval (v2, 'Option B' -> key 'b') is the
-- provable one; the v1 history is NOT fabricated by the backfill
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","approvedOption","approvedById","publishedAt","createdAt")
VALUES ('DL-4','p1','Tile grade','Bath','approved','ivory','Option B','USER-1',NOW(),'2026-05-02');
INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch")
VALUES ('OPT-41','DL-4','Option A','a','Vitrified 600',0,'ivory'),
       ('OPT-42','DL-4','Option B','b','Vitrified 800',900,'ivory');
INSERT INTO "DecisionEvent" ("id","decisionId","type","actor","actorId","at","payload")
VALUES ('EV-41','DL-4','approved','Legacy PMC','USER-1','2026-06-02','{"option":"Option A"}'),
       ('EV-42','DL-4','reapproved','Legacy PMC','USER-1','2026-06-12','{"option":"Option B"}');

-- REQ-1: a PR-189 material requirement whose spec pins DL-3's approval exactly as
-- approvedRef served it then (version = event count 1, option key 'a')
INSERT INTO "ActivityRequirementRoot" ("id","projectId","createdById") VALUES ('REQ-1','p1','USER-1');
INSERT INTO "ActivityRequirement" ("id","projectId","requirementId","revision","activityId","requiredQty","baseUom","requiredBy","createdById")
VALUES ('AR-1','p1','REQ-1',1,'ACT-1',100,'bag','2026-08-15','USER-1');
INSERT INTO "MaterialRequirementSpec" ("id","projectId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","baseUom","specFingerprint","decisionId","decisionVersion","optionKey")
VALUES ('S-1','p1','REQ-1',1,'cement','ultratech','opc 53','grey','bag','fp-legacy-1','DL-3',1,'a');

-- REQ-2: the FORGED row — a provenance triple naming an approval that NEVER happened
INSERT INTO "ActivityRequirementRoot" ("id","projectId","createdById") VALUES ('REQ-2','p1','USER-1');
INSERT INTO "ActivityRequirement" ("id","projectId","requirementId","revision","activityId","requiredQty","baseUom","requiredBy","createdById")
VALUES ('AR-2','p1','REQ-2',1,'ACT-1',50,'bag','2026-09-01','USER-1');
INSERT INTO "MaterialRequirementSpec" ("id","projectId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","baseUom","specFingerprint","decisionId","decisionVersion","optionKey")
VALUES ('S-FORGED','p1','REQ-2',1,'cement','forged','opc 43','grey','bag','fp-forged','DL-3',999,'zz');

-- REQ-3: the #191-review reproduction — a requirement created WHILE DL-4's FIRST approval
-- (v1, Option A) governed; the decision was then reopened and reapproved as v2/Option B.
-- This VALID earlier-version reference must survive the upgrade VERBATIM — the round-2
-- current-only backfill falsely rejected it as forged.
INSERT INTO "ActivityRequirementRoot" ("id","projectId","createdById") VALUES ('REQ-3','p1','USER-1');
INSERT INTO "ActivityRequirement" ("id","projectId","requirementId","revision","activityId","requiredQty","baseUom","requiredBy","createdById")
VALUES ('AR-3','p1','REQ-3',1,'ACT-1',75,'bag','2026-08-20','USER-1');
INSERT INTO "MaterialRequirementSpec" ("id","projectId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","baseUom","specFingerprint","decisionId","decisionVersion","optionKey")
VALUES ('S-2','p1','REQ-3',1,'tile','vitrified 600','std','ivory','bag','fp-legacy-2','DL-4',1,'a');
SQL
echo "PR-189 fixture planted (incl. one FORGED triple and one VALID earlier-version reference)"

# ---- 3c. REHEARSAL: the provenance migration must ABORT on the forged row ---------------
# (the VALID earlier-version reference S-2 must NOT trip it — only S-FORGED may appear)
echo ""
echo "=== REHEARSAL: applying the provenance migration over FORGED provenance (must ABORT) ==="
R2_PROVENANCE="$MIG_DIR/20261212000000_phase3_approval_provenance"
R3_HISTORY="$MIG_DIR/20261216000000_phase3_approval_history"
[ -d "$R2_PROVENANCE" ] && [ -d "$R3_HISTORY" ] || { echo "FAILED: expected Phase-3 provenance migrations missing from the ledger"; exit 1; }
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$R2_PROVENANCE/migration.sql" > /tmp/upgrade-r2-rehearsal.log 2>&1; then
  echo "FAILED: the provenance migration applied over FORGED provenance instead of aborting"; exit 1
fi
grep -q "FORGED or UNVERIFIABLE" /tmp/upgrade-r2-rehearsal.log || { echo "FAILED: no forged-provenance diagnostic in the abort output"; cat /tmp/upgrade-r2-rehearsal.log; exit 1; }
grep -q "S-FORGED" /tmp/upgrade-r2-rehearsal.log || { echo "FAILED: the abort did not SAMPLE the forged row"; cat /tmp/upgrade-r2-rehearsal.log; exit 1; }
grep -q "S-2" /tmp/upgrade-r2-rehearsal.log && { echo "FAILED: the VALID earlier-version reference S-2 was falsely flagged as forged"; cat /tmp/upgrade-r2-rehearsal.log; exit 1; }
echo "rehearsal ok: ABORTED, sampled ONLY the forged row (the valid v1 reference passed)"

# ---- 3d. EXPLICIT operator repair, then the real round-2 upgrade ------------------------
# The append-only trigger guards the spec table, so the repair is a deliberate, privileged,
# in-the-open act: disable the trigger, strip the forged reference to a manual spec
# (the technical identity is kept — only the false approval claim is removed), re-enable.
echo ""
echo "=== operator repair: stripping the FORGED provenance (explicit, trigger disabled/re-enabled) ==="
$PSQL -q <<'SQL' || { echo "operator repair failed"; exit 1; }
ALTER TABLE "MaterialRequirementSpec" DISABLE TRIGGER "MaterialRequirementSpec_append_only";
UPDATE "MaterialRequirementSpec"
   SET "decisionId" = NULL, "decisionVersion" = NULL, "optionKey" = NULL
 WHERE "id" = 'S-FORGED';
ALTER TABLE "MaterialRequirementSpec" ENABLE TRIGGER "MaterialRequirementSpec_append_only";
SQL
echo "repaired: S-FORGED is a manual specification again"

apply_one() {
  local d="$1" name
  name="$(basename "$d")"
  echo ""
  echo "=== applying $name (single transaction) — diagnostics follow ==="
  if ! psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$d/migration.sql" 2>&1 \
      | grep -Ev '^(SET|SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|DO|COMMENT)' ; then
    true
  fi
  applied=$(psql -X -tAc "SELECT 1" -d "$DB")
  [ "$applied" = "1" ] || { echo "database unreachable after $name"; exit 1; }
}

apply_one "$R2_PROVENANCE"
r2_ok=$($PSQL -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='DecisionApprovalRevision');")
[ "$r2_ok" = "t" ] || { echo "FAILED: the provenance migration did not apply after repair (DecisionApprovalRevision missing)"; exit 1; }

# ---- 3e. simulate an ALREADY-APPLIED (defective round-2) database ------------------------
# A database that ran the DEFECTIVE current-only backfill holds ONLY latest-version register
# rows. Plant a decision in exactly that state (two provable approval events, register row
# for v2 only) BEFORE the history migration — it must complete the missing v1, idempotently.
echo ""
echo "=== planting the applied-defective simulation (DL-6: register holds only v2) ==="
$PSQL -q <<'SQL' || { echo "applied-defective fixture failed"; exit 1; }
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","approvedOption","approvedById","publishedAt","createdAt")
VALUES ('DL-6','p1','Paint system','Study','approved','sand','Option B','USER-1',NOW(),'2026-05-03');
INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch")
VALUES ('OPT-61','DL-6','Option A','a','Acrylic emulsion',0,'sand'),
       ('OPT-62','DL-6','Option B','b','Silicone emulsion',700,'sand');
INSERT INTO "DecisionEvent" ("id","decisionId","type","actor","actorId","at","payload")
VALUES ('EV-61','DL-6','approved','Legacy PMC','USER-1','2026-06-03','{"option":"Option A"}'),
       ('EV-62','DL-6','reapproved','Legacy PMC','USER-1','2026-06-13','{"option":"Option B"}');
INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById")
VALUES ('dar-DL-6-v2','p1','DL-6',2,'b','2026-06-13','USER-1');
SQL
echo "applied-defective simulation planted"

apply_one "$R3_HISTORY"

# the history migration is IDEMPOTENT — a second run inserts nothing and changes nothing
before_count=$($PSQL -tAc 'SELECT COUNT(*) FROM "DecisionApprovalRevision";')
apply_one "$R3_HISTORY"
after_count=$($PSQL -tAc 'SELECT COUNT(*) FROM "DecisionApprovalRevision";')
[ "$before_count" = "$after_count" ] || { echo "FAILED: the history migration is not idempotent ($before_count -> $after_count rows)"; exit 1; }
echo "history migration idempotency: $before_count rows before and after the re-run"

# ---- 3f. the remaining ledger to HEAD ----------------------------------------------------
# Migrations stamped after the round-2 stop (Task 2 procurement onward) also land in
# phase3_r2_dirs; the explicit round-2/3 stops above covered exactly two of them. Apply every
# remaining one in ledger order so the proof upgrades the legacy database all the way to HEAD.
for d in "${phase3_r2_dirs[@]}"; do
  case "$(basename "$d")" in
    "$(basename "$R2_PROVENANCE")"|"$(basename "$R3_HISTORY")") continue ;;
  esac
  apply_one "$d"
done

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
  "SELECT string_agg(id || '=' || status, ',' ORDER BY id) FROM \"Decision\" WHERE id IN ('DL-1','DL-2');" \
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

# Phase 2 Task 4 — the domain-event envelope is additive over a tenant-backfilled legacy DB
assert "the event store + per-project stream counter tables exist" \
  "SELECT ((to_regclass('\"DomainEvent\"') IS NOT NULL) AND (to_regclass('\"ProjectEventStream\"') IS NOT NULL))::text;" \
  "true"
assert "Project.orgId was locked NOT NULL (every project now carries a tenant)" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_name='Project' AND column_name='orgId';" \
  "NO"
assert "the composite tenant identity (orgId, id) is database-enforced" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname='Project_orgId_id_key';" \
  "1"
assert "every legacy project was backfilled its stream counter at position 0" \
  "SELECT COUNT(*) FILTER (WHERE \"nextPosition\" = 0)::text || '/' || COUNT(*)::text FROM \"ProjectEventStream\";" \
  "2/2"
assert "the append-only trigger guards the event store" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname='DomainEvent_append_only';" \
  "1"
assert "the attribution truth-table CHECK exists" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname='DomainEvent_attribution_truth_table';" \
  "1"
assert "a legacy project predates the event store — it carries NO domain events" \
  "SELECT COUNT(*) FROM \"DomainEvent\" WHERE \"projectId\"='p1';" \
  "0"
assert "legacy decisions/activities are untouched by the additive event migration" \
  "SELECT (SELECT status FROM \"Decision\" WHERE id='DL-1') || '|' || (SELECT status FROM \"Activity\" WHERE id='ACT-1');" \
  "change|done"

# Phase 2 Task 5 — the command-idempotency ledger is a pure, row-free capability addition
assert "the CommandExecution ledger table exists" \
  "SELECT (to_regclass('\"CommandExecution\"') IS NOT NULL)::text;" \
  "true"
assert "both SCOPE-SPECIFIC partial unique indexes exist (project index never constrains org rows and vice versa)" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname IN ('command_execution_project_key','command_execution_org_key');" \
  "2"
assert "the scope truth-table CHECK and the status CHECK are database-enforced" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('CommandExecution_scope_truth_table','CommandExecution_status_check');" \
  "2"
assert "the composite project-scoped tenant FK (organizationId, projectId) -> Project(orgId, id) exists" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname='CommandExecution_tenant_fkey' AND contype='f';" \
  "1"
assert "the additive migration wrote NO receipts — a legacy client that sends no key keeps working" \
  "SELECT COUNT(*) FROM \"CommandExecution\";" \
  "0"

# Phase 2 Task 6 — the per-consumer transactional outbox is a pure, row-free capability addition
assert "the OutboxDelivery / ProcessedEvent / ProjectionCursor tables exist" \
  "SELECT ((to_regclass('\"OutboxDelivery\"') IS NOT NULL) AND (to_regclass('\"ProcessedEvent\"') IS NOT NULL) AND (to_regclass('\"ProjectionCursor\"') IS NOT NULL))::text;" \
  "true"
# (PR B replaces the event-only FK with the composite coordinate FK — asserted in the PR B block below.)
assert "the (eventId, consumer) unique is database-enforced" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname='OutboxDelivery_eventId_consumer_key';" \
  "1"
assert "the delivery status / consumerKind / cursor-status CHECKs exist (NO ambiguous 'failed' status)" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('OutboxDelivery_status_check','OutboxDelivery_consumerKind_check','ProjectionCursor_status_check');" \
  "3"
assert "the additive migration wrote NO deliveries — pre-cutover events are backfilled at app boot" \
  "SELECT COUNT(*) FROM \"OutboxDelivery\";" \
  "0"

# Phase 2 Task 7 — the module-boundary edges 5/6/7 became database ON DELETE SET NULL FK
# actions (confdeltype 'n'); the guarded/blocking edges stay NO ACTION ('a'). Row-free.
assert "the seven referential edges (5/6/7) are now ON DELETE SET NULL (confdeltype 'n')" \
  "SELECT string_agg(confdeltype, '' ORDER BY conname) FROM pg_constraint WHERE conname IN ('Activity_projectId_nodeId_fkey','Activity_projectId_phaseId_fkey','Drawing_projectId_activityId_fkey','Drawing_projectId_nodeId_fkey','Inspection_projectId_nodeId_fkey','Media_projectId_nodeId_fkey','SiteMaterial_projectId_nodeId_fkey');" \
  "nnnnnnn"
assert "the guarded/blocking edges stay NO ACTION ('a'): Decision node-guard + Inspection/GateOverride activity-block" \
  "SELECT string_agg(confdeltype, '' ORDER BY conname) FROM pg_constraint WHERE conname IN ('Decision_projectId_nodeId_fkey','GateOverride_projectId_activityId_fkey','Inspection_projectId_activityId_fkey');" \
  "aaa"

# Phase 2 fix-forward PR B — durable outbox reliability. Additive + constraint-strengthening over a
# legacy (event-free) DB: the durable consumer catalog, the composite coordinate FK binding a
# delivery to its event's real coordinates, the catalog FK binding a delivery to a declared
# contract, the dispatch/noop action, and the persisted dispatch intent. Row-free here.
assert "the durable catalog / operator-action / cutover-state tables exist" \
  "SELECT ((to_regclass('\"OutboxConsumerCatalog\"') IS NOT NULL) AND (to_regclass('\"OutboxOperatorAction\"') IS NOT NULL) AND (to_regclass('\"OutboxCutoverState\"') IS NOT NULL))::text;" \
  "true"
assert "the two existing consumer contracts were seeded (v1, unordered/external)" \
  "SELECT string_agg(consumer || '=' || \"consumerKind\" || '/' || \"consumerEffect\" || '/v' || \"catalogVersion\", ',' ORDER BY consumer) FROM \"OutboxConsumerCatalog\";" \
  "socket.invalidation=unordered/external/v1,webpush.notify=unordered/external/v1"
assert "DomainEvent.dispatchIntent + OutboxDelivery.deliveryAction columns were added" \
  "SELECT ((SELECT COUNT(*) FROM information_schema.columns WHERE table_name='DomainEvent' AND column_name='dispatchIntent')=1 AND (SELECT COUNT(*) FROM information_schema.columns WHERE table_name='OutboxDelivery' AND column_name='deliveryAction')=1)::text;" \
  "true"
assert "the event-only delivery FK was replaced by the composite (eventId, projectId, streamPosition) FK" \
  "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conname='OutboxDelivery_eventId_fkey')::text || '|' || (SELECT COUNT(*) FROM pg_constraint WHERE conname='OutboxDelivery_eventId_projectId_streamPosition_fkey' AND contype='f')::text;" \
  "0|1"
assert "the DomainEvent composite candidate key backing that FK exists" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname='DomainEvent_eventId_projectId_streamPosition_key';" \
  "1"
assert "the (consumer, consumerKind) delivery-to-catalog FK is database-enforced" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname='OutboxDelivery_consumer_consumerKind_fkey' AND contype='f';" \
  "1"
assert "the deliveryAction / catalog kind-effect-pair / cutover-singleton CHECKs exist" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('OutboxDelivery_deliveryAction_check','OutboxConsumerCatalog_kind_effect_check','OutboxCutoverState_singleton_check');" \
  "3"
assert "PR B wrote NO deliveries over an event-free legacy DB (row-free capability add)" \
  "SELECT COUNT(*) FROM \"OutboxDelivery\";" \
  "0"

# Phase 2 fix-forward PR C Task 3 — the external-effect cutover seal is a pure invariant addition
# over the event-free legacy DB: a BEFORE INSERT trigger that requires a dispatchIntent ONCE the
# singleton cutover row exists. Installing the trigger touches no row and does not seal anything —
# the DB stays UNSEALED until an operator runs `outbox:seal-external` in legacy/shadow mode.
assert "the seal BEFORE INSERT trigger on DomainEvent was installed" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname='DomainEvent_seal_requires_intent' AND NOT tgisinternal;" \
  "1"
assert "the DB is UNSEALED over the legacy fixture (no cutover row until an operator seals)" \
  "SELECT COUNT(*) FROM \"OutboxCutoverState\";" \
  "0"

# Phase 3 Task 1 correction round 2 — the immutable approval register over the PR-189 fixture.
assert "DL-3's single provable approval backfilled at version 1 with the REAL option key and approver" \
  "SELECT version || '|' || \"optionKey\" || '|' || \"approvedById\" FROM \"DecisionApprovalRevision\" WHERE \"decisionId\"='DL-3';" \
  "1|a|USER-1"
assert "DL-4 backfilled its FULL provable history — v1/a (the reference a live requirement pins) AND v2/b" \
  "SELECT string_agg('v' || version || '/' || \"optionKey\", ',' ORDER BY version) FROM \"DecisionApprovalRevision\" WHERE \"decisionId\"='DL-4';" \
  "v1/a,v2/b"
assert "the requirement created while DL-4 v1/a governed survives the upgrade VERBATIM (the #191-review reproduction)" \
  "SELECT \"decisionId\" || '|' || \"decisionVersion\" || '|' || \"optionKey\" || '|' || \"specFingerprint\" FROM \"MaterialRequirementSpec\" WHERE id='S-2';" \
  "DL-4|1|a|fp-legacy-2"
assert "the applied-defective simulation (DL-6: register held only v2) was COMPLETED by the history migration" \
  "SELECT string_agg('v' || version || '/' || \"optionKey\", ',' ORDER BY version) FROM \"DecisionApprovalRevision\" WHERE \"decisionId\"='DL-6';" \
  "v1/a,v2/b"
assert "the pre-existing DL-6 v2 register row was never touched (immutable fact, id preserved)" \
  "SELECT id || '|' || \"approvedAt\"::date::text FROM \"DecisionApprovalRevision\" WHERE \"decisionId\"='DL-6' AND version=2;" \
  "dar-DL-6-v2|2026-06-13"
assert "DL-2 (approved, NO provable option) was SKIPPED, not fabricated and not nulled — runtime refuses it until operator repair" \
  "SELECT COUNT(*) FROM \"DecisionApprovalRevision\" WHERE \"decisionId\"='DL-2';" \
  "0"
assert "S-1's PR-189 provenance survived VERBATIM (never silently nulled) and now FKs the register" \
  "SELECT \"decisionId\" || '|' || \"decisionVersion\" || '|' || \"optionKey\" FROM \"MaterialRequirementSpec\" WHERE id='S-1';" \
  "DL-3|1|a"
assert "the repaired S-FORGED is a manual spec (all-null provenance) with its technical identity intact" \
  "SELECT COALESCE(\"decisionId\",'<null>') || '|' || COALESCE(\"decisionVersion\"::text,'<null>') || '|' || COALESCE(\"optionKey\",'<null>') || '|' || \"specFingerprint\" FROM \"MaterialRequirementSpec\" WHERE id='S-FORGED';" \
  "<null>|<null>|<null>|fp-forged"
assert "the composite provenance FK onto the register is database-enforced" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname='MaterialRequirementSpec_provenance_fkey' AND contype='f';" \
  "1"
assert "the duplicated spec unit column is GONE (single-source UOM on the revision row)" \
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='MaterialRequirementSpec' AND column_name='baseUom';" \
  "0"
assert "AR-1 kept its unit, its DATE needed-by and its attributed identities untouched" \
  "SELECT \"baseUom\" || '|' || \"requiredBy\"::text || '|' || \"createdById\" FROM \"ActivityRequirement\" WHERE id='AR-1';" \
  "bag|2026-08-15|USER-1"
assert "the register and the requirement root are database-immutable (append-only triggers installed)" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('DecisionApprovalRevision_append_only','ActivityRequirementRoot_append_only') AND NOT tgisinternal;" \
  "2"
assert "the commit-time material/spec pairing constraint triggers are installed on both tables" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('ActivityRequirement_spec_pairing','MaterialRequirementSpec_spec_pairing') AND NOT tgisinternal;" \
  "2"
assert "(decisionId, optionKey) is a database-enforced candidate key on DecisionOption" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname='DecisionOption_decisionId_optionKey_key';" \
  "1"

# Phase 3 Task 2 — procurement is a purely additive, row-free capability over the legacy DB.
assert "the eight procurement tables exist" \
  "SELECT ((to_regclass('\"Vendor\"') IS NOT NULL) AND (to_regclass('\"ProjectVendor\"') IS NOT NULL) AND (to_regclass('\"Requisition\"') IS NOT NULL) AND (to_regclass('\"RequisitionLine\"') IS NOT NULL) AND (to_regclass('\"Rfq\"') IS NOT NULL) AND (to_regclass('\"VendorQuote\"') IS NOT NULL) AND (to_regclass('\"VendorQuoteLine\"') IS NOT NULL) AND (to_regclass('\"QuoteComparison\"') IS NOT NULL))::text;" \
  "true"
assert "the procurement migration wrote NO rows over the legacy DB (pure capability add)" \
  "SELECT (SELECT COUNT(*) FROM \"Vendor\") + (SELECT COUNT(*) FROM \"ProjectVendor\") + (SELECT COUNT(*) FROM \"Requisition\");" \
  "0"
assert "requisition lines FK the ActivityRequirement revision row (the §F bound-1 anchor)" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname='RequisitionLine_projectId_requirementId_revision_fkey' AND contype='f';" \
  "1"
assert "the §H dual composite FKs make a cross-org vendor binding unrepresentable" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('ProjectVendor_orgId_projectId_fkey','ProjectVendor_orgId_vendorId_fkey') AND contype='f';" \
  "2"
assert "quotes reach the vendor ONLY through the project binding (composite §H FK)" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname='VendorQuote_projectId_vendorId_fkey' AND contype='f';" \
  "1"
assert "the comparison approval completeness CHECK is database-enforced" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname='QuoteComparison_approval_check';" \
  "1"

# Phase 3 Task 3 — versioned POs + delivery commitments: purely additive, row-free.
assert "the five purchase-order/delivery tables exist" \
  "SELECT ((to_regclass('\"PurchaseOrder\"') IS NOT NULL) AND (to_regclass('\"PurchaseOrderVersion\"') IS NOT NULL) AND (to_regclass('\"PurchaseOrderLine\"') IS NOT NULL) AND (to_regclass('\"DeliveryCommitment\"') IS NOT NULL) AND (to_regclass('\"DeliveryPromise\"') IS NOT NULL))::text;" \
  "true"
assert "the purchase-order migration wrote NO rows over the legacy DB (pure capability add)" \
  "SELECT (SELECT COUNT(*) FROM \"PurchaseOrder\") + (SELECT COUNT(*) FROM \"PurchaseOrderVersion\") + (SELECT COUNT(*) FROM \"DeliveryCommitment\");" \
  "0"
assert "'ordered' joined the requisition-line status vocabulary (widened CHECK)" \
  "SELECT pg_get_constraintdef(oid) LIKE '%ordered%' FROM pg_constraint WHERE conname='RequisitionLine_status_check';" \
  "t"
assert "the frozen-snapshot, lifecycle-only and append-only PO/delivery triggers are installed" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('PurchaseOrder_append_only','PurchaseOrderVersion_lifecycle_only','PurchaseOrderLine_frozen','DeliveryCommitment_lifecycle_only','DeliveryPromise_append_only') AND NOT tgisinternal;" \
  "5"
assert "the §F overage-reason and cancel/close-short reason CHECKs are database-enforced" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('PurchaseOrderLine_overage_reason_check','PurchaseOrderVersion_cancel_reason_check','PurchaseOrderVersion_close_short_reason_check','DeliveryPromise_revision_reason_check');" \
  "4"

# Phase 3 Tasks 2-3 CORRECTION — the review findings' database invariants land row-free.
assert "at most ONE recorded quote per (project, rfq, vendor) — the F5 partial unique exists" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname='VendorQuote_one_recorded_per_rfq_vendor';" \
  "1"
assert "exactly ONE delivery commitment per PO line — the F6 unique exists" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname='DeliveryCommitment_projectId_poLineId_key';" \
  "1"
assert "quotes/quote-lines/comparisons are sealed — the F4 evidence triggers are installed" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('VendorQuote_lifecycle_only','VendorQuoteLine_append_only','QuoteComparison_lifecycle_only') AND NOT tgisinternal;" \
  "3"
assert "the F4 provenance chain FKs exist (rfq-sealed selection, comparison->rfq requisition, PO->comparison, PO-line pin)" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('QuoteComparison_selection_fkey','QuoteComparison_projectId_rfqId_requisitionId_fkey','PurchaseOrder_comparison_provenance_fkey','PurchaseOrderLine_requirement_pin_fkey') AND contype='f';" \
  "4"
assert "the F2 purchase triple is present with the base-quantity derivation CHECK" \
  "SELECT ((SELECT COUNT(*) FROM information_schema.columns WHERE table_name='PurchaseOrderLine' AND column_name IN ('purchaseUom','purchaseQty','conversionToBase'))::text || '|' || (SELECT COUNT(*) FROM pg_constraint WHERE conname='PurchaseOrderLine_base_qty_derivation_check')::text);" \
  "3|1"
assert "the F1 match-only identity: PO-line specFingerprint is NOT NULL" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_name='PurchaseOrderLine' AND column_name='specFingerprint';" \
  "NO"

# F4 round 2 — status-bearing PO provenance + requisition containment, row-free.
assert "the PO provenance FK carries the comparison STATUS (draft references unrepresentable)" \
  "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conname='PurchaseOrder_comparison_status_check')::text || '|' || (SELECT pg_get_constraintdef(oid) LIKE '%comparisonStatus%' FROM pg_constraint WHERE conname='PurchaseOrder_comparison_provenance_fkey')::text;" \
  "1|true"
assert "the four containment FKs seal quote lines AND PO lines to their parent requisition" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('VendorQuoteLine_quote_containment_fkey','VendorQuoteLine_line_containment_fkey','PurchaseOrderLine_version_containment_fkey','PurchaseOrderLine_line_containment_fkey') AND contype='f';" \
  "4"
assert "the denormalized requisitionId columns are NOT NULL on all four evidence tables" \
  "SELECT COUNT(*) FROM information_schema.columns WHERE column_name='requisitionId' AND is_nullable='NO' AND table_name IN ('VendorQuote','VendorQuoteLine','PurchaseOrderVersion','PurchaseOrderLine');" \
  "4"

# Phase 3 Task 4 — the inventory tables land row-free with their §C seals installed.
assert "the two inventory tables exist and the migration wrote NO rows over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('StockLot','StockTransaction'))::text || '|' || (SELECT COUNT(*) FROM \"StockLot\")::text || '|' || (SELECT COUNT(*) FROM \"StockTransaction\")::text;" \
  "2|0|0"
assert "both inventory tables are append-only and the reversal-inverse trigger is installed (§C rule iii)" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('StockLot_append_only','StockTransaction_append_only','StockTransaction_reversal_inverse') AND NOT tgisinternal;" \
  "3"
assert "the §C conservation CHECKs pin qty > 0, the type vocabulary, the bucket domain and the per-type movement shape" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('StockTransaction_qty_positive_check','StockTransaction_type_check','StockTransaction_bucket_domain_check','StockTransaction_type_shape_check');" \
  "4"
assert "the ledger's provenance FKs seal receipt (PO line + commitment), evidence media, the reversal chain and the source command" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('StockTransaction_projectId_poLineId_fkey','StockTransaction_projectId_commitmentId_fkey','StockTransaction_projectId_evidenceMediaId_fkey','StockTransaction_projectId_reversedTxId_fkey','StockTransaction_projectId_sourceCommandId_fkey') AND contype='f';" \
  "5"
assert "each ledger row is reversible AT MOST once (the partial unique exists)" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname='StockTransaction_reversedTx_once_key';" \
  "1"
assert "the lot's §B ref is FK-sealed to its pinned requirement revision and its (Tasks 4–5 correction) chain-coherent PO-line/commitment provenance" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('StockLot_projectId_requirementId_revision_fkey','StockLot_projectId_poLineId_requirementId_revision_fkey','StockLot_projectId_commitmentId_poLineId_fkey') AND contype='f';" \
  "3"

# Phase 3 Task 5 — the store-to-site tables land row-free with their §§C/E seals installed.
assert "the two Task-5 tables exist and the migration wrote NO rows over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('MaterialIssue','MismatchResolution'))::text || '|' || (SELECT COUNT(*) FROM \"MaterialIssue\")::text || '|' || (SELECT COUNT(*) FROM \"MismatchResolution\")::text;" \
  "2|0|0"
assert "the ledger gained the three Task-5 columns (activityId, issueId, toStoreLocation), all nullable — additive over legacy rows" \
  "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='StockTransaction' AND column_name IN ('activityId','issueId','toStoreLocation') AND is_nullable='YES';" \
  "3"
assert "the widened type CHECK admits the seven Task-5 movements" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname='StockTransaction_type_check' AND pg_get_constraintdef(oid) LIKE '%issue%' AND pg_get_constraintdef(oid) LIKE '%transfer%' AND pg_get_constraintdef(oid) LIKE '%wastage%';" \
  "1"
assert "the bucket domain CHECK admits the two Task-5 buckets (reserved, issuedToActivity)" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname='StockTransaction_bucket_domain_check' AND pg_get_constraintdef(oid) LIKE '%reserved%' AND pg_get_constraintdef(oid) LIKE '%issuedToActivity%';" \
  "1"
assert "both §E records are append-only (MaterialIssue + MismatchResolution triggers installed)" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('MaterialIssue_append_only','MismatchResolution_append_only') AND NOT tgisinternal;" \
  "2"
assert "the v2 reversal-inverse function verifies the transfer location swap and the copied activity/issue scope" \
  "SELECT COUNT(*) FROM pg_proc WHERE proname='phase3_stock_reversal_inverse' AND prosrc LIKE '%toStoreLocation%' AND prosrc LIKE '%activityId%' AND prosrc LIKE '%issueId%';" \
  "1"
assert "one resolution per observation (the SiteMaterial unique target + the resolution's unique both exist)" \
  "SELECT COUNT(*) FROM pg_indexes WHERE indexname IN ('SiteMaterial_projectId_id_key','MismatchResolution_projectId_siteMaterialId_key');" \
  "2"
assert "the Task-5 provenance FKs seal the issue chain (ledger→activity, ledger→issue, issue→lot/activity, resolution→observation)" \
  "SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('StockTransaction_projectId_activityId_fkey','StockTransaction_projectId_issueId_fkey','MaterialIssue_projectId_lotId_fkey','MaterialIssue_projectId_activityId_fkey','MismatchResolution_projectId_siteMaterialId_fkey') AND contype='f';" \
  "5"

# ── Phase 3 Tasks 4–5 integrity correction — EXECUTED hostile inserts over the migrated legacy
#    database (not merely constraint-name inspection). First a minimal COHERENT §C chain is
#    planted (its acceptance proves the correction lets valid legacy-shaped data through); then
#    each hostile insert must be REJECTED by the seal it targets. ──────────────────────────────
assert_rejects() {
  local label="$1" sql="$2"
  if $PSQL -q -c "$sql" >/dev/null 2>&1; then
    printf 'FAILED  %s\n        (hostile insert was ACCEPTED — a correction seal is missing)\n' "$label"; FAIL=1
  else
    printf 'ok      %s (rejected by PostgreSQL)\n' "$label"
  fi
}

# a coherent chain on legacy project p1 (org-legacy / USER-1 / ACT-1): requirement → spec →
# requisition → RFQ → quote → approved comparison → PO → PO line → commitment → lot → receipt,
# plus a valid MaterialIssue + its canonical issue movement (one transaction so the deferred
# issue-movement trigger is satisfied), a matched=false observation + its resolution, and a
# matched=true observation. Any error here fails the proof (ON_ERROR_STOP).
$PSQL >/dev/null <<'SQL' || { echo "FAILED  integrity-correction fixture chain did not apply"; FAIL=1; }
BEGIN;
INSERT INTO "ActivityRequirementRoot"("id","projectId","createdById") VALUES('UP45-ROOT','p1','USER-1');
INSERT INTO "ActivityRequirement"("id","projectId","requirementId","revision","activityId","type","requiredQty","baseUom","requiredBy","criticality","status","createdById")
  VALUES('UP45-AR','p1','UP45-ROOT',1,'ACT-1','material',100,'bag','2026-08-15','normal','open','USER-1');
INSERT INTO "MaterialRequirementSpec"("id","projectId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","specFingerprint")
  VALUES('UP45-MS','p1','UP45-ROOT',1,'Cement','UltraTech','OPC 53','grey','FP-UP45');
INSERT INTO "Requisition"("id","projectId","title","status","createdById") VALUES('UP45-REQ','p1','up45','approved','USER-1');
INSERT INTO "RequisitionLine"("id","projectId","requisitionId","requirementId","revision","qty","status")
  VALUES('UP45-RL','p1','UP45-REQ','UP45-ROOT',1,100,'ordered');
INSERT INTO "Vendor"("id","orgId","name","createdById") VALUES('UP45-VEN','org-legacy','V','USER-1');
INSERT INTO "ProjectVendor"("id","projectId","orgId","vendorId","boundById") VALUES('UP45-PV','p1','org-legacy','UP45-VEN','USER-1');
INSERT INTO "Rfq"("id","projectId","requisitionId","status","issuedById") VALUES('UP45-RFQ','p1','UP45-REQ','closed','USER-1');
INSERT INTO "VendorQuote"("id","projectId","rfqId","requisitionId","vendorId","status","validUntil","recordedById")
  VALUES('UP45-VQ','p1','UP45-RFQ','UP45-REQ','UP45-VEN','recorded','2027-01-01','USER-1');
INSERT INTO "VendorQuoteLine"("id","projectId","quoteId","requisitionLineId","requisitionId","baseRate","taxAmount","freightAmount","landedCost","quotedMake","matchesSpecification")
  VALUES('UP45-VQL','p1','UP45-VQ','UP45-RL','UP45-REQ',100,50,25,999.99,'UltraTech OPC',true);
INSERT INTO "QuoteComparison"("id","projectId","rfqId","requisitionId","status","selectedQuoteId","selectedVendorId","reason","createdById","approvedById","approvedAt")
  VALUES('UP45-CMP','p1','UP45-RFQ','UP45-REQ','approved','UP45-VQ','UP45-VEN','ok','USER-1','USER-1',now());
INSERT INTO "PurchaseOrder"("id","projectId","vendorId","requisitionId","comparisonId","comparisonStatus","createdById")
  VALUES('UP45-PO','p1','UP45-VEN','UP45-REQ','UP45-CMP','approved','USER-1');
INSERT INTO "PurchaseOrderVersion"("id","projectId","poId","version","requisitionId","status","issuedById","issuedAt","createdById")
  VALUES('UP45-POV','p1','UP45-PO',1,'UP45-REQ','issued','USER-1',now(),'USER-1');
INSERT INTO "PurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","specFingerprint","uom","purchaseUom","purchaseQty","conversionToBase","qty","rate","taxAmount","freightAmount","landedAmount","committedAmountBase")
  VALUES('UP45-POL','p1','UP45-POV','UP45-RL','UP45-REQ','UP45-ROOT',1,'FP-UP45','bag','bag',100,1,100,100,50,25,999.99,100);
INSERT INTO "DeliveryCommitment"("id","projectId","poLineId","status","createdById") VALUES('UP45-DC','p1','UP45-POL','committed','USER-1');
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  VALUES('UP45-CMD','project','org-legacy','p1','USER-1','test.up45','up45','x','succeeded');
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  VALUES('UP45-CMD2','project','org-legacy','p2','USER-1','test.up45','up45b','x','succeeded');
INSERT INTO "StockLot"("id","projectId","poLineId","commitmentId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","baseUom","specFingerprint","receivedById")
  VALUES('UP45-LOT','p1','UP45-POL','UP45-DC','UP45-ROOT',1,'Cement','UltraTech','OPC 53','grey','bag','FP-UP45','USER-1');
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","poLineId","commitmentId","recordedById","sourceCommandId")
  VALUES('UP45-RCPT','p1','UP45-LOT','main','receipt',100,NULL,'quarantine','UP45-POL','UP45-DC','USER-1','UP45-CMD');
INSERT INTO "MaterialIssue"("id","projectId","lotId","storeLocation","activityId","qty","issuedById")
  VALUES('UP45-MI','p1','UP45-LOT','main','ACT-1',20,'USER-1');
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","activityId","issueId","recordedById","sourceCommandId")
  VALUES('UP45-ISS','p1','UP45-LOT','main','issue',20,'acceptedOnHand','issuedToActivity','ACT-1','UP45-MI','USER-1','UP45-CMD');
INSERT INTO "DailyLog"("id","projectId","date","submitted","checkedIn","progress") VALUES('UP45-DL','p1','01 Jun 2026',false,true,10);
INSERT INTO "SiteMaterial"("id","projectId","dailyLogId","name","qty","zone","matched","swatch","order")
  VALUES('UP45-SM-F','p1','UP45-DL','Tile','5','Bath',false,'tile',0),
        ('UP45-SM-T','p1','UP45-DL','Tile OK','5','Bath',true,'tile',1);
INSERT INTO "MismatchResolution"("id","projectId","siteMaterialId","resolution","reason","resolvedById")
  VALUES('UP45-MR','p1','UP45-SM-F','returned','wrong batch','USER-1');
COMMIT;
SQL

# happy path: the correction ACCEPTS coherent legacy-shaped data (lot, receipt, issue, resolution)
assert "integrity correction accepts a coherent lot + receipt + issue + resolution over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM \"StockLot\" WHERE id='UP45-LOT') || '|' || (SELECT COUNT(*) FROM \"StockTransaction\" WHERE id IN ('UP45-RCPT','UP45-ISS')) || '|' || (SELECT COUNT(*) FROM \"MaterialIssue\" WHERE id='UP45-MI') || '|' || (SELECT COUNT(*) FROM \"MismatchResolution\" WHERE id='UP45-MR');" \
  "1|2|1|1"

# F1 — a ledger row with no source command, and one citing a command in ANOTHER project
assert_rejects "F1: a §C ledger row with a NULL sourceCommandId" \
  "INSERT INTO \"StockTransaction\"(\"id\",\"projectId\",\"lotId\",\"storeLocation\",\"type\",\"qty\",\"fromBucket\",\"toBucket\",\"reason\",\"recordedById\") VALUES('UP45-H1','p1','UP45-LOT','main','adjustment',1,'acceptedOnHand',NULL,'x','USER-1')"
assert_rejects "F1: a §C ledger row citing a source command in another project" \
  "INSERT INTO \"StockTransaction\"(\"id\",\"projectId\",\"lotId\",\"storeLocation\",\"type\",\"qty\",\"fromBucket\",\"toBucket\",\"reason\",\"recordedById\",\"sourceCommandId\") VALUES('UP45-H2','p1','UP45-LOT','main','adjustment',1,'acceptedOnHand',NULL,'x','USER-1','UP45-CMD2')"
# F2.2 — a lot whose frozen §B spec copy is forged
assert_rejects "F2.2: a stock lot with a forged §B spec fingerprint" \
  "INSERT INTO \"StockLot\"(\"id\",\"projectId\",\"poLineId\",\"commitmentId\",\"requirementId\",\"revision\",\"materialCategory\",\"make\",\"grade\",\"normalizedAttributes\",\"baseUom\",\"specFingerprint\",\"receivedById\") VALUES('UP45-H3','p1','UP45-POL','UP45-DC','UP45-ROOT',1,'Cement','UltraTech','OPC 53','grey','bag','FORGED','USER-1')"
# F3.2 — an orphan MaterialIssue (no canonical issue movement) rejected at commit
assert_rejects "F3.2: an orphan MaterialIssue is rejected at commit" \
  "BEGIN; INSERT INTO \"MaterialIssue\"(\"id\",\"projectId\",\"lotId\",\"storeLocation\",\"activityId\",\"qty\",\"issuedById\") VALUES('UP45-H4','p1','UP45-LOT','main','ACT-1',5,'USER-1'); COMMIT;"
# F3.1 — a SECOND canonical issue movement for a MaterialIssue that already has one (partial unique)
assert_rejects "F3.1: a second canonical issue movement for the same MaterialIssue" \
  "INSERT INTO \"StockTransaction\"(\"id\",\"projectId\",\"lotId\",\"storeLocation\",\"type\",\"qty\",\"fromBucket\",\"toBucket\",\"activityId\",\"issueId\",\"recordedById\",\"sourceCommandId\") VALUES('UP45-H7','p1','UP45-LOT','main','issue',20,'acceptedOnHand','issuedToActivity','ACT-1','UP45-MI','USER-1','UP45-CMD')"
# F3.3 — an issue-scoped movement at a different store location than its MaterialIssue
assert_rejects "F3.3: an issue-scoped movement mis-scoped against its MaterialIssue" \
  "INSERT INTO \"StockTransaction\"(\"id\",\"projectId\",\"lotId\",\"storeLocation\",\"type\",\"qty\",\"fromBucket\",\"toBucket\",\"activityId\",\"issueId\",\"recordedById\",\"sourceCommandId\") VALUES('UP45-H5','p1','UP45-LOT','elsewhere','consumption',1,'issuedToActivity',NULL,'ACT-1','UP45-MI','USER-1','UP45-CMD')"
# F4 — a resolution on a matched=true observation, and a resolved observation reverting to matched=true
assert_rejects "F4: a resolution on a matched=true observation" \
  "INSERT INTO \"MismatchResolution\"(\"id\",\"projectId\",\"siteMaterialId\",\"resolution\",\"reason\",\"resolvedById\") VALUES('UP45-H6','p1','UP45-SM-T','x','y','USER-1')"
assert_rejects "F4: a resolved observation cannot revert to matched=true" \
  "UPDATE \"SiteMaterial\" SET \"matched\"=true WHERE id='UP45-SM-F'"

# =====================================================================================
# Phase 4 Task 1 — the labour foundation is a PURELY ADDITIVE, row-free capability add over the
# legacy DB, and every §B/§H seal (type↔detail, immutable-type, append-only, same-project
# composite FKs, applicable uniqueness) holds against hostile inserts.
# =====================================================================================
assert "the eight labour tables exist (incl. the normalized WorkerSkill) and the migration wrote NO rows over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('LabourTrade','LabourSkill','Worker','WorkerSkill','Crew','CrewMembership','LabourRequirementSpec','LabourDemandSlice'))::text || '|' || (SELECT COUNT(*) FROM \"Worker\")::text || '|' || (SELECT COUNT(*) FROM \"WorkerSkill\")::text || '|' || (SELECT COUNT(*) FROM \"LabourRequirementSpec\")::text || '|' || (SELECT COUNT(*) FROM \"CrewMembership\")::text;" \
  "8|0|0|0|0"
assert "the WorkerDevice->Worker binding column exists (nullable — anonymous onboarding still works)" \
  "SELECT is_nullable FROM information_schema.columns WHERE table_name='WorkerDevice' AND column_name='workerId';" \
  "YES"
assert "the labour type<->detail, slice-typed, append-only and immutable-type triggers are installed" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('LabourRequirementSpec_spec_pairing','LabourDemandSlice_typed','LabourRequirementSpec_append_only','LabourDemandSlice_append_only','ActivityRequirement_type_immutable') AND NOT tgisinternal;" \
  "5"

# plant a coherent labour fixture: a trade in each project, a worker in p1 and p2, a crew in p1
# with one active member. The correction ACCEPTS well-formed, project-contained rows.
$PSQL >/dev/null <<'SQL' || { echo "FAILED  labour fixture chain did not apply"; FAIL=1; }
BEGIN;
INSERT INTO "LabourTrade"("projectId","code","name","createdById") VALUES ('p1','mason','Mason','USER-1'),('p2','mason','Mason','USER-1');
INSERT INTO "LabourSkill"("projectId","code","name","createdById") VALUES ('p1','bar-bending','Bar Bending','USER-1');
INSERT INTO "Worker"("id","projectId","name","tradeCode","activeFrom","createdById")
  VALUES ('UPL-W1','p1','Ravi','mason','2026-06-01','USER-1'),
         ('UPL-W2','p2','Sita','mason','2026-06-01','USER-1');
INSERT INTO "WorkerSkill"("projectId","workerId","skillCode") VALUES ('p1','UPL-W1','bar-bending');
INSERT INTO "Crew"("id","projectId","name","activeFrom","createdById") VALUES ('UPL-C1','p1','Gang A','2026-06-01','USER-1');
INSERT INTO "CrewMembership"("id","projectId","crewId","workerId","addedById") VALUES ('UPL-CM1','p1','UPL-C1','UPL-W1','USER-1');
INSERT INTO "WorkerDevice"("id","projectId","workerId","token") VALUES ('UPL-WD1','p1','UPL-W1','uptok-ok');
COMMIT;
SQL
assert "the labour foundation accepts a coherent trade/worker/crew/membership/device over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM \"Worker\") || '|' || (SELECT COUNT(*) FROM \"CrewMembership\") || '|' || (SELECT COUNT(*) FROM \"WorkerDevice\" WHERE \"workerId\" IS NOT NULL);" \
  "2|1|1"

# §H — a crew cannot enroll a worker that lives in another project (same-project composite FK)
assert_rejects "labour §H: a crew cannot enroll a worker from another project (composite FK)" \
  "INSERT INTO \"CrewMembership\"(\"id\",\"projectId\",\"crewId\",\"workerId\",\"addedById\") VALUES('UPL-H1','p1','UPL-C1','UPL-W2','USER-1')"
# §H — a device cannot bind a worker that lives in another project (same-project composite FK)
assert_rejects "labour §H: a device cannot bind a worker from another project (composite FK)" \
  "INSERT INTO \"WorkerDevice\"(\"id\",\"projectId\",\"workerId\",\"token\") VALUES('UPL-H2','p1','UPL-W2','uptok-forge')"
# §H — one ACTIVE membership per (crew, worker) (partial unique)
assert_rejects "labour §H: a second active membership for the same (crew,worker) (partial unique)" \
  "INSERT INTO \"CrewMembership\"(\"id\",\"projectId\",\"crewId\",\"workerId\",\"addedById\") VALUES('UPL-H3','p1','UPL-C1','UPL-W1','USER-1')"
# §H — a worker allocated only within its active window (activeTo not before activeFrom)
assert_rejects "labour §H: a worker with activeTo before activeFrom (CHECK)" \
  "INSERT INTO \"Worker\"(\"id\",\"projectId\",\"name\",\"tradeCode\",\"activeFrom\",\"activeTo\",\"createdById\") VALUES('UPL-H4','p1','Bad','mason','2026-06-10','2026-06-01','USER-1')"
# §B — a type='labour' requirement with NO labour detail is refused at commit (type<->detail)
assert_rejects "labour §B: a type='labour' requirement with no LabourRequirementSpec (type<->detail)" \
  "BEGIN; INSERT INTO \"ActivityRequirementRoot\"(\"id\",\"projectId\",\"createdById\") VALUES('UPL-LR','p1','USER-1'); INSERT INTO \"ActivityRequirement\"(\"id\",\"projectId\",\"requirementId\",\"revision\",\"activityId\",\"type\",\"requiredQty\",\"baseUom\",\"requiredBy\",\"createdById\") VALUES('UPL-LAR','p1','UPL-LR',1,'ACT-1','labour',1,'person-shift','2026-08-10','USER-1'); COMMIT;"
# §B — a LabourDemandSlice cannot attach to a MATERIAL requirement (the slice-typed guard)
assert_rejects "labour §B: a demand slice on a material requirement (slice-typed guard)" \
  "INSERT INTO \"LabourDemandSlice\"(\"id\",\"projectId\",\"requirementId\",\"revision\",\"civilDate\",\"personShiftQty\") VALUES('UPL-H5','p1','REQ-1',1,'2026-08-10',1)"

# ── Phase 4 Task 1 CORRECTION 3 — worker skills NORMALIZED into WorkerSkill (concurrency-safe FK) ──
assert "correction 3 dropped the racing worker-skill triggers; the labour demand seal remains" \
  "SELECT (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('Worker_skills_contained','LabourSkill_referenced_guard') AND NOT tgisinternal)::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname='LabourRequirementSpec_demand_sealed' AND NOT tgisinternal)::text;" \
  "0|1"
assert "the Worker.skillCodes column is GONE (normalized into WorkerSkill)" \
  "SELECT COUNT(*)::text FROM information_schema.columns WHERE table_name='Worker' AND column_name='skillCodes';" \
  "0"
assert "the WorkerSkill composite FKs (to Worker + LabourSkill) exist" \
  "SELECT COUNT(*)::text FROM pg_constraint WHERE conname IN ('WorkerSkill_projectId_workerId_fkey','WorkerSkill_projectId_skillCode_fkey');" \
  "2"
# C3 — a WorkerSkill element referencing a skill absent from the same-project catalog is rejected (FK)
assert_rejects "labour C3: a WorkerSkill element not in the project catalog (composite FK)" \
  "INSERT INTO \"WorkerSkill\"(\"projectId\",\"workerId\",\"skillCode\") VALUES('p1','UPL-W1','ghost-skill')"
# C3 — a WorkerSkill binding a cross-project worker is rejected (same-project composite FK)
assert_rejects "labour C3: a WorkerSkill binding a cross-project worker (composite FK)" \
  "INSERT INTO \"WorkerSkill\"(\"projectId\",\"workerId\",\"skillCode\") VALUES('p1','UPL-W2','bar-bending')"
# F3 — a LabourRequirementSpec skillCode absent from the same-project catalog is rejected (composite FK)
assert_rejects "labour F3: a LabourRequirementSpec skillCode not in the catalog (composite FK)" \
  "BEGIN; INSERT INTO \"ActivityRequirementRoot\"(\"id\",\"projectId\",\"createdById\") VALUES('UPL-F3R','p1','USER-1'); INSERT INTO \"ActivityRequirement\"(\"id\",\"projectId\",\"requirementId\",\"revision\",\"activityId\",\"type\",\"requiredQty\",\"baseUom\",\"requiredBy\",\"createdById\") VALUES('UPL-F3AR','p1','UPL-F3R',1,'ACT-1','labour',3,'person-shift','2026-08-12','USER-1'); INSERT INTO \"LabourRequirementSpec\"(\"id\",\"projectId\",\"requirementId\",\"revision\",\"tradeCode\",\"skillCode\",\"shift\",\"labourSpecFingerprint\") VALUES('UPL-F3S','p1','UPL-F3R',1,'mason','ghost-skill','day','x'); COMMIT;"
# F2 — a labour revision with a FORGED fingerprint is rejected at deferred commit (demand seal)
assert_rejects "labour F2: a labour revision with a forged labourSpecFingerprint (demand seal)" \
  "BEGIN; INSERT INTO \"ActivityRequirementRoot\"(\"id\",\"projectId\",\"createdById\") VALUES('UPL-F2R','p1','USER-1'); INSERT INTO \"ActivityRequirement\"(\"id\",\"projectId\",\"requirementId\",\"revision\",\"activityId\",\"type\",\"requiredQty\",\"baseUom\",\"requiredBy\",\"createdById\") VALUES('UPL-F2AR','p1','UPL-F2R',1,'ACT-1','labour',3,'person-shift','2026-08-12','USER-1'); INSERT INTO \"LabourRequirementSpec\"(\"id\",\"projectId\",\"requirementId\",\"revision\",\"tradeCode\",\"skillCode\",\"shift\",\"labourSpecFingerprint\") VALUES('UPL-F2S','p1','UPL-F2R',1,'mason','bar-bending','day','deadbeef'); INSERT INTO \"LabourDemandSlice\"(\"id\",\"projectId\",\"requirementId\",\"revision\",\"civilDate\",\"personShiftQty\") VALUES('UPL-F2D','p1','UPL-F2R',1,'2026-08-12',3); COMMIT;"
# F2 — a labour revision with ZERO slices is rejected at commit (canonical fingerprint computed inline
# via pgcrypto so ONLY the missing slice violates the seal)
assert_rejects "labour F2: a labour revision with no demand slice (demand seal)" \
  "BEGIN; INSERT INTO \"ActivityRequirementRoot\"(\"id\",\"projectId\",\"createdById\") VALUES('UPL-F2R2','p1','USER-1'); INSERT INTO \"ActivityRequirement\"(\"id\",\"projectId\",\"requirementId\",\"revision\",\"activityId\",\"type\",\"requiredQty\",\"baseUom\",\"requiredBy\",\"createdById\") VALUES('UPL-F2AR2','p1','UPL-F2R2',1,'ACT-1','labour',3,'person-shift','2026-08-12','USER-1'); INSERT INTO \"LabourRequirementSpec\"(\"id\",\"projectId\",\"requirementId\",\"revision\",\"tradeCode\",\"skillCode\",\"shift\",\"labourSpecFingerprint\") VALUES('UPL-F2S2','p1','UPL-F2R2',1,'mason','bar-bending','day', encode(digest('lsf.v1'||chr(31)||'trade:mason'||chr(31)||'skill:bar-bending'||chr(31)||'shift:day','sha256'),'hex')); COMMIT;"
# F2 — a COHERENT labour revision (canonical fingerprint + matching demand) is ACCEPTED — seal is precise
$PSQL >/dev/null <<'SQL' && printf 'ok      %s\n' "labour F2: a coherent labour revision (canonical fingerprint + matching demand) is accepted" || { printf 'FAILED  %s\n' "labour F2 coherent revision rejected"; FAIL=1; }
BEGIN;
INSERT INTO "ActivityRequirementRoot"("id","projectId","createdById") VALUES('UPL-F2OK','p1','USER-1');
INSERT INTO "ActivityRequirement"("id","projectId","requirementId","revision","activityId","type","requiredQty","baseUom","requiredBy","createdById") VALUES('UPL-F2OKAR','p1','UPL-F2OK',1,'ACT-1','labour',3,'person-shift','2026-08-12','USER-1');
INSERT INTO "LabourRequirementSpec"("id","projectId","requirementId","revision","tradeCode","skillCode","shift","labourSpecFingerprint") VALUES('UPL-F2OKS','p1','UPL-F2OK',1,'mason','bar-bending','day', encode(digest('lsf.v1'||chr(31)||'trade:mason'||chr(31)||'skill:bar-bending'||chr(31)||'shift:day','sha256'),'hex'));
INSERT INTO "LabourDemandSlice"("id","projectId","requirementId","revision","civilDate","personShiftQty") VALUES('UPL-F2OKD','p1','UPL-F2OK',1,'2026-08-12',3);
COMMIT;
SQL

# ── Phase 4 Task 1 CORRECTION 2 — the demand seal is DURABLE under a LATER slice append (re-review 1) ──
assert "the correction-2 durable slice-insert demand seal is installed" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname='LabourDemandSlice_demand_sealed' AND NOT tgisinternal;" \
  "1"
# a slice appended to the coherent UPL-F2OK revision (rev 1, requiredQty 3) in a LATER statement is
# REJECTED at commit (the sealed aggregate would drift: sum 4 != 3, max date drifts).
assert_rejects "labour C2 finding-1: a slice appended to a sealed revision after the fact (durable demand seal)" \
  "INSERT INTO \"LabourDemandSlice\"(\"id\",\"projectId\",\"requirementId\",\"revision\",\"civilDate\",\"personShiftQty\") VALUES('UPL-C2D','p1','UPL-F2OK',1,'2026-08-13',1)"
assert "the sealed revision's aggregate is UNCHANGED after the rejected append (still one slice)" \
  "SELECT COUNT(*)::text FROM \"LabourDemandSlice\" WHERE \"projectId\"='p1' AND \"requirementId\"='UPL-F2OK' AND \"revision\"=1;" \
  "1"
# ── Phase 4 Task 1 CORRECTION 3 — a LabourSkill referenced by a WorkerSkill row cannot be deleted or
#    re-keyed (the concurrency-safe composite FK replaces the racing reverse-guard trigger). ──────────
$PSQL >/dev/null <<'SQL' || { echo "FAILED  labour C3 fixture did not apply"; FAIL=1; }
INSERT INTO "LabourSkill"("projectId","code","name","createdById") VALUES ('p1','plumbing','Plumbing','USER-1');
INSERT INTO "WorkerSkill"("projectId","workerId","skillCode") VALUES ('p1','UPL-W1','plumbing');
SQL
assert_rejects "labour C3: deleting a WorkerSkill-referenced LabourSkill (composite FK)" \
  "DELETE FROM \"LabourSkill\" WHERE \"projectId\"='p1' AND \"code\"='plumbing'"
assert_rejects "labour C3: re-keying a WorkerSkill-referenced LabourSkill (composite FK)" \
  "UPDATE \"LabourSkill\" SET \"code\"='plumbing-2' WHERE \"projectId\"='p1' AND \"code\"='plumbing'"
# the FK is PRECISE — a NON-referenced skill still deletes cleanly.
$PSQL >/dev/null <<'SQL' && printf 'ok      %s\n' "labour C3: a non-referenced skill still deletes (precise FK)" || { printf 'FAILED  %s\n' "labour C3: a non-referenced skill could not be deleted"; FAIL=1; }
INSERT INTO "LabourSkill"("projectId","code","name","createdById") VALUES ('p1','carpentry','Carpentry','USER-1');
DELETE FROM "LabourSkill" WHERE "projectId"='p1' AND "code"='carpentry';
SQL

# ── Phase 4 Task 1 CORRECTION 2 — the diagnostic-first migration ABORTS on a pre-existing inconsistency,
#    the operator repairs it, and the migration then redeploys cleanly. Proven end-to-end on a SECOND
#    scratch database that applies the full ledger EXCEPT 20270120, plants a coherent labour revision +
#    worker, then breaks BOTH invariants exactly as the runtime gap allowed (a later slice; a deleted
#    referenced skill) before the correction's triggers exist. ─────────────────────────────────────────
echo ""
echo "=== correction-2 abort -> operator repair -> redeploy (fresh scratch DB) ==="
DB2="${DB}_c2repair"
NEWMIG="$MIG_DIR/20270120000000_phase4_t1_correction2"
PSQL2="psql -X -v ON_ERROR_STOP=1 -d $DB2"
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB2;" >/dev/null 2>&1
$PSQL_ADMIN -c "CREATE DATABASE $DB2;" >/dev/null 2>&1
# apply the ledger through 20270115 (the pre-correction-2 schema, which still carries Worker.skillCodes
# + the forward containment trigger). Correction 2 (20270120) is applied SEPARATELY below; correction 3
# (20270125, which normalizes away skillCodes) is skipped so this scenario exercises the array schema.
for d in $(ls -d "$MIG_DIR"/*/ | sort); do
  case "$(basename "$d")" in
    20270120000000_phase4_t1_correction2|20270125000000_phase4_t1_correction3) continue ;;
  esac
  psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB2" -f "$d/migration.sql" >/dev/null 2>&1 \
    || { echo "FAILED  correction-2 repair proof: base migration $(basename "$d") did not apply"; FAIL=1; break; }
done
# a COHERENT labour revision (rev 1, requiredQty 3, one slice) + a worker referencing only 'tiling'.
# The AR + spec + slice land in ONE transaction so the deferred type<->detail + demand seals see the
# whole coherent revision at commit (a bare labour AR would otherwise be rejected for having no detail).
$PSQL2 -q >/dev/null 2>&1 <<'SQL' || { echo "FAILED  correction-2 repair proof: coherent fixture did not apply"; FAIL=1; }
INSERT INTO "Org"("id","name","slug") VALUES ('org-c2','C2 Org','c2-org');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('pc2','org-c2','C2 Site','C2','','Finishing','C2-01','01 Jan 2026','31 Dec 2026',50,30,60);
INSERT INTO "User"("id","projectId","role","name","email","passwordHash") VALUES ('UC2','pc2','pmc','C2 PMC','c2@vitan.in','h');
INSERT INTO "Activity"("id","projectId","name","zone","plannedStart","plannedEnd") VALUES ('AC2','pc2','Slab','Zone',0,5);
INSERT INTO "LabourTrade"("projectId","code","name","createdById") VALUES ('pc2','mason','Mason','UC2');
INSERT INTO "LabourSkill"("projectId","code","name","createdById") VALUES ('pc2','bar-bending','Bar Bending','UC2'),('pc2','tiling','Tiling','UC2');
INSERT INTO "Worker"("id","projectId","name","tradeCode","skillCodes","activeFrom","createdById") VALUES ('WC2','pc2','Tara','mason','{tiling}','2026-06-01','UC2');
BEGIN;
INSERT INTO "ActivityRequirementRoot"("id","projectId","createdById") VALUES ('RC2','pc2','UC2');
INSERT INTO "ActivityRequirement"("id","projectId","requirementId","revision","activityId","type","requiredQty","baseUom","requiredBy","createdById")
  VALUES ('ARC2','pc2','RC2',1,'AC2','labour',3,'person-shift','2026-08-12','UC2');
INSERT INTO "LabourRequirementSpec"("id","projectId","requirementId","revision","tradeCode","skillCode","shift","labourSpecFingerprint")
  VALUES ('SC2','pc2','RC2',1,'mason','bar-bending','day', encode(digest('lsf.v1'||chr(31)||'trade:mason'||chr(31)||'skill:bar-bending'||chr(31)||'shift:day','sha256'),'hex'));
INSERT INTO "LabourDemandSlice"("id","projectId","requirementId","revision","civilDate","personShiftQty") VALUES ('DC2','pc2','RC2',1,'2026-08-12',3);
COMMIT;
SQL
# break BOTH invariants exactly as the runtime gap allowed (no correction-2 triggers yet).
$PSQL2 -q >/dev/null 2>&1 <<'SQL' || { echo "FAILED  correction-2 repair proof: the pre-fix gap did not allow the corrupting mutations"; FAIL=1; }
INSERT INTO "LabourDemandSlice"("id","projectId","requirementId","revision","civilDate","personShiftQty") VALUES ('DC2X','pc2','RC2',1,'2026-08-13',1);
DELETE FROM "LabourSkill" WHERE "projectId"='pc2' AND "code"='tiling';
SQL
# 1) the migration ABORTS on the inconsistent demand aggregate (diagnostic-first).
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB2" -f "$NEWMIG/migration.sql" >/tmp/c2-abort1.log 2>&1; then
  echo "FAILED  correction-2 repair proof: the migration APPLIED over an inconsistent demand aggregate"; FAIL=1
elif grep -q 'inconsistent demand aggregate' /tmp/c2-abort1.log; then
  printf 'ok      %s\n' "correction-2 repair: migration ABORTS on the inconsistent demand aggregate (names the finding)"
else
  echo "FAILED  correction-2 repair proof: aborted but not for the demand finding"; cat /tmp/c2-abort1.log; FAIL=1
fi
# operator repair 1 — remove the appended slice (append-only briefly toggled in the maintenance window).
$PSQL2 -q >/dev/null 2>&1 <<'SQL' || { echo "FAILED  correction-2 repair proof: demand repair failed"; FAIL=1; }
ALTER TABLE "LabourDemandSlice" DISABLE TRIGGER "LabourDemandSlice_append_only";
DELETE FROM "LabourDemandSlice" WHERE "id"='DC2X';
ALTER TABLE "LabourDemandSlice" ENABLE TRIGGER "LabourDemandSlice_append_only";
SQL
# 2) the migration now ABORTS on the orphaned worker skill (the second invariant).
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB2" -f "$NEWMIG/migration.sql" >/tmp/c2-abort2.log 2>&1; then
  echo "FAILED  correction-2 repair proof: the migration APPLIED over an orphaned worker skill"; FAIL=1
elif grep -q 'no longer exists in the project catalog' /tmp/c2-abort2.log; then
  printf 'ok      %s\n' "correction-2 repair: migration ABORTS on the orphaned Worker.skillCodes element (names the finding)"
else
  echo "FAILED  correction-2 repair proof: aborted but not for the worker-skill finding"; cat /tmp/c2-abort2.log; FAIL=1
fi
# operator repair 2 — restore the referenced skill.
$PSQL2 -q >/dev/null 2>&1 -c "INSERT INTO \"LabourSkill\"(\"projectId\",\"code\",\"name\",\"createdById\") VALUES ('pc2','tiling','Tiling','UC2');" \
  || { echo "FAILED  correction-2 repair proof: skill restore failed"; FAIL=1; }
# 3) with the data repaired, the migration REDEPLOYS cleanly and installs the durable triggers.
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB2" -f "$NEWMIG/migration.sql" >/tmp/c2-redeploy.log 2>&1; then
  installed=$($PSQL2 -tAc "SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('LabourDemandSlice_demand_sealed','LabourSkill_referenced_guard') AND NOT tgisinternal;")
  if [ "$installed" = "2" ]; then
    printf 'ok      %s\n' "correction-2 repair: after the operator repair the migration REDEPLOYS cleanly and installs both durable triggers"
  else
    echo "FAILED  correction-2 repair proof: redeployed but the durable triggers are missing ($installed/2)"; FAIL=1
  fi
else
  echo "FAILED  correction-2 repair proof: the migration did not redeploy after the repair"; cat /tmp/c2-redeploy.log; FAIL=1
fi
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB2;" >/dev/null 2>&1

# ── Phase 4 Task 1 CORRECTION 3 — the normalization migration is DIAGNOSTIC-FIRST: it ABORTS on a
#    pre-existing orphaned Worker.skillCodes element (the state the un-serialized race could leave), the
#    operator repairs it, and the migration then redeploys cleanly (WorkerSkill created + backfilled,
#    the racing triggers dropped, skillCodes gone). Proven on a THIRD scratch DB. ─────────────────────
echo ""
echo "=== correction-3 abort -> operator repair -> redeploy (fresh scratch DB) ==="
DB3="${DB}_c3repair"
NEWMIG3="$MIG_DIR/20270125000000_phase4_t1_correction3"
PSQL3="psql -X -v ON_ERROR_STOP=1 -d $DB3"
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB3;" >/dev/null 2>&1
$PSQL_ADMIN -c "CREATE DATABASE $DB3;" >/dev/null 2>&1
# apply the ledger EXCEPT correction 3 (the schema still carries Worker.skillCodes + its two triggers).
for d in $(ls -d "$MIG_DIR"/*/ | sort); do
  [ "$(basename "$d")" = "20270125000000_phase4_t1_correction3" ] && continue
  psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB3" -f "$d/migration.sql" >/dev/null 2>&1 \
    || { echo "FAILED  correction-3 repair proof: base migration $(basename "$d") did not apply"; FAIL=1; break; }
done
# a coherent worker referencing the 'tiling' skill.
$PSQL3 -q >/dev/null 2>&1 <<'SQL' || { echo "FAILED  correction-3 repair proof: coherent fixture did not apply"; FAIL=1; }
INSERT INTO "Org"("id","name","slug") VALUES ('org-c3','C3 Org','c3-org');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('pc3','org-c3','C3 Site','C3','','Finishing','C3-01','01 Jan 2026','31 Dec 2026',50,30,60);
INSERT INTO "User"("id","projectId","role","name","email","passwordHash") VALUES ('UC3','pc3','pmc','C3 PMC','c3@vitan.in','h');
INSERT INTO "LabourTrade"("projectId","code","name","createdById") VALUES ('pc3','mason','Mason','UC3');
INSERT INTO "LabourSkill"("projectId","code","name","createdById") VALUES ('pc3','tiling','Tiling','UC3');
INSERT INTO "Worker"("id","projectId","name","tradeCode","skillCodes","activeFrom","createdById") VALUES ('WC3','pc3','Tara','mason','{tiling}','2026-06-01','UC3');
SQL
# simulate the RACE outcome the two triggers could not prevent: the triggers are briefly disabled
# (exactly what an un-serialized concurrent commit achieved) and the referenced skill deleted, leaving
# Worker.skillCodes pointing at a missing catalog entry — an orphan.
$PSQL3 -q >/dev/null 2>&1 <<'SQL' || { echo "FAILED  correction-3 repair proof: could not simulate the race orphan"; FAIL=1; }
ALTER TABLE "Worker" DISABLE TRIGGER "Worker_skills_contained";
ALTER TABLE "LabourSkill" DISABLE TRIGGER "LabourSkill_referenced_guard";
DELETE FROM "LabourSkill" WHERE "projectId"='pc3' AND "code"='tiling';
ALTER TABLE "Worker" ENABLE TRIGGER "Worker_skills_contained";
ALTER TABLE "LabourSkill" ENABLE TRIGGER "LabourSkill_referenced_guard";
SQL
# 1) the migration ABORTS on the orphaned worker skill (diagnostic-first).
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB3" -f "$NEWMIG3/migration.sql" >/tmp/c3-abort.log 2>&1; then
  echo "FAILED  correction-3 repair proof: the migration APPLIED over an orphaned worker skill"; FAIL=1
elif grep -q 'absent from their project catalog' /tmp/c3-abort.log; then
  printf 'ok      %s\n' "correction-3 repair: migration ABORTS on the orphaned Worker.skillCodes element (names the finding)"
else
  echo "FAILED  correction-3 repair proof: aborted but not for the worker-skill finding"; cat /tmp/c3-abort.log; FAIL=1
fi
# operator repair — restore the missing skill so the backfill will satisfy the new FK.
$PSQL3 -q >/dev/null 2>&1 -c "INSERT INTO \"LabourSkill\"(\"projectId\",\"code\",\"name\",\"createdById\") VALUES ('pc3','tiling','Tiling','UC3');" \
  || { echo "FAILED  correction-3 repair proof: skill restore failed"; FAIL=1; }
# 2) with the data repaired, the migration REDEPLOYS: WorkerSkill created + backfilled, racing triggers
#    gone, skillCodes column dropped.
if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB3" -f "$NEWMIG3/migration.sql" >/tmp/c3-redeploy.log 2>&1; then
  state=$($PSQL3 -tAc "SELECT (SELECT COUNT(*) FROM \"WorkerSkill\" WHERE \"projectId\"='pc3' AND \"workerId\"='WC3' AND \"skillCode\"='tiling') || '|' || (SELECT COUNT(*) FROM information_schema.columns WHERE table_name='Worker' AND column_name='skillCodes') || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('Worker_skills_contained','LabourSkill_referenced_guard') AND NOT tgisinternal);")
  if [ "$state" = "1|0|0" ]; then
    printf 'ok      %s\n' "correction-3 repair: after the repair the migration REDEPLOYS — WorkerSkill backfilled, skillCodes dropped, racing triggers gone"
  else
    echo "FAILED  correction-3 repair proof: redeployed but the end state is wrong ($state, want 1|0|0)"; FAIL=1
  fi
else
  echo "FAILED  correction-3 repair proof: the migration did not redeploy after the repair"; cat /tmp/c3-redeploy.log; FAIL=1
fi
$PSQL_ADMIN -c "DROP DATABASE IF EXISTS $DB3;" >/dev/null 2>&1

# ── Phase 4 Task 2 — the LABOUR COMMERCIAL chain seals (§F). The 12 additive tables upgrade ROW-FREE
#    over the legacy DB, and the DB seals (CAS/frozen-snapshot/append-only/provenance) reject forgeries
#    on the MIGRATED database. The §F BOUNDS are SERVICE-enforced (proven in the integration + barrier
#    race), NOT triggers; here we prove the physical-integrity seals only. Anchored on the coherent
#    labour requirement UPL-F2OK (rev 1, slice 2026-08-12, qty 3, canonical fingerprint) from Task 1. ─
assert "the 12 Phase-4 Task-2 labour commercial tables exist and are ROW-FREE over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('VendorLabourProfile','LabourRequisition','LabourRequisitionLine','LabourRfq','SupplierLabourQuote','SupplierLabourQuoteLine','LabourQuoteComparison','LabourPurchaseOrder','LabourPurchaseOrderVersion','LabourPurchaseOrderLine','CapacityCommitment','CapacityPromise'))::text || '|' || (SELECT COUNT(*) FROM \"LabourRequisition\")::text || '|' || (SELECT COUNT(*) FROM \"LabourPurchaseOrder\")::text || '|' || (SELECT COUNT(*) FROM \"CapacityCommitment\")::text;" \
  "12|0|0|0"
assert "the labour PO status-pinned provenance FK + frozen/append-only triggers are installed" \
  "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conname='LabourPurchaseOrder_comparison_provenance_fkey')::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('LabourPurchaseOrderLine_frozen','LabourPurchaseOrder_append_only','CapacityPromise_append_only','SupplierLabourQuoteLine_append_only') AND NOT tgisinternal)::text;" \
  "1|4"
# a labour requisition with an out-of-machine status is rejected (CAS status CHECK)
assert_rejects "labour T2: a requisition with an out-of-machine status (status CHECK)" \
  "INSERT INTO \"LabourRequisition\"(\"id\",\"projectId\",\"title\",\"status\",\"createdById\") VALUES('UPL-T2BADREQ','p1','bad','bogus','USER-1')"

# build a COHERENT labour commercial chain (requisition→quote→APPROVED comparison→PO→commitment→promise)
FPD="encode(digest('lsf.v1'||chr(31)||'trade:mason'||chr(31)||'skill:bar-bending'||chr(31)||'shift:day','sha256'),'hex')"
$PSQL >/dev/null <<SQL && printf 'ok      %s\n' "labour T2: a coherent labour commercial chain is accepted (seal is precise)" || { printf 'FAILED  %s\n' "labour T2 coherent chain rejected"; FAIL=1; }
BEGIN;
INSERT INTO "Vendor"("id","orgId","name","createdById") VALUES('UPL-T2V','org-legacy','Labour Supplier','USER-1');
INSERT INTO "ProjectVendor"("id","projectId","orgId","vendorId","boundById") VALUES('UPL-T2PV','p1','org-legacy','UPL-T2V','USER-1');
INSERT INTO "LabourRequisition"("id","projectId","title","status","createdById","approvedById","approvedAt") VALUES('UPL-T2REQ','p1','crew','approved','USER-1','USER-1',NOW());
INSERT INTO "LabourRequisitionLine"("id","projectId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","status") VALUES('UPL-T2RL','p1','UPL-T2REQ','UPL-F2OK',1,'2026-08-12','day',$FPD,3,'ordered');
INSERT INTO "LabourRfq"("id","projectId","requisitionId","issuedById") VALUES('UPL-T2RFQ','p1','UPL-T2REQ','USER-1');
INSERT INTO "SupplierLabourQuote"("id","projectId","rfqId","requisitionId","vendorId","status","validUntil","recordedById") VALUES('UPL-T2Q','p1','UPL-T2RFQ','UPL-T2REQ','UPL-T2V','recorded','2026-12-31','USER-1');
INSERT INTO "SupplierLabourQuoteLine"("id","projectId","quoteId","requisitionLineId","requisitionId","ratePerPersonShift","shiftPremium","landedPerPersonShift","matchesSpecification") VALUES('UPL-T2QL','p1','UPL-T2Q','UPL-T2RL','UPL-T2REQ',1000,100,1100,true);
INSERT INTO "LabourQuoteComparison"("id","projectId","rfqId","requisitionId","status","selectedQuoteId","selectedVendorId","reason","createdById","approvedById","approvedAt") VALUES('UPL-T2CMP','p1','UPL-T2RFQ','UPL-T2REQ','approved','UPL-T2Q','UPL-T2V','ok','USER-1','USER-1',NOW());
INSERT INTO "LabourPurchaseOrder"("id","projectId","vendorId","requisitionId","comparisonId","comparisonStatus","createdById") VALUES('UPL-T2PO','p1','UPL-T2V','UPL-T2REQ','UPL-T2CMP','approved','USER-1');
INSERT INTO "LabourPurchaseOrderVersion"("id","projectId","poId","version","requisitionId","comparisonId","status","issuedById","issuedAt","createdById") VALUES('UPL-T2POV','p1','UPL-T2PO',1,'UPL-T2REQ','UPL-T2CMP','issued','USER-1',NOW(),'USER-1');
INSERT INTO "LabourPurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","comparisonId","selectedQuoteId","selectedQuoteLineId") VALUES('UPL-T2POL','p1','UPL-T2POV','UPL-T2RL','UPL-T2REQ','UPL-F2OK',1,'2026-08-12','day',$FPD,3,1000,100,3300,'UPL-T2CMP','UPL-T2Q','UPL-T2QL');
-- a VALID second PO line (correct quote-line provenance) left UNCOMMITTED — the clean subject for the F3 identity probe
INSERT INTO "LabourPurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","comparisonId","selectedQuoteId","selectedQuoteLineId") VALUES('UPL-T2POL2','p1','UPL-T2POV','UPL-T2RL','UPL-T2REQ','UPL-F2OK',1,'2026-08-12','day',$FPD,3,1000,100,3300,'UPL-T2CMP','UPL-T2Q','UPL-T2QL');
INSERT INTO "CapacityCommitment"("id","projectId","poLineId","labourSpecFingerprint","civilDate","shift","personShiftQty","createdById") VALUES('UPL-T2CC','p1','UPL-T2POL',$FPD,'2026-08-12','day',3,'USER-1');
INSERT INTO "CapacityPromise"("id","projectId","commitmentId","seq","promisedDate","recordedById") VALUES('UPL-T2CP','p1','UPL-T2CC',1,'2026-08-11','USER-1');
COMMIT;
SQL
# the frozen PO-line commercial snapshot cannot be mutated (only committedQty may change)
assert_rejects "labour T2: mutating a frozen PO-line rate (frozen-snapshot trigger)" \
  "UPDATE \"LabourPurchaseOrderLine\" SET \"ratePerPersonShift\"=1 WHERE \"id\"='UPL-T2POL'"
# the labour PO root is append-only
assert_rejects "labour T2: mutating the append-only labour PO root" \
  "UPDATE \"LabourPurchaseOrder\" SET \"vendorId\"='x' WHERE \"id\"='UPL-T2PO'"
# a capacity promise is append-only
assert_rejects "labour T2: mutating an append-only capacity promise" \
  "UPDATE \"CapacityPromise\" SET \"promisedDate\"='2026-01-01' WHERE \"id\"='UPL-T2CP'"
# a second commitment on one PO line is unrepresentable (one-per-line partial unique)
assert_rejects "labour T2: a second capacity commitment on one PO line (one-per-line unique)" \
  "INSERT INTO \"CapacityCommitment\"(\"id\",\"projectId\",\"poLineId\",\"labourSpecFingerprint\",\"civilDate\",\"shift\",\"personShiftQty\",\"createdById\") VALUES('UPL-T2CC2','p1','UPL-T2POL',$FPD,'2026-08-12','day',3,'USER-1')"
# a PO line whose committedAmountBase != round((rate+premium)*qty,2) is rejected (frozen-amount CHECK)
assert_rejects "labour T2: a PO line with a wrong committedAmountBase (amount CHECK)" \
  "INSERT INTO \"LabourPurchaseOrderLine\"(\"id\",\"projectId\",\"poVersionId\",\"requisitionLineId\",\"requisitionId\",\"requirementId\",\"revision\",\"civilDate\",\"shift\",\"labourSpecFingerprint\",\"personShiftQty\",\"ratePerPersonShift\",\"shiftPremium\",\"committedAmountBase\") VALUES('UPL-T2POLBAD','p1','UPL-T2POV','UPL-T2RL','UPL-T2REQ','UPL-F2OK',1,'2026-08-12','day',$FPD,3,1000,100,9999)"
# a labour PO whose comparison provenance is not 'approved' is unrepresentable (status-pinned FK + CHECK)
assert_rejects "labour T2: a PO forging its provenance to a NON-approved comparison (status-pinned)" \
  "INSERT INTO \"LabourPurchaseOrder\"(\"id\",\"projectId\",\"vendorId\",\"requisitionId\",\"comparisonId\",\"comparisonStatus\",\"createdById\") VALUES('UPL-T2POF','p1','UPL-T2V','UPL-T2REQ','UPL-T2CMP','draft','USER-1')"

# ── Task-2 CORRECTION seals (F2..F5) over the migrated legacy DB ───────────────────────────────
assert "the Task-2 correction constraints + the requisition-line freeze trigger are installed" \
  "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('LabourPurchaseOrderLine_committed_le_person_check','CapacityCommitment_poLine_identity_fkey','LabourRequisitionLine_spec_identity_fkey','LabourRequisitionLine_slice_fkey','LabourPurchaseOrderLine_quote_provenance_fkey','LabourPurchaseOrderLine_comparison_selection_fkey','LabourPurchaseOrderLine_reqline_slice_fkey'))::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname='LabourRequisitionLine_frozen' AND NOT tgisinternal)::text;" \
  "7|1"
# F5 — committedQty may never exceed the ordered personShiftQty (UPL-T2POL orders 3)
assert_rejects "labour T2C F5: committedQty > personShiftQty (bound CHECK)" \
  "UPDATE \"LabourPurchaseOrderLine\" SET \"committedQty\"=99 WHERE \"id\"='UPL-T2POL'"
# F2 — a requisition line's frozen identity cannot be raw-mutated (freeze trigger)
assert_rejects "labour T2C F2: mutating a requisition line's frozen shift (freeze trigger)" \
  "UPDATE \"LabourRequisitionLine\" SET \"shift\"='night' WHERE \"id\"='UPL-T2RL'"
# F2 — a requisition line whose fingerprint is not the pinned spec's is unrepresentable (identity FK)
assert_rejects "labour T2C F2: a requisition line with a forged fingerprint (spec identity FK)" \
  "INSERT INTO \"LabourRequisitionLine\"(\"id\",\"projectId\",\"requisitionId\",\"requirementId\",\"revision\",\"civilDate\",\"shift\",\"labourSpecFingerprint\",\"personShiftQty\",\"status\") VALUES('UPL-T2RLF','p1','UPL-T2REQ','UPL-F2OK',1,'2026-08-12','day','forged-fingerprint',3,'open')"
# F3 — a commitment whose slice identity differs from its (uncommitted) PO line is unrepresentable (identity FK)
assert_rejects "labour T2C F3: a commitment with a mismatched slice identity (PO-line identity FK)" \
  "INSERT INTO \"CapacityCommitment\"(\"id\",\"projectId\",\"poLineId\",\"labourSpecFingerprint\",\"civilDate\",\"shift\",\"personShiftQty\",\"createdById\") VALUES('UPL-T2CCF','p1','UPL-T2POL2',$FPD,'2026-09-09','night',3,'USER-1')"
# F4 — a PO line whose rate/premium did not come from the comparison-selected quote line is unrepresentable (provenance FK)
assert_rejects "labour T2C F4: a PO line with a rate not from the selected quote line (provenance FK)" \
  "INSERT INTO \"LabourPurchaseOrderLine\"(\"id\",\"projectId\",\"poVersionId\",\"requisitionLineId\",\"requisitionId\",\"requirementId\",\"revision\",\"civilDate\",\"shift\",\"labourSpecFingerprint\",\"personShiftQty\",\"ratePerPersonShift\",\"shiftPremium\",\"committedAmountBase\",\"comparisonId\",\"selectedQuoteId\",\"selectedQuoteLineId\") VALUES('UPL-T2POLF','p1','UPL-T2POV','UPL-T2RL','UPL-T2REQ','UPL-F2OK',1,'2026-08-12','day',$FPD,3,2000,100,6300,'UPL-T2CMP','UPL-T2Q','UPL-T2QL')"
# F2/slice — a PO line whose COPIED slice identity differs from its requisition line is unrepresentable (reqline-slice FK)
assert_rejects "labour T2C F2: a PO line whose civil date differs from its requisition line (reqline-slice FK)" \
  "INSERT INTO \"LabourPurchaseOrderLine\"(\"id\",\"projectId\",\"poVersionId\",\"requisitionLineId\",\"requisitionId\",\"requirementId\",\"revision\",\"civilDate\",\"shift\",\"labourSpecFingerprint\",\"personShiftQty\",\"ratePerPersonShift\",\"shiftPremium\",\"committedAmountBase\",\"comparisonId\",\"selectedQuoteId\",\"selectedQuoteLineId\") VALUES('UPL-T2POLS','p1','UPL-T2POV','UPL-T2RL','UPL-T2REQ','UPL-F2OK',1,'2026-09-09','day',$FPD,3,1000,100,3300,'UPL-T2CMP','UPL-T2Q','UPL-T2QL')"

# ── Phase 4 Task 3 — the §C TIME-CAPACITY fact seals. The 4 additive tables upgrade ROW-FREE over
#    the legacy DB, and the DB seals (the worker-level conservation exclusion, the frozen-identity
#    and append-only triggers, the trusted device binding, the work↔allocation identity copy, and
#    §F bound 3) reject forgeries on the MIGRATED database. Anchored on the coherent Task-2 chain
#    above (UPL-T2POL / UPL-T2CC, slice 2026-08-12 day, 3 person-shifts).
assert "the 4 Phase-4 Task-3 time-capacity tables exist and are ROW-FREE over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('WorkerAllocation','LabourAttendance','LabourWorkFact','ApprovedSkillSubstitution'))::text || '|' || (SELECT COUNT(*) FROM \"WorkerAllocation\")::text || '|' || (SELECT COUNT(*) FROM \"LabourAttendance\")::text || '|' || (SELECT COUNT(*) FROM \"LabourWorkFact\")::text || '|' || (SELECT COUNT(*) FROM \"ApprovedSkillSubstitution\")::text;" \
  "4|0|0|0|0"
assert "the §C conservation exclusions + the 6 time-capacity triggers are installed" \
  "SELECT (SELECT COUNT(*) FROM pg_indexes WHERE indexname IN ('WorkerAllocation_live_slice_key','LabourAttendance_live_slice_key','ApprovedSkillSubstitution_active_key'))::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('WorkerAllocation_frozen','LabourAttendance_append_only','LabourWorkFact_append_only','ApprovedSkillSubstitution_append_only','LabourWorkFact_matches_allocation','WorkerAllocation_worker_active','LabourAttendance_device_bound','WorkerAllocation_within_commitment') AND NOT tgisinternal)::text;" \
  "3|8"

# a coherent §C fact chain over the Task-2 commitment: worker -> bound device -> allocation ->
# attendance -> effort. Proves the seals are PRECISE (they accept legitimate physical truth).
$PSQL >/dev/null <<SQL && printf 'ok      %s\n' "labour T3: a coherent §C time-capacity chain is accepted (seals are precise)" || { printf 'FAILED  %s\n' "labour T3 coherent chain rejected"; FAIL=1; }
BEGIN;
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  SELECT 'UPL-CMD1','project',"orgId",'p1','USER-1','labour.allocation.allocate','upl-t3-key','upl-t3-hash','succeeded' FROM "Project" WHERE "id"='p1';
INSERT INTO "Worker"("id","projectId","name","tradeCode","activeFrom","createdById") VALUES('UPL-T3W','p1','Mason A','mason','2026-01-01','USER-1');
INSERT INTO "WorkerSkill"("projectId","workerId","skillCode") VALUES('p1','UPL-T3W','bar-bending');
INSERT INTO "WorkerDevice"("id","projectId","token","workerId") VALUES('UPL-T3DEV','p1','upl-t3-token','UPL-T3W');
INSERT INTO "WorkerAllocation"("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","capacityCommitmentId","allocatedById","sourceCommandId")
  VALUES('UPL-T3ALLOC','p1','UPL-T3W','2026-08-12','day','ACT-1','UPL-F2OK',1,$FPD,'UPL-T2CC','USER-1','UPL-CMD1');
INSERT INTO "LabourAttendance"("id","projectId","workerId","civilDate","shift","deviceId","recordedById","sourceCommandId")
  VALUES('UPL-T3ATT','p1','UPL-T3W','2026-08-12','day','UPL-T3DEV','USER-1','UPL-CMD1');
INSERT INTO "LabourWorkFact"("id","projectId","workerId","allocationId","activityId","civilDate","shift","workedMinutes","recordedById","sourceCommandId")
  VALUES('UPL-T3WORK','p1','UPL-T3W','UPL-T3ALLOC','ACT-1','2026-08-12','day',480,'USER-1','UPL-CMD1');
COMMIT;
SQL

# §C.2 — the worker-level conservation exclusion: a second LIVE allocation of one worker for one
# (civilDate, shift) is unrepresentable, whoever writes it
assert_rejects "labour T3 §C.2: a second live allocation of one worker for one (date, shift)" \
  "INSERT INTO \"WorkerAllocation\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"activityId\",\"requirementId\",\"originRevision\",\"labourSpecFingerprint\",\"allocatedById\",\"sourceCommandId\") VALUES('UPL-T3DUP','p1','UPL-T3W','2026-08-12','day','ACT-1','UPL-F2OK',1,$FPD,'USER-1','UPL-CMD1')"
# the allocation identity is FROZEN — only status + release attribution may change
assert_rejects "labour T3 §C.2: re-pointing a frozen allocation's slice (frozen-identity trigger)" \
  "UPDATE \"WorkerAllocation\" SET \"civilDate\"='2026-08-13' WHERE \"id\"='UPL-T3ALLOC'"
assert_rejects "labour T3 §C.2: deleting an allocation (release it instead)" \
  "DELETE FROM \"WorkerAllocation\" WHERE \"id\"='UPL-T3ALLOC'"
# §F bound 3 — the commitment covers 3 person-shifts; a 4th draw is refused
assert_rejects "labour T3 §F bound 3: drawing more person-shifts than the commitment covers" \
  "INSERT INTO \"Worker\"(\"id\",\"projectId\",\"name\",\"tradeCode\",\"activeFrom\",\"createdById\") VALUES('UPL-T3W2','p1','Mason B','mason','2026-01-01','USER-1'); INSERT INTO \"Worker\"(\"id\",\"projectId\",\"name\",\"tradeCode\",\"activeFrom\",\"createdById\") VALUES('UPL-T3W3','p1','Mason C','mason','2026-01-01','USER-1'); INSERT INTO \"Worker\"(\"id\",\"projectId\",\"name\",\"tradeCode\",\"activeFrom\",\"createdById\") VALUES('UPL-T3W4','p1','Mason D','mason','2026-01-01','USER-1'); INSERT INTO \"WorkerAllocation\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"activityId\",\"requirementId\",\"originRevision\",\"labourSpecFingerprint\",\"capacityCommitmentId\",\"allocatedById\",\"sourceCommandId\") SELECT 'UPL-T3A'||w, 'p1', w, '2026-08-12','day','ACT-1','UPL-F2OK',1,$FPD,'UPL-T2CC','USER-1','UPL-CMD1' FROM (VALUES('UPL-T3W2'),('UPL-T3W3'),('UPL-T3W4')) AS t(w)"
# capacity committed for one slice can never be drawn for another (five-column slice-identity FK)
assert_rejects "labour T3 §F bound 3: drawing a commitment for a slice it does not cover" \
  "INSERT INTO \"WorkerAllocation\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"activityId\",\"requirementId\",\"originRevision\",\"labourSpecFingerprint\",\"capacityCommitmentId\",\"allocatedById\",\"sourceCommandId\") VALUES('UPL-T3MIS','p1','UPL-T3W','2026-08-13','day','ACT-1','UPL-F2OK',1,$FPD,'UPL-T2CC','USER-1','UPL-CMD1')"
# §C.3 — one live muster per worker/date/shift; presence history is append-only
assert_rejects "labour T3 §C.3: a second live muster for one worker/date/shift" \
  "INSERT INTO \"LabourAttendance\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3ATT2','p1','UPL-T3W','2026-08-12','day','USER-1','UPL-CMD1')"
assert_rejects "labour T3 §C.3: editing a presence observation (append-only trigger)" \
  "UPDATE \"LabourAttendance\" SET \"civilDate\"='2026-08-13' WHERE \"id\"='UPL-T3ATT'"
# §H — a device may evidence a muster ONLY for the worker it is bound to
assert_rejects "labour T3 §H: an UNBOUND device standing as attendance evidence" \
  "INSERT INTO \"WorkerDevice\"(\"id\",\"projectId\",\"token\") VALUES('UPL-T3DEV2','p1','upl-t3-token-2'); INSERT INTO \"LabourAttendance\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"deviceId\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3ATT3','p1','UPL-T3W','2026-08-14','day','UPL-T3DEV2','USER-1','UPL-CMD1')"
# §C.4 — effort is immutable and can never name a slice its allocation does not
assert_rejects "labour T3 §C.4: editing an effort observation (a correction is a NEW row)" \
  "UPDATE \"LabourWorkFact\" SET \"workedMinutes\"=1 WHERE \"id\"='UPL-T3WORK'"
assert_rejects "labour T3 §C.4: an effort fact naming a slice its allocation does not" \
  "INSERT INTO \"LabourWorkFact\"(\"id\",\"projectId\",\"workerId\",\"allocationId\",\"activityId\",\"civilDate\",\"shift\",\"workedMinutes\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3WF2','p1','UPL-T3W','UPL-T3ALLOC','ACT-1','2026-08-13','day',60,'USER-1','UPL-CMD1')"
assert_rejects "labour T3 §C.4: an effort record longer than one shift (per-row CHECK)" \
  "INSERT INTO \"LabourWorkFact\"(\"id\",\"projectId\",\"workerId\",\"allocationId\",\"activityId\",\"civilDate\",\"shift\",\"workedMinutes\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3WF3','p1','UPL-T3W','UPL-T3ALLOC','ACT-1','2026-08-12','day',721,'USER-1','UPL-CMD1')"
# §B — a substitution never admits its own identity, and only one is ACTIVE per (requirement, from, to)
assert_rejects "labour T3 §B: a substitution whose target equals its source (distinct CHECK)" \
  "INSERT INTO \"ApprovedSkillSubstitution\"(\"id\",\"projectId\",\"requirementId\",\"fromFingerprint\",\"toFingerprint\",\"reason\",\"approvedById\",\"sourceCommandId\") SELECT 'UPL-T3SUBBAD','p1','UPL-F2OK',$FPD,$FPD,'x','USER-1','UPL-CMD1'"
# a worker outside its active window can never be allocated
assert_rejects "labour T3 §H: allocating a worker outside its active window" \
  "INSERT INTO \"Worker\"(\"id\",\"projectId\",\"name\",\"tradeCode\",\"activeFrom\",\"activeTo\",\"createdById\") VALUES('UPL-T3WOLD','p1','Retired','mason','2026-01-01','2026-02-01','USER-1'); INSERT INTO \"WorkerAllocation\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"activityId\",\"requirementId\",\"originRevision\",\"labourSpecFingerprint\",\"allocatedById\",\"sourceCommandId\") SELECT 'UPL-T3AOLD','p1','UPL-T3WOLD','2026-08-12','day','ACT-1','UPL-F2OK',1,$FPD,'USER-1','UPL-CMD1'"

# ── Phase 4 Task 3 CORRECTION — the four review findings, sealed. The correction migration is
#    purely additive over the same row-free labour tables; these assertions prove each new seal is
#    installed AND that the coherent §C chain built above still passes it (the seals are precise).
assert "the Task-3 correction seals are installed (demand-identity FK, evidence CHECKs, media FK, head-live trigger)" \
  "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('WorkerAllocation_demand_identity_fkey','LabourAttendance_trusted_evidence','LabourAttendance_one_evidence_path','LabourAttendance_evidence_media_fkey'))::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'WorkerAllocation_head_live' AND NOT tgisinternal)::text;" \
  "4|1"
# F1 — an allocation may not name an activity that does not own its requirement revision
assert_rejects "labour T3C F1: an allocation naming an activity that does not own its requirement" \
  "INSERT INTO \"Activity\"(\"id\",\"projectId\",\"name\",\"zone\",\"plannedStart\",\"plannedEnd\") VALUES('UPL-T3CACT','p1','Other','Z',0,10); INSERT INTO \"WorkerAllocation\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"activityId\",\"requirementId\",\"originRevision\",\"labourSpecFingerprint\",\"allocatedById\",\"sourceCommandId\") VALUES('UPL-T3CF1','p1','UPL-T3W2','2026-08-12','day','UPL-T3CACT','UPL-F2OK',1,$FPD,'USER-1','UPL-CMD1')"
# F2 — presence with neither a bound device nor an explicit manual exception
assert_rejects "labour T3C F2: attendance with NO trusted evidence (device-or-manual CHECK)" \
  "INSERT INTO \"LabourAttendance\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3CF2','p1','UPL-T3W','2026-08-15','day','USER-1','UPL-CMD1')"
assert_rejects "labour T3C F2: attendance claiming BOTH a device and a manual exception" \
  "INSERT INTO \"LabourAttendance\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"deviceId\",\"manualReason\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3CF2B','p1','UPL-T3W','2026-08-16','day','UPL-T3DEV','both','USER-1','UPL-CMD1')"
assert_rejects "labour T3C F2: attendance citing a media id absent from its project (evidence FK)" \
  "INSERT INTO \"LabourAttendance\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"deviceId\",\"evidenceMediaId\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3CF2C','p1','UPL-T3W','2026-08-17','day','UPL-T3DEV','no-such-media','USER-1','UPL-CMD1')"
# a MANUAL muster (the explicit attributable exception) IS accepted — the seal is precise
$PSQL >/dev/null <<SQL && printf 'ok      %s\n' "labour T3C F2: an explicit MANUAL muster is accepted (the exception is modelled, not banned)" || { printf 'FAILED  %s\n' "labour T3C manual muster rejected"; FAIL=1; }
INSERT INTO "LabourAttendance"("id","projectId","workerId","civilDate","shift","manualReason","recordedById","sourceCommandId")
  VALUES('UPL-T3CMAN','p1','UPL-T3W','2026-08-18','day','device battery dead; foreman vouched at the gate','USER-1','UPL-CMD1');
SQL
# F4 — a cancelled requirement head accepts no new allocation
$PSQL >/dev/null <<SQL 2>&1
INSERT INTO "ActivityRequirement"("id","projectId","requirementId","revision","activityId","type","requiredQty","baseUom","requiredBy","status","createdById")
  SELECT 'UPL-T3CCANCEL','p1','UPL-F2OK',2,"activityId",'labour',3,'person-shift','2026-08-12','cancelled','USER-1' FROM "ActivityRequirement" WHERE "projectId"='p1' AND "requirementId"='UPL-F2OK' AND "revision"=1;
SQL
assert_rejects "labour T3C F4: an allocation against a CANCELLED requirement head" \
  "INSERT INTO \"WorkerAllocation\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"activityId\",\"requirementId\",\"originRevision\",\"labourSpecFingerprint\",\"allocatedById\",\"sourceCommandId\") SELECT 'UPL-T3CF4','p1','UPL-T3W2','2026-08-12','day',\"activityId\",'UPL-F2OK',1,$FPD,'USER-1','UPL-CMD1' FROM \"ActivityRequirement\" WHERE \"projectId\"='p1' AND \"requirementId\"='UPL-F2OK' AND \"revision\"=1"

# ── Task-3 correction ROUND 2 (20270220000000) ────────────────────────────────────────────────
# Finding 1 — the manual muster's justification is frozen with the rest of the observation, and a
# blank reason is not a reason. `UPL-T3CMAN` above is the accepted manual muster these act on.
assert_rejects "labour T3C2 finding 1: rewriting a recorded manualReason after the fact" \
  "UPDATE \"LabourAttendance\" SET \"manualReason\"='a different story' WHERE \"id\"='UPL-T3CMAN'"
assert_rejects "labour T3C2 finding 1: a whitespace-only manualReason (spaces)" \
  "INSERT INTO \"LabourAttendance\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"manualReason\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3C2B1','p1','UPL-T3W','2026-08-19','day','   ','USER-1','UPL-CMD1')"
assert_rejects "labour T3C2 finding 1: a whitespace-only manualReason (tab/newline/VT/FF — none are in btrim's default set)" \
  "INSERT INTO \"LabourAttendance\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"manualReason\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3C2B2','p1','UPL-T3W','2026-08-20','day',E'\t\n\x0B\f ','USER-1','UPL-CMD1')"
# … while the ONE permitted mutation still works: a single revocation stamp, reason preserved.
$PSQL >/dev/null <<SQL && printf 'ok      %s\n' "labour T3C2 finding 1: the one-time revocation stamp is still permitted (precision, not just strictness)" || { printf 'FAILED  %s\n' "labour T3C2 revocation stamp rejected"; FAIL=1; }
UPDATE "LabourAttendance" SET "revokedAt"=NOW(),"revokedById"='USER-1',"revokeReason"='recorded against the wrong worker' WHERE "id"='UPL-T3CMAN';
SQL
assert_rejects "labour T3C2 finding 1: a revoked muster is terminal (no second stamp)" \
  "UPDATE \"LabourAttendance\" SET \"revokeReason\"='changed my mind' WHERE \"id\"='UPL-T3CMAN'"

# ── Task-3 correction ROUND 3 (20270225000000) ────────────────────────────────────────────────
# Finding 1 — the invalid-legacy marker is RESERVED for the audited operator repair (t3c:repair),
# which only ever UPDATEs an existing row and always revokes it in the same statement. No ordinary
# write may claim it, and no marked row may be left live: otherwise a forged marker would read like
# operator provenance and a repaired muster could still count as presence.
assert_rejects "labour T3C3 finding 1: an ordinary INSERT claiming the reserved invalid-legacy marker" \
  "INSERT INTO \"LabourAttendance\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"manualReason\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3C3M1','p1','UPL-T3W','2026-08-21','day','[invalid-legacy:blank-manual-reason] forged','USER-1','UPL-CMD1')"
assert_rejects "labour T3C3 finding 1: the marker prefix even with trailing text of its own" \
  "INSERT INTO \"LabourAttendance\"(\"id\",\"projectId\",\"workerId\",\"civilDate\",\"shift\",\"manualReason\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T3C3M2','p1','UPL-T3W','2026-08-22','day','[invalid-legacy:blank-manual-reason] retired by ops','USER-1','UPL-CMD1')"
# … and a REAL manual reason that merely mentions the words is still accepted (precision, not a
# blanket substring ban): only the reserved PREFIX is refused.
$PSQL >/dev/null <<SQL && printf 'ok      %s\n' "labour T3C3 finding 1: a real reason mentioning 'invalid legacy' is still accepted (prefix-scoped, not a word ban)" || { printf 'FAILED  %s\n' "labour T3C3 a legitimate reason was rejected"; FAIL=1; }
INSERT INTO "LabourAttendance"("id","projectId","workerId","civilDate","shift","manualReason","recordedById","sourceCommandId")
  VALUES('UPL-T3C3OK','p1','UPL-T3W','2026-08-23','day','device replaced after an invalid legacy tag was found on it','USER-1','UPL-CMD1');
SQL
# Finding 3 — the project readiness lock trigger is installed and fires FIRST on WorkerAllocation,
# which is what makes two opposite-order raw batches serialize instead of deadlocking.
$PSQL -tA -c "SELECT tgname FROM pg_trigger WHERE tgrelid='\"WorkerAllocation\"'::regclass AND NOT tgisinternal AND (tgtype & 4) <> 0 AND (tgtype & 2) <> 0 ORDER BY tgname LIMIT 1" \
  | grep -qx 'WorkerAllocation_00_project_lock' \
  && printf 'ok      %s\n' "labour T3C3 finding 3: the per-project readiness lock is the FIRST BEFORE-INSERT trigger on WorkerAllocation" \
  || { printf 'FAILED  %s\n' "labour T3C3 finding 3: the project-lock trigger does not fire first"; FAIL=1; }

# ── Phase 4 Task 4 — the SEVENTH rebuildable projection store (§A/§G). A purely additive,
#    row-free capability add: the generation-scoped LabourReadinessProjection table exists and
#    holds ZERO rows over the legacy DB (the forecast dto is recomputed from canonical facts by
#    the consumer/rebuild — the migration never writes data, and the labour pilot has no rows).
assert "the Phase-4 Task-4 LabourReadinessProjection table exists and is ROW-FREE over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'LabourReadinessProjection')::text || '|' || (SELECT COUNT(*) FROM \"LabourReadinessProjection\")::text;" \
  "1|0"

# ── Phase 4 Task 5 — the §E mismatch register + §I measured-output facts. The 3 additive tables
#    upgrade ROW-FREE over the legacy DB, and the DB seals (append-only triggers, the ONE-resolution
#    register unique, the kind/quantity/non-blank CHECKs, and the activity/worker/media/command
#    provenance composite FKs) reject forgeries on the MIGRATED database. Anchored on the coherent
#    Task-3 chain above (p1 / ACT-1 / UPL-T3W / UPL-CMD1).
assert "the 3 Phase-4 Task-5 reconciliation tables exist and are ROW-FREE over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('LabourMismatch','LabourMismatchResolution','ActivityWorkOutput'))::text || '|' || (SELECT COUNT(*) FROM \"LabourMismatch\")::text || '|' || (SELECT COUNT(*) FROM \"LabourMismatchResolution\")::text || '|' || (SELECT COUNT(*) FROM \"ActivityWorkOutput\")::text;" \
  "3|0|0|0"
assert "the Task-5 append-only triggers + register unique + integrity CHECKs are installed" \
  "SELECT (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('LabourMismatch_append_only','LabourMismatchResolution_append_only','ActivityWorkOutput_append_only') AND NOT tgisinternal)::text || '|' || (SELECT COUNT(*) FROM pg_indexes WHERE indexname = 'LabourMismatchResolution_projectId_mismatchId_key')::text || '|' || (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('LabourMismatch_kind_check','ActivityWorkOutput_quantity_check','LabourMismatch_note_nonblank','LabourMismatchResolution_text_nonblank','ActivityWorkOutput_text_nonblank','LabourMismatch_shift_check','ActivityWorkOutput_shift_check','LabourMismatch_kind_worker_check'))::text;" \
  "3|1|8"

# a coherent §E/§I chain: observation -> ONE resolution + a measured output. Proves the seals are
# PRECISE (they accept legitimate reconciliation truth).
$PSQL >/dev/null <<SQL && printf 'ok      %s\n' "labour T5: a coherent mismatch->resolution + output chain is accepted (seals are precise)" || { printf 'FAILED  %s\n' "labour T5 coherent chain rejected"; FAIL=1; }
BEGIN;
INSERT INTO "LabourMismatch"("id","projectId","activityId","civilDate","shift","kind","workerId","note","recordedById","sourceCommandId")
  VALUES('UPL-T5M','p1','ACT-1','2026-08-12','day','wrong_trade','UPL-T3W','carpenter sent for mason work','USER-1','UPL-CMD1');
INSERT INTO "LabourMismatchResolution"("id","projectId","mismatchId","resolution","reason","resolvedById","sourceCommandId")
  VALUES('UPL-T5R','p1','UPL-T5M','crew corrected on site','verified by pmc','USER-1','UPL-CMD1');
INSERT INTO "ActivityWorkOutput"("id","projectId","activityId","civilDate","shift","quantity","uom","recordedById","sourceCommandId")
  VALUES('UPL-T5O','p1','ACT-1','2026-08-12','day',12.5,'m3','USER-1','UPL-CMD1');
COMMIT;
SQL

# §E — the register: exactly ONE resolution per observation; a resolution needs a REAL observation
assert_rejects "labour T5 §E: a SECOND resolution for one observation (register unique)" \
  "INSERT INTO \"LabourMismatchResolution\"(\"id\",\"projectId\",\"mismatchId\",\"resolution\",\"reason\",\"resolvedById\",\"sourceCommandId\") VALUES('UPL-T5R2','p1','UPL-T5M','another story','forged','USER-1','UPL-CMD1')"
assert_rejects "labour T5 §E: a resolution citing a NONEXISTENT observation (composite FK)" \
  "INSERT INTO \"LabourMismatchResolution\"(\"id\",\"projectId\",\"mismatchId\",\"resolution\",\"reason\",\"resolvedById\",\"sourceCommandId\") VALUES('UPL-T5R3','p1','UPL-NOPE','x','y','USER-1','UPL-CMD1')"
# §E/§I — history is append-only, whoever writes
assert_rejects "labour T5 §E: editing a mismatch observation (append-only trigger)" \
  "UPDATE \"LabourMismatch\" SET \"note\"='forged' WHERE \"id\"='UPL-T5M'"
assert_rejects "labour T5 §E: deleting a mismatch observation (append-only trigger)" \
  "DELETE FROM \"LabourMismatch\" WHERE \"id\"='UPL-T5M'"
assert_rejects "labour T5 §E: editing a resolution register row (append-only trigger)" \
  "UPDATE \"LabourMismatchResolution\" SET \"reason\"='forged' WHERE \"id\"='UPL-T5R'"
assert_rejects "labour T5 §I: editing a measured output (append-only trigger)" \
  "UPDATE \"ActivityWorkOutput\" SET \"quantity\"=999 WHERE \"id\"='UPL-T5O'"
assert_rejects "labour T5 §I: deleting a measured output (append-only trigger)" \
  "DELETE FROM \"ActivityWorkOutput\" WHERE \"id\"='UPL-T5O'"
# integrity CHECKs — blank text, alien kind, non-positive quantity are unrepresentable
assert_rejects "labour T5 §E: a whitespace-only mismatch note (non-blank CHECK)" \
  "INSERT INTO \"LabourMismatch\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"kind\",\"note\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5MB','p1','ACT-1','2026-08-12','day','shortfall',E' \t\n','USER-1','UPL-CMD1')"
assert_rejects "labour T5 §E: an alien mismatch kind (kind CHECK)" \
  "INSERT INTO \"LabourMismatch\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"kind\",\"note\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5MK','p1','ACT-1','2026-08-12','day','vibes','n','USER-1','UPL-CMD1')"
assert_rejects "labour T5 §I: a zero-quantity output (quantity CHECK)" \
  "INSERT INTO \"ActivityWorkOutput\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"quantity\",\"uom\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5OZ','p1','ACT-1','2026-08-12','day',0,'m3','USER-1','UPL-CMD1')"
assert_rejects "labour T5 §I: a whitespace-only uom (non-blank CHECK)" \
  "INSERT INTO \"ActivityWorkOutput\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"quantity\",\"uom\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5OU','p1','ACT-1','2026-08-12','day',1,E'\t','USER-1','UPL-CMD1')"
# provenance — activity/worker/media/command references must be THIS project's real rows
assert_rejects "labour T5: a mismatch naming a nonexistent activity (composite FK)" \
  "INSERT INTO \"LabourMismatch\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"kind\",\"note\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5MA','p1','ACT-NOPE','2026-08-12','day','shortfall','n','USER-1','UPL-CMD1')"
assert_rejects "labour T5: a mismatch naming a foreign/nonexistent worker (composite FK)" \
  "INSERT INTO \"LabourMismatch\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"kind\",\"workerId\",\"note\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5MW','p1','ACT-1','2026-08-12','day','wrong_trade','W-NOPE','carpenter','USER-1','UPL-CMD1')"
assert_rejects "labour T5 §I: an output citing a nonexistent evidence photo (composite FK)" \
  "INSERT INTO \"ActivityWorkOutput\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"quantity\",\"uom\",\"evidenceMediaId\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5OE','p1','ACT-1','2026-08-12','day',1,'m3','MEDIA-NOPE','USER-1','UPL-CMD1')"
assert_rejects "labour T5: a forged sourceCommandId (provenance composite FK)" \
  "INSERT INTO \"LabourMismatch\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"kind\",\"note\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5MC','p1','ACT-1','2026-08-12','day','shortfall','n','USER-1','UPL-NOCMD')"
# Codex round 2 — the §E invariants hold even OUTSIDE the HTTP zod schemas (raw import,
# maintenance): the shift vocabulary is the same closed set as the Task-3 fact tables, and the
# kind<->worker correspondence is sealed at the database
assert_rejects "labour T5 round-2: an alien shift on a mismatch observation (shift CHECK)" \
  "INSERT INTO \"LabourMismatch\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"kind\",\"note\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5MS','p1','ACT-1','2026-08-12','swing','shortfall','n','USER-1','UPL-CMD1')"
assert_rejects "labour T5 round-2: an alien shift on a measured output (shift CHECK)" \
  "INSERT INTO \"ActivityWorkOutput\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"quantity\",\"uom\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5OS','p1','ACT-1','2026-08-12','swing',1,'m3','USER-1','UPL-CMD1')"
assert_rejects "labour T5 round-2: a shortfall NAMING a worker (kind<->worker CHECK)" \
  "INSERT INTO \"LabourMismatch\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"kind\",\"workerId\",\"note\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5MSW','p1','ACT-1','2026-08-13','day','shortfall','UPL-T3W','n','USER-1','UPL-CMD1')"
assert_rejects "labour T5 round-2: a wrong_trade naming NO worker (kind<->worker CHECK)" \
  "INSERT INTO \"LabourMismatch\"(\"id\",\"projectId\",\"activityId\",\"civilDate\",\"shift\",\"kind\",\"note\",\"recordedById\",\"sourceCommandId\") VALUES('UPL-T5MWT','p1','ACT-1','2026-08-13','day','wrong_trade','n','USER-1','UPL-CMD1')"

# ── Phase 5 Task 1 — the COMMERCIAL cost-head catalog + the §C commitment attribution. Both
#    tables upgrade ROW-FREE over the legacy DB (the pilot has no rows and the migration never
#    writes data — its closing block ABORTS if it finds any), and the §C seals reject forgeries on
#    the MIGRATED database. Anchored on the coherent PO lines above: UP45-POL (material) and
#    UPL-T2POL (labour).
assert "the 2 Phase-5 Task-1 commercial tables exist and are ROW-FREE over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('CostHead','CommitmentAttribution'))::text || '|' || (SELECT COUNT(*) FROM \"CostHead\")::text || '|' || (SELECT COUNT(*) FROM \"CommitmentAttribution\")::text;" \
  "2|0|0"
assert "the Task-1 XOR/supersede CHECKs, per-target partial uniques and immutability triggers are installed" \
  "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('CommitmentAttribution_target_xor','CommitmentAttribution_supersede_complete','CommitmentAttribution_text_nonblank','CostHead_text_nonblank'))::text || '|' || (SELECT COUNT(*) FROM pg_indexes WHERE indexname IN ('CommitmentAttribution_active_poLine_key','CommitmentAttribution_active_labourPoLine_key'))::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('CommitmentAttribution_append_only','CostHead_key_frozen') AND NOT tgisinternal)::text;" \
  "4|2|2"
# §C — the attribution carries NO amount column. The absence is load-bearing: a column to copy the
# frozen committed amount into is exactly how "the amount is not copied" gets broken.
assert "the §C attribution has NO amount column (a second committed-amount ledger is unrepresentable)" \
  "SELECT COUNT(*)::text FROM information_schema.columns WHERE table_name='CommitmentAttribution' AND column_name IN ('amount','committedAmountBase','committedAmount');" \
  "0"

# a coherent §C chain: two cost heads, one material attribution and one labour attribution. Proves
# the seals are PRECISE (they accept legitimate attribution truth), not merely strict.
$PSQL >/dev/null <<SQL && printf 'ok      %s\n' "commercial T1: a coherent cost-head + material/labour attribution chain is accepted (seals are precise)" || { printf 'FAILED  %s\n' "commercial T1 coherent chain rejected"; FAIL=1; }
BEGIN;
INSERT INTO "CostHead"("projectId","code","name","definedById") VALUES('p1','CIVIL','Civil works','USER-1');
INSERT INTO "CostHead"("projectId","code","name","definedById") VALUES('p1','MEP','MEP','USER-1');
INSERT INTO "CommitmentAttribution"("id","projectId","poLineId","costHeadCode","reason","createdById")
  VALUES('UPL-P5A','p1','UP45-POL','CIVIL','purchase order issued','USER-1');
INSERT INTO "CommitmentAttribution"("id","projectId","labourPoLineId","costHeadCode","reason","createdById")
  VALUES('UPL-P5AL','p1','UPL-T2POL','CIVIL','labour purchase order issued','USER-1');
COMMIT;
SQL

# §C — EXACTLY ONE target. Both degenerate shapes are unrepresentable.
assert_rejects "commercial T1 §C: an attribution with NEITHER target (XOR CHECK)" \
  "INSERT INTO \"CommitmentAttribution\"(\"id\",\"projectId\",\"costHeadCode\",\"reason\",\"createdById\") VALUES('UPL-P5X0','p1','CIVIL','attributes nothing','USER-1')"
assert_rejects "commercial T1 §C: an attribution with BOTH targets (XOR CHECK)" \
  "INSERT INTO \"CommitmentAttribution\"(\"id\",\"projectId\",\"poLineId\",\"labourPoLineId\",\"costHeadCode\",\"reason\",\"createdById\") VALUES('UPL-P5X2','p1','UP45-POL','UPL-T2POL','CIVIL','two obligations, one row','USER-1')"
# §C — exactly ONE active attribution per target
assert_rejects "commercial T1 §C: a SECOND active attribution for one material line (partial unique)" \
  "INSERT INTO \"CommitmentAttribution\"(\"id\",\"projectId\",\"poLineId\",\"costHeadCode\",\"reason\",\"createdById\") VALUES('UPL-P5D','p1','UP45-POL','MEP','double-counted','USER-1')"
assert_rejects "commercial T1 §C: a SECOND active attribution for one labour line (partial unique)" \
  "INSERT INTO \"CommitmentAttribution\"(\"id\",\"projectId\",\"labourPoLineId\",\"costHeadCode\",\"reason\",\"createdById\") VALUES('UPL-P5DL','p1','UPL-T2POL','MEP','double-counted','USER-1')"
# §C — the seal is on EVERY row from insertion: the hostile in-place reclassification of the LIVE
# row is refused, and so is smuggling one inside an otherwise-legitimate supersession stamp
assert_rejects "commercial T1 §C: the in-place CIVIL->MEP edit of the LIVE attribution" \
  "UPDATE \"CommitmentAttribution\" SET \"costHeadCode\"='MEP' WHERE \"id\"='UPL-P5A'"
assert_rejects "commercial T1 §C: rewriting a live attribution's reason" \
  "UPDATE \"CommitmentAttribution\" SET \"reason\"='rewritten' WHERE \"id\"='UPL-P5A'"
assert_rejects "commercial T1 §C: DELETING an attribution (append-only)" \
  "DELETE FROM \"CommitmentAttribution\" WHERE \"id\"='UPL-P5A'"
assert_rejects "commercial T1 §C: piggybacking a cost-head change onto a supersession stamp" \
  "UPDATE \"CommitmentAttribution\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='stamp', \"costHeadCode\"='MEP' WHERE \"id\"='UPL-P5A'"
# §C — a half-stamped supersession would leave the line unattributed with nobody accountable
assert_rejects "commercial T1 §C: an unattributable half-stamped supersession (supersede-complete CHECK)" \
  "UPDATE \"CommitmentAttribution\" SET \"supersededAt\"=now() WHERE \"id\"='UPL-P5A'"
# §C — the ONE permitted transition succeeds, and cannot be repeated
$PSQL >/dev/null -c "UPDATE \"CommitmentAttribution\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='reclassified' WHERE \"id\"='UPL-P5A'" \
  && printf 'ok      %s\n' "commercial T1 §C: the ONE permitted transition (stamping an ACTIVE row superseded) is accepted" \
  || { printf 'FAILED  %s\n' "commercial T1 §C: the permitted supersession was rejected"; FAIL=1; }
assert_rejects "commercial T1 §C: stamping an ALREADY-superseded row a second time" \
  "UPDATE \"CommitmentAttribution\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='again' WHERE \"id\"='UPL-P5A'"
assert_rejects "commercial T1 §C: DELETING a superseded attribution (history is not erasable)" \
  "DELETE FROM \"CommitmentAttribution\" WHERE \"id\"='UPL-P5A'"
# …and the freed material line can be re-attributed, so supersession really releases the unique
$PSQL >/dev/null -c "INSERT INTO \"CommitmentAttribution\"(\"id\",\"projectId\",\"poLineId\",\"costHeadCode\",\"reason\",\"createdById\") VALUES('UPL-P5A2','p1','UP45-POL','MEP','reclassified','USER-1')" \
  && printf 'ok      %s\n' "commercial T1 §C: the replacement attribution is accepted once the prior is superseded" \
  || { printf 'FAILED  %s\n' "commercial T1 §C: the replacement attribution was rejected"; FAIL=1; }
# §0b — a key that groups money is FROZEN after write (the unreferenced rename the FK cannot reach)
assert_rejects "commercial T1 §0b: re-keying a cost head in place (key-freeze trigger)" \
  "UPDATE \"CostHead\" SET \"code\"='RENAMED' WHERE \"projectId\"='p1' AND \"code\"='MEP'"
assert_rejects "commercial T1 §0b: rewriting a cost head's definition provenance" \
  "UPDATE \"CostHead\" SET \"definedById\"='USER-2' WHERE \"projectId\"='p1' AND \"code\"='MEP'"
# tenancy + referential truth — a cross-project or invented reference is unrepresentable
assert_rejects "commercial T1: an attribution naming ANOTHER project's PO line (same-project composite FK)" \
  "INSERT INTO \"CommitmentAttribution\"(\"id\",\"projectId\",\"poLineId\",\"costHeadCode\",\"reason\",\"createdById\") VALUES('UPL-P5T','p2','UP45-POL','CIVIL','cross-tenant','USER-1')"
assert_rejects "commercial T1: an attribution citing a cost head that does not exist (composite FK)" \
  "INSERT INTO \"CommitmentAttribution\"(\"id\",\"projectId\",\"labourPoLineId\",\"costHeadCode\",\"reason\",\"createdById\") VALUES('UPL-P5H','p1','UPL-T2POL2','NOPE','invented head','USER-1')"
assert_rejects "commercial T1 §0b: a whitespace-only attribution reason (non-blank CHECK)" \
  "INSERT INTO \"CommitmentAttribution\"(\"id\",\"projectId\",\"poLineId\",\"costHeadCode\",\"reason\",\"createdById\") VALUES('UPL-P5B','p1','UPL-T2POL2','CIVIL',E' \t\n','USER-1')"
assert_rejects "commercial T1 §0b: a whitespace-only cost-head code (non-blank CHECK)" \
  "INSERT INTO \"CostHead\"(\"projectId\",\"code\",\"name\",\"definedById\") VALUES('p1',E' \t\n','Blank','USER-1')"

# ── Phase 5 Task 2 — the §B versioned BUDGET and the over-budget EXCEPTION. Both tables upgrade
#    ROW-FREE over the legacy DB (the pilot has no rows; each migration's closing block ABORTS if
#    it finds any), and the §B seals reject forgeries on the MIGRATED database. Anchored on the
#    cost heads created by the Task-1 coherent chain above (p1/CIVIL and p1/MEP).
assert "the 2 Phase-5 Task-2 budget tables exist and are ROW-FREE over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('BudgetLine','BudgetException'))::text || '|' || (SELECT COUNT(*) FROM \"BudgetLine\")::text || '|' || (SELECT COUNT(*) FROM \"BudgetException\")::text;" \
  "2|0|0"
assert "the Task-2 sign/version/relation CHECKs, live+open partial uniques and append-only triggers are installed" \
  "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('BudgetLine_amount_check','BudgetLine_version_check','BudgetLine_supersede_complete','BudgetLine_text_nonblank','BudgetException_headroom_check','BudgetException_arithmetic_check','BudgetException_raisedBy_check'))::text || '|' || (SELECT COUNT(*) FROM pg_indexes WHERE indexname IN ('BudgetLine_live_costHead_key','BudgetException_open_costHead_key'))::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('BudgetLine_append_only','BudgetException_lifecycle') AND NOT tgisinternal)::text;" \
  "7|2|2"

# a coherent §B chain: v1, a revision that supersedes it, and an exception raised against the live
# version. Proves the seals are PRECISE (they accept legitimate budget truth), not merely strict.
$PSQL >/dev/null <<SQL && printf 'ok      %s\n' "commercial T2 §B: a coherent budget v1 -> revision -> exception chain is accepted (seals are precise)" || { printf 'FAILED  %s\n' "commercial T2 coherent budget chain rejected"; FAIL=1; }
BEGIN;
INSERT INTO "BudgetLine"("id","projectId","costHeadCode","amount","version","reason","createdById")
  VALUES('UPL-P5BL1','p1','CIVIL',100.00,1,'civil plan','USER-1');
UPDATE "BudgetLine" SET "supersededAt"=now(), "supersededById"='USER-1', "supersedeReason"='budget cut'
  WHERE "id"='UPL-P5BL1';
INSERT INTO "BudgetLine"("id","projectId","costHeadCode","amount","version","reason","createdById")
  VALUES('UPL-P5BL2','p1','CIVIL',50.00,2,'civil plan v2','USER-1');
INSERT INTO "BudgetException"("id","projectId","costHeadCode","headroom","budget","exposure","raisedBy","raisedById")
  VALUES('UPL-P5BX1','p1','CIVIL',-40.00,50.00,90.00,'budget_revision','USER-1');
COMMIT;
SQL

# §B — exactly ONE live budget chain per head, and the amount can never be negative
assert_rejects "commercial T2 §B: a SECOND live budget version for one head (live partial unique)" \
  "INSERT INTO \"BudgetLine\"(\"id\",\"projectId\",\"costHeadCode\",\"amount\",\"version\",\"reason\",\"createdById\") VALUES('UPL-P5BLD','p1','CIVIL',10.00,3,'a second live plan','USER-1')"
assert_rejects "commercial T2 §B: a NEGATIVE budget amount (sign CHECK)" \
  "INSERT INTO \"BudgetLine\"(\"id\",\"projectId\",\"costHeadCode\",\"amount\",\"version\",\"reason\",\"createdById\") VALUES('UPL-P5BLN','p1','MEP',-1.00,1,'negative authority','USER-1')"
assert_rejects "commercial T2 §B: a version below 1 (monotonic-version CHECK)" \
  "INSERT INTO \"BudgetLine\"(\"id\",\"projectId\",\"costHeadCode\",\"amount\",\"version\",\"reason\",\"createdById\") VALUES('UPL-P5BLV','p1','MEP',10.00,0,'version zero','USER-1')"
assert_rejects "commercial T2 §B: a whitespace-only budget reason (non-blank CHECK)" \
  "INSERT INTO \"BudgetLine\"(\"id\",\"projectId\",\"costHeadCode\",\"amount\",\"version\",\"reason\",\"createdById\") VALUES('UPL-P5BLB','p1','MEP',10.00,1,E' \t\n','USER-1')"
# §B — versions are IMMUTABLE: the amount a budget authorised is not editable after the fact
assert_rejects "commercial T2 §B: editing a LIVE budget amount in place (append-only trigger)" \
  "UPDATE \"BudgetLine\" SET \"amount\"=999.00 WHERE \"id\"='UPL-P5BL2'"
assert_rejects "commercial T2 §B: rewriting a superseded version's amount (history is not editable)" \
  "UPDATE \"BudgetLine\" SET \"amount\"=999.00 WHERE \"id\"='UPL-P5BL1'"
assert_rejects "commercial T2 §B: DELETING a budget version (append-only)" \
  "DELETE FROM \"BudgetLine\" WHERE \"id\"='UPL-P5BL1'"
assert_rejects "commercial T2 §B: an unattributable half-stamped supersession (supersede-complete CHECK)" \
  "UPDATE \"BudgetLine\" SET \"supersededAt\"=now() WHERE \"id\"='UPL-P5BL2'"
assert_rejects "commercial T2 §B: re-stamping an ALREADY-superseded version" \
  "UPDATE \"BudgetLine\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='again' WHERE \"id\"='UPL-P5BL1'"

# §B — the exception describes a REAL breach: negative headroom, and `headroom = budget - exposure`
assert_rejects "commercial T2 §B: an exception with NON-negative headroom (there is nothing to flag)" \
  "INSERT INTO \"BudgetException\"(\"id\",\"projectId\",\"costHeadCode\",\"headroom\",\"budget\",\"exposure\",\"raisedBy\",\"raisedById\") VALUES('UPL-P5BXP','p1','MEP',10.00,50.00,40.00,'commitment','USER-1')"
assert_rejects "commercial T2 §B: an exception whose arithmetic does not hold (relation CHECK)" \
  "INSERT INTO \"BudgetException\"(\"id\",\"projectId\",\"costHeadCode\",\"headroom\",\"budget\",\"exposure\",\"raisedBy\",\"raisedById\") VALUES('UPL-P5BXA','p1','MEP',-10.00,50.00,999.00,'commitment','USER-1')"
assert_rejects "commercial T2 §B: a SECOND open exception on one head (open partial unique)" \
  "INSERT INTO \"BudgetException\"(\"id\",\"projectId\",\"costHeadCode\",\"headroom\",\"budget\",\"exposure\",\"raisedBy\",\"raisedById\") VALUES('UPL-P5BXD','p1','CIVIL',-5.00,50.00,55.00,'commitment','USER-1')"
assert_rejects "commercial T2 §B: an UNLABELLED headroom mover (raisedBy CHECK)" \
  "INSERT INTO \"BudgetException\"(\"id\",\"projectId\",\"costHeadCode\",\"headroom\",\"budget\",\"exposure\",\"raisedBy\",\"raisedById\") VALUES('UPL-P5BXU','p1','MEP',-10.00,50.00,60.00,'somebody_did_something','USER-1')"
# §B round-2 — `acceptance` IS one of the four movers: accepted OVERAGE raises exposure with no
# commitment released against it, so a receipt can breach a budget with no PO write anywhere
$PSQL >/dev/null -c "INSERT INTO \"BudgetException\"(\"id\",\"projectId\",\"costHeadCode\",\"headroom\",\"budget\",\"exposure\",\"raisedBy\",\"raisedById\") VALUES('UPL-P5BXAC','p1','MEP',-10.00,50.00,60.00,'acceptance','USER-1')" \
  && printf 'ok      %s\n' "commercial T2 §B: an exception raised by an ACCEPTANCE overage is accepted (the fourth mover)" \
  || { printf 'FAILED  %s\n' "commercial T2 §B: the acceptance-raised exception was rejected"; FAIL=1; }
# §B round-4 — `receipt_progress` is the FIFTH mover: moving `receivedQty` re-prices a closed-short
# line's release with NOTHING accepted, so recording it as `acceptance` would claim a delivery that
# never happened. `raisedBy` is the durable explanation, so PostgreSQL must admit the honest label.
$PSQL >/dev/null -c "UPDATE \"BudgetException\" SET \"clearedAt\"=now() WHERE \"id\"='UPL-P5BXAC'" >/dev/null
$PSQL >/dev/null -c "INSERT INTO \"BudgetException\"(\"id\",\"projectId\",\"costHeadCode\",\"headroom\",\"budget\",\"exposure\",\"raisedBy\",\"raisedById\") VALUES('UPL-P5BXRP','p1','MEP',-10.00,50.00,60.00,'receipt_progress','USER-1')" \
  && printf 'ok      %s\n' "commercial T2 §B: an exception raised by RECEIPT PROGRESS is accepted (the fifth mover)" \
  || { printf 'FAILED  %s\n' "commercial T2 §B: the receipt_progress exception was rejected"; FAIL=1; }
$PSQL >/dev/null -c "UPDATE \"BudgetException\" SET \"clearedAt\"=now() WHERE \"id\"='UPL-P5BXRP'" >/dev/null
# §B — the exception is a LIFECYCLE row with exactly ONE permitted transition
assert_rejects "commercial T2 §B: editing an open exception's figures (lifecycle trigger)" \
  "UPDATE \"BudgetException\" SET \"headroom\"=-1.00 WHERE \"id\"='UPL-P5BX1'"
assert_rejects "commercial T2 §B: re-labelling which write raised an exception" \
  "UPDATE \"BudgetException\" SET \"raisedBy\"='commitment' WHERE \"id\"='UPL-P5BX1'"
assert_rejects "commercial T2 §B: DELETING an exception (a breach is history, never erased)" \
  "DELETE FROM \"BudgetException\" WHERE \"id\"='UPL-P5BX1'"
$PSQL >/dev/null -c "UPDATE \"BudgetException\" SET \"clearedAt\"=now() WHERE \"id\"='UPL-P5BX1'" \
  && printf 'ok      %s\n' "commercial T2 §B: the ONE permitted transition (clearing an OPEN exception) is accepted" \
  || { printf 'FAILED  %s\n' "commercial T2 §B: the permitted clear was rejected"; FAIL=1; }
assert_rejects "commercial T2 §B: RE-OPENING a cleared exception" \
  "UPDATE \"BudgetException\" SET \"clearedAt\"=NULL WHERE \"id\"='UPL-P5BX1'"
# …and the cleared head can be flagged again, so clearing really releases the open unique
$PSQL >/dev/null -c "INSERT INTO \"BudgetException\"(\"id\",\"projectId\",\"costHeadCode\",\"headroom\",\"budget\",\"exposure\",\"raisedBy\",\"raisedById\") VALUES('UPL-P5BX2','p1','CIVIL',-20.00,50.00,70.00,'commitment','USER-1')" \
  && printf 'ok      %s\n' "commercial T2 §B: a fresh exception is accepted once the prior is cleared" \
  || { printf 'FAILED  %s\n' "commercial T2 §B: the follow-on exception was rejected"; FAIL=1; }
# tenancy — a budget or exception on ANOTHER project's cost head is unrepresentable
assert_rejects "commercial T2: a budget line naming ANOTHER project's cost head (same-project composite FK)" \
  "INSERT INTO \"BudgetLine\"(\"id\",\"projectId\",\"costHeadCode\",\"amount\",\"version\",\"reason\",\"createdById\") VALUES('UPL-P5BLT','p2','CIVIL',10.00,1,'cross-tenant','USER-1')"
assert_rejects "commercial T2: an exception citing a cost head that does not exist (composite FK)" \
  "INSERT INTO \"BudgetException\"(\"id\",\"projectId\",\"costHeadCode\",\"headroom\",\"budget\",\"exposure\",\"raisedBy\",\"raisedById\") VALUES('UPL-P5BXH','p1','NOPE',-1.00,1.00,2.00,'commitment','USER-1')"

# ── Phase 5 Task 3 — the §D MEASUREMENT. The table upgrades ROW-FREE over the legacy DB (the
#    migration's closing block ABORTS if it finds any), and its seals reject forgeries on the
#    MIGRATED database. A measurement is LABOUR-only and FULLY immutable — stricter than the
#    append-only tables that permit one supersession stamp, because it has no lifecycle at all.
assert "the Phase-5 Task-3 Measurement table exists and is ROW-FREE over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name='Measurement')::text || '|' || (SELECT COUNT(*) FROM \"Measurement\")::text;" \
  "1|0"
assert "the Task-3 quantity/reason/self-correction CHECKs and the immutability trigger are installed" \
  "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('Measurement_quantity_check','Measurement_correction_reasoned','Measurement_reason_nonblank','Measurement_corrects_not_self'))::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'Measurement_immutable' AND NOT tgisinternal)::text;" \
  "4|1"
# round-3 — the row-level correction floor is only sound over a ONE-LEVEL tree, so a correction
# targeting another correction must be unrepresentable, not merely refused by the service.
# round-4 — and it must fire at COMMIT: a BEFORE trigger's snapshot and the FK's are taken at
# different moments, so a target committing between them was seen by the FK and missed by the
# trigger. DEFERRABLE INITIALLY DEFERRED leaves no interleaving before the check.
assert "the Task-3 correction-target trigger is installed and DEFERRED to commit" \
  "SELECT (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'Measurement_correction_target' AND NOT tgisinternal)::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname = 'Measurement_correction_target' AND tgdeferrable AND tginitdeferred)::text;" \
  "1|1"
# round-4 — the two identity FKs: a cited output belongs to the MEASURING activity, and a
# correction carries its target's WHOLE work identity (not merely the target's existence)
assert "the Task-3 round-4 identity FKs and their candidate keys are installed" \
  "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('Measurement_projectId_citedOutputId_activityId_fkey','Measurement_corrects_identity_fkey'))::text || '|' || (SELECT COUNT(*) FROM pg_indexes WHERE indexname IN ('Measurement_corrects_identity_key','ActivityWorkOutput_projectId_id_activityId_key'))::text;" \
  "2|2"
# §D — MATERIAL lines are not measured, and the ABSENCE of the column is what makes that true:
# `ACCEPTED(poLine)` already IS the measurement of a delivery, so a parallel manual figure would be
# a second truth about one physical event. There is no `poLineId` to point at a material line with.
assert "the §D measurement has NO material PO-line column (a material measurement is unrepresentable)" \
  "SELECT COUNT(*)::text FROM information_schema.columns WHERE table_name='Measurement' AND column_name IN ('poLineId','purchaseOrderLineId');" \
  "0"
# §B round-5 — `measurement` joins the headroom-mover set (§D makes measured person-shifts the
# labour CONSUMPTION term), so PostgreSQL must admit the honest label.
$PSQL >/dev/null -c "INSERT INTO \"BudgetException\"(\"id\",\"projectId\",\"costHeadCode\",\"headroom\",\"budget\",\"exposure\",\"raisedBy\",\"raisedById\") VALUES('UPL-P5BXME','p1','MEP',-10.00,50.00,60.00,'measurement','USER-1')" \
  && printf 'ok      %s\n' "commercial T3 §B: an exception raised by a MEASUREMENT is accepted (the sixth mover)" \
  || { printf 'FAILED  %s\n' "commercial T3 §B: the measurement-raised exception was rejected"; FAIL=1; }
$PSQL >/dev/null -c "UPDATE \"BudgetException\" SET \"clearedAt\"=now() WHERE \"id\"='UPL-P5BXME'" >/dev/null
# A coherent §D chain FIRST — an original measurement and its signed correction, both citing the
# real §I output `UPL-T5O` on the same activity. This proves the seals below are PRECISE rather
# than merely strict, and it is what makes each rejection attributable: every hostile row differs
# from this accepted one in exactly the one respect its label names. (Cite a nonexistent output and
# every rejection below would pass on the `citedOutputId` FK while proving nothing.)
$PSQL >/dev/null <<SQL && printf 'ok      %s\n' "commercial T3 §D: a coherent measurement + its signed correction are accepted (seals are precise)" || { printf 'FAILED  %s\n' "commercial T3 §D coherent measurement chain rejected"; FAIL=1; }
BEGIN;
INSERT INTO "Measurement"("id","projectId","labourPoLineId","activityId","quantity","measuredOn","citedOutputId","takenById","sourceCommandId")
  VALUES('UPL-P5M0','p1','UPL-T2POL','ACT-1',2,'2026-08-12','UPL-T5O','USER-1','UPL-CMD1');
INSERT INTO "Measurement"("id","projectId","labourPoLineId","activityId","quantity","correctsId","reason","measuredOn","citedOutputId","takenById","sourceCommandId")
  VALUES('UPL-P5M0C','p1','UPL-T2POL','ACT-1',-1,'UPL-P5M0','over-measured by one shift','2026-08-12','UPL-T5O','USER-1','UPL-CMD1');
COMMIT;
SQL
# tenancy + referential truth — every reference is same-project or unrepresentable
assert_rejects "commercial T3 §D: a measurement naming a labour PO line that does not exist (composite FK)" \
  "INSERT INTO \"Measurement\"(\"id\",\"projectId\",\"labourPoLineId\",\"activityId\",\"quantity\",\"measuredOn\",\"citedOutputId\",\"takenById\",\"sourceCommandId\") VALUES('UPL-P5M1','p1','NOPE','ACT-1',1,'2026-08-12','UPL-T5O','USER-1','UPL-CMD1')"
assert_rejects "commercial T3 §D: a measurement of ZERO (quantity CHECK — it measures nothing)" \
  "INSERT INTO \"Measurement\"(\"id\",\"projectId\",\"labourPoLineId\",\"activityId\",\"quantity\",\"measuredOn\",\"citedOutputId\",\"takenById\",\"sourceCommandId\") VALUES('UPL-P5M2','p1','UPL-T2POL','ACT-1',0,'2026-08-12','UPL-T5O','USER-1','UPL-CMD1')"
# round-3 — an ORIGINAL records work that HAPPENED, so it is strictly positive; only a CORRECTION
# carries a sign. A negative original slipped in directly would be PERMANENT (the row is immutable)
# and would sit under every service-side floor as corrupted billing evidence.
assert_rejects "commercial T3 §D: a NEGATIVE original measurement (only a correction carries a sign)" \
  "INSERT INTO \"Measurement\"(\"id\",\"projectId\",\"labourPoLineId\",\"activityId\",\"quantity\",\"measuredOn\",\"citedOutputId\",\"takenById\",\"sourceCommandId\") VALUES('UPL-P5M4','p1','UPL-T2POL','ACT-1',-1,'2026-08-12','UPL-T5O','USER-1','UPL-CMD1')"
assert_rejects "commercial T3 §D: a correction with a whitespace-only reason (a signed delta nobody justified)" \
  "INSERT INTO \"Measurement\"(\"id\",\"projectId\",\"labourPoLineId\",\"activityId\",\"quantity\",\"correctsId\",\"reason\",\"measuredOn\",\"citedOutputId\",\"takenById\",\"sourceCommandId\") VALUES('UPL-P5M3','p1','UPL-T2POL','ACT-1',-1,'UPL-P5M0',E' \t\n','2026-08-12','UPL-T5O','USER-1','UPL-CMD1')"
# round-3 — the correction floor walks a row's DIRECT children only, so a chain would let a second
# correction erase evidence the first already accounted for. `UPL-P5M0C` is itself a correction.
assert_rejects "commercial T3 §D: a correction targeting ANOTHER correction (chain trigger)" \
  "INSERT INTO \"Measurement\"(\"id\",\"projectId\",\"labourPoLineId\",\"activityId\",\"quantity\",\"correctsId\",\"reason\",\"measuredOn\",\"citedOutputId\",\"takenById\",\"sourceCommandId\") VALUES('UPL-P5M5','p1','UPL-T2POL','ACT-1',-1,'UPL-P5M0C','correcting the correction','2026-08-12','UPL-T5O','USER-1','UPL-CMD1')"
# §D — a measurement is FULLY immutable: no lifecycle stamp, no edit, no delete
assert_rejects "commercial T3 §D: editing a taken measurement's quantity (immutability trigger)" \
  "UPDATE \"Measurement\" SET \"quantity\"=99 WHERE \"id\"='UPL-P5M0'"
assert_rejects "commercial T3 §D: DELETING a measurement (a correction is a NEW row, never an erasure)" \
  "DELETE FROM \"Measurement\" WHERE \"id\"='UPL-P5M0'"
assert_rejects "commercial T3 §D: a measurement citing ANOTHER project's activity (same-project composite FK)" \
  "INSERT INTO \"Measurement\"(\"id\",\"projectId\",\"labourPoLineId\",\"activityId\",\"quantity\",\"measuredOn\",\"citedOutputId\",\"takenById\",\"sourceCommandId\") VALUES('UPL-P5M6','p2','UPL-T2POL','ACT-1',1,'2026-08-12','UPL-T5O','USER-1','UPL-CMD1')"
# round-4 — the cited output must belong to the MEASURING activity. `UPL-T5O` is recorded against
# ACT-1; naming ACT-2 while citing it is a measurement resting on another activity's progress.
$PSQL >/dev/null -c "INSERT INTO \"Activity\"(\"id\",\"projectId\",\"name\",\"zone\",\"plannedStart\",\"plannedEnd\",\"status\",\"progressPct\",\"gateMaterial\") VALUES('ACT-P5T3','p1','Second activity','Hall',0,5,'done',100,'na')" 2>/dev/null
assert_rejects "commercial T3 §D: a measurement whose cited OUTPUT belongs to another activity (identity FK)" \
  "INSERT INTO \"Measurement\"(\"id\",\"projectId\",\"labourPoLineId\",\"activityId\",\"quantity\",\"measuredOn\",\"citedOutputId\",\"takenById\",\"sourceCommandId\") VALUES('UPL-P5M7','p1','UPL-T2POL','ACT-P5T3',1,'2026-08-12','UPL-T5O','USER-1','UPL-CMD1')"
# round-4 — a correction carries its target's WHOLE work identity. `UPL-P5M0` measures UPL-T2POL on
# ACT-1; a correction naming it while describing ANOTHER line's work would apply its signed quantity
# to that other line while `netOf` counted it against the one it names.
assert_rejects "commercial T3 §D: a correction naming a target but describing ANOTHER line's work (identity FK)" \
  "INSERT INTO \"Measurement\"(\"id\",\"projectId\",\"labourPoLineId\",\"activityId\",\"quantity\",\"correctsId\",\"reason\",\"measuredOn\",\"citedOutputId\",\"takenById\",\"sourceCommandId\") VALUES('UPL-P5M8','p1','UPL-T2POL2','ACT-1',-1,'UPL-P5M0','forged','2026-08-12','UPL-T5O','USER-1','UPL-CMD1')"
echo ""
if [ "$FAIL" = "0" ]; then
  echo "UPGRADE PROOF PASSED: all Phase 1 migrations applied over the legacy fixture and every legacy meaning survived."
else
  echo "UPGRADE PROOF FAILED: see the assertions above."
fi
exit $FAIL
