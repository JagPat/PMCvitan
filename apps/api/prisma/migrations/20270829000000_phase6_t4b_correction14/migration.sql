-- Phase 6 unit 4b-i — ROUND 14 CORRECTION (Codex, head a09f0b2).
--
-- ONE of the three findings lands here, and `decision_t4b_recorded_seal` is deliberately NOT
-- touched: every earlier migration, `20270821000000` and `20270827000000` included, is byte-for-byte
-- unchanged. See the note on R14-2 at the foot of this file for why the seal is not being widened.
--
--   R14-3 (P1)  A DIRECT `Activity` / `SiteMaterial` insert could race the draft-to-record
--               conversion. The FK takes `FOR KEY SHARE`, which does NOT conflict with the
--               conversion's non-key UPDATE, so both sessions committed and the dependent was left
--               waiting on an issue nobody can approve. Round 10 sealed the conversion against
--               dependents that already exist and serialized the SERVICE writers, which opt into
--               `FOR SHARE` through `linkableInProject`; a writer that never calls it took no
--               conflicting lock at all. The rule is now stated where the write happens.
--
-- R14-1 is a contract and a service message — no schema.

-- ── R14-3: the link rule, owned by decisions and asked at the child's own write ───────────────
-- The exact twin of `linkableInProject`'s in-tx form, and deliberately the same lock: `FOR SHARE`
-- conflicts with the conversion's `FOR NO KEY UPDATE`, so the two orderings each have exactly one
-- winner. A raw writer now takes the lock a service writer opted into, rather than slipping past
-- on the FK's weaker `FOR KEY SHARE`.
--
-- Ownership runs the same way `orgs_user_decision_authority` does: DECISIONS states what a
-- linkable decision is (it is a fact about the decision register), and the tables that hold the
-- dependents ask it from their own triggers. Neither module reads the other's rows.
CREATE OR REPLACE FUNCTION decisions_t4b_assert_linkable(
  p_project_id  TEXT,
  p_decision_id TEXT,
  p_dependent   TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF p_decision_id IS NULL THEN
    RETURN;
  END IF;
  -- FOR SHARE, not a plain read: this is the serialization point, not just a lookup. Held for the
  -- rest of the caller's transaction, it makes a conversion committing alongside this write wait
  -- for it (and then count the dependent), and a conversion already holding the row make this
  -- write wait (and then see `recorded`).
  SELECT d."status"::text INTO v_status
    FROM "Decision" d
   WHERE d."projectId" = p_project_id AND d."id" = p_decision_id
     FOR SHARE;
  -- Absent is not this guard's business: the composite FK is the authority on existence, and it
  -- runs after this trigger. Saying anything here would only produce a worse message.
  IF v_status IS NULL THEN
    RETURN;
  END IF;
  IF v_status = 'recorded' THEN
    RAISE EXCEPTION 'phase6-4b: % cannot depend on a recorded issue (%) — a record is approvable by nobody, so the gate would wait forever. Point it at a decision, or leave the dependency off.', p_dependent, p_decision_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION activity_t4b_decision_linkable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM decisions_t4b_assert_linkable(NEW."projectId", NEW."decisionId", 'an activity');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION site_material_t4b_decision_linkable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM decisions_t4b_assert_linkable(NEW."projectId", NEW."decisionId", 'a delivery');
  RETURN NEW;
END $$;

-- INSERT and RE-POINT are separate triggers because `OLD` does not exist in an INSERT `WHEN`, and
-- because an UPDATE that merely names `decisionId` in its SET list without changing it should not
-- pay for a row lock.
DROP TRIGGER IF EXISTS "Activity_t4b_decision_linkable_ins" ON "Activity";
CREATE TRIGGER "Activity_t4b_decision_linkable_ins"
  BEFORE INSERT ON "Activity"
  FOR EACH ROW WHEN (NEW."decisionId" IS NOT NULL)
  EXECUTE FUNCTION activity_t4b_decision_linkable();

DROP TRIGGER IF EXISTS "Activity_t4b_decision_linkable_upd" ON "Activity";
CREATE TRIGGER "Activity_t4b_decision_linkable_upd"
  BEFORE UPDATE OF "decisionId" ON "Activity"
  FOR EACH ROW WHEN (NEW."decisionId" IS NOT NULL AND NEW."decisionId" IS DISTINCT FROM OLD."decisionId")
  EXECUTE FUNCTION activity_t4b_decision_linkable();

DROP TRIGGER IF EXISTS "SiteMaterial_t4b_decision_linkable_ins" ON "SiteMaterial";
CREATE TRIGGER "SiteMaterial_t4b_decision_linkable_ins"
  BEFORE INSERT ON "SiteMaterial"
  FOR EACH ROW WHEN (NEW."decisionId" IS NOT NULL)
  EXECUTE FUNCTION site_material_t4b_decision_linkable();

DROP TRIGGER IF EXISTS "SiteMaterial_t4b_decision_linkable_upd" ON "SiteMaterial";
CREATE TRIGGER "SiteMaterial_t4b_decision_linkable_upd"
  BEFORE UPDATE OF "decisionId" ON "SiteMaterial"
  FOR EACH ROW WHEN (NEW."decisionId" IS NOT NULL AND NEW."decisionId" IS DISTINCT FROM OLD."decisionId")
  EXECUTE FUNCTION site_material_t4b_decision_linkable();

-- ── DIAGNOSTIC-FIRST: a dependent that ALREADY points at a record ─────────────────────────────
-- The race this migration closes is the one way such a row could have been written, so the deploy
-- must not install the guard and walk past the rows it exists to prevent. It never edits or
-- invents: it names them and stops. Both legal repairs are in docs/RUNBOOK.md §P6-4b.2 — unlink the
-- dependent, or take the decision back out of `recorded` (unpublished records only).
DO $do$
DECLARE
  v_acts INT;
  v_mats INT;
  v_sample TEXT;
BEGIN
  SELECT COUNT(*) INTO v_acts
    FROM "Activity" a JOIN "Decision" d ON d."projectId" = a."projectId" AND d."id" = a."decisionId"
   WHERE d."status"::text = 'recorded';
  SELECT COUNT(*) INTO v_mats
    FROM "SiteMaterial" m JOIN "Decision" d ON d."projectId" = m."projectId" AND d."id" = m."decisionId"
   WHERE d."status"::text = 'recorded';
  IF v_acts > 0 OR v_mats > 0 THEN
    SELECT string_agg(s.line, '; ') INTO v_sample FROM (
      (SELECT 'activity ' || a."id" || ' -> ' || a."decisionId" AS line
         FROM "Activity" a JOIN "Decision" d ON d."projectId" = a."projectId" AND d."id" = a."decisionId"
        WHERE d."status"::text = 'recorded' ORDER BY a."id" LIMIT 5)
      UNION ALL
      (SELECT 'delivery ' || m."id" || ' -> ' || m."decisionId"
         FROM "SiteMaterial" m JOIN "Decision" d ON d."projectId" = m."projectId" AND d."id" = m."decisionId"
        WHERE d."status"::text = 'recorded' ORDER BY m."id" LIMIT 5)
    ) s;
    RAISE EXCEPTION 'phase6-4b R14-3: % activities and % deliveries already depend on a recorded issue — each is a gate that can never open. Repair per docs/RUNBOOK.md §P6-4b.2, then redeploy. Sample: %', v_acts, v_mats, v_sample;
  END IF;
END $do$;


-- ── R14-2: WHY THE SEAL IS NOT WIDENED HERE ───────────────────────────────────────────────────
-- The finding: `migrate.sh` runs inside the API container's start command, so this schema becomes
-- durable before the process that goes with it is known to be healthy. A release that predates 4b
-- writes no `approvedDecider*` column, so in front of `decision_t4b_recorded_seal` it can approve
-- nothing — and if a deploy commits its migrations and then fails, a rollback puts exactly that
-- release in front of exactly this seal. That much is true and is worth saying out loud.
--
-- What was tried and REJECTED: deriving an absent holder tuple from the designation the row
-- already carries. It reads well — the three values are precisely what `approve()` computes, so
-- nothing is invented — but it does not add a compatibility path, it REPLACES the rule. The seal's
-- premise since round 5 is that an approval transition CARRIES its attribution; ten assertions
-- across rounds 6, 8 and 10 exist to pin exactly that, and derivation turns every one of them from
-- a refusal into an acceptance. Buying a deploy property by retiring five heads of reviewed
-- forgery resistance is the wrong trade, and it was made and reverted rather than argued from
-- theory: the upgrade proof named all ten.
--
-- What is TRUE about the exposure: it is not specific to 4b. Nine migrations in this ledger make
-- an existing column NOT NULL and sixty-eight install raising triggers, and an old writer dies on
-- every one of them — `PurchaseOrderLine."purchaseUom"` as surely as this. The forward-only ledger
-- IS this repository's migration policy, and RUNBOOK cutover step 1 (drain the old instances
-- BEFORE `migrate.sh`) is how the policy is honoured. Making one seal in one unit rollback-safe
-- would make it the weakest seal in the codebase and would still leave the deploy unsafe.
--
-- What this correction DOES owe, and pays, is the operator's side: RUNBOOK §P6-4b.1 now states the
-- constraint for 4b in the same terms §P6-4a states it for 4a — do not roll back across this
-- deploy; roll forward. A schema change that cannot be un-deployed should say so where the person
-- deploying it will read it.
