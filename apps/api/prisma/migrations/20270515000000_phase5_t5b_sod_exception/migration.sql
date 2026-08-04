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
       JOIN "CommandExecution" ce ON ce."projectId" = s."projectId" AND ce."id" = s."sourceCommandId"
       WHERE s."projectId" = p_project AND s."certificateId" = p_certificate
         AND s."actorId" = v_certifier
         AND s."rule" = 'evidence-recorder-may-not-certify'
         AND s."approverId" <> s."actorId"
         AND s."sourceCommandId" = c."sourceCommandId"
         -- Codex round-7 P1 — matching ids are not provenance. Two rows can copy the SAME STALE
         -- command and satisfy an equality between themselves while that command produced some
         -- other certificate entirely, so the durable trail still answers "which command authorised
         -- this?" with an unrelated act. The RECEIPT is the authority: `executeCommand` writes
         -- `status`/`resultRef` inside the same transaction as the act, so at COMMIT the receipt
         -- either says it produced THIS certificate or the override is not this act's.
         AND ce."commandType" = 'commercial.bill.certify'
         AND ce."status" = 'succeeded'
         AND ce."resultRef" = p_certificate
         -- Codex round-7 P1 — the APPROVER must have ACTED. Everything above proves the override is
         -- well-formed; none of it proves anybody authorised it, because `approverId` arrived in the
         -- certifier's own request. The exception now rests on a GRANT: a row only the approver's
         -- own authenticated command could have created, scoped to this bill, this claim VERSION,
         -- this rule and this actor, and consumed by THIS certificate. A claim becomes a signature.
         AND EXISTS (
           SELECT 1 FROM "SodGrant" g
            WHERE g."projectId" = s."projectId" AND g."id" = s."grantId"
              AND g."approverId" = s."approverId"
              AND g."actorId" = s."actorId"
              AND g."rule" = s."rule"
              AND g."billId" = c."billId"
              AND g."versionId" = c."versionId"
              AND g."consumedByCertificateId" = p_certificate
              -- Codex round-8 P1 — and the GRANT itself must be the approver's act. Round 7 made the
              -- exception rest on a grant and then treated the grant AS the signature without ever
              -- proving who wrote it: `sourceCommandId` was a bare FK, so a direct writer could mint
              -- a grant naming any approver and the whole two-step design would certify a forgery.
              --
              -- This is the same correction as the one two lines up, applied to the artifact that
              -- correction introduced. That is the root this PR's audit keeps naming: the fix lands
              -- on the instance a finding named, and the sibling — here, one created in the SAME
              -- round — survives. The receipt is the authority for BOTH rows or for neither.
              AND EXISTS (
                SELECT 1 FROM "CommandExecution" gce
                 WHERE gce."projectId" = g."projectId" AND gce."id" = g."sourceCommandId"
                   AND gce."commandType" = 'commercial.sod.grant'
                   AND gce."status" = 'succeeded'
                   AND gce."actorId" = g."approverId"
                   AND gce."resultRef" = g."id"
              )
         )
         AND phase5_t5_pmc_standing(p_project, s."approverId")
    ) INTO v_excepted;
    IF NOT v_excepted THEN
      RAISE EXCEPTION 'Certificate % was certified by %, who recorded evidence it rests on, with no attributable `evidence-recorder-may-not-certify` exception resting on a grant this act consumed, from a pmc with standing — §I permits the act only with such an override', p_certificate, v_certifier;
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


-- ── §I — the OVERRIDE is a second AUTHENTICATED act, not a name the certifier types ────────────
--
-- Codex round-7 P1. Everything above proves the override is well-formed: the rule matches, the
-- approver holds standing, the provenance names this certificate's own command receipt. None of it
-- proves the APPROVER EVER ACTED. `certify` took `sodOverride.approverId` from the certifier's own
-- request, so a self-certifying pmc could type a colleague's id and a reason and the system would
-- write an immutable record asserting that colleague authorised it. §I's whole control is "a
-- stronger authority said yes", and the authority was never asked.
--
-- So the override becomes TWO acts. The approver, authenticated as themselves, issues a GRANT; the
-- certifier consumes it. The grant is:
--
--   * SCOPED to one (bill, claim version, rule, actor-to-be-excused). Version-pinned because an
--     amendment is a different claim, and permission to certify THIS claim should not survive it.
--   * SINGLE-USE — consumed by exactly one certificate, and the consume is a CAS transition.
--   * granted by someone who is NOT the actor being excused (CHECK), holding pmc standing (seal).
--
-- What this buys is the difference between a claim and a signature: after this, the exception rests
-- on a row only the approver's own authenticated command could have created.
CREATE TABLE IF NOT EXISTS "SodGrant" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceCommandId" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "consumedByCertificateId" TEXT,

    CONSTRAINT "SodGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SodGrant_projectId_id_key" ON "SodGrant"("projectId", "id");
