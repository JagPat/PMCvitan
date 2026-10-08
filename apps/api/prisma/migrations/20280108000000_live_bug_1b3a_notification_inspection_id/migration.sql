-- Live bug 1b-3a — the inspection an inspection notice announces.
--
-- A notice is a derived communication artifact, so which inspection it is about must not be read back out
-- of its display text: a title or zone is user text and can carry anything (Codex 4214386937 on #735). The
-- writers stamp this column, exactly as "decisionId" is stamped for decision notices
-- (20270810000000_phase6_t4a_withdraw). Nullable: non-inspection notices and every legacy row carry none,
-- and a legacy row names no inspection. NOT a relation: a notice may outlive its inspection, and a deleted
-- project cascades via "projectId".
--
-- Additive and previous-release safe: an old release neither reads nor writes the column.
ALTER TABLE "Notification" ADD COLUMN IF NOT EXISTS "inspectionId" TEXT;

-- THE STAMP IS A TRUSTED CLAIM, SO IT IS SEALED (Codex 4215279309, 4215279320 on #736). The bell opens the
-- inspection this column names, so two things are enforced by PostgreSQL rather than by the writers:
--
-- 1. FROZEN after insert. A notice announces the inspection it was written for: no UPDATE may re-point a
--    stamp, fill one on a row written without it (a legacy kindless notice would acquire a target no writer
--    gave it), or clear one. No service writer updates a Notification. A STAMPED notice also keeps its
--    project and its class: its `projectId` may not move (the containment judged at insert would stop being
--    true; the 4d-i seal freezes `projectId` only on event-bound rows, Codex 4216092325), and it may not later
--    acquire a `decisionId`, which the bell resolves first (Codex 4216092340).
-- 2. SAME PROJECT at insert. A non-NULL stamp must name an inspection of the notice's own project. Checked
--    once, when the stamp is written (DEFERRED, so a writer may insert the notice before its inspection in
--    the same transaction), and not as a foreign key, because a notice may outlive its inspection.
-- 3. INSPECTION CLASS at insert. A stamped notice is a kindless inspection notice: it carries no `decisionId`,
--    `kind` or `eventId`, so a decision or event-bound notice can never also name an inspection
--    (Codex 4216092340).
CREATE OR REPLACE FUNCTION live_bug_1b3_notification_inspection_freeze() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."inspectionId" IS DISTINCT FROM OLD."inspectionId" THEN
    RAISE EXCEPTION
      'live bug 1b-3a: notice % may not change the inspection it announces (% → %) — the stamp is written once, by the writer of the notice',
      OLD."id", COALESCE(OLD."inspectionId", '<null>'), COALESCE(NEW."inspectionId", '<null>');
  END IF;
  IF OLD."inspectionId" IS NOT NULL THEN
    IF NEW."projectId" IS DISTINCT FROM OLD."projectId" THEN
      RAISE EXCEPTION
        'live bug 1b-3a: notice % announces inspection % and may not change project (% → %) — the stamp was judged against its own project',
        OLD."id", OLD."inspectionId", OLD."projectId", NEW."projectId";
    END IF;
    IF NEW."decisionId" IS DISTINCT FROM OLD."decisionId" THEN
      RAISE EXCEPTION
        'live bug 1b-3a: notice % announces inspection % and may not name a decision (%) — a stamped notice is an inspection notice',
        OLD."id", OLD."inspectionId", COALESCE(NEW."decisionId", '<null>');
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "Notification_1b3_inspection_freeze" ON "Notification";
CREATE TRIGGER "Notification_1b3_inspection_freeze" BEFORE UPDATE ON "Notification"
  FOR EACH ROW EXECUTE FUNCTION live_bug_1b3_notification_inspection_freeze();

CREATE OR REPLACE FUNCTION live_bug_1b3_notification_inspection_bound() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."inspectionId" IS NOT NULL
    AND (NEW."decisionId" IS NOT NULL OR NEW."kind" IS NOT NULL OR NEW."eventId" IS NOT NULL) THEN
    RAISE EXCEPTION
      'live bug 1b-3a: notice % names inspection % but is not an inspection notice (decision %, kind %, event %) — only a kindless, eventless notice may announce an inspection',
      NEW."id", NEW."inspectionId", COALESCE(NEW."decisionId", '<null>'), COALESCE(NEW."kind", '<null>'), COALESCE(NEW."eventId", '<null>');
  END IF;
  IF NEW."inspectionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Inspection" i WHERE i."id" = NEW."inspectionId" AND i."projectId" = NEW."projectId"
  ) THEN
    RAISE EXCEPTION
      'live bug 1b-3a: notice % names inspection %, which is not an inspection of project % — a notice may only announce a record of its own project',
      NEW."id", NEW."inspectionId", NEW."projectId";
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS "Notification_1b3_inspection_bound" ON "Notification";
CREATE CONSTRAINT TRIGGER "Notification_1b3_inspection_bound"
  AFTER INSERT ON "Notification" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION live_bug_1b3_notification_inspection_bound();
