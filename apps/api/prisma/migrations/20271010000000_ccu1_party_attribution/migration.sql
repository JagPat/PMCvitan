-- Contractor-capture UNIT 1 (docs/ux/CONTRACTOR_CAPTURE_PROPOSAL.md §4 item 1) — the
-- ATTRIBUTION SHAPE: additive migration ALONE, no service change, writing NO rows.
--
-- The shape binds the WORKER/CREW side to the orgs-owned canonical party directory:
--   · `Worker.partyId` — the AUTHORITATIVE binding (the worker's party is the one ownership
--     authority; §4). NULL = in-house/unbound.
--   · `Crew.partyId` — a DERIVED convenience the deferred null-strict equality seal keeps
--     consistent with every ACTIVE member's and the in-charge's worker binding.
--   · `Membership.partyId` — which external party a project member acts FOR (how a contractor
--     token maps to a party; unit 4 derives ownership from it).
--   · `LabourAttendance.workerPartyId` / `LabourWorkFact.workerPartyId` — the party bound AT THE
--     MOMENT OF INSERT, derived by the DATABASE for every writer (old release included), NULL
--     while unbound: pre-attribution history, attributed to no party, never rewritten.
--   · `CapacityCommitment.supplierPartyId` — the commitment's supplier party, denormalized onto
--     the labour-owned commercial chain (population STAGED: unit 2 dual-writes + backfills;
--     enforcement enables only after that — criterion 14's single verified opening below).
--   · `ProjectPartyLabourSource` — the NEW orgs-owned labour justification source (§2), matching
--     the existing company/vendor source pattern. The ORIGIN here is a nullable COLUMN on three
--     tables rather than a row, so no source→origin FK is representable; criterion 13's two
--     directions are the same deferred-constraint-trigger shape the deployed
--     `phase6_project_party_sourced` pattern already uses.
--   · `WorkerPartyReliance` (labour-owned) / `MembershipPartyReliance` (orgs-owned) — the
--     RELIANCE REGISTERS for the binding freeze: a freeze trigger never reads a foreign module's
--     tables (AGENTS.md binds triggers too) — labour's worker/crew guards check labour-owned
--     evidence directly plus labour's own register; the orgs Membership guard reads ONLY the
--     orgs register. Registered by later units through the binding owner's participant, in the
--     same transaction as the evidence row.
--
-- Six DB seals belong to THIS migration or the shape is not what it claims, because during the
-- mixed-version window the OLD release and any alternate writer keep writing these tables:
--   S1  the ENUMERATED attendance append-only comparison extends over `workerPartyId` (only
--       LabourAttendance enumerates; `LabourWorkFact_append_only` and
--       `ActivityWorkOutput_append_only` call the generic full-row `phase3_immutable_row()`,
--       which already covers added columns and is RETAINED unchanged, never replaced).
--   S2  the DB is the ONLY writer of the evidence snapshot (BEFORE INSERT derivation; a
--       writer-supplied value is overwritten).
--   S3  the derivation reads the Worker binding row FOR SHARE, which conflicts with the
--       row-level lock any rebind UPDATE must take — the guard-vs-first-fact race is closed for
--       every writer, not only the new services.
--   S4  crew-party equality as DEFERRABLE INITIALLY DEFERRED constraint triggers firing from
--       BOTH ends (membership, in-charge, AND worker/crew party-binding updates), null-strict,
--       scoped to ACTIVE roster edges (criterion 5) — deferred because an immediate check makes
--       unit 2's atomic whole-roster bind impossible. Deferral is the COMMIT BACKSTOP, never the
--       serialization: the writer-side stable worker-lock order is unit 2's obligation, proven
--       by unit 2's own barrier probes in both orderings (criteria 1 and 9).
--   S5  the evidence-dependent binding FREEZE as BEFORE UPDATE triggers checking MODULE-LOCAL
--       state only, with an ACTIVE allocation itself counted as binding reliance (criterion 2).
--   S6  the binding lifecycle is DB-verifiable beyond the evidence condition (criterion 7): the
--       permitted-transition rule — NULL→party and party→NULL only; a direct party→party rewrite
--       is unrepresentable in one statement, so every transition is one of the CAS lifecycle's
--       own steps even for an alternate writer in the pre-first-fact window.
-- Plus: `phase6_project_party_sourced()` extended over the labour source + the corresponding
-- constraint trigger on the new table (criterion 11), and `phase4_lp_commitment_lifecycle_only`
-- extended over `supplierPartyId` with exactly one NULL→value opening (criteria 8 + 14).
--
-- ADDITIVE and DIAGNOSTIC-FIRST: every earlier migration is byte-for-byte unchanged; the closing
-- block ABORTS if any new table holds a row or any new column a value (this migration invents no
-- attribution — a legacy database upgrades row-free). Nothing here can be violated by pre-existing
-- data because every object is new.

-- ── tables ────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE "ProjectPartyLabourSource" (
  "id"        TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "partyId"   TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProjectPartyLabourSource_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectPartyLabourSource_projectId_partyId_key"
  ON "ProjectPartyLabourSource"("projectId", "partyId");
CREATE INDEX "ProjectPartyLabourSource_orgId_partyId_idx"
  ON "ProjectPartyLabourSource"("orgId", "partyId");
-- Restrict, matching the company/vendor sources: a direct delete of the association must not
-- take its own justification with it.
ALTER TABLE "ProjectPartyLabourSource" ADD CONSTRAINT "ProjectPartyLabourSource_projectId_partyId_fkey"
  FOREIGN KEY ("projectId", "partyId") REFERENCES "ProjectParty"("projectId", "partyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "WorkerPartyReliance" (
  "id"        TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "workerId"  TEXT NOT NULL,
  "partyId"   TEXT NOT NULL,
  "source"    TEXT NOT NULL,
  "refId"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkerPartyReliance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkerPartyReliance_projectId_workerId_partyId_idx"
  ON "WorkerPartyReliance"("projectId", "workerId", "partyId");
ALTER TABLE "WorkerPartyReliance" ADD CONSTRAINT "WorkerPartyReliance_projectId_workerId_fkey"
  FOREIGN KEY ("projectId", "workerId") REFERENCES "Worker"("projectId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE TABLE "MembershipPartyReliance" (
  "id"           TEXT NOT NULL,
  "projectId"    TEXT NOT NULL,
  "membershipId" TEXT NOT NULL,
  "partyId"      TEXT NOT NULL,
  "source"       TEXT NOT NULL,
  "refId"        TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MembershipPartyReliance_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MembershipPartyReliance_projectId_membershipId_partyId_idx"
  ON "MembershipPartyReliance"("projectId", "membershipId", "partyId");
ALTER TABLE "MembershipPartyReliance" ADD CONSTRAINT "MembershipPartyReliance_projectId_membershipId_fkey"
  FOREIGN KEY ("projectId", "membershipId") REFERENCES "Membership"("projectId", "id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ── columns (nullable, additive — the old release serves against them untouched) ─────────────
ALTER TABLE "Worker"             ADD COLUMN "partyId"         TEXT;
ALTER TABLE "Crew"               ADD COLUMN "partyId"         TEXT;
ALTER TABLE "Membership"         ADD COLUMN "partyId"         TEXT;
ALTER TABLE "LabourAttendance"   ADD COLUMN "workerPartyId"   TEXT;
ALTER TABLE "LabourWorkFact"     ADD COLUMN "workerPartyId"   TEXT;
ALTER TABLE "CapacityCommitment" ADD COLUMN "supplierPartyId" TEXT;

-- ── S2 + S3: the DB is the ONLY snapshot writer, serialized against rebind ────────────────────
-- BEFORE INSERT, for EVERY writer: the snapshot is DERIVED from the worker's binding at the
-- moment of insert (a writer-supplied value is overwritten — writers never supply it), and the
-- binding row is read FOR SHARE, which conflicts with the row-level lock any rebind UPDATE must
-- take. So even an OLD-release insert either completes before a rebind (whose reliant-evidence
-- guard then sees the new row and refuses) or blocks until the rebind commits and derives the
-- NEW party. NULL while unbound is the truth of that moment — pre-attribution history.
CREATE OR REPLACE FUNCTION phase4_u1_attendance_party_snapshot() RETURNS trigger AS $$
DECLARE p TEXT;
BEGIN
  SELECT "partyId" INTO p FROM "Worker"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."workerId"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LabourAttendance % references a Worker absent from its project', NEW."id";
  END IF;
  NEW."workerPartyId" := p;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LabourAttendance_party_snapshot" BEFORE INSERT ON "LabourAttendance"
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_attendance_party_snapshot();

CREATE OR REPLACE FUNCTION phase4_u1_workfact_party_snapshot() RETURNS trigger AS $$
DECLARE p TEXT;
BEGIN
  SELECT "partyId" INTO p FROM "Worker"
   WHERE "projectId" = NEW."projectId" AND "id" = NEW."workerId"
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'LabourWorkFact % references a Worker absent from its project', NEW."id";
  END IF;
  NEW."workerPartyId" := p;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "LabourWorkFact_party_snapshot" BEFORE INSERT ON "LabourWorkFact"
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_workfact_party_snapshot();

-- ── S1: the ENUMERATED attendance append-only comparison extends over the snapshot ────────────
-- Only LabourAttendance freezes evidence by enumerated, revocation-aware column comparison — a
-- party snapshot left out of THAT enumeration is silently mutable, so this migration adds it.
-- (`LabourWorkFact_append_only` / `ActivityWorkOutput_append_only` call the generic full-row
-- `phase3_immutable_row()`, which rejects EVERY update and delete — retained unchanged.)
-- `CREATE OR REPLACE` preserves the function's identity, so the existing
-- `LabourAttendance_append_only` trigger keeps enforcing with the new body; the t3c seal
-- registry gains this migration as a new canonical layer (`generate-t3c-fn-bodies.mjs`).
-- Body lines at column 0 so `pg_proc.prosrc` matches the generated canonical text byte-for-byte.
CREATE OR REPLACE FUNCTION phase4_t3_attendance_append_only() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LabourAttendance rows are never deleted (revoke the attendance instead, %)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."workerId" <> OLD."workerId"
     OR NEW."civilDate" <> OLD."civilDate" OR NEW."shift" <> OLD."shift"
     OR NEW."deviceId" IS DISTINCT FROM OLD."deviceId"
     OR NEW."manualReason" IS DISTINCT FROM OLD."manualReason"
     OR NEW."evidenceMediaId" IS DISTINCT FROM OLD."evidenceMediaId"
     OR NEW."workerPartyId" IS DISTINCT FROM OLD."workerPartyId"
     OR NEW."recordedAt" <> OLD."recordedAt" OR NEW."recordedById" <> OLD."recordedById"
     OR NEW."sourceCommandId" <> OLD."sourceCommandId" THEN
    RAISE EXCEPTION 'LabourAttendance is an APPEND-ONLY observation — only the revocation stamp may change (%)', OLD."id";
  END IF;
  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'a revoked LabourAttendance is terminal (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

-- ── S5 + S6: the binding guards — one-way lifecycle + evidence-dependent freeze ───────────────
-- BEFORE UPDATE, so an alternate writer updating the binding column directly cannot bypass the
-- CAS rebind lifecycle. The lifecycle is DB-verifiable (criterion 7): NULL→party and party→NULL
-- are the only representable transitions, so every change is one of the CAS steps. The freeze
-- checks MODULE-LOCAL state only: the labour-owned worker/crew guards read labour-owned evidence
-- and labour's own reliance register; the orgs-owned Membership guard reads ONLY the orgs
-- register. An ACTIVE allocation is itself binding reliance (criterion 2) — a rebind of a worker
-- with an active allocation is refused; the allocation is released/reassigned in the same
-- lifecycle by the unit-2 command, never stranded.
CREATE OR REPLACE FUNCTION phase4_u1_worker_binding_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
    IF OLD."partyId" IS NOT NULL AND NEW."partyId" IS NOT NULL THEN
      RAISE EXCEPTION 'ccu1: worker % party binding is one-way — release (party->NULL) then bind (NULL->party); a direct rebind is unrepresentable', OLD."id";
    END IF;
    IF OLD."partyId" IS NOT NULL AND (
         EXISTS (SELECT 1 FROM "LabourAttendance" a
                  WHERE a."projectId" = OLD."projectId" AND a."workerId" = OLD."id"
                    AND a."workerPartyId" = OLD."partyId")
      OR EXISTS (SELECT 1 FROM "LabourWorkFact" f
                  WHERE f."projectId" = OLD."projectId" AND f."workerId" = OLD."id"
                    AND f."workerPartyId" = OLD."partyId")
      OR EXISTS (SELECT 1 FROM "WorkerAllocation" al
                  WHERE al."projectId" = OLD."projectId" AND al."workerId" = OLD."id"
                    AND al."status" = 'active')
      OR EXISTS (SELECT 1 FROM "WorkerPartyReliance" r
                  WHERE r."projectId" = OLD."projectId" AND r."workerId" = OLD."id"
                    AND r."partyId" = OLD."partyId")
    ) THEN
      RAISE EXCEPTION 'ccu1: worker % binding to party % is FROZEN — party-stamped evidence, an active allocation, or a registered reliance depends on it', OLD."id", OLD."partyId";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Worker_party_binding_guard" BEFORE UPDATE ON "Worker"
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_worker_binding_guard();

CREATE OR REPLACE FUNCTION phase4_u1_crew_binding_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
    IF OLD."partyId" IS NOT NULL AND NEW."partyId" IS NOT NULL THEN
      RAISE EXCEPTION 'ccu1: crew % party binding is one-way — release (party->NULL) then bind (NULL->party); a direct rebind is unrepresentable', OLD."id";
    END IF;
    -- evidence recorded under THIS binding: party-stamped facts of workers holding an ACTIVE
    -- membership edge in this crew (criterion 5 scoping), or a registered reliance on one.
    IF OLD."partyId" IS NOT NULL AND (
         EXISTS (SELECT 1 FROM "LabourAttendance" a
                   JOIN "CrewMembership" m ON m."projectId" = a."projectId"
                    AND m."workerId" = a."workerId" AND m."crewId" = OLD."id" AND m."removedAt" IS NULL
                  WHERE a."projectId" = OLD."projectId" AND a."workerPartyId" = OLD."partyId")
      OR EXISTS (SELECT 1 FROM "LabourWorkFact" f
                   JOIN "CrewMembership" m ON m."projectId" = f."projectId"
                    AND m."workerId" = f."workerId" AND m."crewId" = OLD."id" AND m."removedAt" IS NULL
                  WHERE f."projectId" = OLD."projectId" AND f."workerPartyId" = OLD."partyId")
      OR EXISTS (SELECT 1 FROM "WorkerPartyReliance" r
                   JOIN "CrewMembership" m ON m."projectId" = r."projectId"
                    AND m."workerId" = r."workerId" AND m."crewId" = OLD."id" AND m."removedAt" IS NULL
                  WHERE r."projectId" = OLD."projectId" AND r."partyId" = OLD."partyId")
    ) THEN
      RAISE EXCEPTION 'ccu1: crew % binding to party % is FROZEN — party-stamped evidence of its active members depends on it', OLD."id", OLD."partyId";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Crew_party_binding_guard" BEFORE UPDATE ON "Crew"
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_crew_binding_guard();

CREATE OR REPLACE FUNCTION phase4_u1_membership_binding_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."partyId" IS DISTINCT FROM OLD."partyId" THEN
    IF OLD."partyId" IS NOT NULL AND NEW."partyId" IS NOT NULL THEN
      RAISE EXCEPTION 'ccu1: membership % party binding is one-way — release (party->NULL) then bind (NULL->party); a direct rebind is unrepresentable', OLD."id";
    END IF;
    IF OLD."partyId" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "MembershipPartyReliance" r
       WHERE r."projectId" = OLD."projectId" AND r."membershipId" = OLD."id"
         AND r."partyId" = OLD."partyId"
    ) THEN
      RAISE EXCEPTION 'ccu1: membership % binding to party % is FROZEN — registered reliance depends on it', OLD."id", OLD."partyId";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Membership_party_binding_guard" BEFORE UPDATE ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_membership_binding_guard();

-- ── S4: crew-party equality — a DB seal firing from BOTH ends, deferred, null-strict ──────────
-- The same-project composite FKs on CrewMembership and Crew.inchargeWorkerId prove only shared
-- projectId, so an old instance or direct SQL could join a party-A worker to a party-B crew.
-- DEFERRABLE INITIALLY DEFERRED so unit 2's whole-roster bind is possible at all (the all-null
-- roster moves to one party atomically inside one transaction); the deferred check is the COMMIT
-- BACKSTOP — writer-side serialization (the §C stable ascending worker-lock order, crew root
-- first per criterion 1) is unit 2's obligation, proven by its barrier probes. Null-strict:
-- NULL equals only NULL. Scoped to ACTIVE roster edges — membership `removedAt IS NULL`; the
-- in-charge edge of a non-revoked crew (criterion 5: historical memberships must not block
-- legitimate binds or rebinds). Re-derived from LIVE rows at commit, so a row rewritten later in
-- the same transaction is judged by its final state.
CREATE OR REPLACE FUNCTION phase4_u1_party_equality() RETURNS trigger AS $$
DECLARE c RECORD; w_party TEXT;
BEGIN
  IF TG_TABLE_NAME = 'CrewMembership' THEN
    IF EXISTS (
      SELECT 1 FROM "CrewMembership" m
        JOIN "Worker" w ON w."projectId" = m."projectId" AND w."id" = m."workerId"
        JOIN "Crew"   k ON k."projectId" = m."projectId" AND k."id" = m."crewId"
       WHERE m."id" = NEW."id" AND m."removedAt" IS NULL
         AND w."partyId" IS DISTINCT FROM k."partyId"
    ) THEN
      RAISE EXCEPTION 'ccu1: active crew membership % joins a worker and a crew bound to different parties (null-strict) — the roster moves as one party or not at all', NEW."id";
    END IF;
  ELSIF TG_TABLE_NAME = 'Crew' THEN
    SELECT "partyId", "inchargeWorkerId", "revokedAt" INTO c
      FROM "Crew" WHERE "projectId" = NEW."projectId" AND "id" = NEW."id";
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF c."revokedAt" IS NULL AND c."inchargeWorkerId" IS NOT NULL THEN
      SELECT "partyId" INTO w_party FROM "Worker"
       WHERE "projectId" = NEW."projectId" AND "id" = c."inchargeWorkerId";
      IF w_party IS DISTINCT FROM c."partyId" THEN
        RAISE EXCEPTION 'ccu1: crew % and its in-charge worker % are bound to different parties (null-strict)', NEW."id", c."inchargeWorkerId";
      END IF;
    END IF;
    IF EXISTS (
      SELECT 1 FROM "CrewMembership" m
        JOIN "Worker" w ON w."projectId" = m."projectId" AND w."id" = m."workerId"
       WHERE m."projectId" = NEW."projectId" AND m."crewId" = NEW."id" AND m."removedAt" IS NULL
         AND w."partyId" IS DISTINCT FROM c."partyId"
    ) THEN
      RAISE EXCEPTION 'ccu1: crew % is bound to a party its active members are not (null-strict)', NEW."id";
    END IF;
  ELSE -- Worker: every ACTIVE membership edge and every non-revoked crew it leads
    SELECT "partyId" INTO w_party FROM "Worker"
     WHERE "projectId" = NEW."projectId" AND "id" = NEW."id";
    IF EXISTS (
      SELECT 1 FROM "CrewMembership" m
        JOIN "Crew" k ON k."projectId" = m."projectId" AND k."id" = m."crewId"
       WHERE m."projectId" = NEW."projectId" AND m."workerId" = NEW."id" AND m."removedAt" IS NULL
         AND k."partyId" IS DISTINCT FROM w_party
    ) OR EXISTS (
      SELECT 1 FROM "Crew" k
       WHERE k."projectId" = NEW."projectId" AND k."inchargeWorkerId" = NEW."id"
         AND k."revokedAt" IS NULL AND k."partyId" IS DISTINCT FROM w_party
    ) THEN
      RAISE EXCEPTION 'ccu1: worker % and a crew it actively belongs to (or leads) are bound to different parties (null-strict)', NEW."id";
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "CrewMembership_party_equality"
  AFTER INSERT OR UPDATE ON "CrewMembership"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_party_equality();
CREATE CONSTRAINT TRIGGER "Crew_party_equality"
  AFTER INSERT OR UPDATE ON "Crew"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_party_equality();
CREATE CONSTRAINT TRIGGER "Worker_party_equality"
  AFTER UPDATE ON "Worker"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_party_equality();

-- ── criterion 13: each binding owes its labour-source row at commit, both directions ──────────
-- The existing source pattern's inverse/origin seal, mirrored with the same lock-then-count
-- discipline as the deployed `phase6_project_party_sourced`: the source row is locked FOR UPDATE
-- before counting, so of two racing transactions (one deleting the source, one binding a
-- worker/crew/membership to its party) exactly one commits. The origin here is a nullable
-- COLUMN on three tables, so no FK can carry it; the deferred trigger fires from BOTH ends —
-- every binding write, and every source delete/update. (The Worker/Crew end reads the orgs-owned
-- source table and the source end reads the labour-owned binding columns — the same declared
-- cross-table trigger shape as the deployed `phase4_t3_attendance_device_bound`, which reads the
-- orgs-owned WorkerDevice from a labour trigger; the alternative, an FK, cannot express a
-- column-valued origin.)
CREATE OR REPLACE FUNCTION phase4_u1_labour_source_covered() RETURNS trigger AS $$
DECLARE target_project TEXT; target_party TEXT; bindings BIGINT; src BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_project := OLD."projectId"; target_party := OLD."partyId";
  ELSE
    target_project := NEW."projectId"; target_party := NEW."partyId";
  END IF;
  IF target_party IS NULL THEN RETURN NULL; END IF;

  SELECT count(*) INTO src FROM (
    SELECT 1 FROM "ProjectPartyLabourSource"
     WHERE "projectId" = target_project AND "partyId" = target_party
     FOR UPDATE) locked;

  SELECT (SELECT count(*) FROM "Worker"
           WHERE "projectId" = target_project AND "partyId" = target_party)
       + (SELECT count(*) FROM "Crew"
           WHERE "projectId" = target_project AND "partyId" = target_party)
       + (SELECT count(*) FROM "Membership"
           WHERE "projectId" = target_project AND "partyId" = target_party)
    INTO bindings;

  IF bindings > 0 AND src = 0 THEN
    RAISE EXCEPTION 'ccu1: % binding(s) name party % on project % with no ProjectPartyLabourSource justifying them — each binding owes its labour-source row at commit, and removing that source is refused while a binding remains', bindings, target_party, target_project;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER "Worker_labour_source_covered"
  AFTER INSERT OR UPDATE ON "Worker"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_labour_source_covered();
CREATE CONSTRAINT TRIGGER "Crew_labour_source_covered"
  AFTER INSERT OR UPDATE ON "Crew"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_labour_source_covered();
CREATE CONSTRAINT TRIGGER "Membership_labour_source_covered"
  AFTER INSERT OR UPDATE ON "Membership"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_labour_source_covered();
CREATE CONSTRAINT TRIGGER "ProjectPartyLabourSource_binding_covered"
  AFTER DELETE OR UPDATE ON "ProjectPartyLabourSource"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase4_u1_labour_source_covered();

-- ── criterion 11: the structural source seal covers the labour source ─────────────────────────
-- The deployed `phase6_project_party_sourced()` (20270801000000) counts only the company and
-- vendor sources, so removing the last company source while a labour source remained would abort
-- at the trigger even after the SERVICE count is extended (unit 2's change). The same migration
-- that adds the labour-source table extends the function and installs the corresponding
-- constraint trigger on the new table. The body below is the deployed text with exactly the
-- labour-source count added; `CREATE OR REPLACE` preserves the function identity every existing
-- association trigger is bound to.
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
       + (SELECT count(*) FROM "ProjectPartyLabourSource"
           WHERE "projectId" = target_project AND "partyId" = target_party)
    INTO sources;

  IF sources = 0 THEN
    RAISE EXCEPTION 'phase6: ProjectParty(project %, party %) has no source justifying it — an association exists only while a ProjectCompany, ProjectVendor or labour binding supports it', target_project, target_party;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ProjectPartyLabourSource_association_sourced" ON "ProjectPartyLabourSource";
CREATE CONSTRAINT TRIGGER "ProjectPartyLabourSource_association_sourced"
  AFTER DELETE OR UPDATE ON "ProjectPartyLabourSource"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "phase6_project_party_sourced"();

-- ── criteria 8 + 14: the denormalized supplier party joins the frozen enumeration ─────────────
-- In the SAME migration that adds the column: `supplierPartyId` must not be freely updateable.
-- The freeze admits exactly ONE DB-verified NULL→value transition (the staged unit-2
-- dual-write/backfill — a null-safe freeze would reject every backfill, while an ordinary `<>`
-- comparison would let arbitrary null transitions bypass it); a set value never changes and
-- never returns to NULL. The body below is the deployed 20270201000000 text with exactly that
-- rule added; the existing `CapacityCommitment_lifecycle_only` trigger keeps enforcing it.
CREATE OR REPLACE FUNCTION phase4_lp_commitment_lifecycle_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CapacityCommitment rows are never deleted (%)', OLD."id";
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."projectId" <> OLD."projectId" OR NEW."poLineId" <> OLD."poLineId"
     OR NEW."labourSpecFingerprint" <> OLD."labourSpecFingerprint" OR NEW."civilDate" <> OLD."civilDate"
     OR NEW."shift" <> OLD."shift" OR NEW."personShiftQty" <> OLD."personShiftQty"
     OR NEW."createdAt" <> OLD."createdAt" OR NEW."createdById" <> OLD."createdById" THEN
    RAISE EXCEPTION 'CapacityCommitment identity/slice is frozen — only lifecycle columns may change (%)', OLD."id";
  END IF;
  IF OLD."supplierPartyId" IS NOT NULL AND NEW."supplierPartyId" IS DISTINCT FROM OLD."supplierPartyId" THEN
    RAISE EXCEPTION 'CapacityCommitment supplier party is one-way — set once (NULL->party, the staged population) and never changed (%)', OLD."id";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── closing diagnostic: this migration writes NO rows and invents NO attribution ──────────────
DO $$
DECLARE bad BIGINT;
BEGIN
  SELECT (SELECT count(*) FROM "ProjectPartyLabourSource")
       + (SELECT count(*) FROM "WorkerPartyReliance")
       + (SELECT count(*) FROM "MembershipPartyReliance") INTO bad;
  IF bad > 0 THEN
    RAISE EXCEPTION 'ccu1 ABORT: the unit-1 tables must be row-free at migration time (found % rows) — this migration writes no rows; see the contractor-capture proposal §4 item 1', bad;
  END IF;
  SELECT (SELECT count(*) FROM "Worker" WHERE "partyId" IS NOT NULL)
       + (SELECT count(*) FROM "Crew" WHERE "partyId" IS NOT NULL)
       + (SELECT count(*) FROM "Membership" WHERE "partyId" IS NOT NULL)
       + (SELECT count(*) FROM "LabourAttendance" WHERE "workerPartyId" IS NOT NULL)
       + (SELECT count(*) FROM "LabourWorkFact" WHERE "workerPartyId" IS NOT NULL)
       + (SELECT count(*) FROM "CapacityCommitment" WHERE "supplierPartyId" IS NOT NULL) INTO bad;
  IF bad > 0 THEN
    RAISE EXCEPTION 'ccu1 ABORT: the unit-1 attribution columns must be entirely NULL at migration time (found % values) — attribution is never invented; the unit-2 backfill is the only population path', bad;
  END IF;
END $$;
