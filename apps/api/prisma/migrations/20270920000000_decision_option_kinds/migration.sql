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
  -- `to_regtype`, not a bare `pg_type` scan. `typname` is not schema-qualified, so a same-named
  -- type in ANY other schema satisfies a database-wide EXISTS and this block then skips creating
  -- `public."OptionBaseKind"` — after which the CREATE TABLE below fails on a type that is not on
  -- the search path, and the deploy stops. The guard has to ask about the object the migration
  -- actually uses.
  IF to_regtype('public."OptionBaseKind"') IS NULL THEN
    CREATE TYPE public."OptionBaseKind" AS ENUM ('material', 'technology', 'solution', 'other');
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

-- The built-in menu, and the reason this is not a plain `ON CONFLICT DO NOTHING`.
--
-- On the supported pre-baseline path `schema.prisma` produces this TABLE without any of the guards
-- above, so the migration can meet rows that were never governed by anything. `DO NOTHING` accepts
-- whatever it finds — and then the freeze trigger installed below makes it PERMANENT. Reproduced by
-- execution before this was written: with `material` carrying `baseKind = 'technology'`, the file
-- re-applied with EXIT 0, the closing verification saw nothing, and every legacy and defaulted
-- option on that database silently read as a technology choice.
--
-- So the conflicting cases are separated by ONE question — could a legitimate operator action have
-- produced this row? — rather than by a list:
--
--   `baseKind` is NEVER legitimately different. It is frozen once anything is classified by it, and
--   for the column-default kind it is frozen outright, so a mismatch is corruption by construction.
--   ABORT, naming the row: this migration cannot know whether the options already carrying that
--   code meant the canonical classification or the one they found, and guessing would silently
--   re-classify a site's decisions.
--
--   `active = false` on the DEFAULT kind is equally impossible — the guard below refuses retiring
--   it — and it is not merely wrong but BREAKING: every insert from the still-serving release takes
--   that default and would be refused. ABORT.
--
--   `active = false` on any OTHER built-in is a legitimate act. Retiring a kind the menu no longer
--   offers is exactly what this unit provides, and a re-run that quietly resurrected it would undo
--   a deliberate decision. LEAVE IT.
--
-- `labelKey` and `displayOrder` are presentation and are reconciled to canonical without comment:
-- they carry no classification and no lifecycle.
DO $$
DECLARE v_bad TEXT;
BEGIN
  CREATE TEMP TABLE _kind_seed ("code" TEXT, "baseKind" "OptionBaseKind", "labelKey" TEXT, "displayOrder" INTEGER)
    ON COMMIT DROP;
  INSERT INTO _kind_seed VALUES
    ('material',   'material',   'option.kind.material',   10),
    ('technology', 'technology', 'option.kind.technology', 20),
    ('solution',   'solution',   'option.kind.solution',   30),
    ('other',      'other',      'option.kind.other',      40);

  SELECT string_agg(format('%s (baseKind is %s, canonical is %s)', k."code", k."baseKind", s."baseKind"), '; ')
    INTO v_bad
    FROM "DecisionOptionKind" k JOIN _kind_seed s ON s."code" = k."code"
   WHERE k."baseKind" IS DISTINCT FROM s."baseKind";
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'decisions A1-i: this database already holds built-in option kinds whose base classification is not the canonical one: %. Every option carrying that code is classified by it, so this migration will not overwrite it and will not adopt it. Reconcile the row (or the options) deliberately, then re-run.', v_bad;
  END IF;

  SELECT k."code" INTO v_bad
    FROM "DecisionOptionKind" k
   WHERE k."code" = 'material' AND NOT k."active";
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'decisions A1-i: the built-in option kind % is the column default this migration installs, and this database already has it RETIRED. Every insert from the still-serving release takes that default and would be refused at commit. Re-activate it deliberately, then re-run.', v_bad;
  END IF;

  INSERT INTO "DecisionOptionKind" ("code", "baseKind", "labelKey", "displayOrder", "active")
  SELECT s."code", s."baseKind", s."labelKey", s."displayOrder", true FROM _kind_seed s
  ON CONFLICT ("code") DO UPDATE
    SET "labelKey" = EXCLUDED."labelKey", "displayOrder" = EXCLUDED."displayOrder";
