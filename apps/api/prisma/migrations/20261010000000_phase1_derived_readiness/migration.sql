-- Phase 1 Task 6 — readiness derived from explicit links (additive).
-- Timestamped AFTER 20261005000000_phase1_closing_signoff per the gate
-- re-review instruction; the plan's original 20260930 slot was taken by the
-- Task 4 migration.
--
-- Creates GateOverride: the ONLY remaining manual path over a derived gate —
-- an attributable, reasoned, optionally evidenced record that ALWAYS expires.
-- Readiness itself is a READ-TIME derivation (domain/transitions.ts) — no
-- stored gate value is backfilled or rewritten here, and Activity.gateInspection
-- is retired from the write contracts but KEPT as a deprecated column (its
-- stored-vs-derived delta report ships as scripts/readiness-delta-report.ts,
-- run against an upgraded copy and attached to the PR — the canonical TS
-- derivation is the single implementation, never re-implemented in SQL).

-- CreateTable
CREATE TABLE "GateOverride" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "state" "GateState" NOT NULL,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorName" TEXT NOT NULL,
    "evidenceMediaId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GateOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GateOverride_projectId_activityId_idx" ON "GateOverride"("projectId", "activityId");

-- AddForeignKey
ALTER TABLE "GateOverride" ADD CONSTRAINT "GateOverride_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: an override can only name THIS project's activity
ALTER TABLE "GateOverride" ADD CONSTRAINT "GateOverride_projectId_activityId_fkey" FOREIGN KEY ("projectId", "activityId") REFERENCES "Activity"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey: supporting evidence must be THIS project's photo
ALTER TABLE "GateOverride" ADD CONSTRAINT "GateOverride_projectId_evidenceMediaId_fkey" FOREIGN KEY ("projectId", "evidenceMediaId") REFERENCES "Media"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
