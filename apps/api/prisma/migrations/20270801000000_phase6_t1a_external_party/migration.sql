-- Phase 6 unit 6.1a — the canonical external party, its per-project association, and the
-- per-origin sources that justify it. From the cleared foundation plan (PR #324, `main`
-- `adfaff6`); §A identity, §E the promotion seam, §F tenancy.
--
-- ADDITIVE and DIAGNOSTIC-FIRST. Nothing here edits or invents a fact: existing `Vendor` and
-- `ProjectCompany` rows each receive their OWN party, and the migration deliberately MERGES
-- NOTHING. A firm that is both a vendor and a project company therefore ends with two parties,
-- which is correct — deciding they are one firm is a human judgement, and the operator
-- merge/repoint command (unit 6.1b) is the place that judgement is recorded.
--
-- Order matters and is load-bearing: nullable columns -> backfill -> constraints -> NOT NULL.
-- Adding the seals before the backfill would reject the very rows the backfill exists to create.

-- ── diagnostics (abort before any structural change) ─────────────────────────────────────────
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  -- A ProjectCompany whose project has no resolvable org cannot receive an org-scoped party,
  -- and guessing one would fabricate a tenant. Report and abort instead.
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT c."id" FROM "ProjectCompany" c
      LEFT JOIN "Project" p ON p."id" = c."projectId"
     WHERE p."id" IS NULL OR p."orgId" IS NULL
     LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t1a: % ProjectCompany row(s) have no resolvable project org (sample: %). Repair the project reference, then redeploy.', bad, sample;
  END IF;

  -- A ProjectVendor whose org disagrees with its project's org would mirror an association into
  -- the wrong tenant. The Phase-3 composite FKs make this unrepresentable going forward; the
  -- check exists so a legacy database is never silently carried across.
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT b."id" FROM "ProjectVendor" b
      JOIN "Project" p ON p."id" = b."projectId"
     WHERE p."orgId" <> b."orgId"
     LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t1a: % ProjectVendor row(s) disagree with their project org (sample: %). Repair the binding, then redeploy.', bad, sample;
  END IF;

  -- The backfill copies these names into `ExternalParty.name`, which is non-blank by CHECK. A
  -- legacy blank would otherwise surface as an opaque constraint violation partway through the
  -- backfill; naming the rows is the difference between a repairable abort and a puzzle.
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT 'Vendor:' || v."id" AS id FROM "Vendor" v
     WHERE btrim(v."name", E' \t\n\x0B\f\r') = ''
    UNION ALL
    SELECT 'ProjectCompany:' || c."id" FROM "ProjectCompany" c
     WHERE btrim(c."name", E' \t\n\x0B\f\r') = ''
     LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t1a: % firm row(s) have a blank name (sample: %). The canonical party carries the firm name and cannot be blank; give each row a real name, then redeploy.', bad, sample;
  END IF;
END $$;

-- ── the canonical party ──────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "ExternalParty" (
  "id"            TEXT NOT NULL,
  "orgId"         TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL only for rows this backfill created: `ProjectCompany` has no creator column, so a
  -- party derived from one has no attributable author, and recording that is honest where
  -- inventing an actor would not be.
  "createdById"   TEXT,
  "promotedOrgId" TEXT,
  CONSTRAINT "ExternalParty_pkey" PRIMARY KEY ("id"),
  -- The firm's name is what a person reads to decide WHO they are granting access to, so a name
  -- of spaces is an identity nobody can verify. `btrim` alone strips spaces only; the explicit
  -- class covers the whole ASCII whitespace set, matching the repository's existing discipline.
  CONSTRAINT "ExternalParty_name_not_blank" CHECK (btrim("name", E' \t\n\x0B\f\r') <> '')
);
CREATE UNIQUE INDEX IF NOT EXISTS "ExternalParty_orgId_id_key" ON "ExternalParty"("orgId", "id");
CREATE INDEX IF NOT EXISTS "ExternalParty_orgId_idx" ON "ExternalParty"("orgId");
ALTER TABLE "ExternalParty" DROP CONSTRAINT IF EXISTS "ExternalParty_orgId_fkey";
ALTER TABLE "ExternalParty" ADD CONSTRAINT "ExternalParty_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalParty" DROP CONSTRAINT IF EXISTS "ExternalParty_createdById_fkey";
ALTER TABLE "ExternalParty" ADD CONSTRAINT "ExternalParty_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
-- §E: the promotion target is a REAL tenant, not a string. One-way and one-to-one both operate on
-- the value; neither proves the org exists. A typo written by a repair would then be frozen
-- forever, because correcting it IS the transition the one-way trigger refuses — the guard and
-- the gap combine into an unrepairable row unless the reference is checked at write time.
ALTER TABLE "ExternalParty" DROP CONSTRAINT IF EXISTS "ExternalParty_promotedOrgId_fkey";
ALTER TABLE "ExternalParty" ADD CONSTRAINT "ExternalParty_promotedOrgId_fkey"
  FOREIGN KEY ("promotedOrgId") REFERENCES "Org"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- §E — the promotion seam ships FROZEN. The promotion command is deferred out of Phase 6, which
