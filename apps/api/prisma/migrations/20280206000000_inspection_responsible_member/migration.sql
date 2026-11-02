-- #482 proof photos, "Who fixes this?" (Jagrut's QA decisions, 14 Oct 2026). A failed inspection item is fixed by a
-- contractor or consultant member, and that member's open items and proof photos follow from naming them. This file adds
-- the column that names them. Nothing writes or reads it yet: the API unit that does ships after this one, alone.
--
-- WHAT. One nullable column, "Inspection"."responsibleMemberId", with a composite foreign key to
-- "Membership"("projectId", "userId") so it can only name a membership of the inspection's own project (memberships are
-- soft-removed, never deleted, so the key never blocks a removal), and an index on ("projectId", "responsibleMemberId")
-- for a member's open-items read. It is not "assigneeId": that names the engineer whose re-inspection it is. The role
-- (contractor or consultant, active) is the service's check at write and again at read, because a membership's role and
-- standing change after the name is written. No backfill: every existing inspection names nobody.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never names the column: its Prisma client neither selects nor
-- writes it, its inserts leave it NULL, and a NULL key is never checked. No trigger on "Inspection" reads it.
--
-- LOCKS WHILE IT RUNS. ADD COLUMN with no default is a catalog change. The index build holds a SHARE lock on
-- "Inspection" for one pass over a small table. The foreign key takes SHARE ROW EXCLUSIVE on both tables and validates
-- in one pass, where every row is NULL. No lock is waited for longer than 15 s (lock_timeout, this transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; IF NOT EXISTS for the column and the index, the key added only when
-- missing. A db-push baseline models all three from schema.prisma, so the file needs no ALWAYS_EXECUTE entry.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "responsibleMemberId" TEXT;

CREATE INDEX IF NOT EXISTS "Inspection_projectId_responsibleMemberId_idx" ON public."Inspection"("projectId", "responsibleMemberId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."Inspection"'::regclass AND conname = 'Inspection_projectId_responsibleMemberId_fkey') THEN
    ALTER TABLE public."Inspection" ADD CONSTRAINT "Inspection_projectId_responsibleMemberId_fkey"
      FOREIGN KEY ("projectId", "responsibleMemberId") REFERENCES public."Membership"("projectId", "userId")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

COMMIT;
