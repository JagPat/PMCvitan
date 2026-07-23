-- Phase 3 Task 6 — canonical coverage authority (§A/§B).
--
-- `ApprovedSubstitution` is the audited, event-bearing record that lets accepted
-- stock of one specification satisfy a requirement pinned to a DIFFERENT
-- specification (§B satisfaction rule). It is pmc authority, per requirement
-- root, and coverage re-derives WITHOUT it from the moment it is revoked.
--
-- Additive only: a new table + its four foreign keys (project, requirement root,
-- the approving user, the optional revoking user) + two read indexes.
CREATE TABLE "ApprovedSubstitution" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "fromFingerprint" TEXT NOT NULL,
    "toFingerprint" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "ApprovedSubstitution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovedSubstitution_projectId_requirementId_idx" ON "ApprovedSubstitution"("projectId", "requirementId");

-- CreateIndex
CREATE INDEX "ApprovedSubstitution_projectId_toFingerprint_idx" ON "ApprovedSubstitution"("projectId", "toFingerprint");

-- AddForeignKey
ALTER TABLE "ApprovedSubstitution" ADD CONSTRAINT "ApprovedSubstitution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey — the substitution lives under the immutable requirement ROOT (per-project lineage),
-- so a substitution can never straddle projects or point at a requirement outside this project.
ALTER TABLE "ApprovedSubstitution" ADD CONSTRAINT "ApprovedSubstitution_projectId_requirementId_fkey" FOREIGN KEY ("projectId", "requirementId") REFERENCES "ActivityRequirementRoot"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey — attributable human authority (approve), validated against a real user row.
ALTER TABLE "ApprovedSubstitution" ADD CONSTRAINT "ApprovedSubstitution_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey — attributable human authority (revoke), when present.
ALTER TABLE "ApprovedSubstitution" ADD CONSTRAINT "ApprovedSubstitution_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- §B: a substitution is written ONCE and never deleted; the ONLY mutation ever
-- allowed is the single revocation stamp (NULL → set on all three revoke columns
-- together). Every identity/authority column is frozen after insert, a revoked
-- row can never be un-revoked or re-revoked, and no row is ever deleted. This
-- keeps "never deletes the record — coverage re-derives without it" a
-- DATABASE truth, not a service convention. (TRUNCATE fires no row trigger and
-- stays available to the test harness.)
CREATE OR REPLACE FUNCTION phase3_substitution_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ApprovedSubstitution rows are never deleted (§B): revoke instead';
  END IF;
  -- identity + approval columns are frozen
  IF NEW."id" <> OLD."id"
     OR NEW."projectId" <> OLD."projectId"
     OR NEW."requirementId" <> OLD."requirementId"
     OR NEW."fromFingerprint" <> OLD."fromFingerprint"
     OR NEW."toFingerprint" <> OLD."toFingerprint"
     OR NEW."reason" <> OLD."reason"
     OR NEW."approvedById" <> OLD."approvedById"
     OR NEW."at" <> OLD."at" THEN
    RAISE EXCEPTION 'ApprovedSubstitution identity/approval columns are immutable (§B)';
  END IF;
  -- a revoked row is terminal — its revocation stamp can never change
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'ApprovedSubstitution % is already revoked — a revocation is terminal (§B)', OLD."id";
  END IF;
  -- the only legal transition writes ALL THREE revoke columns together (NULL → set)
  IF NEW."revokedAt" IS NULL OR NEW."revokedById" IS NULL OR NEW."revokeReason" IS NULL THEN
    RAISE EXCEPTION 'the only mutation of an ApprovedSubstitution is a complete revocation stamp (revokedAt + revokedById + revokeReason)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ApprovedSubstitution_immutable"
  BEFORE UPDATE OR DELETE ON "ApprovedSubstitution"
  FOR EACH ROW EXECUTE FUNCTION phase3_substitution_immutable();
