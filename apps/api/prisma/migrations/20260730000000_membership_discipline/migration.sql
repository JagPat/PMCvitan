-- Consultant role: a per-project membership can now record a `discipline` (architect,
-- MEP, lighting, plumbing, …) for a `consultant` member. The discipline is a label, not a
-- permission — every consultant shares the same read-mostly role, so a new consultant type
-- needs no new role. Additive and nullable: existing memberships are unaffected.

ALTER TABLE "Membership" ADD COLUMN "discipline" TEXT;
