-- Phase 1 gate remediation (finding 2) — additive, diagnostic-first.
--
-- Concurrent construction issues could leave TWO live for_construction
-- revisions on one drawing (the governing revision then depended on createdAt
-- ordering — not a reliable fact). The service now serializes issue/publish on
-- the parent Drawing row (SELECT … FOR UPDATE); this partial unique index is
-- the DATABASE backstop: at most one live for_construction revision per
-- drawing, even against direct writes.
--
-- DIAGNOSTICS FIRST — if any drawing already carries multiple live
-- for_construction revisions, the migration ABORTS and an operator decides
-- which revision governs (supersede the others by hand). Never guessed.

DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT "drawingId" FROM "DrawingRevision"
    WHERE "status" = 'for_construction'
    GROUP BY "drawingId" HAVING count(*) > 1
  ) multi;
  IF bad > 0 THEN
    RAISE EXCEPTION 'phase1_drawing_governing: % drawing(s) carry multiple live for_construction revisions — resolve by hand before migrating', bad;
  END IF;
END $$;

-- CreateIndex: ONE governing construction revision per drawing
CREATE UNIQUE INDEX "DrawingRevision_one_construction_per_drawing" ON "DrawingRevision" ("drawingId") WHERE "status" = 'for_construction';
