-- Site Visits (#792) SV1-a — the visit record: three tables and every rule PostgreSQL enforces on them.
--
-- The owner chose (13 Oct 2026, on #792) to build this step with its proofs rather than redesign it on paper again.
-- Each rule below is proved, beside an accepted coherent row, by test/integration/site-visits-sv1a.test.ts; the
-- review findings it answers are named inline (F-numbers are #792's).
--
-- WHAT THE DATABASE OWNS, so no command, alternate writer or raw SQL can weaken it:
--   V1  Tenancy. Every row carries `projectId`; children reach their visit, and every row its node, through composite
--       (projectId, id) keys. Project deletion cascades project → visit → child (F60).
--   V2  Who. The visitor, a member attendee and the closer must hold the stated role on the project when the row (or
--       the close) is written, judged by `platform_user_holds_role_windowed` after the registers it reads are locked
--       in the actor envelope's order: OrgUserAuthority, then ProjectUserStanding, then UserIdentity, then the
--       project row (F55). A frozen name is COPIED from the locked `UserIdentity`, never taken from the caller (F57).
--       Only the visitor adds or retires a child row (`addedById` / `retiredById` = the locked visit's visitor, F46).
--   V3  Time. The caller sends only CLAIMED times; the database stamps each receipt (`site_visits_now()`, read after
--       the visit row is locked) and derives the ACCEPTED time: the claim when it lies in its window, else the
--       receipt. `adjusted` is exactly "accepted differs from claimed", both ways (F54), so an accepted time is never
--       in the future of its receipt and never before the start (F47), and an end is never before a place walked
--       while the visit was open.
--   V4  Lifecycle. open → ended | closed, once; a late end only on a closed visit, once. A closed visit takes no
--       child edit, and a place added to an ended visit is `addedAfterEnd`, set from the locked visit (F49).
--   V5  Immutable. Nothing is deleted or truncated except by a project cascade or the sanctioned test reset; every
--       column outside the lifecycle and retire arms is frozen. A node reference is cleared ONLY by its foreign key's
--       own `ON DELETE SET NULL (col)` action when the node is removed (F58) — never by a direct UPDATE.
--   V6  Paired. Each change commits with exactly one same-transaction `sitevisit.*` event from the attributed human,
--       naming its row; start, end and close also with exactly one notice whose kind is that event (F45, F59). The
--       event is then CLAIMED, so the kernel's `pairingRequired` seal refuses any site-visit event with no change.
--       The site-visit rows are themselves the audit register (append-only, attributed, timed), as `DecisionEvent`
--       is for decisions; the generic `AuditLog` row a command writes stays a convention and is not paired (F56).
--
-- The event types and their catalog generation are `20280111000000_site_visits_sv1a_catalog` (the claim needs the
-- `pairingRequired` rows). No writer exists until SV1-b's commands, so this release changes no behaviour.
--
-- Re-runnable, and on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline models the tables but not the
-- triggers, CHECKs, partial indexes or column-list FK actions). Every statement is guarded.

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- TABLES
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "SiteVisit" (
    "id"                 TEXT NOT NULL,
    "projectId"          TEXT NOT NULL,
    "visitorId"          TEXT NOT NULL,
    "visitorRole"        TEXT NOT NULL,
    "visitorName"        TEXT NOT NULL DEFAULT '',
    "startClaimedAt"     TIMESTAMP(3) NOT NULL,
    "startedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startTimeAdjusted"  BOOLEAN NOT NULL DEFAULT false,
    "startReceivedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startNodeId"        TEXT,
    "startPlaceName"     TEXT,
    "locationKind"       TEXT NOT NULL,
    "locLat"             DOUBLE PRECISION,
    "locLng"             DOUBLE PRECISION,
    "locAccuracyM"       DOUBLE PRECISION,
    "locAt"              TIMESTAMP(3),
    "status"             TEXT NOT NULL DEFAULT 'open',
    "endClaimedAt"       TIMESTAMP(3),
    "endedAt"            TIMESTAMP(3),
    "endTimeAdjusted"    BOOLEAN,
    "endReceivedAt"      TIMESTAMP(3),
    "closedAt"           TIMESTAMP(3),
    "closedById"         TEXT,
    "closeReason"        TEXT,
    "lateEndClaimedAt"   TIMESTAMP(3),
    "lateEndReceivedAt"  TIMESTAMP(3),
    CONSTRAINT "SiteVisit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SiteVisitAttendee" (
    "id"           TEXT NOT NULL,
    "projectId"    TEXT NOT NULL,
    "visitId"      TEXT NOT NULL,
    "userId"       TEXT,
    "role"         TEXT,
    "guestName"    TEXT,
    "displayName"  TEXT NOT NULL DEFAULT '',
    "addedById"    TEXT NOT NULL,
    "addedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt"    TIMESTAMP(3),
    "retiredById"  TEXT,
    CONSTRAINT "SiteVisitAttendee_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SiteVisitPlace" (
    "id"                 TEXT NOT NULL,
    "projectId"          TEXT NOT NULL,
    "visitId"            TEXT NOT NULL,
    "nodeId"             TEXT,
    "placeName"          TEXT NOT NULL DEFAULT '',
    "addedById"          TEXT NOT NULL,
    "addedClaimedAt"     TIMESTAMP(3) NOT NULL,
    "addedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedTimeAdjusted"  BOOLEAN NOT NULL DEFAULT false,
    "addedReceivedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedAfterEnd"      BOOLEAN NOT NULL DEFAULT false,
    "retiredAt"          TIMESTAMP(3),
    "retiredById"        TEXT,
    CONSTRAINT "SiteVisitPlace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SiteVisit_projectId_id_key" ON "SiteVisit"("projectId", "id");
CREATE INDEX IF NOT EXISTS "SiteVisit_projectId_idx" ON "SiteVisit"("projectId");
CREATE INDEX IF NOT EXISTS "SiteVisit_visitorId_idx" ON "SiteVisit"("visitorId");
CREATE INDEX IF NOT EXISTS "SiteVisit_startNodeId_idx" ON "SiteVisit"("startNodeId");
-- S2: at most one open visit per visitor per project.
CREATE UNIQUE INDEX IF NOT EXISTS "SiteVisit_one_open_per_visitor" ON "SiteVisit"("projectId", "visitorId") WHERE "status" = 'open';

CREATE INDEX IF NOT EXISTS "SiteVisitAttendee_projectId_visitId_idx" ON "SiteVisitAttendee"("projectId", "visitId");
CREATE INDEX IF NOT EXISTS "SiteVisitAttendee_userId_idx" ON "SiteVisitAttendee"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "SiteVisitAttendee_one_standing_member"
  ON "SiteVisitAttendee"("visitId", "userId") WHERE "userId" IS NOT NULL AND "retiredAt" IS NULL;

CREATE INDEX IF NOT EXISTS "SiteVisitPlace_projectId_visitId_idx" ON "SiteVisitPlace"("projectId", "visitId");
CREATE INDEX IF NOT EXISTS "SiteVisitPlace_nodeId_idx" ON "SiteVisitPlace"("nodeId");
CREATE UNIQUE INDEX IF NOT EXISTS "SiteVisitPlace_one_standing_node"
  ON "SiteVisitPlace"("visitId", "nodeId") WHERE "nodeId" IS NOT NULL AND "retiredAt" IS NULL;

-- ── foreign keys (V1; F60 cascade chain; F58 node clearing by the FK action only) ──────────────
DO $sv1a_fk$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisit_projectId_fkey') THEN
    ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_projectId_fkey"
      FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisit_visitorId_fkey') THEN
    ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_visitorId_fkey"
      FOREIGN KEY ("visitorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisit_closedById_fkey') THEN
    ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_closedById_fkey"
      FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisit_projectId_startNodeId_fkey') THEN
    ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_projectId_startNodeId_fkey"
      FOREIGN KEY ("projectId", "startNodeId") REFERENCES "ProjectNode"("projectId", "id")
      ON DELETE SET NULL ("startNodeId") ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitAttendee_projectId_visitId_fkey') THEN
    ALTER TABLE "SiteVisitAttendee" ADD CONSTRAINT "SiteVisitAttendee_projectId_visitId_fkey"
      FOREIGN KEY ("projectId", "visitId") REFERENCES "SiteVisit"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitAttendee_userId_fkey') THEN
    ALTER TABLE "SiteVisitAttendee" ADD CONSTRAINT "SiteVisitAttendee_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitAttendee_addedById_fkey') THEN
    ALTER TABLE "SiteVisitAttendee" ADD CONSTRAINT "SiteVisitAttendee_addedById_fkey"
      FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitAttendee_retiredById_fkey') THEN
    ALTER TABLE "SiteVisitAttendee" ADD CONSTRAINT "SiteVisitAttendee_retiredById_fkey"
      FOREIGN KEY ("retiredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitPlace_projectId_visitId_fkey') THEN
    ALTER TABLE "SiteVisitPlace" ADD CONSTRAINT "SiteVisitPlace_projectId_visitId_fkey"
      FOREIGN KEY ("projectId", "visitId") REFERENCES "SiteVisit"("projectId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitPlace_projectId_nodeId_fkey') THEN
    ALTER TABLE "SiteVisitPlace" ADD CONSTRAINT "SiteVisitPlace_projectId_nodeId_fkey"
      FOREIGN KEY ("projectId", "nodeId") REFERENCES "ProjectNode"("projectId", "id")
      ON DELETE SET NULL ("nodeId") ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitPlace_addedById_fkey') THEN
    ALTER TABLE "SiteVisitPlace" ADD CONSTRAINT "SiteVisitPlace_addedById_fkey"
      FOREIGN KEY ("addedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitPlace_retiredById_fkey') THEN
    ALTER TABLE "SiteVisitPlace" ADD CONSTRAINT "SiteVisitPlace_retiredById_fkey"
      FOREIGN KEY ("retiredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END $sv1a_fk$;

-- ── CHECKs: the shape every committed row has, whoever wrote it ─────────────────────────────
-- Non-blank is judged under the full ASCII whitespace set, the repository's spelling (F61).
DO $sv1a_check$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisit_shape_check') THEN
    ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_shape_check" CHECK (
      "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND "visitorRole" IN ('pmc', 'consultant', 'architect')
      AND btrim("visitorName", E' \t\n\x0B\f\r') <> ''
      -- a start node is never stored without its label; the label is non-blank and outlives the node (F61)
      AND ("startNodeId" IS NULL OR "startPlaceName" IS NOT NULL)
      AND ("startPlaceName" IS NULL OR btrim("startPlaceName", E' \t\n\x0B\f\r') <> '')
      -- location: all four for a device fix, none for 'none' (Q6, Q12)
      AND (("locationKind" = 'device'
              AND "locLat" IS NOT NULL AND "locLng" IS NOT NULL AND "locAccuracyM" IS NOT NULL AND "locAt" IS NOT NULL
              AND "locLat" BETWEEN -90 AND 90 AND "locLng" BETWEEN -180 AND 180 AND "locAccuracyM" >= 0)
        OR ("locationKind" = 'none'
              AND "locLat" IS NULL AND "locLng" IS NULL AND "locAccuracyM" IS NULL AND "locAt" IS NULL))
      -- V3 / F54: accepted is the claim exactly when not adjusted, else the receipt; never after the receipt
      AND "startTimeAdjusted" = ("startedAt" <> "startClaimedAt")
      AND ("startedAt" = "startClaimedAt" OR "startedAt" = "startReceivedAt")
      AND "startedAt" <= "startReceivedAt"
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisit_lifecycle_check') THEN
    ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_lifecycle_check" CHECK (
      ("status" = 'open'
        AND "endClaimedAt" IS NULL AND "endedAt" IS NULL AND "endTimeAdjusted" IS NULL AND "endReceivedAt" IS NULL
        AND "closedAt" IS NULL AND "closedById" IS NULL AND "closeReason" IS NULL
        AND "lateEndClaimedAt" IS NULL AND "lateEndReceivedAt" IS NULL)
      OR ("status" = 'ended'
        AND "endClaimedAt" IS NOT NULL AND "endedAt" IS NOT NULL AND "endTimeAdjusted" IS NOT NULL AND "endReceivedAt" IS NOT NULL
        AND "endTimeAdjusted" = ("endedAt" <> "endClaimedAt")
        AND ("endedAt" = "endClaimedAt" OR "endedAt" = "endReceivedAt")
        AND "startedAt" <= "endedAt" AND "endedAt" <= "endReceivedAt" AND "startReceivedAt" <= "endReceivedAt"
        AND "closedAt" IS NULL AND "closedById" IS NULL AND "closeReason" IS NULL
        AND "lateEndClaimedAt" IS NULL AND "lateEndReceivedAt" IS NULL)
      OR ("status" = 'closed'
        AND "closedAt" IS NOT NULL AND "closedById" IS NOT NULL AND "closeReason" IS NOT NULL
        AND btrim("closeReason", E' \t\n\x0B\f\r') <> ''
        AND "closedAt" >= "startReceivedAt"
        AND "endClaimedAt" IS NULL AND "endedAt" IS NULL AND "endTimeAdjusted" IS NULL AND "endReceivedAt" IS NULL
        AND ("lateEndClaimedAt" IS NULL) = ("lateEndReceivedAt" IS NULL)
        AND ("lateEndReceivedAt" IS NULL OR "lateEndReceivedAt" >= "closedAt"))
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitAttendee_shape_check') THEN
    ALTER TABLE "SiteVisitAttendee" ADD CONSTRAINT "SiteVisitAttendee_shape_check" CHECK (
      "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      -- exactly one of a member (with the role they attended in) or a typed guest
      AND (("userId" IS NOT NULL AND "role" IS NOT NULL AND "guestName" IS NULL)
        OR ("userId" IS NULL AND "role" IS NULL AND "guestName" IS NOT NULL
            AND btrim("guestName", E' \t\n\x0B\f\r') <> '' AND char_length("guestName") <= 120))
      AND btrim("displayName", E' \t\n\x0B\f\r') <> ''
      AND ("retiredAt" IS NULL) = ("retiredById" IS NULL)
      AND ("retiredAt" IS NULL OR "retiredAt" >= "addedAt")
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SiteVisitPlace_shape_check') THEN
    ALTER TABLE "SiteVisitPlace" ADD CONSTRAINT "SiteVisitPlace_shape_check" CHECK (
      "id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND btrim("placeName", E' \t\n\x0B\f\r') <> ''
      AND "addedTimeAdjusted" = ("addedAt" <> "addedClaimedAt")
      AND ("addedAt" = "addedClaimedAt" OR "addedAt" = "addedReceivedAt")
      AND "addedAt" <= "addedReceivedAt"
      -- a correction after the visit is not part of the walk: it is accepted at its receipt
      AND (NOT "addedAfterEnd" OR "addedAt" = "addedReceivedAt")
      AND ("retiredAt" IS NULL) = ("retiredById" IS NULL)
      AND ("retiredAt" IS NULL OR "retiredAt" >= "addedReceivedAt")
    );
  END IF;
END $sv1a_check$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- V2 — WHO: standing under the envelope's lock order, and names copied from the locked identity
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- The receipt clock: wall-clock time when the trigger runs (after its locks are held, so a later act always reads a
-- later time than the act it waited for), in UTC and at the columns' millisecond precision, truncated so that it is
-- never later than the instant it records.
CREATE OR REPLACE FUNCTION site_visits_now() RETURNS TIMESTAMP(3) LANGUAGE sql VOLATILE AS $$
  SELECT date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
$$;

-- Locks what `platform_user_holds_role_windowed` reads, in the actor envelope's order (OrgUserAuthority through the
-- project's org, then ProjectUserStanding, then UserIdentity), then the project row the operability check holds,
-- and answers. A concurrent removal, re-role, demotion or rename of a PRESENT row therefore waits for this
-- transaction or is seen by it (F55, F57). Returns the user's locked display name; raises when the user does not
-- hold the role, the project is archived, or the account has no name.
CREATE OR REPLACE FUNCTION site_visits_standing_name(p_project TEXT, p_user TEXT, p_role TEXT, p_what TEXT)
RETURNS TEXT LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_name TEXT;
BEGIN
  PERFORM 1 FROM "OrgUserAuthority" a JOIN "ProjectOrg" po ON po."orgId" = a."orgId"
   WHERE po."projectId" = p_project AND a."userId" = p_user
     FOR SHARE OF a;
  PERFORM 1 FROM "ProjectUserStanding"
   WHERE "projectId" = p_project AND "userId" = p_user
     FOR SHARE;
  SELECT "displayName" INTO v_name FROM "UserIdentity" WHERE "userId" = p_user FOR SHARE;
  IF NOT phase6_project_operable(p_project) THEN
    RAISE EXCEPTION 'site-visits: project % is not operable (archived or absent), so no % may be written on it', p_project, p_what;
  END IF;
  IF NOT platform_user_holds_role_windowed(p_project, p_user, p_role) THEN
    RAISE EXCEPTION 'site-visits: user % does not hold role % on project %, so they cannot be the % of a site visit',
      p_user, p_role, p_project, p_what;
  END IF;
  IF v_name IS NULL OR btrim(v_name, E' \t\n\x0B\f\r') = '' THEN
    RAISE EXCEPTION 'site-visits: user % has no account name to freeze as the % of a site visit', p_user, p_what;
  END IF;
  RETURN v_name;
END $$;

-- A node a visit names must be PUBLISHED (a draft is private to its author) and in the visit's project; its label is
-- COPIED from the locked node, never taken from the caller. The node row is locked FOR KEY SHARE (what the foreign
-- key itself takes), so a concurrent rename waits and the frozen label is the name at the act.
CREATE OR REPLACE FUNCTION site_visits_node_label(p_project TEXT, p_node TEXT)
RETURNS TEXT LANGUAGE plpgsql VOLATILE AS $$
DECLARE v_name TEXT; v_published TIMESTAMP(3);
BEGIN
  SELECT "name", "publishedAt" INTO v_name, v_published
    FROM "ProjectNode" WHERE "projectId" = p_project AND "id" = p_node FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'site-visits: node % is not a place of project %', p_node, p_project;
  END IF;
  IF v_published IS NULL THEN
    RAISE EXCEPTION 'site-visits: node % is an unpublished draft; a visit records only published places', p_node;
  END IF;
  RETURN v_name;
END $$;

-- The accepted time for a claim with a window: the claim when lower <= claim <= receipt, else the receipt (V3).
CREATE OR REPLACE FUNCTION site_visits_accept(p_claim TIMESTAMP(3), p_lower TIMESTAMP(3), p_received TIMESTAMP(3))
RETURNS TIMESTAMP(3) LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_claim >= p_lower AND p_claim <= p_received THEN p_claim ELSE p_received END;
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- SiteVisit — insert, lifecycle, immutability
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION site_visits_visit_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_created TIMESTAMP(3); v_received TIMESTAMP(3);
BEGIN
  IF NEW."status" IS DISTINCT FROM 'open'
     OR NEW."endClaimedAt" IS NOT NULL OR NEW."closedById" IS NOT NULL OR NEW."closeReason" IS NOT NULL
     OR NEW."lateEndClaimedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'site-visits: visit % must be inserted open, with no end, close or late end', NEW."id";
  END IF;
  NEW."visitorName" := site_visits_standing_name(NEW."projectId", NEW."visitorId", NEW."visitorRole", 'visitor');
  IF NEW."startNodeId" IS NOT NULL THEN
    NEW."startPlaceName" := site_visits_node_label(NEW."projectId", NEW."startNodeId");
  ELSE
    NEW."startPlaceName" := NULL;
  END IF;
  -- V3: the receipt is stamped here; a start claim is accepted within [max(receipt − 7 days, project start), receipt]
  SELECT "createdAt" INTO v_created FROM "Project" WHERE "id" = NEW."projectId";
  v_received := site_visits_now();
  NEW."startReceivedAt" := v_received;
  NEW."startedAt" := site_visits_accept(NEW."startClaimedAt", GREATEST(v_received - interval '7 days', v_created), v_received);
  NEW."startTimeAdjusted" := NEW."startedAt" <> NEW."startClaimedAt";
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisit_insert" ON "SiteVisit";
CREATE TRIGGER "SiteVisit_insert"
  BEFORE INSERT ON "SiteVisit"
  FOR EACH ROW EXECUTE FUNCTION site_visits_visit_insert();

CREATE OR REPLACE FUNCTION site_visits_visit_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_received TIMESTAMP(3); v_lower TIMESTAMP(3);
BEGIN
  -- Frozen in every arm: who, where and when it started, and the location.
  IF ROW(NEW."id", NEW."projectId", NEW."visitorId", NEW."visitorRole", NEW."visitorName",
         NEW."startClaimedAt", NEW."startedAt", NEW."startTimeAdjusted", NEW."startReceivedAt", NEW."startPlaceName",
         NEW."locationKind", NEW."locLat", NEW."locLng", NEW."locAccuracyM", NEW."locAt")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."projectId", OLD."visitorId", OLD."visitorRole", OLD."visitorName",
         OLD."startClaimedAt", OLD."startedAt", OLD."startTimeAdjusted", OLD."startReceivedAt", OLD."startPlaceName",
         OLD."locationKind", OLD."locLat", OLD."locLng", OLD."locAccuracyM", OLD."locAt") THEN
    RAISE EXCEPTION 'site-visits: visit % keeps its visitor, start and location as recorded', OLD."id";
  END IF;

  -- V5 / F58: the start node is cleared ONLY by its foreign key's ON DELETE SET NULL action, which runs below
  -- trigger depth 1 and changes nothing else. A direct UPDATE (depth 1) may never touch it.
  IF NEW."startNodeId" IS DISTINCT FROM OLD."startNodeId" THEN
    IF pg_trigger_depth() > 1 AND NEW."startNodeId" IS NULL
       AND to_jsonb(NEW) = (to_jsonb(OLD) || jsonb_build_object('startNodeId', NULL)) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'site-visits: visit % start place is cleared only when that place is removed', OLD."id";
  END IF;

  IF OLD."status" = 'open' AND NEW."status" = 'ended' THEN
    IF NEW."endClaimedAt" IS NULL OR NEW."closedById" IS NOT NULL OR NEW."closeReason" IS NOT NULL
       OR NEW."lateEndClaimedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'site-visits: ending visit % takes an end claim and nothing else', OLD."id";
    END IF;
    -- V3 / F47: never before the start, nor before any place walked while the visit was open. The UPDATE holds the
    -- visit row, and every place insert locks it first, so no open-time place can commit after this read.
    SELECT GREATEST(OLD."startedAt", COALESCE(max(p."addedAt"), OLD."startedAt")) INTO v_lower
      FROM "SiteVisitPlace" p
     WHERE p."projectId" = OLD."projectId" AND p."visitId" = OLD."id" AND NOT p."addedAfterEnd";
    v_received := site_visits_now();
    NEW."endReceivedAt" := v_received;
    NEW."endedAt" := site_visits_accept(NEW."endClaimedAt", v_lower, v_received);
    NEW."endTimeAdjusted" := NEW."endedAt" <> NEW."endClaimedAt";
    IF NOT phase6_project_operable(OLD."projectId") THEN
      RAISE EXCEPTION 'site-visits: project % is not operable, so visit % cannot be ended', OLD."projectId", OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'open' AND NEW."status" = 'closed' THEN
    IF NEW."closedById" IS NULL OR NEW."endClaimedAt" IS NOT NULL OR NEW."lateEndClaimedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'site-visits: closing visit % takes a closer and a reason and nothing else', OLD."id";
    END IF;
    PERFORM site_visits_standing_name(OLD."projectId", NEW."closedById", 'pmc', 'closer');
    NEW."closedAt" := site_visits_now();
    NEW."endedAt" := NULL; NEW."endTimeAdjusted" := NULL; NEW."endReceivedAt" := NULL; NEW."lateEndReceivedAt" := NULL;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'closed' AND NEW."status" = 'closed'
     AND OLD."lateEndClaimedAt" IS NULL AND NEW."lateEndClaimedAt" IS NOT NULL
     AND ROW(NEW."closedAt", NEW."closedById", NEW."closeReason")
         IS NOT DISTINCT FROM ROW(OLD."closedAt", OLD."closedById", OLD."closeReason") THEN
    NEW."lateEndReceivedAt" := site_visits_now();
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'site-visits: visit % moves only open → ended, open → closed, or records one late end once closed (from % to %)',
    OLD."id", OLD."status", NEW."status";
END $$;

DROP TRIGGER IF EXISTS "SiteVisit_update" ON "SiteVisit";
CREATE TRIGGER "SiteVisit_update"
  BEFORE UPDATE ON "SiteVisit"
  FOR EACH ROW EXECUTE FUNCTION site_visits_visit_update();

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Children — the visit row is the lock for every child write (F49)
-- ════════════════════════════════════════════════════════════════════════════════════════════

-- Locks the child's visit and returns its state. Every child insert or retire runs this FIRST, so a child write and
-- the visit's end or close serialise on one row.
CREATE OR REPLACE FUNCTION site_visits_lock_visit(p_project TEXT, p_visit TEXT, OUT o_status TEXT, OUT o_visitor TEXT, OUT o_started TIMESTAMP(3))
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  SELECT "status", "visitorId", "startedAt" INTO o_status, o_visitor, o_started
    FROM "SiteVisit" WHERE "projectId" = p_project AND "id" = p_visit FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'site-visits: visit % is not a visit of project %', p_visit, p_project;
  END IF;
  IF o_status = 'closed' THEN
    RAISE EXCEPTION 'site-visits: visit % is closed and takes no more edits', p_visit;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION site_visits_attendee_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v RECORD;
BEGIN
  SELECT * INTO v FROM site_visits_lock_visit(NEW."projectId", NEW."visitId");
  IF NEW."addedById" IS DISTINCT FROM v.o_visitor THEN
    RAISE EXCEPTION 'site-visits: only the visitor adds attendees to visit % (added by %)', NEW."visitId", NEW."addedById";
  END IF;
  IF NEW."retiredAt" IS NOT NULL OR NEW."retiredById" IS NOT NULL THEN
    RAISE EXCEPTION 'site-visits: attendee % is inserted standing, not retired', NEW."id";
  END IF;
  IF NEW."userId" IS NOT NULL THEN
    NEW."displayName" := site_visits_standing_name(NEW."projectId", NEW."userId", NEW."role", 'attendee');
  ELSE
    NEW."displayName" := NEW."guestName";
    IF NOT phase6_project_operable(NEW."projectId") THEN
      RAISE EXCEPTION 'site-visits: project % is not operable, so no attendee may be added', NEW."projectId";
    END IF;
  END IF;
  NEW."addedAt" := site_visits_now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitAttendee_insert" ON "SiteVisitAttendee";
CREATE TRIGGER "SiteVisitAttendee_insert"
  BEFORE INSERT ON "SiteVisitAttendee"
  FOR EACH ROW EXECUTE FUNCTION site_visits_attendee_insert();

CREATE OR REPLACE FUNCTION site_visits_place_insert() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v RECORD; v_received TIMESTAMP(3);
BEGIN
  SELECT * INTO v FROM site_visits_lock_visit(NEW."projectId", NEW."visitId");
  IF NEW."addedById" IS DISTINCT FROM v.o_visitor THEN
    RAISE EXCEPTION 'site-visits: only the visitor adds places to visit % (added by %)', NEW."visitId", NEW."addedById";
  END IF;
  IF NEW."retiredAt" IS NOT NULL OR NEW."retiredById" IS NOT NULL THEN
    RAISE EXCEPTION 'site-visits: place % is inserted standing, not retired', NEW."id";
  END IF;
  -- F51: a place always names its node when it is written; only the node's removal clears it later.
  IF NEW."nodeId" IS NULL THEN
    RAISE EXCEPTION 'site-visits: place % must name the node it records', NEW."id";
  END IF;
  NEW."placeName" := site_visits_node_label(NEW."projectId", NEW."nodeId");
  IF NOT phase6_project_operable(NEW."projectId") THEN
    RAISE EXCEPTION 'site-visits: project % is not operable, so no place may be added', NEW."projectId";
  END IF;
  v_received := site_visits_now();
  NEW."addedReceivedAt" := v_received;
  NEW."addedAfterEnd" := (v.o_status = 'ended');
  IF NEW."addedAfterEnd" THEN
    NEW."addedAt" := v_received;
  ELSE
    NEW."addedAt" := site_visits_accept(NEW."addedClaimedAt", v.o_started, v_received);
  END IF;
  NEW."addedTimeAdjusted" := NEW."addedAt" <> NEW."addedClaimedAt";
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitPlace_insert" ON "SiteVisitPlace";
CREATE TRIGGER "SiteVisitPlace_insert"
  BEFORE INSERT ON "SiteVisitPlace"
  FOR EACH ROW EXECUTE FUNCTION site_visits_place_insert();

-- A child row changes in exactly two ways: the visitor retires it once (depth 1), or a place's node is cleared by
-- the node foreign key's own SET NULL action (below depth 1), with nothing else moving.
CREATE OR REPLACE FUNCTION site_visits_child_update() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v RECORD; v_old JSONB; v_new JSONB;
BEGIN
  v_old := to_jsonb(OLD) - 'retiredAt' - 'retiredById';
  v_new := to_jsonb(NEW) - 'retiredAt' - 'retiredById';
  -- Nested, not AND-ed: PL/pgSQL does not promise short-circuit evaluation, and an attendee row has no "nodeId".
  IF TG_TABLE_NAME = 'SiteVisitPlace' THEN
    IF v_new ->> 'nodeId' IS DISTINCT FROM v_old ->> 'nodeId' THEN
      IF pg_trigger_depth() > 1 AND v_new ->> 'nodeId' IS NULL
         AND to_jsonb(NEW) = (to_jsonb(OLD) || jsonb_build_object('nodeId', NULL)) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'site-visits: place % node is cleared only when that node is removed', OLD."id";
    END IF;
  END IF;
  IF v_new IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'site-visits: % % is frozen; only its retirement may be recorded', TG_TABLE_NAME, OLD."id";
  END IF;
  IF OLD."retiredAt" IS NOT NULL OR NEW."retiredById" IS NULL THEN
    RAISE EXCEPTION 'site-visits: % % is retired once, by naming who retired it', TG_TABLE_NAME, OLD."id";
  END IF;
  SELECT * INTO v FROM site_visits_lock_visit(OLD."projectId", OLD."visitId");
  IF NEW."retiredById" IS DISTINCT FROM v.o_visitor THEN
    RAISE EXCEPTION 'site-visits: only the visitor retires % % (retired by %)', TG_TABLE_NAME, OLD."id", NEW."retiredById";
  END IF;
  IF NOT phase6_project_operable(OLD."projectId") THEN
    RAISE EXCEPTION 'site-visits: project % is not operable, so % % cannot be retired', OLD."projectId", TG_TABLE_NAME, OLD."id";
  END IF;
  NEW."retiredAt" := site_visits_now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "SiteVisitAttendee_update" ON "SiteVisitAttendee";
CREATE TRIGGER "SiteVisitAttendee_update"
  BEFORE UPDATE ON "SiteVisitAttendee"
  FOR EACH ROW EXECUTE FUNCTION site_visits_child_update();
DROP TRIGGER IF EXISTS "SiteVisitPlace_update" ON "SiteVisitPlace";
CREATE TRIGGER "SiteVisitPlace_update"
  BEFORE UPDATE ON "SiteVisitPlace"
  FOR EACH ROW EXECUTE FUNCTION site_visits_child_update();

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- V5 — no delete except a cascade, no truncate except the sanctioned reset
-- ════════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION site_visits_no_delete() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- A cascade (project → visit → child) runs below trigger depth 1; a direct DELETE is depth 1.
  IF pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'site-visits: % % is part of the visit record and is never deleted; it goes only with its project',
      TG_TABLE_NAME, OLD."id";
  END IF;
  RETURN OLD;
END $$;

CREATE OR REPLACE FUNCTION site_visits_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'site-visits: % is part of the visit record and is never truncated', TG_TABLE_NAME;
END $$;

DROP TRIGGER IF EXISTS "SiteVisit_no_delete" ON "SiteVisit";
CREATE TRIGGER "SiteVisit_no_delete" BEFORE DELETE ON "SiteVisit"
  FOR EACH ROW EXECUTE FUNCTION site_visits_no_delete();
DROP TRIGGER IF EXISTS "SiteVisitAttendee_no_delete" ON "SiteVisitAttendee";
CREATE TRIGGER "SiteVisitAttendee_no_delete" BEFORE DELETE ON "SiteVisitAttendee"
  FOR EACH ROW EXECUTE FUNCTION site_visits_no_delete();
DROP TRIGGER IF EXISTS "SiteVisitPlace_no_delete" ON "SiteVisitPlace";
CREATE TRIGGER "SiteVisitPlace_no_delete" BEFORE DELETE ON "SiteVisitPlace"
  FOR EACH ROW EXECUTE FUNCTION site_visits_no_delete();

DROP TRIGGER IF EXISTS "SiteVisit_no_truncate" ON "SiteVisit";
CREATE TRIGGER "SiteVisit_no_truncate" BEFORE TRUNCATE ON "SiteVisit"
  FOR EACH STATEMENT EXECUTE FUNCTION site_visits_no_truncate();
DROP TRIGGER IF EXISTS "SiteVisitAttendee_no_truncate" ON "SiteVisitAttendee";
CREATE TRIGGER "SiteVisitAttendee_no_truncate" BEFORE TRUNCATE ON "SiteVisitAttendee"
  FOR EACH STATEMENT EXECUTE FUNCTION site_visits_no_truncate();
DROP TRIGGER IF EXISTS "SiteVisitPlace_no_truncate" ON "SiteVisitPlace";
CREATE TRIGGER "SiteVisitPlace_no_truncate" BEFORE TRUNCATE ON "SiteVisitPlace"
  FOR EACH STATEMENT EXECUTE FUNCTION site_visits_no_truncate();

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- V6 — every change paired with its event (and, for start, end and close, its notice), then claimed (F45, F59)
-- ════════════════════════════════════════════════════════════════════════════════════════════
--
-- U3's order-independent claimant: ONE function behind an immediate AFTER trigger and a DEFERRED constraint trigger.
-- The immediate half claims when the event already exists; the deferred half, at commit, DEMANDS exactly one
-- matching event (and notice) and claims it. The claim is what lets the kernel's `pairingRequired` seal refuse a
-- site-visit event that no change claimed; the register's per-event key makes a second claimant impossible.
--
-- A match is: same project, the visit's stream (`SiteVisit` / visit id), the change's type, a HUMAN actor who is the
-- person the row attributes the change to, written in this transaction, and — for a child change — `payload.rowId`
-- naming this row (a start that names three attendees writes three `attendee_added` events on one stream).
CREATE OR REPLACE FUNCTION site_visits_claim() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_type TEXT; v_actor TEXT; v_visit TEXT; v_row TEXT; v_table TEXT;
  v_count BIGINT; v_event TEXT; v_notices BIGINT; v_needs_notice BOOLEAN := FALSE;
BEGIN
  v_table := TG_TABLE_NAME;
  IF TG_TABLE_NAME = 'SiteVisit' THEN
    v_visit := NEW."id"; v_row := NULL;
    IF TG_OP = 'INSERT' THEN
      v_type := 'sitevisit.started'; v_actor := NEW."visitorId"; v_needs_notice := TRUE;
    ELSIF OLD."status" = 'open' AND NEW."status" = 'ended' THEN
      v_type := 'sitevisit.ended'; v_actor := NEW."visitorId"; v_needs_notice := TRUE;
    ELSIF OLD."status" = 'open' AND NEW."status" = 'closed' THEN
      v_type := 'sitevisit.closed'; v_actor := NEW."closedById"; v_needs_notice := TRUE;
    ELSIF OLD."lateEndClaimedAt" IS NULL AND NEW."lateEndClaimedAt" IS NOT NULL THEN
      v_type := 'sitevisit.late_end_recorded'; v_actor := NEW."visitorId";
    ELSE
      RETURN NULL;   -- the node-clearing action: not a change of the record's meaning, and announced by node.removed
    END IF;
  ELSE
    v_visit := NEW."visitId"; v_row := NEW."id";
    IF TG_OP = 'INSERT' THEN
      v_type := CASE TG_TABLE_NAME WHEN 'SiteVisitAttendee' THEN 'sitevisit.attendee_added' ELSE 'sitevisit.place_added' END;
      v_actor := NEW."addedById";
    ELSIF OLD."retiredAt" IS NULL AND NEW."retiredAt" IS NOT NULL THEN
      v_type := CASE TG_TABLE_NAME WHEN 'SiteVisitAttendee' THEN 'sitevisit.attendee_retired' ELSE 'sitevisit.place_retired' END;
      v_actor := NEW."retiredById";
    ELSE
      RETURN NULL;   -- the node-clearing action
    END IF;
  END IF;

  SELECT count(*), max(e."eventId") INTO v_count, v_event
    FROM "DomainEvent" e
   WHERE e."projectId" = NEW."projectId"
     AND e."entityType" = 'SiteVisit' AND e."entityId" = v_visit
     AND e."eventType" = v_type
     AND e."actorKind" = 'human' AND e."actorId" = v_actor
     AND e."xmin" = txid_current()::text::xid
     AND (v_row IS NULL OR e."payload" ->> 'rowId' = v_row);

  IF TG_NAME LIKE '%\_deferred' THEN
    IF v_count <> 1 THEN
      RAISE EXCEPTION
        'site-visits: % % changed (%) in this transaction with % matching `%` event(s) from % — each change is announced exactly once, by the person it is attributed to, on the visit''s stream%',
        v_table, NEW."id", TG_OP, v_count, v_type, v_actor,
        CASE WHEN v_row IS NULL THEN '' ELSE ', naming this row as payload.rowId' END;
    END IF;
    IF v_needs_notice THEN
      SELECT count(*) INTO v_notices FROM "Notification" n
       WHERE n."projectId" = NEW."projectId" AND n."eventId" = v_event AND n."kind" = v_type
         AND n."xmin" = txid_current()::text::xid;
      IF v_notices <> 1 THEN
        RAISE EXCEPTION
          'site-visits: % % (`%`) commits with % notice(s) bound to its event — a start, end or close is told to the project exactly once',
          v_table, NEW."id", v_type, v_notices;
      END IF;
    END IF;
  END IF;
  IF v_count <> 1 THEN RETURN NULL; END IF;   -- the immediate half, before the event: the deferred half decides
  PERFORM platform_claim_event_pairing_once(NEW."projectId", v_event, v_table, NEW."id");
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "SiteVisit_claim" ON "SiteVisit";
CREATE TRIGGER "SiteVisit_claim"
  AFTER INSERT OR UPDATE ON "SiteVisit"
  FOR EACH ROW EXECUTE FUNCTION site_visits_claim();
DROP TRIGGER IF EXISTS "SiteVisit_claim_deferred" ON "SiteVisit";
CREATE CONSTRAINT TRIGGER "SiteVisit_claim_deferred"
  AFTER INSERT OR UPDATE ON "SiteVisit" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION site_visits_claim();

DROP TRIGGER IF EXISTS "SiteVisitAttendee_claim" ON "SiteVisitAttendee";
CREATE TRIGGER "SiteVisitAttendee_claim"
  AFTER INSERT OR UPDATE ON "SiteVisitAttendee"
  FOR EACH ROW EXECUTE FUNCTION site_visits_claim();
DROP TRIGGER IF EXISTS "SiteVisitAttendee_claim_deferred" ON "SiteVisitAttendee";
CREATE CONSTRAINT TRIGGER "SiteVisitAttendee_claim_deferred"
  AFTER INSERT OR UPDATE ON "SiteVisitAttendee" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION site_visits_claim();

DROP TRIGGER IF EXISTS "SiteVisitPlace_claim" ON "SiteVisitPlace";
CREATE TRIGGER "SiteVisitPlace_claim"
  AFTER INSERT OR UPDATE ON "SiteVisitPlace"
  FOR EACH ROW EXECUTE FUNCTION site_visits_claim();
DROP TRIGGER IF EXISTS "SiteVisitPlace_claim_deferred" ON "SiteVisitPlace";
CREATE CONSTRAINT TRIGGER "SiteVisitPlace_claim_deferred"
  AFTER INSERT OR UPDATE ON "SiteVisitPlace" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION site_visits_claim();
