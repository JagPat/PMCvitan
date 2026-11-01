-- #904 / #1262 (Codex round 1, threads 4436515182 and 4436515187): an upload key's replay names a file by the type and
-- byte length it was stored with, and two different files can share both. A replay must instead be compared with the
-- bytes themselves. This file adds the column that holds them as a digest; #1262 writes it on every new upload and
-- compares it on replay. Nothing else changes here.
--
-- WHAT. One nullable column, "Media"."contentSha256": the SHA-256 of the file's decoded bytes as 64 lowercase hex
-- characters, written once with the row. A CHECK holds it to that shape or NULL. A row stored before #1262 has NULL, and
-- its replay keeps the byte-length comparison (that is #1262's stated residual, with its end).
--
-- SAFE UNDER THE PREVIOUS RELEASE. The previous release never names the column: its Prisma client neither selects nor
-- writes it, and its inserts leave it NULL, which the CHECK takes.
--
-- LOCKS WHILE IT RUNS. ADD COLUMN with no default is a catalog change; the CHECK reads "Media" once, under the same
-- ACCESS EXCLUSIVE lock, and every row is NULL. No lock is waited for longer than 15 s (lock_timeout, this transaction
-- only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline
-- models the column but not its CHECK). IF NOT EXISTS, and the CHECK is added only when missing. Schema-qualified.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

ALTER TABLE public."Media" ADD COLUMN IF NOT EXISTS "contentSha256" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."Media"'::regclass AND conname = 'Media_contentSha256_shape_check') THEN
    ALTER TABLE public."Media" ADD CONSTRAINT "Media_contentSha256_shape_check"
      CHECK ("contentSha256" IS NULL OR "contentSha256" ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

COMMIT;
