-- Internal-live password enrollment: additive credential metadata, durable
-- purpose-bound challenges, and identity-level security events. Existing
-- password hashes and project data are deliberately untouched.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "credentialVersion" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PasswordCredentialChallenge" (
  "id" UUID NOT NULL,
  "userId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "otpHash" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3),
  "setupTokenHash" TEXT,
  "setupTokenExpiresAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordCredentialChallenge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SecurityAuditEvent" (
  "id" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "actorKind" TEXT NOT NULL,
  "correlationId" TEXT NOT NULL,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PasswordCredentialChallenge_setupTokenHash_key"
  ON "PasswordCredentialChallenge"("setupTokenHash");
CREATE INDEX "PasswordCredentialChallenge_userId_purpose_consumedAt_idx"
  ON "PasswordCredentialChallenge"("userId", "purpose", "consumedAt");
CREATE INDEX "PasswordCredentialChallenge_expiresAt_idx"
  ON "PasswordCredentialChallenge"("expiresAt");
CREATE INDEX "SecurityAuditEvent_targetUserId_createdAt_idx"
  ON "SecurityAuditEvent"("targetUserId", "createdAt");
CREATE INDEX "SecurityAuditEvent_actorUserId_createdAt_idx"
  ON "SecurityAuditEvent"("actorUserId", "createdAt");

ALTER TABLE "PasswordCredentialChallenge"
  ADD CONSTRAINT "PasswordCredentialChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecurityAuditEvent"
  ADD CONSTRAINT "SecurityAuditEvent_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SecurityAuditEvent"
  ADD CONSTRAINT "SecurityAuditEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