END $$;

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
                  WHERE conname = 'DecisionOption_kindCode_fkey'
                    AND conrelid = '"DecisionOption"'::regclass) THEN
    ALTER TABLE "DecisionOption" ADD CONSTRAINT "DecisionOption_kindCode_fkey"
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
--
-- The check runs at COMMIT, as a DEFERRABLE INITIALLY DEFERRED constraint trigger, and that timing
-- is the rule rather than a detail. Round 1 ran it BEFORE INSERT, which left a window this unit's
-- own probe now closes:
--
--   1. the option's BEFORE trigger reads the menu and finds NO row, because the kind is being
--      inserted `active = false` by another transaction that has not committed. A missing row
--      deliberately falls through here, so the foreign key can report an unknown code as an unknown
--      code rather than as a retirement.
--   2. that transaction COMMITS.
--   3. the foreign key's own check — an AFTER trigger taking a FRESH snapshot, not the statement's
--      original one — now SEES the row and passes.
--
-- and the option commits permanently classified by a kind that was never active. Reproduced by
-- execution before this was written, and it is worth being exact about the mechanism: the foreign
-- key does NOT block waiting for the concurrent inserter (a plain racing insert is refused
-- immediately, in milliseconds); the hole is the snapshot the FK check takes, not a wait.
--
-- At COMMIT there is no such window. Either the kind is visible — and its `active` is the committed
-- truth — or the foreign key already refused the row. One rule, evaluated once, against what is
-- actually true when the transaction lands.
CREATE OR REPLACE FUNCTION decision_option_kind_selectable() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE v_active BOOLEAN;
BEGIN
  -- FOR SHARE, and the strength is not incidental.
  --
  -- A retirement may still be in flight when this fires. Without the lock this reads the pre-
  -- retirement `active = true`, the retirement commits, and the option lands on a kind the menu no
  -- longer offers — exactly the state the rule promises cannot exist.
  --
  -- FOR KEY SHARE would NOT fix it: a plain `SET active = false` is a non-key update and takes
  -- FOR NO KEY UPDATE, which does not conflict with FOR KEY SHARE. Verified by execution rather
  -- than from the lock table: holding FOR KEY SHARE, the retirement proceeded; holding FOR SHARE,
  -- it blocked. Whichever transaction arrives second waits and then reads the other's committed
  -- answer — and a retirement that ROLLS BACK correctly leaves the selection standing.
  SELECT k."active" INTO v_active
    FROM public."DecisionOptionKind" k
   WHERE k."code" = NEW."kindCode"
     FOR SHARE;

  -- Tested as FOUND-and-inactive rather than NOT-FOUND-or-inactive. By commit time the foreign key
  -- has already passed, so a missing row is not reachable here; the shape is kept because it states
  -- what the rule is about — a kind that exists and is closed — and because calling a code that
  -- names no kind "retired" would send whoever hit it looking for a menu row that never existed.
  IF FOUND AND NOT v_active THEN
    RAISE EXCEPTION 'decisions: option kind % has been retired and cannot be selected for new options; choose one the menu still offers.', NEW."kindCode";
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "DecisionOption_kind_selectable" ON "DecisionOption";
DROP TRIGGER IF EXISTS "DecisionOption_kind_selectable_ins" ON "DecisionOption";
DROP TRIGGER IF EXISTS "DecisionOption_kind_selectable_upd" ON "DecisionOption";
CREATE CONSTRAINT TRIGGER "DecisionOption_kind_selectable_ins"
  AFTER INSERT ON "DecisionOption"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION decision_option_kind_selectable();
-- Split from the insert arm only because a WHEN clause may reference OLD on an UPDATE trigger and
-- not on one that also covers INSERT. Same function, same rule: an option already carrying a kind
-- is undisturbed, and only a deliberate re-classification is judged.
CREATE CONSTRAINT TRIGGER "DecisionOption_kind_selectable_upd"
  AFTER UPDATE ON "DecisionOption"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."kindCode" IS DISTINCT FROM OLD."kindCode")
  EXECUTE FUNCTION decision_option_kind_selectable();

