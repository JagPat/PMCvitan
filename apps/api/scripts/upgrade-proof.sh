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

# A misspelled or not-yet-defined helper used to vanish onto stderr while the run still reported
# PASSED — which is the exact failure this whole script exists to prevent, turned on itself. It
# was found the honest way: five assertions added above `assert_rejects`'s definition proved
# nothing and the proof passed anyway.
#
# The FIRST version of this guard set `FAIL=1` in the handler and did nothing at all, because bash
# invokes `command_not_found_handle` "in a separate execution environment" — a subshell — so the
# assignment never reached the parent. A guard against silent no-ops that was itself a silent
# no-op. It is a FILE now, which crosses that boundary, and the mechanism is PROVEN below rather
# than trusted.
CNF_SENTINEL="${TMPDIR:-/tmp}/upgrade-proof-missing-command.$$"
CNF_SELFTEST="${TMPDIR:-/tmp}/upgrade-proof-selftest.$$"
rm -f "$CNF_SENTINEL" "$CNF_SELFTEST"
trap 'rm -f "$CNF_SENTINEL" "$CNF_SELFTEST"' EXIT
command_not_found_handle() {
  printf 'FAILED  upgrade-proof: `%s` is not a command here — an assertion silently did nothing\n' "$1"
  # RECORD the name, not just the fact. The printf above goes to the caller's stdout, and plenty of
  # this script's callers are redirected to /dev/null — so a missing command inside one of those is
  # invisible unless the sentinel carries its own message.
  printf '%s\n' "$1" >> "$CNF_SENTINEL"
  return 127
}

# Prove the guard, in a subshell pointed at a throwaway sentinel, so the proof cannot pass while
# its own guard is broken — which is precisely how the first version shipped.
( CNF_SENTINEL="$CNF_SELFTEST"; a_command_that_does_not_exist ) >/dev/null 2>&1
if [ -e "$CNF_SELFTEST" ]; then
  printf 'ok      %s\n' "upgrade-proof: a missing command is caught and FAILS the run (the guard is proven, not assumed)"
  rm -f "$CNF_SELFTEST"
else
  printf 'FAILED  %s\n' "upgrade-proof: the missing-command guard did not fire — every assertion below could be a silent no-op"
  exit 1
fi

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
VALUES ('USER-1','p1','pmc','Legacy PMC','legacy@vitan.in','legacy-bcrypt-hash'),
       -- a SECOND person on the project. Phase 5 §I is about two people — the actor a rule refuses
       -- and the stronger authority who may excuse them — so its seals cannot be exercised against
       -- a fixture with one user, and an FK failure would masquerade as the rule firing.
       ('USER-2','p1','pmc','Legacy PMC 2','legacy2@vitan.in','legacy-bcrypt-hash-2');

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

# A material and a labour purchase-order chain on the PRE-Task-4 schema, so the §F vendor-pinning
# migration has real rows to back-fill (probe 5ax). Both roots carry a vendor; neither LINE can,
# because the columns do not exist yet — which is precisely the state the backfill exists for.
plant_pre_t4_chains() {
  echo ""
  echo "=== planting PRE-Task-4 purchase-order chains (the §F vendor-pinning backfill subjects) ==="
  # the canonical §B fingerprint for THIS chain's own trade/skill. The catalog rows use ids of
  # their own (`mason-t4`/`bar-bending-t4`) because the post-migration fixture plants `mason`/
  # `bar-bending` later, and a project-contained catalog key can only be claimed once.
  local fpd="encode(digest('lsf.v1'||chr(31)||'trade:mason-t4'||chr(31)||'skill:bar-bending-t4'||chr(31)||'shift:day','sha256'),'hex')"
  $PSQL -q <<SQL || { echo "pre-Task-4 chain planting failed"; exit 1; }
BEGIN;
-- a project of its OWN. Several assertions further down prove that a given migration WROTE NO
-- ROWS by counting a table, and rows this script plants deliberately would silently confound
-- them — a fixture that breaks an existing proof is not a fixture, it is a regression. Project
-- p3 keeps the two claims separable: those assertions exclude it by name and still mean exactly
-- what they meant before.
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES('p3','org-legacy','Pre-T4 Backfill Subject','LC','','Finishing','LC-01','01 Jan 2026','31 Dec 2026',50,30,60);
INSERT INTO "Activity"("id","projectId","name","zone","plannedStart","plannedEnd","status") VALUES('ACT-P3','p3','Pre-T4 activity','Hall',0,5,'done');
INSERT INTO "Vendor"("id","orgId","name","createdById") VALUES('UPT4-VEN','org-legacy','Pre-T4 Material Vendor','USER-1');
INSERT INTO "ProjectVendor"("id","projectId","orgId","vendorId","boundById") VALUES('UPT4-PV','p3','org-legacy','UPT4-VEN','USER-1');
INSERT INTO "ActivityRequirementRoot"("id","projectId","createdById") VALUES('UPT4-ROOT','p3','USER-1');
INSERT INTO "ActivityRequirement"("id","projectId","requirementId","revision","activityId","type","requiredQty","baseUom","requiredBy","criticality","status","createdById")
  VALUES('UPT4-AR','p3','UPT4-ROOT',1,'ACT-P3','material',100,'bag','2026-08-15','normal','open','USER-1');
INSERT INTO "MaterialRequirementSpec"("id","projectId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","specFingerprint")
  VALUES('UPT4-MS','p3','UPT4-ROOT',1,'Cement','UltraTech','OPC 53','grey','FP-UPT4');
INSERT INTO "Requisition"("id","projectId","title","status","createdById") VALUES('UPT4-REQ','p3','pre-t4','approved','USER-1');
INSERT INTO "RequisitionLine"("id","projectId","requisitionId","requirementId","revision","qty","status")
  VALUES('UPT4-RL','p3','UPT4-REQ','UPT4-ROOT',1,100,'ordered');
INSERT INTO "Rfq"("id","projectId","requisitionId","status","issuedById") VALUES('UPT4-RFQ','p3','UPT4-REQ','closed','USER-1');
INSERT INTO "VendorQuote"("id","projectId","rfqId","requisitionId","vendorId","status","validUntil","recordedById")
  VALUES('UPT4-VQ','p3','UPT4-RFQ','UPT4-REQ','UPT4-VEN','recorded','2027-01-01','USER-1');
INSERT INTO "VendorQuoteLine"("id","projectId","quoteId","requisitionLineId","requisitionId","baseRate","taxAmount","freightAmount","landedCost","quotedMake","matchesSpecification")
  VALUES('UPT4-VQL','p3','UPT4-VQ','UPT4-RL','UPT4-REQ',100,50,25,999.99,'UltraTech OPC',true);
INSERT INTO "QuoteComparison"("id","projectId","rfqId","requisitionId","status","selectedQuoteId","selectedVendorId","reason","createdById","approvedById","approvedAt")
  VALUES('UPT4-CMP','p3','UPT4-RFQ','UPT4-REQ','approved','UPT4-VQ','UPT4-VEN','ok','USER-1','USER-1',now());
INSERT INTO "PurchaseOrder"("id","projectId","vendorId","requisitionId","comparisonId","comparisonStatus","createdById")
  VALUES('UPT4-PO','p3','UPT4-VEN','UPT4-REQ','UPT4-CMP','approved','USER-1');
INSERT INTO "PurchaseOrderVersion"("id","projectId","poId","version","requisitionId","status","issuedById","issuedAt","createdById")
  VALUES('UPT4-POV','p3','UPT4-PO',1,'UPT4-REQ','issued','USER-1',now(),'USER-1');
INSERT INTO "PurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","specFingerprint","uom","purchaseUom","purchaseQty","conversionToBase","qty","rate","taxAmount","freightAmount","landedAmount","committedAmountBase")
  VALUES('UPT4-POL','p3','UPT4-POV','UPT4-RL','UPT4-REQ','UPT4-ROOT',1,'FP-UPT4','bag','bag',100,1,100,100,50,25,999.99,100);

INSERT INTO "Vendor"("id","orgId","name","createdById") VALUES('UPT4-LVEN','org-legacy','Pre-T4 Labour Supplier','USER-1');
INSERT INTO "ProjectVendor"("id","projectId","orgId","vendorId","boundById") VALUES('UPT4-LPV','p3','org-legacy','UPT4-LVEN','USER-1');
INSERT INTO "LabourTrade"("projectId","code","name","createdById") VALUES('p3','mason-t4','Mason (pre-T4)','USER-1');
INSERT INTO "LabourSkill"("projectId","code","name","createdById") VALUES('p3','bar-bending-t4','Bar Bending (pre-T4)','USER-1');
INSERT INTO "ActivityRequirementRoot"("id","projectId","createdById") VALUES('UPT4-LROOT','p3','USER-1');
INSERT INTO "ActivityRequirement"("id","projectId","requirementId","revision","activityId","type","requiredQty","baseUom","requiredBy","createdById")
  VALUES('UPT4-LAR','p3','UPT4-LROOT',1,'ACT-P3','labour',3,'person-shift','2026-08-12','USER-1');
INSERT INTO "LabourRequirementSpec"("id","projectId","requirementId","revision","tradeCode","skillCode","shift","labourSpecFingerprint")
  VALUES('UPT4-LSPEC','p3','UPT4-LROOT',1,'mason-t4','bar-bending-t4','day',$fpd);
INSERT INTO "LabourDemandSlice"("id","projectId","requirementId","revision","civilDate","personShiftQty") VALUES('UPT4-LSLICE','p3','UPT4-LROOT',1,'2026-08-12',3);
INSERT INTO "LabourRequisition"("id","projectId","title","status","createdById","approvedById","approvedAt") VALUES('UPT4-LREQ','p3','pre-t4 crew','approved','USER-1','USER-1',now());
INSERT INTO "LabourRequisitionLine"("id","projectId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","status")
  VALUES('UPT4-LRL','p3','UPT4-LREQ','UPT4-LROOT',1,'2026-08-12','day',$fpd,3,'ordered');
INSERT INTO "LabourRfq"("id","projectId","requisitionId","issuedById") VALUES('UPT4-LRFQ','p3','UPT4-LREQ','USER-1');
INSERT INTO "SupplierLabourQuote"("id","projectId","rfqId","requisitionId","vendorId","status","validUntil","recordedById") VALUES('UPT4-LQ','p3','UPT4-LRFQ','UPT4-LREQ','UPT4-LVEN','recorded','2026-12-31','USER-1');
INSERT INTO "SupplierLabourQuoteLine"("id","projectId","quoteId","requisitionLineId","requisitionId","ratePerPersonShift","shiftPremium","landedPerPersonShift","matchesSpecification") VALUES('UPT4-LQL','p3','UPT4-LQ','UPT4-LRL','UPT4-LREQ',1000,100,1100,true);
INSERT INTO "LabourQuoteComparison"("id","projectId","rfqId","requisitionId","status","selectedQuoteId","selectedVendorId","reason","createdById","approvedById","approvedAt") VALUES('UPT4-LCMP','p3','UPT4-LRFQ','UPT4-LREQ','approved','UPT4-LQ','UPT4-LVEN','ok','USER-1','USER-1',now());
INSERT INTO "LabourPurchaseOrder"("id","projectId","vendorId","requisitionId","comparisonId","comparisonStatus","createdById") VALUES('UPT4-LPO','p3','UPT4-LVEN','UPT4-LREQ','UPT4-LCMP','approved','USER-1');
INSERT INTO "LabourPurchaseOrderVersion"("id","projectId","poId","version","requisitionId","comparisonId","status","issuedById","issuedAt","createdById") VALUES('UPT4-LPOV','p3','UPT4-LPO',1,'UPT4-LREQ','UPT4-LCMP','issued','USER-1',now(),'USER-1');
INSERT INTO "LabourPurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","comparisonId","selectedQuoteId","selectedQuoteLineId")
  VALUES('UPT4-LPOL','p3','UPT4-LPOV','UPT4-LRL','UPT4-LREQ','UPT4-LROOT',1,'2026-08-12','day',$fpd,3,1000,100,3300,'UPT4-LCMP','UPT4-LQ','UPT4-LQL');
COMMIT;
SQL
  # the state the backfill exists FOR: the lines carry no pinning yet
  local unpinned
  unpinned=$($PSQL -tAc "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='PurchaseOrderLine' AND column_name='vendorId';")
  [ "$unpinned" = "0" ] || { echo "pre-Task-4 planting ran AFTER the pinning migration — the backfill proof would be vacuous"; exit 1; }
  echo "pre-Task-4 chains planted (material UPT4-POL, labour UPT4-LPOL), both lines UNPINNED"
}

