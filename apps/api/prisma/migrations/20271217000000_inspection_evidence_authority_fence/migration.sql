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
-- (`submittedById`). `InspectionEvidence` carries no actor, so the actor arrives as a
-- transaction-local setting this release's writers set and the previous release does not know
-- exists: the same discriminator `20271126000000` uses, for the same reason.
--
-- INSERT ONLY, AND THAT IS A MEASURED LIMIT RATHER THAN AN OVERSIGHT (#571 round 10, after CI).
-- An earlier spelling of this fence carried a DELETE arm too. It refused the seed: `prisma/seed.ts`
-- wipes `Media`, and the FK cascade issues
--
--   DELETE FROM ONLY "public"."InspectionEvidence" WHERE $1 = "projectId" AND $2 = "mediaId"
--
-- which is BYTE-IDENTICAL to the statement `InspectionParticipant.removeEvidence` issues on the
-- legacy delete path. Measured on a live database, not reasoned about: the sanctioned teardown and
-- the writer this fence exists to stop present the database with the same act, and a trigger cannot
-- see intent. Fencing DELETE therefore refuses every reset in the repository — the exact failure
-- `prisma/sanctioned-reset.ts` was written to prevent ("installing one seal used to mean editing
-- every suite that resets a table in its cascade, and MISSING one meant the required integration
-- battery stopped being runnable"), and it would have to be bypassed at more than a dozen teardown
-- sites, each of which is one edit away from silently disabling the protection anyway.
--
-- So the halves are answered differently, and the plan says which is which. ATTACHING evidence to
-- somebody else's binding work is fenced HERE, at the database, where no teardown ever inserts.
-- REMOVING it rests on `MediaService.remove`'s guard plus a drain — the second of the two answers
-- this finding itself admits. Claiming a DELETE fence that every reset must switch off would be a
-- weaker guarantee dressed as a stronger one.
--
-- THE DRAIN IS CARRIED, NOT MERELY CITED (#571 round 11, finding 2). An earlier spelling of this
-- comment deferred to a drain that nothing held: `docs/STATUS.md` read `blocking_directive: none`,
-- so the deferral named an attestation no gate required. The standing directive
-- `phase-6-4d-inspection-assignment-drain` now carries it, and says what it gates: LANDING this
-- unit is not gated, DEPLOYING its assignment semantics is, because a previous-release replica
-- still running the unguarded media-delete path can destroy an assigned checklist's evidence and
-- its bucket object. Enforcing the drain at deploy time is a change to production deploy behaviour
-- and is routed to the Board rather than taken here — the same disposition 4c-iii-r's round 13
-- recorded for this exact class.
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
  v_project := NEW."projectId"; v_inspection := NEW."inspectionId"; v_row := NEW;

  -- LOCKED, because the ABSENCE of an assignment is a fact with a lifetime (#571 round 12,
  -- finding 1). Round 11 established this for the service — an unlocked read of `assigneeId`
  -- followed by an early return lets an alternate writer perform the migration's permitted
  -- `null → A` assignment in between — and then fixed only the service, leaving this fence with
  -- the identical shape. The previous-release upload this trigger EXISTS to judge is exactly the
  -- writer that would slip through it: it reads NULL, returns early, and commits unattributed
  -- evidence onto work that is now A's.
  --
  -- The service pins the observed value in the write's own predicate; a trigger has no later
  -- write to pin, so it takes the row lock instead and re-reads under it. That also settles the
  -- LOCK ORDER for every path through this table — the inspection row BEFORE the membership row
  -- `inspection_assignment_binds` takes — and the service reaches this trigger already holding
  -- both, in that same order, so it adds nothing there.
  SELECT i."assigneeId" INTO v_assignee
    FROM public."Inspection" i WHERE i."id" = v_inspection FOR UPDATE;
  -- UNASSIGNED evidence is unchanged: the route's role gate is its whole guard, as it always was.
  -- The lock above is what makes "unassigned" true at the write rather than true a moment ago.
  IF v_assignee IS NULL THEN RETURN v_row; END IF;

  -- NO READINESS LOCK HERE, and the asymmetry with the submit fence is deliberate (#571 round 11).
  -- Round 10 gave this fence the submit fence's try-and-refuse readiness acquisition by SYMMETRY,
  -- without noticing that the same line costs nothing there and a great deal here. The submit path
  -- enters this trigger from a service that ALREADY holds the project's readiness key, so its
  -- try-acquire is re-entrant within the same transaction and free. `MediaService` takes no
  -- readiness lock at all — so acquiring it here would take a PROJECT-WIDE lock inside every photo
  -- upload and hold it to commit, putting every readiness writer (submit, decide, start, complete)
  -- behind uploads that never used to touch that key.
  --
  -- It bought nothing to pay for. What serializes this judgement against a concurrent standing
  -- change is the `FOR UPDATE` on the assignee's membership row inside
  -- `inspection_assignment_binds` — which exists precisely because #571's round 9, finding 2
  -- established that the advisory lock ALONE was insufficient (an ordinary engineer reactivation
  -- takes no readiness key, so it never met the fence there). Any writer of that membership row
  -- must take the row lock, so a concurrent change either commits before this read or waits behind
  -- it. The readiness key adds no ordering this fence's answer depends on.
  --
  -- The submit fence keeps its acquisition: it is a Codex remedy (round 8, finding 1), it is free
  -- on that path, and `inspections.contract.test.ts` pins the split so neither half drifts.

  -- A STRANDED assignment binds nobody, and evidence returns to the ordinary role gate — the same
  -- answer the service and the read boundary give.
  IF NOT inspection_assignment_binds(v_project, v_assignee) THEN RETURN v_row; END IF;

  v_actor := NULLIF(current_setting('vitan.inspection_evidence_actor', true), '');
  IF v_actor IS DISTINCT FROM v_assignee THEN
    RAISE EXCEPTION
      'Inspection % is assigned to % and only its assignee may attach photo evidence to it; this write was made by %.',
      v_inspection, v_assignee, COALESCE(v_actor, '(an unattributed writer)');
  END IF;
  RETURN v_row;
END;
$evidence$;

DROP TRIGGER IF EXISTS "InspectionEvidence_t571_authority" ON "InspectionEvidence";
CREATE TRIGGER "InspectionEvidence_t571_authority"
  BEFORE INSERT ON "InspectionEvidence"
  FOR EACH ROW EXECUTE FUNCTION inspection_evidence_authority();

COMMIT;
