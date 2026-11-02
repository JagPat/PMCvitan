-- #482 proof photos, "Who fixes this?" (Jagrut's QA decisions, 14 Oct 2026). A failed inspection item is fixed by a
-- contractor or consultant member, and that member's open items and proof photos follow from naming them. This file adds
-- the column that names them. Nothing writes or reads it yet: the API unit that does ships after this one, alone.
--
-- WHAT. Two nullable columns. "Inspection"."responsibleMemberId" has a composite foreign key to
-- "Membership"("projectId", "userId") so it can only name a membership of the inspection's own project (memberships are
-- soft-removed, never deleted, so the key never blocks a removal; a hard delete of a named membership is refused, and
-- the project-removal tool deletes child tables first by reading these keys), and an index on ("projectId", "responsibleMemberId")
-- for a member's open-items read. It is not "assigneeId": that names the engineer whose re-inspection it is. The role
-- (contractor or consultant, active) is the service's check at write and again at read, because a membership's role and
-- standing change after the name is written. No backfill: every existing inspection names nobody.
--
-- "Inspection"."responsibleStandingMark" is the second column (Stage 1's RM-a gap-check, G1: a name holds only while its
-- member has stood WITHOUT A BREAK since it was set). At naming, the API stores the member's count of standing-changing
-- membership transitions (asked of the orgs module, under the project's readiness key, which every member writer takes
-- before it writes a transition). The read serves the name only while that count is unchanged. A count, not a time:
-- a transition's time is its transaction's START, so a removal that began before the naming and committed after it
-- would carry an earlier time. A CHECK keeps the pair whole: both NULL, or both set with a mark of zero or more.
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never names the column: its Prisma client neither selects nor
-- writes either column, its inserts leave both NULL, a NULL key is never checked, and two NULLs pass the CHECK. No trigger
-- on "Inspection" reads either.
--
-- LOCKS WHILE IT RUNS. ADD COLUMN takes ACCESS EXCLUSIVE on "Inspection" and, like every lock here, holds it until
-- COMMIT, so inspection reads and writes wait for the whole file. The index build reads "Inspection" once (measured at
-- the gap-check: 0.93 s for a million rows). The foreign key takes SHARE ROW EXCLUSIVE on "Membership", so membership
-- writes wait too, and validates in one pass where every row is NULL (0.10 s for a million rows). The CHECK validates in
-- one more pass under the lock already held. Today's tables are far smaller. No lock is waited for longer than 15 s (lock_timeout, this transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE, AND NEVER TRUSTING A NAME. BEGIN ... COMMIT. The columns are added when missing, and
-- the index, the key and the CHECK are made when missing. Whatever already stands under any of these names must be
-- exactly this file's definition: a nullable text column, a nullable integer column, the two-column btree index, the key
-- with NO ACTION on delete and update, and the pair CHECK. Anything else (for example a CASCADE key, an index on one
-- column, or a looser CHECK) is refused with an error rather than kept. A db-push baseline models the columns, the index
-- and the key from schema.prisma but not the CHECK, so the file is on `scripts/migrate.sh`'s ALWAYS_EXECUTE. The
-- definitions are compared under a fixed search_path, so they print the same way on every run.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);
SELECT pg_catalog.set_config('search_path', 'pg_catalog, public', true);

ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "responsibleMemberId" TEXT;
ALTER TABLE public."Inspection" ADD COLUMN IF NOT EXISTS "responsibleStandingMark" INTEGER;

DO $$
DECLARE
  col record;
  def text;
BEGIN
  SELECT a.atttypid::regtype::text AS typ, a.attnotnull AS notnull INTO col
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public."Inspection"'::regclass AND a.attname = 'responsibleMemberId' AND NOT a.attisdropped;
  IF col.typ IS DISTINCT FROM 'text' OR col.notnull THEN
    RAISE EXCEPTION 'Inspection.responsibleMemberId already stands as % (not null: %), not a nullable text column', col.typ, col.notnull;
  END IF;
  SELECT a.atttypid::regtype::text AS typ, a.attnotnull AS notnull INTO col
    FROM pg_catalog.pg_attribute a
   WHERE a.attrelid = 'public."Inspection"'::regclass AND a.attname = 'responsibleStandingMark' AND NOT a.attisdropped;
  IF col.typ IS DISTINCT FROM 'integer' OR col.notnull THEN
    RAISE EXCEPTION 'Inspection.responsibleStandingMark already stands as % (not null: %), not a nullable integer column', col.typ, col.notnull;
  END IF;

  IF to_regclass('public."Inspection_projectId_responsibleMemberId_idx"') IS NULL THEN
    CREATE INDEX "Inspection_projectId_responsibleMemberId_idx" ON public."Inspection"("projectId", "responsibleMemberId");
  END IF;
  def := pg_catalog.pg_get_indexdef('public."Inspection_projectId_responsibleMemberId_idx"'::regclass);
  IF def IS DISTINCT FROM 'CREATE INDEX "Inspection_projectId_responsibleMemberId_idx" ON public."Inspection" USING btree ("projectId", "responsibleMemberId")' THEN
    RAISE EXCEPTION 'the index Inspection_projectId_responsibleMemberId_idx already stands as something else: %', def;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."Inspection"'::regclass AND conname = 'Inspection_projectId_responsibleMemberId_fkey') THEN
    ALTER TABLE public."Inspection" ADD CONSTRAINT "Inspection_projectId_responsibleMemberId_fkey"
      FOREIGN KEY ("projectId", "responsibleMemberId") REFERENCES public."Membership"("projectId", "userId")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO def FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public."Inspection"'::regclass AND c.conname = 'Inspection_projectId_responsibleMemberId_fkey';
  IF def IS DISTINCT FROM 'FOREIGN KEY ("projectId", "responsibleMemberId") REFERENCES "Membership"("projectId", "userId")' THEN
    RAISE EXCEPTION 'the key Inspection_projectId_responsibleMemberId_fkey already stands as something else: %', def;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."Inspection"'::regclass AND conname = 'Inspection_responsible_mark_pair_check') THEN
    ALTER TABLE public."Inspection" ADD CONSTRAINT "Inspection_responsible_mark_pair_check" CHECK (
      ("responsibleMemberId" IS NULL AND "responsibleStandingMark" IS NULL)
      OR ("responsibleMemberId" IS NOT NULL AND "responsibleStandingMark" IS NOT NULL AND "responsibleStandingMark" >= 0));
  END IF;
  SELECT pg_catalog.pg_get_constraintdef(c.oid) INTO def FROM pg_catalog.pg_constraint c
   WHERE c.conrelid = 'public."Inspection"'::regclass AND c.conname = 'Inspection_responsible_mark_pair_check' AND c.contype = 'c';
  IF def IS DISTINCT FROM 'CHECK (((("responsibleMemberId" IS NULL) AND ("responsibleStandingMark" IS NULL)) OR (("responsibleMemberId" IS NOT NULL) AND ("responsibleStandingMark" IS NOT NULL) AND ("responsibleStandingMark" >= 0))))' THEN
    RAISE EXCEPTION 'the check Inspection_responsible_mark_pair_check already stands as something else: %', def;
  END IF;
END $$;

COMMIT;
