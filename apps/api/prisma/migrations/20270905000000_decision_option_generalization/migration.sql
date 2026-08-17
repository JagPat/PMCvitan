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
CREATE TABLE IF NOT EXISTS "DecisionOptionKind" (
  "code"         TEXT NOT NULL,
  "baseKind"     "OptionBaseKind" NOT NULL,
  "labelKey"     TEXT NOT NULL,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "orgId"        TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionOptionKind_pkey" PRIMARY KEY ("code")
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

-- A plain UNIQUE over a nullable `orgId` would let two platform rows share a code, because
-- PostgreSQL treats NULLs as distinct. Two PARTIAL uniques say what is actually meant: platform
-- codes are globally unique, and an organization's own codes are unique within that organization.
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionOptionKind_platform_code_key"
  ON "DecisionOptionKind"("code") WHERE "orgId" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "DecisionOptionKind_org_code_key"
  ON "DecisionOptionKind"("orgId", "code") WHERE "orgId" IS NOT NULL;

-- The four seeded platform kinds. `labelKey` is a localization key, not a display string — the
-- frontend hardcodes no labels, so retiring or reordering a kind is a data change.
INSERT INTO "DecisionOptionKind" ("code", "baseKind", "labelKey", "displayOrder", "active")
VALUES ('material',   'material',   'option.kind.material',   10, true),
       ('technology', 'technology', 'option.kind.technology', 20, true),
       ('solution',   'solution',   'option.kind.solution',   30, true),
       ('other',      'other',      'option.kind.other',      40, true)
ON CONFLICT ("code") DO NOTHING;

-- ── 3. The option itself ──────────────────────────────────────────────────────────────────────
ALTER TABLE "DecisionOption"
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "kindCode"    TEXT,
  ADD COLUMN IF NOT EXISTS "costImpact"  "CostImpactState" NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "costAmount"  INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DecisionOption_kindCode_fkey') THEN
    ALTER TABLE "DecisionOption"
      ADD CONSTRAINT "DecisionOption_kindCode_fkey" FOREIGN KEY ("kindCode")
      REFERENCES "DecisionOptionKind"("code") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "DecisionOption_kindCode_idx" ON "DecisionOption"("kindCode");

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
UPDATE "DecisionOption"
   SET "kindCode" = COALESCE("kindCode", 'material'),
       "costImpact" = CASE WHEN "delta" = 0 THEN 'none'::"CostImpactState"
                           ELSE 'estimated'::"CostImpactState" END,
       "costAmount" = CASE WHEN "delta" = 0 THEN NULL ELSE "delta" END
 WHERE "kindCode" IS NULL;

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
-- `MaterialRequirementSpec` pins an approved option through the four-column provenance FK. With
-- `material` now nullable, that FK alone no longer guarantees the option has material identity —
-- a requirement could be pinned to a TECHNOLOGY option and carry a purchase order behind it.
--
-- The UI must not be the thing standing between an unpriced technology note and a purchase order,
-- so this is a trigger. It fires on the requirement side, because that is where the reference is
-- created, and it reads the option and its base kind rather than trusting the caller.
CREATE OR REPLACE FUNCTION material_spec_option_is_material() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_material TEXT; v_base TEXT;
BEGIN
  IF NEW."decisionId" IS NULL OR NEW."optionKey" IS NULL THEN
    RETURN NEW; -- a manual spec cites no option at all; nothing to qualify
  END IF;
  SELECT o."material", k."baseKind"::text
    INTO v_material, v_base
    FROM "DecisionOption" o
    LEFT JOIN "DecisionOptionKind" k ON k."code" = o."kindCode"
   WHERE o."decisionId" = NEW."decisionId" AND o."optionKey" = NEW."optionKey";

  IF v_base IS DISTINCT FROM 'material' THEN
    RAISE EXCEPTION 'procurement: option % on decision % is a % option — only a material option can back a material requirement.',
      NEW."optionKey", NEW."decisionId", COALESCE(v_base, 'kindless');
  END IF;
  IF v_material IS NULL OR btrim(v_material) = '' THEN
    RAISE EXCEPTION 'procurement: option % on decision % carries no material identity — a material requirement cannot be pinned to it.',
      NEW."optionKey", NEW."decisionId";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "MaterialRequirementSpec_option_is_material" ON "MaterialRequirementSpec";
CREATE TRIGGER "MaterialRequirementSpec_option_is_material"
  BEFORE INSERT OR UPDATE ON "MaterialRequirementSpec"
  FOR EACH ROW EXECUTE FUNCTION material_spec_option_is_material();

-- ── 8. Closing verification ───────────────────────────────────────────────────────────────────
-- The backfill is the one step that reads existing data. Re-derive its promises and abort the
-- whole migration if either fails — `prisma migrate deploy` sends the file as one multi-statement
-- query, which PostgreSQL runs in an implicit transaction, so an abort changes nothing.
DO $$
DECLARE v_kindless INT; v_incoherent INT; v_unqualified INT;
BEGIN
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
    LEFT JOIN "DecisionOptionKind" k ON k."code" = o."kindCode"
   WHERE s."decisionId" IS NOT NULL AND s."optionKey" IS NOT NULL
     AND (k."baseKind" IS DISTINCT FROM 'material' OR o."material" IS NULL OR btrim(o."material") = '');
  IF v_unqualified > 0 THEN
    RAISE EXCEPTION 'option generalization: % existing material requirement(s) cite an option with no material identity. Aborting with the database unchanged.', v_unqualified;
  END IF;
END $$;
