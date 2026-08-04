-- Phase 5 Task 5C (§H) — THE DEDUCTION LEDGER: retention, penalties, and their releases.
--
-- §H's shape in one sentence: a deduction is a LEDGER ROW against a certification, never a column
-- on it, and the retained balance is a FOLD over deductions minus releases with NO stored balance
-- column — the Phase-3 §C rule that produced a correct stock model.
--
-- Three seals in this file are WIDENINGS of rules Task 5B unit A sealed, not new rules, and each
-- says so at its site. Unit A wrote them when `certified` was the terminal status of a claim, which
-- it was at that tree. §F's derivation table — cleared with the plan — makes `certified` one of
-- five derived statuses, and the first arm it evaluates is `NET_PAYABLE = PAID`. Withholding the
-- whole of a certificate therefore settles the bill, and the unwidened seals would refuse the very
-- first deduction that did so. The invariant is unchanged: a LIVE certificate stands if and only if
-- the bill is PAST certification. Only the set of statuses that means has grown.

-- ── the two ledger tables ────────────────────────────────────────────────────────────────────

CREATE TABLE "BillDeduction" (
  "id"              TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "certificateId"   TEXT NOT NULL,
  "billId"          TEXT NOT NULL,
  "type"            TEXT NOT NULL,
  "amount"          DECIMAL(18,2) NOT NULL,
  "reason"          TEXT,
  "recordedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "recordedById"    TEXT NOT NULL,
  "sourceCommandId" TEXT NOT NULL,
  CONSTRAINT "BillDeduction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BillDeductionRelease" (
  "id"              TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "deductionId"     TEXT NOT NULL,
  "amount"          DECIMAL(18,2) NOT NULL,
  "reason"          TEXT NOT NULL,
  "releasedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedById"    TEXT NOT NULL,
  "sourceCommandId" TEXT NOT NULL,
  CONSTRAINT "BillDeductionRelease_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BillDeduction_projectId_id_key" ON "BillDeduction"("projectId", "id");
CREATE INDEX "BillDeduction_projectId_certificateId_idx" ON "BillDeduction"("projectId", "certificateId");
CREATE INDEX "BillDeduction_projectId_billId_idx" ON "BillDeduction"("projectId", "billId");
CREATE UNIQUE INDEX "BillDeductionRelease_projectId_id_key" ON "BillDeductionRelease"("projectId", "id");
CREATE INDEX "BillDeductionRelease_projectId_deductionId_idx" ON "BillDeductionRelease"("projectId", "deductionId");

ALTER TABLE "BillDeduction"
  ADD CONSTRAINT "BillDeduction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- the certificate AND the bill in ONE reference: `(projectId, certificateId, billId)` against the
  -- certificate's own candidate key, so the denormalized `billId` cannot name a different claim
  -- than the certificate it withholds from. A plain two-column FK plus a loose `billId` would let a
  -- deduction be folded into a bill whose certificate it does not belong to.
  ADD CONSTRAINT "BillDeduction_certificate_fkey" FOREIGN KEY ("projectId", "certificateId", "billId")
    REFERENCES "BillCertificate"("projectId", "id", "billId") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "BillDeduction_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "BillDeduction_command_fkey" FOREIGN KEY ("projectId", "sourceCommandId")
    REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "BillDeductionRelease"
  ADD CONSTRAINT "BillDeductionRelease_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "BillDeductionRelease_deduction_fkey" FOREIGN KEY ("projectId", "deductionId")
    REFERENCES "BillDeduction"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "BillDeductionRelease_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "BillDeductionRelease_command_fkey" FOREIGN KEY ("projectId", "sourceCommandId")
    REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- §H — the type set this task ships. `advance-recovery` is deliberately absent: it folds against an
-- `advance` row created when the advance is PAID, so the enum member arrives in Task 6 with the row
-- that caps it. §0b's "every declared member is in the fold" then holds at BOTH stages rather than
-- being briefly false.
ALTER TABLE "BillDeduction"
  ADD CONSTRAINT "BillDeduction_type_known" CHECK ("type" IN ('retention', 'penalty', 'other'));

-- §0b's sign constraint, at its third site. The row TYPE carries direction — a withholding is this
-- row and a release is its own — so a negative amount encodes direction twice and the two encodings
-- disagree: a -10 retention makes `NET_PAYABLE = CERTIFIED - (-10)` raise a ₹100 certificate to
-- ₹110, a deduction that PAYS OUT more, sealed append-only so it cannot be corrected in place.
ALTER TABLE "BillDeduction"
  ADD CONSTRAINT "BillDeduction_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "BillDeductionRelease"
  ADD CONSTRAINT "BillDeductionRelease_amount_positive" CHECK ("amount" > 0);

-- the complete non-blank discipline (Phase-4 Task 5, after `btrim` alone let whitespace through).
-- Presence is not justification: a `penalty` reasoned `'   '` satisfies every other stated check and
-- leaves append-only evidence nobody can act on.
ALTER TABLE "BillDeduction"
  ADD CONSTRAINT "BillDeduction_reason_nonblank" CHECK ("reason" IS NULL OR btrim("reason", E' \t\n\x0B\f\r') <> ''),
  ADD CONSTRAINT "BillDeduction_reason_required" CHECK (
    "type" NOT IN ('other', 'penalty') OR ("reason" IS NOT NULL AND btrim("reason", E' \t\n\x0B\f\r') <> '')
  );
ALTER TABLE "BillDeductionRelease"
  ADD CONSTRAINT "BillDeductionRelease_reason_nonblank" CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '');

-- ── append-only, exactly like certificates, approvals and payments (§F/§H) ────────────────────
-- They determine `NET_PAYABLE` directly, so a row that could be updated or deleted is a withholding
-- that never withheld anything. A correction is a release row, never an edit.

CREATE OR REPLACE FUNCTION phase5_t5c_deduction_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A deduction is APPEND-ONLY — deleting one raises the payable with no attributable release behind it (%)', OLD."id";
  END IF;
  RAISE EXCEPTION 'A deduction is APPEND-ONLY — a withholding that can be edited never withheld anything; correct it with a RELEASE row (%)', OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5c_release_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A deduction release is APPEND-ONLY — deleting one re-withholds money somebody attributably released (%)', OLD."id";
  END IF;
  RAISE EXCEPTION 'A deduction release is APPEND-ONLY — it is the correction path itself, so it has none of its own (%)', OLD."id";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillDeduction_append_only" ON "BillDeduction";
CREATE TRIGGER "BillDeduction_append_only" BEFORE UPDATE OR DELETE ON "BillDeduction"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_deduction_append_only();
DROP TRIGGER IF EXISTS "BillDeductionRelease_append_only" ON "BillDeductionRelease";
CREATE TRIGGER "BillDeductionRelease_append_only" BEFORE UPDATE OR DELETE ON "BillDeductionRelease"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_release_append_only();

-- ── §H's two bounds, sealed at COMMIT ────────────────────────────────────────────────────────
--
-- The service re-derives both under the bill lock and refuses with a sentence naming the remaining
-- balance; these are the backstop for whatever route bypassed the service. Same shape as every §G
-- bound in this phase.

-- BOUND 1 — `NET_PAYABLE` has a FLOOR OF ZERO, and the guard is on the DEDUCTION.
--
-- §H is explicit about why it cannot live on the approval instead: positive rows and §G bound 4
-- together still admit a ₹150 penalty against a ₹100 certificate. Every row is positive, so the
-- CHECKs pass; bound 4 only stops a later APPROVAL from exceeding `NET_PAYABLE`, which a negative
-- number satisfies trivially; and −₹50 then flows into §F's status derivation and §J's
-- `certified-payable` bucket as negative payable money. Phase 5 models a deduction as a WITHHOLDING
-- against a payable — not a receivable or a credit note — so there is nothing beyond the
-- certificate to withhold FROM. Recovering more is a matter for the NEXT certificate, where the
-- money to withhold exists.
CREATE OR REPLACE FUNCTION phase5_t5c_withholding_bound_check(p_project text, p_certificate text)
RETURNS void AS $$
DECLARE
  v_certified numeric;
  v_withheld  numeric;
  v_live      timestamp;
BEGIN
  SELECT c."certifiedAmount", c."supersededAt" INTO v_certified, v_live
    FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."id" = p_certificate;
  -- a SUPERSEDED certificate's deductions leave every fold with it, so there is no bound to hold
  IF v_certified IS NULL OR v_live IS NOT NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(d."amount"), 0) - COALESCE((
           SELECT SUM(r."amount") FROM "BillDeductionRelease" r
            JOIN "BillDeduction" d2 ON d2."projectId" = r."projectId" AND d2."id" = r."deductionId"
            WHERE d2."projectId" = p_project AND d2."certificateId" = p_certificate
         ), 0)
    INTO v_withheld
    FROM "BillDeduction" d
   WHERE d."projectId" = p_project AND d."certificateId" = p_certificate;

  IF v_withheld > v_certified THEN
    RAISE EXCEPTION 'Unreleased deductions of % exceed the % this certificate certified — a withholding is taken FROM a payable, and there is nothing beyond the certificate to withhold from; recover the remainder against the NEXT certificate (%)', v_withheld, v_certified, p_certificate;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- BOUND 2 — a release may not exceed the unreleased balance of ITS OWN deduction. Releasing more
