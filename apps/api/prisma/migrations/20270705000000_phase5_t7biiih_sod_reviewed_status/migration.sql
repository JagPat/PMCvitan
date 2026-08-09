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
--
-- `IF NOT EXISTS` because this file is RERUNNABLE BY DESIGN, not from caution. The closing `DO`
-- block below deliberately aborts the deploy on a legacy unconsumed grant — AFTER this statement has
-- already succeeded — and the remedy it instructs is "re-issue those authorisations, then redeploy".
-- Without this, that second run dies on duplicate-column and the instruction is unreachable: the
-- migration would have made itself unrepairable by the very diagnostic that exists to repair it.
ALTER TABLE "SodGrant" ADD COLUMN IF NOT EXISTS "reviewedStatus" TEXT;

-- ── …AND A STATUS IS A DESCRIPTION, NOT AN IDENTITY ──────────────────────────────────────────
--
-- Codex round 2 (P1), and it is the deeper half of the defect this whole unit exists for.
--
-- Recording the reviewed STATUS closed the case where a claim moves on. It does not close the case
-- where a claim moves on and COMES BACK: §F DERIVES the payment status from the folds, and the
-- derivation genuinely returns to a label it has left. Certify ₹100 with ₹10 withheld → `certified`;
-- approve and pay the ₹90 → `paid`; release ₹5 of the withholding → `certified` again. An
-- authorisation given at the first `certified`, when nothing was approved, matches the label at the
-- second — by which time ₹90 has been authorised and has left the practice.
--
-- The reviewed identity therefore needs a fact that only ever moves FORWARD. `lifecycleVersion` is
-- that fact: a per-claim counter, bumped whenever the status changes, never reused.
--
-- BUMPED BY A TRIGGER, not by the services. There are six separate writers of `VendorBill.status`
-- across four services, and "remember to also bump the counter" is exactly the instruction this
-- review lineage has now proved three times that nobody remembers. A trigger is the one site none
-- of them can opt out of, and a seventh writer added tomorrow inherits it without being told.
ALTER TABLE "VendorBill" ADD COLUMN IF NOT EXISTS "lifecycleVersion" INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION phase5_t7biiih_bill_lifecycle_version() RETURNS trigger AS $$
BEGIN
  -- It counts TRANSITIONS, not writes. A write that leaves the status alone must not move it, or
  -- every unrelated edit would silently stale an approver's pin and the remedy — re-authorise —
  -- would be demanded for nothing.
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    NEW."lifecycleVersion" := OLD."lifecycleVersion" + 1;
  ELSIF NEW."lifecycleVersion" IS DISTINCT FROM OLD."lifecycleVersion" THEN
    -- and it is not a field anyone may set. A counter a writer can rewind is not monotonic, and a
    -- stale pin could be made to match again by moving the claim rather than the authorisation.
    RAISE EXCEPTION 'The claim lifecycle version only ever moves forward, and only when the status does (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorBill_lifecycle_version" ON "VendorBill";
CREATE TRIGGER "VendorBill_lifecycle_version" BEFORE UPDATE ON "VendorBill"
  FOR EACH ROW EXECUTE FUNCTION phase5_t7biiih_bill_lifecycle_version();

-- The grant records it alongside the status. NULLABLE for the same reason `reviewedStatus` is:
-- a row written before this column existed attests to nothing, and inventing a version for it would
-- be inventing the very evidence the register exists to carry.
ALTER TABLE "SodGrant" ADD COLUMN IF NOT EXISTS "reviewedLifecycleVersion" INTEGER;

