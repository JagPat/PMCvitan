-- Phase 5 Task 7B-iii-h — §I: a grant records the claim STATE it was justified against.
--
-- WHY. `SodGrant` pins the claim VERSION, and one version walks the whole §E lifecycle
-- (`submitted → under-verification → verified`) without changing id. So an approver who
-- authorised a claim that had not yet been verified would have that authority survive into
-- `verified` and excuse the certification of a verdict they never reviewed. The version says
-- WHICH claim; it does not say WHAT WAS TRUE about it.
--
-- ADDITIVE and NULLABLE. A row written before this column existed has no recorded reviewed
-- state, and there is no honest way to infer one: back-filling the bill's CURRENT status would
-- fabricate evidence that an approver saw something they may never have seen, on the exact
-- register whose purpose is to carry attributable human authorisation. So legacy rows keep NULL
-- and `resolveGrant` treats a NULL as UNUSABLE — the safe direction, and the one that does not
-- put words in an approver's mouth.
ALTER TABLE "SodGrant" ADD COLUMN "reviewedStatus" TEXT;

-- Diagnostic-first, per this repository's established pattern: an UNCONSUMED legacy grant is one
-- whose behaviour this change alters (it stops authorising anything until re-issued), so the
-- deploy STOPS and names them rather than silently revoking live authority. Consumed grants are
-- history and are unaffected — they already did their work under the old rule.
DO $$
DECLARE
  v_live integer;
BEGIN
  SELECT count(*) INTO v_live FROM "SodGrant" WHERE "consumedAt" IS NULL;
  IF v_live > 0 THEN
    RAISE EXCEPTION
      'phase5_t7biiih: % unconsumed SodGrant row(s) predate the reviewedStatus column. They record no evidence of what their approver reviewed, so this release makes them unusable rather than inventing one. Have a pmc re-issue each authorisation against the claim state they can see now, then redeploy. See docs/RUNBOOK.md.',
      v_live;
  END IF;
END $$;

-- …and the live-scope index has to learn the new way a row becomes INERT.
--
-- The index's own history says why. Codex round 9 added `approverId` to this scope for exactly
-- this reason: an unconsumed grant whose approver later lost standing can never be spent, and
-- without the approver in the key no OTHER pmc could issue a replacement — "the stale row is inert
-- rather than dangerous; what the index must not do is let that inert row block a valid one."
--
-- `reviewedStatus` creates a second way to be inert. A grant authorised over a `submitted` claim
-- stops being spendable the moment the claim verifies, and without this column in the scope the
-- SAME approver could not re-authorise against the state that is now true — the remedy for a
-- stale review would be unreachable, which is worse than the hole it closes. A grant against a
-- different reviewed state is a different authorisation, so it is a different row.
DROP INDEX IF EXISTS "SodGrant_live_scope_key";
CREATE UNIQUE INDEX "SodGrant_live_scope_key"
  ON "SodGrant"("projectId", "billId", "versionId", "rule", "actorId", "approverId", "reviewedStatus")
  WHERE "consumedAt" IS NULL;
