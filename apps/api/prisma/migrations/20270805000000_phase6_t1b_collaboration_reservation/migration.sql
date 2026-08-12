-- Phase 6 unit 6.1b — RESERVE the `collaboration` capability name.
--
-- The boundary plan gates the whole collaborator resolver behind a per-project capability, and
-- that guard does not exist yet. A flag that can be switched on before the thing it governs is a
-- flag that means nothing when it is on: a project could carry `collaboration` today and the only
-- honest reading of that row is "someone enabled a feature that has no behaviour". So the name is
-- reserved HERE, in the unit that creates the identity it will later govern, and 6.2 lifts the
-- reservation in the same migration that installs the resolver. The guard ships with the semantics.
--
-- WHY A CHECK RATHER THAN A TRIGGER. The obligation has two ends — a row must not be INSERTed with
-- this capability, and an existing row must not be UPDATEd to it. A CHECK constraint is evaluated
-- on both by construction, which is the F1 lesson applied before it can bite: F1 was an obligation
-- armed against one end only, and the fix there was one function fired from every table that could
-- break it. Here the same completeness comes free from choosing the right instrument.
--
-- WHY NOT A SERVICE REFUSAL ALONE. `CapabilitiesService.enable` also refuses the name, and that is
-- the friendly error, not the seal. A service check is scoped to the CALLER — the operator CLI, a
-- repair script or a raw insert all walk past it — and 6.1a's Root A is precisely the habit of
-- scoping a check to the caller rather than to the data it protects.

-- ── diagnostic first: never delete an operator's row to make the constraint fit ───────────────
DO $$
DECLARE bad BIGINT; sample TEXT;
BEGIN
  SELECT count(*), COALESCE(string_agg(x."projectId", ', ' ORDER BY x."projectId"), '') INTO bad, sample FROM (
    SELECT "projectId" FROM "ProjectCapability" WHERE "capability" = 'collaboration' LIMIT 20) x;
  IF bad > 0 THEN
    RAISE EXCEPTION
      'phase6-t1b: % project(s) already carry the reserved `collaboration` capability (sample: %). '
      'Nothing in this release gives that flag behaviour, so the row was written before the guard '
      'that governs it existed. Decide what it meant and remove it deliberately '
      '(DELETE FROM "ProjectCapability" WHERE "capability" = ''collaboration'' AND "projectId" = ...), '
      'then redeploy. This migration will not delete it for you.', bad, sample;
  END IF;
END $$;

ALTER TABLE "ProjectCapability" DROP CONSTRAINT IF EXISTS "ProjectCapability_collaboration_reserved";
ALTER TABLE "ProjectCapability" ADD CONSTRAINT "ProjectCapability_collaboration_reserved"
  CHECK ("capability" <> 'collaboration');
