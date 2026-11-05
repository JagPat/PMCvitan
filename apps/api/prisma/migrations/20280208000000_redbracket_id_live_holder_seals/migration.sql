-- Redbracket ID A4b-m: THE DATABASE HOLDER SEALS COUNT LIVE HOLDERS.
--
-- WHY. With `IDENTITY_OIDC=1`, an established account whose email first signs in through Redbracket ID is
-- retired (an `IdentityRetirement` row, 20280203000000) and the person gets a new account. Retirement moves no
-- seat: the retired row keeps its active memberships until the team re-seats the person. Nobody can sign in as a
-- retired row, so it can decide nothing. The delivered holder seals (`Membership_t4b2_holder_guard`,
-- `OrgMembership_t4b2_holder_guard`, `Membership_t4d_holder_guard`) refuse a write that leaves a published open
-- decision's ROLE with no effective holder, but they count the retired row. With one live client, one retired
-- client and an open client-held decision, a direct removal of the live client's membership passes them (the raw
-- count stays at one) and leaves the decision with nobody who can decide it (PR #1326, Codex 4452016264). The
-- team commands already refuse that write (#1326, `liveRoleStanding`); this file teaches the database backstop
-- the same rule, so a writer outside the commands (operator SQL) meets it too.
--
-- WHAT. SEPARATE triggers beside the delivered ones (two AFTER-row membership seals here; the decision and user seals
-- below), the 4d-i way (its PART 3d note: a second
-- trigger adds refusals without touching a byte of the delivered function, so nothing delivered is reverted):
--   · `public.platform_user_retired(user)`: PLATFORM-owned, the one read of the platform's retirement record.
--     The orgs functions below ask it and never read `IdentityRetirement` themselves.
--   · `public.phase6_live_role_standing(project, role)`: ORGS-owned, `phase6_effective_role_standing` with the
--     same precedence (an explicit active membership wins over the org arm), counting only users the platform
--     does not call retired.
--   · `Membership_x_live_holder_guard` / `OrgMembership_x_live_holder_guard`: judge exactly the writes the
--     delivered guards judge, for the same roles (`client`, `pmc`; plus a decision awaiting countersign, as the
--     4d guard does). Each refuses only the GAP: effective standing above zero (the delivered seal passed it) and
--     live standing at zero. A zero effective count stays the delivered seal's to refuse, with its own message.
--   · A write whose own user is retired reduces no live standing, so it is never judged here: removing a retired
--     row (the re-seat's last step) is never refused by this file, even when no live holder exists yet, because
--     that shortfall is not this write's (the delivered seals' rule: "never for a pre-existing shortfall some
--     unrelated write did not cause").
--   · A USER'S DELETE is judged as a whole at the `User` row, BEFORE any cascade (#1327 r1 Codex 4452669493, r2
--     Codex 4453555401). PostgreSQL fires the FK actions on `User` (the retirement record, the memberships, the org
--     memberships) in no promised order, so a per-row judgement in the cascade sees a half-deleted user: the
--     retirement record may already be gone, or an explicit seat may already have stopped (or not yet stopped)
--     suppressing the org arm. `User_x_live_holder_guard` refuses a RETIRED user's delete while it holds an active
--     project seat or an owner/admin company seat (re-seat first), and judges a LIVE user's delete per affected
--     project on its own contribution (the live count with and without them: one precedence function). The cascaded org-membership rows then
--     skip the org guard, because their user row is gone and the boundary already judged the delete.
--   · The raise starts `phase6-4b:`, so a member or org command that meets it answers 409 through
--     `rethrowHolderSealViolation`, like the delivered seal.
--
-- PUBLICATION, BIRTH, REOPEN AND FORWARD (#1327 r1, Codex 4452669484). `Decision_x_live_holder_standing` judges the
-- three boundaries the delivered `Decision_t4b2_lifecycle_seal` judges (a row born published as pending or change; a
-- draft's publication; `approved → change`) plus a holder move on a published open row (the 4d forward), under the
-- same readiness key: a role holder (client, pmc) on live standing, a named membership (member) on its user not
-- being retired. It refuses only the gap (effective above zero, live zero; or an active named membership of a
-- retired user); a zero effective count or an inactive named membership stays the delivered seal's refusal. The
-- decisions service judges the same boundaries on the effective count and on an active membership today, so a
-- publication, create-published, change request or forward that meets this seal (only while a retired row holds a
-- seat, which needs `IDENTITY_OIDC=1`) fails closed as a server error until the service judges live holders too
-- (A4b-s, a pilot switch-on precondition).
--
-- NAMES SORT LAST. PostgreSQL fires same-kind triggers in name order. `_x_` sorts after `_qa_`, `_t4a_`, `_t4b_`,
-- `_t4b2_` and `_t4d_`, so the delivered seals judge first and keep their messages; these add only the live arm.
--
-- WHAT THIS FILE DOES NOT DO. No delivered function or trigger is replaced or dropped; no deployed migration is
-- edited; no table, column or row is written. The architect arm is not added: an architect membership and an
-- architect-held decision are both refused at the database while 4d-i's doors stand
-- (`Membership_t4d_architect_reserved`, `Decision_t4d_architect_reserved`), and the A4b command guard counts the
-- architect live (`liveArchitectStanding`) for the day they open. The trigger names avoid `_t4d_`, whose
-- inventory is 4d-i's own (phase6-t4d-i-seal-inventory).
--
-- SAFE UNDER THE PREVIOUS RELEASE. It refuses a write only while a retired row holds a seat, and a retired row
-- exists only with `IDENTITY_OIDC=1`, which is off. A previous-release member or org command that met it would
-- answer 409; a previous-release publication or change request would fail closed (500), as above.
--
-- ORDERING. The readiness key is the delivered seals' (`phase6_try_readiness`, reentrant, try-or-refuse), taken
-- before the judgement, as they do. A retirement takes no readiness key and is never refused (it is a person's
-- first sign-in), so a holder judged live here can be retired after this write commits; that state is the one
-- the plain order reaches, and #1326's residuals end it (the RUNBOOK re-seat and an empty `retired` list).
--
-- Re-runnable: CREATE OR REPLACE and DROP TRIGGER IF EXISTS. Schema-qualified, with a fixed search_path.

CREATE OR REPLACE FUNCTION public.platform_user_retired(p_user TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM public."IdentityRetirement" r WHERE r."userId" = p_user);
$$;

-- One implementation of the precedence (an explicit active membership counts its role; the membership-less org
-- owner/admin arm counts `pmc`), with an optional user left out: the User-row guard asks the same function what the
-- project's live standing is without the user being deleted, never a second copy of the rule.
CREATE OR REPLACE FUNCTION public.phase6_live_role_standing(p_project TEXT, p_role TEXT, p_without_user TEXT)
RETURNS BIGINT LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (
    SELECT count(*) FROM public."Membership" m
     WHERE m."projectId" = p_project AND m."status" = 'active' AND m."role" = p_role
       AND m."userId" IS DISTINCT FROM p_without_user
       AND NOT public.platform_user_retired(m."userId")
  ) + CASE WHEN p_role = 'pmc' THEN (
    SELECT count(*) FROM public."Project" p
      JOIN public."OrgMembership" om ON om."orgId" = p."orgId" AND om."role" IN ('owner', 'admin')
     WHERE p."id" = p_project
       AND om."userId" IS DISTINCT FROM p_without_user
       AND NOT public.platform_user_retired(om."userId")
       AND NOT EXISTS (
         SELECT 1 FROM public."Membership" m2
          WHERE m2."projectId" = p_project AND m2."userId" = om."userId" AND m2."status" = 'active'
       )
  ) ELSE 0 END;
$$;

CREATE OR REPLACE FUNCTION public.phase6_live_role_standing(p_project TEXT, p_role TEXT)
RETURNS BIGINT LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT public.phase6_live_role_standing(p_project, p_role, NULL);
$$;

-- A published open decision held by this role: pending or change (the delivered 4b set) or awaiting countersign
-- (the 4d guard's widened set; that status is itself reserved while 4d-i's doors stand).
CREATE OR REPLACE FUNCTION public.phase6_live_role_held(p_project TEXT, p_role TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."Decision" d
     WHERE d."projectId" = p_project AND d."deciderKind"::text = p_role
       AND d."publishedAt" IS NOT NULL AND d."status"::text IN ('pending', 'change', 'awaiting_countersign')
  );
$$;

CREATE OR REPLACE FUNCTION public.phase6_live_holder_membership_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE pid TEXT; r TEXT; judged TEXT[] := ARRAY[]::TEXT[];
BEGIN
  pid := COALESCE(NEW."projectId", OLD."projectId");
  IF TG_OP = 'UPDATE'
     AND NEW."status" IS NOT DISTINCT FROM OLD."status"
     AND NEW."role" IS NOT DISTINCT FROM OLD."role" THEN
    RETURN NULL;
  END IF;
  -- losing an ACTIVE row of a live user reduces OLD.role's live standing
  IF (TG_OP IN ('UPDATE', 'DELETE')) AND OLD."status" = 'active'
     AND (TG_OP = 'DELETE' OR NEW."status" <> 'active' OR NEW."role" IS DISTINCT FROM OLD."role")
     AND NOT public.platform_user_retired(OLD."userId") THEN
    judged := array_append(judged, OLD."role");
  END IF;
  -- an ACTIVATION suppresses a live user's membership-less org-PMC arm (explicit membership wins)
  IF ((TG_OP = 'INSERT' AND NEW."status" = 'active')
      OR (TG_OP = 'UPDATE' AND OLD."status" <> 'active' AND NEW."status" = 'active'))
     AND NOT public.platform_user_retired(NEW."userId")
     AND EXISTS (
       SELECT 1 FROM public."Project" p
         JOIN public."OrgMembership" om ON om."orgId" = p."orgId" AND om."userId" = NEW."userId"
        WHERE p."id" = pid AND om."role" IN ('owner', 'admin')
     ) THEN
    judged := array_append(judged, 'pmc');
  END IF;
  IF array_length(judged, 1) IS NULL THEN RETURN NULL; END IF;
  IF NOT public.phase6_try_readiness(pid) THEN
    RAISE EXCEPTION 'phase6-4b: the project readiness key is contended — retry this membership change (project %)', pid;
  END IF;
  FOREACH r IN ARRAY judged LOOP
    IF r IN ('client', 'pmc') AND public.phase6_live_role_held(pid, r)
       AND public.phase6_effective_role_standing(pid, r) > 0
       AND public.phase6_live_role_standing(pid, r) = 0 THEN
      RAISE EXCEPTION 'phase6-4b: this change leaves NO live % holder while a published open decision is held by that role (project %): the only remaining holder is an account retired by Redbracket ID, which nobody can sign in as — add the person''s new account first (RUNBOOK "Redbracket ID re-seat")', r, pid;
    END IF;
  END LOOP;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS "Membership_x_live_holder_guard" ON public."Membership";
CREATE TRIGGER "Membership_x_live_holder_guard"
  AFTER INSERT OR UPDATE OR DELETE ON public."Membership"
  FOR EACH ROW EXECUTE FUNCTION public.phase6_live_holder_membership_guard();

CREATE OR REPLACE FUNCTION public.phase6_live_holder_org_membership_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE proj RECORD;
BEGIN
  -- the delivered guard refuses an identity re-key first; this one judges only a lost owner/admin arm of a live user
  IF NOT (TG_OP = 'DELETE'
          OR (TG_OP = 'UPDATE' AND OLD."role" IN ('owner', 'admin') AND NEW."role" NOT IN ('owner', 'admin'))) THEN
    RETURN NULL;
  END IF;
  IF public.platform_user_retired(OLD."userId") THEN RETURN NULL; END IF;
  -- cascaded from a USER delete: `User_x_live_holder_guard` judged that delete as a whole, before any cascade. Only a
  -- DELETE is skipped, and only when its user row no longer exists: the FK keeps an org membership's user present,
  -- so that holds only inside the user's own ON DELETE CASCADE (an org-membership UPDATE, or a DELETE of a user who
  -- still exists, is always judged)
  -- (#1327 r2). If the user's explicit seats cascaded first, this arm would look unsuppressed here and a shortfall
  -- the delete did not cause would be judged as its own. (The membership guard needs no such skip: a lost explicit
  -- seat's judgement reads the same counts the User row already judged.)
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public."User" u WHERE u."id" = OLD."userId") THEN
    RETURN NULL;
  END IF;
  -- key before judgement, every covered project in ascending id, as the delivered guard does
  FOR proj IN
    SELECT p."id" FROM public."Project" p
     WHERE p."orgId" = OLD."orgId"
       AND NOT EXISTS (
         SELECT 1 FROM public."Membership" m
          WHERE m."projectId" = p."id" AND m."userId" = OLD."userId" AND m."status" = 'active'
       )
     ORDER BY p."id" ASC
  LOOP
    IF NOT public.phase6_try_readiness(proj."id") THEN
      RAISE EXCEPTION 'phase6-4b: the readiness key for project % is contended — retry this org-membership change', proj."id";
    END IF;
    IF public.phase6_live_role_held(proj."id", 'pmc')
       AND public.phase6_effective_role_standing(proj."id", 'pmc') > 0
       AND public.phase6_live_role_standing(proj."id", 'pmc') = 0 THEN
      RAISE EXCEPTION 'phase6-4b: this change leaves project % with NO live pmc while a published open decision is pmc-held: the only remaining holder is an account retired by Redbracket ID — add the person''s new account first (RUNBOOK "Redbracket ID re-seat")', proj."id";
    END IF;
  END LOOP;
  RETURN NULL;
END $fn$;

DROP TRIGGER IF EXISTS "OrgMembership_x_live_holder_guard" ON public."OrgMembership";
CREATE TRIGGER "OrgMembership_x_live_holder_guard"
  AFTER UPDATE OR DELETE ON public."OrgMembership"
  FOR EACH ROW EXECUTE FUNCTION public.phase6_live_holder_org_membership_guard();

-- ── the decision boundaries on live standing (#1327 r1, Codex 4452669484) ────────────────────────────────────────
-- ORGS-owned: the named membership is active AND its user is retired (a named holder nobody can sign in as). It
-- asks the platform's `platform_user_retired`, never `IdentityRetirement` itself.
CREATE OR REPLACE FUNCTION public.phase6_membership_held_by_retired(p_project TEXT, p_membership TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM public."Membership" m
     WHERE m."id" = p_membership AND m."projectId" = p_project AND m."status" = 'active'
       AND public.platform_user_retired(m."userId")
  );
$$;

-- Judged boundaries: a row born published as pending or change; a draft's publication; `approved → change`; and
-- a HOLDER MOVE on a published open row (the forward: `deciderKind`/`deciderMembershipId` change while pending,
-- change or awaiting countersign). Each is judged on the NEW holder: a role (client, pmc) must keep a live holder
-- where it has an effective one; a named membership (member) must not belong to a retired user. An inactive named
-- membership or a zero effective count stays the delivered seals' refusal. The architect kind is not judged here
-- (4d-i's doors refuse an architect-held decision; see the head note).
CREATE OR REPLACE FUNCTION public.phase6_live_holder_decision_seal() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE pid TEXT := NEW."projectId"; k TEXT := NEW."deciderKind"::text;
BEGIN
  IF k NOT IN ('client', 'pmc', 'member') THEN RETURN NEW; END IF;
  IF NOT (
       (TG_OP = 'INSERT' AND NEW."publishedAt" IS NOT NULL AND NEW."status"::text IN ('pending', 'change'))
    OR (TG_OP = 'UPDATE' AND OLD."publishedAt" IS NULL AND NEW."publishedAt" IS NOT NULL)
    OR (TG_OP = 'UPDATE' AND OLD."status"::text = 'approved' AND NEW."status"::text = 'change')
    OR (TG_OP = 'UPDATE' AND NEW."publishedAt" IS NOT NULL
        AND NEW."status"::text IN ('pending', 'change', 'awaiting_countersign')
        AND (NEW."deciderKind" IS DISTINCT FROM OLD."deciderKind"
             OR NEW."deciderMembershipId" IS DISTINCT FROM OLD."deciderMembershipId"))
  ) THEN
    RETURN NEW;
  END IF;
  IF NOT public.phase6_try_readiness(pid) THEN
    RAISE EXCEPTION 'phase6-4b: the project readiness key is contended — retry (decision %)', NEW."id";
  END IF;
  IF k = 'member' THEN
    IF public.phase6_membership_held_by_retired(pid, NEW."deciderMembershipId") THEN
      RAISE EXCEPTION 'phase6-4b: the named decider membership % belongs to an account retired by Redbracket ID, which nobody can sign in as — a decision nobody can decide is refused; re-seat the person and name their new membership (RUNBOOK "Redbracket ID re-seat") (decision %)', NEW."deciderMembershipId", NEW."id";
    END IF;
  ELSIF public.phase6_effective_role_standing(pid, k) > 0 AND public.phase6_live_role_standing(pid, k) = 0 THEN
    RAISE EXCEPTION 'phase6-4b: this project has no LIVE % holder: its only holders are accounts retired by Redbracket ID, which nobody can sign in as — a decision nobody can decide is refused; re-seat the person first (RUNBOOK "Redbracket ID re-seat") (decision %)', k, NEW."id";
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS "Decision_x_live_holder_standing" ON public."Decision";
CREATE TRIGGER "Decision_x_live_holder_standing"
  BEFORE INSERT OR UPDATE ON public."Decision"
  FOR EACH ROW EXECUTE FUNCTION public.phase6_live_holder_decision_seal();

-- ── a user's delete, judged as a whole before any cascade (#1327 r1 Codex 4452669493; r2 Codex 4453555401) ─────────
-- The User row is the one place that sees the whole delete: PostgreSQL fires the FK actions on `User` (every one an
-- AFTER trigger) in no promised order, so the membership and org-membership cascades would each see a half-deleted
-- user (an explicit seat suppressing, or no longer suppressing, the org arm). Here, before any cascade:
--   · a RETIRED user still holding an active project seat or an owner/admin company seat is refused (re-seat first);
--   · a LIVE user is judged per affected project (its active seats' projects and every project of a company where
--     it is owner/admin), in ascending id, each under its readiness key: for `client` and `pmc`, a published open
--     decision held by the role, the user's own contribution above zero, and the delete leaving live standing at
--     zero while effective standing stays above zero (the gap; a zero effective count stays the delivered seals').
-- The cascaded org-membership rows then skip the org guard above (their user row is gone). A named `member` decider's
-- membership is refused by the delivered named-decider guard on its own row, which reads no other row, so its
-- cascade order does not matter.
CREATE OR REPLACE FUNCTION public.phase6_live_holder_user_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $fn$
DECLARE proj RECORD; r TEXT; c INT;
BEGIN
  IF public.platform_user_retired(OLD."id") THEN
    IF EXISTS (SELECT 1 FROM public."Membership" m WHERE m."userId" = OLD."id" AND m."status" = 'active')
       OR EXISTS (SELECT 1 FROM public."OrgMembership" om WHERE om."userId" = OLD."id" AND om."role" IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'phase6-4b: user % was retired by Redbracket ID and still holds an active project seat or an owner/admin company seat — end those seats first (RUNBOOK "Redbracket ID re-seat")', OLD."id";
    END IF;
    RETURN OLD;
  END IF;
  FOR proj IN
    SELECT DISTINCT x.pid FROM (
      SELECT m."projectId" AS pid FROM public."Membership" m WHERE m."userId" = OLD."id" AND m."status" = 'active'
      UNION
      SELECT p."id" FROM public."Project" p
        JOIN public."OrgMembership" om ON om."orgId" = p."orgId"
       WHERE om."userId" = OLD."id" AND om."role" IN ('owner', 'admin')
    ) x ORDER BY x.pid ASC
  LOOP
    IF NOT public.phase6_try_readiness(proj.pid) THEN
      RAISE EXCEPTION 'phase6-4b: the readiness key for project % is contended — retry deleting user %', proj.pid, OLD."id";
    END IF;
    FOREACH r IN ARRAY ARRAY['client', 'pmc'] LOOP
      -- the user's own contribution, through the one precedence function (a live user counts the same in the
      -- effective and the live count, so the effective standing without them is effective minus this)
      c := public.phase6_live_role_standing(proj.pid, r) - public.phase6_live_role_standing(proj.pid, r, OLD."id");
      IF c > 0 AND public.phase6_live_role_held(proj.pid, r)
         AND public.phase6_effective_role_standing(proj.pid, r) - c > 0
         AND public.phase6_live_role_standing(proj.pid, r) - c = 0 THEN
        RAISE EXCEPTION 'phase6-4b: deleting user % leaves project % with NO live % holder while a published open decision is held by that role: the only remaining holder is an account retired by Redbracket ID, which nobody can sign in as — add the person''s new account first (RUNBOOK "Redbracket ID re-seat")', OLD."id", proj.pid, r;
      END IF;
    END LOOP;
  END LOOP;
  RETURN OLD;
END $fn$;

DROP TRIGGER IF EXISTS "User_x_live_holder_guard" ON public."User";
CREATE TRIGGER "User_x_live_holder_guard"
  BEFORE DELETE ON public."User"
  FOR EACH ROW EXECUTE FUNCTION public.phase6_live_holder_user_guard();
