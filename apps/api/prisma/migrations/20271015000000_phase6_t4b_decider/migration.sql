-- Phase 6 task 4b — the decider, and the record-only issue
-- (docs/superpowers/plans/2026-08-14-decision-workflow-4b.md §A–§B).
--
-- STAGED SHAPE (the 4a §D discipline): this first slice carries ONLY the contracts/enums/columns
-- the unit's probes need — the behavior (the audit, the §B.2 primitives, the seal network) is
-- deliberately absent at the staged baseline so every probe fails on BEHAVIOR, never on a missing
-- symbol. The seals join this same file in the behavior slice of the same review unit.
--
-- Enum additions ride the migration transaction (PostgreSQL ≥ 12); nothing in THIS transaction
-- consumes the new values, and every later in-file comparison uses ::text, so the
-- unusable-in-same-transaction rule is never tripped.

ALTER TYPE "DeciderKind" ADD VALUE IF NOT EXISTS 'none';
ALTER TYPE "DecisionStatus" ADD VALUE IF NOT EXISTS 'recorded';

-- §A.2 — a RECORD has no option-sourced presentation; the choice kinds keep the column required
-- (the CHECK arrives with the seal slice, judged by ::text so it never consumes the new value).
ALTER TABLE "Decision" ALTER COLUMN "photoSwatch" DROP NOT NULL;

-- §A.3 rounds 9/13/14/15 — the OPTIONAL subscription→user linkage for targeted delivery. All
-- nullable and additive: today's rows carry no owner and a backfill cannot invent one; the link
-- is attributed opportunistically on the next authenticated app open.
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "linkedUserId" TEXT;
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "linkedCredentialVersion" INTEGER;
ALTER TABLE "PushSubscription" ADD COLUMN IF NOT EXISTS "linkedExpiresAt" TIMESTAMP(3);
DO $$ BEGIN
  ALTER TABLE "PushSubscription"
    ADD CONSTRAINT "PushSubscription_linkedUserId_fkey"
    FOREIGN KEY ("linkedUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS "PushSubscription_linkedUserId_idx"
  ON "PushSubscription"("linkedUserId");
