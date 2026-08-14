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
  -- Round 6 (Codex): the register is NOT the only approval evidence. The PR-#192 legacy class
  -- holds approvals whose only trace is DecisionEvent rows and/or the approval columns (an
  -- EMPTY DecisionApprovalRevision register), and the entry trigger cannot recover a
  -- hand-flipped row's source status after the fact. A withdrawn row carrying ANY approval
  -- signal is quarantined here, never accepted.
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT d."id" FROM "Decision" d
    WHERE d."status"::text = 'withdrawn'
      AND (d."approvedById" IS NOT NULL OR d."approver" IS NOT NULL OR d."approvedOption" IS NOT NULL
           OR EXISTS (SELECT 1 FROM "DecisionEvent" e
                       WHERE e."decisionId" = d."id" AND e."type" IN ('approved', 'reapproved')))
    LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t4a: % withdrawn decision(s) carry LEGACY approval signals (approval columns or approved/reapproved events, with or without register rows) — a decision with approval evidence can never be withdrawn (sample: %). Resolve by hand, then redeploy.', bad, sample;
  END IF;
  -- Round 9 (Codex): existence is not standing — a pre-existing withdrawn row attributed to a
  -- membership that is not ACTIVE is quarantined (the FK proves the row exists; the command
  -- requires the standing at withdrawal time; a hand-minted attribution to a removed member is
  -- a false permanent record). Stated honestly for re-runs: after 4a is live, a LEGITIMATE
  -- withdrawal whose member was since removed would also be flagged on a repair re-run — the
  -- named remedy (restore the membership or resolve the row) covers both readings, and the
  -- migration only re-runs inside operator repair flows.
  -- Round 12 (Codex): the standing requirement is ACTIVE **pmc** — active membership alone is
  -- not the authority the command requires (live authz derives the token role from this row).
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT d."id" FROM "Decision" d
    JOIN "Membership" m ON m."projectId" = d."projectId" AND m."userId" = d."withdrawnById"
    WHERE d."status"::text = 'withdrawn' AND (m."status" <> 'active' OR m."role" <> 'pmc')
    LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t4a: % withdrawn decision(s) are attributed to a NON-ACTIVE membership or one without pmc standing (sample: %). Restore the membership or resolve the row by hand, then redeploy.', bad, sample;
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

-- Round 4 (Codex): a decision ALREADY withdrawn when this migration runs — the coherent
-- partial/manual-apply shape the diagnostics deliberately ACCEPT — will never see a future
-- `decisions.withdraw` command, so the cancellation that command performs is executed HERE
-- for its queued announcements, with the command's exact semantics: a pending row is
-- neutralized in place (succeeded/noop, payload preserved for audit), a leased/dead row keeps
-- its status and receives only the mark (the sender's pre-send re-check / an operator redrive
-- turns it into a recorded noop). Compared as ::text (this file adds the enum value; on a
-- first apply no row can hold it, so this is a no-op there). Idempotent via the
-- `cancelledAt IS NULL` guard — rerunnable by design like the whole file.
UPDATE "OutboxDelivery" d
SET "status" = 'succeeded', "deliveryAction" = 'noop', "cancelledAt" = now(),
    "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "lastError" = NULL, "updatedAt" = now()
FROM "DomainEvent" e, "Decision" dec
WHERE e."eventId" = d."eventId"
  AND d."consumer" = 'webpush.notify'
  AND d."status" = 'pending'
  AND d."cancelledAt" IS NULL
  AND e."eventType" = 'decision.published'
  AND dec."id" = e."entityId" AND dec."projectId" = e."projectId"
  AND dec."status"::text = 'withdrawn';
UPDATE "OutboxDelivery" d
SET "cancelledAt" = now(), "updatedAt" = now()
FROM "DomainEvent" e, "Decision" dec
WHERE e."eventId" = d."eventId"
  AND d."consumer" = 'webpush.notify'
  AND d."status" IN ('leased', 'dead')
  AND d."cancelledAt" IS NULL
  AND e."eventType" = 'decision.published'
  AND dec."id" = e."entityId" AND dec."projectId" = e."projectId"
  AND dec."status"::text = 'withdrawn';
