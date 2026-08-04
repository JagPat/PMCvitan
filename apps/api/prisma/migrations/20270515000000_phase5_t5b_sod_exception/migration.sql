-- Phase 5 Task 5B, unit B — §I's attributable OVERRIDE.
--
-- Unit A (migration `20270510000000`) shipped §I's RULE: a certifier who recorded any of a
-- certificate's frozen evidence is refused, in the service and at PostgreSQL. It ships the refusal
-- ALONE and is therefore STRICTER than the finished rule, which is what made splitting the
-- authority check safe — no state of the system between the two units permits an act the finished
-- rule would refuse.
--
-- This unit adds the second half: the NAMED exception. §I is explicit that silently banning the act
-- is not acceptable either, because a two-person practice must still be able to operate — so the
-- override requires a stronger authority, carries its reason, and is written in the same
-- transaction and by the same command as the certification it authorises.
--
-- ── ON REPLACING `phase5_t5_certificate_complete_check` ───────────────────────────────────────
--
-- PostgreSQL has no way to add a clause to a function: `CREATE OR REPLACE` takes a WHOLE body. An
-- earlier head of this task pasted a stale copy of `phase5_t4_bill_lifecycle` from another branch
-- and SILENTLY DELETED five correction rounds of cleared Task-5A work — the migration applied
-- green, and only a test suite noticed. So the body below is unit A's body VERBATIM with ONE named
-- delta, stated here so the next task can diff rather than trust a sentence:
--
--   1. arm (c) — §I's unconditional refusal becomes the BICONDITIONAL: an override exists if and
--      only if the certifier recorded frozen evidence, exactly one of them, naming the rule, from
--      an approver with standing, and PRODUCED BY THE SAME COMMAND as the certificate.
--   2. two declarations (`v_excepted`, `v_exceptions`) that arm (c) needs.
--
-- Everything else — the live-version check (a), the exact-evidence check (b), the early return for
-- superseded history — is byte-for-byte unit A's.

CREATE TABLE IF NOT EXISTS "SodException" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "certificateId" TEXT,
    "rule" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCommandId" TEXT NOT NULL,

    CONSTRAINT "SodException_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SodException_projectId_id_key" ON "SodException"("projectId", "id");
