-- #1177 VT1e, voice note to text. An index for the server's account-wide busy lookup (VT2). Codex on #1226 (round 3,
-- 4408179285; follow-up #1229) found that before each step the server asks whether ANY note was refused as busy in the
-- last 20 s ("lastError" = the busy text, no lease, "updatedAt" recent), across every project, and that with no index
-- that question reads the whole table on every step.
--
-- WHAT. One partial index, "VoiceTranscript_busy_lookup", on ("updatedAt") over the rows with an error and no lease.
-- The lookup's own predicate (an equality on "lastError", "leaseToken" IS NULL) implies this one, so the planner can
-- use it, and the range on "updatedAt" reads only rows written in the last few seconds. The predicate names no
-- message text, so a change to the busy wording never leaves the index unused.
--
-- SAFE UNDER THE PREVIOUS RELEASE. An index changes no row and no answer. The previous release never writes this
-- table (VT2, its first writer, is not merged), and its Prisma client knows nothing of the index.
--
-- LOCKS WHILE IT RUNS. CREATE INDEX takes ShareLock on "VoiceTranscript" until the file commits: writes to the table
-- wait meanwhile (reads do not). The table is empty in production and the file commits in milliseconds; no lock is
-- waited for longer than 15 s (lock_timeout, this transaction only). Not CONCURRENTLY: that cannot run inside the
-- file's one transaction, and on an empty table it buys nothing.
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline does
-- not have a partial index, which the Prisma schema cannot state). IF NOT EXISTS; schema-qualified.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

CREATE INDEX IF NOT EXISTS "VoiceTranscript_busy_lookup"
  ON public."VoiceTranscript" ("updatedAt")
  WHERE "lastError" IS NOT NULL AND "leaseToken" IS NULL;

COMMIT;