-- Round 5 (Codex): the same withdrawal's RECOVERY-GAP arm. An already-withdrawn decision's
-- `decision.published` event can sit in the crash/rolling-deploy gap with NO delivery row at
-- all; the two updates above touch only rows that exist, so the next relay recovery pass
-- would materialize the missing delivery as PENDING — and no future `decisions.withdraw`
-- command will ever run to cancel it. So the migration writes the same cancelled tombstone
-- the runtime cancellation writes (succeeded/noop, cancelledAt, subject from the event's own
-- entityId, no payload was ever built), guarded on the catalog contract row exactly like the
-- runtime arm, idempotent via NOT EXISTS + ON CONFLICT DO NOTHING. A LIVE decision's gap
-- event is deliberately untouched — recovery legitimately owes it a pending delivery.
INSERT INTO "OutboxDelivery"
  ("id","eventId","projectId","consumer","consumerKind","deliveryAction",
   "streamPosition","status","subject","cancelledAt","nextAttemptAt","createdAt","updatedAt")
SELECT gen_random_uuid()::text, e."eventId", e."projectId", 'webpush.notify', 'unordered', 'noop',
       e."streamPosition", 'succeeded', e."entityId", now(), now(), now(), now()
FROM "DomainEvent" e
JOIN "Decision" dec ON dec."id" = e."entityId" AND dec."projectId" = e."projectId"
WHERE e."eventType" = 'decision.published'
  AND dec."status"::text = 'withdrawn'
  AND EXISTS (SELECT 1 FROM "OutboxConsumerCatalog" c
               WHERE c."consumer" = 'webpush.notify' AND c."consumerKind" = 'unordered')
  AND NOT EXISTS (SELECT 1 FROM "OutboxDelivery" d
                   WHERE d."eventId" = e."eventId" AND d."consumer" = 'webpush.notify')
ON CONFLICT DO NOTHING;

-- Round 8 (Codex): a pre-withdrawn decision's OTHER stale surfaces, with the command's exact
-- semantics — no future `decisions.withdraw` will ever run for it.
-- (a) NOTICES: the stamped pending bell row retires by IDENTITY AND the pending text shape; a
-- LEGACY unstamped row retires by the canonical text shape (`pendingDecisionNotice`:
-- 'Decision awaiting approval: <title>'), multiplicity-guarded exactly like the command — if
-- another still-pending published decision shares the title, the text is ambiguous and the
-- row is LEFT, never guessed at. Idempotent (DELETEs).
-- Round 14 (Codex): identity alone over-reached — the withdraw COMMAND writes a
-- decisionId-stamped WITHDRAWAL notice (`withdrawnDecisionNotice`), so a bare identity delete
-- erased the withdrawal record's own notice on every operator re-run of this rerunnable file.
-- The retire arm's job is the stale PENDING bell; the shape predicate makes a re-run after
-- legitimate withdrawals a no-op on their notices.
DELETE FROM "Notification" n
USING "Decision" dec
WHERE n."projectId" = dec."projectId" AND n."decisionId" = dec."id"
  AND dec."status"::text = 'withdrawn'
  AND n."text" LIKE 'Decision awaiting approval:%';
DELETE FROM "Notification" n
USING "Decision" dec
WHERE n."projectId" = dec."projectId"
  AND n."decisionId" IS NULL
  AND dec."status"::text = 'withdrawn'
  AND n."text" = 'Decision awaiting approval: ' || dec."title"
  AND NOT EXISTS (
    SELECT 1 FROM "Decision" o
     WHERE o."projectId" = dec."projectId" AND o."title" = dec."title"
       AND o."status"::text = 'pending' AND o."publishedAt" IS NOT NULL
       AND o."id" <> dec."id");
-- (b) PROJECTIONS: the partial apply emitted no DomainEvent, so a servable `decisions.inbox`
-- generation can still claim the row is pending while `readServableGeneration` calls it
-- caught-up. Round 12 (Codex): retiring WITHOUT a replacement wedged the consumer — the next
-- delivery bootstrapped a fresh generation at `appliedPosition = NULL` (expecting position 0)
-- while the stream is at head+1, releasing every delivery as 'wait' forever. So the stale
-- generation is RETIRED and REPLACED in one step: the replacement copies the retired
-- generation's rows AND its `appliedPosition` VERBATIM (the withdrawal emitted no event, so
-- the checkpoint is still exact), correcting ONLY the withdrawn rows to canonical truth (the
-- same three-key dto extension `serializeDecision` writes — pinned by the integration probe's
-- projection==live slice equality). Scoped to STALE pairs (an active generation whose
-- projection row still claims a withdrawn decision is not withdrawn), so a re-run — or a run
-- after normal operation resumed — is a no-op.
DO $mig$
DECLARE
  g RECORD;
  newid TEXT;