-- than was withheld pays out money no certificate ever authorised, and the rows are append-only, so
-- an over-release cannot be walked back.
CREATE OR REPLACE FUNCTION phase5_t5c_release_bound_check(p_project text, p_deduction text)
RETURNS void AS $$
DECLARE
  v_amount   numeric;
  v_released numeric;
BEGIN
  SELECT d."amount" INTO v_amount FROM "BillDeduction" d
   WHERE d."projectId" = p_project AND d."id" = p_deduction;
  IF v_amount IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(r."amount"), 0) INTO v_released FROM "BillDeductionRelease" r
   WHERE r."projectId" = p_project AND r."deductionId" = p_deduction;

  IF v_released > v_amount THEN
    RAISE EXCEPTION 'Releases of % exceed the % this deduction withheld — a release gives back money that was held, and it cannot give back more than that (%)', v_released, v_amount, p_deduction;
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5c_deduction_bound_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t5c_withholding_bound_check(NEW."projectId", NEW."certificateId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5c_release_bound_sealed() RETURNS trigger AS $$
DECLARE v_certificate text;
BEGIN
  PERFORM phase5_t5c_release_bound_check(NEW."projectId", NEW."deductionId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- DEFERRED, because a command writes the row and then re-derives: the aggregate only has an answer
-- at COMMIT, and an immediate check would fire mid-statement against a half-written act.
DROP TRIGGER IF EXISTS "BillDeduction_bound_sealed" ON "BillDeduction";
CREATE CONSTRAINT TRIGGER "BillDeduction_bound_sealed"
  AFTER INSERT ON "BillDeduction" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_deduction_bound_sealed();
DROP TRIGGER IF EXISTS "BillDeductionRelease_bound_sealed" ON "BillDeductionRelease";
CREATE CONSTRAINT TRIGGER "BillDeductionRelease_bound_sealed"
  AFTER INSERT ON "BillDeductionRelease" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_release_bound_sealed();

-- ── WIDENING 1: the certificate↔status biconditional ─────────────────────────────────────────
--
-- Unit A sealed "a live certificate exists for a bill IF AND ONLY IF that bill is `certified`".
-- The invariant it protects is unchanged and still enforced in BOTH directions: a supersession may
-- not leave the status behind, and a status flip may not leave the certificate behind. What has
-- changed is which statuses mean "past certification". While `certified` was terminal the two were
-- the same sentence. §F's derivation makes `paid` reachable from `certified` (a fully-withheld
-- certificate has nothing left to pay), so the unwidened predicate would refuse the first deduction
-- that zeroed a payable — not because the data were incoherent, but because the seal named one
-- status where it meant a set.
--
-- `approved-for-payment` and `part-paid` are named here even though Task 6 opens the arrows to
-- them: this predicate answers "is a live certificate legitimate?", and it would be wrong for the
-- moment Task 6 lands and right only until then. The LIFECYCLE table is what gates which arrows
-- exist, and that is left to open them beside their evidence.
CREATE OR REPLACE FUNCTION phase5_t5c_past_certification(p_status text) RETURNS boolean AS $$
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
  IF v_status IS NULL THEN RETURN; END IF;

  SELECT COUNT(*) INTO v_live FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."billId" = p_bill AND c."supersededAt" IS NULL;

  IF phase5_t5c_past_certification(v_status) AND v_live <> 1 THEN
    RAISE EXCEPTION 'Bill % is `%` with % live certificate(s) — a bill past certification stands on exactly one certificate, and the status is its projection', p_bill, v_status, v_live;
  END IF;
  IF NOT phase5_t5c_past_certification(v_status) AND v_live <> 0 THEN
    RAISE EXCEPTION 'Bill % is `%` while a LIVE certificate still stands — superseding a certificate must return the claim to `verified` in the SAME transaction', p_bill, v_status;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ── WIDENING 2: the lifecycle table and the certificate shadow rule ───────────────────────────
--
-- Replaced whole rather than patched, because `CREATE OR REPLACE FUNCTION` has no other form. The
-- body below is Task 5B's verbatim except for the two arrows §H produces and the shadow rule's
-- status set — both marked at their sites.
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
      OR (OLD."status" = 'certified'          AND NEW."status" IN ('verified', 'paid'))
      -- Task 5C (§H/§F) — the arrows the DEDUCTION LEDGER produces, and only those. §F derives the
      -- status from three folds and evaluates `NET_PAYABLE = PAID` FIRST, so withholding the whole
      -- of a certificate settles the bill: nothing remains payable, and a status that cannot say so
      -- strands it forever, because approval and payment rows are STRICTLY POSITIVE (§H) and no
      -- legal row could ever advance it. Releasing that withholding raises `NET_PAYABLE` above zero
      -- again and the derivation returns it to `certified` — `APPROVED = 0`, the second arm.
      --
      -- `approved-for-payment` and `part-paid` are NOT opened here. They need an APPROVAL fact, and
      -- Task 6 opens each arrow beside the row that makes it safe — the discipline this table has
      -- followed since Task 4.
      OR (OLD."status" = 'paid'               AND NEW."status" IN ('certified', 'verified'))
      OR (OLD."status" = 'disputed'           AND NEW."status" IN ('resolved', 'rejected'))
    ) THEN
      RAISE EXCEPTION 'A vendor bill cannot move from % to % — a resolved or rejected claim is terminal, a disputed one is corrected by a NEW version, and the arrows past `certified` belong to the task that produces their evidence (%)', OLD."status", NEW."status", OLD."id";
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
  -- Task 5C widened this from `certified` to the whole POST-CERTIFICATION set. The rule was never
  -- about one status: it is that a bill claiming to be past certification must have the certificate
  -- that put it there. While `certified` was terminal the two were the same sentence; the moment
  -- §F's derivation can move a certified bill to `paid`, checking only `certified` would let a
  -- maintenance UPDATE write `paid` with no certificate behind it — the very hole this guard
  -- exists to close, walked around by one status.
  IF NEW."status" IN ('certified', 'paid') AND OLD."status" NOT IN ('certified', 'paid') THEN
    SELECT COUNT(*) INTO v_cert FROM "BillCertificate" c
     WHERE c."projectId" = NEW."projectId" AND c."billId" = NEW."id" AND c."supersededAt" IS NULL;
    IF v_cert <> 1 THEN
      RAISE EXCEPTION 'A bill is `%` because a LIVE certificate exists for it, not because a status says so — found % (%)', NEW."status", v_cert, OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- ── the migration is ADDITIVE and these tables are NEW, so a legacy database upgrades ROW-FREE ──
-- Asserted rather than assumed (the Phase-4 discipline): if any row exists here the migration is
-- being applied to a database it was not written for, and it stops rather than guessing.
DO $$
DECLARE v_d bigint; v_r bigint;
BEGIN
  SELECT COUNT(*) INTO v_d FROM "BillDeduction";
  SELECT COUNT(*) INTO v_r FROM "BillDeductionRelease";
  IF v_d <> 0 OR v_r <> 0 THEN
    RAISE EXCEPTION 'Phase 5 Task 5C expects to create its ledger EMPTY, found % deduction(s) and % release(s) — this database is not the one this migration was written for', v_d, v_r;
  END IF;
END $$;
