-- Idempotency-Key Unit 2a-m (notes/idempotency-key/u2/plan.md §2). The count that tells when the server may refuse a
-- missing key on five routes (Unit 2b). Unit 1 (#1240) sends a stored keyless act of an earlier release under a
-- `legacy-` key, so a request on these routes with no key, or with a `legacy-` key, means an earlier-release tab, a
-- plain-http address, or a stored act from before the keys is still being sent. 2b opens only after 7 days with none.
-- Container logs do not last that long (each deploy replaces them), and an audit row is written only for an act that
-- commits, so a refused resend would never be counted: the count needs its own table.
--
-- WHAT. One table, "CommandKeySighting": per route, class and UTC day, how many such requests arrived and the newest
-- one's time. Nothing else: no person, project, body or key. A row exists only for a day with such a request, so the
-- table holds at most 5 routes x 2 classes rows a day, and none once the residual is gone. A CHECK holds every row to
-- the five routes, the two classes, a count of at least one and finite times. Unit 2a writes it (one upsert, outside
-- each command's transaction) and reads it through the operator door; nothing does yet.
--
-- ITS END. Unit 2b stops writing it when it starts refusing; once 2b is live, a migration-only unit drops the table.
--
-- SAFE UNDER THE PREVIOUS RELEASE. A new table nothing reads or writes; the previous release's Prisma client does not
-- know it.
--
-- LOCKS WHILE IT RUNS. CREATE TABLE locks only the new table. No lock is waited for longer than 15 s (lock_timeout,
-- this transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline
-- models the table but not its CHECK). IF NOT EXISTS, and the CHECK is added only when missing. Schema-qualified.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

CREATE TABLE IF NOT EXISTS public."CommandKeySighting" (
  "route"  TEXT NOT NULL,
  "class"  TEXT NOT NULL,
  "day"    DATE NOT NULL,
  "count"  INTEGER NOT NULL,
  "lastAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CommandKeySighting_pkey" PRIMARY KEY ("route", "class", "day")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."CommandKeySighting"'::regclass AND conname = 'CommandKeySighting_shape_check') THEN
    ALTER TABLE public."CommandKeySighting" ADD CONSTRAINT "CommandKeySighting_shape_check"
      CHECK ("route" IN ('activities.start', 'activities.complete', 'inspections.decide', 'daily-log.flag-mismatch', 'daily-log.submit')
             AND "class" IN ('absent', 'legacy')
             AND "count" >= 1
             AND isfinite("day") AND isfinite("lastAt"));
  END IF;
END $$;

COMMIT;
