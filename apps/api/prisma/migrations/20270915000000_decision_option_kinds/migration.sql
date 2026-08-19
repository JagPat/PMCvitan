-- Issue generalization unit A1-i — AN OPTION DECLARES WHAT KIND OF CHOICE IT IS.
--
-- One concern: an option's own vocabulary. Today an option can only be read as a product choice,
-- and the only thing it can say about money is a bare rupee `delta` that cannot distinguish "this
-- costs nothing" from "nobody has priced this yet". This unit gives an option a KIND drawn from a
-- server-driven menu, and a cost IMPACT STATE that can say the honest thing.
--
-- WHAT THIS UNIT DELIBERATELY DOES NOT DO, because the review record says the combined change was
-- too large to review as one thing:
--
--   * `material` and `swatch` stay NOT NULL. Making the material half optional is what endangers
--     procurement — `MaterialRequirementSpec` pins an approved option, and with a nullable material
--     that pin could land on a technology note with a purchase order behind it. That belongs with
--     the qualification machinery that protects it, in its own unit (A1-ii), not bolted to this one.
--   * There are no ORG-SCOPED custom kinds. The four platform kinds cover what the owner asked for
--     ("technology, solution, or a lot of other things"); per-tenant vocabulary needs the option to
--     carry an organization key so a composite key can contain it, which is a denormalization chain
--     through `Decision` and `Project` and is its own unit (A1-iii). Shipping a menu that a tenant
--     could select ACROSS tenants would be worse than not shipping custom kinds at all, so the
--     surface is not created rather than guarded.
--
-- Additive and retry-safe. Every column is added with a default or nullable, so the running release
-- keeps writing valid options: it names `label`/`material`/`swatch`/`delta` and never mentions the
-- new columns.

BEGIN;

-- `prisma migrate deploy` sets this up; `psql -f` does not, and takes the caller's search path
-- instead — under which every unqualified object below could be created somewhere else entirely
-- and commit successfully while `public` still has none of it.
SET LOCAL search_path = public;

-- ── 1. The stable base kinds, and the cost-impact states ──────────────────────────────────────
-- `OptionBaseKind` is deliberately closed and small: downstream behaviour keys off these and never
-- off a menu label, so procurement keeps working without knowing anyone's vocabulary. A new BASE
-- kind means new downstream behaviour — a code change, not a data change.
--
-- `CostImpactState` exists because a number cannot say "nobody has assessed this". The distinction
-- carrying the weight: `pending` and a missing amount are NOT zero. An option nobody has priced
-- must never read as free.
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
-- `labelKey` is a localization key, not a display string, so the frontend hardcodes no labels and
-- retiring or reordering a kind is a data change. `active` retires a kind without deleting it:
-- options already classified by it keep their classification, and the foreign key below keeps them
-- valid.
CREATE TABLE IF NOT EXISTS "DecisionOptionKind" (
  "code"         TEXT NOT NULL,
  "baseKind"     "OptionBaseKind" NOT NULL,
  "labelKey"     TEXT NOT NULL,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DecisionOptionKind_pkey" PRIMARY KEY ("code"),
  CONSTRAINT "DecisionOptionKind_labelKey_check" CHECK ("labelKey" !~ '^[[:space:]]*$')
);

CREATE INDEX IF NOT EXISTS "DecisionOptionKind_active_displayOrder_idx"
  ON "DecisionOptionKind"("active", "displayOrder");

INSERT INTO "DecisionOptionKind" ("code", "baseKind", "labelKey", "displayOrder", "active")
VALUES ('material',   'material',   'option.kind.material',   10, true),
       ('technology', 'technology', 'option.kind.technology', 20, true),
       ('solution',   'solution',   'option.kind.solution',   30, true),
       ('other',      'other',      'option.kind.other',      40, true)
ON CONFLICT ("code") DO NOTHING;

-- ── 3. The option's new vocabulary ────────────────────────────────────────────────────────────
-- `kindCode` is NOT NULL with a DEFAULT, and both halves of that are deliberate.
--
--   The DEFAULT is the compatibility window. The running release does not know this column exists
--   and never mentions it, so its inserts take the default — and `material` is the TRUTHFUL default
--   rather than a guess, because in this unit an option still must name a material. The same
--   default classifies every pre-existing row when the column is added, so no backfill statement is
--   needed for it and no seal has to be crossed to write it.
--
--   NOT NULL then means there is no such thing as an unclassified option, at any point in the
--   rollout — no permanent nulls for every future reader to special-case.
ALTER TABLE "DecisionOption"
  ADD COLUMN IF NOT EXISTS "description" TEXT,
  ADD COLUMN IF NOT EXISTS "kindCode"    TEXT NOT NULL DEFAULT 'material',
  ADD COLUMN IF NOT EXISTS "costImpact"  "CostImpactState" NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "costAmount"  INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'DecisionOption_kind_fkey'
                    AND conrelid = '"DecisionOption"'::regclass) THEN
    ALTER TABLE "DecisionOption" ADD CONSTRAINT "DecisionOption_kind_fkey"
      FOREIGN KEY ("kindCode") REFERENCES "DecisionOptionKind"("code")
      ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "DecisionOption_kindCode_idx" ON "DecisionOption"("kindCode");

