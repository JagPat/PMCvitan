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

CREATE TABLE IF NOT EXISTS "BillDeduction" (
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

CREATE TABLE IF NOT EXISTS "BillDeductionRelease" (
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

CREATE UNIQUE INDEX IF NOT EXISTS "BillDeduction_projectId_id_key" ON "BillDeduction"("projectId", "id");
CREATE INDEX IF NOT EXISTS "BillDeduction_projectId_certificateId_idx" ON "BillDeduction"("projectId", "certificateId");
CREATE INDEX IF NOT EXISTS "BillDeduction_projectId_billId_idx" ON "BillDeduction"("projectId", "billId");
CREATE UNIQUE INDEX IF NOT EXISTS "BillDeductionRelease_projectId_id_key" ON "BillDeductionRelease"("projectId", "id");
CREATE INDEX IF NOT EXISTS "BillDeductionRelease_projectId_deductionId_idx" ON "BillDeductionRelease"("projectId", "deductionId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeduction_projectId_fkey') THEN
    ALTER TABLE "BillDeduction" ADD CONSTRAINT "BillDeduction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeduction_certificate_fkey') THEN
    ALTER TABLE "BillDeduction" ADD CONSTRAINT "BillDeduction_certificate_fkey" FOREIGN KEY ("projectId", "certificateId", "billId")
    REFERENCES "BillCertificate"("projectId", "id", "billId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeduction_recordedById_fkey') THEN
    ALTER TABLE "BillDeduction" ADD CONSTRAINT "BillDeduction_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeduction_command_fkey') THEN
    ALTER TABLE "BillDeduction" ADD CONSTRAINT "BillDeduction_command_fkey" FOREIGN KEY ("projectId", "sourceCommandId")
    REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeductionRelease_projectId_fkey') THEN
    ALTER TABLE "BillDeductionRelease" ADD CONSTRAINT "BillDeductionRelease_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeductionRelease_deduction_fkey') THEN
    ALTER TABLE "BillDeductionRelease" ADD CONSTRAINT "BillDeductionRelease_deduction_fkey" FOREIGN KEY ("projectId", "deductionId")
    REFERENCES "BillDeduction"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeductionRelease_releasedById_fkey') THEN
    ALTER TABLE "BillDeductionRelease" ADD CONSTRAINT "BillDeductionRelease_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeductionRelease_command_fkey') THEN
    ALTER TABLE "BillDeductionRelease" ADD CONSTRAINT "BillDeductionRelease_command_fkey" FOREIGN KEY ("projectId", "sourceCommandId")
    REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- §H — the type set this task ships. `advance-recovery` is deliberately absent: it folds against an
-- `advance` row created when the advance is PAID, so the enum member arrives in Task 6 with the row
-- that caps it. §0b's "every declared member is in the fold" then holds at BOTH stages rather than
-- being briefly false.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeduction_type_known') THEN
    ALTER TABLE "BillDeduction" ADD CONSTRAINT "BillDeduction_type_known" CHECK ("type" IN ('retention', 'penalty', 'other'));
  END IF;
END $$;

-- §0b's sign constraint, at its third site. The row TYPE carries direction — a withholding is this
-- row and a release is its own — so a negative amount encodes direction twice and the two encodings
-- disagree: a -10 retention makes `NET_PAYABLE = CERTIFIED - (-10)` raise a ₹100 certificate to
-- ₹110, a deduction that PAYS OUT more, sealed append-only so it cannot be corrected in place.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeduction_amount_positive') THEN
    ALTER TABLE "BillDeduction" ADD CONSTRAINT "BillDeduction_amount_positive" CHECK ("amount" > 0);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeductionRelease_amount_positive') THEN
    ALTER TABLE "BillDeductionRelease" ADD CONSTRAINT "BillDeductionRelease_amount_positive" CHECK ("amount" > 0);
  END IF;
END $$;

-- the complete non-blank discipline (Phase-4 Task 5, after `btrim` alone let whitespace through).
-- Presence is not justification: a `penalty` reasoned `'   '` satisfies every other stated check and
-- leaves append-only evidence nobody can act on.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeduction_reason_nonblank') THEN
    ALTER TABLE "BillDeduction" ADD CONSTRAINT "BillDeduction_reason_nonblank" CHECK ("reason" IS NULL OR btrim("reason", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeduction_reason_required') THEN
    ALTER TABLE "BillDeduction" ADD CONSTRAINT "BillDeduction_reason_required" CHECK (
    "type" NOT IN ('other', 'penalty') OR ("reason" IS NOT NULL AND btrim("reason", E' \t\n\x0B\f\r') <> '')
  );
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeductionRelease_reason_nonblank') THEN
    ALTER TABLE "BillDeductionRelease" ADD CONSTRAINT "BillDeductionRelease_reason_nonblank" CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '');
  END IF;
END $$;

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
  -- Codex P2 — LOCK the certificate BEFORE folding. Without it this trigger COUNTS without
  -- serializing: under READ COMMITTED two direct transactions can each insert ₹60 against the same
  -- ₹100 certificate, each deferred check sees only its own uncommitted row, both pass, and the
  -- committed ledger holds ₹120. The service is safe because it takes the bill lock — but this
  -- trigger is the backstop for whatever BYPASSES the service, and a backstop that only works when
  -- the thing it backstops is present is not one. The second commit now blocks here, re-reads with
  -- the first row visible, and is rejected. This is the Phase-4 §F bound-3 finding, one phase along.
  SELECT c."certifiedAmount", c."supersededAt" INTO v_certified, v_live
    FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."id" = p_certificate
     FOR UPDATE;
  -- a SUPERSEDED certificate's deductions leave every fold with it, so there is no bound to hold
  IF v_certified IS NULL OR v_live IS NOT NULL THEN RETURN; END IF;

  -- Codex round 8 — the fold used to be NET, over the whole ledger at once, and a net fold cannot
  -- see a withholding that never existed to take. A bypass transaction inserting a ₹150 deduction
  -- and a ₹50 release against a ₹100 certificate left `v_withheld` = 100 and passed, and the
  -- append-only ledger then said permanently that ₹150 was withheld from a ₹100 payable. Splitting
  -- it across two ₹60 rows with a ₹20 release did the same thing.
  --
  -- A gross cap (`SUM(deductions) <= certified`) closes that and breaks something honest: withhold
  -- ₹100, give all ₹100 back, withhold ₹100 again is a sequence whose net never exceeds the
  -- certificate, and a gross cap refuses it at ₹200.
  --
  -- So the bound is the §C shape this phase already uses for stock: fold the ledger IN ORDER and
  -- require the RUNNING balance to stay within the certificate. A release ranks after a deduction
  -- at the same instant, because money cannot come back before it was withheld — without that,
  -- a release written in the same transaction could sort ahead of its own deduction.
  SELECT COALESCE(MAX(running), 0) INTO v_withheld FROM (
    SELECT SUM(delta) OVER (ORDER BY at, rank, rid ROWS UNBOUNDED PRECEDING) AS running
      FROM (
        SELECT d."recordedAt" AS at, 0 AS rank, d."id" AS rid, d."amount" AS delta
          FROM "BillDeduction" d
         WHERE d."projectId" = p_project AND d."certificateId" = p_certificate
        UNION ALL
        SELECT r."releasedAt", 1, r."id", -r."amount"
          FROM "BillDeductionRelease" r
          JOIN "BillDeduction" d2 ON d2."projectId" = r."projectId" AND d2."id" = r."deductionId"
         WHERE d2."projectId" = p_project AND d2."certificateId" = p_certificate
      ) events
  ) balance;

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
  -- Codex round 2 — LOCK the deduction BEFORE folding its releases. Round 1 gave the withholding
  -- bound exactly this treatment and left its sibling counting without serializing, which is the
  -- same fix-the-member-not-the-set mistake that finding was raised for. Without it two bypass
  -- writers can each insert a ₹60 release against the same ₹100 deduction, each deferred check
  -- sees only its own uncommitted row, and the append-only ledger commits ₹120 released.
  SELECT d."amount" INTO v_amount FROM "BillDeduction" d
   WHERE d."projectId" = p_project AND d."id" = p_deduction
     FOR UPDATE;
  IF v_amount IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(r."amount"), 0) INTO v_released FROM "BillDeductionRelease" r
   WHERE r."projectId" = p_project AND r."deductionId" = p_deduction;

  IF v_released > v_amount THEN
    RAISE EXCEPTION 'Releases of % exceed the % this deduction withheld — a release gives back money that was held, and it cannot give back more than that (%)', v_released, v_amount, p_deduction;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Codex round 3 — COMMAND PROVENANCE, the §E shape. The FK proves the command EXISTS; it does not
-- prove this row came from it. A direct writer could cite an unrelated succeeded receipt — a
-- `commercial.bill.verify`, or one deduction command reused across many rows — and the durable
-- ledger would attribute a withholding that moves `NET_PAYABLE` to an act that did not produce it.
--
-- Split by WHEN each half is knowable, exactly as §E's verified-provenance seal is: the command
-- TYPE is checked at BEFORE INSERT (it is already written), and its OUTCOME and RESULT at COMMIT
-- (the receipt is still `reserved`, and its `resultRef` still unwritten, while its own transaction
-- runs).
CREATE OR REPLACE FUNCTION phase5_t5c_ledger_command_type() RETURNS trigger AS $$
DECLARE
  v_type     text;
  v_expected text := CASE TG_TABLE_NAME
                       WHEN 'BillDeduction' THEN 'commercial.deduction.record'
                       ELSE 'commercial.deduction.release'
                     END;
BEGIN
  SELECT ce."commandType" INTO v_type FROM "CommandExecution" ce
   WHERE ce."projectId" = NEW."projectId" AND ce."id" = NEW."sourceCommandId";
  IF v_type IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION '% row % cites command % of type % — a ledger row records the command that PRODUCED it, and this one did not', TG_TABLE_NAME, NEW."id", NEW."sourceCommandId", COALESCE(v_type, '(missing)');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- R5-F3 — and the command must have PRODUCED this row, not merely have succeeded. Checking the
-- status alone leaves the type check as the only real constraint, and a type check is satisfied by
-- EVERY prior command of that type: a direct writer reuses one succeeded `commercial.deduction.record`
-- receipt to append a second, third, fourth withholding, and the append-only ledger permanently
-- attributes money movement to an act that produced none of it.
--
-- One command produces exactly one ledger row here, and `resultRef` names it. The rule is the same
-- sentence for both tables — `resultRef` IS the row — which is why `release()` answers with the
-- release row rather than the deduction it belongs to. Row ids are unique, so this alone makes a
-- reused receipt unrepresentable; no separate uniqueness is needed to hold it up.
CREATE OR REPLACE FUNCTION phase5_t5c_ledger_command_succeeded() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_result text;
  v_actor  text;
  v_named  text;
BEGIN
  SELECT ce."status", ce."resultRef", ce."actorId" INTO v_status, v_result, v_actor
    FROM "CommandExecution" ce
   WHERE ce."projectId" = NEW."projectId" AND ce."id" = NEW."sourceCommandId";
  IF v_status IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION '% row % rests on command %, which is `%` — a ledger row that outlives a failed act is a withholding nobody made', TG_TABLE_NAME, NEW."id", NEW."sourceCommandId", COALESCE(v_status, '(missing)');
  END IF;
  IF v_result IS DISTINCT FROM NEW."id" THEN
    RAISE EXCEPTION '% row % cites command %, which produced % — a ledger row records the command that PRODUCED it, and reusing a succeeded receipt attributes money to an act that did not move it', TG_TABLE_NAME, NEW."id", NEW."sourceCommandId", COALESCE(v_result, '(nothing)');
  END IF;
  -- Codex round 8 — type, status and `resultRef` proved everything about the cited act EXCEPT who
  -- performed it, so a direct writer could run the command as one person and write the row in
  -- another's name. The ledger is append-only, so that misattribution is permanent and there is no
  -- correcting row to make later. Naming the human who moved the money is the reason the receipt is
  -- cited at all, so the row's actor must BE the command's actor.
  --
  -- The two tables spell the same fact with different column names, and the rule is one sentence
  -- for both, so the column is read off the row rather than duplicating the check per table.
  v_named := CASE TG_TABLE_NAME
    WHEN 'BillDeduction' THEN to_jsonb(NEW)->>'recordedById'
    ELSE to_jsonb(NEW)->>'releasedById'
  END;
  IF v_actor IS DISTINCT FROM v_named THEN
    RAISE EXCEPTION '% row % is attributed to %, but the command it cites was run by % — money that moves names the human who moved it, and an append-only row carries that name for good', TG_TABLE_NAME, NEW."id", COALESCE(v_named, '(nobody)'), COALESCE(v_actor, '(nobody)');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillDeduction_command_type" ON "BillDeduction";
CREATE TRIGGER "BillDeduction_command_type" BEFORE INSERT ON "BillDeduction"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_ledger_command_type();
DROP TRIGGER IF EXISTS "BillDeductionRelease_command_type" ON "BillDeductionRelease";
CREATE TRIGGER "BillDeductionRelease_command_type" BEFORE INSERT ON "BillDeductionRelease"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_ledger_command_type();
DROP TRIGGER IF EXISTS "BillDeduction_command_succeeded" ON "BillDeduction";
CREATE CONSTRAINT TRIGGER "BillDeduction_command_succeeded"
  AFTER INSERT ON "BillDeduction" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_ledger_command_succeeded();
DROP TRIGGER IF EXISTS "BillDeductionRelease_command_succeeded" ON "BillDeductionRelease";
CREATE CONSTRAINT TRIGGER "BillDeductionRelease_command_succeeded"
  AFTER INSERT ON "BillDeductionRelease" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_ledger_command_succeeded();

-- Codex round 2 — a NEW deduction may only target a LIVE certificate. The bound function returns
-- early for a superseded one (correctly: its rows have left every fold), but "no bound to check" is
-- not "anything goes". A direct insert landing after supersession, while the bill is back at
-- `verified` with no live payable at all, would be a withholding recorded against nothing — money
-- withheld from a payable that no longer exists, and by the fold's own scoping, withheld from
-- nobody. Historical rows on a superseded certificate stay; new ones are refused.
CREATE OR REPLACE FUNCTION phase5_t5c_deduction_targets_live() RETURNS trigger AS $$
DECLARE v_superseded timestamp;
BEGIN
  -- Codex round 3 — LOCK before reading liveness. A plain SELECT does not serialize with a
  -- concurrent supersede: this trigger reads `supersededAt = NULL`, supersede commits, and the
  -- deferred bound then returns early for a superseded certificate, leaving a withholding committed
  -- against a payable that no longer stands. Round 2 added `FOR UPDATE` to the bound function and
  -- this trigger — written in the SAME round — was left reading without one.
  SELECT c."supersededAt" INTO v_superseded FROM "BillCertificate" c
   WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."certificateId"
     FOR UPDATE;
  IF v_superseded IS NOT NULL THEN
    RAISE EXCEPTION 'Certificate % was superseded — a withholding is taken FROM a live payable, and this one no longer stands (%)', NEW."certificateId", NEW."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillDeduction_targets_live" ON "BillDeduction";
CREATE TRIGGER "BillDeduction_targets_live" BEFORE INSERT ON "BillDeduction"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_deduction_targets_live();

CREATE OR REPLACE FUNCTION phase5_t5c_deduction_bound_sealed() RETURNS trigger AS $$
BEGIN
  PERFORM phase5_t5c_withholding_bound_check(NEW."projectId", NEW."certificateId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5c_release_bound_sealed() RETURNS trigger AS $$
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

-- ══ Codex round 4 — the same rules, at the moment that actually decides ════════════════════════
--
-- All three round-4 findings are one shape, and it is root A in a dimension the earlier rounds did
-- not have: a rule enforced at INSERT but not at COMMIT, or in the SERVICE but not in the DATABASE.
-- A BEFORE INSERT trigger sees the world as it was mid-transaction; a bypass writer can insert
-- against a live certificate and then supersede it before committing, and every insert-time check
-- has already passed. What a transaction leaves BEHIND is what a seal has to be about.

-- R4-F1 — a deduction is coherent AT COMMIT: it targets a certificate that is still live when the
-- transaction ends. The BEFORE INSERT check above sees the world mid-transaction, so a writer that
-- inserts against a live certificate and then supersedes it in the same transaction passes every
-- insert-time guard and still commits a withholding against nothing.
CREATE OR REPLACE FUNCTION phase5_t5c_deduction_coherent() RETURNS trigger AS $$
DECLARE v_superseded timestamp;
BEGIN
  SELECT c."supersededAt" INTO v_superseded FROM "BillCertificate" c
   WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."certificateId"
     FOR UPDATE;
  IF v_superseded IS NOT NULL THEN
    RAISE EXCEPTION 'Certificate % was superseded in this transaction — a withholding is taken FROM a live payable, and what this commit leaves behind is a deduction against nothing (%)', NEW."certificateId", NEW."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillDeduction_coherent" ON "BillDeduction";
CREATE CONSTRAINT TRIGGER "BillDeduction_coherent"
  AFTER INSERT ON "BillDeduction" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_deduction_coherent();

-- ── the withholding is what makes a certificate UNSUPERSEDABLE ───────────────────────────────
--
-- §H's rule is that a retained balance never vanishes without an attributable release. There are
-- two ways to honour it when a certificate is corrected: CARRY the ledger onto the replacement
-- (re-statement), or REFUSE the correction until the money is given back attributably. This task
-- takes the second. Re-statement is a larger mechanism than it looks — carrying deductions and
-- their releases together, sealing that the copy is faithful in every evidence-bearing field, and
-- keeping a source row releasable exactly once — and it earns its own review unit rather than
-- riding along with the ledger it copies.
--
-- The refusal is the STRICTER of the two: every state it permits, re-statement permits too, and it
-- permits no act re-statement would refuse. That is the criterion that made splitting Task 5B safe,
-- and it is why this is a split rather than a gap. Until the follow-up lands, a practice correcting
-- a certificate releases the withholding first — which is the attributable act §H wanted either
-- way — and the money is never silently dropped.
--
-- It also settles what supersession MOVES. With a live withholding refused, the withheld fold is
-- necessarily zero at supersession, so the only money moving is the claim itself leaving
-- `certified-payable` for `awaiting-certification` — which is exactly what the `claim` mover in
-- `evaluateHeadsForBill` says. No deduction-shaped mover is needed here, because no deduction can
-- be standing.
CREATE OR REPLACE FUNCTION phase5_t5c_supersede_needs_release() RETURNS trigger AS $$
DECLARE
  v_live record;
BEGIN
  IF NEW."supersededAt" IS NULL OR OLD."supersededAt" IS NOT NULL THEN RETURN NULL; END IF;

  -- Codex round 6 — this seal took NO lock of its own, and that is deliberate. It used to lock the
  -- BILL, reasoning that "`supersede` already holds `lockBill`, so the seal adds no new lock order".
  -- That sentence is true of the SERVICE path and false of the only path this seal ever runs for.
  -- The honest deduction path locks bill → certificate (`lockBill`, then `BillDeduction_targets_live`
  -- takes the certificate `FOR UPDATE`). A bypass writer that updates `BillCertificate` alone holds
  -- the CERTIFICATE first and would then have reached for the bill here — certificate → bill. That
  -- is an ABBA inversion, and PostgreSQL resolves it by aborting somebody as a deadlock instead of
  -- returning the refusal below, which is a worse answer than the one this seal exists to give.
  --
  -- No lock is needed, because the CERTIFICATE row is already locked by the UPDATE that fired this
  -- trigger, and the certificate is what the fold is scoped to:
  --   · a concurrent DEDUCTION must take that same certificate `FOR UPDATE` (`BillDeduction_targets_live`),
  --     so it cannot slip a new withholding in beside this check — it waits, and then meets a
  --     superseded certificate and is refused;
  --   · a concurrent RELEASE only ever REDUCES an outstanding balance, so the worst it can produce
  --     is a refusal that a retry no longer earns. Strict, never permissive — and the append-only
  --     ledger means neither direction can be walked back behind us.
  -- Taking the bill on top of that bought no serialization; it only bought the inversion.

  SELECT d."id", (d."amount" - COALESCE((SELECT SUM(r."amount") FROM "BillDeductionRelease" r
                                          WHERE r."projectId" = d."projectId" AND r."deductionId" = d."id"), 0)) AS "outstanding"
    INTO v_live
    FROM "BillDeduction" d
   WHERE d."projectId" = NEW."projectId"
     AND d."certificateId" = NEW."id"
     AND d."amount" > COALESCE((SELECT SUM(r."amount") FROM "BillDeductionRelease" r
                                 WHERE r."projectId" = d."projectId" AND r."deductionId" = d."id"), 0)
   ORDER BY d."id" ASC
   LIMIT 1;

  IF v_live."id" IS NOT NULL THEN
    RAISE EXCEPTION 'Certificate % still carries an unreleased withholding (% of %) — superseding it would drop a retained balance with no release behind it; release the money attributably first, then correct the certification', NEW."id", v_live."outstanding", v_live."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillCertificate_supersede_needs_release" ON "BillCertificate";
CREATE CONSTRAINT TRIGGER "BillCertificate_supersede_needs_release"
  AFTER UPDATE ON "BillCertificate" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_supersede_needs_release();

-- §B (Codex round 1 F6) — the mover VOCABULARY gains the two acts §H introduces. `raisedBy` is the
-- durable explanation a human reads months later, so it must name what actually moved: a
-- release-raised exception labelled `claim` sends a PMC hunting for a claim that never changed.
ALTER TABLE "BudgetException" DROP CONSTRAINT IF EXISTS "BudgetException_raisedBy_check";
ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_raisedBy_check"
  CHECK ("raisedBy" IN ('commitment', 'budget_revision', 'reattribution', 'acceptance', 'receipt_progress', 'measurement', 'claim', 'deduction', 'deduction_release'));

-- ── WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ────────────────────────────────────────────
--
-- §H says a deduction insertion RE-DERIVES the §F payment status. That derivation is NOT here,
-- and its absence is a scope decision rather than an omission.
--
-- §F derives the status from THREE folds — `NET_PAYABLE`, `APPROVED`, `PAID` — and two of them
-- are Task 6's. Deriving from one fold while the other two are structurally zero made `paid`
-- reachable here, which in turn required widening three seals Task 5B unit A had written when
-- `certified` was a claim's terminal status. Each of those widenings then needed its own
-- fold-backed guard, and the guards needed guards: the review surface grew faster than the
-- reviews retired it.
--
-- So the derivation lands in Task 6, beside the approval and payment rows that supply its other
-- two folds. Until then a deduction moves `NET_PAYABLE` and §J's `certified-payable` and the
-- stored bill status does not move at all. That intermediate state is STRICTLY STRICTER than the
-- finished rule — no transition exists to be wrong about — and the "stranded with no row that can
-- advance it" case cannot arise, because the rows that would advance it are Task 6's too.
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
