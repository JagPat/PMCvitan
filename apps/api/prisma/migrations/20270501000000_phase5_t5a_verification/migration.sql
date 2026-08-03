-- Phase 5 Task 5A — §E three-way verification: the ONE arrow the verdict makes safe.
--
-- Task 4 stopped the §F transition graph at `under-verification` and said why in as many words:
-- "the STATUSES stay in the CHECK vocabulary because §0's LIVE rule is defined over the whole set;
-- Task 5 adds these arrows WITH the evidence that makes them safe."
--
-- 5A ships the §E verdict, so it opens exactly ONE arrow — `under-verification -> verified` — and
-- not one step further. `certified` stays closed until 5B ships the certificate that is its
-- evidence, and the arrows past it stay closed until Task 6 ships theirs. A status whose evidence
-- does not exist yet is a status nobody can justify.
--
-- No new table, no new column. This migration replaces one trigger function body.
-- ── the VERDICT, recorded (Codex round-1 F2/F5) ────────────────────────────────────────────────
--
-- Two findings, one structure. `verified` was reachable by direct SQL with nothing re-derived, so a
-- 2x over-rate claim could be walked past the §E check entirely (F2); and an idempotency replay
-- recomputed the triple AFTER the first call had already disputed the bill — and §0 excludes a
-- disputed claim from the live fold, so the retry answered `matched` and contradicted the dispute
-- that actually happened (F5).
--
-- Both are the same shape as Task 5B's `certified`: a STATUS IS THE SHADOW OF A FACT. The fact is
-- recorded here, the trigger requires it, and the replay reads it.
CREATE TABLE IF NOT EXISTS "BillVerification" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "exceptions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedById" TEXT NOT NULL,
    "sourceCommandId" TEXT NOT NULL,

    CONSTRAINT "BillVerification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BillVerification_projectId_id_key" ON "BillVerification"("projectId", "id");
-- ONE command produces at most ONE verdict (Codex round-4). Without it, "the row was produced by a
-- verify command" is satisfiable by pointing a second, forged row at a command that already
-- produced its own — the reuse this seal exists to refuse.
CREATE UNIQUE INDEX IF NOT EXISTS "BillVerification_projectId_sourceCommandId_key"
  ON "BillVerification"("projectId", "sourceCommandId");
CREATE INDEX IF NOT EXISTS "BillVerification_projectId_billId_idx" ON "BillVerification"("projectId", "billId");
CREATE INDEX IF NOT EXISTS "BillVerification_projectId_versionId_idx" ON "BillVerification"("projectId", "versionId");