-- ── 4. Classify the cost of what already exists, without inventing anything ───────────────────
-- A legacy `delta` is a number a PMC really entered, but nothing in the history says whether it was
-- provisional or final. `estimated` is therefore the honest landing place: it preserves the number
-- and claims only that it is provisional. `confirmed` is NEVER backfilled — that would manufacture
-- a finality nobody asserted. A literal zero maps to `none`, because a stated zero IS an
-- assessment. `delta` itself is left untouched.
--
-- Two task-4a seals stand between this backfill and the rows it must classify, and BOTH are right
-- to. They are crossed deliberately, by name, and re-armed before this migration commits.
--
--   `DecisionOption_t4a_frozen` refuses ANY change to a WITHDRAWN decision's options. A withdrawn
--     decision is visible history, not a deletion — it still renders in the Decision Log, so its
--     options still need a cost reading. Skipping them would leave a permanent inconsistency.
--   `DecisionOption_t4a_touch` writes a `DecisionOptionTouch` row per changed option. A schema
--     backfill is not a person editing an option, and recording that it was would be a lie in the
--     evidence table.
--
-- What makes this legitimate rather than a bypass: the backfill does not change what any option
-- SAYS. `delta`, material identity and swatch are untouched, and the new columns only re-express
-- the meaning `delta` already carried. This is the DISABLE/backfill/ENABLE idiom migrations
-- `20261222000000` and `20261224000000` already use — with two things they do not do: the seals
-- must EXIST before the backfill starts (an unknown seal network is refused rather than silently
-- skipped), and they must be ARMED AGAIN before this migration is allowed to commit.
DO $$
DECLARE missing TEXT;
BEGIN
  SELECT string_agg(t.name, ', ') INTO missing
    FROM (VALUES ('DecisionOption_t4a_frozen'), ('DecisionOption_t4a_touch')) AS t(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_trigger
      WHERE tgname = t.name AND tgrelid = '"DecisionOption"'::regclass AND NOT tgisinternal);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'option kinds: expected task-4a option seal(s) % are absent; refusing to backfill against an unknown seal network.', missing;
  END IF;
END $$;

ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen";
ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_touch";

UPDATE "DecisionOption"
   SET "costImpact" = CASE WHEN "delta" = 0 THEN 'none'::"CostImpactState"
                           ELSE 'estimated'::"CostImpactState" END,
       "costAmount" = CASE WHEN "delta" = 0 THEN NULL ELSE "delta" END
 WHERE "costImpact" = 'pending' AND "costAmount" IS NULL;

ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen";
ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_touch";

-- Both seals armed again, read from the catalog rather than assumed from the statements above.
-- `<> 'O'` rather than `= 'D'`: a trigger set to REPLICA ('R') is inert on an origin server and
-- would read as "not disabled" to the narrower test.
DO $$
DECLARE still_off TEXT;
BEGIN
  SELECT string_agg(tgname, ', ') INTO still_off
    FROM pg_trigger
   WHERE tgrelid = '"DecisionOption"'::regclass AND NOT tgisinternal
     AND tgname IN ('DecisionOption_t4a_frozen', 'DecisionOption_t4a_touch')
     AND tgenabled <> 'O';
  IF still_off IS NOT NULL THEN
    RAISE EXCEPTION 'option kinds: task-4a option seal(s) % are not armed after the backfill. Aborting with the database unchanged.', still_off;
  END IF;
END $$;

-- ── 5. Cost-impact coherence ──────────────────────────────────────────────────────────────────
-- An amount is required exactly for `estimated` and `confirmed`, and forbidden otherwise. The
-- forbidding half matters as much: leaving a stale amount attached to a `pending` row is how a
-- number nobody stands behind gets read as a price.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'DecisionOption_cost_impact_check'
                    AND conrelid = '"DecisionOption"'::regclass) THEN
    ALTER TABLE "DecisionOption" ADD CONSTRAINT "DecisionOption_cost_impact_check" CHECK (
      ("costImpact" IN ('estimated', 'confirmed') AND "costAmount" IS NOT NULL)
      OR ("costImpact" IN ('pending', 'none') AND "costAmount" IS NULL)
    );
  END IF;
