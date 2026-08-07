-- Phase 5 Task 6B-i — §F's DERIVED payment status.
--
-- NO new table and NO new column: the three folds this derivation reads all exist already
-- (`NET_PAYABLE` from Task 5C, `APPROVED`/`PAID` from Task 6A). What was missing is permission to
-- STORE the answer. Task 6A sealed the lifecycle at `certified` deliberately and said so in the
-- refusal it raised -- the arrows past it belong to the task that produces their evidence, which is
-- this one.
--
-- Three guards encoded "past certification" as `= 'certified'`, which was exact only while
-- `certified` was the last status a bill could hold. They are widened TOGETHER, against one shared
-- predicate, rather than one at a time as each failure surfaced.
--
-- Everything else in both functions is carried forward VERBATIM.

-- ONE definition of §F's derived family, in SQL, mirroring `isDerivedBillStatus` in
-- `commercial-status.ts`. Three separate guards below encode "past certification"; before this
-- they each spelled it `= 'certified'`, which was true only while `certified` was the LAST status a
-- bill could hold. Widening them one at a time would have left the next reader to find the third.
CREATE OR REPLACE FUNCTION phase5_t6b_derived_bill_status(p_status text)
RETURNS boolean AS $$
  SELECT p_status IN ('certified', 'approved-for-payment', 'part-paid', 'paid');
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION phase5_t5_certificate_projection_check(p_project text, p_bill text)
RETURNS void AS $$
DECLARE
  v_live   bigint;
  v_status text;
BEGIN
  SELECT b."status" INTO v_status FROM "VendorBill" b
   WHERE b."projectId" = p_project AND b."id" = p_bill;
  -- the bill is gone: nothing to be coherent WITH, and `VendorBill` rows are never deleted anyway
  IF v_status IS NULL THEN RETURN; END IF;

  SELECT COUNT(*) INTO v_live FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."billId" = p_bill AND c."supersededAt" IS NULL;

  -- Task 6B-i — the projection is of the FAMILY. Every derived status (`certified`,
  -- `approved-for-payment`, `part-paid`, `paid`) is a post-certification state and presupposes
  -- exactly one live certificate; an approved or part-paid bill standing on a live certificate is
  -- as coherent as a certified one, and before this it was refused.
  IF phase5_t6b_derived_bill_status(v_status) AND v_live <> 1 THEN
    RAISE EXCEPTION 'Bill % is `%` with % live certificate(s) — a payment status is the certificate''s projection and the two move together', p_bill, v_status, v_live;
  END IF;
  IF NOT phase5_t6b_derived_bill_status(v_status) AND v_live <> 0 THEN
    RAISE EXCEPTION 'Bill % is `%` while a LIVE certificate still stands — superseding a certificate must return the claim to `verified` in the SAME transaction', p_bill, v_status;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t4_bill_lifecycle() RETURNS trigger AS $$
