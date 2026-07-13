-- Phase 1 Task 2 — decision change-control: real attribution columns, a resolvable
-- ChangeRequest lifecycle, and the DATABASE-ENFORCED one-open-request invariant.
-- Additive and diagnostic-first: the migration ABORTS on ambiguous legacy data
-- rather than picking a winner silently (plan STOP condition).

-- 1. Additive attribution / resolution columns ------------------------------------
ALTER TABLE "Decision" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "Decision" ADD COLUMN "onBehalfOf" TEXT;

ALTER TABLE "DecisionEvent" ADD COLUMN "actorId" TEXT;
ALTER TABLE "DecisionEvent" ADD COLUMN "actorName" TEXT;

ALTER TABLE "AuditLog" ADD COLUMN "actorId" TEXT;

ALTER TABLE "ChangeRequest" ADD COLUMN "requestedById" TEXT;
ALTER TABLE "ChangeRequest" ADD COLUMN "resolvedById" TEXT;
ALTER TABLE "ChangeRequest" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "ChangeRequest" ADD COLUMN "resolution" TEXT;

-- 2. Diagnostics BEFORE any backfill: a decision still reopened ('change') must
--    resolve to AT MOST ONE would-be-open legacy request. More than one is
--    ambiguous — abort and report; an operator resolves it by hand.
DO $$
DECLARE bad INT;
BEGIN
  SELECT COUNT(*) INTO bad FROM (
    SELECT cr."decisionId"
    FROM "ChangeRequest" cr
    JOIN "Decision" d ON d.id = cr."decisionId"
    WHERE cr.status = 'pending' AND d.status = 'change'
    GROUP BY cr."decisionId"
    HAVING COUNT(*) > 1
  ) ambiguous;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase1_change_control: % decision(s) carry multiple would-be-open change requests — resolve by hand before migrating', bad;
  END IF;
END $$;

-- 3. Backfill: 'pending' becomes 'open' ONLY while its decision is still reopened;
--    every other legacy 'pending' row is closed as 'resolved' (null resolution —
--    the legacy rows never modeled how they were closed, and we do not invent it).
UPDATE "ChangeRequest" cr
SET "status" = 'open'
FROM "Decision" d
WHERE d.id = cr."decisionId" AND cr.status = 'pending' AND d.status = 'change';

UPDATE "ChangeRequest" SET "status" = 'resolved' WHERE "status" = 'pending';

-- 4. New rows are born open; the engine enforces exactly one open per decision.
--    (A partial unique index is not expressible in Prisma schema — documented on
--    the ChangeRequest model; the service translates the P2002 to a 409.)
ALTER TABLE "ChangeRequest" ALTER COLUMN "status" SET DEFAULT 'open';

CREATE UNIQUE INDEX "ChangeRequest_one_open_per_decision"
  ON "ChangeRequest" ("decisionId")
  WHERE "status" = 'open';
