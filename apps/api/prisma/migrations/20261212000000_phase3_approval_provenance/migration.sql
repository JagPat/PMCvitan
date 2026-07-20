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
-- 2. BACKFILL (finding 3): one register row per decision with a recorded approval — its
--    CURRENT approval, at version = the recorded approval-event count (floor 1) — created
--    ONLY when the selected option is UNIQUELY PROVABLE: the latest approval event's payload
--    option label (else Decision.approvedOption) matches EXACTLY ONE of the decision's
--    options. Ambiguous decisions are SKIPPED with a loud sampled WARNING — they are refused
--    at runtime (`decisions.approvedRef` finds no register row → operator repair) and their
--    NEXT real approval versions PAST the unprovable history (the service allocates
--    max(head, recorded approval events) + 1). Earlier approvals (versions 1..N-1 of a
--    reapproved decision) are NOT fabricated: no pre-round-2 requirement ever referenced
--    them (`approvedRef` always served the current count), and inventing rows for approvals
--    whose option is unknowable would be fabrication, not backfill.
--    approvedAt/approvedById come from the latest approval event; an event-less approved
--    decision (pre-event-envelope legacy) falls back to Decision.createdAt /
--    Decision.approvedById — the best recorded truth, noted here, never invented beyond it.
-- ============================================================================
DO $$
DECLARE
  n_ambiguous INTEGER;
  s_ambiguous TEXT;
  n_orphan_actor INTEGER;
  s_orphan_actor TEXT;
BEGIN
  CREATE TEMP TABLE _p3_backfill ON COMMIT DROP AS
  SELECT
    d."id"                                   AS decision_id,
    d."projectId"                            AS project_id,
    GREATEST(1, (SELECT COUNT(*) FROM "DecisionEvent" e
                 WHERE e."decisionId" = d."id" AND e."type" IN ('approved','reapproved')))::int AS version,
    COALESCE(le."payload"->>'option', d."approvedOption") AS selected_label,
    (SELECT COUNT(*) FROM "DecisionOption" o
     WHERE o."decisionId" = d."id"
       AND o."label" = COALESCE(le."payload"->>'option', d."approvedOption"))::int AS label_matches,
    (SELECT o."optionKey" FROM "DecisionOption" o
     WHERE o."decisionId" = d."id"
       AND o."label" = COALESCE(le."payload"->>'option', d."approvedOption")
     LIMIT 1)                                AS option_key,
    COALESCE(le."at", d."createdAt")         AS approved_at,
    COALESCE(le."actorId", d."approvedById") AS approved_by,
    COALESCE(le."payload"->>'onBehalfOf', d."onBehalfOf") AS on_behalf
  FROM "Decision" d
  LEFT JOIN LATERAL (
    SELECT e."at", e."actorId", e."payload"
    FROM "DecisionEvent" e
    WHERE e."decisionId" = d."id" AND e."type" IN ('approved','reapproved')
    ORDER BY e."at" DESC, e."id" DESC
    LIMIT 1
  ) le ON TRUE
  WHERE d."status" = 'approved'
     OR EXISTS (SELECT 1 FROM "DecisionEvent" e
                WHERE e."decisionId" = d."id" AND e."type" IN ('approved','reapproved'));

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

  -- ambiguous selected option → SKIP the backfill, WARN with samples, refuse at runtime
  SELECT COUNT(*), string_agg(decision_id || ' (label=' || COALESCE(selected_label, '<null>') || ', matches=' || label_matches || ')', ' | ')
    INTO n_ambiguous, s_ambiguous
  FROM (SELECT decision_id, selected_label, label_matches FROM _p3_backfill
        WHERE selected_label IS NULL OR label_matches <> 1
        LIMIT 10) s;
  IF n_ambiguous > 0 THEN
    RAISE WARNING 'phase3_approval_provenance: % legacy approvals have NO uniquely provable selected option — NOT backfilled; these decisions cannot anchor requirement provenance until an operator repairs them, sampled: %', n_ambiguous, s_ambiguous;
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
