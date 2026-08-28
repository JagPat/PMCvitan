-- Phase 6 unit 4b — the decider takes authority (plan §A.1/§A.3).
--
-- Additive and read-model only. Every canonical column this unit needs (`Decision.deciderKind`,
-- `deciderMembershipId`, the frozen approval tuple, the holder freeze, the `Membership` candidate
-- key and its identity freeze) already shipped with 20270826000000; the behaviour this unit adds
-- is application-side. What is missing is on the READ-MODEL: `DecisionProjection` carries no
-- holder, so the projected slice cannot apply the per-viewer rule the live slice now applies.
--
-- `deciderKind` defaults to 'client', which is what every projected row already represents, and
-- `deciderUserId` is NULL for every role-held decision. The projection is REBUILDABLE, and its
-- consumer refreshes the whole project's row set from canonical on every applied decision event,
-- so existing generations converge without a backfill; a rebuild produces the same rows either
-- way. No canonical table, constraint, trigger or seal is touched here.
ALTER TABLE "DecisionProjection" ADD COLUMN IF NOT EXISTS "deciderKind" TEXT NOT NULL DEFAULT 'client';
ALTER TABLE "DecisionProjection" ADD COLUMN IF NOT EXISTS "deciderUserId" TEXT;
