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

-- §H/§F (Codex P1) — the RE-STATEMENT chain. Supersession does not discard withholdings: the
-- plan is explicit that a retained balance vanishing without an attributable release is the defect,
-- so certifying a replacement carries the live ledger forward and these columns are the audit
-- chain. UNIQUE, so one source row can never be restated onto two certificates.
ALTER TABLE "BillDeduction" ADD COLUMN IF NOT EXISTS "restatedFromId" TEXT;
ALTER TABLE "BillDeductionRelease" ADD COLUMN IF NOT EXISTS "restatedFromId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "BillDeduction_projectId_restatedFromId_key"
  ON "BillDeduction"("projectId", "restatedFromId");
CREATE UNIQUE INDEX IF NOT EXISTS "BillDeductionRelease_projectId_restatedFromId_key"
  ON "BillDeductionRelease"("projectId", "restatedFromId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeduction_restatedFrom_fkey') THEN
    ALTER TABLE "BillDeduction" ADD CONSTRAINT "BillDeduction_restatedFrom_fkey" FOREIGN KEY ("projectId", "restatedFromId") REFERENCES "BillDeduction"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillDeductionRelease_restatedFrom_fkey') THEN
    ALTER TABLE "BillDeductionRelease" ADD CONSTRAINT "BillDeductionRelease_restatedFrom_fkey" FOREIGN KEY ("projectId", "restatedFromId") REFERENCES "BillDeductionRelease"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
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

  -- Codex round 3 — and a RE-STATED deduction is closed history. The service refuses this; the
  -- database did not, so a direct insert could release the source row after its restatement: the
  -- amount bound passes (the source's own releases stay within its amount) while the LIVE restated
  -- row carries no matching release, so `NET_PAYABLE` stays withheld beside append-only evidence
  -- that the money was returned. The service rule and the DB rule are now one rule.
  IF EXISTS (
    SELECT 1 FROM "BillDeduction" d
     WHERE d."projectId" = p_project AND d."restatedFromId" = p_deduction
  ) THEN
    RAISE EXCEPTION 'Deduction % has been re-stated onto a later certificate — release the live row instead, or the money is given back against a certificate nobody is paying', p_deduction;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Codex round 3 — COMMAND PROVENANCE, the §E shape. The FK proves the command EXISTS; it does not
-- prove this row came from it. A direct writer could cite an unrelated succeeded receipt — a
-- `commercial.bill.verify`, or one deduction command reused across many rows — and the durable
-- ledger would attribute a withholding that moves `NET_PAYABLE` to an act that did not produce it.
--
-- Split by WHEN each half is knowable, exactly as §E's verified-provenance seal is: the command
-- TYPE is checked at BEFORE INSERT (it is already written), and its OUTCOME at COMMIT (the receipt
-- is still `reserved` while its own transaction runs). A RESTATED row carries its SOURCE row's
-- command verbatim, which is the same type — the provenance travels with the withholding rather
-- than being reassigned to whoever re-certified it.
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

CREATE OR REPLACE FUNCTION phase5_t5c_ledger_command_succeeded() RETURNS trigger AS $$
DECLARE v_status text;
BEGIN
  SELECT ce."status" INTO v_status FROM "CommandExecution" ce
   WHERE ce."projectId" = NEW."projectId" AND ce."id" = NEW."sourceCommandId";
  IF v_status IS DISTINCT FROM 'succeeded' THEN
    RAISE EXCEPTION '% row % rests on command %, which is `%` — a ledger row that outlives a failed act is a withholding nobody made', TG_TABLE_NAME, NEW."id", NEW."sourceCommandId", COALESCE(v_status, '(missing)');
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
-- `verified` with no live payable at all, would then be CARRIED onto the replacement by
-- `restateDeductions` — a withholding recorded against nothing, arriving on a payable it was never
-- taken from. Historical rows on a superseded certificate stay; new ones are refused.
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

-- R4-F1/F3 — a deduction is coherent AT COMMIT: it targets a live certificate, and if it claims to
-- be a re-statement, it is one. The FK proves only that `restatedFromId` names some deduction.
-- Without the rest, a forged row on the live certificate naming an unrelated STILL-LIVE ₹10
-- withholding as its source locks that withholding out of release forever — `release()` refuses any
-- deduction that has been re-stated. A denial of service against a legitimate retention.
CREATE OR REPLACE FUNCTION phase5_t5c_deduction_coherent() RETURNS trigger AS $$
DECLARE
  v_superseded timestamp;
  v_src        record;
BEGIN
  SELECT c."supersededAt" INTO v_superseded FROM "BillCertificate" c
   WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."certificateId"
     FOR UPDATE;
  IF v_superseded IS NOT NULL THEN
    RAISE EXCEPTION 'Certificate % was superseded in this transaction — a withholding is taken FROM a live payable, and what this commit leaves behind is a deduction against nothing (%)', NEW."certificateId", NEW."id";
  END IF;

  IF NEW."restatedFromId" IS NULL THEN RETURN NULL; END IF;

  SELECT d."billId", d."certificateId", d."type", d."amount", c."supersededAt" AS "sourceSuperseded"
    INTO v_src
    FROM "BillDeduction" d
    JOIN "BillCertificate" c ON c."projectId" = d."projectId" AND c."id" = d."certificateId"
   WHERE d."projectId" = NEW."projectId" AND d."id" = NEW."restatedFromId"
     FOR UPDATE OF d;
  IF v_src."billId" IS DISTINCT FROM NEW."billId" THEN
    RAISE EXCEPTION 'Deduction % claims to re-state %, which belongs to a different bill — a re-statement carries a withholding forward on ONE payable', NEW."id", NEW."restatedFromId";
  END IF;
  -- source liveness is checked BEFORE the same-certificate rule, because it names the actual harm.
  -- Every other seal in this task stops money LEAVING; this one stops money being TRAPPED: a
  -- re-stated deduction can never be released, so naming a live withholding as your source freezes
  -- it permanently. Checking "same certificate" first would report the wrong thing about the case
  -- that matters, and would leave this branch unreachable while only one certificate is ever live.
  IF v_src."sourceSuperseded" IS NULL THEN
    RAISE EXCEPTION 'Deduction % claims to re-state %, but that withholding still stands on a LIVE certificate — re-stating it would close it as history and freeze money nobody released', NEW."id", NEW."restatedFromId";
  END IF;
  IF v_src."certificateId" = NEW."certificateId" THEN
    RAISE EXCEPTION 'Deduction % claims to re-state % on the SAME certificate — a re-statement moves a withholding onto its replacement, not beside itself', NEW."id", NEW."restatedFromId";
  END IF;
  IF v_src."type" IS DISTINCT FROM NEW."type" OR v_src."amount" IS DISTINCT FROM NEW."amount" THEN
    RAISE EXCEPTION 'Deduction % re-states % with different terms (% % vs % %) — a re-statement carries the SAME withholding forward; changing it is a new judgement and needs its own row', NEW."id", NEW."restatedFromId", NEW."type", NEW."amount", v_src."type", v_src."amount";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillDeduction_coherent" ON "BillDeduction";
CREATE CONSTRAINT TRIGGER "BillDeduction_coherent"
  AFTER INSERT ON "BillDeduction" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_deduction_coherent();

-- the release side of the same rule: a re-stated release belongs to the re-stated deduction of the
-- release's own source, and carries the same amount
CREATE OR REPLACE FUNCTION phase5_t5c_release_coherent() RETURNS trigger AS $$
DECLARE v_src record;
BEGIN
  IF NEW."restatedFromId" IS NULL THEN RETURN NULL; END IF;
  SELECT r."deductionId", r."amount", d."restatedFromId" AS "targetSource"
    INTO v_src
    FROM "BillDeductionRelease" r
    JOIN "BillDeduction" d ON d."projectId" = NEW."projectId" AND d."id" = NEW."deductionId"
   WHERE r."projectId" = NEW."projectId" AND r."id" = NEW."restatedFromId"
     FOR UPDATE OF r;
  IF v_src."targetSource" IS DISTINCT FROM v_src."deductionId" THEN
    RAISE EXCEPTION 'Release % re-states %, but its deduction is not the re-statement of that release''s deduction — a carried release must follow the withholding it belongs to', NEW."id", NEW."restatedFromId";
  END IF;
  IF v_src."amount" IS DISTINCT FROM NEW."amount" THEN
    RAISE EXCEPTION 'Release % re-states % with a different amount — a carried release gives back exactly what was given back', NEW."id", NEW."restatedFromId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillDeductionRelease_coherent" ON "BillDeductionRelease";
CREATE CONSTRAINT TRIGGER "BillDeductionRelease_coherent"
  AFTER INSERT ON "BillDeductionRelease" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_release_coherent();

-- R4-F2 — the re-statement is REQUIRED, not merely well-formed. `restateDeductions` is service
-- code; a bypass replacement certification can supersede a certificate carrying a ₹10 retention and
-- create the new live certificate with no carried rows at all. The old deduction stays as history,
-- `positionFor` reads only the live certificate, and the retained balance vanishes with nobody's
-- release behind it — which is round 1's F2, arriving from the database side.
--
-- Scoped to withholdings with an OUTSTANDING balance, because that is the actual invariant: a
-- retained balance never vanishes. A fully released one has nothing left to carry, and the service
-- carries it anyway (stronger than the seal, so it never collides).
CREATE OR REPLACE FUNCTION phase5_t5c_replacement_restates() RETURNS trigger AS $$
DECLARE
  v_orphan record;
  v_bill   text;
BEGIN
  -- the BILL is the row that scopes this fold, and you cannot lock a fold. `certify` already holds
  -- this lock (`lockBill`), so the seal adds no new lock order — it only closes the gap for a
  -- writer that never took it.
  SELECT b."id" INTO v_bill FROM "VendorBill" b
   WHERE b."projectId" = NEW."projectId" AND b."id" = NEW."billId"
     FOR UPDATE;

  IF EXISTS (SELECT 1 FROM "BillCertificate" c
              WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."id"
                AND c."supersededAt" IS NOT NULL) THEN
    RETURN NULL;  -- this certificate did not survive its own transaction; it replaces nothing
  END IF;

  SELECT d."id", d."amount" INTO v_orphan
    FROM "BillDeduction" d
    JOIN "BillCertificate" pc ON pc."projectId" = d."projectId" AND pc."id" = d."certificateId"
   WHERE d."projectId" = NEW."projectId"
     AND d."billId" = NEW."billId"
     AND d."certificateId" <> NEW."id"
     AND pc."supersededAt" IS NOT NULL
     AND d."amount" > COALESCE((SELECT SUM(r."amount") FROM "BillDeductionRelease" r
                                 WHERE r."projectId" = d."projectId" AND r."deductionId" = d."id"), 0)
     AND NOT EXISTS (SELECT 1 FROM "BillDeduction" n
                      WHERE n."projectId" = d."projectId" AND n."restatedFromId" = d."id")
   ORDER BY d."id" ASC
   LIMIT 1;

  IF v_orphan."id" IS NOT NULL THEN
    RAISE EXCEPTION 'Certificate % replaces one carrying an unreleased withholding (% of %) that it does not re-state — the retained balance would vanish with no release behind it; carry it forward or release it attributably first', NEW."id", v_orphan."amount", v_orphan."id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "BillCertificate_replacement_restates" ON "BillCertificate";
CREATE CONSTRAINT TRIGGER "BillCertificate_replacement_restates"
  AFTER INSERT ON "BillCertificate" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5c_replacement_restates();

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