-- ONE live grant per scope: a second would make "the grant that authorised this" ambiguous, and
-- hoarding unconsumed grants is exactly the standing waiver §I refuses.
--
-- Codex round-8 P2 — the scope MUST include the version, and leaving it out was an operational
-- deadlock rather than a theoretical one. A grant is version-pinned, so after an amendment the v1
-- grant is refused as stale AND stays unconsumed; without `versionId` here the partial unique then
-- blocked any replacement grant for v2, and a legitimate two-person certification could never
-- proceed without someone editing rows out of band. Two live grants for two different versions is
-- not ambiguity: only the LIVE version's grant is usable, and the seal checks that.
-- Codex round-9 P2 — and the APPROVER belongs in the scope too, for the same reason the version
-- does. If an unconsumed grant's approver is later downgraded, the seal correctly refuses to spend
-- it and the row stays live forever; without `approverId` here no OTHER pmc could issue a
-- replacement, and a legitimate certification was stuck short of editing rows out of band. The
-- stale row is inert rather than dangerous: standing is checked WHEN THE GRANT IS SPENT, so a grant
-- from someone who has lost it can never be consumed. What the index must not do is let that inert
-- row block a valid one.
CREATE UNIQUE INDEX IF NOT EXISTS "SodGrant_live_scope_key"
  ON "SodGrant"("projectId", "billId", "versionId", "rule", "actorId", "approverId") WHERE "consumedAt" IS NULL;
CREATE INDEX IF NOT EXISTS "SodGrant_projectId_billId_idx" ON "SodGrant"("projectId", "billId");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_projectId_fkey') THEN
    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_version_fkey') THEN
    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_version_fkey" FOREIGN KEY ("projectId", "versionId", "billId") REFERENCES "VendorBillVersion"("projectId", "id", "billId") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_actorId_fkey') THEN
    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_approverId_fkey') THEN
    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_sourceCommand_fkey') THEN
    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_sourceCommand_fkey" FOREIGN KEY ("projectId", "sourceCommandId") REFERENCES "CommandExecution"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_certificate_fkey') THEN
    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_certificate_fkey" FOREIGN KEY ("projectId", "consumedByCertificateId") REFERENCES "BillCertificate"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_reason_nonblank') THEN
    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_reason_nonblank" CHECK (btrim("reason", E' \t\n\x0B\f\r') <> '');
  END IF;
  -- the approver may not excuse THEMSELVES: a grant where the two are the same person is a
  -- signature on a mirror, exactly as the exception's own CHECK says
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_actor_is_not_approver') THEN
    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_actor_is_not_approver" CHECK ("actorId" <> "approverId");
  END IF;
  -- consumption is atomic: both halves or neither
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_consumed_together') THEN
    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_consumed_together" CHECK (("consumedAt" IS NULL) = ("consumedByCertificateId" IS NULL));
  END IF;
  -- the exception NAMES the grant it rests on
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'SodException' AND column_name = 'grantId') THEN
    ALTER TABLE "SodException" ADD COLUMN "grantId" TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodException_grant_fkey') THEN
    ALTER TABLE "SodException" ADD CONSTRAINT "SodException_grant_fkey" FOREIGN KEY ("projectId", "grantId") REFERENCES "SodGrant"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- A grant is append-only apart from its ONE consume transition, which is one-way.
