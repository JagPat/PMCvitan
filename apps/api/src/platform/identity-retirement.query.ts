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

/**
 * Every account a first Redbracket ID sign-in set aside, oldest first: its id, the address it was retired from (which
 * the person's new linked account now holds) and when. Read by the operator door's list of retired accounts that still
 * hold seats (Redbracket ID A4b); kept beside `isRetired` with the record's platform owner (A4b r2, Codex 4452016253).
 */
export async function retirements(db: Prisma.TransactionClient): Promise<Array<{ userId: string; email: string; retiredAt: Date }>> {
  return db.identityRetirement.findMany({
    select: { userId: true, email: true, retiredAt: true },
    orderBy: [{ retiredAt: 'asc' }, { userId: 'asc' }],
  });
}

/**
 * The account retired from `email` at exactly `at`, if any: the one a first Redbracket ID sign-in replaced in the same
 * transaction that made the new account (retireAndReplace writes one moment as both). Asked by auth's break-glass check.
 */
export async function retiredFrom(db: Prisma.TransactionClient, email: string, at: Date): Promise<{ userId: string } | null> {
  return db.identityRetirement.findFirst({ where: { email, retiredAt: { equals: at } }, select: { userId: true } });
}