-- is exactly why these guards land now: nothing in this phase sets `promotedOrgId`, so nothing
-- in this phase would stop a later retry or repair moving a party from one tenant to another,
-- and historical guest work attributed through that party would resolve to the wrong tenant.
--
-- One-way AND one-to-one are two properties and the first does not imply the second: the trigger
-- stops a promoted party MOVING, the partial unique stops two parties pointing at one tenant.
-- The unique is scoped to the OWNER org because `ExternalParty` is owner-org-scoped by design —
-- a supplier working with two owner orgs legitimately has a local party in each, and a global
-- unique would let the first owner link and then refuse the second.
CREATE UNIQUE INDEX IF NOT EXISTS "ExternalParty_orgId_promotedOrgId_key"
  ON "ExternalParty"("orgId", "promotedOrgId") WHERE "promotedOrgId" IS NOT NULL;

CREATE OR REPLACE FUNCTION "phase6_party_promotion_one_way"() RETURNS trigger AS $$
BEGIN
  IF OLD."promotedOrgId" IS NOT NULL AND NEW."promotedOrgId" IS DISTINCT FROM OLD."promotedOrgId" THEN
    RAISE EXCEPTION 'phase6: ExternalParty.promotedOrgId is one-way — % is already promoted to org %, and a promotion cannot be moved or cleared', OLD."id", OLD."promotedOrgId";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ExternalParty_promotion_one_way" ON "ExternalParty";
CREATE TRIGGER "ExternalParty_promotion_one_way"
  BEFORE UPDATE ON "ExternalParty"
  FOR EACH ROW EXECUTE FUNCTION "phase6_party_promotion_one_way"();

-- ── the party columns on the three existing tables (nullable until backfilled) ───────────────
ALTER TABLE "Vendor"         ADD COLUMN IF NOT EXISTS "partyId" TEXT;
ALTER TABLE "ProjectCompany" ADD COLUMN IF NOT EXISTS "orgId"   TEXT;
ALTER TABLE "ProjectCompany" ADD COLUMN IF NOT EXISTS "partyId" TEXT;
ALTER TABLE "ProjectVendor"  ADD COLUMN IF NOT EXISTS "partyId" TEXT;

-- ── backfill: one party per existing row, merging NOTHING ────────────────────────────────────
-- Deterministic ids derived from the source row, so a re-run is idempotent and an operator can
-- trace any party back to the row that produced it.
INSERT INTO "ExternalParty" ("id", "orgId", "name", "createdAt", "createdById")
SELECT 'p6v_' || v."id", v."orgId", v."name", v."createdAt", v."createdById"
  FROM "Vendor" v
ON CONFLICT ("id") DO NOTHING;

UPDATE "Vendor" v SET "partyId" = 'p6v_' || v."id" WHERE v."partyId" IS NULL;

INSERT INTO "ExternalParty" ("id", "orgId", "name", "createdAt", "createdById")
SELECT 'p6c_' || c."id", p."orgId", c."name", c."createdAt", NULL
  FROM "ProjectCompany" c JOIN "Project" p ON p."id" = c."projectId"
ON CONFLICT ("id") DO NOTHING;

UPDATE "ProjectCompany" c
   SET "orgId"   = p."orgId",
       "partyId" = 'p6c_' || c."id"
  FROM "Project" p
 WHERE p."id" = c."projectId" AND (c."orgId" IS NULL OR c."partyId" IS NULL);

