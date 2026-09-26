-- Phase 6 correction — the Project row lock a seal takes to judge operability is FOR NO KEY UPDATE.
--
-- WHAT THE LOCK IS FOR. `phase6_project_operable` (4c-i) and `phase6_user_decision_authority` (4b)
-- read `Project."archivedAt"` while HOLDING the project row, so a seal cannot read the project
-- operable, lose the race to a committing archive, and still commit its immutable row. The archive
-- is an UPDATE of `archivedAt` (`OrgsService`), a non-key column, which PostgreSQL performs under
-- FOR NO KEY UPDATE. So the lock these functions need is the one that conflicts with THAT write.
--
-- WHAT FOR UPDATE ADDED ON TOP. FOR UPDATE also conflicts with FOR KEY SHARE, the lock every
-- foreign-key check takes on the row it references, held until the checking transaction ends. A
-- ledgered command's `CommandExecution` reservation references `Project(orgId, id)`
-- (`CommandExecution_tenant_fkey`) and is inserted BEFORE the command's body runs. So two ledgered
-- commands on one project interleave like this:
--
--   A  reserves its receipt  (KEY SHARE on the project)       B  reserves its receipt (KEY SHARE)
--   A  takes the readiness key
--                                                             B  waits for the readiness key
--   A  writes a fact whose seal calls one of these functions:
--      FOR UPDATE on the project waits for B's KEY SHARE     → deadlock; PostgreSQL aborts one
--
-- Measured with 4d-ii-a / A2's `requestChange`, whose standard request carries the frozen requester
-- pair: the pair's seal (`ChangeRequest_t4d_birth_pair` → `phase6_t4d_actor_bound`) reaches
-- `phase6_project_operable`, and two simultaneous requests on one decision answered 201 and 500 (a
-- `40P01`) where the loser is owed a 409. Every 4d fact seal goes through the same function, so
-- every 4d-ii command that records a fact under the ledger would meet it.
--
-- FOR NO KEY UPDATE keeps every serialization these functions exist for — against the archive's
-- UPDATE, a project DELETE, a key-column change, and each other — and drops only the conflict with
-- a foreign-key check, which reads the key and never changes the project. The bodies are otherwise
-- the delivered ones, character for character.
--
-- RE-RUNNABLE (it is on `ALWAYS_EXECUTE`): `CREATE OR REPLACE FUNCTION` only. It sorts after the 4b
-- and 4c migrations that first define these functions, which `ALWAYS_EXECUTE` also re-runs, so on
-- every deploy this definition is the one that stands.

CREATE OR REPLACE FUNCTION phase6_project_operable(p_project TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_archived TIMESTAMP(3);
BEGIN
  SELECT "archivedAt" INTO v_archived FROM "Project" WHERE "id" = p_project FOR NO KEY UPDATE;
  IF NOT FOUND THEN RETURN FALSE; END IF;
  RETURN v_archived IS NULL;
END $$;

CREATE OR REPLACE FUNCTION phase6_user_decision_authority(p_project TEXT, p_user TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql VOLATILE AS $$
DECLARE proj RECORD; explicit_role TEXT;
BEGIN
  IF p_user IS NULL THEN RETURN FALSE; END IF;
  SELECT "orgId", "archivedAt" INTO proj FROM "Project" WHERE "id" = p_project FOR NO KEY UPDATE;
  IF NOT FOUND OR proj."archivedAt" IS NOT NULL THEN RETURN FALSE; END IF;
  SELECT m."role" INTO explicit_role FROM "Membership" m
   WHERE m."projectId" = p_project AND m."userId" = p_user AND m."status" = 'active';
  IF explicit_role IS NOT NULL THEN RETURN explicit_role = 'pmc'; END IF;
  RETURN EXISTS (
    SELECT 1 FROM "OrgMembership" om
     WHERE om."orgId" = proj."orgId" AND om."userId" = p_user AND om."role" IN ('owner', 'admin')
  );
END $$;
