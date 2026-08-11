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
END $$;

-- ── the canonical party ──────────────────────────────────────────────────────────────────────
CREATE TABLE "ExternalParty" (
  "id"            TEXT NOT NULL,
  "orgId"         TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL only for rows this backfill created: `ProjectCompany` has no creator column, so a
  -- party derived from one has no attributable author, and recording that is honest where
  -- inventing an actor would not be.
  "createdById"   TEXT,
  "promotedOrgId" TEXT,
  CONSTRAINT "ExternalParty_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExternalParty_orgId_id_key" ON "ExternalParty"("orgId", "id");
CREATE INDEX "ExternalParty_orgId_idx" ON "ExternalParty"("orgId");
ALTER TABLE "ExternalParty" ADD CONSTRAINT "ExternalParty_orgId_fkey"
  FOREIGN KEY ("orgId") REFERENCES "Org"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalParty" ADD CONSTRAINT "ExternalParty_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

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
CREATE UNIQUE INDEX "ExternalParty_orgId_promotedOrgId_key"
  ON "ExternalParty"("orgId", "promotedOrgId") WHERE "promotedOrgId" IS NOT NULL;

CREATE OR REPLACE FUNCTION "phase6_party_promotion_one_way"() RETURNS trigger AS $$
BEGIN
  IF OLD."promotedOrgId" IS NOT NULL AND NEW."promotedOrgId" IS DISTINCT FROM OLD."promotedOrgId" THEN
    RAISE EXCEPTION 'phase6: ExternalParty.promotedOrgId is one-way — % is already promoted to org %, and a promotion cannot be moved or cleared', OLD."id", OLD."promotedOrgId";
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER "ExternalParty_promotion_one_way"
  BEFORE UPDATE ON "ExternalParty"
  FOR EACH ROW EXECUTE FUNCTION "phase6_party_promotion_one_way"();

-- ── the party columns on the three existing tables (nullable until backfilled) ───────────────
ALTER TABLE "Vendor"         ADD COLUMN "partyId" TEXT;
ALTER TABLE "ProjectCompany" ADD COLUMN "orgId"   TEXT;
ALTER TABLE "ProjectCompany" ADD COLUMN "partyId" TEXT;
ALTER TABLE "ProjectVendor"  ADD COLUMN "partyId" TEXT;

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
CREATE UNIQUE INDEX "Vendor_orgId_id_partyId_key" ON "Vendor"("orgId", "id", "partyId");
CREATE INDEX "Vendor_orgId_partyId_idx" ON "Vendor"("orgId", "partyId");
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_orgId_partyId_fkey"
  FOREIGN KEY ("orgId", "partyId") REFERENCES "ExternalParty"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- The org copy is bound to the project itself. Without this a row could keep `projectId` on an
-- org-A project, set its copied `orgId` to org B and point at an org-B party, and both the
-- project FK and the party FK would pass.
ALTER TABLE "ProjectCompany" ADD CONSTRAINT "ProjectCompany_orgId_projectId_fkey"
  FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ProjectCompany" ADD CONSTRAINT "ProjectCompany_orgId_partyId_fkey"
  FOREIGN KEY ("orgId", "partyId") REFERENCES "ExternalParty"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "ProjectCompany_orgId_partyId_idx" ON "ProjectCompany"("orgId", "partyId");
CREATE UNIQUE INDEX "ProjectCompany_orgId_projectId_partyId_id_key"
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
CREATE UNIQUE INDEX "ProjectCompany_projectId_partyId_key" ON "ProjectCompany"("projectId", "partyId");

-- The binding's party copy is bound THROUGH the vendor's party, not to `ExternalParty`
-- directly: otherwise a same-org row could bind project A to vendor V1 while naming party P2.
ALTER TABLE "ProjectVendor" ADD CONSTRAINT "ProjectVendor_orgId_vendorId_partyId_fkey"
  FOREIGN KEY ("orgId", "vendorId", "partyId") REFERENCES "Vendor"("orgId", "id", "partyId") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ProjectVendor" ADD CONSTRAINT "ProjectVendor_orgId_partyId_fkey"
  FOREIGN KEY ("orgId", "partyId") REFERENCES "ExternalParty"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
CREATE INDEX "ProjectVendor_orgId_partyId_idx" ON "ProjectVendor"("orgId", "partyId");
CREATE UNIQUE INDEX "ProjectVendor_orgId_projectId_partyId_id_key"
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
CREATE UNIQUE INDEX "ProjectVendor_projectId_partyId_key" ON "ProjectVendor"("projectId", "partyId");

-- ── the canonical association ────────────────────────────────────────────────────────────────
-- The ONLY table the collaborator resolver reads, so it carries the org seal on BOTH sides: a
-- row pairing an org-A project with an org-B party would associate them no matter how well
-- every other table is sealed.
CREATE TABLE "ProjectParty" (
  "id"        TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "partyId"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectParty_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectParty_projectId_partyId_key" ON "ProjectParty"("projectId", "partyId");
CREATE INDEX "ProjectParty_orgId_partyId_idx" ON "ProjectParty"("orgId", "partyId");
ALTER TABLE "ProjectParty" ADD CONSTRAINT "ProjectParty_orgId_projectId_fkey"
  FOREIGN KEY ("orgId", "projectId") REFERENCES "Project"("orgId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
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
CREATE TABLE "ProjectPartyCompanySource" (
  "id"               TEXT NOT NULL,
  "orgId"            TEXT NOT NULL,
  "projectId"        TEXT NOT NULL,
  "partyId"          TEXT NOT NULL,
  "projectCompanyId" TEXT NOT NULL,
  CONSTRAINT "ProjectPartyCompanySource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectPartyCompanySource_projectCompanyId_key" ON "ProjectPartyCompanySource"("projectCompanyId");
CREATE INDEX "ProjectPartyCompanySource_projectId_partyId_idx" ON "ProjectPartyCompanySource"("projectId", "partyId");
ALTER TABLE "ProjectPartyCompanySource" ADD CONSTRAINT "ProjectPartyCompanySource_association_fkey"
  FOREIGN KEY ("projectId", "partyId") REFERENCES "ProjectParty"("projectId", "partyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProjectPartyCompanySource" ADD CONSTRAINT "ProjectPartyCompanySource_origin_fkey"
  FOREIGN KEY ("orgId", "projectId", "partyId", "projectCompanyId")
  REFERENCES "ProjectCompany"("orgId", "projectId", "partyId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProjectPartyVendorSource" (
  "id"              TEXT NOT NULL,
  "orgId"           TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "partyId"         TEXT NOT NULL,
  "projectVendorId" TEXT NOT NULL,
  CONSTRAINT "ProjectPartyVendorSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectPartyVendorSource_projectVendorId_key" ON "ProjectPartyVendorSource"("projectVendorId");
CREATE INDEX "ProjectPartyVendorSource_projectId_partyId_idx" ON "ProjectPartyVendorSource"("projectId", "partyId");
ALTER TABLE "ProjectPartyVendorSource" ADD CONSTRAINT "ProjectPartyVendorSource_association_fkey"
  FOREIGN KEY ("projectId", "partyId") REFERENCES "ProjectParty"("projectId", "partyId") ON DELETE CASCADE ON UPDATE CASCADE;
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
  IF TG_OP = 'DELETE' THEN
    target_project := OLD."projectId"; target_party := OLD."partyId";
  ELSE
    target_project := NEW."projectId"; target_party := NEW."partyId";
  END IF;

  SELECT count(*) INTO assoc FROM "ProjectParty"
   WHERE "projectId" = target_project AND "partyId" = target_party;
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

CREATE CONSTRAINT TRIGGER "ProjectParty_sourced"
  AFTER INSERT OR UPDATE ON "ProjectParty"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "phase6_project_party_sourced"();

CREATE CONSTRAINT TRIGGER "ProjectPartyCompanySource_association_sourced"
  AFTER DELETE ON "ProjectPartyCompanySource"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "phase6_project_party_sourced"();

CREATE CONSTRAINT TRIGGER "ProjectPartyVendorSource_association_sourced"
  AFTER DELETE ON "ProjectPartyVendorSource"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "phase6_project_party_sourced"();

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
