-- Phase 2 fix-forward PR B — Durable Outbox Reliability.
--
-- Additive + constraint-strengthening, DIAGNOSTIC-FIRST. It (1) adds the durable consumer catalog
-- and the dispatch/no-op action, (2) binds every delivery's copied (projectId, streamPosition) to
-- its event's REAL coordinates with a composite FK, and (3) binds every delivery to a declared
-- consumer contract. It ABORTS with counts + samples rather than guessing if any existing delivery
-- coordinate disagrees with its DomainEvent — the append-only event is authoritative and is never
-- rewritten. It writes NO business rows and leaves historical payloads, IDs, attempts and statuses
-- unchanged; it only seeds the two already-registered consumer contracts.
--
-- The table / column / index DDL matches what Prisma generates from schema.prisma; the CHECKs, the
-- coordinate diagnostic and the composite FKs are the hand-added, not-Prisma-expressible parts (the
-- same accepted-drift convention Task 4/5/6 used).

-- ── 1. Additive columns (nullable / defaulted — existing rows keep working) ───────────────────
ALTER TABLE "DomainEvent"    ADD COLUMN "dispatchIntent" JSONB;
ALTER TABLE "OutboxDelivery" ADD COLUMN "deliveryAction" TEXT NOT NULL DEFAULT 'dispatch';

-- ── 2. Durable consumer catalog + operator-action audit + cutover-state (declared here) ───────
CREATE TABLE "OutboxConsumerCatalog" (
    "consumer" TEXT NOT NULL,
    "consumerKind" TEXT NOT NULL,
    "consumerEffect" TEXT NOT NULL,
    "catalogVersion" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxConsumerCatalog_pkey" PRIMARY KEY ("consumer")
);
CREATE UNIQUE INDEX "OutboxConsumerCatalog_consumer_consumerKind_key" ON "OutboxConsumerCatalog"("consumer", "consumerKind");

CREATE TABLE "OutboxOperatorAction" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "deliveryId" TEXT,
    "consumer" TEXT,
    "projectId" TEXT,
    "eventId" TEXT,
    "operatorIdentity" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "priorError" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxOperatorAction_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutboxOperatorAction_at_idx" ON "OutboxOperatorAction"("at");

CREATE TABLE "OutboxCutoverState" (
    "key" TEXT NOT NULL,
    "coverageVersion" TEXT NOT NULL,
    "sealedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxCutoverState_pkey" PRIMARY KEY ("key")
);

-- ── 3. Seed the two already-registered consumer contracts (v1, unordered/external) ────────────
-- These MUST exist before the (consumer, consumerKind) delivery FK is added, so every existing
-- delivery resolves to a declared contract. ON CONFLICT keeps re-runs idempotent.
INSERT INTO "OutboxConsumerCatalog" ("consumer", "consumerKind", "consumerEffect", "catalogVersion", "active", "registeredAt", "updatedAt")
VALUES
  ('socket.invalidation', 'unordered', 'external', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('webpush.notify',      'unordered', 'external', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("consumer") DO NOTHING;

-- ── 4. DIAGNOSTIC — abort (never guess) if any delivery coordinate disagrees with its event ───
-- Runs BEFORE the composite FK so the failure is a readable diagnostic, not a cryptic FK violation.
DO $$
DECLARE
  mismatch_count integer;
  sample text;
BEGIN
  SELECT count(*) INTO mismatch_count
  FROM "OutboxDelivery" d
  JOIN "DomainEvent" e ON e."eventId" = d."eventId"
  WHERE d."projectId" <> e."projectId" OR d."streamPosition" <> e."streamPosition";

  IF mismatch_count > 0 THEN
    SELECT string_agg(line, '; ') INTO sample FROM (
      SELECT format('delivery %s: delivery(%s, %s) vs event(%s, %s)',
                    d."id", d."projectId", d."streamPosition", e."projectId", e."streamPosition") AS line
      FROM "OutboxDelivery" d
      JOIN "DomainEvent" e ON e."eventId" = d."eventId"
      WHERE d."projectId" <> e."projectId" OR d."streamPosition" <> e."streamPosition"
      LIMIT 5
    ) s;
    RAISE EXCEPTION 'phase2_outbox_reliability aborted: % OutboxDelivery row(s) have coordinates that disagree with their DomainEvent (samples: %). The append-only event is authoritative; correct the delivery coordinates (never the event) before re-running.', mismatch_count, sample;
  END IF;
END $$;

-- ── 5. Candidate key the composite delivery FK references ─────────────────────────────────────
CREATE UNIQUE INDEX "DomainEvent_eventId_projectId_streamPosition_key" ON "DomainEvent"("eventId", "projectId", "streamPosition");

-- ── 6. Replace the event-only FK with the composite coordinate FK ─────────────────────────────
ALTER TABLE "OutboxDelivery" DROP CONSTRAINT "OutboxDelivery_eventId_fkey";
ALTER TABLE "OutboxDelivery" ADD CONSTRAINT "OutboxDelivery_eventId_projectId_streamPosition_fkey"
  FOREIGN KEY ("eventId", "projectId", "streamPosition")
  REFERENCES "DomainEvent"("eventId", "projectId", "streamPosition")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 7. Bind every delivery to a declared consumer contract ────────────────────────────────────
ALTER TABLE "OutboxDelivery" ADD CONSTRAINT "OutboxDelivery_consumer_consumerKind_fkey"
  FOREIGN KEY ("consumer", "consumerKind")
  REFERENCES "OutboxConsumerCatalog"("consumer", "consumerKind")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 8. Closed-set CHECKs (not Prisma-expressible) ─────────────────────────────────────────────
ALTER TABLE "OutboxDelivery" ADD CONSTRAINT "OutboxDelivery_deliveryAction_check" CHECK (
  "deliveryAction" IN ('dispatch', 'noop')
);
ALTER TABLE "OutboxConsumerCatalog" ADD CONSTRAINT "OutboxConsumerCatalog_consumerKind_check" CHECK (
  "consumerKind" IN ('ordered', 'unordered')
);
ALTER TABLE "OutboxConsumerCatalog" ADD CONSTRAINT "OutboxConsumerCatalog_consumerEffect_check" CHECK (
  "consumerEffect" IN ('db', 'external')
);
-- Only the two supported pairs: an ordered consumer is a DB projection; an unordered consumer is an
-- external effect (socket/push). Any other pairing is a contract error, refused by the database.
ALTER TABLE "OutboxConsumerCatalog" ADD CONSTRAINT "OutboxConsumerCatalog_kind_effect_check" CHECK (
  ("consumerKind" = 'ordered' AND "consumerEffect" = 'db') OR
  ("consumerKind" = 'unordered' AND "consumerEffect" = 'external')
);
-- The cutover state is a singleton — at most one row can ever exist.
ALTER TABLE "OutboxCutoverState" ADD CONSTRAINT "OutboxCutoverState_singleton_check" CHECK (
  "key" = 'singleton'
);
