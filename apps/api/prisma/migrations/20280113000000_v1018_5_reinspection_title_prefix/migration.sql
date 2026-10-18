-- #482 V-1018-5 PR 2 — remove the English "Re-inspection: " words the server used to store in a re-inspection's title.
--
-- Before #972 the server created every re-inspection with the title "Re-inspection: " + its parent's title, so Hindi
-- and Gujarati readers saw English inside a record nobody typed. #972 stores the plain title and every screen now adds
-- the label in the reader's language from "reinspectionOfId", so the rows written before it read the label twice.
--
-- WHICH ROWS (the Board's rule, #482): only a row whose "reinspectionOfId" is set AND whose title is exactly
-- 'Re-inspection: ' || <its parent's stored title>. Nothing else is read or written: a title someone typed that merely
-- starts with those words, a re-inspection whose parent was retitled, and every ordinary inspection stay as they are.
--
-- WHAT THEY BECOME: the parent's title after this migration. For a first re-inspection that is the parent's title,
-- i.e. the prefix stripped once. A re-check of a re-check was stored "Re-inspection: Re-inspection: X"; its parent
-- matches the rule too and becomes "X", so the re-check becomes "X" as well, the lineage's first title. That is what
-- #972 now stores for a new re-check, so old and new rows read the same.
--
-- The chain is walked from the top: a seed is a matching row whose parent does not itself match; each step adds a
-- matching child of a row already resolved and gives it the same title. Every row is resolved from the titles as they
-- stood before this statement, in one UPDATE.
--
-- THE READ MODEL TOO (Codex 4308535200). The `inspections.inbox` projection keeps one serialized copy of a project's
-- inspections per generation ("InspectionsProjection"."dto" = { inspections: [ { id, title, ... } ] }), refreshed only
-- by the next inspection event. A quiet project's active generation would go on serving the old title. So the same
-- statement-set rewrites that copy: in every stored row for a project with a resolved row, each entry whose "id" is
-- resolved takes the same new title, and nothing else in the document changes. Projection and canonical read the
-- same afterwards, with no rebuild and no generation change.
--
-- No trigger on "Inspection" governs "title" (the assignee freeze and the submit fence compare other columns), so the
-- UPDATE passes them untouched. Re-runnable: a resolved row equals its parent's title, which never again equals
-- 'Re-inspection: ' || that title, so a second run changes nothing.
--
-- The NOTICE lines report how many rows changed and how many re-inspections were left as they are, split into the QA
-- project(s) (any project with a member signed in as a qa.*@vitan.in account) and everything else.
DO $v1018_5$
DECLARE
  changed_qa integer;
  changed_other integer;
  untouched_qa integer;
  untouched_other integer;
BEGIN
  CREATE TEMP TABLE v1018_5_resolved ON COMMIT DROP AS
  WITH RECURSIVE
    matching AS (
      SELECT c."id", c."projectId", c."reinspectionOfId"
        FROM "Inspection" c
        JOIN "Inspection" p ON p."projectId" = c."projectId" AND p."id" = c."reinspectionOfId"
       WHERE c."reinspectionOfId" IS NOT NULL
         AND c."title" = 'Re-inspection: ' || p."title"
    ),
    resolved AS (
      SELECT m."id", m."projectId", p."title" AS "newTitle"
        FROM matching m
        JOIN "Inspection" p ON p."projectId" = m."projectId" AND p."id" = m."reinspectionOfId"
       WHERE NOT EXISTS (SELECT 1 FROM matching up WHERE up."id" = m."reinspectionOfId")
      UNION ALL
      SELECT m."id", m."projectId", r."newTitle"
        FROM matching m
        JOIN resolved r ON r."projectId" = m."projectId" AND r."id" = m."reinspectionOfId"
    )
  SELECT "id", "projectId", "newTitle" FROM resolved;

  CREATE TEMP TABLE v1018_5_qa_projects ON COMMIT DROP AS
  SELECT DISTINCT m."projectId"
    FROM "Membership" m
    JOIN "User" u ON u."id" = m."userId"
   WHERE lower(u."email") LIKE 'qa.%@vitan.in';

  UPDATE "Inspection" i
     SET "title" = r."newTitle"
    FROM v1018_5_resolved r
   WHERE i."projectId" = r."projectId" AND i."id" = r."id";

  UPDATE "InspectionsProjection" ip
     SET "dto" = jsonb_set(ip."dto", '{inspections}', (
           SELECT COALESCE(jsonb_agg(
                    CASE WHEN r."id" IS NULL THEN e.entry ELSE e.entry || jsonb_build_object('title', r."newTitle") END
                    ORDER BY e.pos), '[]'::jsonb)
             FROM jsonb_array_elements(ip."dto" -> 'inspections') WITH ORDINALITY AS e(entry, pos)
             LEFT JOIN v1018_5_resolved r ON r."projectId" = ip."projectId" AND r."id" = e.entry ->> 'id')),
         "updatedAt" = now()
   WHERE jsonb_typeof(ip."dto" -> 'inspections') = 'array'
     AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(ip."dto" -> 'inspections') AS x(entry)
         JOIN v1018_5_resolved r ON r."projectId" = ip."projectId" AND r."id" = x.entry ->> 'id'
        WHERE x.entry ->> 'title' IS DISTINCT FROM r."newTitle");

  SELECT count(*) FILTER (WHERE q."projectId" IS NOT NULL), count(*) FILTER (WHERE q."projectId" IS NULL)
    INTO changed_qa, changed_other
    FROM v1018_5_resolved r LEFT JOIN v1018_5_qa_projects q ON q."projectId" = r."projectId";

  SELECT count(*) FILTER (WHERE q."projectId" IS NOT NULL), count(*) FILTER (WHERE q."projectId" IS NULL)
    INTO untouched_qa, untouched_other
    FROM "Inspection" i LEFT JOIN v1018_5_qa_projects q ON q."projectId" = i."projectId"
   WHERE i."reinspectionOfId" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM v1018_5_resolved r WHERE r."projectId" = i."projectId" AND r."id" = i."id");

  RAISE NOTICE 'V-1018-5 re-inspection titles: changed QA=% non-QA=%; re-inspections left as they are QA=% non-QA=%',
    changed_qa, changed_other, untouched_qa, untouched_other;
END
$v1018_5$;
