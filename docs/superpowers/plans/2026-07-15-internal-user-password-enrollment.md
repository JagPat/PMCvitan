# Internal User Password Enrollment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let every invited, active named user establish or reset a password after one email OTP while preserving project authorization, invalidating old sessions, and leaving worker/device access unchanged.

**Architecture:** Add a database-backed, purpose-bound password challenge service beside the legacy email-OTP service. The challenge service proves email ownership without issuing an application session, atomically consumes a short-lived setup token while setting the bcrypt hash and incrementing a credential version, then delegates to the existing `AuthService` for the normal project-scoped session. The web store exposes a three-step setup/reset flow and installs authentication only after password completion.

**Tech Stack:** NestJS 11, Prisma 6/PostgreSQL, bcryptjs, Zod, JWT, React 19, Zustand/Immer, Vitest, Supertest, Playwright.

## Global Constraints

- Invite-only: unknown, inactive, and removed-only emails receive the same public request response and no credential.
- Password policy is 12 to 128 characters; use the existing bcrypt library at cost 12.
- OTP and setup-token lifetimes are 10 minutes; OTP challenges allow at most 5 attempts.
- Store only an HMAC of the OTP and SHA-256 hash of the high-entropy setup token.
- OTP verification never returns or installs an application JWT.
- Password completion, setup-token consumption, email verification, credential-version increment, and security audit event are one transaction.
- Existing password hashes remain unchanged; existing users and JWTs begin at credential version `0`.
- Named roles use this flow; worker/device tokens remain on the existing QR path.
- Google and transitional phone OTP remain unchanged; routine email OTP disappears from the web UI only.
- Public errors and responses never expose whether an email, membership, password, or delivery target exists.
- No password, OTP, setup token, or hash may enter logs, audit payloads, analytics, or client persistence.

---

### Task 1: Durable Password Credential Core

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20261012000000_internal_password_enrollment/migration.sql`
- Modify: `apps/api/src/contracts.ts`
- Modify: `apps/api/src/auth/email.service.ts`
- Create: `apps/api/src/auth/password-credentials.service.ts`
- Create: `apps/api/src/auth/password-credentials.service.test.ts`
- Modify: `apps/api/src/app.module.ts`

**Interfaces:**
- Consumes: `PrismaService`, `EmailService.sendPasswordCredentialCode(email, code)`, `resolveJwtSecret()`.
- Produces: `PasswordCredentialsService.request(input)`, `verify(input)`, and `complete(input)`; `complete` initially returns the updated user and is connected to session issuance in Task 2.

- [ ] **Step 1: Add failing contract and service tests**

Cover identical request responses, eligible-only delivery, resend invalidation, five-attempt lockout, expiry, purpose separation, setup-token hashing, 12–128 password policy, removed-user recheck, audit secrecy, and one-winner completion. Use a deterministic clock and crypto seam in the service test:

```ts
const clock = { now: () => new Date('2026-07-15T10:00:00.000Z') };
const secrets = {
  otp: () => '123456',
  setupToken: () => 'setup-token-with-at-least-32-random-bytes',
};

expect(await service.request({ email: 'member@example.com' })).toEqual({
  accepted: true,
  requestId: expect.any(String),
});
expect(await service.request({ email: 'unknown@example.com' })).toEqual({
  accepted: true,
  requestId: expect.any(String),
});
expect(email.sendPasswordCredentialCode).toHaveBeenCalledTimes(1);

const verified = await service.verify({ requestId, code: '123456' });
expect(verified).toEqual({ setupToken: expect.any(String), expiresInSeconds: 600 });
expect(verified).not.toHaveProperty('token');
```

- [ ] **Step 2: Run the focused test and confirm the red state**

Run: `pnpm --filter api test -- src/auth/password-credentials.service.test.ts`

Expected: FAIL because `PasswordCredentialsService`, schemas, and Prisma delegates do not exist.

- [ ] **Step 3: Add the additive schema and diagnostic-safe migration**

Add these Prisma fields/models without rewriting existing credentials:

```prisma
model User {
  // existing fields stay unchanged
  emailVerifiedAt    DateTime?
  credentialVersion Int                           @default(0)
  passwordChallenges PasswordCredentialChallenge[]
  securityEvents     SecurityAuditEvent[]          @relation("SecurityEventTarget")
  securityActorEvents SecurityAuditEvent[]         @relation("SecurityEventActor")
}