-- ── 4a. …and the same rule, armed on the OTHER side ───────────────────────────────────────────
-- The rule above judges the OPTION. It has to judge the KIND too, and the reason is a hole a review
-- found by reading it rather than running it: a constraint trigger is USER-deferrable, so one
-- transaction can
--
--     INSERT the option on a kind that is active
--     SET CONSTRAINTS "DecisionOption_kind_selectable_ins" IMMEDIATE   -- discharge the check now
--     UPDATE the kind SET active = false                              -- queues no check of its own
--     COMMIT
--
-- and land an option classified by a kind that was active in NO committed state. Reproduced by
-- execution before this was written: the transaction committed, and the row is still there.
--
-- This is the THIRD round on this one rule, and the pattern is the finding. Round 1 armed the
-- foreign key. Round 2 armed the option side at commit. Each time I armed the direction I happened
-- to be looking at. So the rule is written once, symmetrically, and both arms are derived from it:
--
--     NO COMMITTED STATE MAY CONTAIN AN OPTION CLASSIFIED BY A KIND THAT IS NOT ACTIVE AT THAT
--     COMMIT — which must therefore be enforced when the OPTION changes AND when the KIND changes.
--
-- The kind arm cannot simply refuse retiring a kind options already carry: retiring a kind IN USE
-- is the whole point of retiring rather than deleting, and this unit asserts that an option
-- classified before a retirement keeps its classification. What it must refuse is retiring a kind
-- that was SELECTED IN THIS SAME TRANSACTION — the only case the option arm cannot see.
--
-- Transaction-scoped detection uses the note table this schema already established for exactly this
-- problem (`DecisionOptionTouch`, phase6-t4a round 13), and for its reasons: `txid_current()` is the
-- TOP-LEVEL id, so a note written inside a SAVEPOINT shares the option write's fate — `xmin` would
-- carry the SUBtransaction's id instead and an option inserted after a savepoint would slip past.
-- Notes from committed transactions are inert history; they are swept by the kind's own cascade.
CREATE TABLE IF NOT EXISTS "DecisionOptionKindSelection" (
  "kindCode" TEXT   NOT NULL,
  "txid"     BIGINT NOT NULL,
  CONSTRAINT "DecisionOptionKindSelection_pkey" PRIMARY KEY ("kindCode", "txid"),
  CONSTRAINT "DecisionOptionKindSelection_kindCode_fkey" FOREIGN KEY ("kindCode")
    REFERENCES "DecisionOptionKind"("code") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE OR REPLACE FUNCTION decision_option_kind_selection_guard() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  -- A note the writing transaction can erase is not evidence. `pg_trigger_depth() = 1` is a DIRECT
  -- statement; a cascade from the kind row itself arrives deeper and passes, so the sanctioned
  -- destructive resets need no new bypass.
  IF TG_OP = 'UPDATE' AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'decisions: option-kind selection notes are evidence rows and cannot be updated (kind %)', OLD."kindCode";
  END IF;
  IF TG_OP = 'DELETE' AND OLD."txid" = txid_current() AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION 'decisions: the option-kind selection note cannot be erased by the transaction that wrote it (kind %)', OLD."kindCode";
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "DecisionOptionKindSelection_guard" ON "DecisionOptionKindSelection";
CREATE TRIGGER "DecisionOptionKindSelection_guard"
  BEFORE UPDATE OR DELETE ON "DecisionOptionKindSelection"
  FOR EACH ROW EXECUTE FUNCTION decision_option_kind_selection_guard();

CREATE OR REPLACE FUNCTION decision_option_kind_selection_note() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public."DecisionOptionKindSelection"("kindCode", "txid")
  VALUES (NEW."kindCode", txid_current())
  ON CONFLICT DO NOTHING;
  -- …and sweep this kind's notes from OTHER transactions in the same statement.
  --
  -- A note is only ever read by the retirement guard, and only for the CURRENT transaction, so a
  -- note from a transaction that has finished is garbage. Without this the table grows by one row
  -- per option write, forever: the four built-in kinds are permanent, so their notes never reach
  -- the ON DELETE CASCADE that sweeps a retired custom kind's. Bounded here to roughly the number
  -- of transactions touching one kind at a time.
  --
  -- Only COMMITTED notes are visible to this DELETE, so a concurrent transaction's live note is
  -- never removed — and the note guard permits it, because the row it refuses is the one written
  -- by the deleting transaction itself.
  DELETE FROM public."DecisionOptionKindSelection"
   WHERE "kindCode" = NEW."kindCode" AND "txid" <> txid_current();
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS "DecisionOption_kind_selection_note_ins" ON "DecisionOption";
DROP TRIGGER IF EXISTS "DecisionOption_kind_selection_note_upd" ON "DecisionOption";
CREATE TRIGGER "DecisionOption_kind_selection_note_ins"
  AFTER INSERT ON "DecisionOption"
  FOR EACH ROW EXECUTE FUNCTION decision_option_kind_selection_note();
CREATE TRIGGER "DecisionOption_kind_selection_note_upd"
  AFTER UPDATE ON "DecisionOption"
  FOR EACH ROW WHEN (NEW."kindCode" IS DISTINCT FROM OLD."kindCode")
  EXECUTE FUNCTION decision_option_kind_selection_note();

CREATE OR REPLACE FUNCTION decision_option_kind_retire_guard() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."DecisionOptionKindSelection" n
              WHERE n."kindCode" = OLD."code" AND n."txid" = txid_current()) THEN
    RAISE EXCEPTION 'decisions: option kind % was selected for an option in this transaction, so it cannot be retired in the same transaction; the classification would name a kind the menu never offered.', OLD."code";
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "DecisionOptionKind_retire_guard" ON "DecisionOptionKind";
CREATE TRIGGER "DecisionOptionKind_retire_guard"
  BEFORE UPDATE ON "DecisionOptionKind"
  FOR EACH ROW WHEN (OLD."active" AND NOT NEW."active")
  EXECUTE FUNCTION decision_option_kind_retire_guard();

