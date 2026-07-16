-- Phase 2 Task 6 — Per-Consumer Transactional Outbox.
--
-- Additive. Adds three tables:
--   * OutboxDelivery  — one delivery row per (event, consumer), written IN THE SAME transaction
--                       as the DomainEvent (crash-safe). A lease-based relay claims and dispatches.
--   * ProcessedEvent  — a database consumer's effectively-once idempotency record.
--   * ProjectionCursor — an ordered consumer's contiguous per-project checkpoint.
--
-- The table / index / FK DDL below is exactly what Prisma generates from schema.prisma (no
-- drift); the status / consumerKind / cursor-status CHECKs are the hand-added, not-Prisma-
-- expressible parts (the same accepted-drift convention Phase 0/1/Task-4/Task-5 used). This
-- migration writes NO rows — pre-cutover events are backfilled once by the app's bootstrap
-- (deriving deliveries from the existing DomainEvent rows), so a legacy database keeps working.

-- CreateTable
CREATE TABLE "OutboxDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "consumerKind" TEXT NOT NULL,
    "streamPosition" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedEvent" (
    "id" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectionCursor" (
    "id" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "appliedPosition" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'live',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectionCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboxDelivery_consumer_status_nextAttemptAt_idx" ON "OutboxDelivery"("consumer", "status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxDelivery_consumer_projectId_streamPosition_idx" ON "OutboxDelivery"("consumer", "projectId", "streamPosition");

-- CreateIndex
CREATE UNIQUE INDEX "OutboxDelivery_eventId_consumer_key" ON "OutboxDelivery"("eventId", "consumer");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedEvent_consumer_eventId_key" ON "ProcessedEvent"("consumer", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectionCursor_consumer_projectId_key" ON "ProjectionCursor"("consumer", "projectId");

-- AddForeignKey — a delivery cannot outlive its event. DomainEvent is append-only (a delete is
-- blocked by its trigger), so this cascade only ever fires for a disposable TRUNCATE reset.
ALTER TABLE "OutboxDelivery" ADD CONSTRAINT "OutboxDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "DomainEvent"("eventId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Closed-set CHECKs (not Prisma-expressible). The delivery status is the state machine's set —
-- note there is NO ambiguous 'failed'. consumerKind and the cursor status are likewise closed.
ALTER TABLE "OutboxDelivery" ADD CONSTRAINT "OutboxDelivery_status_check" CHECK (
  "status" IN ('pending', 'leased', 'succeeded', 'dead')
);
ALTER TABLE "OutboxDelivery" ADD CONSTRAINT "OutboxDelivery_consumerKind_check" CHECK (
  "consumerKind" IN ('ordered', 'unordered')
);
ALTER TABLE "ProjectionCursor" ADD CONSTRAINT "ProjectionCursor_status_check" CHECK (
  "status" IN ('live', 'blocked')
);