model PasswordCredentialChallenge {
  id                  String    @id @default(uuid()) @db.Uuid
  userId              String
  user                User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  purpose             String
  otpHash             String
  attempts            Int       @default(0)
  expiresAt           DateTime
  verifiedAt          DateTime?
  setupTokenHash      String?   @unique
  setupTokenExpiresAt DateTime?
  consumedAt          DateTime?
  createdAt           DateTime  @default(now())

  @@index([userId, purpose, consumedAt])
  @@index([expiresAt])
}

model SecurityAuditEvent {
  id           String   @id @default(uuid()) @db.Uuid
  action       String
  targetUserId String
  targetUser   User     @relation("SecurityEventTarget", fields: [targetUserId], references: [id], onDelete: Restrict)
  actorUserId  String?
  actorUser    User?    @relation("SecurityEventActor", fields: [actorUserId], references: [id], onDelete: SetNull)
  actorKind    String
  correlationId String
  payload      Json?
  createdAt    DateTime @default(now())

  @@index([targetUserId, createdAt])
  @@index([actorUserId, createdAt])
}
```

The SQL migration must use `ADD COLUMN IF NOT EXISTS`, defaults `credentialVersion` to `0`, creates both new tables and indexes, and never updates `passwordHash`.

- [ ] **Step 4: Add exact API contracts**

```ts
export const passwordCredentialRequestSchema = z.object({
  email: z.string().email().transform((value) => value.trim().toLowerCase()),
});
export const passwordCredentialVerifySchema = z.object({
  requestId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});
export const passwordCredentialCompleteSchema = z.object({
  setupToken: z.string().min(32).max(256),
  password: z.string().min(12).max(128),
});
```

- [ ] **Step 5: Add delivery without reusing the legacy in-memory OTP store**

Add `EmailService.sendPasswordCredentialCode(email: string, code: string): Promise<{ live: boolean; devCode?: string }>` using the existing SMTP transport. It must send the supplied code, return `devCode` only outside production when SMTP is absent, and never place this code in `OtpStore`.

- [ ] **Step 6: Implement the minimal durable service**

Use `createHmac('sha256', resolveJwtSecret())` for `${challengeId}:${code}`, `timingSafeEqual` for OTP comparison, `randomInt(100000, 1000000)` for production OTP generation, `randomBytes(32).toString('base64url')` for setup tokens, SHA-256 for setup-token storage, and bcrypt cost 12. Completion uses one interactive transaction:

```ts
const claimed = await tx.passwordCredentialChallenge.updateMany({
  where: {
    id: challenge.id,
    consumedAt: null,
    verifiedAt: { not: null },
    setupTokenHash,
    setupTokenExpiresAt: { gt: now },
  },
  data: { consumedAt: now },
});
if (claimed.count !== 1) throw genericCredentialError();

const eligible = await this.findEligibleUser(tx, challenge.userId);
if (!eligible) throw genericCredentialError();

