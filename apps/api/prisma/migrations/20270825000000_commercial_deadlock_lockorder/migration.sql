-- ═══════════════════════════════════════════════════════════════════════════════════════════
-- Commercial CI deadlock — one lock order for the §G bound check
--
-- SYMPTOM. `api-e2e` fails intermittently on `commercial-pilot.spec.ts` §M chain, always the same
-- way: PostgreSQL detects a deadlock out of `CommercialPaymentService.approve`, the payment
-- approval is never written, `pay-approval` never appears, and the test times out. It has blocked
-- two unrelated pull requests — #342 (a CSS focus-ring change that cannot touch commercial
-- payments; failed attempts 1 AND 2, passed on 3) and #344 — with a byte-identical signature:
--
--   Process A: COMMIT — while locking tuple (0,2) in relation "PurchaseOrderLine"
--              phase5_t4_billed_bound_check line 11 ← phase5_t4_bill_status_sealed line 37
--   Process B: SELECT 1 FROM "Membership" WHERE "projectId" = $1 AND "userId" = $2 FOR UPDATE
--
-- MECHANISM. Every caller of `phase5_t4_billed_bound_check` is a DEFERRABLE INITIALLY DEFERRED
-- constraint trigger, so its `PurchaseOrderLine` lock is always taken at COMMIT — LAST in its
-- transaction, after whatever authority lock that command already holds. The other side never
-- takes an explicit PO-line lock at all: inserting a `VendorBillLine` whose foreign key references
-- a `PurchaseOrderLine` makes PostgreSQL take `FOR KEY SHARE` on the referenced row INLINE, at
-- insert time, and that transaction then reaches its own authority check and wants the membership
-- row the first one is holding. `FOR UPDATE` conflicts with `FOR KEY SHARE`, and the cycle closes.
--
-- FIX. `FOR NO KEY UPDATE` instead of `FOR UPDATE`. The lock exists to serialize the bound check
-- against anything that could change the number it reads — the Phase-4 T3 F3 lesson, stated in the
-- function's own comment: "two sessions that each counted a fold nobody was holding would both
-- pass and both commit". `FOR NO KEY UPDATE` keeps EVERY conflict that lesson needs:
--
--   • another bound check (`FOR NO KEY UPDATE`)            → conflicts, still serialized
--   • an UPDATE of "qty" / "approvedOverage" / "status"    → conflicts, still serialized
--     (an ordinary UPDATE of non-key columns takes exactly this lock)
--   • a DELETE of the PO line (`FOR UPDATE`)               → conflicts, still blocked
--   • `SELECT … FOR SHARE` on the line                     → conflicts, still blocked
--
-- and drops exactly one: `FOR KEY SHARE`, taken by an INSERT that merely REFERENCES the line. Such
-- an insert cannot change "qty", "approvedOverage" or "status", so it was never a reason to wait —
-- it was only ever the edge that closed the cycle. The invariant is unchanged; the false conflict
-- is gone.
--
-- This is a `CREATE OR REPLACE` of one function. No column, constraint, trigger or row is touched,
-- `20270420000000` is byte-for-byte unchanged, and a re-run is a no-op. The function body below is
-- `20270420000000`'s verbatim, with the two lock clauses rewritten and nothing else altered.
-- ═══════════════════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION phase5_t4_billed_bound_check(
  p_project text, p_material text, p_labour text,
  -- Codex round-6 — count THIS version's lines as though the bill were already live. Every
  -- ordinary caller leaves it NULL. The RESOLUTION is the one case that needs it: §0 keeps a
  -- `disputed` bill out of every billed set, so the replacement is invisible to the fold at the
  -- exact moment the lifecycle is deciding whether it is a correction at all.
  p_include_version text DEFAULT NULL
)
RETURNS void AS $$
DECLARE
  v_billed numeric;
  v_ordered numeric;
  v_evidence numeric;
  v_version text;
