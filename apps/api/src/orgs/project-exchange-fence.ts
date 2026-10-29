import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * #1177 VT2-B — the fence between a project's archive and the external exchanges made on its behalf (a voice note sent
 * to its speech provider). A holder takes the SHARED side for one short exchange; the archive takes the EXCLUSIVE side
 * before it writes `archivedAt`. Advisory locks queue in order: once an archive waits, a holder that comes later waits
 * behind it, so back-to-back exchanges cannot keep an archive waiting without end, and holders never wait on each
 * other. The project's row itself is not locked, so no other writer of that row waits on an exchange.
 *
 * LOCK ORDER: both sides take the fence FIRST in their transaction, holding no other lock. The archive therefore waits
 * holding nothing (no org key, no anchor: nothing else in the org queues behind it), and once it has the fence, every
 * lock it takes next is one no fence waiter holds. A holder takes its other locks only after the fence.
 *
 * pg_advisory_xact_lock(_shared) releases automatically at COMMIT/ROLLBACK.
 */
export function projectExchangeFenceKey(projectId: string): string {
  return 'project-exchange-fence:' + projectId;
}

/** How long an archive waits for the exchanges in flight before it answers 409. A holder's transaction is bounded well
 *  inside this (one exchange of at most 20 s), so the wait ends in time unless a holder breaks its bound. */
export const PROJECT_EXCHANGE_FENCE_WAIT_MS = 45_000;
/** The archive's transaction bound: the fence wait and the archive's own writes, inside Prisma's interactive timeout. */
export const PROJECT_ARCHIVE_TX_TIMEOUT_MS = 60_000;
export const PROJECT_EXCHANGES_BUSY = 'A voice note on this project is being sent right now. Try again in a minute.';

/** The holder's side: shared, so two exchanges on one project never wait on each other. */
export async function holdProjectExchangeFence(tx: Prisma.TransactionClient, projectId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${projectExchangeFenceKey(projectId)}, 0))`);
}

/** The archive's side: exclusive, so it waits out every exchange in flight and none starts until it ends. The wait is
 *  bounded (`lock_timeout`, this statement only); past it the archive is the caller's 409 and changes nothing. */
export async function closeProjectExchangeFence(tx: Prisma.TransactionClient, projectId: string, waitMs = PROJECT_EXCHANGE_FENCE_WAIT_MS): Promise<void> {
  // the transaction's own lock_timeout is kept aside in the session (this transaction only) and put back after
  await tx.$executeRaw(Prisma.sql`SELECT pg_catalog.set_config('vitan.fence_lock_timeout_before', pg_catalog.current_setting('lock_timeout'), true)`);
  await tx.$executeRaw(Prisma.sql`SELECT pg_catalog.set_config('lock_timeout', ${`${Math.max(1, Math.trunc(waitMs))}ms`}, true)`);
  try {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${projectExchangeFenceKey(projectId)}, 0))`);
  } catch (e: unknown) {
    if (e instanceof Error && /55P03|could not obtain lock|lock timeout/i.test(e.message)) throw new ConflictException(PROJECT_EXCHANGES_BUSY);
    throw e;
  }
  await tx.$executeRaw(Prisma.sql`SELECT pg_catalog.set_config('lock_timeout', pg_catalog.current_setting('vitan.fence_lock_timeout_before'), true)`);
}