-- ── 4b. What was APPROVED cannot be silently re-described ─────────────────────────────
-- An approval is evidence about a CHOICE, and the option row is what says which choice that was.
-- Editing what the option SAYS IT IS leaves the evidence intact while changing what it attests to.
--
-- Round 1 of this PR froze `kindCode` against ONE approval table, and three review findings showed
-- that a partial freeze is not a weaker version of the rule — it is a different, incoherent rule.
-- So this states the invariant and derives from it, the same way the default-kind guard does:
--
--     an option belonging to a decision that carries durable approval evidence is itself
--     evidence, and the columns saying WHAT IT IS cannot be edited
--
-- Three things follow, and each was a finding:
--
--   1. BOTH identity columns this unit owns are covered — `kindCode` AND `description`. An option
--      may be identified by its description instead of its material (that is the point of adding
--      it), so freezing only the kind leaves the other half of the same identity editable.
--
--   2. EVERY durable approval signal counts, not the newest register. An upgraded database can
--      carry an approved decision with no `DecisionApprovalRevision` at all: the status itself,
--      the legacy stamp table, and recorded approval events are each independently sufficient, and
--      `change` counts because it means approved-then-questioned, not never-approved.
--
--   3. It is SERIALIZED. Under READ COMMITTED an approval committing concurrently is invisible to
--      a plain EXISTS, and the register's foreign key takes only KEY SHARE on the option, which
--      does not conflict with the non-key UPDATE reclassifying it — so both commit and the
--      evidence ends up describing something else. Locking the DECISION row is the repository's
--      established serialization point for exactly this (the task-4a seals do the same). It holds
--      for a reason stronger than "the service updates that row too": EVERY durable approval
--      signal is already written under that same lock — `DecisionApprovalRevision_no_withdrawn`
--      and `DecisionEvent_no_withdrawn_approval` each take `FOR UPDATE` on the parent decision
--      before judging it — so an approval recorded by RAW SQL, touching only the register and
--      never the decision's own status, serializes here just as an ordinary approve does.
--
-- SCOPE, stated rather than hidden. This covers the columns this unit ADDS. `material`, `label` and
-- `delta` on an approved option remain editable, which is PRE-EXISTING — verified by execution: on
-- an approved decision `SET "material" = 'Walnut'` succeeds today. That wider rule is the approval
-- register's own unit, where all of an option's identity is in scope together; this one does not
-- widen the hole and does not pretend to close it.
CREATE OR REPLACE FUNCTION decision_option_identity_frozen_once_approved() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE v_status TEXT; v_evidence TEXT;
BEGIN
  SELECT d."status"::text INTO v_status
    FROM public."Decision" d
   WHERE d."id" = OLD."decisionId"
     FOR UPDATE;

  IF v_status IN ('approved', 'change') THEN
    v_evidence := 'the decision is ' || v_status;
  ELSIF EXISTS (SELECT 1 FROM public."DecisionApprovalRevision" r
                 WHERE r."decisionId" = OLD."decisionId") THEN
    v_evidence := 'an entry in the approval register';
  ELSIF EXISTS (SELECT 1 FROM public."DecisionLegacyApproval" l
                 WHERE l."decisionId" = OLD."decisionId") THEN
    v_evidence := 'a legacy approval stamp';
  ELSIF EXISTS (SELECT 1 FROM public."DecisionEvent" e
                 WHERE e."decisionId" = OLD."decisionId"
                   AND e."type" IN ('approved', 'reapproved')) THEN
    v_evidence := 'a recorded approval event';
  END IF;

  IF v_evidence IS NOT NULL THEN
    RAISE EXCEPTION 'decisions: option % belongs to a decision carrying %, so what that option says it IS cannot be edited — its kind and description are part of the evidence.', OLD."optionKey", v_evidence;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionOption_kind_frozen_once_approved" ON "DecisionOption";
