# Internal User Password Enrollment and Reset

**Status:** Approved design
**Date:** 2026-07-15
**Product:** Vitan PMC
**Priority:** Internal-live prerequisite

## 1. Purpose

Every named member of the practice and project team should be able to use a stable email and password after proving control of the invited email address once. Routine sign-in must not depend on repeatedly obtaining an OTP.

The application already supports email/password login for a `User` with a non-null `passwordHash`. It also provisions invited users with a null `passwordHash` and supports email OTP sign-in. What is missing is the secure bridge between those two states: an invited user can prove email ownership, but cannot create or reset a password.

This feature adds that bridge without creating a second identity system or weakening the existing project-membership authorization model.

## 2. Business Outcome

- An administrator adds a named user with a unique email and project role.
- The user verifies that email once by OTP and creates a password.
- The same user subsequently signs in using email and password.
- A forgotten password is recovered through the same verified-email flow.
- Password setup or reset never grants access to an unknown, removed, or uninvited identity.
- Password reset invalidates older sessions.
- Workers remain on the existing QR/device flow.

## 3. Scope

### Included

- Password enrollment for PMC, client, contractor, consultant, and engineer users with an invited email.
- Password reset for those users.
- Purpose-bound email OTP challenges for credential setup/reset.
- A durable, short-lived, single-use setup credential.
- Existing email/password login after enrollment.
- Credential status in team administration: `not_set` or `active` only.
- Safe correction of an unverified invitation email by an organization owner/admin.
- Session invalidation through a credential version.
- Migration and rollout for existing password and passwordless users.

### Not Included

- Passwords for anonymous workers or worker devices.
- Public self-signup.
- Administrator-created or administrator-visible passwords.
- Password sharing, password export, or recovery of an existing password.
- MFA beyond the one-time email verification used for setup/reset.
- Changing a verified email address. That requires a separate dual-verification design.
- Replacing Google sign-in or the transitional phone-OTP path in this slice.

## 4. Eligibility and Authorization

Password setup/reset is identity-scoped, not project-scoped. An eligible user must:

1. already exist in `User` with the normalized requested email;
2. have at least one active `Membership` or qualifying active organization access;
3. not be a worker/device identity; and
4. receive and verify the OTP sent to that same email.

Unknown, removed-only, and uninvited emails receive the same public response as eligible emails but receive no OTP. This prevents account enumeration.

An organization owner/admin may correct an invitation email only while the account has no password and no verified email. A project PMC alone must not change a global `User.email`, because the identity may belong to multiple projects or organizations.

## 5. Chosen Approach

Use a purpose-bound OTP followed by a durable one-time setup token.

The rejected alternatives are:

- OTP sign-in followed by password setup: this grants a full application session before setup completes.
- Administrator-issued temporary password: the administrator knows and must transmit another person's credential.

The chosen approach proves email ownership without granting an application session until the password is committed.

## 6. User Flows

### 6.1 First-Time Setup

1. On the sign-in screen, the user selects **Set up or forgot password**.
2. The user enters the invited email.
3. The client calls `POST /auth/password/request`.
4. The server always returns a generic success response and a request identifier.
5. If eligible, the server stores a password-purpose OTP challenge and emails the code.
6. The user submits the code to `POST /auth/password/verify`.
7. The server consumes the OTP and returns a short-lived, one-time setup token. It does not return an application JWT.
8. The user enters and confirms a new password.
9. The client calls `POST /auth/password/complete` with the setup token and password.
10. The server commits the password, email verification, token consumption, and credential-version increment atomically.
11. The server returns the normal role/project-scoped authentication result and the user enters the application.

### 6.2 Routine Sign-In

1. The user enters email and password.
2. Existing `POST /auth/login` verifies bcrypt and current access.
3. The issued JWT includes the current credential version.
4. Removed memberships and revoked sessions remain denied by live authorization.

### 6.3 Forgotten Password

The user follows the same request, verify, and complete flow. After email ownership is proven, the password is replaced and the credential version increments. Every older JWT then fails live validation.

### 6.4 Existing Phone-Only Engineer

Phone OTP remains a transitional path. The administrator must first add a valid email before the engineer can enroll a password. New named internal users should be created with an email. Workers continue to use QR/device access.

### 6.5 Organization Owner and Administrator