-- A binding inherits its vendor's party: the copy must be provably the vendor's own.
UPDATE "ProjectVendor" b SET "partyId" = v."partyId"
  FROM "Vendor" v
 WHERE v."id" = b."vendorId" AND b."partyId" IS NULL;

-- ── NOT NULL, now that every row has a value ─────────────────────────────────────────────────
ALTER TABLE "Vendor"         ALTER COLUMN "partyId" SET NOT NULL;
ALTER TABLE "ProjectCompany" ALTER COLUMN "orgId"   SET NOT NULL;
ALTER TABLE "ProjectCompany" ALTER COLUMN "partyId" SET NOT NULL;
ALTER TABLE "ProjectVendor"  ALTER COLUMN "partyId" SET NOT NULL;

-- ── the seals ────────────────────────────────────────────────────────────────────────────────
-- Same-org composite FKs throughout, so a cross-org party link is UNREPRESENTABLE rather than
-- refused by a service that has to remember to check.
CREATE UNIQUE INDEX IF NOT EXISTS "Vendor_orgId_id_partyId_key" ON "Vendor"("orgId", "id", "partyId");
CREATE INDEX IF NOT EXISTS "Vendor_orgId_partyId_idx" ON "Vendor"("orgId", "partyId");
ALTER TABLE "Vendor" DROP CONSTRAINT IF EXISTS "Vendor_orgId_partyId_fkey";
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_orgId_partyId_fkey"
  FOREIGN KEY ("orgId", "partyId") REFERENCES "ExternalParty"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The org copy is bound to the project itself. Without this a row could keep `projectId` on an
-- org-A project, set its copied `orgId` to org B and point at an org-B party, and both the
-- project FK and the party FK would pass.
-- …and it REPLACES the original single-column `projectId` key rather than joining it. PostgreSQL
-- enforces every foreign key on a row, so a CASCADE key beside a NO ACTION key to the same parent
-- means the NO ACTION one wins: deleting a project that holds a directory row would have started
-- failing, silently, for a reason nothing in this unit is about. Two keys to one parent with
-- different delete actions is an incoherent seal, not a stronger one — and the composite key
-- subsumes the single column, so the single column goes and the CASCADE moves onto the survivor.
ALTER TABLE "ProjectCompany" DROP CONSTRAINT IF EXISTS "ProjectCompany_projectId_fkey";
ALTER TABLE "ProjectCompany" DROP CONSTRAINT IF EXISTS "ProjectCompany_orgId_projectId_fkey";
ALTER TABLE "ProjectCompany" ADD CONSTRAINT "ProjectCompany_orgId_projectId_fkey"
  FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ProjectCompany" DROP CONSTRAINT IF EXISTS "ProjectCompany_orgId_partyId_fkey";
ALTER TABLE "ProjectCompany" ADD CONSTRAINT "ProjectCompany_orgId_partyId_fkey"
  FOREIGN KEY ("orgId", "partyId") REFERENCES "ExternalParty"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX IF NOT EXISTS "ProjectCompany_orgId_partyId_idx" ON "ProjectCompany"("orgId", "partyId");
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectCompany_orgId_projectId_partyId_id_key"
  ON "ProjectCompany"("orgId", "projectId", "partyId", "id");

-- §A: one party holds at most ONE association per project THROUGH EACH ORIGIN KIND. The merge
-- command (6.1b) must resolve a same-project collision explicitly rather than repoint into it
-- and leave two directory rows for one firm with independently editable identities. Diagnosed
-- BEFORE the index, because `CREATE UNIQUE INDEX` on its own reports a duplicated key without
-- saying which invariant it belongs to — the same opacity a Phase 3 review already rejected.
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  SELECT count(*), string_agg(DISTINCT "projectId" || '/' || "partyId", ', ')
    INTO bad, sample
    FROM (SELECT "projectId", "partyId" FROM "ProjectCompany"
           GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 20) d;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t1a: backfill produced % project/party pair(s) held by more than one ProjectCompany (sample: %). One party per project per origin kind is a §A invariant; this is a migration defect, not a data problem.', bad, sample;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectCompany_projectId_partyId_key" ON "ProjectCompany"("projectId", "partyId");

