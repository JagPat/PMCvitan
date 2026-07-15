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