# `ProjectCompany` has existed since before Phase 1 and every real project holds rows in it, so
# Phase 6's party backfill is a migration OVER EXISTING DATA — and a proof run against an empty
# table would pass while proving nothing. These two are planted on the PRE-Phase-6 schema, where
# `orgId` and `partyId` do not exist yet, which is exactly the state the backfill exists for.
# (The vendor side already has legacy subjects: `UPT4-VEN`/`UPT4-PV` are planted pre-Task-4.)
# ── Phase 6 task 4a round 1 (Codex F2) — the PARTIAL-APPLY quarantine ─────────────────────────
# A partially-applied fork of the 4a migration (or hand-minted SQL between deploys) can leave the
# 'withdrawn' enum value — and a row in it — WITHOUT the evidence columns. The migration's
# diagnostics are UNCONDITIONAL precisely so that state ABORTS the deploy instead of gaining
# NULL evidence around a row the seals are never asked to judge. Proven here by planting exactly
# that state, applying the migration EXPECTING the named abort, repairing, and letting the real
# apply proceed.
plant_and_prove_t4a_partial_apply() {
  local d="$1" out
  echo ""
  echo "=== Phase 6 4a (F2): planting the PARTIAL-APPLY state (enum value + withdrawn row, NO evidence columns) ==="
  # the enum value commits on its own (a new value is unusable inside its adding transaction)
  $PSQL -q -c "ALTER TYPE \"DecisionStatus\" ADD VALUE IF NOT EXISTS 'withdrawn';" || { echo "4a F2 plant (enum) failed"; exit 1; }
  $PSQL -q <<'SQL' || { echo "4a F2 plant (row) failed"; exit 1; }
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
VALUES ('UP4A-PARTIAL','p1','Hand-minted','Hall','pending','stone',now());
UPDATE "Decision" SET "status"='withdrawn' WHERE "id"='UP4A-PARTIAL';
SQL
  echo "=== Phase 6 4a (F2): the migration must ABORT on the evidence-less withdrawn row ==="
  if out=$(psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$d/migration.sql" 2>&1); then
    echo "FAILED  4a F2: the migration ACCEPTED a withdrawn row with no evidence (the unconditional diagnostic is gone)"
    exit 1
  fi
  if ! printf '%s' "$out" | grep -q 'incomplete withdrawal evidence'; then
    echo "FAILED  4a F2: the migration aborted, but not by the named diagnostic — got: $(printf '%s' "$out" | tail -3)"
    exit 1
  fi
  echo "ok      4a F2: abort names the evidence-less withdrawn row (UP4A-PARTIAL)"
  # operator repair per the diagnostic's remedy (re-issue/remove), then the real apply proceeds
  $PSQL -q -c "DELETE FROM \"Decision\" WHERE \"id\"='UP4A-PARTIAL';" || { echo "4a F2 repair failed"; exit 1; }

  # ── round 2 (Codex F1): the INVERSE state — a NON-withdrawn row carrying withdrawal claims.
  # A partial fork that already added the columns can leave orphan evidence on a pending row;
  # the coherence trigger fires only on future writes, so the diagnostic must quarantine it.
  echo "=== Phase 6 4a (R2-F1): planting ORPHAN withdrawal evidence on a NON-withdrawn row ==="
  $PSQL -q <<'SQL' || { echo "4a R2-F1 plant failed"; exit 1; }
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "withdrawnAt" TIMESTAMP(3);
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "withdrawnById" TEXT;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "withdrawnByName" TEXT;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "withdrawReason" TEXT;
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt","withdrawReason")
VALUES ('UP4A-ORPHAN','p1','Orphan claims','Hall','pending','stone',now(),'stray claim from a partial fork');
SQL
  echo "=== Phase 6 4a (R2-F1): the migration must ABORT on the orphaned evidence ==="
  if out=$(psql -X -v ON_ERROR_STOP=1 --single-transaction -d "$DB" -f "$d/migration.sql" 2>&1); then
    echo "FAILED  4a R2-F1: the migration ACCEPTED a non-withdrawn row carrying withdrawal evidence"
    exit 1
  fi
  if ! printf '%s' "$out" | grep -q 'carry withdrawal evidence'; then
    echo "FAILED  4a R2-F1: aborted, but not by the orphan-evidence diagnostic — got: $(printf '%s' "$out" | tail -3)"
    exit 1
  fi
  echo "ok      4a R2-F1: abort names the orphaned evidence (UP4A-ORPHAN)"
  $PSQL -q -c "DELETE FROM \"Decision\" WHERE \"id\"='UP4A-ORPHAN';" || { echo "4a R2-F1 repair failed"; exit 1; }
}

plant_pre_phase6_firms() {
  echo ""
  echo "=== planting PRE-Phase-6 directory rows (the §A party backfill subjects) ==="
  $PSQL -q <<'SQL' || { echo "pre-Phase-6 directory planting failed"; exit 1; }
BEGIN;
INSERT INTO "ProjectCompany"("id","projectId","name","kind","contactName")
  VALUES('UP6-CO1','p1','Legacy Architects','architect','A. Person');
INSERT INTO "ProjectCompany"("id","projectId","name","kind")
  VALUES('UP6-CO2','p3','Legacy Client','client');
COMMIT;
SQL
  local partied
  partied=$($PSQL -tAc "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='ProjectCompany' AND column_name='partyId';")
  [ "$partied" = "0" ] || { echo "pre-Phase-6 planting ran AFTER the party migration — the backfill proof would be vacuous"; exit 1; }
  echo "pre-Phase-6 directory rows planted (UP6-CO1 on p1, UP6-CO2 on p3), both PARTY-LESS"
}

# ---- 3f. the remaining ledger to HEAD ----------------------------------------------------
# Migrations stamped after the round-2 stop (Task 2 procurement onward) also land in
# phase3_r2_dirs; the explicit round-2/3 stops above covered exactly two of them. Apply every
# remaining one in ledger order so the proof upgrades the legacy database all the way to HEAD.
for d in "${phase3_r2_dirs[@]}"; do
  case "$(basename "$d")" in
    "$(basename "$R2_PROVENANCE")"|"$(basename "$R3_HISTORY")") continue ;;
    # ── Phase 5 Task 4 STOP — the §F vendor-pinning BACKFILL needs rows to back-fill ──────────
    # Every other fixture in this script is planted AFTER the whole ledger has run, which is the
    # right shape for hostile-insert seals but proves nothing about a migration that MIGRATES
    # EXISTING DATA. `PurchaseOrderLine`/`LabourPurchaseOrderLine` are already deployed and real
    # projects hold lines predating Task 4, so the migration must resolve each one from its own
    # version→root chain — and a proof over an empty table would pass while proving nothing.
    # These two chains are therefore planted on the PRE-Task-4 schema, where the pinning columns
    # do not exist yet, and the assertions further down read what the backfill wrote.
    20270420000000_*) plant_pre_t4_chains ;;
    # ── Phase 6 unit 6.1a STOP — the §A party BACKFILL needs directory rows to back-fill ──────
    20270801000000_*) plant_pre_phase6_firms ;;
    # ── Phase 6 task 4a STOP — the F2 partial-apply state must ABORT, then repair + real apply ─
    20270810000000_*) plant_and_prove_t4a_partial_apply "$d" ;;
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
  "SELECT ((to_regclass('\"PasswordCredentialChallenge\"') IS NOT NULL) AND (to_regclass('\"SecurityAuditEvent\"') IS NOT NULL) AND (to_regclass('\"SodException\"') IS NOT NULL) AND (to_regclass('\"SodGrant\"') IS NOT NULL))::text;" \
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
  "SELECT COUNT(*) FILTER (WHERE \"nextPosition\" = 0)::text || '/' || COUNT(*)::text FROM \"ProjectEventStream\" WHERE \"projectId\" <> 'p3';" \
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
  "SELECT (SELECT COUNT(*) FROM \"Vendor\" WHERE \"id\" NOT LIKE 'UPT4-%') + (SELECT COUNT(*) FROM \"ProjectVendor\" WHERE \"projectId\" <> 'p3') + (SELECT COUNT(*) FROM \"Requisition\" WHERE \"projectId\" <> 'p3');" \
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
  "SELECT (SELECT COUNT(*) FROM \"PurchaseOrder\" WHERE \"projectId\" <> 'p3') + (SELECT COUNT(*) FROM \"PurchaseOrderVersion\" WHERE \"projectId\" <> 'p3') + (SELECT COUNT(*) FROM \"DeliveryCommitment\" WHERE \"projectId\" <> 'p3');" \
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
# The optional third argument is an ERE the rejection message must match, and it exists because of
# Codex round 6: a fixture bound to the wrong command was rejected by the provenance trigger while
# NAMING the superseded-certificate rule, so the line stayed green with the rule it named removed.
# "Something rejected it" is not evidence for a named rule — this lets an assertion say WHICH rule
# must do the rejecting. Omitted, the check is the original one.
assert_rejects() {
  local label="$1" sql="$2" expect="${3:-}"
  local err
  if err=$($PSQL -q -c "$sql" 2>&1 >/dev/null); then
    printf 'FAILED  %s\n        (hostile insert was ACCEPTED — a correction seal is missing)\n' "$label"; FAIL=1
  elif [ -n "$expect" ] && ! printf '%s' "$err" | grep -qE "$expect"; then
    printf 'FAILED  %s\n        (rejected, but by the WRONG rule — wanted /%s/, got: %s)\n' \
      "$label" "$expect" "$(printf '%s' "$err" | tr '\n' ' ' | cut -c1-160)"; FAIL=1
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
-- Phase 6 unit 6.1a: post-migration fixture, so it carries its own party.
INSERT INTO "ExternalParty"("id","orgId","name") VALUES('pty_UP45-VEN','org-legacy','V');
INSERT INTO "Vendor"("id","orgId","name","createdById","partyId") VALUES('UP45-VEN','org-legacy','V','USER-1','pty_UP45-VEN');
INSERT INTO "ProjectVendor"("id","projectId","orgId","vendorId","boundById","partyId") VALUES('UP45-PV','p1','org-legacy','UP45-VEN','USER-1','pty_UP45-VEN');
INSERT INTO "ProjectParty"("id","orgId","projectId","partyId") VALUES('pp_UP45-VEN','org-legacy','p1','pty_UP45-VEN') ON CONFLICT DO NOTHING;
INSERT INTO "ProjectPartyVendorSource"("id","orgId","projectId","partyId","projectVendorId") VALUES('ppvs_UP45-VEN','org-legacy','p1','pty_UP45-VEN','UP45-PV');
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
-- Phase 5 Task 4 (§F) — post-migration inserts now supply the pinning columns; the two composite
-- FKs make them provable rather than merely present (they must equal this line's own version→root).
INSERT INTO "PurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","specFingerprint","uom","purchaseUom","purchaseQty","conversionToBase","qty","rate","taxAmount","freightAmount","landedAmount","committedAmountBase","purchaseOrderId","vendorId")
  VALUES('UP45-POL','p1','UP45-POV','UP45-RL','UP45-REQ','UP45-ROOT',1,'FP-UP45','bag','bag',100,1,100,100,50,25,999.99,100,'UP45-PO','UP45-VEN');
INSERT INTO "DeliveryCommitment"("id","projectId","poLineId","status","createdById") VALUES('UP45-DC','p1','UP45-POL','committed','USER-1');
-- reserved-then-completed: the receipt protocol is DB-sealed, and a directly minted succeeded
-- row is the forgery that seal refuses (20270425000000_platform_command_receipt_seal).
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  VALUES('UP45-CMD','project','org-legacy','p1','USER-1','test.up45','up45','x','reserved');
UPDATE "CommandExecution" SET "status"='succeeded', "resultRef"='UP45-LOT', "completedAt"=now() WHERE "id"='UP45-CMD';
-- reserved-then-completed: the receipt protocol is DB-sealed, and a directly minted succeeded
-- row is the forgery that seal refuses (20270425000000_platform_command_receipt_seal).
INSERT INTO "CommandExecution"("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  VALUES('UP45-CMD2','project','org-legacy','p2','USER-1','test.up45','up45b','x','reserved');
UPDATE "CommandExecution" SET "status"='succeeded', "resultRef"='UP45-LOT2', "completedAt"=now() WHERE "id"='UP45-CMD2';
INSERT INTO "StockLot"("id","projectId","poLineId","commitmentId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","baseUom","specFingerprint","receivedById")
  VALUES('UP45-LOT','p1','UP45-POL','UP45-DC','UP45-ROOT',1,'Cement','UltraTech','OPC 53','grey','bag','FP-UP45','USER-1');
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","poLineId","commitmentId","recordedById","sourceCommandId")
  VALUES('UP45-RCPT','p1','UP45-LOT','main','receipt',100,NULL,'quarantine','UP45-POL','UP45-DC','USER-1','UP45-CMD');
-- Codex round-5 — a SMALL acceptance. Without any accepted evidence at all, every §G claim path in
-- this proof could only ever end in refusal, and a seal that is never shown to ACCEPT is not shown
-- to be precise. Five units lets a 3-unit claim go legitimately live while the 10-unit claim below
-- still breaches, so both directions are proven against the same line.
INSERT INTO "Media"("id","projectId","kind","mime","sizeBytes","uploadedBy")
  VALUES('UP45-MED','p1','photo','image/jpeg',1024,'USER-1');
INSERT INTO "StockTransaction"("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","recordedById","sourceCommandId","qualityResult","evidenceMediaId")
  VALUES('UP45-ACC','p1','UP45-LOT','main','acceptance',5,'quarantine','acceptedOnHand','USER-1','UP45-CMD','pass','UP45-MED');
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
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('LabourTrade','LabourSkill','Worker','WorkerSkill','Crew','CrewMembership','LabourRequirementSpec','LabourDemandSlice'))::text || '|' || (SELECT COUNT(*) FROM \"Worker\" WHERE \"projectId\" <> 'p3')::text || '|' || (SELECT COUNT(*) FROM \"WorkerSkill\" WHERE \"projectId\" <> 'p3')::text || '|' || (SELECT COUNT(*) FROM \"LabourRequirementSpec\" WHERE \"projectId\" <> 'p3')::text || '|' || (SELECT COUNT(*) FROM \"CrewMembership\" WHERE \"projectId\" <> 'p3')::text;" \
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
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('VendorLabourProfile','LabourRequisition','LabourRequisitionLine','LabourRfq','SupplierLabourQuote','SupplierLabourQuoteLine','LabourQuoteComparison','LabourPurchaseOrder','LabourPurchaseOrderVersion','LabourPurchaseOrderLine','CapacityCommitment','CapacityPromise'))::text || '|' || (SELECT COUNT(*) FROM \"LabourRequisition\" WHERE \"projectId\" <> 'p3')::text || '|' || (SELECT COUNT(*) FROM \"LabourPurchaseOrder\" WHERE \"projectId\" <> 'p3')::text || '|' || (SELECT COUNT(*) FROM \"CapacityCommitment\" WHERE \"projectId\" <> 'p3')::text;" \
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
-- Phase 6 unit 6.1a: post-migration fixture, so it carries its own party.
INSERT INTO "ExternalParty"("id","orgId","name") VALUES('pty_UPL-T2V','org-legacy','Labour Supplier');
INSERT INTO "Vendor"("id","orgId","name","createdById","partyId") VALUES('UPL-T2V','org-legacy','Labour Supplier','USER-1','pty_UPL-T2V');
INSERT INTO "ProjectVendor"("id","projectId","orgId","vendorId","boundById","partyId") VALUES('UPL-T2PV','p1','org-legacy','UPL-T2V','USER-1','pty_UPL-T2V');
INSERT INTO "ProjectParty"("id","orgId","projectId","partyId") VALUES('pp_UPL-T2V','org-legacy','p1','pty_UPL-T2V') ON CONFLICT DO NOTHING;
INSERT INTO "ProjectPartyVendorSource"("id","orgId","projectId","partyId","projectVendorId") VALUES('ppvs_UPL-T2V','org-legacy','p1','pty_UPL-T2V','UPL-T2PV');
INSERT INTO "LabourRequisition"("id","projectId","title","status","createdById","approvedById","approvedAt") VALUES('UPL-T2REQ','p1','crew','approved','USER-1','USER-1',NOW());
INSERT INTO "LabourRequisitionLine"("id","projectId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","status") VALUES('UPL-T2RL','p1','UPL-T2REQ','UPL-F2OK',1,'2026-08-12','day',$FPD,3,'ordered');
INSERT INTO "LabourRfq"("id","projectId","requisitionId","issuedById") VALUES('UPL-T2RFQ','p1','UPL-T2REQ','USER-1');
INSERT INTO "SupplierLabourQuote"("id","projectId","rfqId","requisitionId","vendorId","status","validUntil","recordedById") VALUES('UPL-T2Q','p1','UPL-T2RFQ','UPL-T2REQ','UPL-T2V','recorded','2026-12-31','USER-1');
INSERT INTO "SupplierLabourQuoteLine"("id","projectId","quoteId","requisitionLineId","requisitionId","ratePerPersonShift","shiftPremium","landedPerPersonShift","matchesSpecification") VALUES('UPL-T2QL','p1','UPL-T2Q','UPL-T2RL','UPL-T2REQ',1000,100,1100,true);
INSERT INTO "LabourQuoteComparison"("id","projectId","rfqId","requisitionId","status","selectedQuoteId","selectedVendorId","reason","createdById","approvedById","approvedAt") VALUES('UPL-T2CMP','p1','UPL-T2RFQ','UPL-T2REQ','approved','UPL-T2Q','UPL-T2V','ok','USER-1','USER-1',NOW());
INSERT INTO "LabourPurchaseOrder"("id","projectId","vendorId","requisitionId","comparisonId","comparisonStatus","createdById") VALUES('UPL-T2PO','p1','UPL-T2V','UPL-T2REQ','UPL-T2CMP','approved','USER-1');
INSERT INTO "LabourPurchaseOrderVersion"("id","projectId","poId","version","requisitionId","comparisonId","status","issuedById","issuedAt","createdById") VALUES('UPL-T2POV','p1','UPL-T2PO',1,'UPL-T2REQ','UPL-T2CMP','issued','USER-1',NOW(),'USER-1');
INSERT INTO "LabourPurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","comparisonId","selectedQuoteId","selectedQuoteLineId","purchaseOrderId","vendorId") VALUES('UPL-T2POL','p1','UPL-T2POV','UPL-T2RL','UPL-T2REQ','UPL-F2OK',1,'2026-08-12','day',$FPD,3,1000,100,3300,'UPL-T2CMP','UPL-T2Q','UPL-T2QL','UPL-T2PO','UPL-T2V');
-- a VALID second PO line (correct quote-line provenance) left UNCOMMITTED — the clean subject for the F3 identity probe
INSERT INTO "LabourPurchaseOrderLine"("id","projectId","poVersionId","requisitionLineId","requisitionId","requirementId","revision","civilDate","shift","labourSpecFingerprint","personShiftQty","ratePerPersonShift","shiftPremium","committedAmountBase","comparisonId","selectedQuoteId","selectedQuoteLineId","purchaseOrderId","vendorId") VALUES('UPL-T2POL2','p1','UPL-T2POV','UPL-T2RL','UPL-T2REQ','UPL-F2OK',1,'2026-08-12','day',$FPD,3,1000,100,3300,'UPL-T2CMP','UPL-T2Q','UPL-T2QL','UPL-T2PO','UPL-T2V');
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
  SELECT 'UPL-CMD1','project',"orgId",'p1','USER-1','labour.allocation.allocate','upl-t3-key','upl-t3-hash','reserved' FROM "Project" WHERE "id"='p1';
UPDATE "CommandExecution" SET "status"='succeeded', "resultRef"='UPL-T3A', "completedAt"=now() WHERE "id"='UPL-CMD1';
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
# ── Phase 5 Task 4 — the §F VENDOR BILL and the §G bounds. Three additive tables upgrade ROW-FREE
#    over the legacy DB, and the vendor-pinning half MIGRATES EXISTING DATA — the only migration in
#    this phase that does. The two pre-Task-4 chains planted at the ledger stop above are its
#    subjects (probe 5ax). ──────────────────────────────────────────────────────────────────────
assert "the three Phase-5 Task-4 vendor-bill tables exist and are ROW-FREE over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name IN ('VendorBill','VendorBillVersion','VendorBillLine'))::text || '|' || (SELECT COUNT(*) FROM \"VendorBill\")::text || '|' || (SELECT COUNT(*) FROM \"VendorBillVersion\")::text || '|' || (SELECT COUNT(*) FROM \"VendorBillLine\")::text;" \
  "3|0|0|0"
# 5ax — the BACKFILL resolved every pre-existing line from its OWN version→root chain, and invented
# nothing: each line's pinned order is its version's order and its pinned vendor is that order's.
assert "§F the vendor-pinning backfill resolved EVERY pre-existing purchase-order line from its own chain" \
  "SELECT (SELECT COUNT(*) FROM \"PurchaseOrderLine\" l JOIN \"PurchaseOrderVersion\" v ON v.\"projectId\"=l.\"projectId\" AND v.\"id\"=l.\"poVersionId\" JOIN \"PurchaseOrder\" p ON p.\"projectId\"=v.\"projectId\" AND p.\"id\"=v.\"poId\" WHERE l.\"purchaseOrderId\" <> v.\"poId\" OR l.\"vendorId\" <> p.\"vendorId\")::text || '|' || (SELECT COUNT(*) FROM \"LabourPurchaseOrderLine\" l JOIN \"LabourPurchaseOrderVersion\" v ON v.\"projectId\"=l.\"projectId\" AND v.\"id\"=l.\"poVersionId\" JOIN \"LabourPurchaseOrder\" p ON p.\"projectId\"=v.\"projectId\" AND p.\"id\"=v.\"poId\" WHERE l.\"purchaseOrderId\" <> v.\"poId\" OR l.\"vendorId\" <> p.\"vendorId\")::text;" \
  "0|0"
assert "§F the two BACKFILLED lines carry exactly the vendor their order names" \
  "SELECT (SELECT \"vendorId\" FROM \"PurchaseOrderLine\" WHERE \"id\"='UPT4-POL') || '|' || (SELECT \"purchaseOrderId\" FROM \"PurchaseOrderLine\" WHERE \"id\"='UPT4-POL') || '|' || (SELECT \"vendorId\" FROM \"LabourPurchaseOrderLine\" WHERE \"id\"='UPT4-LPOL') || '|' || (SELECT \"purchaseOrderId\" FROM \"LabourPurchaseOrderLine\" WHERE \"id\"='UPT4-LPOL');" \
  "UPT4-VEN|UPT4-PO|UPT4-LVEN|UPT4-LPO"
assert "§F the pinning columns are NOT NULL and both chain-sealing FK pairs are installed" \
  "SELECT (SELECT COUNT(*) FROM information_schema.columns WHERE table_name IN ('PurchaseOrderLine','LabourPurchaseOrderLine') AND column_name IN ('vendorId','purchaseOrderId') AND is_nullable='NO')::text || '|' || (SELECT COUNT(*) FROM pg_constraint WHERE conname IN ('PurchaseOrderLine_version_order_fkey','PurchaseOrderLine_order_vendor_fkey','LabourPurchaseOrderLine_version_order_fkey','LabourPurchaseOrderLine_order_vendor_fkey'))::text;" \
  "4|4"
assert "§F/§G the bill seals + the DEFERRED bound triggers are installed on all five firing sites" \
  "SELECT (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('VendorBill_lifecycle','VendorBillVersion_append_only','VendorBillLine_append_only') AND NOT tgisinternal)::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('VendorBillLine_bound_sealed','VendorBillVersion_lines_sealed','VendorBill_bound_sealed','StockTransaction_billed_bound_sealed','Measurement_billed_bound_sealed','PurchaseOrderVersion_billed_bound_sealed','LabourPurchaseOrderVersion_billed_bound_sealed') AND tgdeferrable AND tginitdeferred)::text || '|' || (SELECT COUNT(*) FROM pg_indexes WHERE indexname IN ('VendorBill_live_document_key','VendorBillVersion_one_current_key'))::text;" \
  "3|7|2"

# A COHERENT claim FIRST — a draft bill, its v1 and one material line against the legacy `UP45-POL`
# order, whose vendor `UP45-VEN` it names. This is what makes every rejection below attributable:
# each hostile row differs from this ACCEPTED one in exactly the one respect its label names. A
# rejection is only evidence when an otherwise-identical case is accepted.
$PSQL >/dev/null <<SQL && printf 'ok      %s\n' "commercial T4 §F: a coherent vendor claim (bill + version + line) is accepted (seals are precise)" || { printf 'FAILED  %s\n' "commercial T4 §F coherent claim rejected"; FAIL=1; }
BEGIN;
INSERT INTO "VendorBill"("id","projectId","vendorId","vendorBillNumber","documentDate","status","createdById","sourceCommandId")
  VALUES('UPT4-B1','p1','UP45-VEN','INV-001','2026-08-20','draft','USER-1','UP45-CMD');
INSERT INTO "VendorBillVersion"("id","projectId","billId","vendorIdPin","version","claimedAmount","lineCount","createdById")
  VALUES('UPT4-BV1','p1','UPT4-B1','UP45-VEN',1,10.00,1,'USER-1');
INSERT INTO "VendorBillLine"("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
  VALUES('UPT4-BL1','p1','UPT4-BV1','UPT4-B1','UP45-VEN','material','UP45-POL',10,1,0,0,10.00);
COMMIT;
SQL
# §F vendor pinning (probes 5f/5ao) — WITHIN one project, Vendor A's claim cannot name Vendor B's
# order line. A same-project FK alone would only stop a cross-PROJECT line.
# ── the RECEIPT PROTOCOL, database-enforced (20270425000000) ───────────────────────────────────
# Fifteen `sourceCommandId` columns cite this table to answer "which command produced this fact".
# Every one of those provenance seals is exactly as strong as the receipt behind it, and until
# this migration a receipt could simply be minted already `succeeded` with a chosen `resultRef`.
assert "the receipt-protocol trigger is installed" \
  "SELECT COUNT(*) FROM pg_trigger WHERE tgname='CommandExecution_receipt_protocol' AND NOT tgisinternal;" \
  "1"
assert_rejects "platform: MINTING a receipt already \`succeeded\` (a command that never ran, usable as provenance for anything)" \
  "INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\",\"resultRef\",\"completedAt\") VALUES('UPCR-FORGE','project','org-legacy','p1','USER-1','commercial.bill.verify','upcr-forge','x','succeeded','FORGED-RESULT',now())"
assert_rejects "platform: a RESERVED receipt pre-loaded with a result (a result before the command ran)" \
  "INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\",\"resultRef\") VALUES('UPCR-PRE','project','org-legacy','p1','USER-1','test.upcr','upcr-pre','x','reserved','FORGED-RESULT')"
# …and the HONEST protocol is accepted, so the seal is precise rather than merely strict
# the honest protocol — reserve and complete in ONE transaction, exactly as `executeCommand` does
$PSQL >/dev/null -c "BEGIN; INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UPCR-OK','project','org-legacy','p1','USER-1','test.upcr','upcr-ok','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='REAL-RESULT', \"completedAt\"=now() WHERE \"id\"='UPCR-OK'; COMMIT;" \
  && printf 'ok      %s\n' "platform: reserve -> succeeded with a result, in ONE transaction, is ACCEPTED (the seal enforces the protocol, it does not forbid it)" \
  || { printf 'FAILED  %s\n' "platform: the honest reserve/complete protocol was rejected"; FAIL=1; }
assert_rejects "platform: RE-POINTING a completed receipt's result (a re-pointable receipt is a re-pointable provenance chain)" \
  "UPDATE \"CommandExecution\" SET \"resultRef\"='OTHER-RESULT' WHERE \"id\"='UPCR-OK'"
assert_rejects "platform: re-opening a COMPLETED receipt" \
  "UPDATE \"CommandExecution\" SET \"status\"='failed' WHERE \"id\"='UPCR-OK'"
assert_rejects "platform: re-pointing a receipt's COMMAND TYPE after the fact (identity is who did what)" \
  "UPDATE \"CommandExecution\" SET \"commandType\"='commercial.bill.verify' WHERE \"id\"='UPCR-OK'"
$PSQL >/dev/null -c "INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UPCR-NOTIME','project','org-legacy','p1','USER-1','test.upcr','upcr-notime','x','reserved')" 2>/dev/null
assert_rejects "platform: completing a receipt with no completion time (a terminal receipt records WHEN)" \
  "UPDATE \"CommandExecution\" SET \"status\"='succeeded' WHERE \"id\"='UPCR-NOTIME'"
assert_rejects "platform: a FAILED receipt carrying a result (provenance for something that did not happen)" \
  "UPDATE \"CommandExecution\" SET \"status\"='failed', \"resultRef\"='X', \"completedAt\"=now() WHERE \"id\"='UPCR-NOTIME'"
# Codex round-1 on this PR — reserve in one transaction and complete in another is a protocol
# violation: Phase 2 states the reserve/execute/receipt sequence is ONE transaction, so a
# completion arriving later did not come from a command run.
assert_rejects "platform: ADOPTING a stale reserved receipt from a later transaction (a completion that came from no command run)" \
  "UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='FORGED', \"completedAt\"=now() WHERE \"id\"='UPCR-NOTIME'"

assert_rejects "commercial T4 §F: a claim line naming ANOTHER vendor's purchase-order line in the SAME project (composite FK)" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"poLineId\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-X1','p1','UPT4-BV1','UPT4-B1','UP45-VEN','material','UPT4-POL',1,1,0,0,1)"
# §F/probe 5bf — EXACTLY ONE target, and the discriminator must agree with it
assert_rejects "commercial T4 §F: a claim line with NEITHER PO-line reference (no §G bound could run)" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-X2','p1','UPT4-BV1','UPT4-B1','UP45-VEN','material',1,1,0,0,1)"
assert_rejects "commercial T4 §F: a claim line with BOTH references (the fold owner would be ambiguous)" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"poLineId\",\"labourPoLineId\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-X3','p1','UPT4-BV1','UPT4-B1','UP45-VEN','material','UP45-POL','UPL-T2POL',1,1,0,0,1)"
assert_rejects "commercial T4 §F: a claim line whose type disagrees with the reference present" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"poLineId\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-X4','p1','UPT4-BV1','UPT4-B1','UP45-VEN','labour','UP45-POL',1,1,0,0,1)"
# §0b sign discipline, PER COLUMN — a credit is a separate document, not a negative claim line
assert_rejects "commercial T4 §0b: a ZERO-quantity claim line (it claims nothing)" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"poLineId\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-X5','p1','UPT4-BV1','UPT4-B1','UP45-VEN','material','UP45-POL',0,1,0,0,0)"
assert_rejects "commercial T4 §0b: a NEGATIVE-quantity claim line (Phase 5 has no credit note)" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"poLineId\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-X6','p1','UPT4-BV1','UPT4-B1','UP45-VEN','material','UP45-POL',-1,1,0,0,-1)"
assert_rejects "commercial T4 §0b: a NEGATIVE tax amount on a claim line" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"poLineId\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-X7','p1','UPT4-BV1','UPT4-B1','UP45-VEN','material','UP45-POL',1,1,-1,0,0)"
# §A — the money a fold reads is always the money the line's own components make
assert_rejects "commercial T4 §A: a hand-written claim amount that its own components do not make" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"poLineId\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-X8','p1','UPT4-BV1','UPT4-B1','UP45-VEN','material','UP45-POL',1,1,0,0,999)"
# probe 5au — a LABOUR claim line carries no tax or freight: the labour PO snapshot freezes none
$PSQL >/dev/null -c "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"createdById\",\"sourceCommandId\") VALUES('UPT4-B2','p1','UPL-T2V','LAB-001','2026-08-20','draft','USER-1','UP45-CMD')" 2>/dev/null
$PSQL >/dev/null -c "INSERT INTO \"VendorBillVersion\"(\"id\",\"projectId\",\"billId\",\"vendorIdPin\",\"version\",\"claimedAmount\",\"lineCount\",\"createdById\") VALUES('UPT4-BV2','p1','UPT4-B2','UPL-T2V',1,1000.00,1,'USER-1')" 2>/dev/null
assert_rejects "commercial T4 §E: a LABOUR claim line carrying tax (the ordered snapshot freezes none to verify it against)" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"labourPoLineId\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-X9','p1','UPT4-BV2','UPT4-B2','UPL-T2V','labour','UPL-T2POL',1,1000,5,0,1005)"
# §0b/probe 5bg — the duplicate-claim KEY: non-blank, frozen, and unique among LIVE claims
assert_rejects "commercial T4 §0b: a whitespace-only vendor bill number (the duplicate-claim key)" \
  "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"createdById\",\"sourceCommandId\") VALUES('UPT4-XB1','p1','UP45-VEN',E' \t\n','2026-08-20','draft','USER-1','UP45-CMD')"
assert_rejects "commercial T4 §F: EDITING a vendor bill number after write (the key that groups claims is FROZEN)" \
  "UPDATE \"VendorBill\" SET \"vendorBillNumber\"='INV-999' WHERE \"id\"='UPT4-B1'"
assert_rejects "commercial T4 §F: a SECOND live claim under the same (project, vendor, document number)" \
  "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"createdById\",\"sourceCommandId\") VALUES('UPT4-XB2','p1','UP45-VEN','INV-001','2026-08-21','draft','USER-1','UP45-CMD')"
# §F — a disputed claim is corrected by a NEW version, never revived; a terminal one stays terminal
assert_rejects "commercial T4 §F: reviving a claim from a state the lifecycle does not leave (draft -> certified)" \
  "UPDATE \"VendorBill\" SET \"status\"='certified' WHERE \"id\"='UPT4-B1'"
assert_rejects "commercial T4 §F: DISPUTING a claim with no reason (leaving the live set is never unexplained)" \
  "UPDATE \"VendorBill\" SET \"status\"='disputed' WHERE \"id\"='UPT4-B1'"
# §F — the claim itself is evidence: immutable rows, never deleted
assert_rejects "commercial T4 §F: EDITING a recorded claim line (the vendor's claim is corrected by a new version)" \
  "UPDATE \"VendorBillLine\" SET \"quantity\"=99 WHERE \"id\"='UPT4-BL1'"
assert_rejects "commercial T4 §F: DELETING a recorded claim line" \
  "DELETE FROM \"VendorBillLine\" WHERE \"id\"='UPT4-BL1'"
assert_rejects "commercial T4 §F: DELETING a claim version (an amendment RETAINS the prior verbatim)" \
  "DELETE FROM \"VendorBillVersion\" WHERE \"id\"='UPT4-BV1'"
assert_rejects "commercial T4 §F: DELETING a vendor bill (a claim that was made is history)" \
  "DELETE FROM \"VendorBill\" WHERE \"id\"='UPT4-B1'"
assert_rejects "commercial T4 §F: a claim naming ANOTHER project's purchase-order line (tenancy composite FK)" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"poLineId\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-X10','p2','UPT4-BV1','UPT4-B1','UP45-VEN','material','UP45-POL',1,1,0,0,1)"
# §G — the DEFERRED bound seal. `UP45-POL` orders 100 and has NOTHING accepted, so making this
# claim LIVE breaches bound 2 at COMMIT. This is the seal in the direction a BEFORE trigger cannot
# reach: the line was inserted while the bill was `draft`, and only the transition makes it live.
assert_rejects "commercial T4 §G: making a claim LIVE beyond the accepted evidence behind it (deferred bound seal)" \
  "UPDATE \"VendorBill\" SET \"status\"='submitted' WHERE \"id\"='UPT4-B1'"
# §F — a live version must state the money ITS OWN lines make, and must HAVE lines
assert_rejects "commercial T4 §F: a claim version with no line at all (a claim for nothing no bound can check)" \
  "INSERT INTO \"VendorBillVersion\"(\"id\",\"projectId\",\"billId\",\"vendorIdPin\",\"version\",\"claimedAmount\",\"lineCount\",\"createdById\") VALUES('UPT4-XV1','p1','UPT4-B2','UPL-T2V',2,50.00,1,'USER-1')"
# ── Codex round-1 findings, sealed at PostgreSQL ─────────────────────────────────────────────
# F2 — the reason a claim LEFT the live fold is evidence, so it is frozen once it explains the exit
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='rejected', \"statusReason\"='wrong purchase order' WHERE \"id\"='UPT4-B1'" 2>/dev/null
assert_rejects "commercial T4 F2: REWRITING a claim's exit reason after the transition that set it" \
  "UPDATE \"VendorBill\" SET \"statusReason\"='a different story' WHERE \"id\"='UPT4-B1'"
# F4 — a recorded version's LINE SET is closed. The exploit is a ZERO-money line: `claimedAmount`
# still equals the line total, so the money check passes while QUANTITY enters `BILLED_QTY`.
assert_rejects "commercial T4 F4: APPENDING a zero-money claim line to an already-recorded version" \
  "INSERT INTO \"VendorBillLine\"(\"id\",\"projectId\",\"versionId\",\"billId\",\"vendorId\",\"type\",\"poLineId\",\"quantity\",\"rate\",\"taxAmount\",\"freightAmount\",\"amount\") VALUES('UPT4-F4','p1','UPT4-BV1','UPT4-B1','UP45-VEN','material','UP45-POL',50,0,0,0,0)"
# F3 — the supersession stamp is the evidence for the ONE permitted amendment transition
assert_rejects "commercial T4 F3: PRE-FILLING a supersession reason on a still-current version" \
  "UPDATE \"VendorBillVersion\" SET \"supersedeReason\"='pre-filled' WHERE \"id\"='UPT4-BV1'"
assert_rejects "commercial T4 F3: stamping the ONLY version superseded with no replacement (a bill with no current version)" \
  "UPDATE \"VendorBillVersion\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='no replacement' WHERE \"id\"='UPT4-BV1'"
# ── Codex round-2 findings, sealed at PostgreSQL ─────────────────────────────────────────────
# R2-F1 — the line-set seal is only a seal if its OWN evidence is frozen
assert_rejects "commercial T4 R2-F1: EDITING lineCount, the evidence that closes a version's line set" \
  "UPDATE \"VendorBillVersion\" SET \"lineCount\"=2 WHERE \"id\"='UPT4-BV1'"
# R2-F3 — Task 4 owns the arrows up to `under-verification`; the rest wait for their evidence
# Codex round-3 F3 — a claim is CREATED at draft and walks its arrows; this fixture used to insert
# straight at `under-verification`, and the new creation guard correctly refuses that. Walking the
# arrows is also a better fixture: it exercises the transitions this task owns on the way in.
# Codex round-5 F1 — a LIVE bill must STATE something, so this fixture now carries the version and
# line it always implied. It claims 3 of the 5 accepted units, which is what lets it walk the arrows
# below at all: the deferred seal checks the bound on every transition into a live state.
$PSQL >/dev/null <<SQL
BEGIN;
INSERT INTO "VendorBill"("id","projectId","vendorId","vendorBillNumber","documentDate","status","createdById","sourceCommandId")
  VALUES('UPT4-B3','p1','UP45-VEN','INV-003','2026-08-22','draft','USER-1','UP45-CMD');
INSERT INTO "VendorBillVersion"("id","projectId","billId","vendorIdPin","version","claimedAmount","lineCount","createdById")
  VALUES('UPT4-BV3','p1','UPT4-B3','UP45-VEN',1,3.00,1,'USER-1');
INSERT INTO "VendorBillLine"("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
  VALUES('UPT4-BL3','p1','UPT4-BV3','UPT4-B3','UP45-VEN','material','UP45-POL',3,1,0,0,3.00);
COMMIT;
SQL
# R5-F1 — a bill with NO current version cannot enter a live state at all: the seal used to iterate
# an empty set and pass, leaving a live claim that said nothing while holding the document number.
assert_rejects "commercial T4 R5-F1/R6-F2: CREATING a bill with no claim version at all (a claim that states nothing is not a claim in ANY state)" \
  "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"createdById\",\"sourceCommandId\") VALUES('UPT4-BE','p1','UP45-VEN','INV-EMPTY','2026-08-26','draft','USER-1','UP45-CMD')"
assert_rejects "commercial T4 R6-F3: PRE-LOADING an exit reason at creation (a justification written before anything was decided)" \
  "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"statusReason\",\"createdById\",\"sourceCommandId\") VALUES('UPT4-BP','p1','UP45-VEN','INV-PRE','2026-08-26','draft','pre-loaded','USER-1','UP45-CMD')"
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='submitted', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'" 2>/dev/null
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='under-verification', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'" 2>/dev/null
# Task 5A — the §E verdict now EXISTS, so the arrow whose safety is that verdict opens. This
# assertion is inverted deliberately, and its Task-4 label said so in advance: "whose safety is the
# §E verdict Task 5 ships". A seal is only correct while the evidence behind it is absent.
# …but ONLY behind the verdict that makes it safe. `verified` is the SHADOW of a matched §E verdict
# over the CURRENT claim version, so the bare status update is refused first.
assert_rejects "commercial T5A §E: marking a claim VERIFIED with no §E verdict recorded (a status is not a verdict)" \
  "UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'"
# A verdict is only a verdict if `commercial.bill.verify` produced it, so the fixture needs a command
# of that type — `UP45-CMD` is a `test.up45` row, and the provenance seal correctly refuses it.
# The fixture receipts follow the PROTOCOL — reserved and completed in ONE transaction, carrying
# a result — because the platform seal (20270425000000) now refuses anything else. That is the
# floor this §E provenance seal rests on, and building the fixture through it is what makes the
# assertions below about §E rather than about the floor.
$PSQL >/dev/null -c "BEGIN; INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UPT5A-CMDX','project','org-legacy','p1','USER-1','commercial.bill.verify','upt5a-elsewhere','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='SOME-OTHER-ENTITY', \"completedAt\"=now() WHERE \"id\"='UPT5A-CMDX'; COMMIT;" 2>/dev/null
$PSQL >/dev/null -c "BEGIN; INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UPT5A-CMD','project','org-legacy','p1','USER-1','commercial.bill.verify','upt5a-verify','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='UPT5A-V1', \"completedAt\"=now() WHERE \"id\"='UPT5A-CMD'; COMMIT;" 2>/dev/null
$PSQL >/dev/null -c "INSERT INTO \"BillVerification\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"verdict\",\"verifiedById\",\"sourceCommandId\") VALUES('UPT5A-VX','p1','UPT4-B3','UPT4-BV3','matched','USER-1','UP45-CMD')" 2>/dev/null
assert_rejects "commercial T5A §E: a verdict whose source command is NOT commercial.bill.verify cannot license VERIFIED (provenance, not mere presence)" \
  "UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'"
# Codex round-4 — the command must have PRODUCED this verdict, not merely be of the right type.
# `UPT5A-CMDX` is a perfectly well-formed verify receipt: reserved and completed in one transaction,
# carrying a real result. It simply produced something that is not this verdict, and `resultRef` is
# the binding, so the deferred half of the seal refuses at COMMIT.
$PSQL >/dev/null -c "INSERT INTO \"BillVerification\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"verdict\",\"verifiedById\",\"sourceCommandId\") VALUES('UPT5A-VE','p1','UPT4-B3','UPT4-BV3','matched','USER-1','UPT5A-CMDX')" 2>/dev/null
assert_rejects "commercial T5A R4-F3: a verify-TYPED command that did not produce this verdict cannot license VERIFIED (resultRef, not just commandType)" \
  "UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'"
$PSQL >/dev/null -c "DELETE FROM \"BillVerification\" WHERE \"id\"='UPT5A-VE'" 2>/dev/null
$PSQL >/dev/null -c "INSERT INTO \"BillVerification\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"verdict\",\"verifiedById\",\"sourceCommandId\") VALUES('UPT5A-V1','p1','UPT4-B3','UPT4-BV3','matched','USER-1','UPT5A-CMD')" 2>/dev/null
assert_rejects "commercial T5A R4-F3: a SECOND verdict citing a command that already produced one (one command, one verdict)" \
  "INSERT INTO \"BillVerification\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"verdict\",\"verifiedById\",\"sourceCommandId\") VALUES('UPT5A-V2','p1','UPT4-B3','UPT4-BV3','matched','USER-1','UPT5A-CMD')"
assert_rejects "commercial T5A §E: EDITING a recorded verdict (a rewritable verdict is no verdict)" \
  "UPDATE \"BillVerification\" SET \"verdict\"='exception' WHERE \"id\"='UPT5A-V1'"
assert_rejects "commercial T5A §E: a MATCHED verdict carrying exceptions (a verdict that says both is not a verdict)" \
  "INSERT INTO \"BillVerification\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"verdict\",\"exceptions\",\"verifiedById\",\"sourceCommandId\") VALUES('UPT5A-X1','p1','UPT4-B3','UPT4-BV3','matched',ARRAY['rate-mismatch'],'USER-1','UP45-CMD')"
# Codex round-4 — the exception VOCABULARY, not merely its cardinality: §E names six kinds and each
# names its own check, so a seventh string is a defect that reads as a verdict.
assert_rejects "commercial T5A R4-F5: an exception recorded as free prose (a name with no check behind it)" \
  "INSERT INTO \"BillVerification\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"verdict\",\"exceptions\",\"verifiedById\",\"sourceCommandId\") VALUES('UPT5A-X2','p1','UPT4-B3','UPT4-BV3','exception',ARRAY['looks wrong'],'USER-1','UP45-CMD')"
assert_rejects "commercial T5A R4-F5: an exception array holding NULL (containment alone passes on NULL)" \
  "INSERT INTO \"BillVerification\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"verdict\",\"exceptions\",\"verifiedById\",\"sourceCommandId\") VALUES('UPT5A-X3','p1','UPT4-B3','UPT4-BV3','exception',ARRAY[NULL]::TEXT[],'USER-1','UP45-CMD')"
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'" \
  && printf 'ok      %s\n' "commercial T5A §E: under-verification -> VERIFIED is ACCEPTED once a MATCHED verdict stands (the seal is precise, not merely strict)" \
  || { printf 'FAILED  %s\n' "commercial T5A §E: the verified arrow was rejected behind a matched verdict"; FAIL=1; }
# …and NOT one step further. The arrows past `certified` are Task 6's, and a status whose evidence
# does not exist is a status nobody can justify.
assert_rejects "commercial T5A §F: the arrow into APPROVED-FOR-PAYMENT, whose evidence is Task 6's" \
  "UPDATE \"VendorBill\" SET \"status\"='approved-for-payment' WHERE \"id\"='UPT4-B3'"

# ── Phase 5 Task 5B — CERTIFICATION lands row-free, with its §E/§G/§I seals installed ──────────
#
# The four new tables are ADDITIVE: a legacy database that never certified anything upgrades with
# them EMPTY. That is asserted rather than assumed, and then every seal is exercised — each refusal
# paired with the coherent case it must still accept, because a refusal alone shows only that
# something is strict.
assert "Phase 5 T5B: the five certification tables EXIST after migration" \
  "SELECT ((to_regclass('\"BillCertificate\"') IS NOT NULL) AND (to_regclass('\"CertifiedAcceptanceConsumption\"') IS NOT NULL) AND (to_regclass('\"CertifiedMeasurementConsumption\"') IS NOT NULL))::text;" \
  "true"
assert "Phase 5 T5B: they upgrade ROW-FREE over the legacy fixture (a certificate is never invented)" \
  "SELECT ((SELECT COUNT(*) FROM \"BillCertificate\") + (SELECT COUNT(*) FROM \"CertifiedAcceptanceConsumption\") + (SELECT COUNT(*) FROM \"CertifiedMeasurementConsumption\") + (SELECT COUNT(*) FROM \"SodException\") + (SELECT COUNT(*) FROM \"SodGrant\"))::text;" \
  "0"
# `certified` is the SHADOW of a live certificate. With none, the arrow is refused — the same
# assertion Task 5A carried, now proving the shadow rule rather than an absent table.
assert_rejects "commercial T5B §F: the arrow into CERTIFIED with NO live certificate behind it (a status is not a fact)" \
  "UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'"
# §G bound 3 — `UPT4-B3` claims 3.00, so 4.00 is money nobody claimed
assert_rejects "commercial T5B §G bound 3: a certificate ABOVE the claim it certifies (deferred bound seal)" \
  "INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UPT5B-CB','p1','UPT4-B3','UPT4-BV3',4.00,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),'UP45-CMD')"
assert_rejects "commercial T5B §A: a ZERO-money certificate (an authority that authorises nothing)" \
  "INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UPT5B-CZ','p1','UPT4-B3','UPT4-BV3',0,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),'UP45-CMD')"
# a certificate must name a version OF THE BILL IT CERTIFIES — the composite FK, not a bare id
assert_rejects "commercial T5B §E: a certificate naming ANOTHER bill's claim version" \
  "INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UPT5B-CX','p1','UPT4-B3','UPT4-BV1',1.00,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),'UP45-CMD')"
assert_rejects "commercial T5B §F: a HALF-STAMPED supersession (unattributable history)" \
  "INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"supersededAt\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UPT5B-CH','p1','UPT4-B3','UPT4-BV3',3.00,(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),now(),'USER-1','UP45-CMD')"
# …and the coherent certificate is ACCEPTED, so every refusal above is about ITS OWN rule
# The certificate and the bill STATUS move TOGETHER — the round-1 projection seal. Each `psql -c`
# is its own transaction, so the coherent case is written as ONE transaction; a fixture that left
# the status behind would be building exactly the incoherence the seal exists to refuse.
# The COMPLETE coherent act, in ONE transaction: the certificate, the EVIDENCE it rests on, and the
# status projection. Round 2 added the certificate-side completeness seal, so a certificate that
# freezes nothing is refused however it is written — and §I refuses one certified by the actor who
# RECORDED that evidence unless an exception names them, so `USER-2` certifies what `USER-1`
# accepted. Every refusal below is therefore about ITS OWN rule rather than about a missing piece.
$PSQL >/dev/null -c "BEGIN; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UPT5B-C1','p1','UPT4-B3','UPT4-BV3',3.00,'USER-2',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),'UP45-CMD'); INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-A2','p1','UPT5B-C1','UP45-ACC',3); UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'; COMMIT;" \
  && printf 'ok      %s\n' "commercial T5B §G/§F/§E: a certificate AT the claimed amount, with its frozen evidence and its status projection, is ACCEPTED (every seal precise, not merely strict)" \
  || { printf 'FAILED  %s\n' "commercial T5B §G: a coherent certificate was rejected"; FAIL=1; }

# ── Phase 5 Task 5C (§H) — the deduction ledger, asserted against the LIVE certificate above ──
#
# It is anchored HERE, and that placement is the point. The first spelling of this block sat at the
# end of the script and named a certificate id nothing ever created, so every "rejected" line was
# rejected by the FOREIGN KEY before reaching the CHECK it claimed to test — the assertions would
# have passed with every constraint dropped. A rejection is evidence only when it comes from the
# rule it names, which is why each group below ACCEPTS a coherent row first, and why the certificate
# these rest on is asserted live rather than assumed.
assert "commercial T5C: both ledger tables exist" \
  "SELECT ((to_regclass('\"BillDeduction\"') IS NOT NULL) AND (to_regclass('\"BillDeductionRelease\"') IS NOT NULL))::text;" \
  "true"
assert "commercial T5C: a legacy database upgrades with an EMPTY ledger — no withholding is invented" \
  "SELECT (SELECT COUNT(*) FROM \"BillDeduction\")::text || '/' || (SELECT COUNT(*) FROM \"BillDeductionRelease\")::text;" \
  "0/0"
assert "commercial T5C: the certificate these assertions rest on is LIVE and its claim is certified" \
  "SELECT (SELECT COUNT(*) FROM \"BillCertificate\" WHERE \"id\"='UPT5B-C1' AND \"supersededAt\" IS NULL)::text || '|' || (SELECT \"status\" FROM \"VendorBill\" WHERE \"id\"='UPT4-B3');" \
  "1|certified"
# Codex round 3 — a ledger row records the command that PRODUCED it, so these assertions need
# commands of the RIGHT type. `UP45-CMD` is `test.up45`; citing it would make every rejection below
# come from the provenance seal rather than the rule it names. Reserved-then-completed, because the
# receipt protocol refuses a directly minted `succeeded` row.
#
# R5-F3 — and the command must have PRODUCED the row, so ONE command no longer backs a whole block
# of hostile inserts: each gets its own, bound to the row it is about to attempt. Without this every
# rejection below would come from the provenance seal instead of the rule it names — the exact
# vacuous-assertion shape round 2 found in this file, arriving from the other direction.
#
# The rule is one sentence for both tables — `resultRef` IS the row — so every fixture below binds
# to the id of the row it is about to attempt.
mint5c() {   # <commandId> <commandType> <resultRef>
  $PSQL >/dev/null -c "INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('$1','project','org-legacy','p1','USER-1','$2','key-$1','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='$3', \"completedAt\"=now() WHERE \"id\"='$1'"
}
mint5c UP5C-CMD   commercial.deduction.record  UP5C-DED
mint5c UP5C-RCMD  commercial.deduction.release UP5C-REL
mint5c UP5C-RCMD2 commercial.deduction.release UP5C-REL2
for row in NEG TYP NR WS OVER WT; do mint5c "UP5C-C-$row" commercial.deduction.record "UP5C-$row"; done
for row in RNEG ROVER RWS RWT; do mint5c "UP5C-C-$row" commercial.deduction.release "UP5C-$row"; done
$PSQL >/dev/null -c "INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UP5C-PEND','project','org-legacy','p1','USER-1','commercial.deduction.record','up5c-p','x','reserved')"
assert "commercial T5C: the three provenance fixtures are in the state these assertions assume" \
  "SELECT string_agg(\"status\", '/' ORDER BY \"id\") FROM \"CommandExecution\" WHERE \"id\" IN ('UP5C-CMD','UP5C-PEND','UP5C-RCMD');" \
  "succeeded/reserved/succeeded"
$PSQL >/dev/null -c "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-DED','p1','UPT5B-C1','UPT4-B3','retention',1.00,'USER-1','UP5C-CMD')" \
  && printf 'ok      %s\n' "commercial T5C: a coherent retention against a live certificate is ACCEPTED (so every rejection below is its own rule)" \
  || { printf 'FAILED  %s\n' "commercial T5C: a coherent retention was rejected — the seals are over-strict and the rejections below prove nothing"; FAIL=1; }
assert_rejects "commercial T5C: a NEGATIVE deduction (the row TYPE carries direction; a negative RAISES the payable)" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-NEG','p1','UPT5B-C1','UPT4-B3','retention',-1.00,'USER-1','UP5C-C-NEG')"
assert_rejects "commercial T5C: a deduction of an UNKNOWN type (advance-recovery ships in Task 6 with the row that caps it)" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-TYP','p1','UPT5B-C1','UPT4-B3','advance-recovery',1.00,'USER-1','UP5C-C-TYP')"
assert_rejects "commercial T5C: a PENALTY with no reason (a judgement nobody can read is not one)" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-NR','p1','UPT5B-C1','UPT4-B3','penalty',1.00,'USER-1','UP5C-C-NR')"
assert_rejects "commercial T5C: a reason of pure WHITESPACE (presence is not justification)" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"reason\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-WS','p1','UPT5B-C1','UPT4-B3','other',1.00,E' \t\n ','USER-1','UP5C-C-WS')"
assert_rejects "commercial T5C: withholding MORE than the certificate carries (the NET_PAYABLE floor)" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-OVER','p1','UPT5B-C1','UPT4-B3','retention',2.50,'USER-1','UP5C-C-OVER')"
assert_rejects "commercial T5C: EDITING a withholding (append-only; a correction is a release row)" \
  "UPDATE \"BillDeduction\" SET \"amount\"=0.5 WHERE \"id\"='UP5C-DED'"
assert_rejects "commercial T5C: DELETING a withholding (it would raise the payable with no release behind it)" \
  "DELETE FROM \"BillDeduction\" WHERE \"id\"='UP5C-DED'"
$PSQL >/dev/null -c "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-REL','p1','UP5C-DED',0.40,'partial','USER-1','UP5C-RCMD')" \
  && printf 'ok      %s\n' "commercial T5C: a coherent release within its own deduction is ACCEPTED" \
  || { printf 'FAILED  %s\n' "commercial T5C: a coherent release was rejected"; FAIL=1; }
assert_rejects "commercial T5C: a NEGATIVE release" \
  "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-RNEG','p1','UP5C-DED',-0.10,'why','USER-1','UP5C-C-RNEG')"
assert_rejects "commercial T5C: releasing MORE than its own deduction withheld" \
  "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-ROVER','p1','UP5C-DED',0.70,'too much','USER-1','UP5C-C-ROVER')"
assert_rejects "commercial T5C: a release with a WHITESPACE reason" \
  "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-RWS','p1','UP5C-DED',0.10,E' \t ','USER-1','UP5C-C-RWS')"
assert_rejects "commercial T5C: EDITING a release (append-only — it is the correction path, so it has none of its own)" \
  "UPDATE \"BillDeductionRelease\" SET \"amount\"=0.01 WHERE \"id\"='UP5C-REL'"
# ── Codex round 3, sealed at PostgreSQL ──────────────────────────────────────────────────────
# R3-3 — a ledger row records the command that PRODUCED it. Split by WHEN each half is knowable:
# the TYPE at BEFORE INSERT, the STATUS at COMMIT (a command is still `reserved` while its own
# transaction runs). This is §E's verified-provenance seal, one task along.
assert_rejects "commercial T5C R3-3: a withholding citing a command of the WRONG type (its provenance is not its own)" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-WT','p1','UPT5B-C1','UPT4-B3','retention',0.10,'USER-1','UP45-CMD')"
assert_rejects "commercial T5C R3-3: a withholding citing a command that never SUCCEEDED (a withholding nobody made)" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-PS','p1','UPT5B-C1','UPT4-B3','retention',0.10,'USER-1','UP5C-PEND')"
assert_rejects "commercial T5C R3-3: a RELEASE citing the record command rather than its own" \
  "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-RWT','p1','UP5C-DED',0.10,'wrong command','USER-1','UP5C-CMD')"
# R5-F3 — the command must have PRODUCED the row. The type check alone is satisfied by every prior
# command of that type, so a direct writer could reuse the succeeded receipt behind `UP5C-DED` to
# append a second withholding and the append-only ledger would attribute it to an act that moved no
# money. Both tables obey the same sentence.
assert_rejects "commercial T5C R5-F3: a SECOND withholding reusing the receipt that produced the first" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-REUSE','p1','UPT5B-C1','UPT4-B3','retention',0.10,'USER-1','UP5C-CMD')"
assert_rejects "commercial T5C R5-F3: a SECOND release reusing the receipt that produced the first" \
  "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-RREUSE','p1','UP5C-DED',0.10,'reused receipt','USER-1','UP5C-RCMD')"
# ── the split's load-bearing seal: a retained balance is what makes a certificate uncorrectable ──
#
# §H's rule is that a retained balance never vanishes without an attributable release. Task 5C
# honours it by REFUSING the correction rather than carrying the ledger forward (re-statement is its
# own review unit), and the whole argument for that split rests on this seal holding at PostgreSQL —
# otherwise a bypass supersession drops the money exactly as round 1's F2 described.
#
# The supersession here is the COHERENT §F shape — stamp plus the return to `verified`, in one
# transaction — so the only thing left to object to is the ₹0.60 still held. Asserted with 0.40 of
# 1.00 released, i.e. a PARTIALLY released withholding, which is the case a naive "any release at
# all" rule would wave through.
# Codex round 9 — supersession CARRIES the retained balance onto the replacement rather than
# refusing the correction, so what the database requires is the CARRY, and it is required where the
# money would otherwise vanish: the replacement certificate's own INSERT. A bare supersession is
# legal (the bill returns to `verified` and is not payable at all); it is re-certifying without
# carrying that would drop the balance. Asserted with 0.40 of 1.00 released, i.e. a PARTIALLY
# released withholding, which is the case a naive "any release at all" rule would wave through.
mint5c UP5C-CMD-NOCARRY commercial.bill.certify UPT5B-C1-NC
assert_rejects "commercial T5C R9: re-certifying WITHOUT carrying the retained balance forward" \
  "BEGIN; UPDATE \"BillCertificate\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='drops the balance' WHERE \"id\"='UPT5B-C1'; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") SELECT 'UPT5B-C1-NC',\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"=\"BillCertificate\".\"projectId\" AND r.\"billId\"=\"BillCertificate\".\"billId\"),'UP5C-CMD-NOCARRY' FROM \"BillCertificate\" WHERE \"id\"='UPT5B-C1'; INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") SELECT gen_random_uuid()::text,\"projectId\",'UPT5B-C1-NC',\"stockTransactionId\",\"consumedQty\" FROM \"CertifiedAcceptanceConsumption\" WHERE \"certificateId\"='UPT5B-C1'; COMMIT;" \
  'does not re-state'
assert "commercial T5C R9: …and the original certificate is still LIVE, so the refusal actually held" \
  "SELECT (SELECT COUNT(*) FROM \"BillCertificate\" WHERE \"id\"='UPT5B-C1' AND \"supersededAt\" IS NULL)::text || '|' || (SELECT \"status\" FROM \"VendorBill\" WHERE \"id\"='UPT4-B3');" \
  "1|certified"
# From here on the withholding is fully released, so the T5B assertions below inherit no retained
# balance — and the SAME correction they perform is then accepted, which is what makes the seal
# above precise rather than merely strict.
$PSQL >/dev/null -c "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-REL2','p1','UP5C-DED',0.60,'balance returned','USER-1','UP5C-RCMD2')" \
  && printf 'ok      %s\n' "commercial T5C: releasing the remaining balance EXACTLY is ACCEPTED (the bound is <=, not <)" \
  || { printf 'FAILED  %s\n' "commercial T5C: releasing the exact remaining balance was rejected"; FAIL=1; }
assert "commercial T5C: the withholding is now fully released, so nothing below inherits a retained balance" \
  "SELECT (d.\"amount\" - COALESCE(SUM(r.\"amount\"),0))::text FROM \"BillDeduction\" d LEFT JOIN \"BillDeductionRelease\" r ON r.\"deductionId\"=d.\"id\" WHERE d.\"id\"='UP5C-DED' GROUP BY d.\"amount\";" \
  "0.00"
# Codex round-2 P2 — a certificate that rests on NOTHING. Every row-level seal passes; only the
# certificate-side completeness check sees the absence.
assert_rejects "commercial T5B R2-F1: a certificate freezing NO evidence at all (a row seal cannot see an absence)" \
  "INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UPT5B-CE','p1','UPT4-B3','UPT4-BV3',3.00,'USER-2',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),'UP45-CMD')"
assert_rejects "commercial T5B R1-F2: a STANDALONE supersession, leaving the bill claiming to be certified" \
  "UPDATE \"BillCertificate\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='orphaned' WHERE \"id\"='UPT5B-C1'"
assert_rejects "commercial T5B R1-F2: moving the bill OFF certified while its certificate still stands" \
  "UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'"
assert_rejects "commercial T5B §F: a SECOND live certificate on one bill (bounds 3-5 read the live one)" \
  "INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UPT5B-C2','p1','UPT4-B3','UPT4-BV3',1.00,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),'UP45-CMD')"
assert_rejects "commercial T5B §F: EDITING the amount a certificate authorised" \
  "UPDATE \"BillCertificate\" SET \"certifiedAmount\"=999 WHERE \"id\"='UPT5B-C1'"
assert_rejects "commercial T5B §F: DELETING a certificate (the correction path is a superseding one)" \
  "DELETE FROM \"BillCertificate\" WHERE \"id\"='UPT5B-C1'"
# §E — the frozen evidence set. `consumedQty` must be real, and the row it names must be real too.
assert_rejects "commercial T5B §E: a consumption row naming a NONEXISTENT acceptance (identity, not a label)" \
  "INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-A0','p1','UPT5B-C1','NO-SUCH-ROW',1)"
# Codex round-1 P2 — the FK proves the row EXISTS; the seal proves it is evidence THIS claim rests
# on. A receipt is a real, in-project, same-lot stock row and is still not acceptance evidence.
assert_rejects "commercial T5B R1-F3: freezing a RECEIPT as acceptance evidence (a real row that is not evidence)" \
  "INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-AR','p1','UPT5B-C1','UP45-RCPT',1)"
assert_rejects "commercial T5B §E: a ZERO-quantity consumption row (evidence that says nothing)" \
  "INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-A1','p1','UPT5B-C1','UP45-ACC',0)"
# Codex round-2 P2 — identity is not QUANTITY. `UP45-ACC` accepted 5 units; freezing 50 of them is
# evidence that never existed, and every identity seal passes.
assert_rejects "commercial T5B R2-F3: freezing MORE of an acceptance than was ever accepted" \
  "INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-AQ','p1','UPT5B-C1','UP45-ACC',50)"
assert_rejects "commercial T5B §E: a SECOND consumption row for the same (certificate, acceptance) — double-counting" \
  "INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-A3','p1','UPT5B-C1','UP45-ACC',1)"
assert_rejects "commercial T5B §E: RESTATING how much of a row a certificate consumed" \
  "UPDATE \"CertifiedAcceptanceConsumption\" SET \"consumedQty\"=1 WHERE \"id\"='UPT5B-A2'"
assert_rejects "commercial T5B §E: DELETING the evidence a payable fact rests on" \
  "DELETE FROM \"CertifiedAcceptanceConsumption\" WHERE \"id\"='UPT5B-A2'"
# §F's ONE correction path past certification: the supersession stamp and the return to `verified`
# in ONE transaction. The `verified -> certified` arrow was already proven ACCEPTED above, by the
# transaction that created the certificate — the projection seal makes those the same act, so
# asserting it twice would be asserting a state the database no longer lets exist on its own.
$PSQL >/dev/null -c "BEGIN; UPDATE \"BillCertificate\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='restated' WHERE \"id\"='UPT5B-C1'; UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'; COMMIT;" \
  && printf 'ok      %s\n' "commercial T5B §F: supersession + certified -> verified in ONE transaction is ACCEPTED (the correction path)" \
  || { printf 'FAILED  %s\n' "commercial T5B §F: the supersession return arrow was rejected"; FAIL=1; }
assert_rejects "commercial T5B §F: REWRITING a supersession stamp (a superseded certificate is history)" \
  "UPDATE \"BillCertificate\" SET \"supersedeReason\"='rewritten' WHERE \"id\"='UPT5B-C1'"
# Codex round-5 P2 — the whole-certificate seal deliberately does not re-validate HISTORY against
# today's world, and the append path read that as "history is unguarded". What an act RESTED ON is
# not editable afterwards, and round 6 added the row lock that makes the decision serialize against
# a concurrent supersession rather than race it.
assert_rejects "commercial T5B R5-F1: EVIDENCE appended to a superseded certificate (history does not gain rows)" \
  "INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-A5','p1','UPT5B-C1','UP45-ACC',1)"
# ── §I's OVERRIDE (unit B) ─────────────────────────────────────────────────────────────────────
#
# `USER-1` recorded `UP45-ACC`, so §I refuses a certificate of theirs over it. Unit A shipped that
# refusal alone; this unit adds the NAMED exception that lets a two-person practice proceed. Both
# directions are asserted, because a seal that only refuses proves nothing about being right.
#
# Codex round-11 P2 — NO `Membership` row is created for the approver here, and that absence is the
# point. An earlier head inserted one, because the seal itself re-derived pmc standing by reading
# `Membership`/`OrgMembership` — a commercial trigger taking a synchronous read of orgs-owned
# tables. That predicate is gone: standing is decided once, by the `commercial.sod.grant` command,
# through the module that owns it. The coherent act below is ACCEPTED with the approver holding no
# membership row at all, which is the strongest evidence available that the seal no longer consults
# orgs at all — a proof by what the fixture does NOT need.
assert_rejects "commercial T5B §I: the complete act by the actor who RECORDED its evidence, with NO override" \
  "BEGIN; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UPT5B-CR','p1','UPT4-B3','UPT4-BV3',3.00,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),'UP45-CMD'); INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-CRE','p1','UPT5B-CR','UP45-ACC',3); UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'; COMMIT;"

# …and the SAME act WITH its attributable override is ACCEPTED — the seal is precise, not merely
# strict. One transaction, because §I requires the override to be written with the act it excuses,
# and (Codex round-6 P2) carrying the SAME `sourceCommandId` as the certificate.
# The seal requires the override's COMMAND RECEIPT to name the certificate it produced (round-6
# F4 / round-7 P1), so each act below gets its OWN receipt — otherwise every assertion here would be
# refused by the provenance clause and nothing would be testing the grant.
# reserved-then-completed in ONE transaction, because the receipt protocol is itself DB-sealed:
# a completion arriving in a later transaction did not come from a command run.
$PSQL >/dev/null -c "BEGIN; INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UPT5B-CMDU','project','org-legacy','p1','USER-1','commercial.bill.certify','upt5b-u','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='UPT5B-CU', \"completedAt\"=now() WHERE \"id\"='UPT5B-CMDU'; COMMIT;"
$PSQL >/dev/null -c "BEGIN; INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UPT5B-CMD4','project','org-legacy','p1','USER-1','commercial.bill.certify','upt5b-4','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='UPT5B-C4', \"completedAt\"=now() WHERE \"id\"='UPT5B-CMD4'; COMMIT;"
# Codex round-7 P1 — the override now rests on the APPROVER'S OWN act. The grant is written first
# (it is `USER-2` authorising `USER-1`), then consumed by the certificate that spends it, and the
# seal requires the two to agree on approver, actor, rule, bill and claim VERSION.
# the grant carries its OWN receipt: a `commercial.sod.grant` command by the APPROVER whose
# resultRef names it (Codex round-8 P1 — a grant is only an authority if the approver's own command
# wrote it, which is the round-7 receipt rule applied to the artifact round 7 introduced)
$PSQL >/dev/null -c "BEGIN; INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UPT5B-CMDG','project','org-legacy','p1','USER-2','commercial.sod.grant','upt5b-g','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='UPT5B-G4', \"completedAt\"=now() WHERE \"id\"='UPT5B-CMDG'; COMMIT;"
# 7B-iii-h — the grant also records the claim STATE its approver reviewed, and `verified` is the
# only state a certification proceeds from. Written here so every §I assertion below is refused by
# the seal it is NAMED for rather than by the reviewed-state seal standing in front of it.
$PSQL >/dev/null -c "INSERT INTO \"SodGrant\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"reviewedStatus\",\"reviewedLifecycleVersion\",\"sourceCommandId\") SELECT 'UPT5B-G4','p1','UPT4-B3','UPT4-BV3','evidence-recorder-may-not-certify','USER-1','USER-2','two-person practice','verified',COALESCE((SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),0),'UPT5B-CMDG' FROM \"VendorBill\" b WHERE b.\"id\"='UPT4-B3'"
assert_rejects "commercial T5B R7-F1: a certificate consuming a grant it did not spend (the override must be the approver's act, exercised HERE)" \
  "BEGIN; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UPT5B-CU','p1','UPT4-B3','UPT4-BV3',3.00,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),'UPT5B-CMDU'); INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-AU','p1','UPT5B-CU','UP45-ACC',3); INSERT INTO \"SodException\"(\"id\",\"projectId\",\"certificateId\",\"grantId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UPT5B-SU','p1','UPT5B-CU','UPT5B-G4','evidence-recorder-may-not-certify','USER-1','USER-2','two-person practice','UPT5B-CMDU'); UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'; COMMIT;"
# Codex round-11 P2 — the certify RECEIPT must be the CERTIFIER'S own. Round 8 bound the grant
# receipt to its approver and left the certify receipt bound only by type, status and result, so a
# certificate attributed to `USER-1` could rest on a command `USER-2` actually ran and the durable
# trail would name two different people for one act.
$PSQL >/dev/null -c "BEGIN; INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UPT5B-CMDX','project','org-legacy','p1','USER-2','commercial.bill.certify','upt5b-x','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='UPT5B-CX', \"completedAt\"=now() WHERE \"id\"='UPT5B-CMDX'; COMMIT;"
assert_rejects "commercial T5B R11-F2: a certificate whose certify RECEIPT was run by someone else" \
  "BEGIN; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") SELECT 'UPT5B-CX','p1','UPT4-B3','UPT4-BV3',3.00,'USER-1',COALESCE((SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),0),'UPT5B-CMDX' FROM \"VendorBill\" b WHERE b.\"id\"='UPT4-B3'; INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-AX','p1','UPT5B-CX','UP45-ACC',3); UPDATE \"SodGrant\" SET \"consumedAt\"=now(), \"consumedByCertificateId\"='UPT5B-CX' WHERE \"id\"='UPT5B-G4'; INSERT INTO \"SodException\"(\"id\",\"projectId\",\"certificateId\",\"grantId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UPT5B-SX','p1','UPT5B-CX','UPT5B-G4','evidence-recorder-may-not-certify','USER-1','USER-2','two-person practice','UPT5B-CMDX'); UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'; COMMIT;"

