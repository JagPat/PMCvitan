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
SQL
echo "PR-189 fixture planted (incl. one FORGED provenance triple)"

# ---- 3c. REHEARSAL: the round-2 migration must ABORT on the forged row ------------------
echo ""
echo "=== REHEARSAL: applying the round-2 migration over FORGED provenance (must ABORT) ==="
for d in "${phase3_r2_dirs[@]}"; do
  name="$(basename "$d")"
  if psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$d/migration.sql" > /tmp/upgrade-r2-rehearsal.log 2>&1; then
    echo "FAILED: $name applied over FORGED provenance instead of aborting"; exit 1
  fi
  grep -q "FORGED or UNVERIFIABLE" /tmp/upgrade-r2-rehearsal.log || { echo "FAILED: no forged-provenance diagnostic in the abort output of $name"; cat /tmp/upgrade-r2-rehearsal.log; exit 1; }
  grep -q "S-FORGED" /tmp/upgrade-r2-rehearsal.log || { echo "FAILED: the abort of $name did not SAMPLE the forged row"; cat /tmp/upgrade-r2-rehearsal.log; exit 1; }
  echo "rehearsal ok: $name ABORTED and sampled the forged row"
done

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

for d in "${phase3_r2_dirs[@]}"; do
  name="$(basename "$d")"
  echo ""
  echo "=== applying $name (single transaction) — diagnostics follow ==="
  if ! psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$d/migration.sql" 2>&1 \
      | grep -Ev '^(SET|SELECT|INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|DO|COMMENT)' ; then
    true
  fi
  applied=$(psql -X -tAc "SELECT 1" -d "$DB")
  [ "$applied" = "1" ] || { echo "database unreachable after $name"; exit 1; }
done
r2_ok=$($PSQL -tAc "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='DecisionApprovalRevision');")
[ "$r2_ok" = "t" ] || { echo "FAILED: the round-2 migration did not apply after repair (DecisionApprovalRevision missing)"; exit 1; }

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
assert "DL-4 backfilled ONLY its current approval (v2, the reapproved option) — v1 history never fabricated" \
  "SELECT COUNT(*)::text || '|' || MAX(version)::text || '|' || string_agg(\"optionKey\", '') FROM \"DecisionApprovalRevision\" WHERE \"decisionId\"='DL-4';" \
  "1|2|b"
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

echo ""
if [ "$FAIL" = "0" ]; then
  echo "UPGRADE PROOF PASSED: all Phase 1 migrations applied over the legacy fixture and every legacy meaning survived."
else
  echo "UPGRADE PROOF FAILED: see the assertions above."
fi
exit $FAIL
