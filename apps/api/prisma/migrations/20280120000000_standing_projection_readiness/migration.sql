-- #1100 (Unit 2a of the #1076 plan, #1094 comment 6362982215): a direct write that changes who holds a role on a
-- project is refused while that project's readiness key is held elsewhere. This is a database change shipped alone.
--
-- WHY. Every app writer of "Membership" and of owner/admin "OrgMembership" takes the project's readiness key before it
-- writes (members.service, auth.service sign-up, orgs.service createProject, `lockOrgStandingWriters`). A decision
-- command takes the same key first, so under it the set of people holding a role on the project cannot change. A
-- DIRECT write takes no key: its projection ("Membership_t4d_role_standing", "OrgMembership_t4d_user_standing",
-- "Project_t4d_user_standing", all through this function) runs uncontended, as 20271220 says of
-- `platform_role_has_holder`. So a raw `INSERT INTO "Membership"` can add a holder to a role while a forward to that
-- role has already read its holders. The forward then holds no anchor for the new holder, and its seal's
-- `platform_role_has_holder ... FOR UPDATE` can wait on that holder's row while the holder's own mark waits on the
-- project row the forward holds: a deadlock (#1076's review, discussion_r4358540856).
--
-- WHAT. Before this function adds a "ProjectUserStanding" row that is not there, or deletes one that is, it tries
-- the project's readiness key (`phase6_try_readiness`) and refuses the write if another transaction holds it, as
-- `phase6_t4d_actor_bound` already does for a direct fact write. A write that changes nothing (an upsert of a row that
-- exists, which only refreshes its "membershipId", or a delete of a row that is not there) is not refused: the org
-- roster's member-only arm takes no project key and its trigger fans out a no-op delete to every project of the org.
--
-- LOCK ORDER. A try-lock never waits, so it adds no edge to any wait cycle. It is re-entrant in a transaction, so
-- every app writer, which holds the key already, takes it again at no cost and is never refused. A direct writer that
-- gets it holds it to commit, like every app writer: a decision command waits on it at its first lock and the direct
-- writer waits on nothing that command holds.
--
-- OTHER FENCES. A direct write that does change a holder now holds the project's readiness key until it commits, so
-- a fence that try-locks that key refuses as contended while it is open, where before it could reach its own row lock
-- (20271216's inspection submit fence: a raw reactivation of the assignee now refuses the submit at once, with that
-- fence's "readiness is held by another transaction" message; inspections-idempotency.test.ts, ROUND 9).
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release's writers all hold the key (above), so they behave as
-- before. Only a direct SQL write that changes a role's holders while a command holds the key elsewhere is refused,
-- and it can be run again. A new project's key is free when it is created, so a project insert is never refused.
--
-- NAMES. The function is replaced in place with search_path pg_catalog, public, pg_temp and qualified names. It is one
-- statement, so it installs whole or not at all. Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE for the
-- reason 20280119 is: a function body is not in schema.prisma, so a ledger-less restore or a replay of 20271220 would
-- reinstall 20271220's body, and replayed after it this file puts this one back.
CREATE OR REPLACE FUNCTION public.platform_user_standing_apply(
  p_project TEXT, p_user TEXT, p_role TEXT, p_membership TEXT, p_present BOOLEAN
) RETURNS VOID LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_exists BOOLEAN := EXISTS (
    SELECT 1 FROM public."ProjectUserStanding"
     WHERE "projectId" = p_project AND "userId" = p_user AND "role" = p_role);
BEGIN
  IF v_exists IS DISTINCT FROM p_present AND NOT public.phase6_try_readiness(p_project) THEN
    RAISE EXCEPTION 'phase6 4d: the project readiness key is held elsewhere — this direct write of % standing on project % is refused rather than waiting inside a trigger', p_role, p_project;
  END IF;
  IF p_present THEN
    INSERT INTO public."ProjectUserStanding" ("projectId", "userId", "role", "membershipId")
    VALUES (p_project, p_user, p_role, p_membership)
    ON CONFLICT ("projectId", "userId", "role")
    DO UPDATE SET "membershipId" = EXCLUDED."membershipId";
  ELSE
    DELETE FROM public."ProjectUserStanding"
     WHERE "projectId" = p_project AND "userId" = p_user AND "role" = p_role;
  END IF;
END $$;
