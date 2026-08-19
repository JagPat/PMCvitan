-- Issue generalization unit A1-i — AN OPTION DECLARES WHAT KIND OF CHOICE IT IS.
--
-- One concern, and only one: an option's own vocabulary. Today an option can only be read as a
-- product choice, so a question about technology, sequencing or a proposed remedy has to be dressed
-- up as one or not asked at all. This unit gives an option a KIND, drawn from a server-driven menu.
--
-- WHAT THIS UNIT DELIBERATELY DOES NOT DO. Each of these is a real improvement that belongs in its
-- own unit, and each was removed from here because carrying it made this one unreviewable:
--
--   * NO cost impact state. A bare rupee `delta` cannot distinguish "this costs nothing" from
--     "nobody has priced this yet", and fixing that is worth doing — but while the serving release
--     still returns only `delta`, any new cost column is a SECOND live representation of the same
--     fact, and every guard that keeps the two agreeing creates another place they can disagree.
--     That question (refuse the unpriced state during the compatibility window, or carry it without
--     telling a legacy reader zero) is the whole substance of its own unit, and it is not settled
--     by asserting it here.
--   * NO relaxation of `material`/`swatch`. Making the material half optional is what endangers
--     procurement — `MaterialRequirementSpec` pins an approved option, and a nullable material lets
--     that pin land on a technology note with a purchase order behind it. It belongs with the
--     qualification machinery that protects it.
--   * NO org-scoped custom kinds. Per-tenant vocabulary needs the option to carry an organization
--     key so a composite key can contain the selection — a denormalization chain through `Decision`
--     and `Project`. A menu one tenant could select ACROSS tenants would be worse than no custom
--     kinds at all, so the surface is not created rather than guarded.
--
-- Because no cost column ships, this migration writes to NO existing row: `kindCode` arrives with a
-- column DEFAULT, which is DDL and fires no row trigger. So the two task-4a option seals are not
-- crossed at all, and the disable/backfill/re-arm machinery that crossing needs is absent along
-- with them. Additive and retry-safe throughout.

BEGIN;

-- `prisma migrate deploy` sets this up; `psql -f` does not, and takes the caller's search path
-- instead — under which every unqualified object below could be created somewhere else entirely
-- and commit successfully while `public` still has none of it.
SET LOCAL search_path = public;

-- ── 1. The stable base kinds ──────────────────────────────────────────────────────────────────
-- Deliberately closed and small: downstream behaviour keys off THESE and never off a menu label, so
-- procurement keeps working without knowing anyone's vocabulary. A new BASE kind means new
-- downstream behaviour — a code change, not a data change.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OptionBaseKind') THEN
    CREATE TYPE "OptionBaseKind" AS ENUM ('material', 'technology', 'solution', 'other');
  END IF;
END $$;

-- ── 2. The server-driven menu ─────────────────────────────────────────────────────────────────
-- `labelKey` is a localization key, not a display string, so the frontend hardcodes no labels and
-- retiring or reordering a kind is a data change. `active` retires a kind without deleting it:
-- options already classified by it keep their classification, and only NEW selections are refused.
CREATE TABLE IF NOT EXISTS "DecisionOptionKind" (
  "code"         TEXT NOT NULL,
  "baseKind"     "OptionBaseKind" NOT NULL,
  "labelKey"     TEXT NOT NULL,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionOptionKind_pkey" PRIMARY KEY ("code")
);

