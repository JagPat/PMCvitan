-- Phase 3 Task 1 correction ROUND 2 (six findings) — IMMUTABLE approval provenance.
-- FORWARD-ONLY and DIAGNOSTIC-FIRST. This migration NEVER silently converts provenance or
-- responsible identities to null: every unverifiable fact ABORTS with sampled rows and an
-- explicit operator-repair instruction; every skipped backfill is WARNED with samples. The
-- merged migrations it builds on are not amended or rolled back.

-- ============================================================================
-- 1. The decisions-owned IMMUTABLE approval register (finding 1).
-- ============================================================================
CREATE TABLE "DecisionApprovalRevision" (
    "id"           TEXT NOT NULL,
    "projectId"    TEXT NOT NULL,
    "decisionId"   TEXT NOT NULL,
    "version"      INTEGER NOT NULL,
    "optionKey"    TEXT NOT NULL,
    "approvedAt"   TIMESTAMP(3) NOT NULL,
    "approvedById" TEXT,
    "onBehalfOf"   TEXT,
    CONSTRAINT "DecisionApprovalRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DecisionApprovalRevision_version_check" CHECK ("version" >= 1)
);
CREATE UNIQUE INDEX "DecisionApprovalRevision_decisionId_version_key"
  ON "DecisionApprovalRevision"("decisionId", "version");
