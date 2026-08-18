-- Issue generalization unit A1 — AN OPTION IS NOT NECESSARILY A CHOICE OF MATERIAL.
--
-- One concern: what an option can say. Today every option must name a material and a colour
-- swatch, so a question about technology, sequencing or a proposed remedy has to be dressed up as
-- a product choice or not asked at all. This unit makes the material half OPTIONAL, gives an
-- option a kind drawn from a server-driven menu, and replaces the bare rupee delta with a cost
-- IMPACT STATE that can honestly say "nobody has priced this yet".
--
-- The ISSUE-level half — record-only versus response-required, zero-option issues, free-text
-- resolutions — is a separate unit against `Decision`, deliberately not here.
--
-- Additive and retry-safe. Every column is added nullable or with a default, so the running
-- release keeps writing valid options: it names `material`/`swatch` (still accepted) and never
-- mentions the new columns.

-- ── 1. The stable base kinds, and the cost-impact states ──────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OptionBaseKind') THEN
    CREATE TYPE "OptionBaseKind" AS ENUM ('material', 'technology', 'solution', 'other');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'CostImpactState') THEN
    CREATE TYPE "CostImpactState" AS ENUM ('pending', 'none', 'estimated', 'confirmed');
  END IF;
END $$;

-- ── 2. The server-driven menu ─────────────────────────────────────────────────────────────────
-- `scope` is the tenant this kind belongs to: the literal 'platform' for the seeded kinds, or an
-- organization's own id. It exists because the identity of a custom kind IS its tenant plus its
-- code, and a bare `code` primary key said otherwise — it made codes globally unique, so the first
-- organization to add `precast` would have taken that word from everyone else, and the partial
-- uniques written below to express the real rule could never come into play. A NOT NULL scope also
-- gives `DecisionOption` something to point a composite foreign key at, which is what stops one
-- tenant selecting another tenant's kind.
CREATE TABLE IF NOT EXISTS "DecisionOptionKind" (
  "scope"        TEXT NOT NULL,
  "code"         TEXT NOT NULL,
  "baseKind"     "OptionBaseKind" NOT NULL,
  "labelKey"     TEXT NOT NULL,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "orgId"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionOptionKind_pkey" PRIMARY KEY ("scope", "code"),
  -- the two halves of `scope` are the two halves of `orgId`, and they may not disagree
  CONSTRAINT "DecisionOptionKind_scope_check" CHECK (
    ("orgId" IS NULL AND "scope" = 'platform') OR ("orgId" IS NOT NULL AND "scope" = "orgId")
  )
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DecisionOptionKind_orgId_fkey') THEN
    ALTER TABLE "DecisionOptionKind"
      ADD CONSTRAINT "DecisionOptionKind_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Org"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "DecisionOptionKind_active_displayOrder_idx"
  ON "DecisionOptionKind"("active", "displayOrder");

-- The primary key `(scope, code)` now states both rules directly — platform codes are unique
-- among platform codes, an organization's codes are unique within that organization, and the two
-- namespaces cannot collide. The earlier pair of partial unique indexes tried to say this while a
-- bare `code` primary key was quietly saying something stricter and wrong; they are gone rather
-- than left as decoration that no longer decides anything.

-- The four seeded platform kinds. `labelKey` is a localization key, not a display string — the
-- frontend hardcodes no labels, so retiring or reordering a kind is a data change.
INSERT INTO "DecisionOptionKind" ("scope", "code", "baseKind", "labelKey", "displayOrder", "active")
VALUES ('platform', 'material',   'material',   'option.kind.material',   10, true),
       ('platform', 'technology', 'technology', 'option.kind.technology', 20, true),
       ('platform', 'solution',   'solution',   'option.kind.solution',   30, true),
       ('platform', 'other',      'other',      'option.kind.other',      40, true)
ON CONFLICT ("scope", "code") DO NOTHING;

-- ── 3. The option itself ──────────────────────────────────────────────────────────────────────
ALTER TABLE "DecisionOption"
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "kindScope"   TEXT,
  ADD COLUMN IF NOT EXISTS "kindCode"    TEXT,
  ADD COLUMN IF NOT EXISTS "costImpact"  "CostImpactState" NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "costAmount"  INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DecisionOption_kind_fkey') THEN
    ALTER TABLE "DecisionOption"
      ADD CONSTRAINT "DecisionOption_kind_fkey" FOREIGN KEY ("kindScope", "kindCode")
      REFERENCES "DecisionOptionKind"("scope", "code") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "DecisionOption_kind_idx" ON "DecisionOption"("kindScope", "kindCode");

-- ── 4. Classify what already exists, without inventing anything ───────────────────────────────
-- Every pre-existing option WAS a material choice — the columns left no other possibility — so
-- `material` is the truthful classification rather than a guess.
--
-- Cost is the careful part. A legacy `delta` is a number a PMC really entered, but nothing in the
-- history says whether it was provisional or final. `estimated` is therefore the honest landing
-- place: it preserves the number and claims only that it is provisional. Backfilling `confirmed`
-- would manufacture a finality nobody ever asserted, and `none` for a zero delta would do the
-- same in the other direction — a stated zero is an assessment, so it maps to `none` only where
-- the author really wrote zero, which is what the CASE below says.
-- Two task-4a seals stand between this backfill and the rows it must classify, and BOTH are
-- right to. They are crossed deliberately, by name, and re-armed before this migration commits.
--
--   `DecisionOption_t4a_frozen` refuses ANY change to a WITHDRAWN decision's options. A withdrawn
--     decision is visible history, not a deletion — it still renders in the Decision Log, so its
--     options still need a kind. Skipping them would leave permanent nulls that every future
--     reader has to special-case, which is a worse answer than classifying them.
--   `DecisionOption_t4a_touch` writes a `DecisionOptionTouch` row per changed option. A schema
--     backfill is not a person editing an option, and recording that it was would be a lie in the
--     evidence table.
--
-- What makes this legitimate rather than a bypass: the backfill does not change what any option
-- SAYS. `delta` is left untouched, the material identity is untouched, and the new columns only
-- re-express the meaning those columns already carried. This is the DISABLE/backfill/ENABLE idiom
-- migrations `20261222000000` and `20261224000000` already use — with a re-arm assertion added,
-- because a migration that silently left a seal disabled would be far worse than one that fails.
DO $$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(t.name, ', ') INTO missing
    FROM (VALUES ('DecisionOption_t4a_frozen'), ('DecisionOption_t4a_touch')) AS t(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger WHERE tgname = t.name AND NOT tgisinternal);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'option generalization: expected task-4a option seal(s) % are absent; refusing to backfill against an unknown seal network.', missing;
  END IF;
END $$;

ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen";
ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_touch";

UPDATE "DecisionOption"
   SET "kindScope" = COALESCE("kindScope", 'platform'),
       "kindCode" = COALESCE("kindCode", 'material'),
       "costImpact" = CASE WHEN "delta" = 0 THEN 'none'::"CostImpactState"
                           ELSE 'estimated'::"CostImpactState" END,
       "costAmount" = CASE WHEN "delta" = 0 THEN NULL ELSE "delta" END
 WHERE "kindCode" IS NULL;

ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen";
ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_touch";

-- Both seals armed again, verified from the catalog rather than assumed from the statements above.
DO $$
DECLARE still_off TEXT;
BEGIN
  SELECT string_agg(tgname, ', ') INTO still_off
    FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgname IN ('DecisionOption_t4a_frozen', 'DecisionOption_t4a_touch')
     AND tgenabled = 'D';
  IF still_off IS NOT NULL THEN
    RAISE EXCEPTION 'option generalization: task-4a option seal(s) % are still DISABLED after the backfill. Aborting with the database unchanged.', still_off;
  END IF;
END $$;

-- ── 5. Now relax the material columns ─────────────────────────────────────────────────────────
-- Done AFTER the backfill so no window exists in which a row could be written with neither a
-- material nor a kind.
ALTER TABLE "DecisionOption" ALTER COLUMN "material" DROP NOT NULL;
ALTER TABLE "DecisionOption" ALTER COLUMN "swatch"   DROP NOT NULL;

-- …and the issue's OWN colour chip with them. `Decision.photoSwatch` is material evidence sitting
-- on the question itself, fed directly from the chosen option's swatch, so leaving it NOT NULL
-- would re-impose through the back door exactly the compulsion this unit removes: a technology
-- question would still have to invent a colour. Widening a column is safe for the running release,
-- which always supplies one.
ALTER TABLE "Decision" ALTER COLUMN "photoSwatch" DROP NOT NULL;

-- ── 6. Cost-impact coherence ──────────────────────────────────────────────────────────────────
-- An amount is required exactly for `estimated` and `confirmed`, and forbidden otherwise. The
-- forbidding half matters as much: leaving a stale amount attached to a `pending` row is how a
-- number nobody stands behind gets read as a price.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DecisionOption_cost_impact_check') THEN
    ALTER TABLE "DecisionOption" ADD CONSTRAINT "DecisionOption_cost_impact_check" CHECK (
      ("costImpact" IN ('estimated', 'confirmed') AND "costAmount" IS NOT NULL)
      OR ("costImpact" IN ('pending', 'none') AND "costAmount" IS NULL)
    );
  END IF;
END $$;

-- ── 7. Procurement may only draw on an option that really names a material ────────────────────
-- `MaterialRequirementSpec` pins an approved option through a provenance FK. With `material` now
-- nullable, that FK alone no longer guarantees the option HAS material identity — a requirement
-- could be pinned to a technology note and carry a purchase order behind it.
--
-- The first version answered this with a trigger on `MaterialRequirementSpec` that read
-- `DecisionOption` and `DecisionOptionKind`. That was wrong twice over, and both are worth naming:
--
--   It crossed a module boundary. `MaterialRequirementSpec` is activities-owned; the two tables it
--   read are decisions-owned and read-encapsulated. Doing the lookup in PL/pgSQL rather than Prisma
--   hides the edge from the boundary analyzer but does not remove it — the dependency is just as
--   real for being written in SQL.
--
--   It only judged the SPEC. Once a spec committed, nothing stopped the option itself being
--   updated to a technology kind with a null material: no spec row changed, so the trigger never
--   fired, and the terminal state held exactly the pairing this section exists to forbid.
--
-- Both dissolve if qualification is a FACT THE OPTION CARRIES rather than a question asked about
-- it. `materialQualified` is maintained by decisions, on decisions' own tables; the spec names the
-- value it requires and a foreign key holds the two together. Changing the option to a technology
-- kind now breaks that key while a spec references it, so PostgreSQL refuses the update — the
-- protection covers the whole lifetime of the reference rather than the instant it was created.
-- This is the pattern `PurchaseOrder.comparisonStatus` already uses to pin a reference to an
-- APPROVED comparison, applied to the same shape of problem.
ALTER TABLE "DecisionOption"
  ADD COLUMN IF NOT EXISTS "materialQualified" BOOLEAN NOT NULL DEFAULT false;

-- One trigger, because these are all one thing: the option's own invariants, maintained by the
-- module that owns it, before the row lands.
CREATE OR REPLACE FUNCTION decision_option_invariants() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_base TEXT;
BEGIN
  -- (a) COMPATIBILITY: the release still serving writes only the legacy `delta`. Left alone, a row
  -- it inserts after this migration takes the new column DEFAULTS — `pending`/NULL — so a cost a
  -- PMC really typed would read to the next release as "nobody has assessed this", and the amount
  -- would be gone. The backfill's rule is therefore applied to those writes too, which is the only
  -- way the same input keeps the same meaning on both sides of the deployment.
  IF TG_OP = 'INSERT' AND NEW."kindCode" IS NULL
     AND NEW."costImpact" = 'pending' AND NEW."costAmount" IS NULL THEN
    NEW."costImpact" := CASE WHEN NEW."delta" = 0 THEN 'none'::"CostImpactState"
                             ELSE 'estimated'::"CostImpactState" END;
    NEW."costAmount" := CASE WHEN NEW."delta" = 0 THEN NULL ELSE NEW."delta" END;
  END IF;

  -- (b) FINALIZED COST IS EVIDENCE. `confirmed` is a financial claim somebody stands behind; the
  -- pairwise CHECK below permits its coherence but says nothing about its history, so without this
  -- a confirmed 31,500 could be quietly rewritten to `pending`/NULL or to a different number.
  -- Correcting a finalized figure is a new option, not an edit of the old one.
  IF TG_OP = 'UPDATE' AND OLD."costImpact" = 'confirmed'
     AND (NEW."costImpact" IS DISTINCT FROM OLD."costImpact"
          OR NEW."costAmount" IS DISTINCT FROM OLD."costAmount") THEN
    RAISE EXCEPTION 'decisions: option % on decision % records a CONFIRMED cost of % — a finalized figure is evidence and cannot be rewritten; record a new option instead.',
      NEW."optionKey", NEW."decisionId", OLD."costAmount";
  END IF;

  -- (c) The qualification fact itself. `btrim` with the full ASCII whitespace set, because the
  -- one-argument form strips only spaces — a tab, newline, vertical tab, form feed or carriage
  -- return would otherwise pass as a material identity nobody can order against.
  SELECT k."baseKind"::text INTO v_base
    FROM "DecisionOptionKind" k
   WHERE k."scope" = NEW."kindScope" AND k."code" = NEW."kindCode";

  NEW."materialQualified" :=
    NEW."material" IS NOT NULL
    AND btrim(NEW."material", E' \t\n\r\v\f') <> ''
    -- a NULL kind is the compatibility window, and such a row IS a material option: that is what
    -- the backfill asserts about every row predating it, and the rule cannot differ for the
    -- byte-identical row written tomorrow.
    AND (NEW."kindCode" IS NULL OR v_base = 'material');

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionOption_invariants" ON "DecisionOption";
CREATE TRIGGER "DecisionOption_invariants"
  BEFORE INSERT OR UPDATE ON "DecisionOption"
  FOR EACH ROW EXECUTE FUNCTION decision_option_invariants();

-- Re-derive the flag for everything the backfill just classified (the trigger did not exist yet).
ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen";
ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_touch";
UPDATE "DecisionOption" SET "materialQualified" = "materialQualified";
ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen";
ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_touch";

-- The key the spec points at. Adding `materialQualified` to an already-unique pair keeps it unique
-- and gives the reference something to require.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionOption_qualified_key"
  ON "DecisionOption"("decisionId", "optionKey", "materialQualified");

ALTER TABLE "MaterialRequirementSpec"
  ADD COLUMN IF NOT EXISTS "optionMaterialQualified" BOOLEAN;

UPDATE "MaterialRequirementSpec" s
   SET "optionMaterialQualified" = true
 WHERE s."decisionId" IS NOT NULL AND s."optionKey" IS NOT NULL
   AND s."optionMaterialQualified" IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaterialRequirementSpec_option_qualified_check') THEN
    ALTER TABLE "MaterialRequirementSpec" ADD CONSTRAINT "MaterialRequirementSpec_option_qualified_check"
      CHECK (("decisionId" IS NULL AND "optionKey" IS NULL AND "optionMaterialQualified" IS NULL)
             OR ("decisionId" IS NOT NULL AND "optionKey" IS NOT NULL AND "optionMaterialQualified" = true));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MaterialRequirementSpec_option_qualified_fkey') THEN
    ALTER TABLE "MaterialRequirementSpec" ADD CONSTRAINT "MaterialRequirementSpec_option_qualified_fkey"
      FOREIGN KEY ("decisionId", "optionKey", "optionMaterialQualified")
      REFERENCES "DecisionOption"("decisionId", "optionKey", "materialQualified")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

-- The cross-module trigger is removed outright rather than narrowed. Its job is done by the key.
DROP TRIGGER IF EXISTS "MaterialRequirementSpec_option_is_material" ON "MaterialRequirementSpec";
DROP FUNCTION IF EXISTS material_spec_option_is_material();

-- ── 8. Closing verification ───────────────────────────────────────────────────────────────────
-- The backfill is the one step that reads existing data. Re-derive its promises and abort the
-- whole migration if either fails — `prisma migrate deploy` sends the file as one multi-statement
-- query, which PostgreSQL runs in an implicit transaction, so an abort changes nothing.
DO $$
DECLARE v_kindless INT; v_incoherent INT; v_unqualified INT; v_fabricated INT;
BEGIN
  -- The touch seal was disabled across the backfill, so no touch row should bear this
  -- migration's own transaction id. `txid_current()` is exact here: the whole migration runs in
  -- one implicit transaction, so a row carrying this txid could only have come from the backfill.
  SELECT COUNT(*) INTO v_fabricated
    FROM "DecisionOptionTouch" WHERE "txid" = txid_current();
  IF v_fabricated > 0 THEN
    RAISE EXCEPTION 'option generalization: the backfill fabricated % option-touch evidence row(s). Aborting with the database unchanged.', v_fabricated;
  END IF;

  SELECT COUNT(*) INTO v_kindless FROM "DecisionOption" WHERE "kindCode" IS NULL;
  IF v_kindless > 0 THEN
    RAISE EXCEPTION 'option generalization: % pre-existing option(s) were left without a kind. Aborting with the database unchanged.', v_kindless;
  END IF;

  SELECT COUNT(*) INTO v_incoherent FROM "DecisionOption"
   WHERE ("costImpact" IN ('estimated','confirmed') AND "costAmount" IS NULL)
      OR ("costImpact" IN ('pending','none') AND "costAmount" IS NOT NULL);
  IF v_incoherent > 0 THEN
    RAISE EXCEPTION 'option generalization: % option(s) carry a cost state and amount that disagree. Aborting with the database unchanged.', v_incoherent;
  END IF;

  -- The new trigger judges FUTURE references. Any EXISTING requirement pinned to an option that
  -- would now fail it is a real pre-existing problem, and the deploy must say so rather than
  -- leave a rule that only applies to rows written after today.
  SELECT COUNT(*) INTO v_unqualified
    FROM "MaterialRequirementSpec" s
    JOIN "DecisionOption" o ON o."decisionId" = s."decisionId" AND o."optionKey" = s."optionKey"
   WHERE s."decisionId" IS NOT NULL AND s."optionKey" IS NOT NULL
     AND NOT o."materialQualified";
  IF v_unqualified > 0 THEN
    RAISE EXCEPTION 'option generalization: % existing material requirement(s) cite an option with no material identity. Aborting with the database unchanged.', v_unqualified;
  END IF;
END $$;
