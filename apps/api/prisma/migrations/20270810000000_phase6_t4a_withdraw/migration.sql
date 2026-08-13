-- Phase 6 task 4a — `decisions.withdraw`: the owner's live defect (a wrongly-published
-- decision has no honest exit) gets a real command. From the cleared decision-workflow plan
-- (PR #335, `main` 27c484b) §A: the `withdrawn` enum value, the write-once withdrawal
-- evidence, the notice stamp that lets a now-false pending bell item be RETIRED rather than
-- text-matched, the push-delivery SUBJECT key (+ its backfill) the withdraw transaction
-- cancels by, and the three seals — terminal + evidence freeze, attributed-to-a-real-actor
-- coherence, and never-approved in BOTH directions.
--
-- ADDITIVE and DIAGNOSTIC-FIRST. Nothing here edits or invents a fact. Every statement is in
-- the retry-safe form (`ADD VALUE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
-- `CREATE INDEX IF NOT EXISTS`, `pg_constraint`-guarded `DO` blocks, `CREATE OR REPLACE` +
-- `DROP TRIGGER IF EXISTS`) because this file is RERUNNABLE BY DESIGN: the diagnostics below
-- abort the deploy on a violating database, and a re-run after operator repair must get past
-- the statements that already succeeded — a duplicate-column death would make the migration
-- unrepairable by the very diagnostic that exists to repair it.
--
-- Enum-in-transaction note: the new value is ADDED here and never USED in this file's own
-- immediate SQL except through `::text` comparisons (PostgreSQL forbids resolving a new enum
-- LITERAL in the transaction that adds it; a text cast never resolves the literal, and the
-- trigger function bodies are parsed at runtime, after commit).

-- ── the ADDITIVE shape first, then the diagnostics — the order is load-bearing ───────────────
-- (Round 1, Codex F2.) The diagnostics below quarantine any PRE-EXISTING 'withdrawn' row that
-- lacks coherent evidence, and that check is only EXPRESSIBLE once the evidence columns exist.
-- A partially-applied fork of this migration (or hand-minted SQL between deploys) can leave the
-- enum value — and rows in it — WITHOUT the columns; gating the diagnostic on the columns'
-- existence would let exactly that state slide through, adding NULL evidence around a row the
-- seals are then never asked to judge. So the harmless additive shape (an enum value and four
-- nullable columns — neither edits a row nor enforces anything) installs FIRST, and the
-- diagnostics run UNCONDITIONALLY after it: any 'withdrawn' row without full evidence, or
-- beside an approval revision, ABORTS the deploy before a single SEAL (the binding structural
-- change) installs. Diagnostic-first still holds where it matters: nothing is enforced, and no
-- fact is edited or invented, until the database is proven clean.

-- the enum value (added, never used in this file's immediate SQL except via ::text)
ALTER TYPE "DecisionStatus" ADD VALUE IF NOT EXISTS 'withdrawn';

-- the withdrawal evidence (write-once with the status; sealed by the triggers below)
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "withdrawnAt" TIMESTAMP(3);
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "withdrawnById" TEXT;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "withdrawnByName" TEXT;
ALTER TABLE "Decision" ADD COLUMN IF NOT EXISTS "withdrawReason" TEXT;

-- ── diagnostics (abort before any SEAL installs; unconditional) ──────────────────────────────
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT d."id" FROM "Decision" d
    WHERE d."status"::text = 'withdrawn'
      AND (d."withdrawnAt" IS NULL OR d."withdrawnById" IS NULL OR d."withdrawnByName" IS NULL
           OR d."withdrawReason" IS NULL OR btrim(d."withdrawReason", E' \t\n\x0B\f\r') = '')
    LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t4a: % withdrawn decision(s) carry incomplete withdrawal evidence (sample: %). Repair the rows (attribute or re-issue), then redeploy.', bad, sample;
  END IF;
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT d."id" FROM "Decision" d
    JOIN "DecisionApprovalRevision" r ON r."decisionId" = d."id"
    WHERE d."status"::text = 'withdrawn'
    LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t4a: % withdrawn decision(s) carry approval revisions — a decision with approval evidence can never be withdrawn (sample: %). Resolve by hand, then redeploy.', bad, sample;
  END IF;
  -- Round 2 (Codex F1): the INVERSE arm of coherence, back-checked. The trigger below refuses
  -- orphan evidence only on FUTURE writes; a partial/manual apply that already added the
  -- columns can leave a non-withdrawn row carrying withdrawal claims, which the withdrawn-only
  -- scans above never visit. Quarantine it here.
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT d."id" FROM "Decision" d
    WHERE d."status"::text <> 'withdrawn'
      AND (d."withdrawnAt" IS NOT NULL OR d."withdrawnById" IS NOT NULL
           OR d."withdrawnByName" IS NOT NULL OR d."withdrawReason" IS NOT NULL)
    LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t4a: % NON-withdrawn decision(s) carry withdrawal evidence — orphaned claims from a partial apply (sample: %). Clear the stray columns or complete the withdrawal by hand, then redeploy.', bad, sample;
  END IF;
  -- Round 2 (Codex F2): a withdrawn row must be PUBLISHED — the entry guard requires it going
  -- forward, and the visibility rule's draft arm would otherwise hide the permanent record
  -- from the pmc register. A pre-existing violation is quarantined, never repaired silently.
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT d."id" FROM "Decision" d
    WHERE d."status"::text = 'withdrawn' AND d."publishedAt" IS NULL
    LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t4a: % withdrawn decision(s) have no publishedAt — the withdrawal record would vanish behind the draft filter (sample: %). Restore the publication fact by hand, then redeploy.', bad, sample;
  END IF;
END $$;

-- attribution names a REAL member of THIS project (the completionRequestedById discipline):
-- presence alone would let hostile SQL attribute the permanent register to a nonexistent actor.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Decision_projectId_withdrawnById_fkey') THEN
    ALTER TABLE "Decision" ADD CONSTRAINT "Decision_projectId_withdrawnById_fkey"
      FOREIGN KEY ("projectId", "withdrawnById") REFERENCES "Membership"("projectId", "userId")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- ── the notice stamp (retire-by-identity, not by display text) ───────────────────────────────
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "decisionId" TEXT;
CREATE INDEX IF NOT EXISTS "Notification_decisionId_idx" ON "Notification"("decisionId");

-- ── the push-delivery subject key + cancellation mark (platform-owned) ───────────────────────
ALTER TABLE "OutboxDelivery" ADD COLUMN IF NOT EXISTS "subject" TEXT;
ALTER TABLE "OutboxDelivery" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "OutboxDelivery_consumer_subject_idx" ON "OutboxDelivery"("consumer", "subject");

-- The subject reaches BACKWARD: a `decision.published` push committed before this deploy, with
-- the relay down and the withdrawal after it, would otherwise escape cancel-by-subject as a
-- subjectless row. Backfill existing UNDELIVERED decision-published push rows from their own
-- event's entityId — deterministic, copied from the event the delivery already carries, never
-- invented. Retry-safe: the `"subject" IS NULL` guard makes a re-run a no-op.
UPDATE "OutboxDelivery" d
SET "subject" = e."entityId"
FROM "DomainEvent" e
WHERE e."eventId" = d."eventId"
  AND e."projectId" = d."projectId"
  AND e."streamPosition" = d."streamPosition"
  AND d."consumer" = 'webpush.notify'
  AND e."eventType" = 'decision.published'
  AND d."subject" IS NULL
  -- 'dead' included (round 2, Codex F4): a pre-4a push that exhausted its retries must still be
  -- markable by a later withdrawal, or an operator redrive would resurrect the stale
  -- announcement past the pre-send check (which reads the mark this subject enables).
  AND d."status" IN ('pending', 'leased', 'dead');

-- ── seal 1: terminal, and the evidence FROZEN with it ────────────────────────────────────────
-- Trigger NAMES are load-bearing: PostgreSQL fires same-event triggers in name order, so the
-- `t4a_a/_b/_c` prefixes make the TERMINAL seal answer first (a transition out of `withdrawn`
-- is refused as terminal, not as an evidence complaint), the ENTRY guard second, and the
-- evidence COHERENCE check last.
-- A transition OUT of 'withdrawn' would be a forged register entry (the DecisionEvent register
-- says the decision was withdrawn; a resurrected row contradicts it). And a status-only seal
-- would let hostile SQL rewrite WHO withdrew and WHY while the status stays legal — rewritten
-- history wearing an intact seal. Write-once means the columns, not just the state.
CREATE OR REPLACE FUNCTION phase6_t4a_withdrawn_terminal() RETURNS trigger AS $fn$
BEGIN
  IF OLD."status"::text = 'withdrawn' THEN
    IF NEW."status"::text <> 'withdrawn' THEN
      RAISE EXCEPTION 'phase6-t4a: withdrawn is terminal — decision % cannot transition to %', OLD."id", NEW."status";
    END IF;
    IF NEW."withdrawnAt" IS DISTINCT FROM OLD."withdrawnAt"
       OR NEW."withdrawnById" IS DISTINCT FROM OLD."withdrawnById"
       OR NEW."withdrawnByName" IS DISTINCT FROM OLD."withdrawnByName"
       OR NEW."withdrawReason" IS DISTINCT FROM OLD."withdrawReason" THEN
      RAISE EXCEPTION 'phase6-t4a: withdrawal evidence is write-once — decision % cannot be re-attributed', OLD."id";
    END IF;
    -- Round 2 (Codex F2): the PUBLICATION fact is part of the frozen record. Clearing
    -- publishedAt on a withdrawn row would drop it into the draft filter's author-private arm
    -- and the pmc register would lose the permanent withdrawal + its reason.
    IF NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt" THEN
      RAISE EXCEPTION 'phase6-t4a: publishedAt is frozen on a withdrawn decision — the record stays on the register (decision %)', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Decision_t4a_a_terminal" ON "Decision";
CREATE TRIGGER "Decision_t4a_a_terminal"
  BEFORE UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4a_withdrawn_terminal();

-- ── seal 2: attributed — to a real actor, with a non-blank reason, in BOTH directions ────────
-- status='withdrawn' requires the complete evidence (the FK above makes the actor real); and
-- the inverse — evidence columns only ever exist WITH the status — so a non-withdrawn row can
-- never carry orphaned withdrawal claims. Non-blank is the repository's FULL ASCII-whitespace
-- discipline: btrim(x) strips spaces only, so the tab/newline class is spelled exactly.
CREATE OR REPLACE FUNCTION phase6_t4a_withdrawn_coherent() RETURNS trigger AS $fn$
BEGIN
  IF NEW."status"::text = 'withdrawn' THEN
    IF NEW."withdrawnAt" IS NULL OR NEW."withdrawnById" IS NULL OR NEW."withdrawnByName" IS NULL
       OR NEW."withdrawReason" IS NULL OR btrim(NEW."withdrawReason", E' \t\n\x0B\f\r') = '' THEN
      RAISE EXCEPTION 'phase6-t4a: a withdrawn decision must carry withdrawnAt, withdrawnById, withdrawnByName and a non-blank withdrawReason (decision %)', NEW."id";
    END IF;
    IF NEW."publishedAt" IS NULL THEN
      RAISE EXCEPTION 'phase6-t4a: a withdrawn decision must remain PUBLISHED — the register keeps the record (decision %)', NEW."id";
    END IF;
  ELSE
    IF NEW."withdrawnAt" IS NOT NULL OR NEW."withdrawnById" IS NOT NULL
       OR NEW."withdrawnByName" IS NOT NULL OR NEW."withdrawReason" IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-t4a: withdrawal evidence may exist only on a withdrawn decision (decision %)', NEW."id";
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Decision_t4a_c_coherent" ON "Decision";
CREATE TRIGGER "Decision_t4a_c_coherent"
  BEFORE INSERT OR UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4a_withdrawn_coherent();

-- ── seal 3 (forward arm): entry ONLY from a published `pending` row ──────────────────────────
-- Register emptiness is NOT proof of never-approved on legacy data: the Phase-3 approval-history
-- backfill (PR #192) deliberately left UNPROVABLE legacy approvals without a
-- DecisionApprovalRevision row, so an `approved` decision with an empty register exists, and
-- hostile SQL could otherwise withdraw it — with a real actor and a non-blank reason — hiding a
-- decision that carries approval evidence. The SOURCE STATE is therefore the guard; the
-- register-emptiness check stays as the second arm (belt-and-braces where BOTH facts exist).
-- A row can also not be BORN withdrawn: an INSERT has no published-pending prior state.
CREATE OR REPLACE FUNCTION phase6_t4a_withdraw_entry() RETURNS trigger AS $fn$
DECLARE approvals BIGINT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status"::text = 'withdrawn' THEN
      RAISE EXCEPTION 'phase6-t4a: a decision cannot be created withdrawn (decision %)', NEW."id";
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status"::text = 'withdrawn' AND OLD."status"::text <> 'withdrawn' THEN
    IF OLD."status"::text <> 'pending' OR OLD."publishedAt" IS NULL THEN
      RAISE EXCEPTION 'phase6-t4a: only a published pending decision can be withdrawn (decision %, status %, published %)', OLD."id", OLD."status", (OLD."publishedAt" IS NOT NULL);
    END IF;
    SELECT count(*) INTO approvals FROM "DecisionApprovalRevision" WHERE "decisionId" = OLD."id";
    IF approvals > 0 THEN
      RAISE EXCEPTION 'phase6-t4a: decision % carries % approval revision(s) — it can never be withdrawn', OLD."id", approvals;
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Decision_t4a_b_entry" ON "Decision";
CREATE TRIGGER "Decision_t4a_b_entry"
  BEFORE INSERT OR UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4a_withdraw_entry();

-- ── seal 3 (reverse arm): no approval revision against a withdrawn decision ──────────────────
-- Takes the DECISION ROW LOCK (`FOR UPDATE`) before reading its status — a plain READ COMMITTED
-- read would race an uncommitted withdrawal (the insert sees the old 'pending', both commit,
-- contradiction). With the lock, the two orderings serialize: insert-first holds the row lock so
-- the withdraw's CAS waits and then (via the forward arm's register count, which sees the
-- committed row) refuses; withdraw-first holds the row lock so this trigger waits and then sees
-- 'withdrawn' and refuses. Exactly one side ever commits — the Phase-4 bound-3 precedent.
CREATE OR REPLACE FUNCTION phase6_t4a_no_approval_after_withdraw() RETURNS trigger AS $fn$
DECLARE dstatus TEXT;
BEGIN
  SELECT d."status"::text INTO dstatus FROM "Decision" d WHERE d."id" = NEW."decisionId" FOR UPDATE;
  IF dstatus = 'withdrawn' THEN
    RAISE EXCEPTION 'phase6-t4a: decision % is withdrawn — an approval revision can no longer be recorded', NEW."decisionId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "DecisionApprovalRevision_no_withdrawn" ON "DecisionApprovalRevision";
CREATE TRIGGER "DecisionApprovalRevision_no_withdrawn"
  BEFORE INSERT ON "DecisionApprovalRevision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4a_no_approval_after_withdraw();