END $$;

-- ── 6. An option must say WHAT IT IS ──────────────────────────────────────────────────────────
-- Diagnose before constraining: an option that names neither a material nor a description is
-- unreadable, and if any such row already exists this migration says which and stops rather than
-- failing later as an opaque constraint violation. Nothing is invented — the fix is a decision
-- about real data and it belongs to a person.
--
-- On the SHAPE of this rule. The obvious reading — "a kind-aware option must carry a description" —
-- cannot be expressed, because `kindCode` has a default and therefore every row is kind-aware from
-- the moment this migration runs; there is no column that separates a new-style option from a
-- legacy one. Requiring a description unconditionally is also wrong: it would break the running
-- release, which does not send one.
--
-- What IS true, and is what the constraint says: an option is identified either by the material it
-- names or by what it describes, and one of those must be present and legible. Today material is
-- mandatory, so this bites only on a BLANK material. When A1-ii makes the material half optional,
-- the same constraint becomes exactly the rule that matters — a material-less option must carry a
-- description — without being rewritten.
DO $$
DECLARE offenders TEXT; n INTEGER;
BEGIN
  SELECT COUNT(*), string_agg(sample, '; ') INTO n, offenders FROM (
    SELECT "decisionId" || '/' || "optionKey" AS sample
      FROM "DecisionOption"
     WHERE COALESCE("material", '') ~ '^[[:space:]]*$'
       AND COALESCE("description", '') ~ '^[[:space:]]*$'
     LIMIT 20) q;
  IF n > 0 THEN
    RAISE EXCEPTION 'option kinds: % option(s) name neither a material nor a description and cannot be read as anything: %. Resolve these before deploying.', n, offenders;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname = 'DecisionOption_says_what_it_is_check'
                    AND conrelid = '"DecisionOption"'::regclass) THEN
    -- `COALESCE(..., '')` before the regex, deliberately. A CHECK constraint PASSES when its
    -- expression evaluates to UNKNOWN, and `NULL !~ '...'` is UNKNOWN — so a bare regex on a
    -- nullable column is not a test at all for exactly the rows it is meant to catch.
    ALTER TABLE "DecisionOption" ADD CONSTRAINT "DecisionOption_says_what_it_is_check" CHECK (
      COALESCE("material", '') !~ '^[[:space:]]*$'
      OR COALESCE("description", '') !~ '^[[:space:]]*$'
    );
  END IF;
END $$;

-- ── 7. The option's own invariants, maintained by the module that owns it ─────────────────────
CREATE OR REPLACE FUNCTION decision_option_invariants() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  -- (a) COMPATIBILITY. The release still serving writes only the legacy `delta`. Left alone, a row
  -- it inserts AFTER this migration takes the new column defaults — `pending`/NULL — so a cost a
  -- PMC really typed would read to the next release as "nobody has assessed this", and the amount
  -- would be gone. The backfill's rule is applied to those writes too, which is the only way the
  -- same input keeps the same meaning on both sides of the deployment.
  --
  -- The boundary, stated rather than left to be discovered: PostgreSQL cannot distinguish a column
  -- the writer omitted from one it explicitly set to the same value, so this derivation fires for
  -- ANY insert that leaves both new cost columns at their defaults. That is correct while no writer
  -- sets them — which is the case in this unit, since it adds no service logic and no route. The
  -- unit that introduces a writer able to MEAN `pending` with a non-zero delta must carry an
  -- explicit marker for that intent and narrow this branch to match; it must not be left to infer.
  IF TG_OP = 'INSERT' AND NEW."costImpact" = 'pending' AND NEW."costAmount" IS NULL THEN
    NEW."costImpact" := CASE WHEN NEW."delta" = 0 THEN 'none'::"CostImpactState"
                             ELSE 'estimated'::"CostImpactState" END;
    NEW."costAmount" := CASE WHEN NEW."delta" = 0 THEN NULL ELSE NEW."delta" END;
  END IF;

  -- (b) A FINALIZED COST IS EVIDENCE, AND SO IS THE PROPOSAL IT IS ATTACHED TO.
  --
  -- `confirmed` is a financial claim somebody stands behind. Freezing only the amount leaves the
  -- worse hole open: keep the trusted 31,500 and rewrite the description, the material or the kind,
  -- and a price agreed for one proposal now sits against a different one. Correcting finalized
  -- evidence is a NEW option, not an edit of the old one.
  --
  -- Compared as JSONB with the presentational keys removed, rather than as a list of columns, so a
  -- column added to this table later is frozen BY DEFAULT. `recommended` and `order` are the two
  -- fields that carry no claim about the proposal — which of several options is preferred, and what
  -- sequence they read in, remain editable while a cost is confirmed.
  IF TG_OP = 'UPDATE' AND OLD."costImpact" = 'confirmed'
     AND (to_jsonb(NEW) - 'recommended' - 'order')
         IS DISTINCT FROM (to_jsonb(OLD) - 'recommended' - 'order') THEN
    RAISE EXCEPTION 'decisions: option % on decision % records a CONFIRMED cost of % — a finalized figure and the proposal it was agreed for are evidence together, and neither is rewritable. Record a new option instead.',
      NEW."optionKey", NEW."decisionId", OLD."costAmount";
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionOption_invariants" ON "DecisionOption";
CREATE TRIGGER "DecisionOption_invariants"
  BEFORE INSERT OR UPDATE ON "DecisionOption"
  FOR EACH ROW EXECUTE FUNCTION decision_option_invariants();

