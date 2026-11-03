/**
 * Redbracket ID A3 — which PMC account an issuer person is, under the Board's fresh-join rule (31 Oct 2026, 22:08 IST):
 * Hub and PMC join fresh. No old PMC password or hash goes to the issuer; an old `User` row is never attached to an
 * issuer person because the email matches; an issuer person who already has an email is never taken over.
 *
 * So, for an issuer person (`issuer`, `sub`) who has just proved their password at the issuer:
 *
 * - already linked to a PMC account: that account. A password sign-in (`IdentitySignInService.login`) also needs the
 *   typed email to name that same account, with the credential version it had before the issuer proved the password.
 * - an unlinked PMC account holds the same email and was never set up (an invitation: no password, mailbox never
 *   proved): it is linked only on the invitation's own acceptance (`acceptInvite`, after PMC's emailed code), never on
 *   a plain sign-in, which refuses with `invite-pending`.
 * - an unlinked PMC account holds the same email and was set up before Redbracket ID: it is RETIRED (its email set
 *   aside as `<email>#retired-<id>`, a record kept so an operator can undo it; its work and memberships stay where they
 *   are), and a NEW account is made for this person and linked. The new account holds no project: roles stay in PMC's
 *   Membership and an operator or the company's PMC seats it. A token claim is never a role.
 * - a retired account never signs in again by any door (phone, emailed code, Google, password, a code already sent):
 *   `AuthService.signInAccess` refuses it (`isRetired`), so nothing it held comes back through the old row.
 * - a test account address (`qa.*@vitan.in`) is never retired or linked: test accounts sign in through the operator door.
 * - no PMC account holds the email: nothing is made (PMC sign-up stays by invitation).
 *
 * Every write runs in the caller's transaction under the person's lock, then the account's credential lock, in that
 * order everywhere, so two first sign-ins of one person make one account.
 */
import { Prisma, type User } from '@prisma/client';
import { lockUserCredential } from '../../common/credential-lock';
import { OrgsParticipant, QA_ACCOUNT_EMAIL } from '../../orgs/orgs.participant';
import type { IdClaims } from './id-token';

export type Settled =
  | { kind: 'account'; user: User; fresh: boolean }
  | { kind: 'no-account' }
  | { kind: 'invite-pending' }
  | { kind: 'test-account' }
  | { kind: 'email-unverified' };

const orgs = new OrgsParticipant();

/** The person's lock: every link decision for one issuer person runs one at a time. Taken before any account lock. */
export async function lockIssuerPerson(tx: Prisma.TransactionClient, issuer: string, sub: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity-person:${issuer} ${sub}`}, 0))`);
}

/** The account this issuer person is linked to, or null. */
export async function linkedAccount(tx: Prisma.TransactionClient, issuer: string, sub: string): Promise<User | null> {
  const link = await tx.platformPersonLink.findUnique({ where: { issuer_subject: { issuer, subject: sub } }, select: { userId: true } });
  return link ? orgs.accountById(tx, link.userId) : null;
}

/** The issuer person an account is linked to, or null. */
export async function linkOf(tx: Prisma.TransactionClient, userId: string): Promise<{ issuer: string; subject: string } | null> {
  return tx.platformPersonLink.findUnique({ where: { userId }, select: { issuer: true, subject: true } });
}

// The ONE predicate lives with the record's platform owner (A4b r1, Codex 4451627330); auth asks it from there.
export { isRetired } from '../../platform/identity-retirement.query';
import { retiredFrom } from '../../platform/identity-retirement.query';

/**
 * The PMC password hash a break-glass sign-in checks for `user` (the account now holding the typed email): its own,
 * or, for an account a first Redbracket ID sign-in made, the hash of the account it replaced (that account is retired:
 * it never signs in itself, its email is set aside and its hash is never changed again, nor sent anywhere). Null when
 * there is none. Who may use break-glass is still decided on `user` (its own company owner or admin standing).
 */
export async function breakGlassHash(db: Prisma.TransactionClient, user: Pick<User, 'id' | 'email' | 'passwordHash' | 'createdAt'>): Promise<string | null> {
  if (user.passwordHash) return user.passwordHash;
  // only an account a first sign-in made (linked at `signup`), and only the retirement made in that same transaction
  // (retireAndReplace writes one moment as the retirement's `retiredAt` and this account's `createdAt`)
  const link = await db.platformPersonLink.findUnique({ where: { userId: user.id }, select: { matchedOn: true } });
  if (!user.email || link?.matchedOn !== 'signup') return null;
  const replaced = await retiredFrom(db, user.email, user.createdAt);
  if (!replaced) return null;
  return (await orgs.accountById(db, replaced.userId))?.passwordHash ?? null;
}

