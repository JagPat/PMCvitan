-- The assignment rule at the EVIDENCE boundary, for writers this deployment does not control.
--
-- WHAT THIS CLOSES. `20271216000000` fences the SUBMIT transition against a previous-release
-- replica. Evidence was left in the same position it fenced submit out of: the authority added for
-- uploads and deletes lives in `MediaService`, which an already-running previous-release API is not
-- running. During a rolling deployment that replica will still attach a photo to — or PERMANENTLY
-- DELETE a photo from — an inspection whose assignment binds to somebody else. Delete is the sharp
-- end: the bytes do not come back, and nothing downstream can reconstruct what the item proved.
--
-- WHY A SETTING AND NOT A COLUMN. The submit fence judges an actor the row itself carries
-- (`submittedById`). `InspectionEvidence` carries no actor, and a DELETE could not use one anyway —
-- the row records who ADDED the evidence, never who is removing it. So the actor arrives as a
-- transaction-local setting this release's writers set and the previous release does not know
-- exists: the same discriminator `20271126000000` uses, for the same reason.
--
-- ITS HONEST LIMIT, stated because the repository states it elsewhere (4c-iii-r): a `SET LOCAL` is
-- MISTAKE-PROOFING, not a privilege boundary — this deployment's single table-owning role could not
-- honour one. A hostile direct writer can set the value to the assignee's id, exactly as it could
-- write `submittedById = assigneeId` past the submit fence. Both fences judge the CLAIMED actor, and
-- neither pretends otherwise. What they close is the writer that claims nothing because it has never
-- heard of the rule, which is the previous release.
--
-- ONE STATEMENT OF THE RULE. This fence asks `inspection_assignment_binds`, defined by
-- `20271216000000` beside the submit fence, rather than carrying its own copy of the corrective-role
-- list and the membership row lock. `inspections.contract.test.ts` pins that exactly one such list
-- exists across both fences. A second fence with its own copy of the predicate is how the two would
-- come to disagree — the defect this PR has now been corrected for five times.
BEGIN;

-- The evidence fence. Reaches the membership lookup only for evidence on an ASSIGNED inspection,
-- so an ordinary photo on an unassigned checklist — the common case — costs one indexed read of the
-- inspection row and nothing else.
CREATE OR REPLACE FUNCTION inspection_evidence_authority() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $evidence$
DECLARE
  v_project text;
  v_inspection text;
  v_assignee text;
  v_actor text;
  v_row public."InspectionEvidence";
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_project := OLD."projectId"; v_inspection := OLD."inspectionId"; v_row := OLD;
  ELSE
    v_project := NEW."projectId"; v_inspection := NEW."inspectionId"; v_row := NEW;
  END IF;

  SELECT i."assigneeId" INTO v_assignee
    FROM public."Inspection" i WHERE i."id" = v_inspection;
  -- UNASSIGNED evidence is unchanged: the route's role gate is its whole guard, as it always was.
  IF v_assignee IS NULL THEN RETURN v_row; END IF;

  -- The same readiness fence the submit trigger takes, for the same reason and with the same
  -- try-and-refuse shape: a blocking acquisition here could invert a lock order against a writer
  -- holding the key and waiting on these rows.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('readiness:' || v_project, 0)) THEN
    RAISE EXCEPTION
      'Inspection % evidence cannot be changed right now: this project''s readiness is held by another transaction, so the assignee''s standing cannot be judged. Retry.',
      v_inspection;
  END IF;

  -- A STRANDED assignment binds nobody, and evidence returns to the ordinary role gate — the same
  -- answer the service and the read boundary give.
  IF NOT inspection_assignment_binds(v_project, v_assignee) THEN RETURN v_row; END IF;

  v_actor := NULLIF(current_setting('vitan.inspection_evidence_actor', true), '');
  IF v_actor IS DISTINCT FROM v_assignee THEN
    RAISE EXCEPTION
      'Inspection % is assigned to % and only its assignee may change its photo evidence; this write was made by %.',
      v_inspection, v_assignee, COALESCE(v_actor, '(an unattributed writer)');
  END IF;
  RETURN v_row;
END;
$evidence$;

DROP TRIGGER IF EXISTS "InspectionEvidence_t571_authority" ON "InspectionEvidence";
CREATE TRIGGER "InspectionEvidence_t571_authority"
  BEFORE INSERT OR DELETE ON "InspectionEvidence"
  FOR EACH ROW EXECUTE FUNCTION inspection_evidence_authority();

COMMIT;
