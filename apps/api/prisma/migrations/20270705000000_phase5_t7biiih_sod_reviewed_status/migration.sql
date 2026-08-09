-- Phase 5 Task 7B-iii-h — §I: a grant records the claim STATE it was justified against.
--
-- WHY. `SodGrant` pins the claim VERSION, and one version walks the whole §E lifecycle
-- (`submitted → under-verification → verified`) without changing id. So an approver who
-- authorised a claim that had not yet been verified would have that authority survive into
-- `verified` and excuse the certification of a verdict they never reviewed. The version says
-- WHICH claim; it does not say WHAT WAS TRUE about it.
--
-- ADDITIVE and NULLABLE. A row written before this column existed has no recorded reviewed
-- state, and there is no honest way to infer one: back-filling the bill's CURRENT status would
-- fabricate evidence that an approver saw something they may never have seen, on the exact
-- register whose purpose is to carry attributable human authorisation. So legacy rows keep NULL
-- and `resolveGrant` treats a NULL as UNUSABLE — the safe direction, and the one that does not
-- put words in an approver's mouth.
--
-- `IF NOT EXISTS` because this file is RERUNNABLE BY DESIGN, not from caution. The closing `DO`
-- block below deliberately aborts the deploy on a legacy unconsumed grant — AFTER this statement has
-- already succeeded — and the remedy it instructs is "re-issue those authorisations, then redeploy".
-- Without this, that second run dies on duplicate-column and the instruction is unreachable: the
-- migration would have made itself unrepairable by the very diagnostic that exists to repair it.
ALTER TABLE "SodGrant" ADD COLUMN IF NOT EXISTS "reviewedStatus" TEXT;