-- The binding's party copy is bound THROUGH the vendor's party, not to `ExternalParty`
-- directly: otherwise a same-org row could bind project A to vendor V1 while naming party P2.
--
-- ON UPDATE CASCADE, because the copy is DERIVED and a derived value has to follow its source.
-- With the key frozen there is no order in which 6.1b's merge can repoint an already-bound
-- vendor: moving the vendor first orphans the binding, and moving the binding first names a
-- parent key that does not exist yet. The merge would have been unable to reconcile exactly the
-- firms most worth reconciling — the ones already trading on a project.
ALTER TABLE "ProjectVendor" DROP CONSTRAINT IF EXISTS "ProjectVendor_orgId_vendorId_partyId_fkey";
ALTER TABLE "ProjectVendor" ADD CONSTRAINT "ProjectVendor_orgId_vendorId_partyId_fkey"
  FOREIGN KEY ("orgId", "vendorId", "partyId") REFERENCES "Vendor"("orgId", "id", "partyId") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProjectVendor" DROP CONSTRAINT IF EXISTS "ProjectVendor_orgId_partyId_fkey";
ALTER TABLE "ProjectVendor" ADD CONSTRAINT "ProjectVendor_orgId_partyId_fkey"
  FOREIGN KEY ("orgId", "partyId") REFERENCES "ExternalParty"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX IF NOT EXISTS "ProjectVendor_orgId_partyId_idx" ON "ProjectVendor"("orgId", "partyId");
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectVendor_orgId_projectId_partyId_id_key"
  ON "ProjectVendor"("orgId", "projectId", "partyId", "id");

-- The same §A seal on the binding side. `(projectId, vendorId)` was already unique and the party
-- is derived from the vendor, so the backfill cannot violate this — but 6.1b's merge REPOINTS
-- `partyId`, and after that the derivation no longer holds. The seal is what makes the merge's
-- same-project refusal enforceable rather than a rule it is trusted to remember.
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  SELECT count(*), string_agg(DISTINCT "projectId" || '/' || "partyId", ', ')
    INTO bad, sample
    FROM (SELECT "projectId", "partyId" FROM "ProjectVendor"
           GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 20) d;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t1a: backfill produced % project/party pair(s) held by more than one ProjectVendor (sample: %). One party per project per origin kind is a §A invariant; this is a migration defect, not a data problem.', bad, sample;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectVendor_projectId_partyId_key" ON "ProjectVendor"("projectId", "partyId");