DROP TRIGGER IF EXISTS "DecisionOption_identity_frozen_once_approved" ON "DecisionOption";
CREATE TRIGGER "DecisionOption_identity_frozen_once_approved"
  BEFORE UPDATE ON "DecisionOption"
  FOR EACH ROW WHEN (NEW."kindCode" IS DISTINCT FROM OLD."kindCode"
                     OR NEW."description" IS DISTINCT FROM OLD."description")
  EXECUTE FUNCTION decision_option_identity_frozen_once_approved();

-- ── 5. What a menu row may not do once it is load-bearing ─────────────────────────────────────
-- Two rules, both about a kind that something else already depends on.
--
-- `baseKind` is what downstream behaviour keys off. Re-pointing it after options already carry the
-- code silently re-classifies every one of them — and no option row changes, so nothing that
-- watches options would ever fire. Retiring the kind and adding a new one is the honest change, and
-- it leaves the already-classified options saying what they always said.
--
-- The DEFAULT kind is load-bearing for a different reason: the currently serving release does not
-- know `kindCode` exists, names no kind, and takes the column default on EVERY insert. Removing it
-- takes that release down by a data edit. Round 1 guarded only the retirement of it and missed the
-- two other ways to remove the same thing — DELETE, and re-keying it out from under the default —
-- both of which succeed on an option-empty database where no foreign key stands in the way.
--
-- Which kind that is comes from the catalog, EVALUATED rather than string-matched, so the guard
-- tracks the column instead of a memory of it: when a later unit changes or drops the default, this
-- protection follows it without being remembered.
CREATE OR REPLACE FUNCTION decision_option_kind_frozen() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
DECLARE v_defexpr TEXT; v_default TEXT;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_defexpr
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'public."DecisionOption"'::regclass
     AND a.attname = 'kindCode';
  IF v_defexpr IS NOT NULL THEN
    EXECUTE format('SELECT (%s)::text', v_defexpr) INTO v_default;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF v_default IS NOT NULL AND OLD."code" = v_default THEN
      RAISE EXCEPTION 'decisions: option kind % is the column default the currently serving release relies on, and cannot be deleted while it is; a database with no options yet has no foreign key to stop this, which is exactly when it would go unnoticed.', OLD."code";
    END IF;
    RETURN OLD;
  END IF;

  IF NEW."baseKind" IS DISTINCT FROM OLD."baseKind"
     AND EXISTS (SELECT 1 FROM public."DecisionOption" o WHERE o."kindCode" = OLD."code") THEN
    RAISE EXCEPTION 'decisions: option kind % already classifies at least one option, so its base kind is frozen — retire it (active = false) and add a new kind instead of re-pointing this one.', OLD."code";
  END IF;

  -- The four arms below are DERIVED from one sentence rather than enumerated, and the difference
  -- is why an earlier round shipped three of them and missed the fourth:
  --
  --   the row the column default names must stay PRESENT, ACTIVE and CORRECTLY CLASSIFIED for as
  --   long as a serving release depends on that default.
  --
  -- DELETE breaks `present`. Re-keying breaks `present`. `active = false` breaks `active`. And a
  -- `baseKind` change breaks `correctly classified` — which the reference test above cannot catch,
  -- because on an option-EMPTY database nothing references the kind yet and the EXISTS is false.
  -- That is exactly the install where it matters: every later insert from the still-serving
  -- release omits `kindCode`, takes this default, and is then read as whatever it was re-pointed
  -- to.
  IF v_default IS NOT NULL AND OLD."code" = v_default THEN
    IF NEW."baseKind" IS DISTINCT FROM OLD."baseKind" THEN
      RAISE EXCEPTION 'decisions: option kind % is the column default the currently serving release relies on, so its base kind cannot be re-pointed — every option that release writes takes this default and would silently become a % choice.', OLD."code", NEW."baseKind";
    END IF;
    IF OLD."active" AND NOT NEW."active" THEN
      RAISE EXCEPTION 'decisions: option kind % is the column default the currently serving release relies on, and cannot be retired while it is; retire it only once no release depends on the default.', OLD."code";
    END IF;
    IF NEW."code" IS DISTINCT FROM OLD."code" THEN
      RAISE EXCEPTION 'decisions: option kind % is the column default the currently serving release relies on, and cannot be re-keyed while it is; renaming it leaves the default naming a kind that no longer exists.', OLD."code";
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "DecisionOptionKind_frozen" ON "DecisionOptionKind";
CREATE TRIGGER "DecisionOptionKind_frozen"
  BEFORE UPDATE OR DELETE ON "DecisionOptionKind"
  FOR EACH ROW EXECUTE FUNCTION decision_option_kind_frozen();

