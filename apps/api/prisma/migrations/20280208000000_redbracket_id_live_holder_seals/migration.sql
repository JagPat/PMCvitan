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
-- WHAT. Two SEPARATE AFTER-row triggers beside the delivered ones, the 4d-i way (its PART 3d note: a second
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
--   · The raise starts `phase6-4b:`, so a member or org command that meets it answers 409 through
--     `rethrowHolderSealViolation`, like the delivered seal.
--
-- NAMES SORT LAST. PostgreSQL fires same-kind triggers in name order. `_x_` sorts after `_qa_`, `_t4b2_` and
-- `_t4d_`, so the delivered seals judge first and keep their messages; these add only the live arm.
--
-- WHAT THIS FILE DOES NOT DO. No delivered function or trigger is replaced or dropped; no deployed migration is
-- edited; no table, column or row is written. The architect arm is not added: an architect membership and an
-- architect-held decision are both refused at the database while 4d-i's doors stand
-- (`Membership_t4d_architect_reserved`, `Decision_t4d_architect_reserved`), and the A4b command guard counts the
-- architect live (`liveArchitectStanding`) for the day they open. The trigger names avoid `_t4d_`, whose
-- inventory is 4d-i's own (phase6-t4d-i-seal-inventory).
--
-- SAFE UNDER THE PREVIOUS RELEASE. It refuses a write only while a retired row holds a seat, and a retired row
-- exists only with `IDENTITY_OIDC=1`, which is off. A previous-release command that met it would answer 409.
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

CREATE OR REPLACE FUNCTION public.phase6_live_role_standing(p_project TEXT, p_role TEXT)
RETURNS BIGINT LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT (
    SELECT count(*) FROM public."Membership" m
     WHERE m."projectId" = p_project AND m."status" = 'active' AND m."role" = p_role
       AND NOT public.platform_user_retired(m."userId")
  ) + CASE WHEN p_role = 'pmc' THEN (
    SELECT count(*) FROM public."Project" p
      JOIN public."OrgMembership" om ON om."orgId" = p."orgId" AND om."role" IN ('owner', 'admin')
     WHERE p."id" = p_project
       AND NOT public.platform_user_retired(om."userId")
       AND NOT EXISTS (
         SELECT 1 FROM public."Membership" m2
          WHERE m2."projectId" = p_project AND m2."userId" = om."userId" AND m2."status" = 'active'
       )
  ) ELSE 0 END;
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