CREATE OR REPLACE FUNCTION phase5_t5_grant_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A segregation-of-duties grant is an authority someone exercised — it is never deleted (%)', OLD."id";
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."projectId" IS DISTINCT FROM OLD."projectId"
     OR NEW."billId" IS DISTINCT FROM OLD."billId" OR NEW."versionId" IS DISTINCT FROM OLD."versionId"
     OR NEW."rule" IS DISTINCT FROM OLD."rule" OR NEW."actorId" IS DISTINCT FROM OLD."actorId"
     OR NEW."approverId" IS DISTINCT FROM OLD."approverId" OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."grantedAt" IS DISTINCT FROM OLD."grantedAt"
     OR NEW."sourceCommandId" IS DISTINCT FROM OLD."sourceCommandId" THEN
    RAISE EXCEPTION 'A segregation-of-duties grant is IMMUTABLE — only its one-way consumption may be stamped (%)', OLD."id";
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'This grant was already consumed at % — an authority is exercised ONCE (%)', OLD."consumedAt", OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── The grant carries the SAME seals its exception does ───────────────────────────────────────
--
-- Codex rounds 8 and 9, five findings, EVERY ONE of them on this table. That is the signal: round 7
-- introduced `SodGrant` to close a finding and gave it CHECKs and an append-only trigger, while the
-- row it accompanies — `SodException` — had an insert-side seal, receipt provenance and standing
-- validation. Each round then re-derived one of those for the grant, one at a time.
--
-- So this is the whole set at once, stated as one rule: **a grant is a trusted authority row, and
-- every seal that applies to the exception applies to it.** Validated at INSERT (round-9 P2: the
-- only trigger was BEFORE UPDATE, so a direct writer could park a live grant with no standing and
-- no receipt, and simply wait for that user to gain standing later) and again on the CONSUME
-- transition (round-9 P2: a stray UPDATE could burn an approver's single-use authority against an
-- unrelated certificate, leaving the ledger saying it was exercised when no override consumed it).
--
-- DEFERRED, because a grant and its command receipt are written in ONE transaction and the receipt
-- is completed after the row exists.
CREATE OR REPLACE FUNCTION phase5_t5_grant_sealed() RETURNS trigger AS $$
BEGIN
  -- (a) the grant is the APPROVER'S OWN act: a `commercial.sod.grant` receipt, succeeded, whose
  -- actor IS the approver and whose result names this grant
  IF NOT EXISTS (
    SELECT 1 FROM "CommandExecution" ce
     WHERE ce."projectId" = NEW."projectId" AND ce."id" = NEW."sourceCommandId"
       AND ce."commandType" = 'commercial.sod.grant'
       AND ce."status" = 'succeeded'
       AND ce."actorId" = NEW."approverId"
       AND ce."resultRef" = NEW."id"
  ) THEN
    RAISE EXCEPTION 'Grant % is not the act of the approver it names — §I authority is a command someone ran, not a row someone wrote (%)', NEW."id", NEW."approverId";
  END IF;

  -- (b) the approver held standing WHEN THE GRANT WAS MADE. The service checks this too; this is
  -- the database twin, and it is what stops a live grant being parked by someone with no authority
  -- against the day they acquire some.
  IF NOT phase5_t5_pmc_standing(NEW."projectId", NEW."approverId") THEN
    RAISE EXCEPTION 'Grant % names % as its authority, who does not hold pmc standing on this project', NEW."id", NEW."approverId";
  END IF;

  -- (c) a CONSUMED grant names a certificate that actually rests on it. Without this the consume
  -- transition is unguarded: a stray UPDATE burns the authority against an unrelated certificate.
  IF NEW."consumedByCertificateId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "SodException" s
      JOIN "BillCertificate" c ON c."projectId" = s."projectId" AND c."id" = s."certificateId"
     WHERE s."projectId" = NEW."projectId" AND s."grantId" = NEW."id"
       AND s."certificateId" = NEW."consumedByCertificateId"
       AND s."rule" = NEW."rule" AND s."actorId" = NEW."actorId" AND s."approverId" = NEW."approverId"
       AND c."billId" = NEW."billId" AND c."versionId" = NEW."versionId"
  ) THEN
    RAISE EXCEPTION 'Grant % was stamped consumed by certificate %, which carries no matching override — an authority is spent BY the act it excuses', NEW."id", NEW."consumedByCertificateId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SodGrant_sealed" ON "SodGrant";
CREATE CONSTRAINT TRIGGER "SodGrant_sealed"
  AFTER INSERT OR UPDATE ON "SodGrant" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_grant_sealed();

DROP TRIGGER IF EXISTS "SodGrant_append_only" ON "SodGrant";
CREATE TRIGGER "SodGrant_append_only" BEFORE UPDATE OR DELETE ON "SodGrant"
  FOR EACH ROW EXECUTE FUNCTION phase5_t5_grant_append_only();

DO $$
DECLARE v_rows bigint;
BEGIN
  SELECT COUNT(*) INTO v_rows FROM "SodGrant";
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'phase5_t5 unit B: expected SodGrant to upgrade row-free, found % row(s)', v_rows;
  END IF;
END $$;