-- ── 5b. The registry cannot be truncated ──────────────────────────────────────────────────────
-- Every rule above is a ROW trigger, and TRUNCATE fires none of them. The blast radius was measured
-- rather than assumed, because it is larger than it looks: `TRUNCATE "DecisionOptionKind" CASCADE`
-- on a populated database cascaded into
--
--     DecisionOption, WorkerAllocation, SupplierLabourQuoteLine, LabourPurchaseOrderLine,
--     LabourWorkFact, CapacityCommitment, CommitmentAttribution, Measurement, VendorBillLine,
--     CapacityPromise, CertifiedMeasurementConsumption
--
-- — the whole labour and commercial spine, because those chain back through requirement specs to
-- the approval register, and the register points at options. The approved decisions SURVIVE, still
-- saying `approved`, with the evidence of what was approved gone. And afterwards the serving
-- release cannot insert an option at all, because the `material` default names a row that no longer
-- exists. One statement against a four-row lookup table.
--
-- TRUNCATE is grantable separately from ownership, so it is also WEAKER than the
-- `ALTER TABLE ... DISABLE TRIGGER` boundary every sanctioned bypass in this schema standardizes
-- on. The seal is blanket rather than carrying the empty-case permit its siblings use: those tables
-- can legitimately be empty during a fixture reset, and this one cannot — the migration seeds four
-- built-ins and the default-kind guard makes removing them unrepresentable. Nothing references this
-- table with ON DELETE CASCADE either, so no reset can arrive here by cascade.
CREATE OR REPLACE FUNCTION decision_option_kind_no_truncate() RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'decisions: the option kind registry is the vocabulary every option is classified by and cannot be truncated; retire a kind you no longer offer instead.';
END $$;
DROP TRIGGER IF EXISTS "DecisionOptionKind_no_truncate" ON "DecisionOptionKind";
CREATE TRIGGER "DecisionOptionKind_no_truncate"
  BEFORE TRUNCATE ON "DecisionOptionKind"
  FOR EACH STATEMENT EXECUTE FUNCTION decision_option_kind_no_truncate();

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
