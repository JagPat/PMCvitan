-- `Inspection.assigneeId` is frozen after insert: it is an authority claim, not a mutable field.
--
-- WHAT CHANGED ABOVE IT. This release makes `assigneeId` load-bearing twice over: the read offers a
-- non-PMC viewer only unassigned work and their own, and `submit` accepts only the assignee. Before
-- that the column was descriptive — who the corrective work was FOR — and nothing depended on it, so
-- nothing had to defend it. Now the row's value decides who may act and whose name is recorded as
-- having done the work, while the column itself stayed freely updateable.
--
-- THE FAILURE THAT ALLOWS. An alternate writer — a fixture, a support script, a future service path,
-- a hand-run UPDATE — moves the value from A to B. B then passes the submit guard and is stamped as
-- the submitter of work assigned to A. The ownership claim is rewritten with no transition anyone
-- can point to, and the audit trail agrees with the forgery because the forgery happened first.
--
-- THE RULE, AND ITS EXACT EDGE. A NAMED assignee is final: once the column holds a value it can
-- never become a different value, and never become NULL again. Naming a previously unassigned
-- checklist is NOT blocked, because that rewrites nobody's claim — the attack this closes is the
-- substitution of B for A, and unassigned work has no A to substitute. Stating it as "never changes
-- at all" would have been the stronger-sounding rule and the wrong one: it would forbid a future
-- assign-this-checklist feature at the database while adding nothing against the actual forgery.
--
-- This costs no current path: the service writes the column exactly once, in the `decide` rejection
-- that creates the re-inspection, and nothing updates it. Every other UPDATE on this table (submit,
-- decide, sign-off) leaves it untouched and passes unnoticed, because the trigger compares only it.
--
-- Reassignment, if it is ever wanted, is a NEW attributable command with its own audited transition
-- — the shape this project uses everywhere else for a change of responsible party. It is deliberately
-- not smuggled in here as a general UPDATE permission.
--
-- Additive and diagnostic-free by construction: it constrains future writes only, reads nothing, and
-- backfills nothing, so it cannot abort on existing data and legacy databases upgrade untouched.
CREATE OR REPLACE FUNCTION inspection_assignee_frozen() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $frozen$
BEGIN
  IF OLD."assigneeId" IS NOT NULL AND NEW."assigneeId" IS DISTINCT FROM OLD."assigneeId" THEN
    RAISE EXCEPTION
      'Inspection.assigneeId is frozen: % cannot be reassigned to % (inspection %). A named assignee is final; reassignment would need its own attributable command.',
      OLD."assigneeId", COALESCE(NEW."assigneeId", '(unassigned)'), OLD."id";
  END IF;
  RETURN NEW;
END;
$frozen$;

DROP TRIGGER IF EXISTS "Inspection_assignee_frozen" ON "Inspection";
CREATE TRIGGER "Inspection_assignee_frozen"
  BEFORE UPDATE ON "Inspection"
  FOR EACH ROW EXECUTE FUNCTION inspection_assignee_frozen();
