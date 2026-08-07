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

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- Codex round 1 — the family was a PROXY for the derivation
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- The first head of this migration guarded MEMBERSHIP and left the MEMBER to the service, and the
-- comment above justified it: enumerating §F's arrows in SQL would put a second copy of the truth
-- table here, free to disagree. That reasoning was wrong in the way this module keeps being found
-- for. The choice was never "one copy or two" — `phase5_t6b_derived_bill_status` above is already a
-- second copy of the FAMILY. The choice was WHICH question the database is allowed to answer, and
-- answering only the coarse one leaves the fine one enforced nowhere:
--
--   UPDATE "VendorBill" SET "status"='paid' WHERE ...   -- on a bill with APPROVED = PAID = 0
--
-- passes membership, commits, and every read surface then reports an unpaid bill as paid until some
-- unrelated command happens to re-derive it. That is the stored-status-versus-fold defect §F exists
-- to prevent, reachable with one statement.
--
-- The same gap has a second mouth (Codex finding 4, the same root reaching the other side): a direct
-- writer can append a VALID `PaymentApproval` — satisfying every 6A seal — and simply not move the
-- status. The folds derive `approved-for-payment`, the column still says `certified`, and nothing
-- refuses it. A fix that sealed only `VendorBill` would close the first mouth and leave the second,
-- so the seal is fired from the bill AND from every table that can make the equation false.

-- §F's truth table, in SQL, mirroring `derivedBillStatus` in `commercial-status.ts` arm for arm and
-- in the same first-match order. The three folds are computed exactly as
-- `CommercialDeductionQuery.foldsFor` computes them: `NET_PAYABLE` is the LIVE certificate less its
-- unreleased withholdings (zero when no certificate stands), `APPROVED` counts approvals on the LIVE
-- certificate only, and `PAID` is bill-scoped Σ payments — the asymmetry is §0's, because an
-- authority dies with its certificate and cash that has left does not.
CREATE OR REPLACE FUNCTION phase5_t6b_derive_bill_status(p_project text, p_bill text)
RETURNS text AS $$
DECLARE
  v_cert     text;
  v_net      numeric := 0;
  v_approved numeric := 0;
  v_paid     numeric := 0;
BEGIN
  SELECT c."id",
         c."certifiedAmount"
           - COALESCE((SELECT SUM(d."amount") FROM "BillDeduction" d
                        WHERE d."projectId" = c."projectId" AND d."certificateId" = c."id"), 0)
           + COALESCE((SELECT SUM(r."amount") FROM "BillDeductionRelease" r
                         JOIN "BillDeduction" d2
                           ON d2."projectId" = r."projectId" AND d2."id" = r."deductionId"
                        WHERE d2."projectId" = c."projectId" AND d2."certificateId" = c."id"), 0)
    INTO v_cert, v_net
    FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."billId" = p_bill AND c."supersededAt" IS NULL;
  -- no live certificate: nothing is payable, which is the value the first arm needs
  IF v_cert IS NULL THEN v_net := 0; END IF;

  SELECT COALESCE(SUM(a."amount"), 0) INTO v_approved
    FROM "PaymentApproval" a
    JOIN "BillCertificate" c ON c."projectId" = a."projectId" AND c."id" = a."certificateId"
   WHERE a."projectId" = p_project AND a."billId" = p_bill AND c."supersededAt" IS NULL;

  SELECT COALESCE(SUM(p."amount"), 0) INTO v_paid
    FROM "Payment" p
   WHERE p."projectId" = p_project AND p."billId" = p_bill;

  -- first match wins, exactly as the TypeScript does
  IF v_net = v_paid THEN RETURN 'paid'; END IF;
  IF v_approved = 0 THEN RETURN 'certified'; END IF;
  IF v_paid = v_approved AND v_approved < v_net THEN RETURN 'certified'; END IF;
  IF v_paid = 0 THEN RETURN 'approved-for-payment'; END IF;
  RETURN 'part-paid';
END;
$$ LANGUAGE plpgsql STABLE;

