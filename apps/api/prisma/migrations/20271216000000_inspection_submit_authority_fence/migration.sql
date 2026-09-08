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
-- IT TAKES THE PROJECT'S READINESS FENCE BEFORE IT READS MEMBERSHIP (#571 round 8, finding 1).
-- Round 7 moved the SERVICE's binding check under `lockProjectReadiness` for exactly one reason —
-- an unlocked read can be overtaken by a membership change that commits first — and then added
-- this trigger, which read `Membership` under no lock at all. The same hole, in the object built to
-- close it. An alternate writer that takes no readiness key can begin its UPDATE while assignee A
-- is inactive, a membership transaction can reactivate A and commit, and an unfenced trigger would
-- permit B: the terminal state then has a binding active assignee A and B recorded forever.
--
-- TRY-AND-REFUSE, NOT WAIT. `pg_try_advisory_xact_lock` never blocks, so this trigger cannot invert
-- a lock order and deadlock against a writer that holds the key and is waiting on this row. When
-- the key is already held by ANOTHER transaction the honest answer is that authority cannot be
-- judged right now, so the submit is refused and the caller retries — a refusal a retry clears,
-- rather than a decision taken on a membership picture that is provably in flux.
--
-- The current release's `submit` already holds this key (it is the first statement of that
-- command's transaction), and an advisory lock re-taken by the transaction that holds it succeeds,
-- so the ordinary path passes straight through. Only an unfenced writer actually acquires anything.
--
-- The lock acquisition is its own statement, so the `EXISTS` below runs as a LATER statement and,
-- under READ COMMITTED, takes a fresh snapshot — the membership picture it reads is the one that
-- exists after the fence is held, not the one the outer UPDATE started with.
--
-- THE KEY IS `readinessLockKey`'s, and `inspections.contract.test.ts` pins this expression against
-- it. Two spellings of one lock is the failure mode `readiness-lock.ts` exported that helper to
-- prevent: the day the prefix changes, a second spelling stops serializing against the first and
-- nothing fails.
-- THE RULE ITSELF, STATED ONCE IN SQL. `inspection_assignment_binds` is the SQL statement of
-- `assignment-eligibility.ts`, and the only one: `20271217000000`'s evidence fence asks this same
-- function rather than carrying a second copy of the role list, and `inspections.contract.test.ts`
-- pins that there is exactly ONE such list across the fences. Two fences with two copies of one
-- predicate is how they would come to disagree about who holds the work.
--
-- It takes the assignee's membership row FOR UPDATE before it judges (#571 round 9, finding 2):
-- `phase6_t4b2_membership_guard` returns before `phase6_try_readiness` for an ordinary
-- inactive -> active ENGINEER transition, so a direct reactivation of a plain engineer holds no
-- readiness key and the advisory lock alone would not serialize it. The row lock closes that in both
-- orders and needs no cooperation from the other writer, which is the point of a fence built for
-- writers that cooperate with nothing. VOLATILE, not STABLE, precisely because it takes that lock.
--
-- Stated honestly, and it is the same caveat `OrgsParticipant.hasProjectRoleStanding` records for
-- its own `forUpdate`: `FOR UPDATE` locks rows that EXIST. It closes the change-of-an-existing-row
-- race, which is the shape a stranded assignee's return actually takes (a soft `status = 'removed'`
-- or a re-role, both UPDATEs of the same `(projectId, userId)` row, and `MembersService.add` upserts
-- onto it). A membership INSERTED for a user who never had one on this project is not serialized —
-- that direction only ever grants standing AFTER this decision, to somebody who was not the
-- assignee when it was made.
CREATE OR REPLACE FUNCTION inspection_assignment_binds(p_project text, p_assignee text)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public AS $binds$
BEGIN
  IF p_assignee IS NULL THEN RETURN false; END IF;
  PERFORM 1 FROM public."Membership" m
   WHERE m."projectId" = p_project AND m."userId" = p_assignee
     FOR UPDATE;
  RETURN EXISTS (
    SELECT 1 FROM public."Membership" m
     WHERE m."projectId" = p_project
       AND m."userId" = p_assignee
       AND m."status" = 'active'
       AND m."role" IN ('engineer')
  );
END;
$binds$;

CREATE OR REPLACE FUNCTION inspection_submit_authority() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $authority$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('readiness:' || NEW."projectId", 0)) THEN
    RAISE EXCEPTION
      'Inspection % cannot be submitted right now: this project''s readiness is held by another transaction, so the assignee''s standing cannot be judged. Retry.',
      NEW."id";
  END IF;
  IF inspection_assignment_binds(NEW."projectId", NEW."assigneeId") THEN
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
