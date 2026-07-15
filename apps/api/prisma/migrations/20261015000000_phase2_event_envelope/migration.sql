-- Phase 2 Task 4 — Domain-Event Envelope + Gap-Safe Per-Project Stream Position.
--
-- Additive, diagnostic-first. Adds:
--   * ProjectEventStream — one gap-safe position counter per project (backfilled here).
--   * DomainEvent        — the append-only, tenant-consistent, totally-ordered event store.
--   * Project.orgId is made NOT NULL (after a STOP-condition diagnostic), and Project gains
--     the composite unique (orgId, id) the event's tenant FK references.
-- Ordering is (projectId, streamPosition) — NEVER occurredAt (display/audit only).
--
-- Append-only is enforced at the DATABASE level by a BEFORE UPDATE OR DELETE trigger that
-- RAISEs (it fires for every role, including the owner/superuser the app and tests connect
-- as, so it is the load-bearing guarantee here). A dedicated restricted writer role that owns
-- INSERTs only is the aspirational defense-in-depth layer for a multi-role production
-- deployment; this single-role codebase has no separate connection to enforce it under, so it
-- is intentionally left to production role management rather than wired in here.
--
-- The table / index / FK DDL below is exactly what Prisma generates from schema.prisma (so
-- there is no schema drift); the diagnostic DO block, the ProjectEventStream backfill, the
-- attribution CHECK and the append-only trigger are the hand-added, not-Prisma-expressible
-- parts (the same convention Phase 0/1 used for partial indexes, CHECKs and diagnostics).

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- STOP condition (round-2 D): the envelope's tenant key requires every project to belong to
-- an organization. Abort rather than guess a tenant — the operator backfills org first
-- (ensure-accounts already can), then re-runs. Never emit an event with a null organizationId.
DO $$
DECLARE orphan_projects INT;
BEGIN
  SELECT COUNT(*) INTO orphan_projects FROM "Project" WHERE "orgId" IS NULL;
  IF orphan_projects > 0 THEN
    RAISE EXCEPTION 'phase2_event_envelope: % project(s) have no organization (orgId IS NULL) — the event envelope tenant key requires every project to belong to an org; run ensure-accounts to assign a tenant — resolve by hand before migrating', orphan_projects;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Project.orgId → NOT NULL (safe now the diagnostic proved no null-org projects remain).
-- Prisma recreates the orgId FK when the column nullability changes.
ALTER TABLE "Project" DROP CONSTRAINT "Project_orgId_fkey";
ALTER TABLE "Project" ALTER COLUMN "orgId" SET NOT NULL;

-- The composite identity the DomainEvent tenant FK references (orgId, id).
CREATE UNIQUE INDEX "Project_orgId_id_key" ON "Project"("orgId", "id");

-- ProjectEventStream — the per-project gap-safe position counter. emit() locks + increments
-- this row inside the owning mutation transaction, so two concurrent commits on one project
-- get distinct, ordered positions and can never skip.
CREATE TABLE "ProjectEventStream" (
    "projectId" TEXT NOT NULL,
    "nextPosition" BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT "ProjectEventStream_pkey" PRIMARY KEY ("projectId")
);

-- DomainEvent — the append-only event store.
CREATE TABLE "DomainEvent" (
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadVersion" INTEGER NOT NULL DEFAULT 1,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "streamPosition" BIGINT NOT NULL,
    "siteId" TEXT,
    "actorId" TEXT,
    "actorKind" TEXT NOT NULL,
    "systemActor" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlationId" TEXT,
    "causedByEventId" TEXT,
    "payload" JSONB,
    CONSTRAINT "DomainEvent_pkey" PRIMARY KEY ("eventId")
);
CREATE INDEX "DomainEvent_projectId_streamPosition_idx" ON "DomainEvent"("projectId", "streamPosition");
CREATE INDEX "DomainEvent_eventType_idx" ON "DomainEvent"("eventType");
CREATE UNIQUE INDEX "DomainEvent_projectId_streamPosition_key" ON "DomainEvent"("projectId", "streamPosition");

-- FKs (Prisma-generated names). The composite (organizationId, projectId) -> Project(orgId, id)
-- is the tenant guard: a forged organizationId that is not the project's own org is rejected.
-- RESTRICT — an append-only event outlives soft-deletes; a project carrying events cannot be
-- hard-deleted out from under them.
ALTER TABLE "Project" ADD CONSTRAINT "Project_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectEventStream" ADD CONSTRAINT "ProjectEventStream_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Backfill: every existing project gets exactly one stream row at position 0, so emit() can
-- never encounter a project without a counter. New projects create their row in the
-- project-creation transaction (so a project can never commit without its stream).
INSERT INTO "ProjectEventStream" ("projectId", "nextPosition")
SELECT "id", 0 FROM "Project"
ON CONFLICT ("projectId") DO NOTHING;

-- Attribution truth table (round-2 D) — a CHECK, not a convention:
--   actorKind IN ('human','system');
--   a human event REQUIRES a real user identity (actorId NOT NULL);
--   a system event REQUIRES a named stable system-actor reference (systemActor NOT NULL).
ALTER TABLE "DomainEvent" ADD CONSTRAINT "DomainEvent_attribution_truth_table" CHECK (
  "actorKind" IN ('human', 'system')
  AND ("actorKind" <> 'human' OR "actorId" IS NOT NULL)
  AND ("actorKind" <> 'system' OR "systemActor" IS NOT NULL)
);

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Append-only at the database level: a BEFORE UPDATE OR DELETE row trigger that RAISEs. It
-- fires for EVERY role (owner/superuser included), so a domain event can never be rewritten or
-- erased once written. TRUNCATE is intentionally NOT covered (it fires no row trigger) so a
-- disposable test database can still be reset between suites; production never TRUNCATEs it.
CREATE OR REPLACE FUNCTION "domainEvent_append_only"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'DomainEvent is append-only: % is not permitted (eventId=%)', TG_OP, OLD."eventId";
END;
$$;

CREATE TRIGGER "DomainEvent_append_only"
  BEFORE UPDATE OR DELETE ON "DomainEvent"
  FOR EACH ROW EXECUTE FUNCTION "domainEvent_append_only"();

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Every project MUST have its stream counter (round-2 D: "project creation cannot commit
-- without its ProjectEventStream row"). An AFTER INSERT trigger creates the row in the SAME
-- transaction as the project insert, for EVERY creation path (the service, the seed, test
-- fixtures, future migrations) — so emit() can never meet a project without a counter, and no
-- project can commit without one. Idempotent (ON CONFLICT) so the backfill above never clashes.
CREATE OR REPLACE FUNCTION "project_ensure_event_stream"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "ProjectEventStream" ("projectId", "nextPosition")
  VALUES (NEW."id", 0)
  ON CONFLICT ("projectId") DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Project_ensure_event_stream"
  AFTER INSERT ON "Project"
  FOR EACH ROW EXECUTE FUNCTION "project_ensure_event_stream"();
