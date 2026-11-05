import { Prisma } from '@prisma/client';

/**
 * Serializes every operation that can establish, reset, or redirect a named
 * user's password credential. The transaction-scoped advisory lock prevents a
 * verified old address and a concurrently corrected invitation address from
 * both becoming authoritative.
 */
export async function lockUserCredential(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'credential:' + userId}, 0))`);
}

/** The purpose of an emailed password setup or reset code (a phone sign-in code has its own purpose). */
export const PASSWORD_SETUP_PURPOSE = 'password_setup_or_reset';

/** The database answered the clock read with no usable time: a transient fault, answered as unavailable (503). */
export class CredentialClockUnreadable extends Error {
  constructor() {
    super('credential clock unreadable');
    this.name = 'CredentialClockUnreadable';
  }
}

/**
 * The database's own clock at this statement (`clock_timestamp()`, not the transaction's start, which can predate a
 * long lock wait). Read after `lockUserCredential` it is the moment a credential write under that lock takes effect:
 * Redbracket ID A4a starts a password completion's lease here, so a completion that waited or paused before its claim
 * never commits a lease that is already over. Reads no table.
 */
export async function credentialClock(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
  const at = rows[0]?.at;
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) throw new CredentialClockUnreadable();
  return at;
}