-- ── …AND A STATUS IS A DESCRIPTION, NOT AN IDENTITY ──────────────────────────────────────────
--
-- Codex round 2 (P1), and it is the deeper half of the defect this whole unit exists for.
--
-- Recording the reviewed STATUS closed the case where a claim moves on. It does not close the case
-- where a claim moves on and COMES BACK: §F DERIVES the payment status from the folds, and the
-- derivation genuinely returns to a label it has left. Certify ₹100 with ₹10 withheld → `certified`;
-- approve and pay the ₹90 → `paid`; release ₹5 of the withholding → `certified` again. An
-- authorisation given at the first `certified`, when nothing was approved, matches the label at the
-- second — by which time ₹90 has been authorised and has left the practice.
--
-- The reviewed identity therefore needs a fact that only ever moves FORWARD. `lifecycleVersion` is
-- that fact: a per-claim counter, bumped whenever the status changes, never reused.
--
-- BUMPED BY A TRIGGER, not by the services. There are six separate writers of `VendorBill.status`
-- across four services, and "remember to also bump the counter" is exactly the instruction this
-- review lineage has now proved three times that nobody remembers. A trigger is the one site none
-- of them can opt out of, and a seventh writer added tomorrow inherits it without being told.
-- ON ITS OWN ROW, and that is the whole design rather than a detail.
--
-- The counter has to advance from every fold source, and a trigger that advances it by UPDATEing
-- `VendorBill` takes the CLAIM'S row lock — from a writer that may hold no other lock at all. Task
-- 5C's Codex round 6 removed a certificate-side bill lock for exactly this reason and left two
-- probes standing over it: the honest withholding path runs `bill → certificate`, so a
-- certificate-side write reaching for the bill is ABBA, and PostgreSQL answers an ABBA cycle by
-- aborting somebody with a deadlock rather than by the refusal the seal was written to give.
--
-- A counter on its own row is taken LAST by everybody — `bill → certificate → revision`,
-- `certificate → revision`, `deduction → revision` — so it introduces no cycle with anything.
CREATE TABLE IF NOT EXISTS "VendorBillRevision" (
  "projectId" TEXT NOT NULL,
  "billId"    TEXT NOT NULL,
  "revision"  INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "VendorBillRevision_pkey" PRIMARY KEY ("projectId", "billId"),
  CONSTRAINT "VendorBillRevision_bill_fkey" FOREIGN KEY ("projectId", "billId")
    REFERENCES "VendorBill"("projectId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION
);

-- ── …AND THE ROW EXISTS FROM THE CLAIM'S FIRST MOMENT ───────────────────────────────────────
--
-- Codex round 5, and it is the premise two of that round's findings rest on. The counter started
-- life as `COALESCE((SELECT revision …), 0)`: a claim that had never moved money had NO ROW, and
-- read zero by absence. An absence cannot be locked and cannot be constrained — `SELECT … FOR
-- UPDATE` over nothing locks nothing, and a CHECK cannot police a row that is not there.
--
-- So the row is opened WITH the claim. Every later reader locks a row that exists, and the implicit
-- zero — the thing a rewind could aim at — stops existing as a state the system can be in.
CREATE OR REPLACE FUNCTION phase5_t7biiih_open_bill_revision() RETURNS trigger AS $$
BEGIN
  INSERT INTO "VendorBillRevision"("projectId", "billId", "revision")
  VALUES (NEW."projectId", NEW."id", 0)
  ON CONFLICT ("projectId", "billId") DO NOTHING;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorBill_opens_revision" ON "VendorBill";
CREATE TRIGGER "VendorBill_opens_revision" AFTER INSERT ON "VendorBill"
  FOR EACH ROW EXECUTE FUNCTION phase5_t7biiih_open_bill_revision();

-- …and every claim that already exists gets its row now, at zero. Zero is what those claims already
-- read by absence, so this changes no authority's standing — it only makes the reading lockable.
INSERT INTO "VendorBillRevision"("projectId", "billId", "revision")
SELECT b."projectId", b."id", 0 FROM "VendorBill" b
ON CONFLICT ("projectId", "billId") DO NOTHING;

-- Never rewound, never jumped. Advancing is always safe — it can only INVALIDATE an authority,
-- never revive one — so the guard is only about the directions that could revive a stale pin.
CREATE OR REPLACE FUNCTION phase5_t7biiih_revision_forward_only() RETURNS trigger AS $$
BEGIN
  -- INSERT (Codex round 5, P1). The trigger used to police only UPDATE and DELETE, which left the
  -- way a row is BORN completely open: a direct insert of `revision = -1` on a claim reading the
  -- implicit zero made every authority pinned at 0 stale, and the next fold write advanced it back
  -- to 0 and revived them — a rewind performed by creation rather than by change.
  --
  -- This is the same shape as the grant seal below, which guarded consumption and not issue, and
  -- both are one root: A GUARD ON THE TRANSITIONS OF A ROW IS NOT A GUARD ON THE ROW. A value that
  -- can be written wrong the first time does not become right because later edits are policed.
  --
  -- Only the direction that can REVIVE is refused. A row born high only invalidates authorities,
  -- which is the safe direction and the one an operator restoring a counter would need.
  IF TG_OP = 'INSERT' THEN
    IF NEW."revision" < 0 THEN
      RAISE EXCEPTION 'A claim revision starts at zero and only moves forward — % would place this claim behind authorisations already pinned to it (%)', NEW."revision", NEW."billId";
    END IF;
    RETURN NEW;
  END IF;
  -- DELETING it resets the claim to zero, which revives every authorisation ever pinned there. A
  -- counter that can be removed is not monotonic; it is monotonic until someone tires of it.
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A claim revision is never deleted — removing it would take the claim back to 0 and revive authorisations pinned there (%)', OLD."billId";
  END IF;
  -- …and it belongs to ONE claim. Codex round 4: checking only the counter let a direct update
  -- move B1's row onto another bill, leaving B1 reading 0 again — the same revival by a different
  -- route. The identity is as much a part of the fact as the number.
  IF NEW."projectId" IS DISTINCT FROM OLD."projectId" OR NEW."billId" IS DISTINCT FROM OLD."billId" THEN
    RAISE EXCEPTION 'A claim revision belongs to the claim it was opened for and cannot be moved (%)', OLD."billId";
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'The claim revision only ever moves forward, one step at a time (%)', OLD."billId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorBillRevision_forward_only" ON "VendorBillRevision";
CREATE TRIGGER "VendorBillRevision_forward_only"
  BEFORE INSERT OR UPDATE OR DELETE ON "VendorBillRevision"
  FOR EACH ROW EXECUTE FUNCTION phase5_t7biiih_revision_forward_only();

-- One place every mover goes through, so no writer can advance it halfway.
CREATE OR REPLACE FUNCTION phase5_t7biiih_touch_revision(p_project text, p_bill text) RETURNS void AS $$
  INSERT INTO "VendorBillRevision"("projectId", "billId", "revision") VALUES (p_project, p_bill, 1)
  ON CONFLICT ("projectId", "billId") DO UPDATE SET "revision" = "VendorBillRevision"."revision" + 1;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION phase5_t7biiih_bill_lifecycle_version() RETURNS trigger AS $$
BEGIN
  -- A §F status transition is a change a reviewer would have seen, so it advances the revision —
  -- AFTER the row is written, and against the revision row rather than this one, so the claim's
  -- own lock is never taken by anybody who was not already holding it.
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    PERFORM phase5_t7biiih_touch_revision(NEW."projectId", NEW."id");
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "VendorBill_lifecycle_version" ON "VendorBill";
CREATE TRIGGER "VendorBill_lifecycle_version" AFTER UPDATE ON "VendorBill"
  FOR EACH ROW EXECUTE FUNCTION phase5_t7biiih_bill_lifecycle_version();

-- The grant records it alongside the status. NULLABLE for the same reason `reviewedStatus` is:
-- a row written before this column existed attests to nothing, and inventing a version for it would
-- be inventing the very evidence the register exists to carry.
ALTER TABLE "SodGrant" ADD COLUMN IF NOT EXISTS "reviewedLifecycleVersion" INTEGER;

-- ── A LEGACY GRANT MUST BE ABLE TO REACH A TERMINAL STATE ────────────────────────────────────
--
-- Codex round 4 (P1), and it is in direct tension with round 3's finding — which is the useful
-- part. Round 3 said: install the guards BEFORE the abort, or the legacy path commits the evidence
-- columns unguarded. Round 4 observes that once they are installed a legacy NULL grant can be
-- neither filled (the freeze), nor consumed (the seal), nor deleted (append-only) — so the
-- diagnostic's own remedy, "re-issue and redeploy", never clears the count. Re-issuing writes a
-- SECOND row; the first still trips the abort, forever.
--
-- Both exits Codex names are real. The one that terminates is that **an abort was the wrong
-- instrument.** A legacy grant is a row this release can no longer judge, and the honest disposal
-- of a fact you cannot judge is to RETIRE it with a reason — retained, marked, attributable, and
-- named in the runbook — not to stop every deploy until someone does the impossible.
--
-- This is not the silent revocation the abort existed to prevent. Silent would be deleting it, or
-- inventing a reviewed state for it. A retirement says exactly what happened and why.
ALTER TABLE "SodGrant" ADD COLUMN IF NOT EXISTS "retiredAt" TIMESTAMP(3);
ALTER TABLE "SodGrant" ADD COLUMN IF NOT EXISTS "retiredReason" TEXT;

-- ── …AND THE MONEY IS NOT THE LABEL ──────────────────────────────────────────────────────────
--
-- Codex round 3 (P1), which is round 2's finding one level deeper. Round 2 said "a label recycles,
-- so pin a counter"; I then advanced that counter only when the LABEL changed.
--
-- §F's first two arms are `NET_PAYABLE = PAID` and `APPROVED = 0`, so a claim with nothing approved
-- reads `certified` at ANY payable. A retention release raises what is owed from ₹90 to ₹95 and the
-- label does not move at all — and the approver who authorised against ₹90 never saw the ₹95.
--
-- So the counter is the claim's COMMERCIAL REVISION: it advances whenever anything a reviewer would
-- have seen changes. §F reads three folds (NET_PAYABLE, APPROVED, PAID) and exactly six tables feed
-- them. Each gets the same trigger, so a seventh fold source added tomorrow is a visible omission in
-- one list rather than a silent hole in an authority check.
CREATE OR REPLACE FUNCTION phase5_t7biiih_touch_bill_lifecycle() RETURNS trigger AS $$
DECLARE
  v_row record;
  v_bill text;
  v_project text;
BEGIN
  v_row := COALESCE(NEW, OLD);
  v_project := v_row."projectId";

  -- each fold source reaches its claim; the ones that do not carry `billId` walk their own FKs
  IF TG_TABLE_NAME IN ('BillCertificate', 'PaymentApproval', 'Payment', 'PaymentReversal') THEN
    v_bill := v_row."billId";
  ELSIF TG_TABLE_NAME = 'BillDeduction' THEN
    SELECT c."billId" INTO v_bill FROM "BillCertificate" c
     WHERE c."projectId" = v_project AND c."id" = v_row."certificateId";
  ELSIF TG_TABLE_NAME = 'BillDeductionRelease' THEN
    SELECT c."billId" INTO v_bill FROM "BillDeduction" d
      JOIN "BillCertificate" c ON c."projectId" = d."projectId" AND c."id" = d."certificateId"
     WHERE d."projectId" = v_project AND d."id" = v_row."deductionId";
  END IF;

  IF v_bill IS NOT NULL THEN
    PERFORM phase5_t7biiih_touch_revision(v_project, v_bill);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['BillCertificate', 'BillDeduction', 'BillDeductionRelease',
                           'PaymentApproval', 'Payment', 'PaymentReversal'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touches_bill_lifecycle', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION phase5_t7biiih_touch_bill_lifecycle()',
      t || '_touches_bill_lifecycle', t);
  END LOOP;
END $$;

-- The ACT records the revision it was performed against, so the consume seal can compare two frozen
-- columns rather than guess at what the counter was before the act moved it (Codex round 3 P1). By
-- COMMIT the certificate insert and the status transition have both advanced it; what the authority
-- must match is what the act SAW, and that is a fact the act can carry.
ALTER TABLE "BillCertificate" ADD COLUMN IF NOT EXISTS "reviewedLifecycleVersion" INTEGER;
ALTER TABLE "PaymentApproval" ADD COLUMN IF NOT EXISTS "reviewedLifecycleVersion" INTEGER;

-- ── THE ACT'S RECORDED REVISION IS TRUE WHEN WRITTEN, AND FROZEN AFTER ───────────────────────
--
-- Codex round 4 (P1), and it is the objection that invalidates round 3's premise. Round 3 had the
-- consume seal compare the grant's revision to the ACT'S and called that "two frozen columns, no
-- inference". They are two SELF-AUTHORED columns: a bypass writer inserts the certificate with
-- whatever revision matches the stale grant it wants to spend, and the seal proves only that the
-- writer agrees with itself.
--
-- What makes the act's number TRUE is checking it against the claim's actual revision at the
-- moment of writing — BEFORE INSERT, so it runs ahead of this table's own AFTER trigger advancing
-- it, and by a plain read, so it takes no lock and adds no lock order.
--
-- And FROZEN afterwards, because an evidence column that a later UPDATE can rewrite is not
-- evidence. A SEPARATE trigger rather than a `CREATE OR REPLACE` of the two cleared append-only
-- functions, deliberately: replacing them would mean copying their cleared clauses forward, and a
-- seal that judges a copy as an original is the root this PR's audit already names four times.
-- Task 6A made the same choice for the same reason.
CREATE OR REPLACE FUNCTION phase5_t7biiih_act_reviewed_revision() RETURNS trigger AS $$
DECLARE v_now integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."reviewedLifecycleVersion" IS DISTINCT FROM OLD."reviewedLifecycleVersion" THEN
      RAISE EXCEPTION 'The claim revision an act was performed against is evidence and cannot be rewritten (%)', OLD."id";
    END IF;
    RETURN NEW;
  END IF;

  -- NULL is the legacy shape: rows written before this column existed carry nothing, and nothing
  -- is what they must keep. A grant can never be consumed by one, because the consume seal
  -- requires the two to be equal and refuses a NULL act.
  IF NEW."reviewedLifecycleVersion" IS NULL THEN RETURN NEW; END IF;

  -- FOR UPDATE, and that is the difference between a check and a guess (Codex round 5, P1).
  --
  -- A plain read is not authoritative about a counter another session is moving. A fold writer can
  -- hold this row at L2 uncommitted while this trigger still sees the committed L1, accept an act
  -- recorded at L1, and then queue its own touch behind the fold — leaving a certificate or an
  -- approval recorded against a passage of the claim that was already gone when it was written.
  --
  -- Taking the row lock makes the comparison and the advance one indivisible step: the second
  -- session blocks, re-reads L2, and is refused. The lock order is unchanged, and deliberately so —
  -- the revision row is taken LAST by everybody (`bill → certificate → revision`), so this
  -- acquisition closes no cycle with the claim lock the honest paths already hold.
  SELECT r."revision" INTO v_now FROM "VendorBillRevision" r
   WHERE r."projectId" = NEW."projectId" AND r."billId" = NEW."billId"
     FOR UPDATE;
  -- The row is opened with the claim and can never be deleted, so its absence is not a new claim —
  -- it is tampering, and reading a fallback zero here would be trusting the tamper.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim % carries no revision record, so there is nothing an act can honestly say it was performed against', NEW."billId";
  END IF;
  IF NEW."reviewedLifecycleVersion" <> v_now THEN
    RAISE EXCEPTION 'This act records revision % of the claim, which is at revision % — an act carries the passage of the claim it was actually performed on', NEW."reviewedLifecycleVersion", v_now;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['BillCertificate', 'PaymentApproval'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_reviewed_revision_true', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION phase5_t7biiih_act_reviewed_revision()',
      t || '_reviewed_revision_true', t);
  END LOOP;
END $$;



-- …and the live-scope index has to learn the new way a row becomes INERT.
--
-- The index's own history says why. Codex round 9 added `approverId` to this scope for exactly
-- this reason: an unconsumed grant whose approver later lost standing can never be spent, and
-- without the approver in the key no OTHER pmc could issue a replacement — "the stale row is inert
-- rather than dangerous; what the index must not do is let that inert row block a valid one."
--
-- `reviewedStatus` creates a second way to be inert. A grant authorised over a `submitted` claim
-- stops being spendable the moment the claim verifies, and without this column in the scope the
-- SAME approver could not re-authorise against the state that is now true — the remedy for a
-- stale review would be unreachable, which is worse than the hole it closes. A grant against a
-- different reviewed state is a different authorisation, so it is a different row.
--
-- `reviewedLifecycleVersion` joins it for the SAME reason, and here it is load-bearing rather than
-- symmetric: the whole point of the counter is the case where the status label RECYCLES. A
-- re-authorisation after `certified → paid → certified` carries the identical status, so with the
-- status alone in the scope the inert row and its legitimate replacement would collide — and the
-- deadlock this index exists to prevent would be created by the fix for the hole it closes.
DROP INDEX IF EXISTS "SodGrant_live_scope_key";
CREATE UNIQUE INDEX "SodGrant_live_scope_key"
  ON "SodGrant"("projectId", "billId", "versionId", "rule", "actorId", "approverId", "reviewedStatus", "reviewedLifecycleVersion")
  WHERE "consumedAt" IS NULL AND "retiredAt" IS NULL;

-- ── …AND THE COLUMN JOINS EVERY SEAL THAT ALREADY SURROUNDS THIS ROW ─────────────────────────
--
-- Codex, on the first head of this unit, three findings with ONE root: I added the evidence to the
-- COLUMN and stopped there. The append-only trigger that freezes every other field of a grant did
-- not learn it, and neither did the commit-time seal that judges a consumed one. That is PR #310's
-- audit rule 1 — fix the CLASS, not the instance a finding names — recurring on the very artifact
-- introduced to close a finding, which is the shape this table's own comments record twice already.
--
-- A new fact on a guarded row belongs to every guard on that row, or it is decoration.

-- (1) FROZEN. `reviewedStatus` is what an approver is recorded as having reviewed; leaving it
-- outside the immutable set let a direct writer walk a grant from `submitted` to `verified` and
-- rewrite the justification underneath an authority that had already been given. The rest of the
-- function is Task 5's, verbatim — only the new column is added, because the rule it states
-- ("a grant is immutable apart from its one-way consumption") has not changed.
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
     OR NEW."reviewedStatus" IS DISTINCT FROM OLD."reviewedStatus"
     OR NEW."reviewedLifecycleVersion" IS DISTINCT FROM OLD."reviewedLifecycleVersion"
     OR NEW."sourceCommandId" IS DISTINCT FROM OLD."sourceCommandId" THEN
    RAISE EXCEPTION 'A segregation-of-duties grant is IMMUTABLE — only its one-way consumption may be stamped (%)', OLD."id";
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'This grant was already consumed at % — an authority is exercised ONCE (%)', OLD."consumedAt", OLD."id";
  END IF;
  -- RETIREMENT is the other one-way stamp, and it is one-way for the same reason consumption is:
  -- a row that can be un-retired is a row whose disposal nobody can rely on.
  IF OLD."retiredAt" IS NOT NULL THEN
    RAISE EXCEPTION 'This grant was retired at % — a retired authority is history and does not come back (%)', OLD."retiredAt", OLD."id";
  END IF;
  IF NEW."retiredAt" IS NOT NULL AND NEW."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'A grant is either exercised or retired, never both (%)', OLD."id";
  END IF;
  -- ── …AND RETIREMENT IS FOR THE POPULATION IT WAS CUT FOR ────────────────────────────────────
  --
  -- Codex round 5 (P2). Round 4 introduced retirement as the disposal of a LEGACY row — one written
  -- before the reviewed columns existed, which this release cannot judge because no evidence of
  -- what its approver saw was ever recorded. Making the transition one-way is not the same as
  -- saying WHO may take it, and unscoped it became a general revocation: stamp `retiredAt` on a
  -- fully evidenced grant and `resolveSodGrant` filters it out while the live-scope index frees the
  -- slot, so an approver's recorded authority disappears with no counter-authority anywhere.
  --
  -- An escape hatch cut for one population applies to all of them unless it says otherwise. This
  -- says otherwise: a grant that CARRIES its evidence is judged by the seals — spent, or refused
  -- for a stated reason — and is never disposed of. Withdrawing a live authority is a different act
  -- with a different author, and it does not exist in this release rather than existing by
  -- accident here.
  IF NEW."retiredAt" IS NOT NULL AND OLD."retiredAt" IS NULL THEN
    IF OLD."reviewedStatus" IS NOT NULL AND OLD."reviewedLifecycleVersion" IS NOT NULL THEN
      RAISE EXCEPTION 'Grant % records what its approver reviewed, so it is judged by the seals rather than retired — retirement disposes of authority this release cannot judge, and withdrawing a live one is a separate act with its own author', OLD."id";
    END IF;
    IF NEW."retiredReason" IS NULL OR btrim(NEW."retiredReason") = '' THEN
      RAISE EXCEPTION 'Retiring an authority states why, or the register records a disappearance rather than a disposal (%)', OLD."id";
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- (2) The admissible reviewed states, PER RULE, in one place.
--
-- A trigger cannot import TypeScript, so this is the one unavoidable second copy of a shared set —
-- the position `phase5_t6b_derived_bill_status` is already in, and handled the same way: the SQL is
-- the mirror and an integration probe pins it to `BILL_CERTIFY_FROM` and
-- `BILL_STATUSES_PAST_CERTIFICATION`, so a member added to the shared lifecycle and forgotten here
-- fails a test rather than silently refusing a legitimate authorisation in production.
--
-- An UNKNOWN rule admits nothing. §I has exactly two rules today; a third added without teaching
-- this function is refused rather than waved through, which is the direction a seal should fail.
CREATE OR REPLACE FUNCTION phase5_t7biiih_admissible_reviewed_states(p_rule text)
RETURNS text[] AS $$
  SELECT CASE p_rule
    -- certification applies to a VERIFIED claim: the §E verdict is what makes it safe
    WHEN 'evidence-recorder-may-not-certify' THEN ARRAY['verified']
    -- a payment approval proceeds from a claim that HAS a live certification behind it
    WHEN 'certifier-may-not-approve' THEN ARRAY['certified', 'approved-for-payment', 'part-paid', 'paid']
    ELSE ARRAY[]::text[]
  END;
$$ LANGUAGE sql IMMUTABLE;

-- (3) SEALED AT CONSUMPTION, which is where the authority is actually spent.
--
-- The service checks the reviewed state against what is true NOW; the database cannot, because by
-- COMMIT the act has already moved the claim on (a certification leaves the bill `certified`, not
-- `verified`). So the durable rule is the one thing that IS invariant: the state a grant records
-- must be one its rule can legitimately be exercised from. A grant recorded at `submitted` can
-- never certify anything, whatever else is true.
--
-- ONE trigger for BOTH consumption arms deliberately. Task 6A added `consumedByApprovalId` and had
-- to write a SECOND seal because 5B's was guarded on the certificate arm — the sibling-not-updated
-- shape again. This is placed on the transition every arm passes through, so a third target would
-- inherit it rather than need a third copy.
CREATE OR REPLACE FUNCTION phase5_t7biiih_grant_reviewed_state_sealed() RETURNS trigger AS $$
DECLARE
  v_acted  integer;
  v_status text;
  v_rev    integer;
BEGIN
  -- ── AN AUTHORITY IS TRUE WHEN IT IS ISSUED, NOT ONLY WHEN IT IS SPENT ───────────────────────
  --
  -- Codex round 5 (P1), and the same root as the revision trigger's missing INSERT arm above: this
  -- seal policed CONSUMPTION and returned immediately for everything else, so the way a grant is
  -- BORN was never judged at all.
  --
  -- What that left open is not a stale grant — those the consume seal catches — but a PREMATURE
  -- one. A direct writer records a grant whose reviewed revision is a passage the claim has not
  -- reached yet. Nothing refuses it, because nothing looks. Later the claim arrives at that
  -- revision in an admissible status, `resolveSodGrant` finds a row matching on every column, and
  -- the consume seal is satisfied because the act and the grant agree — on a state the approver
  -- could not possibly have reviewed, because it did not exist when they signed.
  --
  -- So the grant is checked against the claim as it stands the moment it is written: the evidence
  -- must be present, and it must be TRUE. An authority is either about something that has happened
  -- or it is a blank cheque post-dated by whoever wrote it.
  IF NEW."consumedAt" IS NULL THEN
    -- The only other way here is a retirement stamp, which asserts nothing new about what was
    -- reviewed — and by then the claim has usually moved, so re-judging it would refuse the very
    -- disposal the row needs. The issue-time facts were judged when the row was written.
    IF TG_OP <> 'INSERT' THEN RETURN NULL; END IF;

    IF NEW."reviewedStatus" IS NULL OR NEW."reviewedLifecycleVersion" IS NULL THEN
      RAISE EXCEPTION 'Grant % records no reviewed state, so nothing attests to what its approver was looking at — an authority is issued against a claim someone read, and this one names nothing', NEW."id";
    END IF;

    -- FOR UPDATE for the act trigger's reason, and it holds the STATUS still as well: every §F
    -- transition touches this same counter, so a session that cannot move the revision cannot move
    -- the label underneath this check either.
    SELECT r."revision" INTO v_rev FROM "VendorBillRevision" r
     WHERE r."projectId" = NEW."projectId" AND r."billId" = NEW."billId"
       FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Claim % carries no revision record, so there is no passage of it an authority could name', NEW."billId";
    END IF;
    SELECT b."status" INTO v_status FROM "VendorBill" b
     WHERE b."projectId" = NEW."projectId" AND b."id" = NEW."billId";

    IF NEW."reviewedLifecycleVersion" <> v_rev OR NEW."reviewedStatus" IS DISTINCT FROM v_status THEN
      RAISE EXCEPTION 'Grant % is authorised over this claim reading % at revision %, but the claim reads % at revision % — an authority names the claim as it stands, never a passage it has not reached', NEW."id", NEW."reviewedStatus", NEW."reviewedLifecycleVersion", COALESCE(v_status, '(absent)'), v_rev;
    END IF;
    RETURN NULL;
  END IF;

  -- A grant written before this column existed records NO evidence of what its approver saw. That
  -- is not the same as recording something harmless: the register's whole purpose is attributable
  -- human authorisation, and inferring a reviewed state would be putting words in an approver's
  -- mouth. Unusable is the safe direction, and the migration's diagnostic stops the deploy on any
  -- LIVE legacy grant so nobody discovers this at the moment they try to certify.
  --
  -- BOTH halves of the evidence, because half of it attests to nothing: the status says what the
  -- claim read and the lifecycle version says WHICH passage through that reading it was, and a
  -- label without the counter is exactly the recycling hole `certified → paid → certified` opens.
  IF NEW."reviewedStatus" IS NULL OR NEW."reviewedLifecycleVersion" IS NULL THEN
    RAISE EXCEPTION 'Grant % records no reviewed state, so nothing attests to what its approver was looking at — an authority without that evidence is a permission slip, not a justification; a pmc with standing must issue it again against the claim as it stands', NEW."id";
  END IF;

  IF NOT (NEW."reviewedStatus" = ANY (phase5_t7biiih_admissible_reviewed_states(NEW."rule"))) THEN
    RAISE EXCEPTION 'Grant % was authorised over a claim reading %, a state no `%` authority can be spent from — the claim version does not change as it moves through its lifecycle, so a version pin does not say WHAT was reviewed; it needs authorising again against the state that holds now', NEW."id", NEW."reviewedStatus", NEW."rule";
  END IF;

  -- …and the AUTHORITY and the ACT must name the same passage of the claim (Codex round 3, P1).
  --
  -- The admissible-set check above says the reviewed state is one this rule can proceed FROM. It
  -- does not say it is the one THIS act proceeded from — and it cannot, because a claim returns to
  -- an admissible state repeatedly. Leave an unspent `verified` grant at revision L1, let a
  -- certificate be issued and superseded so the claim is `verified` again at L3, and every other
  -- clause still matches.
  --
  -- Comparing against the bill's CURRENT revision is not available here: this fires at COMMIT, by
  -- which time the act itself has advanced it. So the act carries what it saw, the grant carries
  -- what its approver saw, and the seal requires them equal — two frozen columns, no inference.
  SELECT COALESCE(
    (SELECT c."reviewedLifecycleVersion" FROM "BillCertificate" c
      WHERE c."projectId" = NEW."projectId" AND c."id" = NEW."consumedByCertificateId"),
    (SELECT a."reviewedLifecycleVersion" FROM "PaymentApproval" a
      WHERE a."projectId" = NEW."projectId" AND a."id" = NEW."consumedByApprovalId")
  ) INTO v_acted;
  IF v_acted IS NULL OR v_acted <> NEW."reviewedLifecycleVersion" THEN
    RAISE EXCEPTION 'Grant % was authorised against revision % of this claim, and the act consuming it was performed against % — an authority is spent on the claim its approver actually reviewed, and this claim moved in between', NEW."id", NEW."reviewedLifecycleVersion", COALESCE(v_acted::text, '(unrecorded)');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "SodGrant_reviewed_state_sealed" ON "SodGrant";
CREATE CONSTRAINT TRIGGER "SodGrant_reviewed_state_sealed"
  AFTER INSERT OR UPDATE ON "SodGrant" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION phase5_t7biiih_grant_reviewed_state_sealed();

-- ── AND ONLY NOW MAY LEGACY AUTHORITY BE RETIRED ────────────────────────────────────────────
--
-- Placed last for round 3's reason — a migration that changes what authority means installs every
-- guard before it acts — and shaped as a retirement rather than an abort for round 4's: an abort
-- here could never be cleared, because the guards above make a legacy row unfillable,
-- unconsumable and undeletable.
--
-- RETROACTIVE and idempotent: it names rows that predate the evidence columns, and a rerun finds
-- none because the first run retired them.
UPDATE "SodGrant"
   SET "retiredAt" = now(),
       "retiredReason" = 'phase5_t7biiih: predates the reviewed-state record; no evidence exists of what its approver reviewed, so it authorises nothing and must be re-issued against the claim as it stands'
 WHERE "consumedAt" IS NULL AND "retiredAt" IS NULL
   AND ("reviewedStatus" IS NULL OR "reviewedLifecycleVersion" IS NULL);

DO $$
DECLARE v_retired integer;
BEGIN
  SELECT count(*) INTO v_retired FROM "SodGrant"
   WHERE "retiredAt" IS NOT NULL AND "reviewedStatus" IS NULL;
  IF v_retired > 0 THEN
    RAISE NOTICE 'phase5_t7biiih: retired % segregation-of-duties grant(s) that predate the reviewed-state record. They are retained and marked, and authorise nothing. A pmc must re-issue each one against the claim state they can see now — see docs/RUNBOOK.md.', v_retired;
  END IF;
END $$;