DECLARE v_cert bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'VendorBill rows are never deleted — a claim that was made is history (%)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."vendorId" <> OLD."vendorId"
     OR NEW."vendorBillNumber" <> OLD."vendorBillNumber" OR NEW."documentDate" <> OLD."documentDate"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById"
     OR NEW."sourceCommandId" <> OLD."sourceCommandId" THEN
    RAISE EXCEPTION 'A vendor bill''s identity is FROZEN — the document number and date are the duplicate-claim key (%)', OLD."id";
  END IF;
  IF NEW."statusReason" IS DISTINCT FROM OLD."statusReason"
     AND (NEW."status" IS NOT DISTINCT FROM OLD."status" OR NEW."status" NOT IN ('disputed', 'rejected')) THEN
    RAISE EXCEPTION 'A vendor bill''s exit reason is FROZEN — it explains the transition that set it, and a rewritable justification is no justification (%)', OLD."id";
  END IF;
  IF NEW."statusChangedAt" IS DISTINCT FROM OLD."statusChangedAt"
     AND NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'A vendor bill''s status timestamp is FROZEN outside its transition — it records WHEN the claim moved (%)', OLD."id";
  END IF;
  IF NEW."status" = 'disputed' AND OLD."status" IS DISTINCT FROM 'disputed' THEN
    NEW."disputedAtVersion" := (
      SELECT v."version" FROM "VendorBillVersion" v
       WHERE v."projectId" = NEW."projectId" AND v."billId" = NEW."id" AND v."supersededAt" IS NULL
    );
    NEW."disputeReason" := NEW."statusReason";
  ELSE
    NEW."disputedAtVersion" := OLD."disputedAtVersion";
    NEW."disputeReason" := OLD."disputeReason";
  END IF;
  IF NEW."status" = 'resolved' AND OLD."status" IS DISTINCT FROM 'resolved' THEN
    IF OLD."disputedAtVersion" IS NULL OR NOT EXISTS (
      SELECT 1 FROM "VendorBillVersion" v
       WHERE v."projectId" = NEW."projectId" AND v."billId" = NEW."id"
         AND v."supersededAt" IS NULL AND v."supersedesVersion" = OLD."disputedAtVersion"
    ) THEN
      RAISE EXCEPTION 'A disputed claim is resolved by AMENDING it — version % must be superseded by a corrected version, and a resolution with no correction behind it would release the document number for a claim nobody fixed (%)', COALESCE(OLD."disputedAtVersion"::text, '?'), OLD."id";
    END IF;
    PERFORM phase5_t4_resolution_bound_check(NEW."projectId", NEW."id");
  END IF;
  -- Codex round-1 F2 — `verified` is the SHADOW of a verdict, not a status a writer may assert.
  -- The verdict must be a MATCH and must have been computed over the claim version that is live
  -- right now: a verdict over a superseded version says nothing about the claim being verified.
  IF NEW."status" = 'verified' AND OLD."status" IS DISTINCT FROM 'verified' THEN
    -- Codex round-3 — the verdict must be PROVABLY the service's, not merely present. The first
    -- head checked that some `matched` row existed, which a maintenance path could satisfy by
    -- inserting one: fake the verdict, then flip the status, and the §E check the arrow exists to
    -- enforce is bypassed with two statements.
    --
    -- The seal is PROVENANCE, not a re-derivation. Re-deriving the rate, tax, freight and duplicate
    -- checks here would restate §E in a second language, and §0 is explicit that restating a rule at
    -- a second site is the drift that produces findings — the two copies disagree the first time
    -- either changes. Instead the row must have been produced BY the command that computes the
    -- verdict, which is the four-FK provenance shape Task 2 established for proving a PO line's
    -- terms came from the approved comparison. `sourceCommandId` is already an FK to
    -- `CommandExecution`; this adds the requirement that the command be a SUCCEEDED
    -- `commercial.bill.verify` for this same project.
    IF NOT EXISTS (
      SELECT 1 FROM "BillVerification" bv
       JOIN "CommandExecution" ce
         ON ce."projectId" = bv."projectId" AND ce."id" = bv."sourceCommandId"
       WHERE bv."projectId" = NEW."projectId" AND bv."billId" = NEW."id"
         AND bv."verdict" = 'matched'
         -- NOT `ce."status" = 'succeeded'`, and NOT `ce."resultRef" = bv."id"`: this trigger fires
         -- DURING the verify command, while its own ledger row is still `reserved` and its result
         -- has not been written, so either clause is unsatisfiable HERE by construction — the
         -- first head of this seal carried the status clause and refused every honest
         -- verification. What can be checked at this instant is the command's TYPE. What cannot
         -- is checked at COMMIT instead, by `VendorBill_verified_provenance` below, which is where
         -- the ledger row is complete. The two halves are one rule split by WHEN it is knowable,
         -- not a weaker check and a stronger one.
         AND ce."commandType" = 'commercial.bill.verify'
         AND bv."versionId" = (
           SELECT v."id" FROM "VendorBillVersion" v
            WHERE v."projectId" = NEW."projectId" AND v."billId" = NEW."id" AND v."supersededAt" IS NULL
         )
    ) THEN
      RAISE EXCEPTION 'A bill is `verified` because a MATCHED §E verdict produced by `commercial.bill.verify` stands over its CURRENT claim version, not because a status says so (%)', OLD."id";
    END IF;
  END IF;
  -- Codex round-4 — `verified -> submitted` is the AMENDMENT arrow, and round 1 opened it without
  -- requiring the amendment. `CommercialBillService.amend` supersedes the verified version and
  -- writes its replacement BEFORE the CAS, so the honest path satisfies this; a bare status flip
  -- does not, and that is the whole difference. Left unguarded, one UPDATE re-opens a verified
  -- claim for re-verification with no new claim behind it — the same "a status is not a fact"
  -- defect the `verified` arrow itself was found for, one arrow along.
  --
  -- The rule names the version the verdict was about, not merely "some superseded version": the
  -- live version must supersede the version whose MATCHED verdict made this bill `verified`.
  IF OLD."status" = 'verified' AND NEW."status" = 'submitted' THEN
    IF NOT EXISTS (
      SELECT 1
        FROM "VendorBillVersion" live
        JOIN "VendorBillVersion" prev
          ON prev."projectId" = live."projectId" AND prev."billId" = live."billId"
         AND prev."version"   = live."supersedesVersion"
        JOIN "BillVerification" bv
          ON bv."projectId" = prev."projectId" AND bv."versionId" = prev."id"
       WHERE live."projectId" = NEW."projectId" AND live."billId" = NEW."id"
         AND live."supersededAt" IS NULL
         AND bv."verdict" = 'matched'
    ) THEN
      RAISE EXCEPTION 'A verified claim returns to `submitted` only by being AMENDED — the live version must supersede the version whose matched verdict made it `verified`, and a status flip with no replacement claim behind it re-opens verification over the claim that was already verified (%)', OLD."id";
    END IF;
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (
      (OLD."status" = 'draft'              AND NEW."status" IN ('submitted', 'disputed', 'rejected'))
      OR (OLD."status" = 'submitted'          AND NEW."status" IN ('under-verification', 'disputed', 'rejected'))
      -- Task 5A — the §E verdict is the evidence that makes THIS arrow safe, and it is the only
      -- one this increment opens.
      OR (OLD."status" = 'under-verification' AND NEW."status" IN ('verified', 'disputed', 'rejected'))
      -- §E/§F — a claim is LIVE from the moment it is submitted, so evidence withdrawn under a
      -- VERIFIED claim must have somewhere to put it. Rejection stops at `verified` because §0
      -- drops a rejected bill from every billed set.
      -- Codex round-1 F3 — `CommercialBillService.amend` has ALWAYS admitted `verified` and CASes
      -- `verified -> submitted` so the replacement claim is re-checked from the start. That path was
      -- unreachable while `verified` was, and opening the state without opening the arrow the
      -- existing service already takes from it would fail every amendment of a verified claim at
      -- the trigger. The recheck is guarded by construction: `submitted` re-runs §G bounds 1–2 on
      -- submission and must be verified again before it can advance.
      -- Task 5B adds `certified` to this row and does NOT disturb the rest of it: `submitted` is
      -- round-1 F3's amendment arrow (guarded above) and `disputed` is §E's withdrawal arrow.
      OR (OLD."status" = 'verified'           AND NEW."status" IN ('submitted', 'certified', 'disputed', 'rejected'))
      -- …and back, on SUPERSESSION — §F's ONE correction path past certification. It never goes
      -- further back: rejection stops at `verified`, because §0 drops a rejected bill from every
      -- billed set and that would free accepted quantity a certificate still stands on.
      -- Task 6B-i — supersession leaves the family from WHEREVER it currently sits. The correction
      -- path is legal from any derived status that carries no cash (the service refuses one that
      -- does, per §0), and pinning this arrow to `certified` would refuse to correct an
      -- approved-but-unpaid claim for a reason that is not true of it.
      OR (phase5_t6b_derived_bill_status(OLD."status") AND NEW."status" = 'verified')
      -- Task 6B-i — §F's DERIVED payment statuses, opened as a FAMILY rather than as a list of
      -- arrows. Past certification the status is not written by hand: it is a function of
      -- NET_PAYABLE, APPROVED and PAID, re-derived at every writer that can move any of the three.
      -- Enumerating the arrows here would put a SECOND copy of §F's truth table in SQL, free to
      -- disagree with `derivedBillStatus` the first time either changed, and a row trigger cannot
      -- cheaply recompute the folds to check WHICH member is right.
      --
      -- So the two questions split by who can answer them: the DATABASE guards the family (nothing
      -- escapes back into the forward lifecycle except supersession, nothing jumps in except
      -- `verified -> certified`), and the DERIVATION owns which member is correct.
      --
      -- Closed under BOTH directions, because the derivation is not monotonic: a retention release
      -- RAISES NET_PAYABLE, so `paid -> certified` is a required move rather than a corruption.
      OR (phase5_t6b_derived_bill_status(OLD."status")
          AND phase5_t6b_derived_bill_status(NEW."status"))
      OR (OLD."status" = 'disputed'           AND NEW."status" IN ('resolved', 'rejected'))
    ) THEN
      RAISE EXCEPTION 'A vendor bill cannot move from % to % — a resolved or rejected claim is terminal, a disputed one is corrected by a NEW version, and the payment statuses form a closed family the §F derivation owns (%)', OLD."status", NEW."status", OLD."id";
    END IF;
  END IF;
  -- Task 5B — `certified` is the SHADOW of a CERTIFICATE, exactly as `verified` above is the
  -- shadow of a verdict. Without this, maintenance SQL could mark a bill certified with no
  -- certificate behind it, and §G bounds 3-5 would read a payable of zero while the status says
  -- money is authorised. The certificate is the fact; the status is its projection.
  --
  -- No provenance clause is needed beside it, and the asymmetry with `verified` is deliberate: a
  -- verdict is DERIVED, so a hand-written one is indistinguishable from a computed one unless the
  -- producing command is checked. A certificate is not derived — it IS the fact, sealed
  -- append-only with its own §G bound checked at COMMIT and its evidence frozen by composite FK.
  -- Requiring a command type here would check the weaker of the two things already checked.
  --
  -- It is checked AFTER the transition table, and the order is the point: an ILLEGAL arrow must be
  -- reported as an illegal arrow. `under-verification -> certified` is not a transition at all, and
  -- answering it with "no live certificate exists" would send a reader hunting for a certificate
  -- when the real answer is that the claim has not been verified yet. The coarser question is
  -- answered first — the same reasoning that puts the certificate refusal ahead of the dispute in
  -- the withdrawal guards.
  -- Task 6B-i — ENTERING the family, from anywhere outside it, is what requires the certificate.
  -- Spelled `= 'certified'` this fired only on the first arrow in; a bill moving certified ->
  -- approved-for-payment was silently exempt from the check that the certificate still stands.
  IF phase5_t6b_derived_bill_status(NEW."status")
     AND NOT phase5_t6b_derived_bill_status(OLD."status") THEN
    SELECT COUNT(*) INTO v_cert FROM "BillCertificate" c
     WHERE c."projectId" = NEW."projectId" AND c."billId" = NEW."id" AND c."supersededAt" IS NULL;
    IF v_cert <> 1 THEN
      RAISE EXCEPTION 'A bill enters the payment lifecycle because a LIVE certificate exists for it, not because a status says so — found % (%)', v_cert, OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