# Codex round-11 P2 — the override carries the APPROVER'S reason. The grant/exception match bound
# approver, actor, rule, bill and version and left `reason` free, so the one sentence a reader
# trusts was the one field the person being excused could still write.
$PSQL >/dev/null -c "BEGIN; INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UPT5B-CMDY','project','org-legacy','p1','USER-1','commercial.bill.certify','upt5b-y','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='UPT5B-CY', \"completedAt\"=now() WHERE \"id\"='UPT5B-CMDY'; COMMIT;"
assert_rejects "commercial T5B R11-F3: an override rewriting the approver's stated reason" \
  "BEGIN; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") SELECT 'UPT5B-CY','p1','UPT4-B3','UPT4-BV3',3.00,'USER-1',COALESCE((SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),0),'UPT5B-CMDY' FROM \"VendorBill\" b WHERE b.\"id\"='UPT4-B3'; INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-AY','p1','UPT5B-CY','UP45-ACC',3); UPDATE \"SodGrant\" SET \"consumedAt\"=now(), \"consumedByCertificateId\"='UPT5B-CY' WHERE \"id\"='UPT5B-G4'; INSERT INTO \"SodException\"(\"id\",\"projectId\",\"certificateId\",\"grantId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UPT5B-SY','p1','UPT5B-CY','UPT5B-G4','evidence-recorder-may-not-certify','USER-1','USER-2','blanket authority for this vendor','UPT5B-CMDY'); UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'; COMMIT;"