-- The narrower candidate key a verification names, proving the version it verified belongs to the
-- bill it names. `VendorBillVersion`'s Task-4 key is `(projectId, id, billId, vendorIdPin)`, which a
-- verdict has no business restating.
CREATE UNIQUE INDEX IF NOT EXISTS "VendorBillVersion_projectId_id_billId_key"
  ON "VendorBillVersion"("projectId", "id", "billId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillVerification_projectId_fkey') THEN
    ALTER TABLE "BillVerification" ADD CONSTRAINT "BillVerification_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillVerification_bill_fkey') THEN
    ALTER TABLE "BillVerification" ADD CONSTRAINT "BillVerification_bill_fkey" FOREIGN KEY ("projectId", "billId") REFERENCES "VendorBill"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillVerification_version_fkey') THEN
    ALTER TABLE "BillVerification" ADD CONSTRAINT "BillVerification_version_fkey" FOREIGN KEY ("projectId", "versionId", "billId") REFERENCES "VendorBillVersion"("projectId", "id", "billId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillVerification_verifiedById_fkey') THEN
    ALTER TABLE "BillVerification" ADD CONSTRAINT "BillVerification_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillVerification_sourceCommand_fkey') THEN
    ALTER TABLE "BillVerification" ADD CONSTRAINT "BillVerification_sourceCommand_fkey" FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillVerification_verdict_check') THEN
    ALTER TABLE "BillVerification" ADD CONSTRAINT "BillVerification_verdict_check" CHECK ("verdict" IN ('matched', 'exception'));
  END IF;
  -- a MATCH has no exceptions and an EXCEPTION has at least one: a verdict that says both, or
  -- neither, is not a verdict
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillVerification_verdict_shape') THEN
    ALTER TABLE "BillVerification" ADD CONSTRAINT "BillVerification_verdict_shape" CHECK (
      ("verdict" = 'matched' AND cardinality("exceptions") = 0)
      OR ("verdict" = 'exception' AND cardinality("exceptions") > 0)
    );
  END IF;
  -- Codex round-4 — the VOCABULARY, not just the cardinality. `verdict` has carried a CHECK since
  -- the first head while `exceptions` accepted any text at all, so an `exception` verdict could be
  -- recorded as `['looks wrong']` or `['qty-over-acceptedd']` and satisfy every constraint on the
  -- table. §E names six kinds and each names its own check; a seventh string is a defect that
  -- reads as a verdict, and it is the DISPUTE REASON a bill then carries.
  --
  -- `array_position(..., NULL) IS NULL` is not redundant with `<@`: containment involving a NULL
  -- element evaluates to NULL, and a CHECK passes on NULL — so `ARRAY[NULL]` would slip through
  -- the containment test alone.
  --
  -- This list is the SQL half of a set whose other half is `VERIFICATION_EXCEPTION_KINDS` in
  -- `@vitan/shared`. Two hand-kept copies of one vocabulary is the root this PR's convergence
  -- audit names, so it is not left to memory: `phase5-t5a-verification.test.ts` reads this CHECK
  -- back out of `pg_constraint` and fails if the two sets differ in either direction.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillVerification_exception_kinds') THEN
    ALTER TABLE "BillVerification" ADD CONSTRAINT "BillVerification_exception_kinds" CHECK (
      array_position("exceptions", NULL) IS NULL
      AND "exceptions" <@ ARRAY[
        'qty-over-ordered', 'qty-over-accepted', 'rate-mismatch',
        'tax-mismatch', 'freight-mismatch', 'duplicate-claim'
      ]::TEXT[]
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION phase5_t5a_verification_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A verification verdict is never deleted — it is the evidence behind a status (%)', OLD."id";
  END IF;
  RAISE EXCEPTION 'A verification verdict is IMMUTABLE — re-verifying appends a NEW verdict over the current claim version (%)', OLD."id";
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillVerification_append_only" ON "BillVerification";
CREATE TRIGGER "BillVerification_append_only" BEFORE UPDATE OR DELETE ON "BillVerification"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5a_verification_append_only();

-- The migration is ADDITIVE and this table is NEW, so a legacy database upgrades ROW-FREE.
DO $$
DECLARE v_rows bigint;
BEGIN
  SELECT COUNT(*) INTO v_rows FROM "BillVerification";
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'phase5_t5a: expected BillVerification to upgrade row-free, found % row(s)', v_rows;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION phase5_t4_bill_lifecycle() RETURNS trigger AS $$
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
      OR (OLD."status" = 'verified'           AND NEW."status" IN ('submitted', 'disputed', 'rejected'))
      OR (OLD."status" = 'disputed'           AND NEW."status" IN ('resolved', 'rejected'))
    ) THEN
      RAISE EXCEPTION 'A vendor bill cannot move from % to % — a resolved or rejected claim is terminal, a disputed one is corrected by a NEW version, and the arrows past `verified` belong to the task that produces their evidence (%)', OLD."status", NEW."status", OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── the provenance seal's COMMIT half (Codex round-4) ──────────────────────────────────────────
--
-- The round-3 seal asked whether a `commercial.bill.verify` command existed behind the verdict. It
-- did not ask whether THAT command produced THIS verdict — so an old, already-spent verify command
-- id could be copied onto a forged `matched` row and the status flipped past §E exactly as before.
-- The type was provenance-shaped without being provenance.
--
-- The binding is `CommandExecution.resultRef`: `commercial.bill.verify` returns the verification
-- row's id as its result, so `ce."resultRef" = bv."id"` is the ledger stating, in its own row, that
-- this command produced this verdict. It cannot be checked in the BEFORE trigger — the ledger row
-- is still `reserved` while the transition runs — so it is checked at COMMIT, by which point
-- `executeCommand` has written the receipt inside the SAME transaction. `succeeded` joins it here
-- for the same reason: at commit it is knowable, and a verdict whose command never completed is
-- not a verdict anybody produced.
--
-- Deferred means the honest ordering (insert verdict, flip status, write receipt) passes while
-- every ordering that ends with a `verified` bill lacking a complete, exclusively-bound verdict
-- fails the transaction. Paired with the UNIQUE on `(projectId, sourceCommandId)` above, one
-- command yields one verdict and one verdict names the command that made it.
CREATE OR REPLACE FUNCTION phase5_t5a_verified_provenance(p_project text, p_bill text) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "VendorBill" b
     WHERE b."projectId" = p_project AND b."id" = p_bill AND b."status" = 'verified'
  ) THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "BillVerification" bv
     JOIN "CommandExecution" ce
       ON ce."projectId" = bv."projectId" AND ce."id" = bv."sourceCommandId"
     WHERE bv."projectId" = p_project AND bv."billId" = p_bill
       AND bv."verdict" = 'matched'
       AND ce."commandType" = 'commercial.bill.verify'
       AND ce."status" = 'succeeded'
       AND ce."resultRef" = bv."id"
       AND bv."versionId" = (
         SELECT v."id" FROM "VendorBillVersion" v
          WHERE v."projectId" = p_project AND v."billId" = p_bill AND v."supersededAt" IS NULL
       )
  ) THEN
    RAISE EXCEPTION 'A `verified` bill must rest on the verdict its own `commercial.bill.verify` command PRODUCED, over the claim version that is live AT COMMIT — the succeeded ledger row must name this verification as its result (%)', p_bill;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Codex round-5 — the predicate above is fired from BOTH tables that can falsify it.
--
-- The round-4 seal hung on `VendorBill` alone, which asks the question only when the STATUS moves.
-- But the predicate names the LIVE VERSION, and the live version moves from the other side: a
-- direct amendment at the version layer supersedes the matched v1 and inserts a v2 at twice the
-- rate while the bill sits untouched at `verified`. Nothing re-asked, and the claim stayed
-- verified against a verdict about a version that no longer exists.
--
-- Two triggers, ONE predicate. Writing the check twice is what §0 calls the drift that produces
-- findings — the copies disagree the first time either changes — so the wrappers do nothing but
-- name the bill their row belongs to. The honest amendment is unaffected: `amend` moves the bill
-- to `submitted` in the same transaction, so at COMMIT the predicate returns early.
CREATE OR REPLACE FUNCTION phase5_t5a_verified_provenance_from_bill() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t5a_verified_provenance(NEW."projectId", NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5a_verified_provenance_from_version() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t5a_verified_provenance(NEW."projectId", NEW."billId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorBill_verified_provenance" ON "VendorBill";
CREATE CONSTRAINT TRIGGER "VendorBill_verified_provenance"
  AFTER INSERT OR UPDATE ON "VendorBill" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5a_verified_provenance_from_bill();

DROP TRIGGER IF EXISTS "VendorBillVersion_verified_provenance" ON "VendorBillVersion";
CREATE CONSTRAINT TRIGGER "VendorBillVersion_verified_provenance"
  AFTER INSERT OR UPDATE ON "VendorBillVersion" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5a_verified_provenance_from_version();