-- Diagnostic-first, per this repository's established pattern: an UNCONSUMED legacy grant is one
-- whose behaviour this change alters (it stops authorising anything until re-issued), so the
-- deploy STOPS and names them rather than silently revoking live authority. Consumed grants are
-- history and are unaffected — they already did their work under the old rule.
--
-- `reviewedStatus IS NULL` is the WHOLE predicate, not a convenience. "Legacy" here means precisely
-- "written before this column existed"; an unconsumed grant that CARRIES a reviewed state is a
-- perfectly good authorisation this release created. Counting every unconsumed row instead made the
-- migration abort on any database that had already taken it and then done the very thing the abort
-- instructs — re-issue the authorisations and redeploy — so the remedy destroyed itself on success.
-- The rerunnability guard one statement above and this predicate are the same requirement asked of
-- two statements in one file.
DO $$
DECLARE
  v_live integer;
BEGIN
  SELECT count(*) INTO v_live FROM "SodGrant" WHERE "consumedAt" IS NULL AND "reviewedStatus" IS NULL;
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
--
-- `reviewedLifecycleVersion` joins it for the SAME reason, and here it is load-bearing rather than
-- symmetric: the whole point of the counter is the case where the status label RECYCLES. A
-- re-authorisation after `certified → paid → certified` carries the identical status, so with the
-- status alone in the scope the inert row and its legitimate replacement would collide — and the
-- deadlock this index exists to prevent would be created by the fix for the hole it closes.
DROP INDEX IF EXISTS "SodGrant_live_scope_key";
CREATE UNIQUE INDEX "SodGrant_live_scope_key"
  ON "SodGrant"("projectId", "billId", "versionId", "rule", "actorId", "approverId", "reviewedStatus", "reviewedLifecycleVersion")
  WHERE "consumedAt" IS NULL;

-- ── …AND THE COLUMN JOINS EVERY SEAL THAT ALREADY SURROUNDS THIS ROW ─────────────────────────
--
-- Codex, on the first head of this unit, three findings with ONE root: I added the evidence to the
-- COLUMN and stopped there. The append-only trigger that freezes every other field of a grant did
-- not learn it, and neither did the commit-time seal that judges a consumed one. That is PR #310's
-- audit rule 1 — fix the CLASS, not the instance a finding names — recurring on the very artifact
-- introduced to close a finding, which is the shape this table's own comments record twice already.
--
-- A new fact on a guarded row belongs to every guard on that row, or it is decoration.

-- (1) FROZEN. `reviewedStatus` is what an approver is recorded as having reviewed; leaving it
-- outside the immutable set let a direct writer walk a grant from `submitted` to `verified` and
-- rewrite the justification underneath an authority that had already been given. The rest of the
-- function is Task 5's, verbatim — only the new column is added, because the rule it states
-- ("a grant is immutable apart from its one-way consumption") has not changed.
CREATE OR REPLACE FUNCTION phase5_t5_grant_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A segregation-of-duties grant is an authority someone exercised — it is never deleted (%)', OLD."id";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."billId" IS DISTINCT FROM OLD."billId" OR NEW."versionId" IS DISTINCT FROM OLD."versionId"
     OR NEW."rule" IS DISTINCT FROM OLD."rule" OR NEW."actorId" IS DISTINCT FROM OLD."actorId"
     OR NEW."approverId" IS DISTINCT FROM OLD."approverId" OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."grantedAt" IS DISTINCT FROM OLD."grantedAt"
     OR NEW."reviewedStatus" IS DISTINCT FROM OLD."reviewedStatus"
     OR NEW."reviewedLifecycleVersion" IS DISTINCT FROM OLD."reviewedLifecycleVersion"
     OR NEW."sourceCommandId" IS DISTINCT FROM OLD."sourceCommandId" THEN
    RAISE EXCEPTION 'A segregation-of-duties grant is IMMUTABLE — only its one-way consumption may be stamped (%)', OLD."id";
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'This grant was already consumed at % — an authority is exercised ONCE (%)', OLD."consumedAt", OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- (2) The admissible reviewed states, PER RULE, in one place.
--
-- A trigger cannot import TypeScript, so this is the one unavoidable second copy of a shared set —
-- the position `phase5_t6b_derived_bill_status` is already in, and handled the same way: the SQL is
-- the mirror and an integration probe pins it to `BILL_CERTIFY_FROM` and
-- `BILL_STATUSES_PAST_CERTIFICATION`, so a member added to the shared lifecycle and forgotten here
-- fails a test rather than silently refusing a legitimate authorisation in production.
--
-- An UNKNOWN rule admits nothing. §I has exactly two rules today; a third added without teaching
-- this function is refused rather than waved through, which is the direction a seal should fail.
CREATE OR REPLACE FUNCTION phase5_t7biiih_admissible_reviewed_states(p_rule text)
RETURNS text[] AS $$
  SELECT CASE p_rule
    -- certification applies to a VERIFIED claim: the §E verdict is what makes it safe
    WHEN 'evidence-recorder-may-not-certify' THEN ARRAY['verified']
    -- a payment approval proceeds from a claim that HAS a live certification behind it
    WHEN 'certifier-may-not-approve' THEN ARRAY['certified', 'approved-for-payment', 'part-paid', 'paid']
    ELSE ARRAY[]::text[]
  END;