$PSQL >/dev/null -c "BEGIN; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") SELECT 'UPT5B-C4','p1','UPT4-B3','UPT4-BV3',3.00,'USER-1',COALESCE((SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='UPT4-B3'),0),'UPT5B-CMD4' FROM \"VendorBill\" b WHERE b.\"id\"='UPT4-B3'; INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UPT5B-A4','p1','UPT5B-C4','UP45-ACC',3); UPDATE \"SodGrant\" SET \"consumedAt\"=now(), \"consumedByCertificateId\"='UPT5B-C4' WHERE \"id\"='UPT5B-G4'; INSERT INTO \"SodException\"(\"id\",\"projectId\",\"certificateId\",\"grantId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UPT5B-S4','p1','UPT5B-C4','UPT5B-G4','evidence-recorder-may-not-certify','USER-1','USER-2','two-person practice','UPT5B-CMD4'); UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'; COMMIT;" \
  && printf 'ok      %s\n' "commercial T5B §I: the RECORDER may certify WITH an attributable override, in one transaction" \
  || { printf 'FAILED  %s\n' "commercial T5B §I: the coherent recorder-certified act was rejected"; FAIL=1; }
# the override carries the trusted-evidence seals
assert_rejects "commercial T5B §I: REWRITING the reason an override was granted for" \
  "UPDATE \"SodException\" SET \"reason\"='a different story' WHERE \"id\"='UPT5B-S4'"
assert_rejects "commercial T5B §I: a SECOND exception on one certificate (which one authorised the act?)" \
  "INSERT INTO \"SodException\"(\"id\",\"projectId\",\"certificateId\",\"grantId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UPT5B-S5','p1','UPT5B-C4','UPT5B-G4','some-other-rule','USER-1','USER-2','a second story','UPT5B-CMD4')"
assert_rejects "commercial T5B R7-F1: RE-SPENDING a consumed grant (an authority is exercised once)" \
  "UPDATE \"SodGrant\" SET \"consumedByCertificateId\"='UPT5B-C1' WHERE \"id\"='UPT5B-G4'"
assert_rejects "commercial T5B R7-F1: a grant that excuses its OWN author (a signature on a mirror)" \
  "INSERT INTO \"SodGrant\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UPT5B-GM','p1','UPT4-B3','UPT4-BV3','evidence-recorder-may-not-certify','USER-2','USER-2','self','UP45-CMD')"
# ── 7B-iii-h — the state a grant was justified against, sealed where the authority is SPENT ──
#
# `SodGrant` pins the claim VERSION, and one version walks the whole lifecycle without changing id.
# So the version says WHICH claim and not WHAT WAS TRUE about it, and an authorisation given before
# the §E verdict existed could excuse the certification of a verdict its approver never reviewed.
# The service refuses that; these prove the DATABASE does too, for a writer that never called it.
#
# `reviewedStatus` is also FROZEN by the append-only trigger now — a new fact on a guarded row
# belongs to every guard on that row, or a direct writer simply rewrites the justification.
mint5b_grant() { $PSQL >/dev/null -c "BEGIN; INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('$1','project','org-legacy','p1','USER-2','commercial.sod.grant','$1','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='$2', \"completedAt\"=now() WHERE \"id\"='$1'; COMMIT;"; }
mint5b_grant UPT5B-CMDGF UPT5B-GF
# THE LEGAL PATH FIRST: an authorisation naming the claim exactly as it stands is ACCEPTED, so the
# issue-side seal below is precise rather than merely strict. The reviewed pair is SELECTED from the
# claim rather than typed, because typing it is what the seal exists to refuse.
$PSQL >/dev/null -c "INSERT INTO \"SodGrant\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"reviewedStatus\",\"reviewedLifecycleVersion\",\"sourceCommandId\") SELECT 'UPT5B-GF','p1','UPT4-B3','UPT4-BV3','evidence-recorder-may-not-certify','USER-1','USER-2','a live authorisation',b.\"status\",r.\"revision\",'UPT5B-CMDGF' FROM \"VendorBill\" b JOIN \"VendorBillRevision\" r ON r.\"projectId\"=b.\"projectId\" AND r.\"billId\"=b.\"id\" WHERE b.\"projectId\"='p1' AND b.\"id\"='UPT4-B3'" \
  && printf 'ok      %s\n' "commercial T7BIIIH: an authorisation naming the claim AS IT STANDS is accepted" \
  || { printf 'FAILED  %s\n' "commercial T7BIIIH: a truthful live authorisation was rejected at issue"; FAIL=1; }
# ── round 5 — the guards on how a row is BORN, not only on how it changes ────────────────────
mint5b_grant UPT5B-CMDGP UPT5B-GP
assert_rejects "commercial T7BIIIH R5: authorising a passage of the claim that has not happened yet" \
  "INSERT INTO \"SodGrant\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"reviewedStatus\",\"reviewedLifecycleVersion\",\"sourceCommandId\") SELECT 'UPT5B-GP','p1','UPT4-B3','UPT4-BV3','evidence-recorder-may-not-certify','USER-1','USER-2','post-dated',b.\"status\",r.\"revision\"+5,'UPT5B-CMDGP' FROM \"VendorBill\" b JOIN \"VendorBillRevision\" r ON r.\"projectId\"=b.\"projectId\" AND r.\"billId\"=b.\"id\" WHERE b.\"projectId\"='p1' AND b.\"id\"='UPT4-B3'" \
  'never a passage it has not reached'
# the counter cannot be BORN behind the authorities already pinned to it (the BEFORE INSERT arm
# fires ahead of the primary-key check, so this is the trigger answering, not the index)
assert_rejects "commercial T7BIIIH R5: a claim revision row created BELOW zero" \
  "INSERT INTO \"VendorBillRevision\"(\"projectId\",\"billId\",\"revision\") VALUES('p1','UPT4-B3',-1)" \
  'starts at zero and only moves forward'
# retirement disposes of authority this release cannot JUDGE — never of a live, evidenced one
assert_rejects "commercial T7BIIIH R5: RETIRING an authorisation that carries its reviewed evidence" \
  "UPDATE \"SodGrant\" SET \"retiredAt\"=now(), \"retiredReason\"='tidying up' WHERE \"id\"='UPT5B-GF'" \
  'judged by the seals rather than retired'
# ── round 6 — NULL is the LEGACY shape, and legacy means "written before the column existed" ──
#
# A row that predates the column is never INSERTED again, so on INSERT a missing revision is not a
# legacy row: it is a post-migration writer declining to say which passage of the claim it acted on,
# at a boundary that now requires the answer. Nothing downstream would ask — the consume seal reads
# the column only when a §I authority is spent.
#
# The OTHERWISE-COHERENT version of this refusal is PROBE 37 in `phase5-t6a-payments.test.ts`,
# which builds a fully valid approval and omits only this column. Here the point is narrower and is
# the one this script exists for: the rule is installed on a database upgraded from the legacy
# fixture, not merely on a freshly migrated one.
assert_rejects "commercial T7BIIIH R6: an act that will not say which passage of the claim it acted on" \
  "INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"sourceCommandId\") VALUES('UPT5B-CN','p1','UPT4-B3','UPT4-BV3',3.00,'USER-2','UP45-CMD')" \
  'records no passage of claim'
# …and the whitespace-only retirement reason (round 6, P2) is proven by PROBE 35 instead: reaching
# it needs a LIVE grant with no reviewed evidence, and this release can no longer create one — the
# issue seal above refuses it. The probe reaches that state through the append-only bypass, which
# is the only honest way to build a row the current code cannot write.
assert_rejects "commercial T7BIIIH: REWRITING what an approver is recorded as having reviewed" \
  "UPDATE \"SodGrant\" SET \"reviewedStatus\"='verified' WHERE \"id\"='UPT5B-GF'" \
  'IMMUTABLE'
mint5b_grant UPT5B-CMDGS UPT5B-GS
assert_rejects "commercial T7BIIIH: spending an authorisation given over a SUBMITTED claim on a certification" \
  "INSERT INTO \"SodGrant\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"reviewedStatus\",\"reviewedLifecycleVersion\",\"sourceCommandId\",\"consumedAt\",\"consumedByCertificateId\") VALUES('UPT5B-GS','p1','UPT4-B3','UPT4-BV3','evidence-recorder-may-not-certify','USER-1','USER-2','authorised before the verdict','submitted',0,'UPT5B-CMDGS',now(),'UPT5B-C4')" \
  'authority can be spent from'
mint5b_grant UPT5B-CMDGN UPT5B-GN
assert_rejects "commercial T7BIIIH: spending a LEGACY grant that records no reviewed state at all" \
  "INSERT INTO \"SodGrant\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\",\"consumedAt\",\"consumedByCertificateId\") VALUES('UPT5B-GN','p1','UPT4-B3','UPT4-BV3','evidence-recorder-may-not-certify','USER-1','USER-2','predates the column','UPT5B-CMDGN',now(),'UPT5B-C4')" \
  'records no reviewed state'
# The APPROVAL arm of the same seal is proven against live PostgreSQL by PROBE 26 in
# `phase5-t6a-payments.test.ts`, and deliberately not here: reaching it needs a coherent
# grant→exception→approval chain, and this legacy fixture's only approval is one §I permits
# outright — so an assertion would be refused by the biconditional first and prove nothing about
# the seal it names. Same reasoning the bound-5 note below already records.

assert_rejects "commercial T5B §I: an exception naming NO fact (a standing waiver)" \
  "INSERT INTO \"SodException\"(\"id\",\"projectId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UPT5B-S0','p1','r','USER-1','USER-2','reason','UP45-CMD')"
assert_rejects "commercial T5B §I: an actor approving their OWN override (a signature on a mirror)" \
  "INSERT INTO \"SodException\"(\"id\",\"projectId\",\"certificateId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UPT5B-S1','p1','UPT5B-C4','r','USER-1','USER-1','reason','UP45-CMD')"
# the repository's non-blank discipline, over the COMPLETE ASCII whitespace set
assert_rejects "commercial T5B §I: an override justified by a TAB (presence is not justification)" \
  "INSERT INTO \"SodException\"(\"id\",\"projectId\",\"certificateId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UPT5B-S2','p1','UPT5B-C4','r','USER-1','USER-2',chr(9),'UP45-CMD')"
# §F's correction path, now past the recorder-certified certificate
$PSQL >/dev/null -c "BEGIN; UPDATE \"BillCertificate\" SET \"supersededAt\"=now(), \"supersededById\"='USER-2', \"supersedeReason\"='restated again' WHERE \"id\"='UPT5B-C4'; UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'; COMMIT;" \
  && printf 'ok      %s\n' "commercial T5B §F: the recorder's certificate supersedes by the same one-transaction path" \
  || { printf 'FAILED  %s\n' "commercial T5B §F: superseding the recorder-certified certificate was rejected"; FAIL=1; }
assert_rejects "commercial T5B R5-F2: an OVERRIDE appended to a superseded certificate (history does not gain rows)" \
  "INSERT INTO \"SodException\"(\"id\",\"projectId\",\"certificateId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UPT5B-S6','p1','UPT5B-C4','evidence-recorder-may-not-certify','USER-1','USER-2','late audit','UP45-CMD')"