-- The seal: a bill INSIDE the family must hold the status its own folds derive. A bill outside it
-- is not derived at all (§F's forward lifecycle, which no fold can move), so the check returns.
--
-- `FOR UPDATE` before reading, for the same reason §G bound 5 takes it: two sessions each appending
-- a fold row would otherwise both compute a derivation that was true when they read and false when
-- they committed. The lock is on the bill, which is §0b's FIRST row, so this adds no new lock order.
CREATE OR REPLACE FUNCTION phase5_t6b_status_coherent(p_project text, p_bill text)
RETURNS void AS $$
DECLARE
  v_status  text;
  v_derived text;
BEGIN
  SELECT b."status" INTO v_status FROM "VendorBill" b
   WHERE b."projectId" = p_project AND b."id" = p_bill
     FOR UPDATE;
  IF v_status IS NULL THEN RETURN; END IF;
  IF NOT phase5_t6b_derived_bill_status(v_status) THEN RETURN; END IF;

  v_derived := phase5_t6b_derive_bill_status(p_project, p_bill);
  IF v_status <> v_derived THEN
    RAISE EXCEPTION 'Bill % is stored as `%` but its own folds derive `%` — past certification the status is a FUNCTION of NET_PAYABLE, APPROVED and PAID, not a value a writer chooses; move the money and let the derivation follow it', p_bill, v_status, v_derived;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t6b_bill_status_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t6b_status_coherent(NEW."projectId", NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t6b_fold_status_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t6b_status_coherent(NEW."projectId", NEW."billId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- `BillDeduction`/`BillDeductionRelease` reach the bill through the certificate, so they get their
-- own resolver rather than a `billId` column this task has no business adding.
CREATE OR REPLACE FUNCTION phase5_t6b_deduction_status_sealed() RETURNS trigger AS $$
DECLARE v_bill text;
BEGIN
  SELECT c."billId" INTO v_bill FROM "BillCertificate" c
   WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."certificateId";
  IF v_bill IS NOT NULL THEN PERFORM phase5_t6b_status_coherent(NEW."projectId", v_bill); END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t6b_release_status_sealed() RETURNS trigger AS $$
DECLARE v_bill text;
BEGIN
  SELECT c."billId" INTO v_bill
    FROM "BillDeduction" d
    JOIN "BillCertificate" c ON c."projectId" = d."projectId" AND c."id" = d."certificateId"
   WHERE d."projectId" = NEW."projectId" AND d."id" = NEW."deductionId";
  IF v_bill IS NOT NULL THEN PERFORM phase5_t6b_status_coherent(NEW."projectId", v_bill); END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- ── the BACKFILL, before the seal that would refuse the state it corrects (Codex finding 2) ──────
--
-- On an upgrade from the 6A schema a bill can already carry live approvals and payments while its
-- status is still `certified`: that was the CORRECT value under 6A's rule, and 6A's own PROBE 9
-- pinned it deliberately. Installing the derivation without moving those rows would leave every
-- read surface reporting a paid bill as certified until some later command happened to touch it —
-- and with the seal above installed, the next honest write to such a bill would be REFUSED for a
-- state it did not create. So the backfill is not a courtesy; it is what makes the seal installable.
--
-- It INVENTS NOTHING. Every value comes from rows that already exist, through the same function the
-- runtime uses, and the WHERE clause is the fixpoint condition — re-running it is a no-op, so this
-- is idempotent whether it runs once or after a partially-applied deploy.
--
-- `statusChangedAt` moves with the status because the lifecycle trigger requires it to (a timestamp
-- frozen outside its transition is one of this table's seals). That records when the STORED VALUE
-- changed, which is now, not when the money moved — the money's own timestamps are on the
-- append-only approval and payment rows, where they have always been, and are not touched here.
DO $$
DECLARE v_moved bigint;
BEGIN
  WITH corrected AS (
    UPDATE "VendorBill" b
       SET "status" = phase5_t6b_derive_bill_status(b."projectId", b."id"),
           "statusChangedAt" = now()
     WHERE phase5_t6b_derived_bill_status(b."status")
       AND b."status" <> phase5_t6b_derive_bill_status(b."projectId", b."id")
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_moved FROM corrected;
  RAISE NOTICE 'phase5_t6b backfill: % bill(s) moved to the status their folds derive', v_moved;
END $$;

DROP TRIGGER IF EXISTS "VendorBill_t6b_status_sealed" ON "VendorBill";
CREATE CONSTRAINT TRIGGER "VendorBill_t6b_status_sealed"
  AFTER INSERT OR UPDATE ON "VendorBill" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6b_bill_status_sealed();

DROP TRIGGER IF EXISTS "PaymentApproval_t6b_status_sealed" ON "PaymentApproval";
CREATE CONSTRAINT TRIGGER "PaymentApproval_t6b_status_sealed"
  AFTER INSERT OR UPDATE ON "PaymentApproval" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6b_fold_status_sealed();

DROP TRIGGER IF EXISTS "Payment_t6b_status_sealed" ON "Payment";
CREATE CONSTRAINT TRIGGER "Payment_t6b_status_sealed"
  AFTER INSERT OR UPDATE ON "Payment" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6b_fold_status_sealed();

DROP TRIGGER IF EXISTS "BillDeduction_t6b_status_sealed" ON "BillDeduction";
CREATE CONSTRAINT TRIGGER "BillDeduction_t6b_status_sealed"
  AFTER INSERT OR UPDATE ON "BillDeduction" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6b_deduction_status_sealed();

DROP TRIGGER IF EXISTS "BillDeductionRelease_t6b_status_sealed" ON "BillDeductionRelease";
CREATE CONSTRAINT TRIGGER "BillDeductionRelease_t6b_status_sealed"
  AFTER INSERT OR UPDATE ON "BillDeductionRelease" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t6b_release_status_sealed();