CREATE INDEX IF NOT EXISTS "SodException_projectId_certificateId_idx" ON "SodException"("projectId", "certificateId");
-- ONE exception per rule per certificate. Without it a certificate can carry several rows
-- overriding the same rule, and `certificateById` reports whichever the planner happens to return:
-- an audit trail that answers "who authorised this?" differently on two reads is not an audit
-- trail. The uniqueness is what makes "the exception on this certificate" a definite description
-- rather than a choice.
CREATE UNIQUE INDEX IF NOT EXISTS "SodException_certificate_rule_key"
  ON "SodException"("projectId", "certificateId", "rule") WHERE "certificateId" IS NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_projectId_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_certificate_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_certificate_fkey" FOREIGN KEY ("projectId", "certificateId") REFERENCES "BillCertificate"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_actorId_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_approverId_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_sourceCommand_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_sourceCommand_fkey" FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_reason_nonblank') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_reason_nonblank" CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_rule_nonblank') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_rule_nonblank" CHECK (btrim("rule", E' \t\n\x0B\f\r') <> '');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_names_one_fact') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_names_one_fact" CHECK ("certificateId" IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_actor_is_not_approver') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_actor_is_not_approver" CHECK ("actorId" <> "approverId");
  END IF;

END $$;

-- §I — does this user hold pmc standing on this project? The orgs module OWNS this rule, and the
-- service asks it through `OrgsParticipant.hasProjectRoleStanding`. A trigger cannot call
-- TypeScript, so this one rule CANNOT have a single authority the way the evidence-actor set does:
-- the honest statement is that there are two implementations, and the closure is that they are
-- PINNED against each other by a correspondence probe that drives both over the same matrix of
-- standing shapes and fails on any cell where they disagree. Naming the predicate here is what
-- makes that probe possible — an inline `EXISTS` inside the seal could only be tested through the
-- seal, one shape at a time.
--
-- PRECEDENCE, not alternation: `hasProjectRoleStanding` returns on an ACTIVE project membership and
-- never reaches the org arm, so an org admin who is also an active contractor on this site operates
-- AS contractor.
--
-- Codex round-6 P2 — the standing rows are LOCKED before the decision, for the same reason the
-- participant passes `forUpdate: true`: `MembersService.updateRole` writes without the readiness
-- lock, so an unlocked read lets a concurrent downgrade commit behind an approval it granted. This
-- seal is the path that enforces §I for a direct-SQL or future writer, where no participant has
-- pre-locked anything.
--
-- The limit is stated rather than papered over: `FOR UPDATE` locks rows that EXIST, so it
-- serializes a downgrade or removal of standing, not the INSERT of a new membership that did not
-- exist when the decision was made. That is exactly the guarantee `hasProjectRoleStanding` gives,
-- and matching the owner's semantics is the bar — a seal that were stricter than the owner's rule
-- would refuse acts the owner permits, which is the disagreement this predicate exists to avoid.
CREATE OR REPLACE FUNCTION phase5_t5_pmc_standing(p_project text, p_user text)
RETURNS boolean AS $$
DECLARE v_has_membership boolean;
BEGIN
  PERFORM 1 FROM "Membership" m
   WHERE m."projectId" = p_project AND m."userId" = p_user
     FOR UPDATE;
  SELECT EXISTS (
    SELECT 1 FROM "Membership" m
     WHERE m."projectId" = p_project AND m."userId" = p_user AND m."status" = 'active'
  ) INTO v_has_membership;
  IF v_has_membership THEN
    RETURN EXISTS (
      SELECT 1 FROM "Membership" m
       WHERE m."projectId" = p_project AND m."userId" = p_user
         AND m."status" = 'active' AND m."role" = 'pmc'
    );
  END IF;
  PERFORM 1
    FROM "Project" pr
    JOIN "OrgMembership" om ON om."orgId" = pr."orgId" AND om."userId" = p_user
   WHERE pr."id" = p_project
     FOR UPDATE OF om;
  RETURN EXISTS (
    SELECT 1
      FROM "Project" pr
      JOIN "OrgMembership" om ON om."orgId" = pr."orgId" AND om."userId" = p_user
     WHERE pr."id" = p_project AND om."role" IN ('owner', 'admin')
  );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION phase5_t5_certificate_complete_check(p_project text, p_certificate text)
RETURNS void AS $$
DECLARE
  v_bill         text;
  v_version      text;
  v_certifier    text;
  v_superseded   timestamp(3);
  v_live_version text;
  v_frozen       numeric;
  v_recorder     boolean;
  v_excepted     boolean;
  v_exceptions   bigint;
  r              record;
BEGIN
  SELECT c."billId", c."versionId", c."certifiedById", c."supersededAt"
    INTO v_bill, v_version, v_certifier, v_superseded
    FROM "BillCertificate" c
   WHERE c."projectId" = p_project AND c."id" = p_certificate;
  IF v_bill IS NULL OR v_superseded IS NOT NULL THEN RETURN; END IF;

  -- (a) the certificate names the bill's LIVE claim version, not merely a version of that bill
  SELECT v."id" INTO v_live_version FROM "VendorBillVersion" v
   WHERE v."projectId" = p_project AND v."billId" = v_bill AND v."supersededAt" IS NULL;
  IF v_version IS DISTINCT FROM v_live_version THEN
    RAISE EXCEPTION 'Certificate % names claim version % while the live version of bill % is % — a certificate reports the claim it certified, so it cannot outlive it', p_certificate, v_version, v_bill, COALESCE(v_live_version, '(none)');
  END IF;

  -- (b) every claimed line is COVERED by frozen evidence. `certify` refuses to write a certificate
  -- it cannot cover; this is that same refusal, stated where no writer can go around it.
  FOR r IN
    SELECT bl."poLineId" AS po_line, bl."labourPoLineId" AS labour_line, SUM(bl."quantity") AS claimed
      FROM "VendorBillLine" bl
     WHERE bl."projectId" = p_project AND bl."versionId" = v_version
     GROUP BY bl."poLineId", bl."labourPoLineId"
  LOOP
    IF r.po_line IS NOT NULL THEN
      SELECT COALESCE(SUM(cc."consumedQty"), 0) INTO v_frozen
        FROM "CertifiedAcceptanceConsumption" cc
        JOIN "StockTransaction" t ON t."projectId" = cc."projectId" AND t."id" = cc."stockTransactionId"
        JOIN "StockLot" lot ON lot."projectId" = t."projectId" AND lot."id" = t."lotId"
       WHERE cc."projectId" = p_project AND cc."certificateId" = p_certificate
         AND lot."poLineId" = r.po_line;
      -- EXACT, not "at least" (Codex round 3). A `<` test leaves the frozen set append-OPEN after
      -- the certificate commits: certify one unit against acceptance A, then insert a row for
      -- acceptance B on the same claimed line, and `readCertificate` plus the reversal guard treat
      -- B as evidence this certificate never consumed. What a certificate rests on is exactly what
      -- it claimed — no less, and equally no more.
      IF v_frozen <> r.claimed THEN
        RAISE EXCEPTION 'Certificate % claims % base units on purchase-order line % but freezes % of accepted evidence — a certificate rests on EXACTLY the evidence it claimed', p_certificate, r.claimed, r.po_line, v_frozen;
      END IF;
    ELSE
      SELECT COALESCE(SUM(mc."consumedQty"), 0) INTO v_frozen
        FROM "CertifiedMeasurementConsumption" mc
        JOIN "Measurement" m ON m."projectId" = mc."projectId" AND m."id" = mc."measurementId"
       WHERE mc."projectId" = p_project AND mc."certificateId" = p_certificate
         AND m."labourPoLineId" = r.labour_line;
      IF v_frozen <> r.claimed THEN
        RAISE EXCEPTION 'Certificate % claims % person-shifts on labour purchase-order line % but freezes % of measured evidence — a certificate rests on EXACTLY the evidence it claimed', p_certificate, r.claimed, r.labour_line, v_frozen;
      END IF;
    END IF;
  END LOOP;

  -- (c) §I — the exception and the conflict are a BICONDITIONAL, and both directions are load-
  -- bearing. If the certifier recorded frozen evidence there must be an attributable override; if
  -- they did not, there must be NO override, because a certificate carrying an exception it never
  -- needed reports an authorisation that authorised nothing.
  --
  -- The actor set still comes from `phase5_t5_evidence_actors` — unchanged, the SAME function the
  -- service calls. What this unit adds is the second half of §I: the named exception that lets a
  -- two-person practice proceed. Unit A shipped the refusal alone and was therefore STRICTER than
  -- the finished rule, which is what made splitting the authority check safe.
  SELECT EXISTS (
    SELECT 1 FROM phase5_t5_evidence_actors(p_project, p_certificate) a WHERE a.actor = v_certifier
  ) INTO v_recorder;
  SELECT COUNT(*) INTO v_exceptions
    FROM "SodException" s
   WHERE s."projectId" = p_project AND s."certificateId" = p_certificate;
  IF v_recorder THEN
    -- An exception is an override of the rule it NAMES, granted by an authority that actually HAS
    -- standing, PRODUCED BY THE SAME COMMAND as the certificate it authorises. Without the first,
    -- an unrelated row satisfies this seal and the trail carries no override for
    -- `evidence-recorder-may-not-certify`. Without the second, the "stronger authority" §I requires
    -- can be a contractor. Without the third (Codex round-6 P2), a forged certificate can cite a
    -- stale `sourceCommandId` on its override row and leave the durable provenance saying the
    -- exception came from a different act than the one it excused — an audit trail that answers
    -- "which command authorised this?" with someone else's command is not an audit trail.
    SELECT EXISTS (
      SELECT 1 FROM "SodException" s
       JOIN "BillCertificate" c ON c."projectId" = s."projectId" AND c."id" = s."certificateId"
       WHERE s."projectId" = p_project AND s."certificateId" = p_certificate
         AND s."actorId" = v_certifier
         AND s."rule" = 'evidence-recorder-may-not-certify'
         AND s."approverId" <> s."actorId"
         AND s."sourceCommandId" = c."sourceCommandId"
         AND phase5_t5_pmc_standing(p_project, s."approverId")
    ) INTO v_excepted;
    IF NOT v_excepted THEN
      RAISE EXCEPTION 'Certificate % was certified by %, who recorded evidence it rests on, with no attributable `evidence-recorder-may-not-certify` exception from the same command granted by a pmc with standing — §I permits the act only with such an override', p_certificate, v_certifier;
    END IF;
    -- ONE override, and only the one this task's §I defines. The partial unique index already
    -- forbids two rows for the same rule, so a count above one means a row naming some OTHER rule
    -- has been attached to this certificate — authority for a question §I has not asked here.
    -- Task 6 adds `certifier-may-not-approve`, and when it does this arm is where the second rule
    -- is admitted: ONE edit, in the place that already states the whole rule.
    IF v_exceptions <> 1 THEN
      RAISE EXCEPTION 'Certificate % carries % segregation-of-duties exceptions — §I authorises this act with exactly one, naming `evidence-recorder-may-not-certify`', p_certificate, v_exceptions;
    END IF;
  ELSIF v_exceptions <> 0 THEN
    RAISE EXCEPTION 'Certificate % carries % segregation-of-duties exception(s) but its certifier recorded none of the evidence it rests on — an override records authority for a conflict, and there is none to override', p_certificate, v_exceptions;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- The EXCEPTION side fires the whole-certificate seal too. `SodException` would otherwise have an
-- immutability trigger and NO insert-side check at all, so an override could be appended to a
-- committed certificate forever — the §0b question asked and answered: a predicate checked at one
-- writer is unchecked at every other, and this table is a writer of the §I invariant.
--
-- The append-closure runs first, because a superseded certificate does not gain rows of any kind;
-- the completeness seal then re-asks the whole §I biconditional over the new state.
CREATE OR REPLACE FUNCTION phase5_t5_sod_exception_sealed() RETURNS trigger AS $$
BEGIN
  IF NEW."certificateId" IS NULL THEN RETURN NULL; END IF;
  PERFORM phase5_t5_assert_certificate_open(NEW."projectId", NEW."certificateId");
  PERFORM phase5_t5_certificate_complete_check(NEW."projectId", NEW."certificateId");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SodException_certificate_sealed" ON "SodException";
CREATE CONSTRAINT TRIGGER "SodException_certificate_sealed"
  AFTER INSERT ON "SodException" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_sod_exception_sealed();

DROP TRIGGER IF EXISTS "SodException_append_only" ON "SodException";
CREATE TRIGGER "SodException_append_only" BEFORE UPDATE OR DELETE ON "SodException"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_row_immutable();

-- The register lands ROW-FREE over any database that upgrades into it: an override is an
-- attributable human act and is never invented by a migration.
DO $$
DECLARE v_rows bigint;
BEGIN
  SELECT COUNT(*) INTO v_rows FROM "SodException";
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'phase5_t5 unit B: expected SodException to upgrade row-free, found % row(s)', v_rows;
  END IF;
END $$;