assert_rejects "commercial T5A R4-F4: VERIFIED -> submitted with no replacement version (the amendment arrow without the amendment)" \
  "UPDATE \"VendorBill\" SET \"status\"='submitted', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'"
# …while the arrows this task DOES own still work — the seal is precise, not merely strict
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='disputed', \"statusReason\"='evidence withdrawn', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'" \
  && printf 'ok      %s\n' "commercial T4 R2-F3: under-verification -> disputed is ACCEPTED (the arrows this task owns still work)" \
  || { printf 'FAILED  %s\n' "commercial T4 R2-F3: a legal Task-4 transition was rejected"; FAIL=1; }
# ── Codex round-4: a RESOLUTION must carry the correction it claims to be ────────────────────
# `resolved` is terminal and RELEASES the duplicate-document key, so a bill marked resolved with no
# amendment behind it frees the vendor's number while the disputed claim is still the only version
# that ever existed. `UPT4-B4` therefore carries real version LINEAGE — the R2-F2 reason assertions
# move onto it, because they are assertions about a legitimate resolution.
$PSQL >/dev/null <<SQL
BEGIN;
INSERT INTO "VendorBill"("id","projectId","vendorId","vendorBillNumber","documentDate","status","createdById","sourceCommandId")
  VALUES('UPT4-B4','p1','UP45-VEN','INV-004','2026-08-24','draft','USER-1','UP45-CMD');
INSERT INTO "VendorBillVersion"("id","projectId","billId","vendorIdPin","version","claimedAmount","lineCount","createdById")
  VALUES('UPT4-BV4A','p1','UPT4-B4','UP45-VEN',1,12.00,1,'USER-1');
