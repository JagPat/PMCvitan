import type { Prisma } from '@prisma/client';

/**
 * Redbracket ID — the read of the platform-owned retirement record (`IdentityRetirement`, platform.manifest.ts) that the
 * auth and orgs modules both ask, so neither reads it through the other (A4b r1, Codex 4451627330): auth's sign-in gates
 * and orgs' team adds and last-holder guards depend on this platform read, as orgs already does on `RoleStandingQuery`.
 *
 * Whether this account was set aside by a first Redbracket ID sign-in: the ONE predicate. Every named-account token
 * (`AuthService.issueNamedUser`), the sign-in access rule (`AuthService.signInAccess`, which also decides whether a phone
 * code is sent), password-credential eligibility (`PasswordCredentialsService`), the team adds and the live-holder
 * guards ask it; retirement-gate.test.ts pins the callers. A retired account never signs in or holds a new credential
 * again. Runs on the caller's client, so it joins the caller's transaction.
 */
export async function isRetired(db: Prisma.TransactionClient, userId: string): Promise<boolean> {
  return (await db.identityRetirement.count({ where: { userId } })) > 0;
}
