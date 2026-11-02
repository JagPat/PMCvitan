-- Redbracket ID A1 (notes/auth/redbracket-id/plan.md). The three tables PMC's sign-in needs before it can check
-- passwords at Redbracket ID, the platform's own OpenID Connect issuer (https://id.vitan.in). Shipped alone, before any
-- code reads or writes them (A2 client, A3 wiring), behind the IDENTITY_OIDC switch, which is off unless it is
-- exactly "1".
--
-- FRESH JOIN (Board, 31 Oct 2026 22:08 IST). No older PMC account is attached to a Redbracket ID person because an
-- email matches, and no PMC password or hash is sent to the issuer. The first Redbracket ID sign-in for a person
-- makes a NEW PMC account; an older account with that email is switched off (its email set aside), as Hub does.
--
-- WHAT.
--   "PlatformPersonLink": which Redbracket ID person (the issuer's `sub`) a PMC `User` is. At most one per user, and
--     one user per (issuer, sub). No password, hash, token or email. `matchedOn` says how the link was made:
--     'signup' (a new account made for a new person on their first Redbracket ID sign-in) or 'invite' (an invited
--     account that had never signed in, linked when the invitee proved the mailbox with PMC's own emailed code).
--     The shared contract's mapping row `(person, pmc, User.id, sub)`; kind and source are fixed for this table.
--     Falls with its user.
--   "SignInAttempt": one row per sign-in or password-reset attempt, counted BEFORE the issuer is called (5 per email
--     and address in 15 min, 10 per email in 1 h, rows older than a day deleted). No email and no address: only a
--     64-hex digest of each (A3 computes HMAC-SHA-256 under a server secret).
--   "IdentityRetirement": an older account switched off when its email first signed in through Redbracket ID: the
--     email it had (now set aside on the user row) and when. It is the record that lets an operator undo it.
--     Falls with its user.
--   CHECKs hold the shapes: one spelling of an https issuer (lower-case host, optional port and path; no trailing
--   slash, query, fragment or whitespace), a sub of 1 to 255 printable ASCII characters (OIDC Core §2), the two
--   `matchedOn` values, the two attempt kinds, 64-hex digests, a non-blank retired email and finite times.
--   Every bracket expression lists its characters one by one (no `a-z`, `0-9` or `!-~` range): a range's meaning
--   follows the database collation, so a look-alike outside ASCII (U+FF10, U+00E9) could pass under one collation.
--
-- ITS END. Lasting tables, not a residual. With IDENTITY_OIDC off they stay unread.
--
-- SAFE UNDER THE PREVIOUS RELEASE. Three new tables nothing reads or writes; the previous release's Prisma client
-- does not know them. The only references to an existing table are two foreign keys to "User" whose deletes
-- cascade, so a release that deletes a user (the seed, the fixtures) is not blocked.
--
-- LOCKS WHILE IT RUNS. CREATE TABLE locks only the new tables; each foreign key takes a SHARE ROW EXCLUSIVE lock on
-- "User" for the moment it is added (no rows to validate). No lock is waited for longer than 15 s (lock_timeout,
-- this transaction only).
--
-- ONE TRANSACTION, RE-RUNNABLE. BEGIN ... COMMIT; on `scripts/migrate.sh`'s ALWAYS_EXECUTE (a `db push` baseline
-- models the tables but not their CHECKs). IF NOT EXISTS, and each constraint is added only when missing.
-- Schema-qualified.

BEGIN;

SELECT pg_catalog.set_config('lock_timeout', '15s', true);

CREATE TABLE IF NOT EXISTS public."PlatformPersonLink" (
  "userId"    TEXT NOT NULL,
  "issuer"    TEXT NOT NULL,
  "subject"   TEXT NOT NULL,
  "matchedOn" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformPersonLink_pkey" PRIMARY KEY ("userId")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlatformPersonLink_issuer_subject_key"
  ON public."PlatformPersonLink" ("issuer", "subject");

CREATE TABLE IF NOT EXISTS public."SignInAttempt" (
  "id"          BIGSERIAL NOT NULL,
  "kind"        TEXT NOT NULL,
  "emailHash"   TEXT NOT NULL,
  "addressHash" TEXT NOT NULL,
  "at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SignInAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SignInAttempt_emailHash_at_idx" ON public."SignInAttempt" ("emailHash", "at");
CREATE INDEX IF NOT EXISTS "SignInAttempt_at_idx" ON public."SignInAttempt" ("at");

CREATE TABLE IF NOT EXISTS public."IdentityRetirement" (
  "userId"    TEXT NOT NULL,
  "email"     TEXT NOT NULL,
  "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IdentityRetirement_pkey" PRIMARY KEY ("userId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."PlatformPersonLink"'::regclass AND conname = 'PlatformPersonLink_userId_fkey') THEN
    ALTER TABLE public."PlatformPersonLink" ADD CONSTRAINT "PlatformPersonLink_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES public."User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."PlatformPersonLink"'::regclass AND conname = 'PlatformPersonLink_shape_check') THEN
    ALTER TABLE public."PlatformPersonLink" ADD CONSTRAINT "PlatformPersonLink_shape_check"
      CHECK ("issuer" ~ '^https://[abcdefghijklmnopqrstuvwxyz0123456789]([abcdefghijklmnopqrstuvwxyz0123456789.-]*[abcdefghijklmnopqrstuvwxyz0123456789])?(:[0123456789]{1,5})?(/[]ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!"#$%&''()*+,./:;<=>?@[\\^_`{|}~-]*[]ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!"$%&''()*+,.:;<=>@[\\^_`{|}~-])?$'
             AND "issuer" !~ '[?#]'
             AND "subject" ~ '^[]ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!"#$%&''()*+,./:;<=>?@[\\^_`{|}~-]{1,255}$'
             AND "matchedOn" IN ('signup', 'invite')
             AND isfinite("createdAt"));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."SignInAttempt"'::regclass AND conname = 'SignInAttempt_shape_check') THEN
    ALTER TABLE public."SignInAttempt" ADD CONSTRAINT "SignInAttempt_shape_check"
      CHECK ("kind" IN ('sign-in', 'reset')
             AND "emailHash" ~ '^[0123456789abcdef]{64}$'
             AND "addressHash" ~ '^[0123456789abcdef]{64}$'
             AND isfinite("at"));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."IdentityRetirement"'::regclass AND conname = 'IdentityRetirement_userId_fkey') THEN
    ALTER TABLE public."IdentityRetirement" ADD CONSTRAINT "IdentityRetirement_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES public."User" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                  WHERE conrelid = 'public."IdentityRetirement"'::regclass AND conname = 'IdentityRetirement_shape_check') THEN
    ALTER TABLE public."IdentityRetirement" ADD CONSTRAINT "IdentityRetirement_shape_check"
      CHECK ("email" ~ '^[]ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!"#$%&''()*+,./:;<=>?@[\\^_`{|}~-]+@[]ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!"#$%&''()*+,./:;<=>?@[\\^_`{|}~-]+$' AND char_length("email") <= 320 AND isfinite("retiredAt"));
  END IF;
END $$;

COMMIT;
