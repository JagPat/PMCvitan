-- #482 test fixes: an org role change between owner and admin rewrites the org authority row in place. This is a database
-- change shipped alone.
--
-- WHY. A writer that needs a person's standing locks, in one order, that person's "OrgUserAuthority" row (FOR SHARE),
-- then their "ProjectUserStanding" row, then the project row: the mark-seen write (notifications-seen.service.ts), the
-- receipt's standing trigger (20280109), the visit trigger (20280112) and every 4d actor envelope (actor-envelope.ts).
-- A change to the "OrgMembership" row takes the same rows in the same order through its two AFTER triggers: the
-- authority row ("OrgMembership_t4d_org_authority"), then the standing rows ("OrgMembership_t4d_user_standing").
--
-- But 20271220's authority trigger wrote an owner-to-admin or admin-to-owner change as a DELETE of the row and an
-- INSERT of a new one. A reader waiting FOR SHARE on that row under READ COMMITTED, when the change commits, finds the
-- row it waited on deleted and locks nothing: PostgreSQL follows an updated row to its new version, never a deleted
-- one to a new row. It goes on to lock the standing row holding no authority lock. The next role change then deletes
-- the new authority row, which nobody holds, and waits for the standing row; the reader's next statement waits FOR
-- SHARE on the authority row that change deleted. Each waits on the other: a deadlock (CI, #1052 attempt 1,
-- top10-4b-notifications-seen.test.ts:415; forced in that file's "forced order" test).
--
-- WHAT. When the role changes between 'owner' and 'admin' on the same company and person, the trigger only upserts
-- the authority row ("ON CONFLICT ... DO UPDATE"), which UPDATEs it in place. A waiting reader then locks the new
-- version, and the next change waits for that reader at the first lock of the order. Every other change (a gain, a
-- loss, a removal, an insert) is written as before. The stored rows are the same either way, so nothing is backfilled.
--
-- SAFE UNDER THE PREVIOUS RELEASE. No application code writes "OrgUserAuthority"; the function's result is the same
-- row, only written by UPDATE where it was DELETE and INSERT.
--
-- NAMES. The function is replaced in place with search_path pg_catalog, public, pg_temp and qualified names. It is one
-- statement, so it installs whole or not at all. Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a baseline
-- resolves a migration as applied without running it, and a function body is not in schema.prisma, so a ledger-less
-- restore taken before this file keeps 20271220's body, and a database without A7d replays 20271220 and reinstalls it;
-- replayed after it, this file puts the in-place body back.
CREATE OR REPLACE FUNCTION public.phase6_t4d_org_authority() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."role" IN ('owner', 'admin') AND NEW."role" IN ('owner', 'admin')
     AND OLD."orgId" = NEW."orgId" AND OLD."userId" = NEW."userId" THEN
    -- in place: a reader waiting on the row locks its new version
    PERFORM public.platform_org_authority_apply(NEW."orgId", NEW."userId", NEW."role", TRUE);
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' AND (OLD."role" IN ('owner', 'admin')) THEN
    PERFORM public.platform_org_authority_apply(OLD."orgId", OLD."userId", OLD."role", FALSE);
  END IF;
  IF TG_OP <> 'DELETE' AND (NEW."role" IN ('owner', 'admin')) THEN
    PERFORM public.platform_org_authority_apply(NEW."orgId", NEW."userId", NEW."role", TRUE);
  END IF;
  RETURN NULL;
END $$;