There is no separate administrator identity or login portal. An organization owner/admin uses the same email/password flow as every other named user. After credential verification, the existing access resolver recognizes `OrgMembership.role` of `owner` or `admin`, selects an accessible non-archived project, and issues the project-scoped PMC session used by the current application. Organization controls remain authorized independently from that project role.

The existing owner adds a new administrator to the organization roster. The invited administrator then completes the same one-time OTP/password enrollment. A platform-wide operator who can enter unrelated organizations is not introduced by this feature.

## 7. API Contracts

### `POST /auth/password/request`

Request:

```json
{ "email": "person@example.com" }
```

Response, identical for known and unknown emails:

```json
{ "accepted": true, "requestId": "opaque-public-id" }
```

The response must not reveal account existence, membership status, password status, or delivery outcome.

### `POST /auth/password/verify`

Request:

```json
{ "requestId": "opaque-public-id", "code": "123456" }
```

Success:

```json
{ "setupToken": "one-time-secret", "expiresInSeconds": 600 }
```

All invalid, expired, consumed, or unknown challenges return one generic verification error.

### `POST /auth/password/complete`

Request:

```json
{ "setupToken": "one-time-secret", "password": "the-new-password" }
```

Success returns the existing `AuthResult` shape. Password confirmation is a client-side equality check; the server accepts only the final password once.

### Invitation Email Correction

Add an organization-owner/admin route scoped to the organization and target user. It may update the normalized email only when `passwordHash` and `emailVerifiedAt` are null. It invalidates all outstanding password challenges for that user and writes an attributable audit event.

## 8. Data Model

Extend `User`:

```text
emailVerifiedAt    DateTime?
credentialVersion Int       @default(0)
```

Add a durable challenge model:

```text
PasswordCredentialChallenge
  id                 UUID primary key
  userId             FK User.id
  purpose            'password_setup_or_reset'
  otpHash            text
  attempts           int default 0
  expiresAt           timestamptz
  verifiedAt          timestamptz nullable
  setupTokenHash      text nullable unique
  setupTokenExpiresAt timestamptz nullable
  consumedAt          timestamptz nullable
  createdAt           timestamptz
```

Only hashes of OTPs and setup tokens are stored. Starting a new challenge invalidates earlier unconsumed challenges for the same user and purpose. Expired rows may be removed by scheduled cleanup after a retention period sufficient for security diagnostics.

The migration is additive. Existing password hashes remain untouched. Existing users start at credential version `0`. Existing tokens without a credential-version claim are interpreted as version `0`; after the first setup/reset increments the user to `1`, those tokens become invalid.

## 9. Password and Token Policy

- Password length: 12 to 128 characters.
- No arbitrary uppercase, number, or symbol composition requirement.
- Hash with the existing bcrypt library at an explicitly configured production cost.
- OTP lifetime: 10 minutes.
- Setup-token lifetime: 10 minutes.
- OTP maximum attempts: 5; exceeding the limit consumes/locks the challenge.
- OTP and setup token are single-use.
- Request, verify, and complete endpoints are rate-limited by IP and challenge/user dimensions.
- Logs, analytics, audit payloads, and errors must never contain passwords, OTPs, setup tokens, or their hashes.
- Password-request responses must be timing- and content-consistent enough not to provide a practical account-enumeration signal.

## 10. Session Invalidation

Add `credentialVersion` to authentication JWT claims. `JwtGuard` compares the claim, treating an absent legacy claim as `0`, with the current user's database value during its existing live authorization check.

Password setup/reset increments `credentialVersion` in the same transaction that stores `passwordHash` and consumes the setup token. A newly issued token carries the incremented value. All older tokens fail after the transaction commits.

## 11. UI Design

### Sign-In Screen

Keep email/password as the primary path. Replace **Email me a code instead** with **Set up or forgot password**.

The recovery/setup flow has four focused states:

1. enter email;
2. enter OTP;
3. create and confirm password;
4. success and authenticated entry.

Required states include sending, resend cooldown, invalid/expired code, attempt limit, expired setup token, password mismatch, weak/too-long password, network failure, and successful completion. Error copy remains generic where account existence is sensitive.

### Team Administration

For authorized managers, show only:

- `Password not set`
- `Password active`

Never expose hashes, token state, password age, or reset secrets. Show invitation-email correction only to an organization owner/admin and only before the credential is active.

## 12. Existing Email OTP and Google/Phone Paths