-- the provenance FK target: version AND option bind together to ONE immutable approval fact
-- (explicit name — the generated one exceeds PostgreSQL's 63-char identifier limit)
CREATE UNIQUE INDEX "DecisionApprovalRevision_provenance_target_key"
  ON "DecisionApprovalRevision"("projectId", "decisionId", "version", "optionKey");

-- ----------------------------------------------------------------------------
-- 1a. DIAGNOSTIC: the register pins options by (decisionId, optionKey), so that pair must be
--     a candidate key. Duplicate legacy pairs are data corruption — ABORT with samples.
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  bad TEXT;
  n   INTEGER;
BEGIN
  SELECT COUNT(*), string_agg(sample, ' | ')
    INTO n, bad
  FROM (
    SELECT '(' || "decisionId" || ', ' || "optionKey" || ') x' || COUNT(*) AS sample
    FROM "DecisionOption"
    GROUP BY "decisionId", "optionKey"
    HAVING COUNT(*) > 1
    LIMIT 10
  ) s;
  IF n > 0 THEN
    RAISE EXCEPTION 'phase3_approval_provenance ABORT: % duplicate (decisionId, optionKey) pairs — operator repair required (deduplicate the options), sampled: %', n, bad;
  END IF;
END $$;
CREATE UNIQUE INDEX "DecisionOption_decisionId_optionKey_key" ON "DecisionOption"("decisionId", "optionKey");

-- ============================================================================
-- 2. BACKFILL (finding 3; AMENDED in the round-3 correction): one register row for EVERY
--    uniquely provable approval/reapproval — NOT only the latest. The round-2 current-only
--    assumption was WRONG: under the round-1 schema a requirement could legitimately pin an
--    approval, after which the decision was reopened and reapproved — its spec then
--    references an EARLIER version, and a current-only register falsely rejected that valid
--    provenance as forged (found + reproduced by the #191 narrow re-review).
--    Provability is PER EVENT: the event's own recorded payload option label (the LATEST
--    event may additionally fall back to the decision's recorded `approvedOption`) matching
--    EXACTLY ONE of the decision's options. An approved decision with NO recorded approval
--    events (pre-event-envelope legacy) yields a single version-1 row from the decision's
--    own recorded selection, at the best recorded timestamp (createdAt) — never invented
--    beyond that. Ambiguous events are SKIPPED with a loud sampled WARNING; a spec that
--    references a skipped version aborts below for explicit operator repair. Nothing is
--    nulled or rewritten.
--    AMENDMENT DISCIPLINE: this file was corrected IN PLACE after merge — documented, never
--    silent. The defective version could only COMPLETE on a database with no earlier-version
--    spec references (it ABORTED otherwise), and `prisma migrate deploy` applies by name
--    without re-verifying applied checksums, so this amendment is inert on such databases;
--    they are completed by `20261216000000_phase3_approval_history`, which idempotently
--    inserts the missing provable history. Still-pending databases (upgrading straight from
--    `d0897a6`) run THIS corrected version and need no repair.
-- ============================================================================
DO $$
DECLARE
  n_ambiguous INTEGER;
  s_ambiguous TEXT;
  n_orphan_actor INTEGER;
  s_orphan_actor TEXT;
BEGIN
  CREATE TEMP TABLE _p3_backfill ON COMMIT DROP AS
  WITH approval_events AS (
    SELECT e."decisionId" AS decision_id, e."at", e."id" AS event_id, e."actorId" AS actor_id, e."payload",
           (ROW_NUMBER() OVER (PARTITION BY e."decisionId" ORDER BY e."at" ASC, e."id" ASC))::int AS version,
           (COUNT(*) OVER (PARTITION BY e."decisionId"))::int AS total
    FROM "DecisionEvent" e
    WHERE e."type" IN ('approved','reapproved')
  ),
  candidates AS (
    -- every recorded approval, versioned 1..N in event order
    SELECT d."id" AS decision_id, d."projectId" AS project_id, ae.version,
           COALESCE(ae."payload"->>'option', CASE WHEN ae.version = ae.total THEN d."approvedOption" END) AS selected_label,
           ae."at" AS approved_at,
           COALESCE(ae.actor_id, CASE WHEN ae.version = ae.total THEN d."approvedById" END) AS approved_by,
           COALESCE(ae."payload"->>'onBehalfOf', CASE WHEN ae.version = ae.total THEN d."onBehalfOf" END) AS on_behalf
    FROM "Decision" d
    JOIN approval_events ae ON ae.decision_id = d."id"
    UNION ALL
    -- approved decisions with NO recorded approval events (pre-event-envelope legacy)
    SELECT d."id", d."projectId", 1, d."approvedOption", d."createdAt", d."approvedById", d."onBehalfOf"
    FROM "Decision" d
    WHERE d."status" = 'approved'
      AND NOT EXISTS (SELECT 1 FROM "DecisionEvent" e
                      WHERE e."decisionId" = d."id" AND e."type" IN ('approved','reapproved'))
  )
  SELECT c.decision_id, c.project_id, c.version, c.selected_label, c.approved_at, c.approved_by, c.on_behalf,
         (SELECT COUNT(*) FROM "DecisionOption" o
          WHERE o."decisionId" = c.decision_id AND o."label" = c.selected_label)::int AS label_matches,
         (SELECT o."optionKey" FROM "DecisionOption" o
          WHERE o."decisionId" = c.decision_id AND o."label" = c.selected_label
          LIMIT 1) AS option_key
  FROM candidates c;

  -- a recorded approver that names NO existing user is unverifiable attribution — never
  -- silently nulled, never invented: ABORT with samples for explicit operator repair
  SELECT COUNT(*), string_agg(decision_id || ' approvedBy=' || approved_by, ' | ')
    INTO n_orphan_actor, s_orphan_actor
  FROM (SELECT decision_id, approved_by FROM _p3_backfill b
        WHERE b.approved_by IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = b.approved_by)
        LIMIT 10) s;
  IF n_orphan_actor > 0 THEN
    RAISE EXCEPTION 'phase3_approval_provenance ABORT: % approvals name a nonexistent approver — operator repair required (restore or correct the user identity), sampled: %', n_orphan_actor, s_orphan_actor;
  END IF;

  -- ambiguous selected option → SKIP that event's backfill, WARN with samples; a spec
  -- referencing a skipped version aborts in step 3 for explicit operator repair
  SELECT COUNT(*), string_agg(decision_id || ' v' || version || ' (label=' || COALESCE(selected_label, '<null>') || ', matches=' || label_matches || ')', ' | ')
    INTO n_ambiguous, s_ambiguous
  FROM (SELECT decision_id, version, selected_label, label_matches FROM _p3_backfill
        WHERE selected_label IS NULL OR label_matches <> 1
        LIMIT 10) s;
  IF n_ambiguous > 0 THEN
    RAISE WARNING 'phase3_approval_provenance: % legacy approvals have NO uniquely provable selected option — NOT backfilled; these approvals cannot anchor requirement provenance until an operator repairs them, sampled: %', n_ambiguous, s_ambiguous;
  END IF;

  INSERT INTO "DecisionApprovalRevision"
    ("id", "projectId", "decisionId", "version", "optionKey", "approvedAt", "approvedById", "onBehalfOf")
  SELECT 'dar-' || decision_id || '-v' || version,
         project_id, decision_id, version, option_key, approved_at, approved_by, on_behalf
  FROM _p3_backfill
  WHERE selected_label IS NOT NULL AND label_matches = 1;
END $$;

-- ============================================================================
-- 3. DIAGNOSTIC then FK (findings 2 + 3): every EXISTING spec provenance triple must name a
--    row of the register — a triple that does not is FORGED or UNVERIFIABLE and the
--    migration ABORTS with samples (explicit operator repair; nothing is nulled here).
-- ============================================================================
DO $$
DECLARE
  n INTEGER;
  s TEXT;
BEGIN
  SELECT COUNT(*), string_agg(m."id" || ' -> (' || m."decisionId" || ', v' || m."decisionVersion" || ', ' || m."optionKey" || ')', ' | ')
    INTO n, s
  FROM (SELECT * FROM "MaterialRequirementSpec"
        WHERE "decisionId" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "DecisionApprovalRevision" r
            WHERE r."projectId" = "MaterialRequirementSpec"."projectId"
              AND r."decisionId" = "MaterialRequirementSpec"."decisionId"
              AND r."version"   = "MaterialRequirementSpec"."decisionVersion"
              AND r."optionKey" = "MaterialRequirementSpec"."optionKey")
        LIMIT 10) m;
  IF n > 0 THEN
    RAISE EXCEPTION 'phase3_approval_provenance ABORT: % requirement specs carry FORGED or UNVERIFIABLE decision provenance (no matching immutable approval revision) — operator repair required, sampled: %', n, s;
  END IF;
