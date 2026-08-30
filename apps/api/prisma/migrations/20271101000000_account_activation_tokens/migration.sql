-- Admin-issued account activation links.
--
-- The account itself already exists: `MembersService.add` writes the `User` with its
-- project role under the owner/admin/pmc guard, and `MemberDto` already reports
-- `credentialState: 'not_set'` for one that has no password yet. What was missing is the
-- HANDOVER — a way to give that person something they can act on when SMS is not
-- configured and the email address may not even be theirs to receive.
--
-- One single-use link, issued by a named admin, expiring, hashed at rest.
--
-- ── WHY THIS IS NOT A `PasswordCredentialChallenge` ROW ────────────────────────────────
-- That table already carries the lifecycle this needs (hashed secret, expiry, attempt
-- cap, single-use `consumedAt`, CAS claim under `lockUserCredential`), and reusing it
-- with a new `purpose` was the obvious cheap path. It is wrong, for one specific reason:
-- `PasswordCredentialsService.complete()` stamps `emailVerifiedAt` when it sets the
-- password. That is TRUE of a six-digit code delivered to the address, and FALSE of a
-- link an admin pasted into WhatsApp — the address is unproven, and may be absent.
-- Recording a verification that never happened would put a lie in the identity trail to
-- save a table, so the shapes stay separate.
CREATE TABLE "AccountActivationToken" (
  "id"         UUID         NOT NULL DEFAULT gen_random_uuid(),
  "userId"     TEXT         NOT NULL,
  "tokenHash"  TEXT         NOT NULL,
  "issuedById" TEXT         NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "revokedAt"  TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountActivationToken_pkey" PRIMARY KEY ("id")
);

-- The secret is stored only as a hash, and one hash is one token.
CREATE UNIQUE INDEX "AccountActivationToken_tokenHash_key"
  ON "AccountActivationToken"("tokenHash");

CREATE INDEX "AccountActivationToken_userId_consumedAt_idx"
  ON "AccountActivationToken"("userId", "consumedAt");
CREATE INDEX "AccountActivationToken_expiresAt_idx"
  ON "AccountActivationToken"("expiresAt");

-- Deleting the subject takes their pending links with them.
ALTER TABLE "AccountActivationToken"
  ADD CONSTRAINT "AccountActivationToken_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The ISSUER is not deletable while their issuance stands: activation is an authority
-- transfer, and "who let this person in" must remain answerable. RESTRICT, not CASCADE.
ALTER TABLE "AccountActivationToken"
  ADD CONSTRAINT "AccountActivationToken_issuedById_fkey"
  FOREIGN KEY ("issuedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A token is spent once. `consumedAt` only ever goes NULL → a timestamp, and a spent or
-- revoked token can never be un-spent — the service claims it by CAS, and this trigger
-- makes the reverse transition unrepresentable rather than merely unused.
CREATE OR REPLACE FUNCTION account_activation_token_single_use() RETURNS trigger AS $fn$
BEGIN
  IF OLD."consumedAt" IS NOT NULL AND NEW."consumedAt" IS DISTINCT FROM OLD."consumedAt" THEN
    RAISE EXCEPTION 'An activation link is single-use — once redeemed its consumption stands (%)', OLD."id";
  END IF;
  IF OLD."revokedAt" IS NOT NULL AND NEW."revokedAt" IS DISTINCT FROM OLD."revokedAt" THEN
    RAISE EXCEPTION 'A revoked activation link stays revoked (%)', OLD."id";
  END IF;
  -- Redeeming something already withdrawn would defeat the revocation.
  IF OLD."revokedAt" IS NOT NULL AND NEW."consumedAt" IS NOT NULL AND OLD."consumedAt" IS NULL THEN
    RAISE EXCEPTION 'A revoked activation link cannot be redeemed (%)', OLD."id";
  END IF;
  -- Identity is frozen: the subject, the issuer and the secret are what the audit trail
  -- rests on, so a spent row cannot be re-pointed at someone else.
  IF NEW."userId" <> OLD."userId" OR NEW."issuedById" <> OLD."issuedById"
     OR NEW."tokenHash" <> OLD."tokenHash" OR NEW."createdAt" <> OLD."createdAt" THEN
    RAISE EXCEPTION 'An activation link''s identity is frozen — who it is for, who issued it, and which secret (%)', OLD."id";
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AccountActivationToken_single_use" ON "AccountActivationToken";
CREATE TRIGGER "AccountActivationToken_single_use"
  BEFORE UPDATE ON "AccountActivationToken"
  FOR EACH ROW EXECUTE FUNCTION account_activation_token_single_use();

-- Additive and dark: nothing reads or writes this table until the service ships, so the
-- previous release runs unchanged over the migrated schema.
DO $$
DECLARE v_rows bigint;
BEGIN
  SELECT COUNT(*) INTO v_rows FROM "AccountActivationToken";
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'account_activation_tokens: expected a row-free install, found %', v_rows;
  END IF;
END $$;
