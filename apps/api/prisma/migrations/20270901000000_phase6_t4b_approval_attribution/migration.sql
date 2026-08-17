-- Phase 6 task 4b — APPROVAL ATTRIBUTION AND ITS EVIDENCE (database unit).
--
-- One question: when this register says a decision was approved, can it say BY WHOM, and can
-- that answer be trusted afterwards? This migration installs the columns that hold the answer,
-- the references that keep them inside one project, the one-time record of which approvals have
-- no answer because they predate the columns, and the rules that stop any of it from being
-- rewritten, deleted or truncated away.
--
-- ── THIS IS THE EXPANSION PHASE, AND THAT IS A DELIBERATE LIMIT ──────────────────────────────
--
-- Every release now in production approves a decision WITHOUT writing an attribution tuple
-- (`decisions.service.ts` sets status/approvedOption/approver/approvedById and nothing else, in
-- both `approve` and `withdrawChange`). During a rolling deploy the old release keeps serving
-- while this migration is already applied. So the one rule this unit does NOT install is the
-- obvious one:
--
--     "a decision may not become `approved` unless it records who approved it"
--
-- That rule would turn every approval made by the still-running old release into a 500. It
-- belongs with the writer, in the enforcement phase, and the required sequence is written down in
-- `docs/RUNBOOK.md` §P6-4B-DB. Everything installed here is safe against the old release because
-- the old release never writes these columns, never deletes a `Decision` and never truncates one
-- (verified against `origin/main`: no delete or truncate path for `Decision` exists in
-- `apps/api/src`, `packages/shared` or `apps/web/src`).
--
-- What that buys: the tuple is FK-correct, project-contained, complete-or-absent and write-once
-- from the day this lands, so when the writer arrives it cannot introduce a malformed attribution
-- even by accident, and the legacy set is already closed and unforgeable.
--
-- ── WHY THE LEGACY STAMP IS A TABLE AND NOT A PREDICATE ──────────────────────────────────────
--
-- After this migration, "this approval has no decider tuple" and "someone stripped this
-- approval's decider tuple" leave IDENTICAL rows behind. The difference cannot be recovered from
-- the `Decision` row, and any rule that infers it from evidence a caller can write is a rule a
-- caller can defeat. A migration is the one writer nothing can impersonate. So the exemption is
-- MEMBERSHIP of a table written exactly once, here, and sealed immediately afterwards.

-- ── 1. The decider enum ──────────────────────────────────────────────────────────────────────
-- 'architect' is deliberately absent: it arrives with the role itself, and a database that
-- accepted an architect decider before anyone can authenticate as one would admit decisions no
-- one can see or approve.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DeciderKind') THEN
    CREATE TYPE "DeciderKind" AS ENUM ('client', 'pmc', 'member', 'none');
  END IF;
END $$;

-- ── 2. The columns ───────────────────────────────────────────────────────────────────────────
-- `deciderKind` carries a DEFAULT so existing rows need no rewrite (PostgreSQL stores the default
-- in the catalog rather than touching every row) and the old release, which never mentions the
-- column, keeps inserting legal rows. The five columns are otherwise nullable: an approval made
-- before today genuinely has no attribution, and inventing one is the forgery this unit exists to
-- prevent.
ALTER TABLE "Decision"
  ADD COLUMN IF NOT EXISTS "deciderKind" "DeciderKind" NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS "deciderMembershipId" TEXT,
  ADD COLUMN IF NOT EXISTS "approvedDeciderKind" "DeciderKind",
  ADD COLUMN IF NOT EXISTS "approvedDeciderMembershipId" TEXT,
  ADD COLUMN IF NOT EXISTS "approvedDeciderLabel" TEXT;