BEGIN
  IF p_material IS NOT NULL THEN
    -- serialize on the constraining row FIRST: two sessions that each counted a fold nobody was
    -- holding would both pass and both commit (Phase-4 T3 F3).
    SELECT "qty" + "approvedOverage", "poVersionId" INTO v_ordered, v_version
      FROM "PurchaseOrderLine" WHERE "projectId" = p_project AND "id" = p_material FOR NO KEY UPDATE;
    IF v_ordered IS NULL THEN RETURN; END IF;
    -- Codex round-1 F1 — a DEAD order authorises NOTHING, and the first head read the line''s
    -- frozen quantity without ever asking whether its version was still live. `pos.cancel`/amend
    -- moves the old version to `cancelled`/`amended` long after a claim was submitted, and the
    -- service only disputes `order-not-live` at SUBMISSION — so a claim submitted BEFORE the
    -- cancel stayed live against an order nobody owes. Ordered authority is the THIRD withdrawal
    -- path, alongside acceptance reversal and measurement correction (§0b: same rule, every site).
    SELECT CASE WHEN "status" IN ('issued','partially_received','completed','closed_short')
                THEN v_ordered ELSE 0 END INTO v_ordered
      FROM "PurchaseOrderVersion" WHERE "projectId" = p_project AND "id" = v_version;

    SELECT COALESCE(SUM(l."quantity"), 0) INTO v_billed
      FROM "VendorBillLine" l
      JOIN "VendorBillVersion" v ON v."projectId" = l."projectId" AND v."id" = l."versionId"
      JOIN "VendorBill"        b ON b."projectId" = v."projectId" AND b."id" = v."billId"
     WHERE l."projectId" = p_project AND l."poLineId" = p_material
       AND v."supersededAt" IS NULL
       AND b."status" NOT IN ('draft', 'rejected', 'disputed', 'resolved');

    IF p_include_version IS NOT NULL THEN
      SELECT v_billed + COALESCE(SUM(l."quantity"), 0) INTO v_billed
        FROM "VendorBillLine" l
       WHERE l."projectId" = p_project AND l."labourPoLineId" = p_labour AND l."versionId" = p_include_version;
    END IF;

    IF p_include_version IS NOT NULL THEN
      SELECT v_billed + COALESCE(SUM(l."quantity"), 0) INTO v_billed
        FROM "VendorBillLine" l
       WHERE l."projectId" = p_project AND l."poLineId" = p_material AND l."versionId" = p_include_version;
    END IF;

    IF v_billed > v_ordered THEN
      RAISE EXCEPTION 'Bound 1 breached on purchase-order line %: live claims total % base units against an ordered authority of % (qty + approvedOverage, or ZERO once the version is no longer live)', p_material, v_billed, v_ordered;
    END IF;

    -- `ACCEPTED(poLine)` per §0: acceptance movements NET of reversals whose target is an
    -- acceptance. NOT `accepted − rejected` (disjoint arms understate an 80/20 split as 60), and
    -- NOT the `acceptedOnHand` balance (issuing empties it; a cycle-count adjustment fills it
    -- with no receipt behind it). Acceptance is an EVENT, not a balance.
    SELECT COALESCE(SUM(
             CASE WHEN t."type" = 'acceptance' THEN t."qty"
                  WHEN t."type" = 'reversal' AND target."type" = 'acceptance' THEN -t."qty"
                  ELSE 0 END), 0) INTO v_evidence
      FROM "StockTransaction" t
      JOIN "StockLot" lot ON lot."projectId" = t."projectId" AND lot."id" = t."lotId"
      LEFT JOIN "StockTransaction" target ON target."projectId" = t."projectId" AND target."id" = t."reversedTxId"
     WHERE t."projectId" = p_project AND lot."poLineId" = p_material;

    IF v_billed > v_evidence THEN
      RAISE EXCEPTION 'Bound 2 breached on purchase-order line %: live claims total % base units against % accepted', p_material, v_billed, v_evidence;
    END IF;
  END IF;

  IF p_labour IS NOT NULL THEN
    SELECT "personShiftQty", "poVersionId" INTO v_ordered, v_version
      FROM "LabourPurchaseOrderLine" WHERE "projectId" = p_project AND "id" = p_labour FOR NO KEY UPDATE;
    IF v_ordered IS NULL THEN RETURN; END IF;
    -- the labour twin of the same rule (its live set names `partially_committed`, not
    -- `partially_received` — the two chains have their own version vocabularies)
    SELECT CASE WHEN "status" IN ('issued','partially_committed','completed','closed_short')
                THEN v_ordered ELSE 0 END INTO v_ordered
      FROM "LabourPurchaseOrderVersion" WHERE "projectId" = p_project AND "id" = v_version;

    SELECT COALESCE(SUM(l."quantity"), 0) INTO v_billed
      FROM "VendorBillLine" l
      JOIN "VendorBillVersion" v ON v."projectId" = l."projectId" AND v."id" = l."versionId"
      JOIN "VendorBill"        b ON b."projectId" = v."projectId" AND b."id" = v."billId"
     WHERE l."projectId" = p_project AND l."labourPoLineId" = p_labour
       AND v."supersededAt" IS NULL
       AND b."status" NOT IN ('draft', 'rejected', 'disputed', 'resolved');

    -- a labour line has no overage column: §G's ordered authority for labour is `personShiftQty`
    IF v_billed > v_ordered THEN
      RAISE EXCEPTION 'Bound 1 breached on labour purchase-order line %: live claims total % person-shifts against an ordered % (ZERO once the version is no longer live)', p_labour, v_billed, v_ordered;
    END IF;

    -- `MEASURED(poLine)` per §0 — the signed fold, corrections included, never a stored total
    SELECT COALESCE(SUM("quantity"), 0) INTO v_evidence
      FROM "Measurement" WHERE "projectId" = p_project AND "labourPoLineId" = p_labour;

    IF v_billed > v_evidence THEN
      RAISE EXCEPTION 'Bound 2 breached on labour purchase-order line %: live claims total % person-shifts against % measured', p_labour, v_billed, v_evidence;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;
