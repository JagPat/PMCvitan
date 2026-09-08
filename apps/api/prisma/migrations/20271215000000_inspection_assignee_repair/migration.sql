-- Repair corrective work that this release's own narrowing would otherwise strand.
--
-- `20271205000000` made `assigneeId` load-bearing for submit authorization and
-- `20271210000000` latched it, and the service narrowed CORRECTIVE_ROLES to
-- ['engineer'] so a rejection is no longer assigned to a contractor. None of that
-- repairs rows the PREVIOUS release already wrote. A project upgraded with an open
-- re-inspection assigned to an active contractor lands in a state with no way out:
--
--   * the contractor is refused by `inspection.submit`'s role ceiling (engineer|pmc),
--   * every engineer and PMC is refused by the exact-assignee guard,
--   * and the latch refuses to clear or reassign the value.
--
-- Corrective work that no caller can submit and no writer can re-route is lost work,
-- so the release that creates the state owes the repair.
--
-- The repair is to UNASSIGN, not to reassign: this migration will not invent a
-- substitute assignee, and it does not need to preserve the old one, because the
-- assignment is already recorded in three durable places `decide` writes in the same
-- transaction as the row — the immutable `inspection.reject` audit payload
-- (`{ reinspectionId, assigneeId, dueDate }`) and the append-only `inspection.rejected`
-- and `inspection.reinspection_created` event payloads. Clearing the column returns the
-- work to the ordinary unassigned pool, where any engineer or PMC can submit it exactly
-- as they could before assignment existed, and the record of who was originally asked
-- survives in the facts that own it.
--
-- The predicate is the SET, not the reported instance: every OPEN inspection whose
-- assignee cannot reach `submit`. A contractor assignee is the case the review found;
-- an assignee whose membership was deactivated or re-roled is the same dead end reached
-- another way, and the latch strands it identically. Both are repaired by one rule.
--
-- Idempotent and safe to re-run: a fresh install has no rows, a repaired database
-- matches nothing, and the statement names no row it did not select.

DO $repair$
DECLARE
  repaired integer;
BEGIN
  -- The latch is a one-way freeze on the SERVICE path. This is the sanctioned repair
  -- path, disabled by NAME (never a blanket `DISABLE TRIGGER ALL`) and re-enabled and
  -- verified below, in the same transaction, so no window exists in which the column is
  -- unprotected and no other trigger is touched.
  ALTER TABLE "Inspection" DISABLE TRIGGER "Inspection_assignee_frozen";

  UPDATE "Inspection" i
     SET "assigneeId" = NULL
   WHERE i."assigneeId" IS NOT NULL
     AND i."submitted" = false
     AND i."decided" = false
     AND NOT EXISTS (
       SELECT 1 FROM "Membership" m
        WHERE m."projectId" = i."projectId"
          AND m."userId"    = i."assigneeId"
          AND m."status"    = 'active'
          AND m."role" IN ('engineer', 'pmc')
     );
  GET DIAGNOSTICS repaired = ROW_COUNT;

  ALTER TABLE "Inspection" ENABLE TRIGGER "Inspection_assignee_frozen";

  -- Fail closed rather than leave the latch off: if the re-enable did not take, the
  -- column is unprotected and this migration must not be recorded as applied.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'Inspection'
       AND t.tgname  = 'Inspection_assignee_frozen'
       AND t.tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Inspection_assignee_frozen is not enabled after the assignee repair — refusing to leave the latch off';
  END IF;

  RAISE NOTICE 'inspection assignee repair: % open inspection(s) returned to the unassigned pool', repaired;
END
$repair$;