INSERT INTO "VendorBillLine"("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
  VALUES('UPT4-BL4A','p1','UPT4-BV4A','UPT4-B4','UP45-VEN','material','UP45-POL',12,1,0,0,12.00);
COMMIT;
SQL
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='disputed', \"statusReason\"='evidence withdrawn', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B4'" 2>/dev/null
assert "commercial T4 R4-F5: the DATABASE captured which version was disputed (no writer supplies it)" \
  "SELECT \"disputedAtVersion\"::text FROM \"VendorBill\" WHERE \"id\"='UPT4-B4';" \
  "1"
assert_rejects "commercial T4 R4-F5: RESOLVING a dispute with no amendment behind it (it would release the document number for a claim nobody fixed)" \
  "UPDATE \"VendorBill\" SET \"status\"='resolved' WHERE \"id\"='UPT4-B4'"
# the real correction: supersede the disputed version and enter the corrected claim
$PSQL >/dev/null <<SQL
BEGIN;
UPDATE "VendorBillVersion" SET "supersededAt"=now(), "supersededById"='USER-1', "supersedeReason"='vendor corrected the claim' WHERE "id"='UPT4-BV4A';
INSERT INTO "VendorBillVersion"("id","projectId","billId","vendorIdPin","version","supersedesVersion","claimedAmount","lineCount","createdById")
  VALUES('UPT4-BV4B','p1','UPT4-B4','UP45-VEN',2,1,2.00,1,'USER-1');
INSERT INTO "VendorBillLine"("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
  VALUES('UPT4-BL4B','p1','UPT4-BV4B','UPT4-B4','UP45-VEN','material','UP45-POL',2,1,0,0,2.00);
COMMIT;
SQL
# R2-F2 — resolving a dispute must not overwrite WHY it was disputed
assert_rejects "commercial T4 R2-F2: overwriting a dispute reason on the way to RESOLVED" \
  "UPDATE \"VendorBill\" SET \"status\"='resolved', \"statusReason\"='vendor corrected the claim' WHERE \"id\"='UPT4-B4'"
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='resolved', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B4'" \
  && printf 'ok      %s\n' "commercial T4 R2-F2/R4-F5: a resolution WITH its amendment behind it is ACCEPTED (the seal is precise, not merely strict)" \
  || { printf 'FAILED  %s\n' "commercial T4 R2-F2/R4-F5: a legitimate resolution was rejected"; FAIL=1; }
assert "commercial T4 R2-F2: the resolved bill still records WHY it left the live fold" \
  "SELECT \"statusReason\" FROM \"VendorBill\" WHERE \"id\"='UPT4-B4';" \
  "evidence withdrawn"
# R5-F2 — the dispute EVIDENCE outlives a later rejection. `statusReason` explains the CURRENT
# status, so `disputed -> rejected` legitimately writes its judgement over it; the breach that first
# took the claim out of the live fold is captured by the trigger and is unwritable.
$PSQL >/dev/null <<SQL
BEGIN;
INSERT INTO "VendorBill"("id","projectId","vendorId","vendorBillNumber","documentDate","status","createdById","sourceCommandId")
  VALUES('UPT4-B5','p1','UP45-VEN','INV-005','2026-08-27','draft','USER-1','UP45-CMD');
INSERT INTO "VendorBillVersion"("id","projectId","billId","vendorIdPin","version","claimedAmount","lineCount","createdById")
  VALUES('UPT4-BV5','p1','UPT4-B5','UP45-VEN',1,2.00,1,'USER-1');
INSERT INTO "VendorBillLine"("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
  VALUES('UPT4-BL5','p1','UPT4-BV5','UPT4-B5','UP45-VEN','material','UP45-POL',2,1,0,0,2.00);
COMMIT;
SQL
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='disputed', \"statusReason\"='qty-over-accepted: evidence withdrawn', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B5'" 2>/dev/null
assert "commercial T4 R5-F2: the DATABASE captured the dispute reason (no writer supplies it)" \
  "SELECT \"disputeReason\" FROM \"VendorBill\" WHERE \"id\"='UPT4-B5';" \
  "qty-over-accepted: evidence withdrawn"
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='rejected', \"statusReason\"='duplicate invoice', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B5'" \
  && printf 'ok      %s\n' "commercial T4 R5-F2: rejecting a DISPUTED claim is ACCEPTED (the judgement is a real transition)" \
  || { printf 'FAILED  %s\n' "commercial T4 R5-F2: a legal disputed->rejected transition was refused"; FAIL=1; }
assert "commercial T4 R5-F2: the rejection JUDGEMENT is recorded" \
  "SELECT \"statusReason\" FROM \"VendorBill\" WHERE \"id\"='UPT4-B5';" \
  "duplicate invoice"
assert "commercial T4 R5-F2: and the dispute EVIDENCE survived it" \
  "SELECT \"disputeReason\" FROM \"VendorBill\" WHERE \"id\"='UPT4-B5';" \
  "qty-over-accepted: evidence withdrawn"
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"disputeReason\"='a different story' WHERE \"id\"='UPT4-B5'" >/dev/null 2>&1
assert "commercial T4 R5-F2: a direct write to the captured dispute reason is DISCARDED by the trigger" \
  "SELECT \"disputeReason\" FROM \"VendorBill\" WHERE \"id\"='UPT4-B5';" \
  "qty-over-accepted: evidence withdrawn"
# ── Codex round-4: the duplicate-document key is the NORMALIZED number ───────────────────────
# `UPT4-B3` still holds `INV-003` and is `disputed`, which §F counts as live for this key.
assert_rejects "commercial T4 R4-F2: a second live claim whose number differs only in LETTER CASE" \
  "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"createdById\",\"sourceCommandId\") VALUES('UPT4-XN1','p1','UP45-VEN','inv-003','2026-08-25','draft','USER-1','UP45-CMD')"
assert_rejects "commercial T4 R4-F2: a second live claim whose number differs only in INTERNAL whitespace" \
  "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"createdById\",\"sourceCommandId\") VALUES('UPT4-XN2','p1','UP45-VEN','INV -003','2026-08-25','draft','USER-1','UP45-CMD')"
assert_rejects "commercial T4 R4-F2: STORING a padded document number (the read surface and the key would disagree)" \
  "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"createdById\",\"sourceCommandId\") VALUES('UPT4-XN3','p1','UP45-VEN','  INV-005  ','2026-08-25','draft','USER-1','UP45-CMD')"
# …and the RESOLVED bill released its number, case-normalized, exactly as a terminal state should
if $PSQL >/dev/null <<SQL
BEGIN;
INSERT INTO "VendorBill"("id","projectId","vendorId","vendorBillNumber","documentDate","status","createdById","sourceCommandId")
  VALUES('UPT4-N4','p1','UP45-VEN','inv-004','2026-08-25','draft','USER-1','UP45-CMD');
INSERT INTO "VendorBillVersion"("id","projectId","billId","vendorIdPin","version","claimedAmount","lineCount","createdById")
  VALUES('UPT4-NV4','p1','UPT4-N4','UP45-VEN',1,1.00,1,'USER-1');
INSERT INTO "VendorBillLine"("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
  VALUES('UPT4-NL4','p1','UPT4-NV4','UPT4-N4','UP45-VEN','material','UP45-POL',1,1,0,0,1.00);
COMMIT;
SQL
then printf 'ok      %s\n' "commercial T4 R4-F2: re-filing a RESOLVED claim's number is ACCEPTED (the normalized key releases with the lifecycle)"
else printf 'FAILED  %s\n' "commercial T4 R4-F2: the normalized key did not release on a terminal state"; FAIL=1
fi
# ── Codex round-3 findings, sealed at PostgreSQL ─────────────────────────────────────────────
# R3-F2 — WHEN a claim left the live fold is evidence too
assert_rejects "commercial T4 R3-F2: rewriting statusChangedAt outside the transition that set it" \
  "UPDATE \"VendorBill\" SET \"statusChangedAt\"='2020-01-01T00:00:00Z' WHERE \"id\"='UPT4-B3'"
# R3-F3 — round 2 sealed the ARROWS; creation needed its own guard
assert_rejects "commercial T4 R3-F3: CREATING a claim already at 'certified', skipping every arrow" \
  "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"createdById\",\"sourceCommandId\") VALUES('UPT4-XC','p1','UP45-VEN','INV-CERT','2026-08-23','certified','USER-1','UP45-CMD')"
assert_rejects "commercial T4 R3-F3: CREATING a claim already at 'submitted'" \
  "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"createdById\",\"sourceCommandId\") VALUES('UPT4-XS','p1','UP45-VEN','INV-SUB','2026-08-23','submitted','USER-1','UP45-CMD')"
# R3-F1 — a live CLAIM is a headroom mover, so the register's vocabulary admits it
$PSQL >/dev/null -c "INSERT INTO \"BudgetException\"(\"id\",\"projectId\",\"costHeadCode\",\"headroom\",\"budget\",\"exposure\",\"raisedBy\",\"raisedById\") VALUES('UPT4-BXCL','p1','MEP',-25.00,100.00,125.00,'claim','USER-1')" \
  && printf 'ok      %s\n' "commercial T4 R3-F1: an exception raised by a live CLAIM is accepted (the seventh mover)" \
  || { printf 'FAILED  %s\n' "commercial T4 R3-F1: the claim-raised exception was rejected"; FAIL=1; }
$PSQL >/dev/null -c "UPDATE \"BudgetException\" SET \"clearedAt\"=now() WHERE \"id\"='UPT4-BXCL'" >/dev/null

# ── Phase 5 Task 5C (§H) — the SUPERSEDED-certificate rule, asserted where one actually is ──
# `UPT5B-C1` was superseded above, so this is the real state the rule is about — and the deduction
# rows taken against it while it was live survive as history, which is what §H requires.
assert "commercial T5C: the withholdings taken while it was live SURVIVE its supersession as history" \
  "SELECT COUNT(*)::text FROM \"BillDeduction\" WHERE \"certificateId\"='UPT5B-C1';" \
  "1"
# Codex round 6 (P2). This assertion USED to cite `UP5C-CMD`, which is bound to `UP5C-DED` — so the
# provenance trigger rejected it for the wrong reason and the line stayed green with the liveness
# seals removed. It named the superseded-certificate rule while testing command provenance. The
# fixture binds to the row it is about to attempt, exactly as the `mint5c` rule above states, so the
# ONLY thing left to reject it is the rule in its name.
mint5c UP5C-CMD-LATE commercial.deduction.record UP5C-LATE
assert_rejects "commercial T5C: a NEW withholding against a SUPERSEDED certificate (taken from nothing)" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-LATE','p1','UPT5B-C1','UPT4-B3','retention',1.00,'USER-1','UP5C-CMD-LATE')" \
  'was superseded'

# ── Codex rounds 3–4 — the re-statement chain, proven end to end on a real supersession ──────────
# This block builds its OWN outstanding withholding rather than reusing `UP5C-DED` (fully released
# above), because every rule below is about a retained BALANCE and a released row would let them all
# "pass" while proving nothing. The certificate ids are DERIVED from the database, and asserted
# present first, so a query matching nothing cannot be mistaken for a rule holding.
# The T5B assertions above leave this bill with NO live certificate, so this block CREATES the state
# it needs rather than assuming it. The first draft assumed one was standing: the accept-first line
# caught it immediately, and the two rejections that had already "passed" turned out to be rejected
# by a foreign key on an empty id rather than by the rules they named. That is the round-2 vacuity
# defect, found by the guard written for it.
# It walks its OWN bill (`UPT4-N4`, left at draft by the T4 assertions) through the lifecycle rather
# than reusing `UPT4-B3`, which by this point is `disputed` and cannot be certified again.
UP5C_BILL=UPT4-N4
UP5C_VER=UPT4-NV4
$PSQL >/dev/null -c "INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UP5C-CMD0','project','org-legacy','p1','USER-1','commercial.bill.certify','up5c-c0','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='UP5C-C0', \"completedAt\"=now() WHERE \"id\"='UP5C-CMD0'"
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='submitted', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'"
$PSQL >/dev/null -c "INSERT INTO \"CommandExecution\"(\"id\",\"scopeKind\",\"organizationId\",\"projectId\",\"actorId\",\"commandType\",\"idempotencyKey\",\"requestHash\",\"status\") VALUES('UP5C-CMDV','project','org-legacy','p1','USER-1','commercial.bill.verify','up5c-v0','x','reserved'); UPDATE \"CommandExecution\" SET \"status\"='succeeded', \"resultRef\"='UP5C-V0', \"completedAt\"=now() WHERE \"id\"='UP5C-CMDV'"
# the verification must already STAND before the arrow moves — §E's seal, so these are two commits
$PSQL >/dev/null -c "INSERT INTO \"BillVerification\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"verdict\",\"verifiedById\",\"sourceCommandId\") VALUES('UP5C-V0','p1','$UP5C_BILL','$UP5C_VER','matched','USER-1','UP5C-CMDV')"
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='under-verification', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'"
$PSQL >/dev/null -c "UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'"
$PSQL -c "BEGIN; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UP5C-C0','p1','$UP5C_BILL','$UP5C_VER',1.00,'USER-2',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='$UP5C_BILL'),'UP5C-CMD0'); INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UP5C-A0','p1','UP5C-C0','UP45-ACC',1); UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'; COMMIT;" \
  && printf 'ok      %s\n' "commercial T5C R3/R4: a fresh live certificate stands on its own bill" \
  || { printf 'FAILED  %s\n' "commercial T5C R3/R4: could not stand up a live certificate — every assertion below would be vacuous"; FAIL=1; }
assert "commercial T5C R3/R4: exactly the certificate this block created is LIVE, so nothing below is vacuous" \
  "SELECT COALESCE(string_agg(\"id\", ','), '(none)') FROM \"BillCertificate\" WHERE \"projectId\"='p1' AND \"billId\"='$UP5C_BILL' AND \"supersededAt\" IS NULL;" \
  "UP5C-C0"
UP5C_LIVE=UP5C-C0
mint5c UP5C-CMD-D2  commercial.deduction.record  UP5C-D2
mint5c UP5C-CMD-R2A commercial.deduction.release UP5C-R2A
mint5c UP5C-CMD-R2B commercial.deduction.release UP5C-R2B
$PSQL >/dev/null -c "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-D2','p1','$UP5C_LIVE','$UP5C_BILL','retention',0.50,'USER-1','UP5C-CMD-D2')" \
  && printf 'ok      %s\n' "commercial T5C R4: a fresh unreleased withholding on the live certificate is ACCEPTED" \
  || { printf 'FAILED  %s\n' "commercial T5C R4: the fresh withholding was rejected"; FAIL=1; }
# ── the carry requirement, at the point where a bypass writer actually lands ────────────────────
#
# §H's rule is that a retained balance never vanishes without an attributable release, and the plan
# names the mechanism: the replacement CARRIES it. The seal is asserted on the shape a bypass writer
# would use — supersede the live certificate and re-certify in ONE transaction — with ₹0.50 still
# held and no carried rows. Round 5's finding 2 is asserted beside it: carrying the DEDUCTION while
# dropping its RELEASE is refused too, because a retained balance is a fold over BOTH halves.
mint5c UP5C-CMD-NC2 commercial.bill.certify UP5C-LIVE-NC
replace_without_carry() {   # $1 = 'nothing' | 'deduction-only'
  local carry_rows=""
  if [ "$1" = "deduction-only" ]; then
    carry_rows="INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"reason\",\"recordedById\",\"sourceCommandId\",\"restatedFromId\") SELECT 'UP5C-D2-NC',\"projectId\",'UP5C-LIVE-NC',\"billId\",\"type\",\"amount\",\"reason\",\"recordedById\",\"sourceCommandId\",\"id\" FROM \"BillDeduction\" WHERE \"id\"='UP5C-D2';"
  fi
  printf 'BEGIN; UPDATE "BillCertificate" SET "supersededAt"=now(), "supersededById"=%s, "supersedeReason"=%s WHERE "id"=%s; INSERT INTO "BillCertificate"("id","projectId","billId","versionId","certifiedAmount","certifiedById","reviewedLifecycleVersion","sourceCommandId") SELECT %s,"projectId","billId","versionId","certifiedAmount","certifiedById",(SELECT r."revision" FROM "VendorBillRevision" r WHERE r."projectId"="BillCertificate"."projectId" AND r."billId"="BillCertificate"."billId"),%s FROM "BillCertificate" WHERE "id"=%s; INSERT INTO "CertifiedAcceptanceConsumption"("id","projectId","certificateId","stockTransactionId","consumedQty") SELECT gen_random_uuid()::text,"projectId",%s,"stockTransactionId","consumedQty" FROM "CertifiedAcceptanceConsumption" WHERE "certificateId"=%s; %s COMMIT;' \
    "'USER-1'" "'drops the balance'" "'$UP5C_LIVE'" "'UP5C-LIVE-NC'" "'UP5C-CMD-NC2'" "'$UP5C_LIVE'" "'UP5C-LIVE-NC'" "'$UP5C_LIVE'" "$carry_rows"
}
assert_rejects "commercial T5C R9: re-certifying WITHOUT carrying the retained balance (the money would vanish)" \
  "$(replace_without_carry nothing)" \
  'does not re-state'
assert "commercial T5C R9: …and the certificate is still LIVE, so the refusal actually held" \
  "SELECT COALESCE(string_agg(\"id\", ','), '(none)') FROM \"BillCertificate\" WHERE \"projectId\"='p1' AND \"billId\"='$UP5C_BILL' AND \"supersededAt\" IS NULL;" \
  "$UP5C_LIVE"
# a PARTIAL release is still a retained balance — the case an "any release at all" rule waves through
$PSQL >/dev/null -c "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-R2A','p1','UP5C-D2',0.20,'first milestone','USER-1','UP5C-CMD-R2A')"
# …and a PARTIAL release is still a retained balance, so a replacement that drops that half is
# refused — the case an "any release at all" rule waves through (round 5 finding 2)
assert_rejects "commercial T5C R9: carrying the withholding but DROPPING its release (a fold has two halves)" \
  "$(replace_without_carry deduction-only)" \
  'drops its release'
assert "commercial T5C R9: …and the certificate is still LIVE, so that refusal actually held" \
  "SELECT COALESCE(string_agg(\"id\", ','), '(none)') FROM \"BillCertificate\" WHERE \"projectId\"='p1' AND \"billId\"='$UP5C_BILL' AND \"supersededAt\" IS NULL;" \
  "$UP5C_LIVE"
# …and once the money is returned the SAME correction is ACCEPTED, which is what makes the seal
# precise rather than merely strict: it is about a retained balance, not about supersession
$PSQL >/dev/null -c "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-R2B','p1','UP5C-D2',0.30,'balance returned','USER-1','UP5C-CMD-R2B')"
assert "commercial T5C R5: the withholding is now fully released" \
  "SELECT (d.\"amount\" - COALESCE(SUM(r.\"amount\"),0))::text FROM \"BillDeduction\" d LEFT JOIN \"BillDeductionRelease\" r ON r.\"deductionId\"=d.\"id\" WHERE d.\"id\"='UP5C-D2' GROUP BY d.\"amount\";" \
  "0.00"
# ── Codex round 8 — the two seals this round added, tried where a bypass writer would try them ────
# Both fixtures bind their command to the row they are about to attempt (CLOSURE 7) and name the
# rule that must do the rejecting, so neither can pass on provenance while claiming something else.
mint5c UP5C-CMD-OVER commercial.deduction.record  UP5C-DOVER
mint5c UP5C-CMD-OVRR commercial.deduction.release UP5C-ROVER
assert_rejects "commercial T5C R8: an over-large withholding netted back under the floor by a same-transaction release" \
  "BEGIN; INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-DOVER','p1','$UP5C_LIVE','$UP5C_BILL','retention',1.50,'USER-1','UP5C-CMD-OVER'); INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-ROVER','p1','UP5C-DOVER',0.50,'nets it back','USER-1','UP5C-CMD-OVRR'); COMMIT;" \
  'exceed the'
mint5c UP5C-CMD-ACT commercial.deduction.record UP5C-DACT
assert_rejects "commercial T5C R8: a withholding attributed to someone other than the actor who ran its command" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-DACT','p1','$UP5C_LIVE','$UP5C_BILL','retention',0.10,'USER-2','UP5C-CMD-ACT')" \
  'was run by'
$PSQL >/dev/null -c "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP5C-DACT','p1','$UP5C_LIVE','$UP5C_BILL','retention',0.10,'USER-1','UP5C-CMD-ACT')" \
  && printf 'ok      %s\n' "commercial T5C R8: the SAME row carrying its command's own actor is ACCEPTED (the seal is precise, not merely strict)" \
  || { printf 'FAILED  %s\n' "commercial T5C R8: an honestly attributed withholding was rejected — the actor seal is over-strict"; FAIL=1; }
mint5c UP5C-CMD-DACTR commercial.deduction.release UP5C-DACTR
$PSQL >/dev/null -c "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP5C-DACTR','p1','UP5C-DACT',0.10,'returned','USER-1','UP5C-CMD-DACTR')" \
  && printf 'ok      %s\n' "commercial T5C R8: …and the balance is returned, so the correction below still has nothing held against it" \
  || { printf 'FAILED  %s\n' "commercial T5C R8: the release of the round-8 withholding was rejected"; FAIL=1; }

# ── Phase 5 Task 6A (§F/§G/§I) — payment authority, over the migrated legacy database ───────────
#
# The two tables must arrive EMPTY: a legacy database has no payment authority, and a row here
# would mean money movement predating the seals this task installs.
assert "commercial T6A: the payment tables upgrade ROW-FREE over the legacy fixture" \
  "SELECT (SELECT COUNT(*) FROM \"PaymentApproval\")::text || '/' || (SELECT COUNT(*) FROM \"Payment\")::text;" \
  "0/0"
# …and the ceiling column is NULL everywhere, so no existing membership silently loses authority
assert "commercial T6A: every existing membership keeps unlimited approval authority (NULL ceiling)" \
  "SELECT COUNT(*)::text FROM \"Membership\" WHERE \"approvalLimit\" IS NOT NULL;" \
  "0"

# §G bound 4 at PostgreSQL, against the certificate that is LIVE at this point: its 1.00
# certification carries only fully-released withholdings, so the net payable is 1.00. Placed here
# deliberately — a superseded certificate leaves nothing payable and the bound would return early,
# which would make every assertion below vacuous rather than wrong.
mint5c UP6A-CMD-OVER commercial.payment.approve UP6A-A-OVER
assert_rejects "commercial T6A: approving MORE than the net payable" \
  "INSERT INTO \"PaymentApproval\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"amount\",\"approvedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UP6A-A-OVER','p1','$UP5C_LIVE','$UP5C_BILL',5.00,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='$UP5C_BILL'),'UP6A-CMD-OVER')" \
  'exceed the'
mint5c UP6A-CMD-OK commercial.payment.approve UP6A-A-OK
# Task 6B-i — the approval now carries the status it derives, in the SAME transaction, because the
# derivation seal refuses a fold that moves without it. That is not a weakening of this assertion:
# the row is identical and bound 4 still decides whether it may exist. It is the fixture being made
# to do what `payment.approve` does, which is what an upgrade proof should be exercising anyway.
$PSQL >/dev/null -c "BEGIN; INSERT INTO \"PaymentApproval\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"amount\",\"approvedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UP6A-A-OK','p1','$UP5C_LIVE','$UP5C_BILL',1.00,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='$UP5C_BILL'),'UP6A-CMD-OK'); UPDATE \"VendorBill\" SET \"status\"='approved-for-payment', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'; COMMIT;" \
  && printf 'ok      %s\n' "commercial T6A: approving EXACTLY the net payable is ACCEPTED (the bound is precise, not merely strict)" \
  || { printf 'FAILED  %s\n' "commercial T6A: a coherent approval was rejected — bound 4 is over-strict"; FAIL=1; }

# §G bound 5 at PostgreSQL
mint5c UP6A-CMD-PAYOVER commercial.payment.record UP6A-P-OVER
assert_rejects "commercial T6A: paying MORE than was approved" \
  "INSERT INTO \"Payment\"(\"id\",\"projectId\",\"approvalId\",\"billId\",\"amount\",\"method\",\"paidById\",\"sourceCommandId\") VALUES('UP6A-P-OVER','p1','UP6A-A-OK','$UP5C_BILL',2.00,'neft','USER-1','UP6A-CMD-PAYOVER')" \
  'exceed the'
# The ACCEPTED payment is deliberately NOT asserted here, and the reason is the new supersede seal
# rather than a gap: a payment is append-only, so recording one leaves it standing against this
# certificate, and the 5C correction below then supersedes that certificate — which drops the
# approval out of `APPROVED` while the payment stays in `PAID`, and the seal correctly refuses. The
# fixture cannot both leave a payment here and let the later correction run. The acceptance is
# proven against live PostgreSQL by PROBE 5 in `phase5-t6a-payments.test.ts`, which builds its own
# claim and is free to leave a payment standing on it.

# append-only, both tables
assert_rejects "commercial T6A: RAISING an approval after the fact (an authority that can be edited is not one)" \
  "UPDATE \"PaymentApproval\" SET \"amount\"=99.00 WHERE \"id\"='UP6A-A-OK'"
# the payment table's append-only rule, proven on the approval's own trigger pair: the DELETE
# arm fires for any row, and asserting it against a row that no longer exists would pass vacuously
assert_rejects "commercial T6A: DELETING an approval (an authority that can be removed is not one)" \
  "DELETE FROM \"PaymentApproval\" WHERE \"id\"='UP6A-A-OK'"

# an exception authorises ONE act, never both halves at once
assert_rejects "commercial T6A: an SoD exception naming BOTH a certificate and an approval" \
  "INSERT INTO \"SodException\"(\"id\",\"projectId\",\"certificateId\",\"approvalId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UP6A-X','p1','$UP5C_LIVE','UP6A-A-OK','certifier-may-not-approve','USER-1','USER-2','both halves','UP6A-CMD-OK')"

# …and a GRANT is spent by one act of one KIND, for the same reason: naming both would make
# "which act exercised this authority?" unanswerable (Codex round 2, the widened CHECK)
mint5c UP6A-CMD-GRANT commercial.sod.grant UP6A-G-BOTH
assert_rejects "commercial T6A: an SoD grant consumed by BOTH a certificate and an approval" \
  "INSERT INTO \"SodGrant\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\",\"reviewedStatus\",\"reviewedLifecycleVersion\",\"consumedAt\",\"consumedByCertificateId\",\"consumedByApprovalId\") VALUES('UP6A-G-BOTH','p1','$UP5C_BILL','$UP5C_VER','certifier-may-not-approve','USER-2','USER-1','both kinds','UP6A-CMD-GRANT','certified',0,now(),'$UP5C_LIVE','UP6A-A-OK')"

# §I is a BICONDITIONAL. `UP6A-A-OK` was approved by USER-1 while USER-2 certified — the rule
# permits that act outright, so an override attached to it records an authorisation nobody needed.
mint5c UP6A-CMD-NOCONF commercial.payment.approve UP6A-X-NOCONF
assert_rejects "commercial T6A: an SoD exception on an approval the rule would never have refused" \
  "INSERT INTO \"SodException\"(\"id\",\"projectId\",\"approvalId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"sourceCommandId\") VALUES('UP6A-X-NOCONF','p1','UP6A-A-OK','certifier-may-not-approve','USER-1','USER-2','no conflict here','UP6A-CMD-NOCONF')" \
  'the rule permits that act outright'

# ── Task 6A, Codex round 3 ───────────────────────────────────────────────────────────────────
#
# A grant's approval-side consume was the ONE evidence target with nothing checking it: Task 5's
# grant seal guards its clause on `consumedByCertificateId IS NOT NULL`, so stamping the approval
# column skipped it entirely and an approver's authority could be burned against an act it never
# excused.
mint5c UP6A-CMD-GRANT2 commercial.sod.grant UP6A-G-LIVE
$PSQL >/dev/null -c "INSERT INTO \"SodGrant\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"rule\",\"actorId\",\"approverId\",\"reason\",\"reviewedStatus\",\"reviewedLifecycleVersion\",\"sourceCommandId\") SELECT 'UP6A-G-LIVE','p1','$UP5C_BILL','$UP5C_VER','certifier-may-not-approve','USER-2','USER-1','only pmc on site',b.\"status\",COALESCE((SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='$UP5C_BILL'),0),'UP6A-CMD-GRANT2' FROM \"VendorBill\" b WHERE b.\"id\"='$UP5C_BILL'" \
  && printf 'ok      %s\n' "commercial T6A R3: a live payment-side grant is ACCEPTED (the approver's own receipt backs it)" \
  || { printf 'FAILED  %s\n' "commercial T6A R3: a well-formed payment-side grant was rejected"; FAIL=1; }
assert_rejects "commercial T6A R3: burning a grant against an approval that carries no matching override" \
  "UPDATE \"SodGrant\" SET \"consumedAt\"=now(), \"consumedByApprovalId\"='UP6A-A-OK' WHERE \"id\"='UP6A-G-LIVE'" \
  'carries no matching override'

# The approval-scoped half of bound 5 is NOT asserted here, and the reason is this fixture rather
# than a gap. Isolating it needs TWO live approvals — the whole point is that the BILL fold sees
# enough headroom while ONE approval is overdrawn — and this legacy claim's net payable is 1.00,
# which bound 4 correctly caps at a single approval. Any second payment here is refused by the bill
# fold first, so an assertion would pass while proving nothing about the new seal.
#
# It is proven against live PostgreSQL by PROBE 21 in `phase5-t6a-payments.test.ts`, which builds a
# 100.00 claim, approves 40 twice, and inserts the overdrawing payment with the service bypassed —
# the bill fold seeing 80 approved against 80 paid, and only the approval-scoped seal refusing.
#
# Nor is an ACCEPTED payment recorded here, for the reason the block above already gives: a payment
# is append-only, and leaving one standing makes the 5C correction below supersede a certificate
# whose approval then drops out of `APPROVED` while the payment stays in `PAID`.


$PSQL >/dev/null -c "BEGIN; UPDATE \"BillCertificate\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='corrected' WHERE \"id\"='$UP5C_LIVE'; UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'; COMMIT;" \
  && printf 'ok      %s\n' "commercial T5C R5: the SAME correction after an attributable release is ACCEPTED (the seal is precise, not merely strict)" \
  || { printf 'FAILED  %s\n' "commercial T5C R5: a correction with nothing left held was rejected — the seal is over-strict"; FAIL=1; }
assert "commercial T5C R5: the ledger survives the correction as append-only HISTORY — nothing was deleted to make it legal" \
  "SELECT (SELECT COUNT(*) FROM \"BillDeduction\" WHERE \"id\"='UP5C-D2')::text || '/' || (SELECT COUNT(*) FROM \"BillDeductionRelease\" WHERE \"deductionId\"='UP5C-D2')::text;" \
  "1/2"

# ── Task 6A, Codex round 2 (P1) — money may not be nested under authority that no longer stands ──
#
# The certificate above is now SUPERSEDED, which is exactly the state the bill-scoped bound cannot
# see: `UP6A-A-OK` drops out of `APPROVED` and any payment against it would stay in `PAID`, so a
# fold-only seal passes whenever some other live approval happens to cover the total. The question
# is asked at the ROW, on both tables — the finding named the payment; its sibling is the approval.
mint5c UP6A-CMD-STALEPAY commercial.payment.record UP6A-P-STALE
assert_rejects "commercial T6A R2: paying against an approval whose certification was superseded" \
  "INSERT INTO \"Payment\"(\"id\",\"projectId\",\"approvalId\",\"billId\",\"amount\",\"method\",\"paidById\",\"sourceCommandId\") VALUES('UP6A-P-STALE','p1','UP6A-A-OK','$UP5C_BILL',1.00,'neft','USER-1','UP6A-CMD-STALEPAY')" \
  'superseded'
mint5c UP6A-CMD-GHOST commercial.payment.approve UP6A-A-GHOST
assert_rejects "commercial T6A R2: approving against a certificate that is retained history" \
  "INSERT INTO \"PaymentApproval\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"amount\",\"approvedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UP6A-A-GHOST','p1','$UP5C_LIVE','$UP5C_BILL',1.00,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='$UP5C_BILL'),'UP6A-CMD-GHOST')" \
  'superseded'

# ── Phase 5 Task 6B unit i (§F) — the DERIVED payment status, over the migrated legacy database ──
#
# This unit adds NO table and NO column, so there is no row-free assertion to make. What it changes
# is the LIFECYCLE — and, after Codex round 1, WHO decides the member. The first head guarded only
# FAMILY MEMBERSHIP here and left the member to the service, which meant one raw UPDATE could store
# `paid` on a bill with nothing approved and nothing paid. The database now computes the exact
# derivation and refuses any disagreement, fired from the bill AND from every table that can make
# the equation false. So every arrow below moves a FOLD and the status TOGETHER, which is the shape
# the real commands use, and each is paired with the otherwise-identical write that is refused.
assert "commercial T6B: §F's derived family has ONE definition in SQL, and it is IMMUTABLE" \
  "SELECT p.\"proname\" || '/' || p.\"provolatile\"::text || '/' || (SELECT COUNT(*) FROM pg_proc c WHERE c.\"prosrc\" LIKE '%phase5_t6b_derived_bill_status%' AND c.\"proname\" IN ('phase5_t5_certificate_projection_check','phase5_t4_bill_lifecycle'))::text FROM pg_proc p WHERE p.\"proname\" = 'phase5_t6b_derived_bill_status';" \
  "phase5_t6b_derived_bill_status/i/2"
assert "commercial T6B: the predicate answers for the WHOLE family and for nothing outside it" \
  "SELECT string_agg(phase5_t6b_derived_bill_status(s)::text, '/' ORDER BY s) FROM unnest(ARRAY['approved-for-payment','certified','draft','paid','part-paid','rejected','submitted','verified']) s;" \
  "true/true/false/true/true/false/false/false"
# Codex round 1 — the TRUTH TABLE is in SQL too, and the seal that uses it is installed on every
# table that can move a fold (six of them after 6B-ii added the reversal). A name-and-count assertion would prove neither, so the derivation is
# exercised directly below and the trigger set is checked by relation as well as by name.
assert "commercial T6B R1: the derivation seal fires from the bill AND from every fold table" \
  "SELECT string_agg(c.\"relname\", '/' ORDER BY c.\"relname\") FROM pg_trigger t JOIN pg_class c ON c.\"oid\" = t.\"tgrelid\" WHERE t.\"tgname\" LIKE '%_t6b_status_sealed' AND NOT t.\"tgisinternal\" AND t.\"tgdeferrable\" AND t.\"tginitdeferred\";" \
  "BillCertificate/BillDeduction/BillDeductionRelease/Payment/PaymentApproval/PaymentReversal/VendorBill"

# A FRESH live certificate on the bill the 6A block left at `verified` — the arrows below are
# vacuous without one, because the projection seal refuses every derived status with no certificate.
mint5c UP6B-CMD-C1 commercial.bill.certify UP6B-C1
if $PSQL >/dev/null -c "BEGIN; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UP6B-C1','p1','$UP5C_BILL','$UP5C_VER',1.00,'USER-2',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='$UP5C_BILL'),'UP6B-CMD-C1'); INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UP6B-A1','p1','UP6B-C1','UP45-ACC',1); UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'; COMMIT;"
then printf 'ok      %s\n' "commercial T6B: a fresh live certificate stands on the bill, so the family arrows below are not vacuous"
else printf 'FAILED  %s\n' "commercial T6B: could not stand up a live certificate — every family assertion below would be vacuous"; FAIL=1
fi
assert "commercial T6B R1: the DATABASE derives the certified member for that bill, nothing withheld or paid" \
  "SELECT phase5_t6b_derive_bill_status('p1', '$UP5C_BILL');" \
  "certified"

# `t6b_arrow <label> <from> <to> <sql moving the fold>` — one coherent transaction moving a fold and
# the status together, then an assertion that the bill actually stood at `from` and actually reached
# `to`. An acceptance is evidence only when the state moved: without that check a silent setup
# failure leaves the bill already at `to`, the lifecycle trigger skips on
# `NEW.status IS DISTINCT FROM OLD.status`, and a no-op UPDATE reports success.
t6b_arrow() {
  local label="$1" from="$2" to="$3" fold="$4"
  local before after
  before=$($PSQL -tAc "SELECT \"status\" FROM \"VendorBill\" WHERE \"id\"='$UP5C_BILL'")
  $PSQL >/dev/null -c "BEGIN; $fold; UPDATE \"VendorBill\" SET \"status\"='$to', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'; COMMIT;" 2>/dev/null
  after=$($PSQL -tAc "SELECT \"status\" FROM \"VendorBill\" WHERE \"id\"='$UP5C_BILL'")
  if [ "$before" = "$from" ] && [ "$after" = "$to" ]; then
    printf 'ok      %s\n' "commercial T6B §F: $label ($from -> $to, fold and status moving together)"
  else
    printf 'FAILED  %s\n' "commercial T6B §F: $label did not happen (stood at '$before', ended at '$after')"; FAIL=1
  fi
}

# withholding the WHOLE payable leaves NET_PAYABLE = PAID = 0, which §F calls `paid`
mint5c UP6B-CMD-D1 commercial.deduction.record UP6B-D1
t6b_arrow "a fully-withheld claim is settled at zero" certified paid \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP6B-D1','p1','UP6B-C1','$UP5C_BILL','retention',1.00,'USER-1','UP6B-CMD-D1')"
# …and giving part of it back RAISES the payable, so the status must move BACKWARD. A forward-only
# guard would strand this bill at `paid` while §J still reported money owed.
mint5c UP6B-CMD-R1 commercial.deduction.release UP6B-R1
t6b_arrow "a release moves the status BACKWARD — the derivation is not monotonic" paid certified \
  "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP6B-R1','p1','UP6B-D1',0.40,'first milestone','USER-1','UP6B-CMD-R1')"
mint5c UP6B-CMD-A1 commercial.payment.approve UP6B-A1
t6b_arrow "an authority against the released payable" certified approved-for-payment \
  "INSERT INTO \"PaymentApproval\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"amount\",\"approvedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UP6B-A1','p1','UP6B-C1','$UP5C_BILL',0.40,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='$UP5C_BILL'),'UP6B-CMD-A1')"

# ── Codex round 1 — the two mouths of the same gap ───────────────────────────────────────────────
#
# The STATUS moving without its folds…
assert_rejects "commercial T6B R1: a raw status flip inside the family, with no fold behind it" \
  "UPDATE \"VendorBill\" SET \"status\"='paid', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'" \
  'its own folds derive'
assert_rejects "commercial T6B R1: …and the flip BACK to a member it has legitimately held is refused too" \
  "UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'" \
  'its own folds derive'
# …and the FOLDS moving without the status. The payment below is valid by every EARLIER seal — a
# live certificate, a real succeeded command of the right type, within its own authority — and a
# weaker forgery would have been rejected before it ever reached the derivation.
mint5c UP6B-CMD-PX commercial.payment.record UP6B-PX
assert_rejects "commercial T6B R1: a VALID payment appended without moving the status it changes" \
  "INSERT INTO \"Payment\"(\"id\",\"projectId\",\"approvalId\",\"billId\",\"amount\",\"method\",\"paidById\",\"sourceCommandId\") VALUES('UP6B-PX','p1','UP6B-A1','$UP5C_BILL',0.40,'neft','USER-1','UP6B-CMD-PX')" \
  'its own folds derive'
# …while a fold write that does NOT change the answer is ACCEPTED, which is the seal being precise
# rather than a blanket ban on writing a fold table. Releasing the remaining ₹0.60 raises
# NET_PAYABLE to ₹1.00 with ₹0.40 approved and nothing paid — still `approved-for-payment`.
mint5c UP6B-CMD-R2 commercial.deduction.release UP6B-R2
$PSQL >/dev/null -c "INSERT INTO \"BillDeductionRelease\"(\"id\",\"projectId\",\"deductionId\",\"amount\",\"reason\",\"releasedById\",\"sourceCommandId\") VALUES('UP6B-R2','p1','UP6B-D1',0.60,'second milestone','USER-1','UP6B-CMD-R2')" \
  && printf 'ok      %s\n' "commercial T6B R1: a fold write that does not move the derived answer is ACCEPTED (coherence, not a ban)" \
  || { printf 'FAILED  %s\n' "commercial T6B R1: a release that leaves the status correct was rejected — the seal is over-strict"; FAIL=1; }
assert "commercial T6B R1: …and the stored column still equals what the database derives" \
  "SELECT (SELECT \"status\" FROM \"VendorBill\" WHERE \"id\"='$UP5C_BILL') || '/' || phase5_t6b_derive_bill_status('p1', '$UP5C_BILL');" \
  "approved-for-payment/approved-for-payment"

# The projection seal, now stated over the FAMILY. Before this unit it named `certified` alone, so a
# bill sitting at another member with its certificate superseded out from under it was
# unrepresentable only by accident — the status was unreachable. It is reachable now, and this bill
# is at `approved-for-payment` with NO cash against it, so §G bound 5 is satisfied and the
# projection rule is the one being tested.
assert_rejects "commercial T6B §F: superseding the certificate an APPROVED-FOR-PAYMENT bill projects" \
  "UPDATE \"BillCertificate\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='forged' WHERE \"id\"='UP6B-C1'" \
  "certificate's projection"
# …and the same correction done coherently in one transaction is ACCEPTED from a member that is NOT
# `certified` — precisely the arrow this unit widened, and the acceptance that makes the refusal
# above evidence rather than mere strictness.
$PSQL >/dev/null -c "BEGIN; UPDATE \"BillCertificate\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='corrected' WHERE \"id\"='UP6B-C1'; UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'; COMMIT;" \
  && printf 'ok      %s\n' "commercial T6B §F: correcting a certificate from a NON-certified family member is ACCEPTED (the widened guard is precise)" \
  || { printf 'FAILED  %s\n' "commercial T6B §F: a coherent supersession from approved-for-payment was refused — the widened arrow is not open"; FAIL=1; }

# A REPLACEMENT certificate, so the cash arrows below have an authority to stand on. The withholding
# above is fully released, so nothing is carried and §H's carry seal is satisfied.
mint5c UP6B-CMD-C2 commercial.bill.certify UP6B-C2
if $PSQL >/dev/null -c "BEGIN; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UP6B-C2','p1','$UP5C_BILL','$UP5C_VER',1.00,'USER-2',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='$UP5C_BILL'),'UP6B-CMD-C2'); INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UP6B-A2EV','p1','UP6B-C2','UP45-ACC',1); UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'; COMMIT;"
then printf 'ok      %s\n' "commercial T6B: the corrected certification stands, and the cash arrows below are not vacuous"
else printf 'FAILED  %s\n' "commercial T6B: could not re-certify — the cash arrows below would be vacuous"; FAIL=1
fi
mint5c UP6B-CMD-A3 commercial.payment.approve UP6B-A3
t6b_arrow "an authority over the corrected certification" certified approved-for-payment \
  "INSERT INTO \"PaymentApproval\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"amount\",\"approvedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UP6B-A3','p1','UP6B-C2','$UP5C_BILL',1.00,'USER-1',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='$UP5C_BILL'),'UP6B-CMD-A3')"
mint5c UP6B-CMD-P1 commercial.payment.record UP6B-P1
t6b_arrow "cash leaving against part of that authority" approved-for-payment part-paid \
  "INSERT INTO \"Payment\"(\"id\",\"projectId\",\"approvalId\",\"billId\",\"amount\",\"method\",\"paidById\",\"sourceCommandId\") VALUES('UP6B-P1','p1','UP6B-A3','$UP5C_BILL',0.40,'neft','USER-1','UP6B-CMD-P1')"
mint5c UP6B-CMD-P2 commercial.payment.record UP6B-P2
t6b_arrow "the balance leaving settles the claim" part-paid paid \
  "INSERT INTO \"Payment\"(\"id\",\"projectId\",\"approvalId\",\"billId\",\"amount\",\"method\",\"paidById\",\"sourceCommandId\") VALUES('UP6B-P2','p1','UP6B-A3','$UP5C_BILL',0.60,'neft','USER-1','UP6B-CMD-P2')"
assert "commercial T6B R1: the DATABASE and the stored column agree after every arrow" \
  "SELECT (SELECT \"status\" FROM \"VendorBill\" WHERE \"id\"='$UP5C_BILL') || '/' || phase5_t6b_derive_bill_status('p1', '$UP5C_BILL');" \
  "paid/paid"

# …and nothing ESCAPES the family except supersession, nor JUMPS into it except `verified ->
# certified`. Each of these differs from an accepted arrow above only in whether one endpoint is
# outside the family, so a rejection here is about membership, not about the UPDATE.
assert_rejects "commercial T6B §F: a derived status escaping FORWARD into the claim lifecycle" \
  "UPDATE \"VendorBill\" SET \"status\"='submitted', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'" \
  'cannot move from'
assert_rejects "commercial T6B §F: rejecting a claim that has already paid out (money left; the claim is not droppable)" \
  "UPDATE \"VendorBill\" SET \"status\"='rejected', \"statusReason\"='too late', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'" \
  'cannot move from'
assert_rejects "commercial T6B §F: CREATING a claim already inside the derived family, skipping every arrow" \
  "INSERT INTO \"VendorBill\"(\"id\",\"projectId\",\"vendorId\",\"vendorBillNumber\",\"documentDate\",\"status\",\"createdById\",\"sourceCommandId\") VALUES('UP6B-XP','p1','UP45-VEN','INV-PAID','2026-08-27','paid','USER-1','UP45-CMD')"
assert_rejects "commercial T6B §F: jumping into the family from OUTSIDE the certification arrow (disputed -> paid)" \
  "UPDATE \"VendorBill\" SET \"status\"='paid', \"statusChangedAt\"=now() WHERE \"id\"='UPT4-B3'" \
  'cannot move from'

# ── the SIXTH fold table, which the first sweep of this correction missed (JagPat) ───────────────
#
# `BillCertificate` is a fold INPUT twice over: `certifiedAmount` feeds NET_PAYABLE, and
# `supersededAt IS NULL` decides which approvals are in APPROVED at all. Superseding a certificate
# and replacing it in ONE otherwise-valid raw transaction therefore moves the folds while writing
# no ledger row and no bill row — the Task-5B projection seal still sees one live certificate beside
# an in-family status, and before the sixth trigger nothing else fired either.
#
# Reached here on a bill that is `paid` with cash standing, so the replacement is refused by §G
# bound 5 rather than by the derivation. The DERIVATION-side refusal, on a claim with an authority
# but no cash, is proven by R1-F5 in `phase5-t6b-status-derivation.test.ts`, which can build that
# state freely; this asserts what the SEAL SET looks like on a migrated legacy database.
assert "commercial T6B R1: the certificate carries the same deferred derivation trigger as the ledger tables" \
  "SELECT t.\"tgname\" || '/' || t.\"tgdeferrable\"::text || '/' || t.\"tginitdeferred\"::text || '/' || p.\"proname\" FROM pg_trigger t JOIN pg_class c ON c.\"oid\" = t.\"tgrelid\" JOIN pg_proc p ON p.\"oid\" = t.\"tgfoid\" WHERE c.\"relname\" = 'BillCertificate' AND t.\"tgname\" = 'BillCertificate_t6b_status_sealed';" \
  "BillCertificate_t6b_status_sealed/true/true/phase5_t6b_fold_status_sealed"

# §0's rule survives the widening: cash already gone is not corrected by correcting a document. The
# bill is `paid` now — a member only this unit made reachable — and 6A's §G bound-5 seal, not
# anything added here, is what refuses the correction. This unit's job was to not weaken it.
assert_rejects "commercial T6B §0: superseding a certificate that has already paid out, from the newly-reachable PAID member" \
  "UPDATE \"BillCertificate\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='too late' WHERE \"id\"='UP6B-C2'" \
  'exceed the'

# The BACKFILL (Codex finding 2) is idempotent — the migration has already run over this database,
# so re-running its expression here must move nothing. A non-zero count would mean the migration
# left the very incoherence it exists to remove.
assert "commercial T6B R1: re-running the migration's backfill over the upgraded database moves NOTHING" \
  "WITH c AS (UPDATE \"VendorBill\" b SET \"status\" = phase5_t6b_derive_bill_status(b.\"projectId\", b.\"id\"), \"statusChangedAt\" = now() WHERE phase5_t6b_derived_bill_status(b.\"status\") AND b.\"status\" <> phase5_t6b_derive_bill_status(b.\"projectId\", b.\"id\") RETURNING 1) SELECT COUNT(*)::text FROM c;" \
  "0"


# ── Task 6B unit ii (§0/§H) — the money coming BACK ──────────────────────────────────────────
#
# The table is CREATED by this migration, so the first thing to prove about the upgrade is that it
# arrived EMPTY over a legacy fixture: `PAID` reads exactly what it read before (Σ payments − 0),
# no stored status moved, and no backfill was needed. A migration that quietly wrote rows here
# would be inventing money.
assert "commercial T6B-ii: the reversal table upgrades ROW-FREE over the legacy fixture" \
  "SELECT COUNT(*)::text FROM \"PaymentReversal\";" \
  "0"
# EXHAUSTIVE over the table's triggers, not a subset — which is why 7B-iii-h's fold-revision
# trigger has to appear here the moment it is attached. That is the assertion working: a new
# trigger on a money table is a thing a reader must be told about, not one that slips in.
assert "commercial T6B-ii: its four seals are installed, with the deferred ones deferred" \
  "SELECT string_agg(t.\"tgname\" || '/' || t.\"tginitdeferred\"::text, ',' ORDER BY t.\"tgname\") FROM pg_trigger t JOIN pg_class c ON c.\"oid\" = t.\"tgrelid\" WHERE c.\"relname\" = 'PaymentReversal' AND NOT t.\"tgisinternal\";" \
  "PaymentReversal_append_only/false,PaymentReversal_bound_sealed/true,PaymentReversal_command_succeeded/true,PaymentReversal_t6b_status_sealed/true,PaymentReversal_touches_bill_lifecycle/false"

# Provenance first, while the payment still has reversible headroom: run after the arrows below and
# the BOUND fires first, so the assertion would pass for the wrong rule. A refusal is only evidence
# of the rule it names.
mint5c UP6BII-CMD-WRONG commercial.payment.record UP6BII-WRONG
assert_rejects "commercial T6B-ii: a reversal citing a receipt of the WRONG command type" \
  "INSERT INTO \"PaymentReversal\"(\"id\",\"projectId\",\"paymentId\",\"billId\",\"amount\",\"reason\",\"reversedById\",\"sourceCommandId\") VALUES('UP6BII-WRONG','p1','UP6B-P1','$UP5C_BILL',0.01,'wrong receipt','USER-1','UP6BII-CMD-WRONG')" \
  'records the command that PRODUCED it'

# The claim above stands at `paid` with ₹1.00 approved and ₹1.00 paid across two rows. Cash coming
# back must move the derivation BACKWARDS, and the arrow helper asserts the state really moved —
# an acceptance is evidence only when it changed something.
mint5c UP6BII-CMD-V1 commercial.payment.reverse UP6BII-V1
t6b_arrow "part of the cash coming back un-settles the claim" paid part-paid \
  "INSERT INTO \"PaymentReversal\"(\"id\",\"projectId\",\"paymentId\",\"billId\",\"amount\",\"reason\",\"reversedById\",\"sourceCommandId\") VALUES('UP6BII-V1','p1','UP6B-P1','$UP5C_BILL',0.40,'wrong account','USER-1','UP6BII-CMD-V1')"
mint5c UP6BII-CMD-V2 commercial.payment.reverse UP6BII-V2
t6b_arrow "the rest coming back leaves the AUTHORITY standing and the cash at zero" part-paid approved-for-payment \
  "INSERT INTO \"PaymentReversal\"(\"id\",\"projectId\",\"paymentId\",\"billId\",\"amount\",\"reason\",\"reversedById\",\"sourceCommandId\") VALUES('UP6BII-V2','p1','UP6B-P2','$UP5C_BILL',0.60,'recall the rest','USER-1','UP6BII-CMD-V2')"

# …and the fold really fell, in the DATABASE's own arithmetic rather than only in the status column
assert "commercial T6B-ii §0: PAID is Σ payments MINUS Σ reversals, at PG" \
  "SELECT (COALESCE((SELECT SUM(\"amount\") FROM \"Payment\" WHERE \"billId\"='$UP5C_BILL'),0) - COALESCE((SELECT SUM(\"amount\") FROM \"PaymentReversal\" WHERE \"billId\"='$UP5C_BILL'),0))::text;" \
  "0.00"

# §0's correction ORDERING, which is the reason this unit exists. The SAME supersession that was
# refused above — while ₹1.00 stood paid — is now PERMITTED, because the cash was recovered by its
# own attributable act first. This is the acceptance half: a seal that only ever refuses has not
# been shown to be right.
# …in ONE transaction, because a certificate and the status it projects move together (5B's seal):
# superseding alone takes APPROVED to 0 and the derivation with it, which the derivation seal
# correctly refuses. The service does both in one transaction and so does this.
if $PSQL >/dev/null 2>&1 -c "BEGIN; UPDATE \"BillCertificate\" SET \"supersededAt\"=now(), \"supersededById\"='USER-1', \"supersedeReason\"='corrected after full recovery' WHERE \"id\"='UP6B-C2'; UPDATE \"VendorBill\" SET \"status\"='verified', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'; COMMIT;"
then printf 'ok      %s\n' "commercial T6B-ii §0: with PAID recovered to zero the correction is PERMITTED (reverse in full, THEN supersede)"
else printf 'FAILED  %s\n' "commercial T6B-ii §0: the correction is still refused after a full reversal — the bound's PAID twin was not widened, so the reversal unlocks nothing"; FAIL=1
fi

# the four forgeries this table must refuse, each otherwise well-formed
mint5c UP6BII-CMD-NEG commercial.payment.reverse UP6BII-NEG
assert_rejects "commercial T6B-ii §H: a NEGATIVE reversal (direction belongs to the row TYPE, not its sign)" \
  "INSERT INTO \"PaymentReversal\"(\"id\",\"projectId\",\"paymentId\",\"billId\",\"amount\",\"reason\",\"reversedById\",\"sourceCommandId\") VALUES('UP6BII-NEG','p1','UP6B-P1','$UP5C_BILL',-0.10,'a negative reversal','USER-1','UP6BII-CMD-NEG')" \
  'PaymentReversal_amount_positive'
mint5c UP6BII-CMD-BLANK commercial.payment.reverse UP6BII-BLANK
assert_rejects "commercial T6B-ii §H: a BLANK reason (recovering cash is an attributable act, and this row cannot acquire one later)" \
  "INSERT INTO \"PaymentReversal\"(\"id\",\"projectId\",\"paymentId\",\"billId\",\"amount\",\"reason\",\"reversedById\",\"sourceCommandId\") VALUES('UP6BII-BLANK','p1','UP6B-P1','$UP5C_BILL',0.10,'   ','USER-1','UP6BII-CMD-BLANK')" \
  'PaymentReversal_reason_nonblank'
mint5c UP6BII-CMD-OVER commercial.payment.reverse UP6BII-OVER
assert_rejects "commercial T6B-ii §0: returning MORE than that payment moved" \
  "INSERT INTO \"PaymentReversal\"(\"id\",\"projectId\",\"paymentId\",\"billId\",\"amount\",\"reason\",\"reversedById\",\"sourceCommandId\") VALUES('UP6BII-OVER','p1','UP6B-P1','$UP5C_BILL',0.10,'one paisa too many','USER-1','UP6BII-CMD-OVER')" \
  'which moved only'
assert_rejects "commercial T6B-ii: EDITING a reversal (money that came back is evidence)" \
  "UPDATE \"PaymentReversal\" SET \"amount\"=0.01 WHERE \"id\"='UP6BII-V1'" \
  'append-only'
assert_rejects "commercial T6B-ii: DELETING one" \
  "DELETE FROM \"PaymentReversal\" WHERE \"id\"='UP6BII-V1'" \
  'append-only'


# ── Task 6C (§H) — the ADVANCE, and the recovery that draws it down ──────────────────────────
#
# Both the table and the enum member are NEW here, so the first thing to prove about the upgrade is
# that they arrive with nothing already claiming them: no advances, and no `advance-recovery`
# deduction (5C's CHECK made the type inadmissible, so a pre-existing one would be a withholding
# that was never bounded by cash and whose ceiling cannot be reconstructed).
assert "commercial T6C: the advance table upgrades ROW-FREE over the legacy fixture" \
  "SELECT COUNT(*)::text FROM \"VendorAdvance\";" \
  "0"
assert "commercial T6C: …and no advance-recovery predates the row that caps it" \
  "SELECT COUNT(*)::text FROM \"BillDeduction\" WHERE \"type\" = 'advance-recovery';" \
  "0"
assert "commercial T6C §H: the widened type set admits the new member and nothing else" \
  "SELECT (SELECT COUNT(*) FROM pg_constraint WHERE conname='BillDeduction_type_known' AND pg_get_constraintdef(\"oid\") LIKE '%advance-recovery%')::text;" \
  "1"
assert "commercial T6C: its seals are installed, with the deferred one deferred" \
  "SELECT string_agg(t.\"tgname\" || '/' || t.\"tginitdeferred\"::text, ',' ORDER BY t.\"tgname\") FROM pg_trigger t JOIN pg_class c ON c.\"oid\" = t.\"tgrelid\" WHERE c.\"relname\" = 'VendorAdvance' AND NOT t.\"tgisinternal\";" \
  "VendorAdvance_append_only/false,VendorAdvance_command_succeeded/true"
assert "commercial T6C: the recovery CEILING fires from the deduction table, deferred to commit" \
  "SELECT t.\"tgname\" || '/' || t.\"tgdeferrable\"::text || '/' || t.\"tginitdeferred\"::text || '/' || p.\"proname\" FROM pg_trigger t JOIN pg_class c ON c.\"oid\" = t.\"tgrelid\" JOIN pg_proc p ON p.\"oid\" = t.\"tgfoid\" WHERE c.\"relname\" = 'BillDeduction' AND t.\"tgname\" = 'BillDeduction_advance_bound_sealed';" \
  "BillDeduction_advance_bound_sealed/true/true/phase5_t6c_recovery_bound_sealed"

# an advance that is not bounded by anything, then the recovery it caps. The claim used here is the
# one the 6B block left at `verified` after its supersession, so it is re-certified first — the
# arrows below would otherwise be vacuous.
mint5c UP6C-CMD-C3 commercial.bill.certify UP6C-C3
if $PSQL >/dev/null -c "BEGIN; INSERT INTO \"BillCertificate\"(\"id\",\"projectId\",\"billId\",\"versionId\",\"certifiedAmount\",\"certifiedById\",\"reviewedLifecycleVersion\",\"sourceCommandId\") VALUES('UP6C-C3','p1','$UP5C_BILL','$UP5C_VER',1.00,'USER-2',(SELECT r.\"revision\" FROM \"VendorBillRevision\" r WHERE r.\"projectId\"='p1' AND r.\"billId\"='$UP5C_BILL'),'UP6C-CMD-C3'); INSERT INTO \"CertifiedAcceptanceConsumption\"(\"id\",\"projectId\",\"certificateId\",\"stockTransactionId\",\"consumedQty\") VALUES('UP6C-A3EV','p1','UP6C-C3','UP45-ACC',1); UPDATE \"VendorBill\" SET \"status\"='certified', \"statusChangedAt\"=now() WHERE \"id\"='$UP5C_BILL'; COMMIT;"
then printf 'ok      %s\n' "commercial T6C: a live certificate stands again, so the recovery arrows below are not vacuous"
else printf 'FAILED  %s\n' "commercial T6C: could not re-certify — the recovery arrows below would be vacuous"; FAIL=1
fi

# a recovery with NO advance behind it is refused — the arm that makes the whole task necessary,
# because without it the sign, fold and status probes all pass while the vendor is underpaid
mint5c UP6C-CMD-D0 commercial.deduction.record UP6C-D0
assert_rejects "commercial T6C §H: recovering against an advance that was never paid" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP6C-D0','p1','UP6C-C3','$UP5C_BILL','advance-recovery',0.50,'USER-1','UP6C-CMD-D0')" \
  'there is no more of it to take'

mint5c UP6C-CMD-ADV commercial.advance.pay UP6C-ADV
if $PSQL >/dev/null -c "INSERT INTO \"VendorAdvance\"(\"id\",\"projectId\",\"vendorId\",\"amount\",\"reason\",\"method\",\"paidById\",\"sourceCommandId\") VALUES('UP6C-ADV','p1','UP45-VEN',1.00,'mobilisation','neft','USER-1','UP6C-CMD-ADV')"
then printf 'ok      %s\n' "commercial T6C §H: a coherent advance to a BOUND counterparty is ACCEPTED (the seals are precise, not merely strict)"
else printf 'FAILED  %s\n' "commercial T6C §H: a legitimate advance was refused"; FAIL=1
fi

# …and NOW the recovery fits. The arrow helper asserts the status really moved: a ₹1 certificate
# offset entirely by a ₹1 recovery leaves NET_PAYABLE = PAID = 0, which §F's FIRST arm calls `paid`
# with no cash having moved (the plan's 5bs, on the upgraded database).
mint5c UP6C-CMD-D1 commercial.deduction.record UP6C-D1
t6b_arrow "a fully-offset certificate is settled at zero by an advance recovery" certified paid \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP6C-D1','p1','UP6C-C3','$UP5C_BILL','advance-recovery',1.00,'USER-1','UP6C-CMD-D1')"

assert "commercial T6C §H: RECOVERABLE is Σ advances MINUS the unreleased recovery on LIVE certificates" \
  "SELECT (COALESCE((SELECT SUM(\"amount\") FROM \"VendorAdvance\" WHERE \"vendorId\"='UP45-VEN'),0) - COALESCE((SELECT SUM(d.\"amount\") FROM \"BillDeduction\" d JOIN \"BillCertificate\" c ON c.\"id\"=d.\"certificateId\" JOIN \"VendorBill\" b ON b.\"id\"=d.\"billId\" WHERE b.\"vendorId\"='UP45-VEN' AND d.\"type\"='advance-recovery' AND c.\"supersededAt\" IS NULL),0))::text;" \
  "0.00"

# …and one paisa more is refused, cumulatively
mint5c UP6C-CMD-D2 commercial.deduction.record UP6C-D2
assert_rejects "commercial T6C §H: a CUMULATIVE overshoot, after the pool is spent" \
  "INSERT INTO \"BillDeduction\"(\"id\",\"projectId\",\"certificateId\",\"billId\",\"type\",\"amount\",\"recordedById\",\"sourceCommandId\") VALUES('UP6C-D2','p1','UP6C-C3','$UP5C_BILL','advance-recovery',0.01,'USER-1','UP6C-CMD-D2')" \
  'there is no more of it to take'

# the advance fact's own seals, each otherwise well-formed
mint5c UP6C-CMD-NEG commercial.advance.pay UP6C-NEG
assert_rejects "commercial T6C §H: a NEGATIVE advance (direction belongs to the row TYPE, not its sign)" \
  "INSERT INTO \"VendorAdvance\"(\"id\",\"projectId\",\"vendorId\",\"amount\",\"reason\",\"method\",\"paidById\",\"sourceCommandId\") VALUES('UP6C-NEG','p1','UP45-VEN',-1.00,'a negative advance','neft','USER-1','UP6C-CMD-NEG')" \
  'VendorAdvance_amount_positive'
mint5c UP6C-CMD-BLANK commercial.advance.pay UP6C-BLANK
assert_rejects "commercial T6C §H: a BLANK reason (an advance nobody can explain is a payment with no story)" \
  "INSERT INTO \"VendorAdvance\"(\"id\",\"projectId\",\"vendorId\",\"amount\",\"reason\",\"method\",\"paidById\",\"sourceCommandId\") VALUES('UP6C-BLANK','p1','UP45-VEN',1.00,'   ','neft','USER-1','UP6C-CMD-BLANK')" \
  'VendorAdvance_reason_nonblank'
mint5c UP6C-CMD-UNBOUND commercial.advance.pay UP6C-UNBOUND
assert_rejects "commercial T6C §H: an advance to a counterparty this project never bound" \
  "INSERT INTO \"VendorAdvance\"(\"id\",\"projectId\",\"vendorId\",\"amount\",\"reason\",\"method\",\"paidById\",\"sourceCommandId\") VALUES('UP6C-UNBOUND','p1','UPT4-VEN',1.00,'wrong project','neft','USER-1','UP6C-CMD-UNBOUND')" \
  'VendorAdvance_binding_fkey'
assert_rejects "commercial T6C: EDITING an advance (cash that left is evidence)" \
  "UPDATE \"VendorAdvance\" SET \"amount\"=99.00 WHERE \"id\"='UP6C-ADV'" \
  'append-only'
assert_rejects "commercial T6C: DELETING one" \
  "DELETE FROM \"VendorAdvance\" WHERE \"id\"='UP6C-ADV'" \
  'append-only'
mint5c UP6C-CMD-WRONG commercial.payment.record UP6C-WRONG
assert_rejects "commercial T6C: an advance citing a receipt of the WRONG command type" \
  "INSERT INTO \"VendorAdvance\"(\"id\",\"projectId\",\"vendorId\",\"amount\",\"reason\",\"method\",\"paidById\",\"sourceCommandId\") VALUES('UP6C-WRONG','p1','UP45-VEN',1.00,'wrong receipt','neft','USER-1','UP6C-CMD-WRONG')" \
  'records the command that PRODUCED it'

# ── Phase 5 Task 7A — the EIGHTH rebuildable projection store (§J). A purely additive, row-free
#    capability add: the generation-scoped CashForecastProjection table exists and holds ZERO rows
#    over the legacy DB. The migration NEVER writes data — the money picture is recomputed from
#    canonical facts by the consumer, the write-through refresh and the operator rebuild alike, so
#    an empty table on the first deploy is correct rather than a gap.
assert "the Phase-5 Task-7A CashForecastProjection table exists and is ROW-FREE over the legacy DB" \
  "SELECT (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'CashForecastProjection')::text || '|' || (SELECT COUNT(*) FROM \"CashForecastProjection\")::text;" \
  "1|0"
# …and the generation-scoped uniqueness that makes an upsert-per-(generation, project) safe is
# installed. Without it two consumers racing the same project would insert two rows and the read
# would serve whichever it found first.
assert "the Task-7A (generationId, projectId) unique is installed" \
  "SELECT COUNT(*)::text FROM pg_indexes WHERE indexname = 'CashForecastProjection_generationId_projectId_key';" \
  "1"

# ── Phase 6 unit 6.1a — the CANONICAL EXTERNAL PARTY (§A), its promotion seam (§E) and its
#    tenancy seals (§F). Unlike most sections here this one migrates EXISTING DATA: every legacy
#    `Vendor`, `ProjectVendor` and `ProjectCompany` gains a party, and the assertions below read
#    what the backfill actually wrote rather than that it ran.
assert "6.1a: every legacy directory row and vendor got a party — and the backfill MERGED NOTHING" \
  "SELECT (SELECT COUNT(*) FROM \"ProjectCompany\" WHERE \"partyId\" IS NULL)::text || '|' || (SELECT COUNT(*) FROM \"Vendor\" WHERE \"partyId\" IS NULL)::text || '|' || (SELECT COUNT(DISTINCT \"partyId\") FROM \"ProjectCompany\")::text || '|' || (SELECT COUNT(*) FROM \"ProjectCompany\")::text;" \
  "0|0|2|2"
# The derivation is per-ROW and per-VENDOR, so two firms are never guessed to be one — deciding
# that is a human judgement, and 6.1 ships the operator merge instead of guessing it.
assert "6.1a: each backfilled party is derived from its OWN row, and the org copy is the PROJECT's" \
  "SELECT c.\"partyId\" || '|' || c.\"orgId\" || '|' || p.\"orgId\" || '|' || p.\"name\" FROM \"ProjectCompany\" c JOIN \"ExternalParty\" p ON p.\"id\" = c.\"partyId\" WHERE c.\"id\" = 'UP6-CO1';" \
  "p6c_UP6-CO1|org-legacy|org-legacy|Legacy Architects"
assert "6.1a: a binding's party copy is provably its VENDOR's, not one of its own" \
  "SELECT (SELECT COUNT(*) FROM \"ProjectVendor\" b JOIN \"Vendor\" v ON v.\"id\" = b.\"vendorId\" WHERE b.\"partyId\" <> v.\"partyId\")::text;" \
  "0"
# The association mirror is orgs-owned and is what the collaborator resolver will read, so the
# backfill has to have produced it for BOTH origin kinds — and nothing unjustified.
assert "6.1a: every legacy origin produced a SOURCED association, and no association is unsourced" \
  "SELECT (SELECT COUNT(*) FROM \"ProjectPartyCompanySource\")::text || '|' || (SELECT COUNT(*) FROM \"ProjectPartyVendorSource\")::text || '|' || (SELECT COUNT(*) FROM \"ProjectParty\" pp WHERE NOT EXISTS (SELECT 1 FROM \"ProjectPartyCompanySource\" s WHERE s.\"projectId\" = pp.\"projectId\" AND s.\"partyId\" = pp.\"partyId\") AND NOT EXISTS (SELECT 1 FROM \"ProjectPartyVendorSource\" s WHERE s.\"projectId\" = pp.\"projectId\" AND s.\"partyId\" = pp.\"partyId\"))::text;" \
  "2|4|0"
assert "6.1a: nothing in Phase 6 promotes a party — the §E seam ships EMPTY" \
  "SELECT COUNT(*)::text FROM \"ExternalParty\" WHERE \"promotedOrgId\" IS NOT NULL;" \
  "0"

# A SECOND owner org, so the §F cross-tenant probes have a real other tenant rather than a
# hypothetical one. Its own project and party are legitimate; only the PAIRINGS below are hostile.
$PSQL >/dev/null <<'SQL' || { echo "FAILED  phase-6 cross-tenant fixture did not apply"; FAIL=1; }
BEGIN;
INSERT INTO "Org"("id","name","slug") VALUES ('org-p6','P6 Other Tenant','p6-other-org');
INSERT INTO "Project"("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES('p6b','org-p6','Other Tenant Site','OT','','Finishing','OT-01','01 Jan 2026','31 Dec 2026',10,5,10);
INSERT INTO "ExternalParty"("id","orgId","name") VALUES('pty_UP6-FOREIGN','org-p6','Foreign Firm');
COMMIT;
SQL

# §F — a cross-tenant pairing is UNREPRESENTABLE on every reference, each by its own named seal.
assert_rejects "6.1a §F: an association pairing an org-legacy project with an org-p6 party" \
  "INSERT INTO \"ProjectParty\"(\"id\",\"orgId\",\"projectId\",\"partyId\") VALUES('UP6-XP','org-p6','p1','pty_UP6-FOREIGN')" \
  'ProjectParty_orgId_projectId_fkey'
assert_rejects "6.1a §F: a directory row keeping its project on org-legacy while claiming org-p6" \
  "INSERT INTO \"ProjectCompany\"(\"id\",\"projectId\",\"orgId\",\"partyId\",\"name\",\"kind\") VALUES('UP6-XC1','p1','org-p6','pty_UP6-FOREIGN','Smuggled','other')" \
  'ProjectCompany_orgId_projectId_fkey'
assert_rejects "6.1a §F: a same-org directory row pointing at a party from another org" \
  "INSERT INTO \"ProjectCompany\"(\"id\",\"projectId\",\"orgId\",\"partyId\",\"name\",\"kind\") VALUES('UP6-XC2','p1','org-legacy','pty_UP6-FOREIGN','Smuggled','other')" \
  'ProjectCompany_orgId_partyId_fkey'
assert_rejects "6.1a §F: a vendor claiming another org's party" \
  "INSERT INTO \"Vendor\"(\"id\",\"orgId\",\"name\",\"createdById\",\"partyId\") VALUES('UP6-XV','org-legacy','Smuggled Vendor','USER-1','pty_UP6-FOREIGN')" \
  'Vendor_orgId_partyId_fkey'
# Same org, still refused: the binding's copy is bound THROUGH the vendor, so it cannot name a
# party the vendor does not hold — which is what stops a binding from mirroring the wrong firm.
assert_rejects "6.1a §F: a binding whose party copy is not its OWN vendor's" \
  "INSERT INTO \"ProjectVendor\"(\"id\",\"projectId\",\"orgId\",\"vendorId\",\"boundById\",\"partyId\") VALUES('UP6-XPV','p1','org-legacy','UPT4-VEN','USER-1','p6c_UP6-CO1')" \
  'ProjectVendor_orgId_vendorId_partyId_fkey'

# §A — the association exists only while something SOURCES it, and the seal fires in BOTH
# directions: on the association appearing, and on its last justification leaving.
assert_rejects "6.1a §A: an association with nothing justifying it (refused at COMMIT)" \
  "INSERT INTO \"ExternalParty\"(\"id\",\"orgId\",\"name\") VALUES('pty_UP6-BARE','org-legacy','Bare'); INSERT INTO \"ProjectParty\"(\"id\",\"orgId\",\"projectId\",\"partyId\") VALUES('UP6-BARE','org-legacy','p1','pty_UP6-BARE')" \
  'has no source justifying it'
assert_rejects "6.1a §A: deleting the last source without releasing the association" \
  "DELETE FROM \"ProjectCompany\" WHERE \"id\" = 'UP6-CO1'" \
  'has no source justifying it'
# …and the POSITIVE control, because a seal that refuses everything proves nothing: the legitimate
# order — association first, then the source that justifies it — commits, which is what makes the
# constraint DEFERRED rather than merely present.
$PSQL >/dev/null <<'SQL' || { echo "FAILED  phase-6: a COHERENT party chain was refused — the seals are too strict"; FAIL=1; }
BEGIN;
INSERT INTO "ExternalParty"("id","orgId","name") VALUES('pty_UP6-OK','org-legacy','Coherent Firm');
INSERT INTO "ProjectParty"("id","orgId","projectId","partyId") VALUES('UP6-OK','org-legacy','p1','pty_UP6-OK');
INSERT INTO "ProjectCompany"("id","projectId","orgId","partyId","name","kind") VALUES('UP6-OKC','p1','org-legacy','pty_UP6-OK','Coherent Firm','contractor');
INSERT INTO "ProjectPartyCompanySource"("id","orgId","projectId","partyId","projectCompanyId") VALUES('UP6-OKS','org-legacy','p1','pty_UP6-OK','UP6-OKC');
COMMIT;
SQL
assert "6.1a §A: the coherent chain was ACCEPTED, so the seals are precise rather than blanket" \
  "SELECT COUNT(*)::text FROM \"ProjectParty\" WHERE \"id\" = 'UP6-OK';" \
  "1"

# §A — one party, one directory row and one binding PER PROJECT. 6.1b's merge repoints `partyId`,
# and after that `(projectId, vendorId)` no longer implies this; the seal is what makes the merge's
# same-project refusal enforceable instead of a rule it is trusted to remember.
assert_rejects "6.1a §A: a second directory row for the same party on one project" \
  "INSERT INTO \"ProjectCompany\"(\"id\",\"projectId\",\"orgId\",\"partyId\",\"name\",\"kind\") VALUES('UP6-DUPC','p1','org-legacy','pty_UP6-OK','Coherent Firm (again)','contractor')" \
  'ProjectCompany_projectId_partyId_key'
$PSQL >/dev/null <<'SQL' || { echo "FAILED  phase-6: the shared-party vendor fixture did not apply"; FAIL=1; }
INSERT INTO "Vendor"("id","orgId","name","createdById","partyId") VALUES('UP6-VSHARE','org-legacy','Merged Twin','USER-1','pty_UP45-VEN');
SQL
assert_rejects "6.1a §A: a second binding for the same party on one project (different vendors)" \
  "INSERT INTO \"ProjectVendor\"(\"id\",\"projectId\",\"orgId\",\"vendorId\",\"boundById\",\"partyId\") VALUES('UP6-DUPPV','p1','org-legacy','UP6-VSHARE','USER-1','pty_UP45-VEN')" \
  'ProjectVendor_projectId_partyId_key'

# §E — the seam ships FROZEN. The promotion command is deferred, so the ONLY thing that could move
# a promoted party is a retry, a repair or a migration; both halves are sealed from day one.
$PSQL >/dev/null <<'SQL' || { echo "FAILED  phase-6: null -> org promotion was refused, but it is the one permitted transition"; FAIL=1; }
UPDATE "ExternalParty" SET "promotedOrgId" = 'org-p6' WHERE "id" = 'pty_UP6-OK';
SQL
assert_rejects "6.1a §E: MOVING a promoted party to another tenant" \
  "UPDATE \"ExternalParty\" SET \"promotedOrgId\" = 'org-legacy' WHERE \"id\" = 'pty_UP6-OK'" \
  'promotion cannot be moved or cleared'
assert_rejects "6.1a §E: CLEARING a promotion" \
  "UPDATE \"ExternalParty\" SET \"promotedOrgId\" = NULL WHERE \"id\" = 'pty_UP6-OK'" \
  'promotion cannot be moved or cleared'
assert_rejects "6.1a §E: one owner org holding TWO parties resolving to the same tenant" \
  "UPDATE \"ExternalParty\" SET \"promotedOrgId\" = 'org-p6' WHERE \"id\" = 'p6c_UP6-CO1'" \
  'ExternalParty_orgId_promotedOrgId_key'
# …and the negative control that proves the uniqueness is scoped to the OWNER org rather than
# global: a DIFFERENT owner linking its own local party to the same tenant is the case §A exists
# to support, and a global unique would have refused it.
$PSQL >/dev/null <<'SQL' || { echo "FAILED  phase-6: a second OWNER org's link to the same tenant was refused — the unique is global, not scoped"; FAIL=1; }
INSERT INTO "ExternalParty"("id","orgId","name","promotedOrgId") VALUES('pty_UP6-OTHEROWNER','org-p6','Same firm, other owner','org-p6');
SQL
assert "6.1a §E: two OWNER orgs may each link their own local party to one tenant" \
  "SELECT COUNT(*)::text FROM \"ExternalParty\" WHERE \"promotedOrgId\" = 'org-p6';" \
  "2"

# ── the review corrections (C3, C4, C5, C8) over the MIGRATED legacy database ──────────────────
#    Added because the first run of this section passed at exactly the same assertion count after
#    the correction landed: the migration still applied and every OLD seal still held, which says
#    nothing at all about the four seals the correction introduced. A gate that cannot notice the
#    change it is being run for is not evidence.

# C3 — the firm name a person reads before granting access cannot be whitespace.
assert_rejects "6.1a C3: a party whose name is only spaces" \
  "INSERT INTO \"ExternalParty\"(\"id\",\"orgId\",\"name\") VALUES('pty_UP6-BLANK','org-legacy','   ')" \
  'ExternalParty_name_not_blank'
assert_rejects "6.1a C3: …or only tabs and newlines (btrim alone strips neither)" \
  "INSERT INTO \"ExternalParty\"(\"id\",\"orgId\",\"name\") VALUES('pty_UP6-BLANK2','org-legacy',E'\\t\\n\\r ')" \
  'ExternalParty_name_not_blank'
$PSQL >/dev/null <<'SQL' || { echo "FAILED  phase-6 C3: a name with INTERNAL whitespace was refused — the CHECK is too strict"; FAIL=1; }
INSERT INTO "ExternalParty"("id","orgId","name") VALUES('pty_UP6-SPACED','org-legacy','A C M E  Ltd');
SQL
assert "6.1a C3: a real firm name containing spaces is ACCEPTED" \
  "SELECT COUNT(*)::text FROM \"ExternalParty\" WHERE \"id\" = 'pty_UP6-SPACED';" \
  "1"

# C5 — the promotion target is a real tenant. Without the reference the one-way trigger would
# freeze a typo permanently, since correcting it IS the transition the trigger refuses.
assert_rejects "6.1a C5: promoting a party to an org that does not exist" \
  "UPDATE \"ExternalParty\" SET \"promotedOrgId\" = 'org-does-not-exist' WHERE \"id\" = 'pty_UP6-SPACED'" \
  'ExternalParty_promotedOrgId_fkey'

# C4 — a source REPOINTED onto another party rechecks the association it LEFT. This is how 6.1b's
# merge moves a source, and the seal previously fired only on DELETE.
assert_rejects "6.1a C4: repointing a company source strands the association it abandoned" \
  "UPDATE \"ProjectCompany\" SET \"partyId\" = 'pty_UP45-VEN' WHERE \"id\" = 'UP6-OKC'" \
  'has no source justifying it'

# C8 — and the repoint a merge legitimately needs must WORK. A bound vendor moving onto a
# surviving party, with the target association created first and the abandoned one released, is
# the whole shape of 6.1b; with the binding's key frozen it was impossible in either order.
$PSQL >/dev/null <<'SQL' || { echo "FAILED  phase-6 C8: a BOUND vendor could not be repointed — 6.1b's merge cannot run"; FAIL=1; }
BEGIN;
INSERT INTO "ExternalParty"("id","orgId","name") VALUES('pty_UP6-SURVIVOR','org-legacy','Surviving Firm');
INSERT INTO "ProjectParty"("id","orgId","projectId","partyId") VALUES('UP6-SURV','org-legacy','p1','pty_UP6-SURVIVOR');
UPDATE "Vendor" SET "partyId" = 'pty_UP6-SURVIVOR' WHERE "id" = 'UP45-VEN';
DELETE FROM "ProjectParty" WHERE "projectId" = 'p1' AND "partyId" = 'pty_UP45-VEN';
COMMIT;
SQL
# E1 — the ORIGIN side of the obligation. A source needs an origin (FK) and an association needs
# a source (trigger); nothing required an ORIGIN to have a source, so a directory row written
# outside its service committed with no association and the resolver could not see the firm.
# Added because the previous round's extension taught the lesson and this round repeated it: the
# proof passed the E-round correction at exactly 534 assertions, unchanged, having tested none of
# it.
assert_rejects "6.1a E1: a directory row naming a party with no source recording it" \
  "INSERT INTO \"ExternalParty\"(\"id\",\"orgId\",\"name\") VALUES('pty_UP6-ORPHAN','org-legacy','Invisible Firm'); INSERT INTO \"ProjectCompany\"(\"id\",\"projectId\",\"orgId\",\"partyId\",\"name\",\"kind\") VALUES('UP6-ORPHANC','p1','org-legacy','pty_UP6-ORPHAN','Invisible Firm','other')" \
  'no source row recording it'
assert_rejects "6.1a E1: …and a vendor binding with the same gap" \
  "INSERT INTO \"ProjectVendor\"(\"id\",\"projectId\",\"orgId\",\"vendorId\",\"boundById\",\"partyId\") VALUES('UP6-ORPHANV','p1','org-legacy','UPT4-VEN','USER-1','p6v_UPT4-VEN')" \
  'no source row recording it'

assert "6.1a C8: the binding AND its source followed the vendor onto the surviving party" \
  "SELECT (SELECT \"partyId\" FROM \"ProjectVendor\" WHERE \"id\" = 'UP45-PV') || '|' || (SELECT \"partyId\" FROM \"ProjectPartyVendorSource\" WHERE \"projectVendorId\" = 'UP45-PV') || '|' || (SELECT COUNT(*)::text FROM \"ProjectParty\" WHERE \"projectId\" = 'p1' AND \"partyId\" = 'pty_UP45-VEN');" \
  "pty_UP6-SURVIVOR|pty_UP6-SURVIVOR|0"

# F1 — the obligation E1 seals is breakable from the OTHER end. Removing a source ran only the
# association check, which counts sources for the (project, party) pair of EITHER kind: for a firm
# reached both ways on one project it sees the sibling row, is satisfied, and lets the company's
# source go — leaving the `ProjectCompany` carrying a party nothing records. The firm is then
# invisible to the resolver, and `renamePartyForSoleSource` (which computes `sources - 1`, reading
# "one of these is me") counts the vendor's row as the caller's own and renames a firm the binding
# depends on.
$PSQL >/dev/null <<'SQL' || { echo "FAILED  phase-6 F1: the both-ways fixture did not apply"; FAIL=1; }
BEGIN;
INSERT INTO "ExternalParty"("id","orgId","name") VALUES('pty_UP6-BOTH','org-legacy','Both Ways Ltd');
INSERT INTO "ProjectParty"("id","orgId","projectId","partyId") VALUES('UP6-BOTH','org-legacy','p1','pty_UP6-BOTH');
INSERT INTO "ProjectCompany"("id","projectId","orgId","partyId","name","kind") VALUES('UP6-BOTHC','p1','org-legacy','pty_UP6-BOTH','Both Ways Ltd','contractor');
INSERT INTO "ProjectPartyCompanySource"("id","orgId","projectId","partyId","projectCompanyId") VALUES('UP6-BOTHCS','org-legacy','p1','pty_UP6-BOTH','UP6-BOTHC');
INSERT INTO "Vendor"("id","orgId","name","createdById","partyId") VALUES('UP6-VBOTH','org-legacy','Both Ways Ltd','USER-1','pty_UP6-BOTH');
INSERT INTO "ProjectVendor"("id","projectId","orgId","vendorId","boundById","partyId") VALUES('UP6-BOTHPV','p1','org-legacy','UP6-VBOTH','USER-1','pty_UP6-BOTH');
INSERT INTO "ProjectPartyVendorSource"("id","orgId","projectId","partyId","projectVendorId") VALUES('UP6-BOTHVS','org-legacy','p1','pty_UP6-BOTH','UP6-BOTHPV');
COMMIT;
SQL
assert_rejects "6.1a F1: stripping a directory row's source while a sibling binding keeps the association alive" \
  "DELETE FROM \"ProjectPartyCompanySource\" WHERE \"id\" = 'UP6-BOTHCS'" \
  'no source row recording it'
assert_rejects "6.1a F1: …and the same from the binding's side" \
  "DELETE FROM \"ProjectPartyVendorSource\" WHERE \"id\" = 'UP6-BOTHVS'" \
  'no source row recording it'
assert "6.1a F1: both refusals left every origin still justified" \
  "SELECT (SELECT COUNT(*)::text FROM \"ProjectPartyCompanySource\" WHERE \"projectCompanyId\" = 'UP6-BOTHC') || '|' || (SELECT COUNT(*)::text FROM \"ProjectPartyVendorSource\" WHERE \"projectVendorId\" = 'UP6-BOTHPV');" \
  "1|1"
# …and the POSITIVE control that matters most for this arm: the legitimate removal deletes the
# ORIGIN, whose cascade takes the source with it. A check that fired on "a source row vanished"
# would refuse every company deletion in the product; this one asks whether the origin is sourced
# AT COMMIT, where there is no origin left to owe anything.
$PSQL >/dev/null <<'SQL' || { echo "FAILED  phase-6 F1: deleting a company cascaded its source and was REFUSED — the new arm fires on the legitimate path"; FAIL=1; }
DELETE FROM "ProjectCompany" WHERE "id" = 'UP6-BOTHC';
SQL
assert "6.1a F1: the company and its source are gone, the association survives on the binding" \
  "SELECT (SELECT COUNT(*)::text FROM \"ProjectPartyCompanySource\" WHERE \"projectCompanyId\" = 'UP6-BOTHC') || '|' || (SELECT COUNT(*)::text FROM \"ProjectParty\" WHERE \"id\" = 'UP6-BOTH');" \
  "0|1"


# ---- Phase 6 task 4a: decisions.withdraw — enum + evidence + the three seals + the subject backfill ----
echo ""
echo "=== Phase 6 task 4a: the withdraw seals over the migrated legacy DB ==="

assert "4a: legacy DB upgrades ROW-FREE (no withdrawn rows) with the four Decision seals (incl. the round-3 delete arm), the reverse-arm trigger, and the attribution FK installed" \
  "SELECT (SELECT COUNT(*) FROM \"Decision\" WHERE \"status\"::text='withdrawn')::text || '|' || (SELECT COUNT(*) FROM pg_trigger WHERE tgname IN ('Decision_t4a_a_terminal','Decision_t4a_b_entry','Decision_t4a_c_coherent','Decision_t4a_d_no_delete','DecisionApprovalRevision_no_withdrawn'))::text || '|' || (SELECT COUNT(*) FROM pg_constraint WHERE conname='Decision_projectId_withdrawnById_fkey')::text || '|' || (SELECT COUNT(*) FROM information_schema.columns WHERE table_name='Notification' AND column_name='decisionId')::text || '|' || (SELECT COUNT(*) FROM information_schema.columns WHERE table_name='OutboxDelivery' AND column_name IN ('subject','cancelledAt'))::text;" \
  "0|5|1|1|2"

# the attribution FK target (idempotent), and two published pending decisions minted for the probes
$PSQL -q >/dev/null <<'SQL'
INSERT INTO "Membership"("id","projectId","userId","role","status") VALUES ('UP4A-M1','p1','USER-1','pmc','active') ON CONFLICT DO NOTHING;
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
VALUES ('UP4A-D1','p1','Withdrawable','Hall','pending','stone',now()),
       ('UP4A-D2','p1','Still pending','Hall','pending','stone',now());
SQL

$PSQL -q -c "UPDATE \"Decision\" SET \"status\"='withdrawn', \"withdrawnAt\"=now(), \"withdrawnById\"='USER-1', \"withdrawnByName\"='Legacy PMC', \"withdrawReason\"='asked in error' WHERE \"id\"='UP4A-D1';" >/dev/null \
  || { echo "FAILED  4a: the COHERENT withdrawal was refused — the seals are blanket, not precise"; FAIL=1; }
assert "4a: a COHERENT withdrawal of a published pending decision by a REAL member is ACCEPTED — the seals are precise, not blanket" \
  "SELECT \"status\"::text FROM \"Decision\" WHERE \"id\"='UP4A-D1';" \
  "withdrawn"

assert_rejects "4a seal 1: any transition OUT of withdrawn (terminal)" \
  "UPDATE \"Decision\" SET \"status\"='pending' WHERE \"id\"='UP4A-D1'" "terminal"
assert_rejects "4a seal 1: rewriting the frozen evidence on a withdrawn row" \
  "UPDATE \"Decision\" SET \"withdrawReason\"='rewritten' WHERE \"id\"='UP4A-D1'" "write-once"
assert_rejects "4a seal 1 delete arm (round 3): DELETING the withdrawn register entry — BEFORE DELETE fires before FK evaluation, so the refusal never depends on surviving children" \
  "DELETE FROM \"Decision\" WHERE \"id\"='UP4A-D1'" "permanent register entry"
assert_rejects "4a seal 2: an UNATTRIBUTED withdrawal (no evidence at all)" \
  "UPDATE \"Decision\" SET \"status\"='withdrawn' WHERE \"id\"='UP4A-D2'" "must carry"
assert_rejects "4a seal 2: a tabs-and-newlines-only reason (the full-whitespace btrim class)" \
  "UPDATE \"Decision\" SET \"status\"='withdrawn', \"withdrawnAt\"=now(), \"withdrawnById\"='USER-1', \"withdrawnByName\"='X', \"withdrawReason\"=E'\t\n \x0B' WHERE \"id\"='UP4A-D2'" "non-blank"
assert_rejects "4a seal 2: a FORGED withdrawer naming no member of the project (the FK)" \
  "UPDATE \"Decision\" SET \"status\"='withdrawn', \"withdrawnAt\"=now(), \"withdrawnById\"='GHOST', \"withdrawnByName\"='Ghost', \"withdrawReason\"='forged' WHERE \"id\"='UP4A-D2'" "foreign key"
assert_rejects "4a seal 2: withdrawal evidence on a NON-withdrawn row (the inverse arm)" \
  "UPDATE \"Decision\" SET \"withdrawReason\"='orphan' WHERE \"id\"='UP4A-D2'" "only on a withdrawn"
assert_rejects "4a seal 3 forward: the LEGACY approved-with-EMPTY-register class (DL-2, the PR-#192 backfill shape) — source state, not register emptiness, is the guard" \
  "UPDATE \"Decision\" SET \"status\"='withdrawn', \"withdrawnAt\"=now(), \"withdrawnById\"='USER-1', \"withdrawnByName\"='X', \"withdrawReason\"='hide it' WHERE \"id\"='DL-2'" "only a published pending"
assert_rejects "4a seal 3 forward: a decision cannot be BORN withdrawn" \
  "INSERT INTO \"Decision\" (\"id\",\"projectId\",\"title\",\"room\",\"status\",\"photoSwatch\",\"withdrawnAt\",\"withdrawnById\",\"withdrawnByName\",\"withdrawReason\") VALUES ('UP4A-D9','p1','Born','Hall','withdrawn','stone',now(),'USER-1','X','r')" "created withdrawn"
assert_rejects "4a seal 3 reverse: an approval revision recorded against the withdrawn decision" \
  "INSERT INTO \"DecisionApprovalRevision\"(\"id\",\"projectId\",\"decisionId\",\"version\",\"optionKey\",\"approvedAt\",\"approvedById\") VALUES('UP4A-R1','p1','UP4A-D1',1,'a',now(),'USER-1')" "withdrawn"

# the subject reaches BACKWARD: a pre-4a durable decision.published push (subjectless, relay
# down) must be backfilled from its own event's entityId when the migration runs — proven by
# planting the legacy shape and RE-RUNNING the migration file, which is rerunnable BY DESIGN
# (this re-run also proves the diagnostics accept a database whose withdrawn rows are coherent).
$PSQL -q >/dev/null <<'SQL'
INSERT INTO "OutboxConsumerCatalog"("consumer","consumerKind","consumerEffect","catalogVersion","active","updatedAt")
VALUES ('webpush.notify','unordered','external',1,true,now()) ON CONFLICT DO NOTHING;
INSERT INTO "DomainEvent"("eventId","eventType","organizationId","projectId","streamPosition","actorId","actorKind","entityType","entityId")
SELECT 'UP4A-EV1','decision.published',p."orgId",p."id",900001,'USER-1','human','Decision','UP4A-D2' FROM "Project" p WHERE p."id"='p1';
INSERT INTO "DomainEvent"("eventId","eventType","organizationId","projectId","streamPosition","actorId","actorKind","entityType","entityId")
SELECT 'UP4A-EV2','decision.published',p."orgId",p."id",900002,'USER-1','human','Decision','UP4A-D2' FROM "Project" p WHERE p."id"='p1';
INSERT INTO "OutboxDelivery"("id","eventId","projectId","consumer","consumerKind","streamPosition","deliveryAction","status","payload","updatedAt")
VALUES ('UP4A-DEL1','UP4A-EV1','p1','webpush.notify','unordered',900001,'dispatch','pending','{"body":"stale announcement"}',now()),
       -- round 2 (Codex F4): a push that EXHAUSTED its retries before the deploy — the subject
       -- must reach it too, or an operator redrive would slip past the cancellation mark
       ('UP4A-DEL2','UP4A-EV2','p1','webpush.notify','unordered',900002,'dispatch','dead','{"body":"stale announcement (dead)"}',now());
SQL
$PSQL -q -f "$MIG_DIR/20270810000000_phase6_t4a_withdraw/migration.sql" >/dev/null || { echo "FAILED  4a migration re-run (rerunnable-by-design) did not apply"; FAIL=1; }
assert "4a: the subject backfill reached the pre-4a undelivered decision.published push rows — pending AND dead (copied from each event's entityId, never invented)" \
  "SELECT string_agg(\"id\" || '=' || COALESCE(\"subject\",'<null>'), ',' ORDER BY \"id\") FROM \"OutboxDelivery\" WHERE \"id\" IN ('UP4A-DEL1','UP4A-DEL2');" \
  "UP4A-DEL1=UP4A-D2,UP4A-DEL2=UP4A-D2"

echo ""
# a missing command anywhere above is a failed run, however far from here it happened — and it
# names itself, because the handler's own output may have been redirected away by its caller
if [ -e "$CNF_SENTINEL" ]; then
  FAIL=1
  echo "FAILED  upgrade-proof: these commands do not exist here, so whatever they were asserting did nothing:"
  sort -u "$CNF_SENTINEL" | sed 's/^/          /'
fi
if [ "$FAIL" = "0" ]; then
  echo "UPGRADE PROOF PASSED: all Phase 1 migrations applied over the legacy fixture and every legacy meaning survived."
else
  echo "UPGRADE PROOF FAILED: see the assertions above."
fi
exit $FAIL