END $$;
ALTER TABLE "MaterialRequirementSpec"
  ADD CONSTRAINT "MaterialRequirementSpec_provenance_fkey"
  FOREIGN KEY ("projectId", "decisionId", "decisionVersion", "optionKey")
  REFERENCES "DecisionApprovalRevision"("projectId", "decisionId", "version", "optionKey")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "DecisionApprovalRevision"
  ADD CONSTRAINT "DecisionApprovalRevision_projectId_decisionId_fkey"
  FOREIGN KEY ("projectId", "decisionId") REFERENCES "Decision"("projectId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "DecisionApprovalRevision"
  ADD CONSTRAINT "DecisionApprovalRevision_decisionId_optionKey_fkey"
  FOREIGN KEY ("decisionId", "optionKey") REFERENCES "DecisionOption"("decisionId", "optionKey")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "DecisionApprovalRevision"
  ADD CONSTRAINT "DecisionApprovalRevision_approvedById_fkey"
  FOREIGN KEY ("approvedById") REFERENCES "User"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- 4. SINGLE-SOURCE UOM (finding 4): the unit lives ONCE, on the revision row. Before the
--    duplicated column departs, any disagreement between the two copies is unresolvable
--    corruption — ABORT with samples rather than silently picking a side.
-- ============================================================================
DO $$
DECLARE
  n INTEGER;
  s TEXT;
BEGIN
  SELECT COUNT(*), string_agg(m."id" || ' (spec=' || m."baseUom" || ', revision=' || ar."baseUom" || ')', ' | ')
    INTO n, s
  FROM "MaterialRequirementSpec" m
  JOIN "ActivityRequirement" ar
    ON ar."projectId" = m."projectId" AND ar."requirementId" = m."requirementId" AND ar."revision" = m."revision"
  WHERE m."baseUom" <> ar."baseUom";
  IF n > 0 THEN
    RAISE EXCEPTION 'phase3_approval_provenance ABORT: % specs disagree with their revision on the unit of measure — operator repair required, sampled: %', n, s;
  END IF;
END $$;
ALTER TABLE "MaterialRequirementSpec" DROP COLUMN "baseUom";

-- ============================================================================
-- 5. COMMIT-TIME PAIRING (finding 4), pre-validated over existing rows first:
--    type = 'material'  → exactly ONE MaterialRequirementSpec for the revision;
--    type <> 'material' → NO MaterialRequirementSpec.
-- ============================================================================
DO $$
DECLARE
  n INTEGER;
  s TEXT;
BEGIN
  SELECT COUNT(*), string_agg(sample, ' | ')
    INTO n, s
  FROM (
    SELECT ar."requirementId" || ' rev ' || ar."revision" || ' (' || ar."type" || ', specs=' || COUNT(m."id") || ')' AS sample
    FROM "ActivityRequirement" ar
    LEFT JOIN "MaterialRequirementSpec" m
      ON m."projectId" = ar."projectId" AND m."requirementId" = ar."requirementId" AND m."revision" = ar."revision"
    GROUP BY ar."projectId", ar."requirementId", ar."revision", ar."type"
    HAVING (ar."type" = 'material' AND COUNT(m."id") <> 1)
        OR (ar."type" <> 'material' AND COUNT(m."id") > 0)
    LIMIT 10
  ) bad;
  IF n > 0 THEN
    RAISE EXCEPTION 'phase3_approval_provenance ABORT: % requirement revisions violate the material/spec pairing — operator repair required, sampled: %', n, s;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION phase3_requirement_spec_pairing() RETURNS trigger AS $$
DECLARE
  rev_type   TEXT;
  spec_count INTEGER;
BEGIN
  SELECT ar."type" INTO rev_type FROM "ActivityRequirement" ar
  WHERE ar."projectId" = NEW."projectId" AND ar."requirementId" = NEW."requirementId" AND ar."revision" = NEW."revision";
  IF rev_type IS NULL THEN
    RAISE EXCEPTION 'MaterialRequirementSpec (%, %, rev %) names no requirement revision', NEW."projectId", NEW."requirementId", NEW."revision";
  END IF;
  SELECT COUNT(*) INTO spec_count FROM "MaterialRequirementSpec" m
  WHERE m."projectId" = NEW."projectId" AND m."requirementId" = NEW."requirementId" AND m."revision" = NEW."revision";
  IF rev_type = 'material' AND spec_count <> 1 THEN
    RAISE EXCEPTION 'a material requirement revision must commit with exactly one MaterialRequirementSpec (found % for % rev %)', spec_count, NEW."requirementId", NEW."revision";
  END IF;
  IF rev_type <> 'material' AND spec_count <> 0 THEN
    RAISE EXCEPTION 'a % requirement revision must commit with no MaterialRequirementSpec (found % for % rev %)', rev_type, spec_count, NEW."requirementId", NEW."revision";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- deferred to COMMIT so the revision and its spec may land in either order within the tx
CREATE CONSTRAINT TRIGGER "ActivityRequirement_spec_pairing"
  AFTER INSERT ON "ActivityRequirement"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION phase3_requirement_spec_pairing();
CREATE CONSTRAINT TRIGGER "MaterialRequirementSpec_spec_pairing"
  AFTER INSERT ON "MaterialRequirementSpec"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION phase3_requirement_spec_pairing();

-- ============================================================================
-- 6. IMMUTABILITY (findings 1 + 6): the approval register AND the requirement root carry
--    canonical attribution/tenant identity — database-immutable like the revisions.
--    (TRUNCATE, used by sanctioned test/seed resets, fires no row triggers.)
-- ============================================================================
CREATE OR REPLACE FUNCTION phase3_immutable_row() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is forbidden', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "DecisionApprovalRevision_append_only"
  BEFORE UPDATE OR DELETE ON "DecisionApprovalRevision"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();
CREATE TRIGGER "ActivityRequirementRoot_append_only"
  BEFORE UPDATE OR DELETE ON "ActivityRequirementRoot"
  FOR EACH ROW EXECUTE FUNCTION phase3_immutable_row();