BEGIN
  FOR g IN
    SELECT pg."id", pg."consumer", pg."projectId", pg."appliedPosition"
      FROM "ProjectionGeneration" pg
     WHERE pg."consumer" = 'decisions.inbox' AND pg."status" = 'active'
       AND EXISTS (
         -- stale = a withdrawn decision this generation either claims is NOT withdrawn or has
         -- no row for at all (a generation that never applied the decision is equally stale)
         SELECT 1 FROM "Decision" d
          WHERE d."projectId" = pg."projectId"
            AND d."status"::text = 'withdrawn'
            AND NOT EXISTS (
              SELECT 1 FROM "DecisionProjection" dp
               WHERE dp."generationId" = pg."id" AND dp."decisionId" = d."id"
                 AND dp."status" = 'withdrawn'))
  LOOP
    UPDATE "ProjectionGeneration" SET "status" = 'retired', "updatedAt" = now() WHERE "id" = g."id";
    newid := gen_random_uuid()::text;
    INSERT INTO "ProjectionGeneration"
      ("id", "consumer", "projectId", "generation", "status", "appliedPosition", "cursorStatus", "activatedAt", "createdAt", "updatedAt")
    SELECT newid, g."consumer", g."projectId",
           (SELECT COALESCE(MAX("generation"), 0) + 1 FROM "ProjectionGeneration" WHERE "consumer" = g."consumer" AND "projectId" = g."projectId"),
           'active', g."appliedPosition", 'live', now(), now(), now();
    INSERT INTO "DecisionProjection"
      ("id", "generationId", "projectId", "decisionId", "status", "publishedAt", "authorId", "dto", "updatedAt")
    SELECT gen_random_uuid()::text, newid, dp."projectId", dp."decisionId",
           CASE WHEN d."status"::text = 'withdrawn' THEN 'withdrawn' ELSE dp."status" END,
           dp."publishedAt", dp."authorId",
           CASE WHEN d."status"::text = 'withdrawn'
                THEN dp."dto"::jsonb || jsonb_build_object(
                       'status', 'withdrawn',
                       'withdrawnAt', to_char(d."withdrawnAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                       'withdrawnBy', d."withdrawnByName",
                       'withdrawReason', d."withdrawReason")
                ELSE dp."dto"::jsonb END,
           now()
      FROM "DecisionProjection" dp
      JOIN "Decision" d ON d."id" = dp."decisionId"
     WHERE dp."generationId" = g."id";
    -- Round 13 (Codex): the copy above can only CORRECT rows that exist — the never-applied
    -- shape (a withdrawn decision with NO projection row, a case the stale predicate itself
    -- names) would otherwise produce a caught-up replacement that still omits the withdrawal,
    -- and projectionSlice() would serve it as complete. The missing rows are seeded from
    -- CANONICAL truth, composing the dto exactly as serializeDecision writes it: nullable
    -- columns are ABSENT when NULL (the `?? undefined` mappings), photoSwatch/draft/options
    -- always present, options ordered by "order" with photoUrl absent when null — pinned by
    -- the probe's storedDecisionRows == computeDecisionRows equality.
    INSERT INTO "DecisionProjection"
      ("id", "generationId", "projectId", "decisionId", "status", "publishedAt", "authorId", "dto", "updatedAt")
    SELECT gen_random_uuid()::text, newid, d."projectId", d."id", 'withdrawn', d."publishedAt", d."authorId",
           (jsonb_build_object(
              'id', d."id",
              'title', d."title",
              'room', d."room",
              'status', 'withdrawn',
              'draft', (d."publishedAt" IS NULL),
              'photoSwatch', d."photoSwatch",
              'options', COALESCE((
                SELECT jsonb_agg(
                         jsonb_build_object(
                           'label', o."label", 'key', o."optionKey", 'material', o."material",
                           'delta', o."delta", 'swatch', o."swatch", 'recommended', o."recommended")
                         || CASE WHEN o."photoUrl" IS NOT NULL THEN jsonb_build_object('photoUrl', o."photoUrl") ELSE '{}'::jsonb END
                         ORDER BY o."order" ASC)
                  FROM "DecisionOption" o WHERE o."decisionId" = d."id"), '[]'::jsonb)))
           || CASE WHEN d."nodeId" IS NOT NULL THEN jsonb_build_object('nodeId', d."nodeId") ELSE '{}'::jsonb END
           || CASE WHEN d."ageDays" IS NOT NULL THEN jsonb_build_object('ageDays', d."ageDays") ELSE '{}'::jsonb END
           || CASE WHEN d."approvedOption" IS NOT NULL THEN jsonb_build_object('approvedOption', d."approvedOption") ELSE '{}'::jsonb END
           || CASE WHEN d."material" IS NOT NULL THEN jsonb_build_object('material', d."material") ELSE '{}'::jsonb END
           || CASE WHEN d."approver" IS NOT NULL THEN jsonb_build_object('approver', d."approver") ELSE '{}'::jsonb END
           || CASE WHEN d."onBehalfOf" IS NOT NULL THEN jsonb_build_object('onBehalfOf', d."onBehalfOf") ELSE '{}'::jsonb END
           || CASE WHEN d."date" IS NOT NULL THEN jsonb_build_object('date', d."date") ELSE '{}'::jsonb END
           || CASE WHEN d."cost" IS NOT NULL THEN jsonb_build_object('cost', d."cost") ELSE '{}'::jsonb END
           || CASE WHEN d."withdrawnAt" IS NOT NULL THEN jsonb_build_object('withdrawnAt', to_char(d."withdrawnAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE '{}'::jsonb END
           || CASE WHEN d."withdrawnByName" IS NOT NULL THEN jsonb_build_object('withdrawnBy', d."withdrawnByName") ELSE '{}'::jsonb END
           || CASE WHEN d."withdrawReason" IS NOT NULL THEN jsonb_build_object('withdrawReason', d."withdrawReason") ELSE '{}'::jsonb END,
           now()
      FROM "Decision" d
     WHERE d."projectId" = g."projectId" AND d."status"::text = 'withdrawn'
       AND NOT EXISTS (
         SELECT 1 FROM "DecisionProjection" dp2
          WHERE dp2."generationId" = g."id" AND dp2."decisionId" = d."id");
  END LOOP;
END $mig$;

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
    -- Round 4 (Codex): the PROJECT identity is part of the frozen record too. Re-pointing
    -- projectId at another project where the same withdrawer happens to be an active member
    -- passes the attribution FK while the permanent record vanishes from the original
    -- project's PMC register — the row must stay on the register it was withdrawn from.
    IF NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
      RAISE EXCEPTION 'phase6-t4a: a withdrawn decision stays on its project''s register — projectId is frozen (decision %)', OLD."id";
    END IF;
    -- Round 9 (Codex): the QUESTION identity is part of the frozen record — retitling or
    -- relocating a withdrawn row attaches the frozen actor/reason to a DIFFERENT register
    -- entry ("Kitchen counter" was withdrawn; the row now says something else was).
    -- Round 12 (Codex): the primary `id` joins the frozen set — every child FK is ON UPDATE
    -- CASCADE, so re-keying the row would drag the children to a new key and the register
    -- would no longer hold the withdrawn entry under the id that was actually issued.
    IF NEW."title" IS DISTINCT FROM OLD."title" OR NEW."room" IS DISTINCT FROM OLD."room"
       OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId" OR NEW."id" IS DISTINCT FROM OLD."id" THEN
      RAISE EXCEPTION 'phase6-t4a: a withdrawn decision''s question identity is frozen — id/title/room/nodeId cannot change (decision %)', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Decision_t4a_a_terminal" ON "Decision";
CREATE TRIGGER "Decision_t4a_a_terminal"
  BEFORE UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4a_withdrawn_terminal();

-- ── seal 1 (delete arm): the register entry cannot be ERASED either ──────────────────────────
-- Round 3 (Codex): the update arm freezes a withdrawn row's evidence, but DELETE was the other
-- way to remove it — hostile SQL that clears the children first loses the withdrawn status,
-- actor, time and reason from the pmc-visible register. BEFORE DELETE fires before FK
-- evaluation, so this refusal never depends on what children remain. TRUNCATE (the sanctioned
-- disposable-database reset) fires no row-level trigger, and the two destructive resets that
-- wipe decisions (prisma/seed.ts; the t4a suite's own cleanup) disable this trigger BY NAME
-- under the same contract that lets them TRUNCATE the append-only DomainEvent store.
CREATE OR REPLACE FUNCTION phase6_t4a_withdrawn_no_delete() RETURNS trigger AS $fn$
BEGIN
  IF OLD."status"::text = 'withdrawn' THEN
    RAISE EXCEPTION 'phase6-t4a: a withdrawn decision is a permanent register entry — it cannot be deleted (decision %)', OLD."id";
  END IF;
  RETURN OLD;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "Decision_t4a_d_no_delete" ON "Decision";
CREATE TRIGGER "Decision_t4a_d_no_delete"
  BEFORE DELETE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4a_withdrawn_no_delete();

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
    -- Round 7 (Codex): the entry guard judges the OLD row and the register; a single statement
    -- could ADD the legacy approval columns while entering withdrawal, and the terminal freeze
    -- covers only the withdrawal columns. Coherence judges every withdrawn NEW row, so the
    -- contradiction is unrepresentable on entry AND on any later write to a withdrawn row —
    -- the same signals the round-6 migration diagnostic quarantines in pre-existing data.
    IF NEW."approvedById" IS NOT NULL OR NEW."approver" IS NOT NULL OR NEW."approvedOption" IS NOT NULL THEN
      RAISE EXCEPTION 'phase6-t4a: a withdrawn decision cannot carry approval evidence (approvedById/approver/approvedOption) — the register would contradict the withdrawal (decision %)', NEW."id";
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
    -- Round 7 (Codex): the round-4 freeze fires only when OLD.status is already withdrawn, so
    -- ONE statement could withdraw AND move the row to a project where the withdrawer holds a
    -- membership — the FK passes, the record vanishes from the original register. The entry
    -- transition carries the freeze too.
    IF NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
      RAISE EXCEPTION 'phase6-t4a: a withdrawal cannot move the decision — projectId is frozen on entry (decision %)', OLD."id";
    END IF;
    -- Round 9 (Codex): the withdrawing statement cannot rewrite the QUESTION either — the
    -- entry-transition twin of the terminal identity freeze (the command's CAS only ever
    -- writes the status and the evidence columns). Round 12: `id` joins the entry freeze too
    -- (the terminal arm's re-key refusal, applied to the withdrawing statement itself).
    IF NEW."title" IS DISTINCT FROM OLD."title" OR NEW."room" IS DISTINCT FROM OLD."room"
       OR NEW."nodeId" IS DISTINCT FROM OLD."nodeId" OR NEW."id" IS DISTINCT FROM OLD."id" THEN
      RAISE EXCEPTION 'phase6-t4a: a withdrawal cannot rewrite the question — the identity is frozen on entry (decision %)', OLD."id";
    END IF;
    -- Round 12 (Codex): the CHOICES are part of the question the withdrawer takes back. The
    -- option seal judges option writes against the parent's status AT THE TIME OF THE WRITE,
    -- so ONE transaction could edit the published options and then withdraw. The option touch
    -- trigger (below) leaves a per-transaction note naming every decision whose options this
    -- transaction wrote — UPDATE, INSERT and DELETE alike — and a withdrawal of a noted
    -- decision refuses: the command never touches options, so no legitimate withdrawal trips
    -- this. (A pre-withdrawal edit in an EARLIER transaction is outside this seal's scope —
    -- tampering with a LIVE pending question is client-visible and its own problem; what can
    -- never happen is the WITHDRAWING statement swapping the question it freezes.)
    -- Round 13 (Codex): the note lived in pg_temp, which the SAME session could DROP with no
    -- privilege on the app schema at all — erasing the evidence between the edit and the
    -- withdraw. It now lives in the REAL "DecisionOptionTouch" table (below), keyed by
    -- txid_current() — the TOP-LEVEL transaction id, so a SAVEPOINT cannot detach the note
    -- from its write (they share the same subtransaction fate) — and its guard refuses
    -- same-transaction erasure. Same-tx rows are always visible, so a plain read suffices.
    IF EXISTS (SELECT 1 FROM "DecisionOptionTouch" tn WHERE tn."decisionId" = NEW."id" AND tn."txid" = txid_current()) THEN
      RAISE EXCEPTION 'phase6-t4a: the decision''s options were modified in the withdrawing transaction — the frozen question must be the question that was published (decision %)', OLD."id";
    END IF;
    -- Round 9 (Codex): existence is not standing. The attribution FK proves the membership
    -- ROW; the command requires it ACTIVE (the locked participant check). Guarded on NOT NULL
    -- so an evidence-less withdrawal still falls through to coherence's own message.
    -- Round 10 (Codex): the read LOCKS the membership row (`FOR UPDATE`) so it serializes
    -- with a concurrent status flip: a removal committing mid-withdrawal now either waits
    -- for the withdrawal (attribution was active AT commit) or, having won the lock, makes
    -- this re-evaluated read see 'removed' and refuse. The service path already holds this
    -- lock (OrgsParticipant.lockActiveMembership), so re-locking there is a no-op.
    -- Round 12 (Codex): active membership is not AUTHORITY — `decisions.withdraw` is a pmc
    -- command and live authz derives the token role FROM the membership row, so the attributed
    -- member must hold ACTIVE pmc standing, not merely an active row of any role.
    IF NEW."withdrawnById" IS NOT NULL THEN
      PERFORM 1 FROM "Membership" m
       WHERE m."projectId" = NEW."projectId" AND m."userId" = NEW."withdrawnById" AND m."status" = 'active' AND m."role" = 'pmc'
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'phase6-t4a: a withdrawal must be attributed to an ACTIVE pmc member of the project (decision %, member %)', NEW."id", NEW."withdrawnById";
      END IF;
    END IF;
    IF OLD."status"::text <> 'pending' OR OLD."publishedAt" IS NULL THEN
      RAISE EXCEPTION 'phase6-t4a: only a published pending decision can be withdrawn (decision %, status %, published %)', OLD."id", OLD."status", (OLD."publishedAt" IS NOT NULL);
    END IF;
    SELECT count(*) INTO approvals FROM "DecisionApprovalRevision" WHERE "decisionId" = OLD."id";
    IF approvals > 0 THEN
      RAISE EXCEPTION 'phase6-t4a: decision % carries % approval revision(s) — it can never be withdrawn', OLD."id", approvals;
    END IF;
    -- Round 9 (Codex): the round-6 diagnostic establishes approved/reapproved DecisionEvents
    -- as approval evidence for the PR-#192 legacy class — the ENTRY seal must count them
    -- exactly as it counts the register, or a legacy-approved published-pending row could be
    -- withdrawn by direct SQL.
    SELECT count(*) INTO approvals FROM "DecisionEvent" e
     WHERE e."decisionId" = OLD."id" AND e."type" IN ('approved', 'reapproved');
    IF approvals > 0 THEN
      RAISE EXCEPTION 'phase6-t4a: decision % carries % legacy approval event(s) — it can never be withdrawn', OLD."id", approvals;
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

-- ── seal 3 (reverse arm, round 9): no LEGACY approval EVENT against a withdrawn decision ─────
-- The round-6 diagnostic establishes approved/reapproved DecisionEvents as approval evidence
-- for the PR-#192 legacy class; the reverse seal must reach them exactly as it reaches the
-- register. Same FOR UPDATE serialization as the revision arm; every other event type — the
-- register's own 'withdrawn' entry included — passes untouched.
-- Round 10 (Codex): the trigger covers UPDATE too — `DecisionEvent` carries no append-only
-- seal (unlike the register), so an existing benign event could otherwise be RE-POINTED
-- (`decisionId` and/or `type`) into approval evidence against a withdrawn decision. The
-- NEW-row check is the single rule for both verbs; benign updates on live decisions pass.
CREATE OR REPLACE FUNCTION phase6_t4a_no_approval_event_after_withdraw() RETURNS trigger AS $fn$
DECLARE dstatus TEXT;
BEGIN
  -- Round 12 (Codex): approval events are EVIDENCE the entry seal counts, so they must be as
  -- durable as the register — erasing one (DELETE) or downgrading its type would launder a
  -- PR-#192 legacy approval away and let the pending row be withdrawn afterwards. The
  -- sanctioned destructive resets disable this named trigger for exactly their wipe.
  IF TG_OP = 'DELETE' THEN
    IF OLD."type" IN ('approved', 'reapproved') THEN
      RAISE EXCEPTION 'phase6-t4a: event % is approval evidence — it cannot be deleted (decision %)', OLD."id", OLD."decisionId";
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."type" IN ('approved', 'reapproved') AND NEW."type" NOT IN ('approved', 'reapproved') THEN
    RAISE EXCEPTION 'phase6-t4a: event % is approval evidence — its type cannot be downgraded (decision %)', OLD."id", OLD."decisionId";
  END IF;
  IF NEW."type" IN ('approved', 'reapproved') THEN
    SELECT d."status"::text INTO dstatus FROM "Decision" d WHERE d."id" = NEW."decisionId" FOR UPDATE;
    IF dstatus = 'withdrawn' THEN
      RAISE EXCEPTION 'phase6-t4a: decision % is withdrawn — an approval event can no longer be recorded', NEW."decisionId";
    END IF;
  END IF;
  -- Round 13 (Codex): the type freeze alone left the event's DECISION mutable — an UPDATE
  -- keeping the approval type while changing `decisionId` re-points a legacy decision's only
  -- approval evidence at some other LIVE decision (the round-10 arm above judges only what it
  -- lands ON), and the pending row withdraws afterwards. Approval evidence stays with its
  -- decision; a non-approval event remains re-pointable. Placed AFTER the target check so a
  -- re-point onto a withdrawn decision keeps its established refusal.
  IF TG_OP = 'UPDATE' AND OLD."type" IN ('approved', 'reapproved') AND NEW."decisionId" IS DISTINCT FROM OLD."decisionId" THEN
    RAISE EXCEPTION 'phase6-t4a: event % is approval evidence — it cannot be re-pointed away from decision %', OLD."id", OLD."decisionId";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "DecisionEvent_no_withdrawn_approval" ON "DecisionEvent";
CREATE TRIGGER "DecisionEvent_no_withdrawn_approval"
  BEFORE INSERT OR UPDATE OR DELETE ON "DecisionEvent"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4a_no_approval_event_after_withdraw();

-- ── seal 5 (round 11, Codex — the frozen question includes its CHOICES) ──────────────────────
-- The option rows define what was asked: their count, materials, cost deltas and swatches ARE
-- the question the withdrawer took back. A withdrawn decision's `DecisionOption` rows are
-- frozen — no UPDATE, DELETE or INSERT while the parent is withdrawn (an UPDATE that re-points
-- an option ACROSS decisions is judged on BOTH parents). Same FOR UPDATE serialization as the
-- other reverse arms. The sanctioned destructive resets (the seed wipe, the test cleanups)
-- disable this named trigger for exactly their wipe, like `Decision_t4a_d_no_delete`.
CREATE OR REPLACE FUNCTION phase6_t4a_option_frozen_after_withdraw() RETURNS trigger AS $fn$
DECLARE dstatus TEXT;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    SELECT d."status"::text INTO dstatus FROM "Decision" d WHERE d."id" = OLD."decisionId" FOR UPDATE;
    IF dstatus = 'withdrawn' THEN
      RAISE EXCEPTION 'phase6-t4a: decision % is withdrawn — its options are part of the frozen question and cannot change', OLD."decisionId";
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW."decisionId" IS DISTINCT FROM OLD."decisionId") THEN
    SELECT d."status"::text INTO dstatus FROM "Decision" d WHERE d."id" = NEW."decisionId" FOR UPDATE;
    IF dstatus = 'withdrawn' THEN
      RAISE EXCEPTION 'phase6-t4a: decision % is withdrawn — its options are part of the frozen question and cannot change', NEW."decisionId";
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "DecisionOption_t4a_frozen" ON "DecisionOption";
CREATE TRIGGER "DecisionOption_t4a_frozen"
  BEFORE INSERT OR UPDATE OR DELETE ON "DecisionOption"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4a_option_frozen_after_withdraw();

-- Round 12 (Codex): the withdrawing TRANSACTION must not rewrite the question first. Every
-- option write leaves a per-transaction touch note naming the parent decision(s); the
-- withdrawal-entry seal refuses when the decision being withdrawn was touched in the SAME
-- transaction — catching UPDATE, INSERT and DELETE alike (xmin cannot see deleted rows).
-- Ordinary transactions never withdraw, so create-with-options, fixtures and the destructive
-- resets are untouched.
-- Round 13 (Codex): the round-12 note was an ON COMMIT DROP temp table — which the SAME
-- session could DROP with NO privilege on the app schema (a session owns its pg_temp
-- namespace), erasing the evidence between the edit and the withdraw. The note is now a REAL
-- table keyed by (decisionId, txid_current()):
--   - txid_current() is the TOP-LEVEL transaction id, so the note and the option write share
--     the same (sub)transaction fate — a SAVEPOINT rollback undoes both, a commit keeps both;
--   - the guard trigger below refuses erasing or rewriting a note in the transaction that
--     wrote it, so the only way around the seal is ALTER TABLE ... DISABLE TRIGGER — the same
--     OWNERSHIP privilege every sanctioned bypass in this seal network already requires
--     (dropping a pg_temp table required none, which was the finding);
--   - notes from COMMITTED transactions are inert history (the entry seal matches only the
--     CURRENT txid); they are swept by the decision's ON DELETE CASCADE, and a cascade (FK
--     depth > 1) passes the guard so the sanctioned destructive resets need no new bypass;
--   - the old pg_temp plan-cache footgun is gone with the temp table: a real table has a
--     stable oid, so plain static SQL is correct here.
CREATE TABLE IF NOT EXISTS "DecisionOptionTouch" (
  "decisionId" TEXT NOT NULL,
  "txid" BIGINT NOT NULL,
  CONSTRAINT "DecisionOptionTouch_pkey" PRIMARY KEY ("decisionId", "txid"),
  CONSTRAINT "DecisionOptionTouch_decisionId_fkey" FOREIGN KEY ("decisionId")
    REFERENCES "Decision"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE OR REPLACE FUNCTION phase6_t4a_touch_guard() RETURNS trigger AS $fn$
BEGIN
  -- pg_trigger_depth() = 1 is a DIRECT statement on the note table; a cascaded FK action
  -- (deleting or re-keying the decision itself) arrives at depth 2 and passes — erasing the
  -- decision row is a different act with its own seals, not a way to blind this one.
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'phase6-t4a: option touch notes are evidence rows — they cannot be updated (decision %)', OLD."decisionId";
  END IF;
  IF TG_OP = 'DELETE' AND OLD."txid" = txid_current() AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'phase6-t4a: the option touch note cannot be erased by the transaction that wrote it (decision %)', OLD."decisionId";
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "DecisionOptionTouch_guard" ON "DecisionOptionTouch";
CREATE TRIGGER "DecisionOptionTouch_guard"
  BEFORE UPDATE OR DELETE ON "DecisionOptionTouch"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4a_touch_guard();

CREATE OR REPLACE FUNCTION phase6_t4a_option_touch_note() RETURNS trigger AS $fn$
BEGIN
  -- OLD is a NULL RECORD on INSERT and NEW on DELETE (plpgsql-trigger docs: "This variable is
  -- null in statement-level triggers and for INSERT operations") — a field of a null record
  -- reads as NULL, never an error, so the COALESCE lands on the populated side. Round 13
  -- claimed this raises; refuted by execution — probe R13-F1 runs both verbs through this
  -- trigger and asserts their notes.
  INSERT INTO "DecisionOptionTouch"("decisionId", "txid")
  VALUES (COALESCE(OLD."decisionId", NEW."decisionId"), txid_current())
  ON CONFLICT DO NOTHING;
  IF TG_OP = 'UPDATE' AND NEW."decisionId" IS DISTINCT FROM OLD."decisionId" THEN
    INSERT INTO "DecisionOptionTouch"("decisionId", "txid")
    VALUES (NEW."decisionId", txid_current())
    ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS "DecisionOption_t4a_touch" ON "DecisionOption";
CREATE TRIGGER "DecisionOption_t4a_touch"
  AFTER INSERT OR UPDATE OR DELETE ON "DecisionOption"
  FOR EACH ROW EXECUTE FUNCTION phase6_t4a_option_touch_note();
