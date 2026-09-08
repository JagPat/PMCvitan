-- The submit-authority rule, restated at the boundary the API replicas SHARE.
--
-- WHAT THIS CLOSES. This release makes `Inspection.assigneeId` decide who may submit assigned
-- corrective work, and stamps `submittedById` as the person who did it. `20271210000000` froze the
-- column so the NAME cannot be substituted. Neither stops the case a rolling deployment creates: a
-- previous-release API replica is still serving requests after these migrations apply, and its
-- `submit` has no assignee guard at all — it never had one to keep. A request routed there submits
-- engineer A's assigned inspection as engineer B, writes B into `submittedById`, and the freeze
-- trigger waves it through because `assigneeId` itself is untouched. The forged attribution is then
-- the permanent record of who did the remedial work, and every later read agrees with it.
--
-- WHY NOT "DRAIN THE OLD REPLICAS FIRST". That is an operational precondition this repository has no
-- way to verify at deploy time, and the failure it prevents is silent, permanent and unattributable.
-- A rule the database enforces is one no writer can be outside of — including a writer this
-- deployment does not control, which is precisely the writer in question.
--
-- THE RULE, AND IT IS THE SAME ONE. A submit transition (`submitted` false -> true) on an inspection
-- with a BINDING assignee must record that assignee as the submitter. "Binding" means what
-- `assignment-eligibility.ts` means by it and nothing else: an ACTIVE membership on this project in a
-- corrective role. An assignee who was removed or re-roled, and a PMC who took the work by naming
-- themselves (they hold no checklist screen), bind nobody — the checklist returns to the ordinary
-- role gate and any eligible submitter is recorded honestly. That is the service's rule verbatim, so
-- THIS TRIGGER REJECTS ONLY WHAT THIS RELEASE'S `submit` ALREADY REJECTS. It is a floor under the
-- rule for writers that never learned it, not a second, stricter rule that a current replica could
-- trip over.
--
-- WHY IT RAISES, WHERE `20271126000000` DELIBERATELY DID NOT. That fence stamps instead of raising
-- because rejecting there would abort a RELAY delivery, which retries, dead-letters, and leaves a
-- projection needing an operator. This sits on an interactive request: raising costs the caller one
-- failed submit during the deployment window, and they retry — most likely onto a current replica.
-- Not raising costs somebody the record of their own work, permanently. There is no stamp-and-repair
-- option here, because nothing downstream can reconstruct who actually filled the checklist.
--
-- ITS EXACT REACH. Only the false -> true submit transition, only when a named assignee is present,
-- and only when the recorded submitter is not that assignee. An UNASSIGNED checklist — the common
-- case — never reaches the membership lookup; neither does a decide, a sign-off, or any later update
-- of an already-submitted row. A NULL `submittedById` on an assigned submit is refused with the
-- same message, deliberately: an unattributable submit of somebody's named work is the very thing
-- the rule exists to prevent, and admitting it would leave the widest door open.
--
-- Additive and diagnostic-free: one function, one trigger, no column, no backfill. It constrains
-- future writes only, so it cannot abort on existing data and legacy databases upgrade untouched.
--
-- THE ROLE LIST BELOW IS PINNED TO `CORRECTIVE_ROLES` BY `inspections.contract.test.ts`. One rule
-- stated at two boundaries has to be stated identically, and a SQL copy that silently drifted from
-- the TypeScript one would be the rule disagreeing with itself about who holds the work.
CREATE OR REPLACE FUNCTION inspection_submit_authority() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $authority$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public."Membership" m
     WHERE m."projectId" = NEW."projectId"
       AND m."userId" = NEW."assigneeId"
       AND m."status" = 'active'
       AND m."role" IN ('engineer')
  ) THEN
    RAISE EXCEPTION
      'Inspection % is assigned to % and only its assignee may submit it; % was recorded as the submitter. A writer without this release''s submit guard reached this row.',
      NEW."id", NEW."assigneeId", COALESCE(NEW."submittedById", '(nobody)');
  END IF;
  RETURN NEW;
END;
$authority$;

DROP TRIGGER IF EXISTS "Inspection_submit_authority" ON "Inspection";
-- The pure-column half of the predicate lives in WHEN, so an ordinary submit of an unassigned
-- checklist and every non-submit UPDATE never call the function at all.
CREATE TRIGGER "Inspection_submit_authority"
  BEFORE UPDATE ON "Inspection"
  FOR EACH ROW
  WHEN (
    NEW."submitted" AND NOT OLD."submitted"
    AND NEW."assigneeId" IS NOT NULL
    AND NEW."submittedById" IS DISTINCT FROM NEW."assigneeId"
  )
  EXECUTE FUNCTION inspection_submit_authority();