const user = await tx.user.update({
  where: { id: challenge.userId },
  data: {
    passwordHash,
    emailVerifiedAt: now,
    credentialVersion: { increment: 1 },
  },
});
await tx.securityAuditEvent.create({
  data: {
    action: challenge.user.passwordHash ? 'auth.password_reset' : 'auth.password_enrolled',
    targetUserId: user.id,
    actorUserId: user.id,
    actorKind: 'self',
    correlationId: challenge.id,
  },
});
return user;
```

Request returns a synthetic UUID even when no durable row is created. Delivery errors are logged only as a correlation ID and error class; the public response stays `{ accepted: true, requestId }`.

- [ ] **Step 7: Generate Prisma and run focused tests**

Run: `pnpm --filter api prisma:generate && pnpm --filter api test -- src/auth/password-credentials.service.test.ts src/auth/email.service.test.ts`

Expected: all focused tests PASS and generated Prisma accepts both models.

- [ ] **Step 8: Commit the credential core**

```bash
git add apps/api/prisma apps/api/src/contracts.ts apps/api/src/auth/email.service.ts apps/api/src/auth/password-credentials.service.ts apps/api/src/auth/password-credentials.service.test.ts apps/api/src/app.module.ts
git commit -m "feat(auth): add durable password credential challenges"
```

---

### Task 2: Session Issuance, Live Revocation, and Public Endpoints

**Files:**
- Modify: `apps/api/src/auth/auth.service.ts`
- Modify: `apps/api/src/auth/auth.service.test.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/auth/auth.controller.test.ts`
- Modify: `apps/api/src/common/auth.ts`
- Modify: `apps/api/src/common/project-access.service.ts`
- Modify: `apps/api/src/common/project-access.service.test.ts`
- Create: `apps/api/test/integration/password-credentials.test.ts`
- Modify: `apps/api/test/integration/global-route-authz.test.ts`

**Interfaces:**
- Consumes: `PasswordCredentialsService.complete(input)` and the updated `User.credentialVersion`.
- Produces: public `/auth/password/request`, `/verify`, `/complete`; every named-user JWT carries `credentialVersion`; guard rejects stale versions.

- [ ] **Step 1: Write failing auth and PostgreSQL integration tests**

Test the full request → verify → complete → login chain, no JWT after verify, old-password rejection after reset, old-JWT rejection, absent legacy claim accepted only while DB version is `0`, concurrent completion with exactly one success, removed-user request/completion denial, migration preservation, and public-route metadata.

```ts
const request = await http.post('/auth/password/request').send({ email }).expect(201);
const verify = await http.post('/auth/password/verify').send({
  requestId: request.body.requestId,
  code: deliveredCode,
}).expect(201);
expect(verify.body.token).toBeUndefined();

const completed = await http.post('/auth/password/complete').send({
  setupToken: verify.body.setupToken,
  password: 'a long internal passphrase',
}).expect(201);
expect(completed.body.token).toEqual(expect.any(String));
```

- [ ] **Step 2: Run focused API tests and confirm they fail**

Run: `pnpm --filter api test -- src/auth/auth.service.test.ts src/auth/auth.controller.test.ts src/common/project-access.service.test.ts`

Expected: FAIL because JWT claims, endpoints, and version checks are not connected.

- [ ] **Step 3: Make named-user session issuance carry the credential version**

Change the central issuer to sign:

```ts
type NamedUserClaims = {
  sub: string;
  role: string;
  projectId: string;
  orgId?: string;
  credentialVersion: number;
};

return { token: this.jwt.sign(claims), role, projectId };
```

Every password, email-OTP, Google, phone-account, switch-project, and real dev-account path must load and pass the current version. Worker/device tokens retain `worker: true` and do not require a `User` row. Expose `AuthService.signInUser(user)` for `PasswordCredentialsService` to call after its transaction commits.

- [ ] **Step 4: Add the live credential-version check**

Extend `AuthUser` with `credentialVersion?: number` and `worker?: boolean`. Before project or identity authorization, call:

```ts
async assertCredentialVersion(user: AuthUser): Promise<void> {
  if (user.worker) return;
  const row = await this.prisma.user.findUnique({
    where: { id: user.sub },
    select: { credentialVersion: true },
  });
  if (!row || row.credentialVersion !== (user.credentialVersion ?? 0)) {
    throw new UnauthorizedException('Session expired');
  }
}
```

The guard must apply this to both identity-scoped and project-scoped named-user routes. Synthetic dev users may bypass only when not production and the subject starts with `dev-`.

- [ ] **Step 5: Wire the three public endpoints**

Inject `PasswordCredentialsService` into `AuthController`. Apply `@Public()` and per-IP throttles of 5 requests, 15 verifies, and 10 completions per 10 minutes. `complete` calls the credential service, then `AuthService.signInUser(updatedUser)`; `verify` returns only setup-token fields.

- [ ] **Step 6: Run unit and live PostgreSQL tests**

Run:

```bash
pnpm --filter api test -- src/auth/auth.service.test.ts src/auth/auth.controller.test.ts src/common/project-access.service.test.ts src/auth/password-credentials.service.test.ts
pnpm --filter api test:integration -- test/integration/password-credentials.test.ts test/integration/global-route-authz.test.ts
```

Expected: all focused unit and integration tests PASS, including one winner in the concurrent completion probe.

- [ ] **Step 7: Commit session invalidation and endpoints**

```bash
git add apps/api/src/auth apps/api/src/common apps/api/test/integration
git commit -m "feat(auth): enroll passwords and revoke stale sessions"
```

---

### Task 3: Setup and Forgot-Password Web Flow

**Files:**
- Modify: `packages/shared/src/domain/types.ts`
- Modify: `apps/web/src/data/apiGateway.ts`
- Modify: `apps/web/src/store/store.ts`
- Modify: `apps/web/src/screens/TeamAccessScreen.tsx`
- Modify: `apps/web/tests/auth.test.ts`
- Modify: `apps/web/tests/apiGateway.test.ts`
- Modify: `apps/web/e2e-api/auth.spec.ts`

**Interfaces:**
- Consumes: the three Task 2 endpoints and existing `applyAuthResult` project-scope generation guard.
- Produces: `password-email`, `password-code`, and `password-create` access states and a routine password login UI.

- [ ] **Step 1: Add failing gateway, store, and UI tests**

Assert the login link says `Set up or forgot password`, request stores only `requestId`, verification stores only `setupToken`, no auth state changes before completion, mismatch/policy failures remain local, completion uses `applyAuthResult`, stale continuations after reset/scope movement do nothing, and worker access is unchanged.

```ts
await s().requestPasswordSetup('member@example.com');
expect(s().access.step).toBe('password-code');
expect(s().auth).toBeNull();