The web application stops presenting email OTP as a routine login alternative. During a short compatibility window, the existing email-OTP backend endpoints may remain available to older cached clients. After the updated web client is deployed and the compatibility window closes, production disables routine email-OTP session issuance; OTP remains available only for password setup/reset.

Google sign-in remains unchanged. Phone OTP remains temporarily available for existing phone-only engineers. Their migration is complete when each named engineer has an invited email and an active password.

## 13. Failure Handling

- Email delivery failure does not change the generic public response. It is recorded internally without secrets.
- A server restart does not lose a valid challenge because challenges are database-backed.
- Concurrent completion attempts have one winner. The challenge update uses a compare-and-set condition on `consumedAt IS NULL`, token hash, and expiry; losers receive the generic expired/used response.
- Password hashing may occur before the short transaction, but the token is revalidated and consumed atomically with the user update.
- A removed user's outstanding challenge cannot complete because active access is rechecked inside the completion transaction.
- Changing an invitation email invalidates prior challenges before the new address can enroll.

## 14. Audit and Events

Record attributable security audit entries without secrets:

- `auth.password_requested` only in protected operational security telemetry, not as a public account-existence signal;
- `auth.password_enrolled`;
- `auth.password_reset`;
- `auth.invitation_email_changed`.

The enrollment/reset event contains user identity, actor kind (`self`), occurred time, and correlation ID, but never email OTP/token/password material. Invitation-email correction records the administrator actor and target user.

These identity events are platform/organization events, not project operational events. They must be classified explicitly in the Phase 2 event and command inventories before the relevant platform tasks close.

## 15. Tests

### API Unit Tests

- Request responses are identical for known, unknown, inactive, and removed-only emails.
- Purpose-bound OTP cannot be reused as a routine login OTP or vice versa.
- OTP attempts, expiry, resend invalidation, and token expiry.
- Password policy and bcrypt verification.
- JWT credential-version behavior, including legacy version `0`.

### PostgreSQL Integration Tests

- Invited active user: request -> verify -> complete -> password login.
- Unknown user receives no challenge and cannot enumerate the account.
- Removed user cannot request or complete.
- Setup token is hashed, single-use, and one-winner under concurrency.
- Password reset invalidates an older JWT and permits the newly issued JWT.
- Completion transaction rolls back fully on injected failure.
- Cross-user, expired, forged, and previously consumed tokens fail.
- Existing password hashes survive the migration and deployment.
- Invitation-email correction is owner/admin-only and blocked after verification.

### Web Tests

- Complete setup and forgot-password flows.
- Password mismatch and policy errors.
- No full session is installed after OTP verification alone.
- Successful completion installs the returned session through the existing atomic auth path.
- Project/user scope changes retire stale setup continuations and toasts.
- Routine login works for engineer and consultant roles after enrollment.
- Worker QR flow is unchanged.

### Acceptance Tests

- An administrator adds a new internal user; that user enrolls once and subsequently logs in by password.
- The same user resets a forgotten password; the old password and old JWT no longer work.
- A removed member cannot use either password or an outstanding setup token.

## 16. Rollout

1. Rotate the previously exposed Coolify and SMTP credentials before exercising live email flows.
2. Back up the production database to durable storage and confirm automated backups.
3. Deploy the additive migration and backend endpoints first.
4. Verify SMTP delivery and generic unknown-email behavior.
5. Deploy the updated web setup/reset flow.
6. Enroll one internal pilot account and verify password login plus reset/session invalidation.
7. Enroll the remaining named internal users.
8. After cached clients drain, disable routine email-OTP session issuance in production.
9. Retain phone OTP only for users still awaiting email migration; workers remain unchanged.

Rollback may hide the new UI and stop accepting new challenges, but must not remove `passwordHash`, `emailVerifiedAt`, or `credentialVersion`. The additive challenge table may remain unused until a corrected deployment.

## 17. Acceptance Criteria

- Every invited active named user with a verified email can establish a password using one OTP flow.
- OTP verification alone never grants an application session.
- Routine sign-in uses email/password and works across all active project memberships.
- Forgot-password uses the same secure flow and invalidates older sessions.
- Unknown or removed identities cannot enroll, reset, or learn whether an account exists.
- Workers remain on QR/device access.
- No existing password or production data is overwritten by migration, seed, or deployment automation.
- Full unit, live-PostgreSQL integration, upgrade-proof, demo e2e, and API-backed e2e gates are green.