-- ── the canonical association ────────────────────────────────────────────────────────────────
-- The ONLY table the collaborator resolver reads, so it carries the org seal on BOTH sides: a
-- row pairing an org-A project with an org-B party would associate them no matter how well
-- every other table is sealed.
CREATE TABLE IF NOT EXISTS "ProjectParty" (
  "id"        TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "partyId"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectParty_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectParty_projectId_partyId_key" ON "ProjectParty"("projectId", "partyId");
CREATE INDEX IF NOT EXISTS "ProjectParty_orgId_partyId_idx" ON "ProjectParty"("orgId", "partyId");
ALTER TABLE "ProjectParty" DROP CONSTRAINT IF EXISTS "ProjectParty_orgId_projectId_fkey";
ALTER TABLE "ProjectParty" ADD CONSTRAINT "ProjectParty_orgId_projectId_fkey"
  FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ProjectParty" DROP CONSTRAINT IF EXISTS "ProjectParty_orgId_partyId_fkey";
ALTER TABLE "ProjectParty" ADD CONSTRAINT "ProjectParty_orgId_partyId_fkey"
  FOREIGN KEY ("orgId", "partyId") REFERENCES "ExternalParty"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── which SOURCE justifies the association ───────────────────────────────────────────────────
-- One table per origin, not a `(projectId, partyId, source)` triple with a discriminator: a
-- discriminated triple has no source-specific key, so no ordinary foreign key can bind a vendor
-- row to the `ProjectVendor` justifying it, and every way the row could drift from its origin
-- has to be caught by a hand-written guard. Here a source row outliving its origin is
-- UNREPRESENTABLE — the FK cascades.
--
-- The FK carries the project and the party, not just the origin id. An FK to the origin alone
-- would say only "some binding exists in this org", so a row justifying ProjectParty(project B,
-- party P) could point at an origin on project A and pass.
--
-- The association side is ON DELETE RESTRICT, not CASCADE. Cascading made the seal circular: a
-- direct delete of `ProjectParty` took its own justification with it, and the deferred check then
-- counted zero sources and returned satisfied — leaving a `ProjectCompany` whose firm no
-- association names, which is the state the check exists to prevent. RESTRICT refuses that delete
-- instead, and the legitimate order is unaffected: the release path removes the association only
-- once both source counts are already zero.
CREATE TABLE IF NOT EXISTS "ProjectPartyCompanySource" (
  "id"               TEXT NOT NULL,
  "orgId"            TEXT NOT NULL,
  "projectId"        TEXT NOT NULL,
  "partyId"          TEXT NOT NULL,
  "projectCompanyId" TEXT NOT NULL,
  CONSTRAINT "ProjectPartyCompanySource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectPartyCompanySource_projectCompanyId_key" ON "ProjectPartyCompanySource"("projectCompanyId");
CREATE INDEX IF NOT EXISTS "ProjectPartyCompanySource_projectId_partyId_idx" ON "ProjectPartyCompanySource"("projectId", "partyId");
ALTER TABLE "ProjectPartyCompanySource" DROP CONSTRAINT IF EXISTS "ProjectPartyCompanySource_association_fkey";
ALTER TABLE "ProjectPartyCompanySource" ADD CONSTRAINT "ProjectPartyCompanySource_association_fkey"
  FOREIGN KEY ("projectId", "partyId") REFERENCES "ProjectParty"("projectId", "partyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectPartyCompanySource" DROP CONSTRAINT IF EXISTS "ProjectPartyCompanySource_origin_fkey";
ALTER TABLE "ProjectPartyCompanySource" ADD CONSTRAINT "ProjectPartyCompanySource_origin_fkey"
  FOREIGN KEY ("orgId", "projectId", "partyId", "projectCompanyId")
  REFERENCES "ProjectCompany"("orgId", "projectId", "partyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "ProjectPartyVendorSource" (
  "id"              TEXT NOT NULL,
  "orgId"           TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "partyId"         TEXT NOT NULL,
  "projectVendorId" TEXT NOT NULL,
  CONSTRAINT "ProjectPartyVendorSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProjectPartyVendorSource_projectVendorId_key" ON "ProjectPartyVendorSource"("projectVendorId");
CREATE INDEX IF NOT EXISTS "ProjectPartyVendorSource_projectId_partyId_idx" ON "ProjectPartyVendorSource"("projectId", "partyId");
ALTER TABLE "ProjectPartyVendorSource" DROP CONSTRAINT IF EXISTS "ProjectPartyVendorSource_association_fkey";
ALTER TABLE "ProjectPartyVendorSource" ADD CONSTRAINT "ProjectPartyVendorSource_association_fkey"
  FOREIGN KEY ("projectId", "partyId") REFERENCES "ProjectParty"("projectId", "partyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProjectPartyVendorSource" DROP CONSTRAINT IF EXISTS "ProjectPartyVendorSource_origin_fkey";
ALTER TABLE "ProjectPartyVendorSource" ADD CONSTRAINT "ProjectPartyVendorSource_origin_fkey"
  FOREIGN KEY ("orgId", "projectId", "partyId", "projectVendorId")
  REFERENCES "ProjectVendor"("orgId", "projectId", "partyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── mirror the existing rows into the association ────────────────────────────────────────────
INSERT INTO "ProjectParty" ("id", "orgId", "projectId", "partyId")
SELECT DISTINCT ON (s."projectId", s."partyId") 'pp_' || s."projectId" || '_' || s."partyId", s."orgId", s."projectId", s."partyId"
  FROM (
    SELECT c."orgId", c."projectId", c."partyId" FROM "ProjectCompany" c
    UNION ALL
    SELECT b."orgId", b."projectId", b."partyId" FROM "ProjectVendor" b
  ) s
ON CONFLICT ("projectId", "partyId") DO NOTHING;

INSERT INTO "ProjectPartyCompanySource" ("id", "orgId", "projectId", "partyId", "projectCompanyId")
SELECT 'ppcs_' || c."id", c."orgId", c."projectId", c."partyId", c."id" FROM "ProjectCompany" c
ON CONFLICT ("projectCompanyId") DO NOTHING;

INSERT INTO "ProjectPartyVendorSource" ("id", "orgId", "projectId", "partyId", "projectVendorId")
SELECT 'ppvs_' || b."id", b."orgId", b."projectId", b."partyId", b."id" FROM "ProjectVendor" b
ON CONFLICT ("projectVendorId") DO NOTHING;

-- ── the association exists IF AND ONLY IF a source justifies it ──────────────────────────────
-- DEFERRED, and checked at COMMIT rather than per statement, because the two participants that
-- own the source rows write independently: two transactions removing different sources would
-- each see the other's row, each conclude it is not the last remover, and both commit — leaving
-- an association alive with nothing justifying it, ready to receive grants.
CREATE OR REPLACE FUNCTION "phase6_project_party_sourced"() RETURNS trigger AS $$
DECLARE target_project TEXT; target_party TEXT; sources BIGINT; assoc BIGINT;
BEGIN
  -- Which association is at risk? For a source LEAVING (a delete, or an update that repoints it
  -- onto a different party) it is the one it left — OLD. `ON UPDATE CASCADE` on the origin key
  -- means a repoint is exactly how 6.1b's merge moves a source, so checking only NEW would let a
  -- merge strand the abandoned association with nothing justifying it, still readable by the
  -- resolver. For a new association appearing it is NEW.
  IF TG_OP = 'INSERT' THEN
    target_project := NEW."projectId"; target_party := NEW."partyId";
  ELSIF TG_OP = 'DELETE' THEN
    target_project := OLD."projectId"; target_party := OLD."partyId";
  ELSIF TG_TABLE_NAME = 'ProjectParty' THEN
    target_project := NEW."projectId"; target_party := NEW."partyId";
  ELSE
    target_project := OLD."projectId"; target_party := OLD."partyId";
  END IF;

  -- LOCK the association before counting. A check that only reads is not a check that
  -- serializes: two transactions each removing one of the two last justifications would each see
  -- the other's row still present, both conclude the association is still supported, and both
  -- commit — leaving a resolver target no row justifies. The lock makes the second re-read after
  -- the first has committed, which is the whole point of counting at all.
  SELECT count(*) INTO assoc FROM (
    SELECT 1 FROM "ProjectParty"
     WHERE "projectId" = target_project AND "partyId" = target_party
     FOR UPDATE) locked;
  IF assoc = 0 THEN RETURN NULL; END IF;

  SELECT (SELECT count(*) FROM "ProjectPartyCompanySource"
           WHERE "projectId" = target_project AND "partyId" = target_party)
       + (SELECT count(*) FROM "ProjectPartyVendorSource"
           WHERE "projectId" = target_project AND "partyId" = target_party)
    INTO sources;

  IF sources = 0 THEN
    RAISE EXCEPTION 'phase6: ProjectParty(project %, party %) has no source justifying it — an association exists only while a ProjectCompany or ProjectVendor supports it', target_project, target_party;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ProjectParty_sourced" ON "ProjectParty";
CREATE CONSTRAINT TRIGGER "ProjectParty_sourced"
  AFTER INSERT OR UPDATE ON "ProjectParty"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "phase6_project_party_sourced"();

DROP TRIGGER IF EXISTS "ProjectPartyCompanySource_association_sourced" ON "ProjectPartyCompanySource";
CREATE CONSTRAINT TRIGGER "ProjectPartyCompanySource_association_sourced"
  AFTER DELETE OR UPDATE ON "ProjectPartyCompanySource"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "phase6_project_party_sourced"();

DROP TRIGGER IF EXISTS "ProjectPartyVendorSource_association_sourced" ON "ProjectPartyVendorSource";
CREATE CONSTRAINT TRIGGER "ProjectPartyVendorSource_association_sourced"
  AFTER DELETE OR UPDATE ON "ProjectPartyVendorSource"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "phase6_project_party_sourced"();

-- ── the ORIGIN side of the same obligation ──────────────────────────────────────────────────
-- Three statements make up "this firm is reachable on this project", and the seals above only
-- covered two of them: a SOURCE must have an origin (the origin FK), and an ASSOCIATION must have
-- a source (the sourced trigger). Nothing required an ORIGIN to have a source.
--
-- So a `ProjectCompany` or `ProjectVendor` written outside its service — an operator import, a
-- repair script, a raw fixture — could name a party and commit with no source and no association
-- at all. No trigger fires, because every trigger hangs off the two tables that were never
-- written. The directory row exists, the firm is real, and the collaborator resolver (which reads
-- `ProjectParty` and nothing else) cannot see it. An invisible counterparty is not a safe failure:
-- it is a firm whose access nobody can grant, revoke or audit.
--
-- Deferred, because the service legitimately writes the origin before its source in one
-- transaction. Checked at COMMIT, when the whole obligation is either satisfied or is not.
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  SELECT count(*), COALESCE(string_agg(x.id, ', ' ORDER BY x.id), '') INTO bad, sample FROM (
    SELECT 'ProjectCompany:' || c."id" AS id FROM "ProjectCompany" c
     WHERE NOT EXISTS (SELECT 1 FROM "ProjectPartyCompanySource" s WHERE s."projectCompanyId" = c."id")
    UNION ALL
    SELECT 'ProjectVendor:' || b."id" FROM "ProjectVendor" b
     WHERE NOT EXISTS (SELECT 1 FROM "ProjectPartyVendorSource" s WHERE s."projectVendorId" = b."id")
     LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t1a: % firm row(s) carry a party with no source recording it (sample: %). The mirror above creates one per row; this is a migration defect, not a data problem.', bad, sample;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "phase6_origin_sourced"() RETURNS trigger AS $$
DECLARE still_there BIGINT; sourced BIGINT;
BEGIN
  -- The row may have been deleted later in the same transaction; a deferred check must judge the
  -- state at COMMIT, and a row that no longer exists owes nothing.
  IF TG_TABLE_NAME = 'ProjectCompany' THEN
    SELECT count(*) INTO still_there FROM "ProjectCompany" WHERE "id" = NEW."id";
    IF still_there = 0 THEN RETURN NULL; END IF;
    SELECT count(*) INTO sourced FROM "ProjectPartyCompanySource" WHERE "projectCompanyId" = NEW."id";
  ELSE
    SELECT count(*) INTO still_there FROM "ProjectVendor" WHERE "id" = NEW."id";
    IF still_there = 0 THEN RETURN NULL; END IF;
    SELECT count(*) INTO sourced FROM "ProjectPartyVendorSource" WHERE "projectVendorId" = NEW."id";
  END IF;

  IF sourced = 0 THEN
    RAISE EXCEPTION 'phase6: % % names party % with no source row recording it, so no ProjectParty association exists and the firm is invisible to the resolver', TG_TABLE_NAME, NEW."id", NEW."partyId";
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ProjectCompany_origin_sourced" ON "ProjectCompany";
CREATE CONSTRAINT TRIGGER "ProjectCompany_origin_sourced"
  AFTER INSERT OR UPDATE ON "ProjectCompany"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "phase6_origin_sourced"();

DROP TRIGGER IF EXISTS "ProjectVendor_origin_sourced" ON "ProjectVendor";
CREATE CONSTRAINT TRIGGER "ProjectVendor_origin_sourced"
  AFTER INSERT OR UPDATE ON "ProjectVendor"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "phase6_origin_sourced"();

-- ── closing diagnostic: the backfill left nothing unjustified ────────────────────────────────
DO $$
DECLARE bad BIGINT;
BEGIN
  SELECT count(*) INTO bad FROM "ProjectParty" pp
   WHERE NOT EXISTS (SELECT 1 FROM "ProjectPartyCompanySource" s
                      WHERE s."projectId" = pp."projectId" AND s."partyId" = pp."partyId")
     AND NOT EXISTS (SELECT 1 FROM "ProjectPartyVendorSource" s
                      WHERE s."projectId" = pp."projectId" AND s."partyId" = pp."partyId");
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase6-t1a: backfill produced % ProjectParty row(s) with no source. This is a migration defect, not a data problem — do not repair by hand.', bad;
  END IF;
END $$;