/** An account that was never set up: no password and its mailbox never proved (an invitation not yet accepted). */
export function neverSetUp(user: Pick<User, 'passwordHash' | 'emailVerifiedAt'>): boolean {
  return !user.passwordHash && !user.emailVerifiedAt;
}

/**
 * The account a plain sign-in lands on (see the file comment). Must run inside a transaction; takes the person's lock
 * and, when it retires an account, that account's credential lock.
 */
export async function settleSignIn(tx: Prisma.TransactionClient, issuer: string, claims: IdClaims, correlationId?: string): Promise<Settled> {
  await lockIssuerPerson(tx, issuer, claims.sub);
  const linked = await linkedAccount(tx, issuer, claims.sub);
  if (linked) return { kind: 'account', user: linked, fresh: false };
  if (!claims.email || !claims.emailVerified) return { kind: 'email-unverified' };
  const holder = await orgs.accountByAddress(tx, { email: claims.email });
  if (!holder) return { kind: 'no-account' };
  if (QA_ACCOUNT_EMAIL.test(holder.email ?? '')) return { kind: 'test-account' };
  await lockUserCredential(tx, holder.id);
  // re-read under the account's lock: an invitation accepted meanwhile is now linked (and is this person's only if
  // the link says so, which the person's lock above already decided)
  const current = await orgs.accountById(tx, holder.id);
  if (!current || current.email !== claims.email) return { kind: 'no-account' };
  if (await linkOf(tx, current.id)) return { kind: 'no-account' };
  if (neverSetUp(current)) return { kind: 'invite-pending' };
  const fresh = await retireAndReplace(tx, issuer, claims, current, correlationId);
  return { kind: 'account', user: fresh, fresh: true };
}

/**
 * Sets an established pre-Redbracket account aside and makes this person a new one, linked (`signup`). The old
 * account keeps its id, work and memberships; only its email moves aside (so the address is free for the new
 * account) and its credential version moves on (so its open sessions end).
 */
async function retireAndReplace(tx: Prisma.TransactionClient, issuer: string, claims: IdClaims, old: User, correlationId?: string): Promise<User> {
  const email = claims.email;
  // one moment, written on both rows: breakGlassHash finds this retirement from the new account by it
  const at = new Date();
  await tx.identityRetirement.create({ data: { userId: old.id, email, retiredAt: at } });
  await tx.user.update({
    where: { id: old.id },
    data: { email: `${email}#retired-${old.id}`, credentialVersion: { increment: 1 } },
  });
  const name = [claims.givenName, claims.familyName].filter((part) => part && part !== '-').join(' ').trim() || old.name;
  // `projectId`/`role` are the legacy, non-authoritative columns every account carries (they never grant access;
  // the sign-in rule reads Membership and OrgMembership only), copied so the row is well formed
  // the issuer vouched for the mailbox (`email_verified`), so the new account is set up from its first moment: it is
  // never mistaken for an invitation nobody accepted (whose address an owner may still correct)
  const fresh = await tx.user.create({ data: { projectId: old.projectId, role: old.role, name, email, emailVerifiedAt: at, createdAt: at } });
  await tx.platformPersonLink.create({ data: { userId: fresh.id, issuer, subject: claims.sub, matchedOn: 'signup' } });
  // the security trail names what happened to whom: the old account set aside, replaced by the new one; on a password
  // setup it carries that setup's code id, as the new account's own event does
  await tx.securityAuditEvent.create({
    data: { action: 'auth.identity_retired', targetUserId: old.id, actorUserId: fresh.id, actorKind: 'self', correlationId: correlationId ?? fresh.id, payload: { replacedBy: fresh.id } },
  });
  return fresh;
}

/**
 * Links an invitation's account to the issuer person on the invitation's own acceptance (PMC's emailed code proved
 * the mailbox, and the person proved or set their issuer password). Must run inside a transaction, after
 * `lockIssuerPerson` and the account's credential lock. False when the person is already linked to another account.
 */
export async function linkInvite(tx: Prisma.TransactionClient, issuer: string, sub: string, userId: string): Promise<boolean> {
  const taken = await tx.platformPersonLink.findUnique({ where: { issuer_subject: { issuer, subject: sub } }, select: { userId: true } });
  if (taken) return taken.userId === userId;
  await tx.platformPersonLink.create({ data: { userId, issuer, subject: sub, matchedOn: 'invite' } });
  return true;
}
