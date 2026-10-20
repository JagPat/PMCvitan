-- #482 QA company lock (Jagrut, 20 Oct 2026: "Rebuild it" on the QA sign-in door card). The operator door's QA sign-in
-- (#983) had to re-check on every request that the QA company still held only QA people, and each check raced anyone
-- adding a member. This file moves that rule into the database, so the door can trust it. It ships alone, before the
-- door that uses it.
--
-- WHAT. One column, "Org"."qaOnly" (default false), marks a company as QA-only. Every company starts unmarked, so this
-- file changes no stored row; an operator marks the QA company later, through the door unit.
--
-- A QA address is `qa.<lowercase letters>@vitan.in`, matched exactly as stored: the pattern the Board fixed for the QA
-- accounts, the same one `project-remove.ts` QA_EMAIL holds.
--
-- WHAT THE DATABASE GUARANTEES, for every writer, raw SQL included. "A company's people" are its "OrgMembership" rows
-- and every "Membership" on its projects that is not 'removed' (an invited person can become active without another
-- check, so invited counts).
--   Q1  A QA-only company's people all have QA addresses.
--   Q2  A person with a QA address belongs only to QA-only companies (and their projects).
--   So a QA account reaches only QA-only companies, and those hold only QA accounts, and that stays true: each write
--   that could break it is refused (check_violation):
--     - adding or changing a company membership, or a project membership that is not 'removed' (trigger
--       "OrgMembership_qa_lock", "Membership_qa_lock");
--     - changing a person's email to or from a QA address while they belong anywhere ("User_qa_lock");
--     - marking or unmarking a company while its people do not already fit the new mark ("Org_qa_lock"). So the QA
--       company is marked only while it holds QA people alone, and can never be unmarked while it holds any. Marking
--       also checks Q2 for those people: rows written before this file never met it, so a QA account that still
--       belongs to an unmarked company refuses the mark until that membership is removed.
--   Removing a membership (deleting it, or setting it 'removed') is always allowed: it can only make the rule truer.
--   A project never moves company: phase 6-4b's "Project"."orgId" freeze refuses it, and that file is on ALWAYS_EXECUTE,
--   so a `db push` baseline has it too. A project membership's person and project are frozen by phase 6-4b as well,
--   but that file is not replayed on a baseline, so "Membership_qa_lock" also checks a change of either itself.
--
-- RACES. Each trigger runs AFTER its row is written (so that row is locked) and locks FOR SHARE the other rows its
-- answer depends on, always in one order: project, then company, then person. Two writes that could break the rule
-- only together therefore run one after the other, and the second sees the first; and no trigger waits on a row while
-- holding one a waiter of its own needs, so the lock adds no deadlock (see the note above "user_qa_lock"). Under READ
-- COMMITTED each query inside a trigger reads what is committed when it runs; under REPEATABLE READ or SERIALIZABLE a
-- conflicting lock fails the write (a serialization error), which also refuses it.
--
-- NOT HERE. Whether a person may sign in is the auth module's rule; "User"."projectId" (the landing project) grants no
-- access by itself, so it is not part of a company's people.
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE: a `db push` baseline models the column but not the
-- triggers. Every statement is guarded or replaces itself.

ALTER TABLE "Org" ADD COLUMN IF NOT EXISTS "qaOnly" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION qa_address(p_email TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT p_email IS NOT NULL AND p_email ~ '^qa\.[a-z]+@vitan\.in$'
$$;

-- Q1 and Q2 for one address in one company: refuse unless the address fits the company's mark.
CREATE OR REPLACE FUNCTION qa_lock_fits(p_user TEXT, p_email TEXT, p_org TEXT, p_qa_only BOOLEAN) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_qa_only AND NOT qa_address(p_email) THEN
    RAISE EXCEPTION 'qa lock: company % is QA-only, and % is not a QA account', p_org, p_user
      USING ERRCODE = 'check_violation';
  ELSIF NOT p_qa_only AND qa_address(p_email) THEN
    RAISE EXCEPTION 'qa lock: % is a QA account, and company % is not QA-only', p_user, p_org
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- A new or changed membership: lock the company, then the person (FOR SHARE), in that order everywhere. A membership
-- row is written only after its project is found, so a project membership locks the project before the company.
CREATE OR REPLACE FUNCTION qa_lock_member(p_user TEXT, p_org TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_qa_only BOOLEAN;
  v_email TEXT;
BEGIN
  SELECT "qaOnly" INTO v_qa_only FROM "Org" WHERE "id" = p_org FOR SHARE;
  IF NOT FOUND THEN
    RETURN; -- the foreign key refuses a missing company
  END IF;
  SELECT "email" INTO v_email FROM "User" WHERE "id" = p_user FOR SHARE;
  IF NOT FOUND THEN
    RETURN; -- the foreign key refuses a missing person
  END IF;
  PERFORM qa_lock_fits(p_user, v_email, p_org, v_qa_only);
END;
$$;

CREATE OR REPLACE FUNCTION org_membership_qa_lock() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM qa_lock_member(NEW."userId", NEW."orgId");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION membership_qa_lock() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_org TEXT;
BEGIN
  IF NEW."status" = 'removed' THEN
    RETURN NULL;
  END IF;
  SELECT "orgId" INTO v_org FROM "Project" WHERE "id" = NEW."projectId" FOR SHARE;
  IF FOUND THEN
    PERFORM qa_lock_member(NEW."userId", v_org);
  END IF;
  RETURN NULL;
END;
$$;

-- The two triggers below each hold their own row (the person, the company) by the time they run. They
-- lock only the projects and companies they read, never another person, so none of them waits on a membership write,
-- and a membership write that needs the row they hold waits for them and then reads what they committed. The people
-- they read are read without a lock: a person's own address can change only under that person's row lock, and
-- "User_qa_lock" then checks that change itself, after waiting for any company or project lock held here.

-- a person's address changes to or from a QA address: check every company they belong to, through either kind of
-- membership (their projects locked first, then the companies)
CREATE OR REPLACE FUNCTION user_qa_lock() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_org TEXT;
  v_qa_only BOOLEAN;
BEGIN
  IF qa_address(NEW."email") = qa_address(OLD."email") THEN
    RETURN NULL;
  END IF;
  PERFORM 1 FROM "Project" p
    WHERE p."id" IN (SELECT m."projectId" FROM "Membership" m WHERE m."userId" = NEW."id" AND m."status" <> 'removed')
    ORDER BY p."id" FOR SHARE;
  FOR v_org, v_qa_only IN
    SELECT o."id", o."qaOnly" FROM "Org" o
     WHERE o."id" IN (SELECT om."orgId" FROM "OrgMembership" om WHERE om."userId" = NEW."id"
                      UNION
                      SELECT p."orgId" FROM "Membership" m JOIN "Project" p ON p."id" = m."projectId"
                       WHERE m."userId" = NEW."id" AND m."status" <> 'removed')
     ORDER BY o."id" FOR SHARE
  LOOP
    PERFORM qa_lock_fits(NEW."id", NEW."email", v_org, v_qa_only);
  END LOOP;
  RETURN NULL;
END;
$$;

-- a company is marked or unmarked: its people must already fit the new mark
CREATE OR REPLACE FUNCTION org_qa_lock() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_user TEXT;
  v_email TEXT;
  v_other TEXT;
BEGIN
  IF NEW."qaOnly" IS NOT DISTINCT FROM OLD."qaOnly" THEN
    RETURN NULL;
  END IF;
  FOR v_user, v_email IN
    SELECT u."id", u."email" FROM "User" u
     WHERE u."id" IN (SELECT om."userId" FROM "OrgMembership" om WHERE om."orgId" = NEW."id"
                      UNION
                      SELECT m."userId" FROM "Membership" m JOIN "Project" p ON p."id" = m."projectId"
                       WHERE p."orgId" = NEW."id" AND m."status" <> 'removed')
  LOOP
    PERFORM qa_lock_fits(v_user, v_email, NEW."id", NEW."qaOnly");
    -- marking: each of its people is a QA account by now, and must belong to no other unmarked company (Q2). Read
    -- without a lock: no write can add such a membership meanwhile (a QA account joining an unmarked company is
    -- refused), an unmark of that other company is refused while it holds this person, and a concurrent mark of it
    -- is read as unmarked, which refuses this mark rather than letting Q2 slip.
    IF NEW."qaOnly" THEN
      SELECT o."id" INTO v_other FROM "Org" o
       WHERE o."id" <> NEW."id" AND NOT o."qaOnly"
         AND o."id" IN (SELECT om."orgId" FROM "OrgMembership" om WHERE om."userId" = v_user
                        UNION
                        SELECT p."orgId" FROM "Membership" m JOIN "Project" p ON p."id" = m."projectId"
                         WHERE m."userId" = v_user AND m."status" <> 'removed')
       ORDER BY o."id" LIMIT 1;
      IF FOUND THEN
        RAISE EXCEPTION 'qa lock: % is a QA account that still belongs to company %, which is not QA-only', v_user, v_other
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS "OrgMembership_qa_lock" ON "OrgMembership";
CREATE TRIGGER "OrgMembership_qa_lock"
  AFTER INSERT OR UPDATE OF "userId", "orgId" ON "OrgMembership"
  FOR EACH ROW EXECUTE FUNCTION org_membership_qa_lock();

DROP TRIGGER IF EXISTS "Membership_qa_lock" ON "Membership";
CREATE TRIGGER "Membership_qa_lock"
  AFTER INSERT OR UPDATE OF "status", "userId", "projectId" ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION membership_qa_lock();

DROP TRIGGER IF EXISTS "User_qa_lock" ON "User";
CREATE TRIGGER "User_qa_lock"
  AFTER UPDATE OF "email" ON "User"
  FOR EACH ROW EXECUTE FUNCTION user_qa_lock();

DROP TRIGGER IF EXISTS "Org_qa_lock" ON "Org";
CREATE TRIGGER "Org_qa_lock"
  AFTER UPDATE OF "qaOnly" ON "Org"
  FOR EACH ROW EXECUTE FUNCTION org_qa_lock();
