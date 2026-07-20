-- Phase 3 Task 1 correction ROUND 3 — complete the immutable approval register with the
-- FULL provable history.
--
-- WHY THIS EXISTS: the round-2 version of `20261212000000_phase3_approval_provenance`
-- backfilled only each decision's LATEST approval. That current-only assumption falsely
-- rejected a requirement legitimately pinning an EARLIER approved version (reproduced by the
-- #191 narrow re-review) — that migration file is now amended in place to backfill every
-- uniquely provable approval. A database that already APPLIED the defective version could
-- only have completed because it held no earlier-version spec references (the forged check
-- aborted otherwise), but its register is still missing the earlier provable rows. This
-- migration inserts exactly those missing rows, IDEMPOTENTLY (`ON CONFLICT DO NOTHING` on
-- the (decisionId, version) candidate key):
--   • on a database that ran the AMENDED provenance migration (fresh upgrades from
--     `d0897a6`), everything already exists — this inserts nothing;
--   • on a database that ran the DEFECTIVE version, the missing earlier provable approvals
--     are added — existing rows (backfilled or runtime-written) are never touched.
-- `prisma migrate deploy` applies by name and does not re-verify applied checksums, so the
-- in-place amendment is inert on already-applied databases — the pair of migrations, not a
-- silent checksum change, is the upgrade strategy (documented here, in the amended file and
-- in docs/RUNBOOK.md). Nothing is nulled, rewritten or fabricated.
DO $$
DECLARE
  n_ambiguous INTEGER;
  s_ambiguous TEXT;
  n_orphan_actor INTEGER;
  s_orphan_actor TEXT;
BEGIN
  CREATE TEMP TABLE _p3_history ON COMMIT DROP AS
  WITH approval_events AS (
    SELECT e."decisionId" AS decision_id, e."at", e."id" AS event_id, e."actorId" AS actor_id, e."payload",
           (ROW_NUMBER() OVER (PARTITION BY e."decisionId" ORDER BY e."at" ASC, e."id" ASC))::int AS version,
           (COUNT(*) OVER (PARTITION BY e."decisionId"))::int AS total
    FROM "DecisionEvent" e
    WHERE e."type" IN ('approved','reapproved')
  ),
  candidates AS (
    SELECT d."id" AS decision_id, d."projectId" AS project_id, ae.version,
           COALESCE(ae."payload"->>'option', CASE WHEN ae.version = ae.total THEN d."approvedOption" END) AS selected_label,
           ae."at" AS approved_at,
           COALESCE(ae.actor_id, CASE WHEN ae.version = ae.total THEN d."approvedById" END) AS approved_by,
           COALESCE(ae."payload"->>'onBehalfOf', CASE WHEN ae.version = ae.total THEN d."onBehalfOf" END) AS on_behalf
    FROM "Decision" d
    JOIN approval_events ae ON ae.decision_id = d."id"
    UNION ALL
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
  FROM candidates c
  -- only approvals the register does not already record — existing rows are immutable facts
  WHERE NOT EXISTS (SELECT 1 FROM "DecisionApprovalRevision" r
                    WHERE r."decisionId" = c.decision_id AND r."version" = c.version);

  -- a to-be-inserted approver naming no existing user is unverifiable attribution — never
  -- silently nulled, never invented: ABORT with samples for explicit operator repair
  SELECT COUNT(*), string_agg(decision_id || ' v' || version || ' approvedBy=' || approved_by, ' | ')
    INTO n_orphan_actor, s_orphan_actor
  FROM (SELECT decision_id, version, approved_by FROM _p3_history b
        WHERE b.approved_by IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id" = b.approved_by)
        LIMIT 10) s;
  IF n_orphan_actor > 0 THEN
    RAISE EXCEPTION 'phase3_approval_history ABORT: % approvals name a nonexistent approver — operator repair required (restore or correct the user identity), sampled: %', n_orphan_actor, s_orphan_actor;
  END IF;

  SELECT COUNT(*), string_agg(decision_id || ' v' || version || ' (label=' || COALESCE(selected_label, '<null>') || ', matches=' || label_matches || ')', ' | ')
    INTO n_ambiguous, s_ambiguous
  FROM (SELECT decision_id, version, selected_label, label_matches FROM _p3_history
        WHERE selected_label IS NULL OR label_matches <> 1
        LIMIT 10) s;
  IF n_ambiguous > 0 THEN
    RAISE WARNING 'phase3_approval_history: % legacy approvals have NO uniquely provable selected option — NOT backfilled; these approvals cannot anchor requirement provenance until an operator repairs them, sampled: %', n_ambiguous, s_ambiguous;
  END IF;

  INSERT INTO "DecisionApprovalRevision"
    ("id", "projectId", "decisionId", "version", "optionKey", "approvedAt", "approvedById", "onBehalfOf")
  SELECT 'dar-' || decision_id || '-v' || version,
         project_id, decision_id, version, option_key, approved_at, approved_by, on_behalf
  FROM _p3_history
  WHERE selected_label IS NOT NULL AND label_matches = 1
  ON CONFLICT ("decisionId", "version") DO NOTHING;
END $$;
