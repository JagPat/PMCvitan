-- Phase 2 Task 5 — Command-Idempotency Ledger.
--
-- Additive. Adds CommandExecution: one receipt per (scope, actor, commandType, idempotencyKey).
-- A retried/duplicated command (offline replay, network retry, double-tap) reserves→executes→
-- commits its succeeded receipt in ONE transaction, so the effect happens exactly once and a
-- replay returns the stored result. See src/platform/commands.ts for the reserve/execute/receipt
-- protocol and the actor-scoped, non-disclosing replay lookup.
--
-- The table / index / FK DDL below is exactly what Prisma generates from schema.prisma (so there
-- is no schema drift). The SCOPE-SPECIFIC partial unique indexes, the scope truth-table CHECK,
-- the status CHECK and the composite project-scoped tenant FK are the hand-added, not-Prisma-
-- expressible parts (the same accepted-drift convention Phase 0/1/Task-4 used for partial
-- indexes, CHECKs and composite tenant keys). This migration writes NO rows: it is a pure
-- capability addition, so a legacy client that sends no key keeps working unchanged.

-- CreateTable
CREATE TABLE "CommandExecution" (
    "id" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "actorId" TEXT NOT NULL,
    "commandType" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "resultRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CommandExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommandExecution_organizationId_idx" ON "CommandExecution"("organizationId");

-- CreateIndex
CREATE INDEX "CommandExecution_projectId_idx" ON "CommandExecution"("projectId");

-- AddForeignKey — the simple tenant FK covers ORG-scoped rows (organizationId always non-null).
-- CASCADE: a command receipt is meaningless once its org is hard-deleted.
ALTER TABLE "CommandExecution" ADD CONSTRAINT "CommandExecution_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- Scope truth table (round-2 B) — a CHECK, not a convention. A project-scoped row carries BOTH
-- ids; an org-scoped row carries the org and a NULL project. This is what lets the composite
-- project FK and the partial indexes rely on projectId's presence/absence per scope.
ALTER TABLE "CommandExecution" ADD CONSTRAINT "CommandExecution_scope_truth_table" CHECK (
  ("scopeKind" = 'project' AND "organizationId" IS NOT NULL AND "projectId" IS NOT NULL)
  OR ("scopeKind" = 'org' AND "organizationId" IS NOT NULL AND "projectId" IS NULL)
);

-- Status is a small closed set — the ledger never holds a value outside the protocol.
ALTER TABLE "CommandExecution" ADD CONSTRAINT "CommandExecution_status_check" CHECK (
  "status" IN ('reserved', 'succeeded', 'failed')
);

-- Composite project-scoped tenant FK (organizationId, projectId) -> Project(orgId, id): a
-- project-scoped receipt's organizationId MUST be the project's REAL org (forgery-proof, exactly
-- like the DomainEvent tenant key). Under MATCH SIMPLE a row with a NULL projectId (org scope)
-- skips this FK, so only project-scoped rows are constrained. CASCADE: receipts follow a hard
-- project delete (they are disposable idempotency records, not an immutable audit trail).
ALTER TABLE "CommandExecution" ADD CONSTRAINT "CommandExecution_tenant_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────────────────
-- SCOPE-SPECIFIC PARTIAL unique indexes (round-3). Prisma cannot express a WHERE, so these are
-- hand-written. The project index constrains ONLY project-scoped rows; the org index ONLY
-- org-scoped rows. Consequences:
--   * the same (actor, command, key) on two projects of one org → two rows (project index keys
--     on projectId, which differs), never a false collision;
--   * an org-scoped duplicate key IS rejected (the org index keys on organizationId), so a
--     concurrent duplicate reserve raises 23505 → the loser replays the winner's committed result.
CREATE UNIQUE INDEX "command_execution_project_key"
  ON "CommandExecution" ("projectId", "actorId", "commandType", "idempotencyKey")
  WHERE "scopeKind" = 'project';

CREATE UNIQUE INDEX "command_execution_org_key"
  ON "CommandExecution" ("organizationId", "actorId", "commandType", "idempotencyKey")
  WHERE "scopeKind" = 'org';