-- ── 3. The FK target, and the two references that use it ─────────────────────────────────────
-- `Membership.id` is already the primary key, so uniqueness over (projectId, id) is implied and
-- this index cannot fail on existing data. It exists so that (projectId, membershipId) is a legal
-- FK target — which is what makes a CROSS-PROJECT decider unrepresentable rather than merely
-- unwritten. Both references carry the row's own `projectId`, so pointing a decision at another
-- project's member is a foreign-key violation, not a code review.
CREATE UNIQUE INDEX IF NOT EXISTS "Membership_projectId_id_key" ON "Membership" ("projectId", "id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Decision_projectId_deciderMembershipId_fkey') THEN
    ALTER TABLE "Decision"
      ADD CONSTRAINT "Decision_projectId_deciderMembershipId_fkey"
      FOREIGN KEY ("projectId", "deciderMembershipId") REFERENCES "Membership" ("projectId", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  -- The FROZEN act needs the same containment. Its membership is history, so NO ACTION is the
  -- only correct behaviour: removing a member must not silently rewrite who approved something.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Decision_projectId_approvedDeciderMembershipId_fkey') THEN
    ALTER TABLE "Decision"
      ADD CONSTRAINT "Decision_projectId_approvedDeciderMembershipId_fkey"
      FOREIGN KEY ("projectId", "approvedDeciderMembershipId") REFERENCES "Membership" ("projectId", "id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Decision_deciderMembershipId_idx"
  ON "Decision" ("projectId", "deciderMembershipId") WHERE "deciderMembershipId" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "Decision_approvedDeciderMembershipId_idx"
  ON "Decision" ("projectId", "approvedDeciderMembershipId") WHERE "approvedDeciderMembershipId" IS NOT NULL;

-- ── 4. Shape CHECKs — a half-written attribution is not a fact ────────────────────────────────
-- Every existing row satisfies all three: `deciderKind` defaults to 'client' with a NULL
-- membership, and the approved tuple is entirely NULL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Decision_t4b_decider_pair_check') THEN
    ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b_decider_pair_check" CHECK (
      ("deciderKind" = 'member' AND "deciderMembershipId" IS NOT NULL)
      OR ("deciderKind" <> 'member' AND "deciderMembershipId" IS NULL)
    );
  END IF;
  -- The act is entirely absent, or entirely present. A kind with no label is an attribution that
  -- cannot be displayed, which in a register is the same as no attribution while looking like one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Decision_t4b_approved_decider_pair_check') THEN
    ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b_approved_decider_pair_check" CHECK (
      "approvedDeciderKind" IS NULL
      OR ("approvedDeciderLabel" IS NOT NULL
          AND (("approvedDeciderKind" = 'member' AND "approvedDeciderMembershipId" IS NOT NULL)
               OR ("approvedDeciderKind" <> 'member' AND "approvedDeciderMembershipId" IS NULL)))
    );
  END IF;
  -- …and the two halves of the act cannot appear without the kind that types them.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Decision_t4b_approved_decider_orphan_check') THEN
    ALTER TABLE "Decision" ADD CONSTRAINT "Decision_t4b_approved_decider_orphan_check" CHECK (
      "approvedDeciderKind" IS NOT NULL
      OR ("approvedDeciderMembershipId" IS NULL AND "approvedDeciderLabel" IS NULL)
    );
  END IF;
END $$;

-- ── 5. The one-time legacy record ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "DecisionLegacyApproval" (
  "decisionId" TEXT NOT NULL,
  "stampedAt"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "DecisionLegacyApproval_pkey" PRIMARY KEY ("decisionId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DecisionLegacyApproval_decisionId_fkey') THEN
    ALTER TABLE "DecisionLegacyApproval"
      ADD CONSTRAINT "DecisionLegacyApproval_decisionId_fkey"
      FOREIGN KEY ("decisionId") REFERENCES "Decision" ("id")
      ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;

-- The stamp set: every decision that HAS BEEN APPROVED and carries no attribution tuple. At this
-- point in the migration the tuple columns were created seconds ago, so the second half is true
-- of every row and the set is exactly "has been approved".
--
-- "Has been approved" is read from FIVE independent traces rather than from `status` alone,
-- because a decision does not stay `approved`:
--   * status='approved'  — approved and locked right now
--   * status='change'    — approved, then reopened; `raiseChange` requires 'approved', so a
--                          `change` row is proof of a past approval, not of a pending one
--   * approvedById       — Phase 1 attribution on the row itself
--   * an approval REVISION — the immutable register, one row per approve/reapprove
--   * an approved/reapproved EVENT — the ledger
-- Any one of them is enough. Over-reaching here would exempt a decision that was never approved;
-- under-reaching would refuse a genuine legacy approval forever. The closing verification block
-- asserts the set is exactly this predicate, so a future edit that changes one and not the other
-- fails the deploy instead of shipping a silent difference.
-- ── FIRST APPLICATION ONLY, and that gate is load-bearing twice over ─────────────────────────
-- The set must close at the first application, so a re-run has to be a NO-OP rather than a second
-- stamping pass. Two distinct things go wrong without this gate:
--
--   1. The `DecisionLegacyApproval_sealed` trigger below refuses every INSERT once installed, and
--      PostgreSQL fires BEFORE INSERT row triggers BEFORE it resolves `ON CONFLICT`. A re-run
--      would therefore RAISE rather than quietly do nothing — the migration would stop being
--      re-runnable, which this repository proves for its migrations rather than assumes.
--   2. Worse, if it did run again it would stamp approvals made SINCE the first application by the
--      still-deployed old writer. Those approvals are not pre-attribution — they are exactly the
--      ones the enforcement phase must come back and fix. Stamping them would forgive them
--      permanently and silently, which is the opposite of what this table is for.
--
-- The existence of that trigger is the marker: it can only be there because a previous run got
-- past this point. The verification block at the end is gated the same way and for reason (2) —
-- on a re-run those legitimately-unstamped new approvals would make it abort spuriously.
DO $$
DECLARE v_stamped INT; v_missing INT; v_extra INT; v_sample TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'DecisionLegacyApproval_sealed' AND NOT tgisinternal) THEN
    RAISE NOTICE 'phase6-4b: the pre-attribution set was closed by an earlier application of this migration — backfill skipped, which is what a re-run must do.';
    RETURN;
  END IF;

  INSERT INTO "DecisionLegacyApproval" ("decisionId")
  SELECT d."id"
    FROM "Decision" d
   WHERE d."approvedDeciderKind" IS NULL
     AND (
          d."status"::text IN ('approved', 'change')
       OR d."approvedById" IS NOT NULL
       OR EXISTS (SELECT 1 FROM "DecisionApprovalRevision" r WHERE r."decisionId" = d."id")
       OR EXISTS (SELECT 1 FROM "DecisionEvent" e
                   WHERE e."decisionId" = d."id" AND e."type" IN ('approved', 'reapproved'))
     )
     -- so a repeated run inside one application (the seal is created later in this file, and an
     -- applier that autocommits per statement can leave the stamps without it) selects nothing
     AND NOT EXISTS (SELECT 1 FROM "DecisionLegacyApproval" l WHERE l."decisionId" = d."id");

  SELECT COUNT(*) INTO v_stamped FROM "DecisionLegacyApproval";
  RAISE NOTICE 'phase6-4b: % approval(s) recorded as predating attribution.', v_stamped;

  -- ── the backfill is the one step here that reads existing data, so it is the one step that can
  -- be wrong on a database nobody has seen. Re-derive the predicate and abort in EITHER direction.
  -- `prisma migrate deploy` sends this file as a single multi-statement query, which PostgreSQL
  -- runs in an implicit transaction, so an abort leaves the database exactly as it was.
  SELECT COUNT(*), string_agg(d."id", ', ' ORDER BY d."id")
    INTO v_missing, v_sample
    FROM "Decision" d
   WHERE d."approvedDeciderKind" IS NULL
     AND (
          d."status"::text IN ('approved', 'change')
       OR d."approvedById" IS NOT NULL
       OR EXISTS (SELECT 1 FROM "DecisionApprovalRevision" r WHERE r."decisionId" = d."id")
       OR EXISTS (SELECT 1 FROM "DecisionEvent" e
                   WHERE e."decisionId" = d."id" AND e."type" IN ('approved', 'reapproved'))
     )
     AND NOT EXISTS (SELECT 1 FROM "DecisionLegacyApproval" l WHERE l."decisionId" = d."id");
  IF v_missing > 0 THEN
    RAISE EXCEPTION 'phase6-4b: % approval(s) predate attribution but were not stamped (e.g. %) — they would be permanently indistinguishable from an approval whose tuple was stripped. Aborting with the database unchanged.', v_missing, left(v_sample, 200);
  END IF;

  SELECT COUNT(*), string_agg(l."decisionId", ', ' ORDER BY l."decisionId")
    INTO v_extra, v_sample
    FROM "DecisionLegacyApproval" l
    JOIN "Decision" d ON d."id" = l."decisionId"
   WHERE NOT (
          d."status"::text IN ('approved', 'change')
       OR d."approvedById" IS NOT NULL
       OR EXISTS (SELECT 1 FROM "DecisionApprovalRevision" r WHERE r."decisionId" = d."id")
       OR EXISTS (SELECT 1 FROM "DecisionEvent" e
                   WHERE e."decisionId" = d."id" AND e."type" IN ('approved', 'reapproved'))
     );
  IF v_extra > 0 THEN
    RAISE EXCEPTION 'phase6-4b: % stamp(s) exempt a decision that was never approved (e.g. %) — an exemption that broad would let a real stripped approval hide behind it. Aborting with the database unchanged.', v_extra, left(v_sample, 200);
  END IF;
END $$;

-- ── 6. …and the door closes behind it ────────────────────────────────────────────────────────
-- INSERT and UPDATE are refused unconditionally from here on. That is what makes membership
-- meaningful: the set cannot grow, so a caller cannot mint an exemption for an approval it
-- stripped. DELETE is refused while the subject exists, so the evidence cannot be removed out
-- from under a standing decision.
CREATE OR REPLACE FUNCTION decision_t4b_legacy_evidence_sealed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'phase6-4b: "DecisionLegacyApproval" is one-time migration evidence — it records which approvals predate attribution and cannot be added to afterwards (decision %).', NEW."decisionId";
  ELSIF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'phase6-4b: "DecisionLegacyApproval" is one-time migration evidence and is never updated (decision %).', OLD."decisionId";
  END IF;
  -- DELETE: lawful only when the subject itself is gone. In practice §8 now refuses to delete a
  -- stamped decision at all, so this arm's remaining job is to refuse an INDEPENDENT delete of
  -- the evidence — which is the attack it was written for.
  IF EXISTS (SELECT 1 FROM "Decision" WHERE "id" = OLD."decisionId") THEN
    RAISE EXCEPTION 'phase6-4b: the legacy-approval stamp for decision % cannot be deleted while decision % still exists — evidence leaves only with its subject.', OLD."decisionId", OLD."decisionId";
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "DecisionLegacyApproval_sealed" ON "DecisionLegacyApproval";
CREATE TRIGGER "DecisionLegacyApproval_sealed"
  BEFORE INSERT OR UPDATE OR DELETE ON "DecisionLegacyApproval"
  FOR EACH ROW EXECUTE FUNCTION decision_t4b_legacy_evidence_sealed();

-- A row-level trigger never fires for TRUNCATE, and TRUNCATE is separately grantable, so the
-- whole set could otherwise be dropped in one statement. Conditional, so a disposable database
-- holding no stamps is not blocked by a seal defending rows that do not exist.
CREATE OR REPLACE FUNCTION decision_t4b_legacy_evidence_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_stamped INT;
BEGIN
  SELECT COUNT(*) INTO v_stamped FROM "DecisionLegacyApproval";
  IF v_stamped > 0 THEN
    RAISE EXCEPTION 'phase6-4b: TRUNCATE would erase % legacy-approval stamp(s) — the only evidence that those approvals predate attribution, and unrecoverable once gone.', v_stamped;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionLegacyApproval_no_truncate" ON "DecisionLegacyApproval";
CREATE TRIGGER "DecisionLegacyApproval_no_truncate"
  BEFORE TRUNCATE ON "DecisionLegacyApproval"
  FOR EACH STATEMENT EXECUTE FUNCTION decision_t4b_legacy_evidence_no_truncate();

-- ── 7. The act is write-once ─────────────────────────────────────────────────────────────────
-- The HOLDER columns keep moving — forwarding a decision is a legitimate change, and this unit
-- takes no position on who may do it. The ACT does not move. Once an attribution tuple exists it
-- is frozen against every later UPDATE, including one that sets it back to NULL: "nobody approved
-- this after all" is exactly the rewrite a register must refuse.
CREATE OR REPLACE FUNCTION decision_t4b_approval_frozen() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."approvedDeciderKind" IS NULL THEN
    RETURN NEW; -- no act recorded yet; the enforcement phase decides when one must be
  END IF;
  IF NEW."approvedDeciderKind" IS DISTINCT FROM OLD."approvedDeciderKind"
     OR NEW."approvedDeciderMembershipId" IS DISTINCT FROM OLD."approvedDeciderMembershipId"
     OR NEW."approvedDeciderLabel" IS DISTINCT FROM OLD."approvedDeciderLabel" THEN
    RAISE EXCEPTION 'phase6-4b: decision % already records WHO approved it (% / %) — the approval attribution is frozen at the act and may not be restated.', OLD."id", OLD."approvedDeciderKind", OLD."approvedDeciderLabel";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_approval_frozen" ON "Decision";
CREATE TRIGGER "Decision_t4b_approval_frozen"
  BEFORE UPDATE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION decision_t4b_approval_frozen();

-- ── 8. An approval is permanent — against DELETE ─────────────────────────────────────────────
-- Carried from PR #344 as an unresolved integrity finding (round 19, P1).
--
-- Freezing the tuple against UPDATE is worth nothing if the row can simply be removed. Worse:
-- `DecisionLegacyApproval` cascades from `Decision`, and its own seal deliberately permits
-- removal once the parent is gone — so deleting a decision took its legacy stamp with it, and
-- THE ONLY PROOF THAT A PRE-ATTRIBUTION APPROVAL EVER HAPPENED could be erased by deleting the
-- thing it was proof about.
--
-- This NARROWS a path that was previously documented as lawful. The cascade was described as the
-- one legitimate way a stamp may leave — "evidence leaves only with its subject". That reasoning
-- was answering a different question (may the evidence be deleted on its own?) and it is still
-- sound. What it never established is that the SUBJECT may be deleted. It may not: an approval is
-- a register entry, a pre-attribution approval is still an approval, and no application path
-- deletes a `Decision` in the first place — so the narrowing costs nothing operationally and
-- closes the hole completely. The cascade arm above is now unreachable for a stamped row, which
-- is stated there rather than left for a reader to discover.
CREATE OR REPLACE FUNCTION decision_t4b_approval_permanent() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_stamped INT;
BEGIN
  IF OLD."approvedDeciderKind" IS NOT NULL THEN
    RAISE EXCEPTION 'phase6-4b: decision % records WHO approved it (% / %) — an approval is a permanent register entry and is never deleted.', OLD."id", OLD."approvedDeciderKind", OLD."approvedDeciderLabel";
  END IF;
  SELECT COUNT(*) INTO v_stamped FROM "DecisionLegacyApproval" WHERE "decisionId" = OLD."id";
  IF v_stamped > 0 THEN
    RAISE EXCEPTION 'phase6-4b: decision % is stamped as a pre-attribution approval — deleting it would erase the only evidence that that approval ever happened.', OLD."id";
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_approval_permanent" ON "Decision";
CREATE TRIGGER "Decision_t4b_approval_permanent"
  BEFORE DELETE ON "Decision"
  FOR EACH ROW EXECUTE FUNCTION decision_t4b_approval_permanent();

-- ── 9. …and against TRUNCATE ─────────────────────────────────────────────────────────────────
-- Carried from PR #344 as an unresolved integrity finding (round 19, P2). Same omission, one verb
-- along: §8 is a ROW trigger and row triggers never fire for TRUNCATE.
--
-- The list is written out rather than remembered, because the previous version of this guard was
-- wrong precisely by enumerating the cases its author happened to have in view. What this unit
-- calls permanent is:
--   1. an ATTRIBUTED APPROVAL      — the frozen act (§7)
--   2. a LEGACY APPROVAL STAMP     — the only evidence of a pre-attribution approval (§5)
-- Withdrawal permanence belongs to task 4a and is enforced by 4a's own seals, untouched here.
-- Conditional for the same reason as §6: a database with neither must still truncate.
CREATE OR REPLACE FUNCTION decision_t4b_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_attributed INT; v_stamped INT;
BEGIN
  SELECT COUNT(*) INTO v_attributed FROM "Decision" WHERE "approvedDeciderKind" IS NOT NULL;
  SELECT COUNT(*) INTO v_stamped FROM "DecisionLegacyApproval";
  IF v_attributed > 0 OR v_stamped > 0 THEN
    RAISE EXCEPTION 'phase6-4b: TRUNCATE would erase % attributed approval(s) and % pre-attribution stamp(s) — a permanent register entry is permanent against every verb, not only DELETE.', v_attributed, v_stamped;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Decision_t4b_no_truncate" ON "Decision";
CREATE TRIGGER "Decision_t4b_no_truncate"
  BEFORE TRUNCATE ON "Decision"
  FOR EACH STATEMENT EXECUTE FUNCTION decision_t4b_no_truncate();