$$ LANGUAGE sql IMMUTABLE;

-- (3) SEALED AT CONSUMPTION, which is where the authority is actually spent.
--
-- The service checks the reviewed state against what is true NOW; the database cannot, because by
-- COMMIT the act has already moved the claim on (a certification leaves the bill `certified`, not
-- `verified`). So the durable rule is the one thing that IS invariant: the state a grant records
-- must be one its rule can legitimately be exercised from. A grant recorded at `submitted` can
-- never certify anything, whatever else is true.
--
-- ONE trigger for BOTH consumption arms deliberately. Task 6A added `consumedByApprovalId` and had
-- to write a SECOND seal because 5B's was guarded on the certificate arm — the sibling-not-updated
-- shape again. This is placed on the transition every arm passes through, so a third target would
-- inherit it rather than need a third copy.
CREATE OR REPLACE FUNCTION phase5_t7biiih_grant_reviewed_state_sealed() RETURNS trigger AS $$
BEGIN
  IF NEW."consumedAt" IS NULL THEN RETURN NULL; END IF;

  -- A grant written before this column existed records NO evidence of what its approver saw. That
  -- is not the same as recording something harmless: the register's whole purpose is attributable
  -- human authorisation, and inferring a reviewed state would be putting words in an approver's
  -- mouth. Unusable is the safe direction, and the migration's diagnostic stops the deploy on any
  -- LIVE legacy grant so nobody discovers this at the moment they try to certify.
  --
  -- BOTH halves of the evidence, because half of it attests to nothing: the status says what the
  -- claim read and the lifecycle version says WHICH passage through that reading it was, and a
  -- label without the counter is exactly the recycling hole `certified → paid → certified` opens.
  IF NEW."reviewedStatus" IS NULL OR NEW."reviewedLifecycleVersion" IS NULL THEN
    RAISE EXCEPTION 'Grant % records no reviewed state, so nothing attests to what its approver was looking at — an authority without that evidence is a permission slip, not a justification; a pmc with standing must issue it again against the claim as it stands', NEW."id";
  END IF;

  IF NOT (NEW."reviewedStatus" = ANY (phase5_t7biiih_admissible_reviewed_states(NEW."rule"))) THEN
    RAISE EXCEPTION 'Grant % was authorised over a claim reading %, a state no `%` authority can be spent from — the claim version does not change as it moves through its lifecycle, so a version pin does not say WHAT was reviewed; it needs authorising again against the state that holds now', NEW."id", NEW."reviewedStatus", NEW."rule";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SodGrant_reviewed_state_sealed" ON "SodGrant";
CREATE CONSTRAINT TRIGGER "SodGrant_reviewed_state_sealed"
  AFTER INSERT OR UPDATE ON "SodGrant" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t7biiih_grant_reviewed_state_sealed();