-- EVERY constraint below is a guarded ALTER rather than an inline clause, and that is the fix for a
-- whole class rather than one instance.
--
-- `CREATE TABLE IF NOT EXISTS` is skipped WHOLESALE when the table already exists — and it can
-- already exist without this file having run, because `schema.prisma` describes the table and a
-- baseline or `db push`-shaped reconciliation can produce it. Prisma reproduces tables, columns,
-- primary keys and foreign keys; it does NOT reproduce a CHECK. So a CHECK written inline is
-- silently absent on exactly the databases that most need the migration to assert it, while the
-- ledger records the migration as applied. Written as a guarded ALTER, it lands either way.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'DecisionOptionKind_labelKey_check'
                    AND conrelid = '"DecisionOptionKind"'::regclass) THEN
    ALTER TABLE "DecisionOptionKind" ADD CONSTRAINT "DecisionOptionKind_labelKey_check"
      CHECK ("labelKey" !~ '^[[:space:]]*$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "DecisionOptionKind_active_displayOrder_idx"
  ON "DecisionOptionKind"("active", "displayOrder");

INSERT INTO "DecisionOptionKind" ("code", "baseKind", "labelKey", "displayOrder", "active")
VALUES ('material',   'material',   'option.kind.material',   10, true),
       ('technology', 'technology', 'option.kind.technology', 20, true),
       ('solution',   'solution',   'option.kind.solution',   30, true),
       ('other',      'other',      'option.kind.other',      40, true)
ON CONFLICT ("code") DO NOTHING;

-- ── 3. The option's kind, and what it says about itself ───────────────────────────────────────
-- `kindCode` is NOT NULL with a DEFAULT, and both halves are deliberate.
--
--   The DEFAULT is the compatibility window. The running release does not know this column exists
--   and never mentions it, so its inserts take the default — and `material` is the TRUTHFUL default
--   rather than a guess, because in this unit an option still must name a material. The same
--   default classifies every pre-existing row when the column is added, which is why this migration
--   needs no backfill statement and crosses no seal.
--
--   NOT NULL then means there is no such thing as an unclassified option, at any point in the
--   rollout — no permanent nulls for every future reader to special-case.
ALTER TABLE "DecisionOption"
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "kindCode"    TEXT NOT NULL DEFAULT 'material';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'DecisionOption_kind_fkey'
                    AND conrelid = '"DecisionOption"'::regclass) THEN
    ALTER TABLE "DecisionOption" ADD CONSTRAINT "DecisionOption_kind_fkey"
      FOREIGN KEY ("kindCode") REFERENCES "DecisionOptionKind"("code")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;

  -- An option must SAY WHAT IT IS: it names a material, or it describes itself.
  --
  -- Diagnosing first would be the pattern if this could fail on existing data; it cannot. Every
  -- pre-existing option carries a NOT NULL `material`, and the only rows this could reject are ones
  -- whose material is blank rather than absent. The closing verification below re-derives that
  -- rather than assuming it.
  --
  -- `COALESCE(..., '')` before each regex, deliberately: a CHECK PASSES when its expression is
  -- UNKNOWN, and `NULL !~ '...'` is UNKNOWN, so a bare regex on a nullable column is not a test at
  -- all for exactly the rows it is meant to catch.
  --
  -- The second clause is independent of the first on purpose. Without it, a material-bearing option
  -- satisfies the identity rule and a whitespace-only description rides along unchecked — leaving a
  -- nullable column with two ways to mean "absent", NULL and a lone tab, only one of which any
  -- reader will test for. Absence is NULL here; anything non-null must be legible.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'DecisionOption_says_what_it_is_check'
                    AND conrelid = '"DecisionOption"'::regclass) THEN
    ALTER TABLE "DecisionOption" ADD CONSTRAINT "DecisionOption_says_what_it_is_check" CHECK (
      (COALESCE("material", '') !~ '^[[:space:]]*$'
       OR COALESCE("description", '') !~ '^[[:space:]]*$')
      AND ("description" IS NULL OR "description" !~ '^[[:space:]]*$')
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "DecisionOption_kindCode_idx" ON "DecisionOption"("kindCode");

-- ── 4. A retired kind cannot be newly selected ────────────────────────────────────────────────
-- The foreign key proves the code EXISTS, which is not the same as the menu still offering it.
-- After `active = false` the menu stops showing a kind, and without this a stale client — or any
-- direct writer — keeps classifying new options with it. Existing references stay valid, which is
-- the point of retiring rather than deleting; it is INSERTS and kind-CHANGES that must pick from
-- what the server currently offers.
CREATE OR REPLACE FUNCTION decision_option_kind_selectable() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE v_active BOOLEAN;
BEGIN
  IF TG_OP = 'INSERT' OR NEW."kindCode" IS DISTINCT FROM OLD."kindCode" THEN
    -- FOR SHARE, and the strength is not incidental.
    --
    -- Without a lock this reads `active = true`, a concurrent retirement commits, and the insert
    -- then proceeds through the foreign key and commits carrying a kind the menu no longer offers —
    -- exactly the state this rule promises cannot exist.
    --
    -- FOR KEY SHARE would NOT fix it: a plain `SET active = false` is a non-key update and takes
    -- FOR NO KEY UPDATE, which does not conflict with FOR KEY SHARE. Verified by execution rather
    -- than from the lock table: holding FOR KEY SHARE, the retirement proceeded; holding FOR SHARE,
    -- it blocked. FOR SHARE conflicts with FOR NO KEY UPDATE, so whichever transaction arrives
    -- second waits and then reads the other's committed answer.
    SELECT k."active" INTO v_active
      FROM public."DecisionOptionKind" k
     WHERE k."code" = NEW."kindCode"
       FOR SHARE;

    -- Tested as FOUND-and-inactive rather than NOT-FOUND-or-inactive, so a code naming no kind at
    -- all falls through to the foreign key and is reported as what it is. Calling a nonexistent kind
    -- "retired" sends whoever hit it looking for a menu row that was never there.
    IF FOUND AND NOT v_active THEN
      RAISE EXCEPTION 'decisions: option kind % has been retired and cannot be selected for new options; choose one the menu still offers.', NEW."kindCode";
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionOption_kind_selectable" ON "DecisionOption";
CREATE TRIGGER "DecisionOption_kind_selectable"
  BEFORE INSERT OR UPDATE ON "DecisionOption"
  FOR EACH ROW EXECUTE FUNCTION decision_option_kind_selectable();

-- ── 5. A kind's base classification is frozen once anything is classified by it ────────────────
-- `baseKind` is what downstream behaviour keys off. Re-pointing it after options already carry the
-- code silently re-classifies every one of them — and no option row changes, so nothing that
-- watches options would ever fire. Retiring the kind and adding a new one is the honest change, and
-- it leaves the already-classified options saying what they always said.
CREATE OR REPLACE FUNCTION decision_option_kind_frozen() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."baseKind" IS DISTINCT FROM OLD."baseKind"
     AND EXISTS (SELECT 1 FROM public."DecisionOption" o WHERE o."kindCode" = OLD."code") THEN
    RAISE EXCEPTION 'decisions: option kind % already classifies at least one option, so its base kind is frozen — retire it (active = false) and add a new kind instead of re-pointing this one.', OLD."code";
  END IF;

  -- `material` is the COLUMN DEFAULT, which is how the currently serving release — which does not
  -- know `kindCode` exists — writes a valid option at all. Retiring it would make every insert from
  -- that release fail the retired-kind rule above, taking the running application down by a data
  -- edit. It stops being the default when a release that names its kind explicitly is the only one
  -- serving, and it can be retired then.
  IF OLD."code" = 'material' AND OLD."active" AND NOT NEW."active" THEN
    RAISE EXCEPTION 'decisions: option kind "material" is the column default the currently serving release relies on, and cannot be retired while it is; retire it only once no release depends on the default.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionOptionKind_frozen" ON "DecisionOptionKind";
CREATE TRIGGER "DecisionOptionKind_frozen"
  BEFORE UPDATE ON "DecisionOptionKind"
  FOR EACH ROW EXECUTE FUNCTION decision_option_kind_frozen();

-- ── 6. Closing verification ───────────────────────────────────────────────────────────────────
-- This migration writes no existing row, so there is little to re-derive — but "little" is not
-- "none", and the two things it DOES assert about existing data are checked rather than assumed.
-- The file is one transaction, so an abort changes nothing.
DO $$
DECLARE v_kindless INT; v_illegible INT;
BEGIN
  SELECT COUNT(*) INTO v_kindless FROM "DecisionOption" WHERE "kindCode" IS NULL;
  IF v_kindless > 0 THEN
    RAISE EXCEPTION 'option kinds: % option(s) were left without a kind. Aborting with the database unchanged.', v_kindless;
  END IF;

  SELECT COUNT(*) INTO v_illegible FROM "DecisionOption"
   WHERE COALESCE("material", '') ~ '^[[:space:]]*$'
     AND COALESCE("description", '') ~ '^[[:space:]]*$';
  IF v_illegible > 0 THEN
    RAISE EXCEPTION 'option kinds: % option(s) name neither a material nor a description and cannot be read as anything. Aborting with the database unchanged.', v_illegible;
  END IF;
END $$;

COMMIT;