-- ── 8. A kind's base classification is frozen once anything is classified by it ────────────────
-- `baseKind` is what downstream behaviour keys off. Re-pointing it after options already carry the
-- code silently re-classifies every one of them — no option row changes, so nothing that watches
-- options ever fires. Retiring a kind (`active = false`) and adding a new one is the honest change,
-- and it leaves the already-classified options saying what they always said.
--
-- Stated honestly about scope: in THIS unit nothing yet caches a base kind, so no downstream fact
-- can go stale. The freeze is installed now because it is cheap, because it is right on its own
-- terms, and because A1-ii introduces exactly the cached qualification that would otherwise make
-- this a live defect.
CREATE OR REPLACE FUNCTION decision_option_kind_base_frozen() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."baseKind" IS DISTINCT FROM OLD."baseKind"
     AND EXISTS (SELECT 1 FROM public."DecisionOption" o WHERE o."kindCode" = OLD."code") THEN
    RAISE EXCEPTION 'decisions: option kind % already classifies at least one option, so its base kind is frozen — retire it (active = false) and add a new kind instead of re-pointing this one.', OLD."code";
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionOptionKind_base_frozen" ON "DecisionOptionKind";
CREATE TRIGGER "DecisionOptionKind_base_frozen"
  BEFORE UPDATE ON "DecisionOptionKind"
  FOR EACH ROW EXECUTE FUNCTION decision_option_kind_base_frozen();

-- ── 9. Closing verification ───────────────────────────────────────────────────────────────────
-- The backfill is the one step that reads existing data. Re-derive its promises and abort the whole
-- migration if any fails — the file is one transaction, so an abort changes nothing.
DO $$
DECLARE v_incoherent INT; v_fabricated INT; v_confirmed INT; v_kindless INT;
BEGIN
  -- The touch seal was disabled across the backfill, so no touch row should bear this migration's
  -- own transaction id. `txid_current()` is exact here: the whole migration runs in one
  -- transaction, so a row carrying this txid could only have come from the backfill.
  SELECT COUNT(*) INTO v_fabricated
    FROM "DecisionOptionTouch" WHERE "txid" = txid_current();
  IF v_fabricated > 0 THEN
    RAISE EXCEPTION 'option kinds: the backfill fabricated % option-touch evidence row(s). Aborting with the database unchanged.', v_fabricated;
  END IF;

  SELECT COUNT(*) INTO v_confirmed FROM "DecisionOption" WHERE "costImpact" = 'confirmed';
  IF v_confirmed > 0 THEN
    RAISE EXCEPTION 'option kinds: the backfill asserted a CONFIRMED cost on % option(s); nothing in the history supports that finality. Aborting with the database unchanged.', v_confirmed;
  END IF;

  SELECT COUNT(*) INTO v_kindless FROM "DecisionOption" WHERE "kindCode" IS NULL;
  IF v_kindless > 0 THEN
    RAISE EXCEPTION 'option kinds: % option(s) were left without a kind. Aborting with the database unchanged.', v_kindless;
  END IF;

  SELECT COUNT(*) INTO v_incoherent FROM "DecisionOption"
   WHERE ("costImpact" IN ('estimated','confirmed') AND "costAmount" IS NULL)
      OR ("costImpact" IN ('pending','none') AND "costAmount" IS NOT NULL);
  IF v_incoherent > 0 THEN
    RAISE EXCEPTION 'option kinds: % option(s) carry a cost state and amount that disagree. Aborting with the database unchanged.', v_incoherent;
  END IF;
END $$;

COMMIT;