await s().verifyPasswordSetup('123456');
expect(s().access.step).toBe('password-create');
expect(s().auth).toBeNull();

await s().completePasswordSetup('a long internal passphrase', 'a long internal passphrase');
expect(s().auth?.token).toBe('new-token');
```

- [ ] **Step 2: Run focused web tests and confirm they fail**

Run: `pnpm --filter web test -- tests/auth.test.ts tests/apiGateway.test.ts`

Expected: FAIL because the password-setup states and gateway calls do not exist.

- [ ] **Step 3: Add typed access state and gateway methods**

Extend `AccessStep` with `'password-email' | 'password-code' | 'password-create'`. Add nullable `passwordRequestId` and `passwordSetupToken` fields, clearing both in every access reset and successful authentication.

Add gateway methods with exact response types:

```ts
passwordCredentialRequest(email: string): Promise<{ accepted: true; requestId: string }>;
passwordCredentialVerify(requestId: string, code: string): Promise<{ setupToken: string; expiresInSeconds: number }>;
passwordCredentialComplete(setupToken: string, password: string): Promise<AuthResult>;
```

- [ ] **Step 4: Implement scope-safe store actions**

Each action captures the access-flow generation before awaiting. Increment that generation on `accReset`, sign-out, and every new request. A stale response must not change step, token, errors, toast, or project state. `completePasswordSetup` validates equality and 12–128 length before network access, then passes the result through the existing `applyAuthResult` path.

- [ ] **Step 5: Replace routine email OTP UI with password enrollment/reset**

Keep email/password first. Replace the link text and render three focused screens: invited email, six-digit code, create/confirm password. Show a resend action only on the code screen, use `autocomplete="email"`, `autocomplete="one-time-code"`, and `autocomplete="new-password"`, and keep the setup token out of visible copy and browser storage.

- [ ] **Step 6: Run web tests and API-backed acceptance**

Run:

```bash
pnpm --filter web test -- tests/auth.test.ts tests/apiGateway.test.ts
pnpm --filter web test:e2e:api -- --grep "password enrollment|password reset|worker access"
```

Expected: focused unit tests and three acceptance paths PASS; OTP verification alone never changes the authenticated route.

- [ ] **Step 7: Commit the setup/reset UI**

```bash
git add packages/shared/src/domain/types.ts apps/web/src/data/apiGateway.ts apps/web/src/store/store.ts apps/web/src/screens/TeamAccessScreen.tsx apps/web/tests apps/web/e2e-api
git commit -m "feat(web): add password setup and recovery flow"
```

---

### Task 4: Credential Status, Invitation Correction, and Release Proof

**Files:**
- Modify: `apps/api/src/orgs/members.service.ts`
- Modify: `apps/api/src/orgs/members.service.test.ts`
- Modify: `apps/api/src/orgs/orgs.service.ts`
- Modify: `apps/api/src/orgs/orgs.service.test.ts`
- Modify: `apps/api/src/orgs/orgs.controller.ts`
- Modify: `apps/api/src/contracts.ts`
- Modify: `packages/shared/src/domain/types.ts`
- Modify: `apps/web/src/data/apiGateway.ts`
- Modify: `apps/web/src/store/store.ts`
- Modify: `apps/web/src/screens/TeamScreen.tsx`
- Modify: `apps/web/tests/team.test.tsx`
- Modify: `apps/api/test/integration/password-credentials.test.ts`
- Modify: `apps/web/e2e-api/auth.spec.ts`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes: `User.passwordHash`, `User.emailVerifiedAt`, outstanding password challenges, and `SecurityAuditEvent`.
- Produces: `credentialState: 'not_set' | 'active'` on project/org roster DTOs and owner/admin-only invitation-email correction.

- [ ] **Step 1: Add failing authorization and UI tests**

Test that rosters expose only `not_set`/`active`; project PMC cannot change a global email; org owner/admin can correct an unverified invitation; duplicate email, verified email, and active password are refused; challenges are invalidated and a secret-free `auth.invitation_email_changed` event records actor and target.

```ts
await expect(service.correctInvitationEmail(orgId, adminId, targetId, {
  email: 'corrected@example.com',
})).resolves.toMatchObject({
  email: 'corrected@example.com',
  credentialState: 'not_set',
});
expect(securityEvents[0]).toMatchObject({
  action: 'auth.invitation_email_changed',
  actorUserId: adminId,
  targetUserId: targetId,
});
```

- [ ] **Step 2: Run focused tests and confirm they fail**

Run: `pnpm --filter api test -- src/orgs/members.service.test.ts src/orgs/orgs.service.test.ts && pnpm --filter web test -- tests/team.test.tsx`

Expected: FAIL because roster status and email correction do not exist.

- [ ] **Step 3: Add status and the owner/admin correction transaction**

Return `credentialState: user.passwordHash ? 'active' : 'not_set'` from both roster services. Add `PATCH /orgs/:orgId/members/:userId/invitation-email` with `{ email }`. Inside one transaction, recheck caller role owner/admin, target membership in that org, `passwordHash === null`, `emailVerifiedAt === null`, update normalized email, consume outstanding challenges, and insert the security event. Translate Prisma uniqueness failure to `409 Conflict` without revealing another identity.

- [ ] **Step 4: Add restrained roster UI**

Show `Password active` or `Password not set` next to each named user. Show the correction command only in the org roster for owner/admin viewers and only when `credentialState === 'not_set'`; submit a confirmed normalized email and refresh the roster. Do not display OTP, challenge, password age, or token details.

- [ ] **Step 5: Run the complete verification battery**

Run all commands by exit code:

```bash
pnpm check
pnpm --filter api test:integration
pnpm --filter web test:e2e
pnpm --filter web test:e2e:api
pnpm --filter api build
git diff --check
```

Expected: every command exits `0`; the migration applies to a populated fixture without changing existing `passwordHash`; all existing Phase 1 and Phase 2 characterization tests remain green.

- [ ] **Step 6: Record rollout and commit**

Update the roadmap with the delivered credential flow and these operator prerequisites: rotate the exposed Coolify root token and `SMTP_PASS`, copy the database backup from container `/tmp` to durable storage, confirm daily automated backups, deploy API/migration before web, pilot one internal account, then enroll the remaining named users.

```bash
git add apps/api apps/web packages/shared docs/ROADMAP.md
git commit -m "feat(admin): expose credential readiness safely"
```

---

## Final Review Checklist

- [ ] Request responses are structurally identical for eligible, unknown, inactive, and removed-only emails.
- [ ] Setup OTPs cannot authenticate through legacy email-OTP endpoints.
- [ ] Verifying an OTP cannot create a project session.
- [ ] Exactly one concurrent completion wins, with no partial password/audit/token state.
- [ ] Reset invalidates old JWTs and old passwords while the returned JWT works.
- [ ] Existing hashes and all construction/project data survive migration and seed scripts.
- [ ] Worker QR, Google, phone OTP, project switching, and org-admin project resolution still pass their existing tests.
- [ ] Team screens reveal only credential readiness, never secrets or security metadata.
- [ ] Public logs and errors contain no email-existence signal or credential material.
- [ ] Production rollout remains blocked until external secrets and backups are corrected.
