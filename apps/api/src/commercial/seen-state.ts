import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Seen-state pins (#482) — the state a screen showed when an act was made, compared under the lock
 * that serializes the write.
 *
 * The value travels in a HEADER, never in the body, and that is the whole compatibility story. The
 * body of every pinned command is byte-identical to an unpinned one, so its request hash is
 * unchanged and an op committed before this unit still replays. An older API never reads the
 * header, so rolling the API back lands a phone's queued pinned op as today's unpinned act rather
 * than refusing it — a `.strict()` body field would have turned every such op into a 400 the web
 * drops as terminal. CORS sets no `allowedHeaders` (`app-setup.ts`), so the preflight reflects it.
 *
 * Optional: an absent header runs the act exactly as before, and its audit row says so
 * (`seenPin: 'absent'`), which is what the ops read counts to know when it can be required.
 */
export const SEEN_STATE_HEADER = 'x-vitan-seen-state';

const COUNT = /^(0|[1-9][0-9]{0,15})$/u;
// every attribution id is a Prisma `cuid()`: a count sent to the id route is unreadable, not a stale id
const ID = /^c[a-z0-9]{20,31}$/u;

/** Parse the header for one command: a revision or count (`count`), or a row id (`id`). Absent is
 *  `undefined`; a value that is present but malformed can only come from a build that sends the
 *  header, so it is refused rather than ignored — ignoring it would run the act unpinned. */
export function seenState(raw: string | undefined, kind: 'count'): number | undefined;
export function seenState(raw: string | undefined, kind: 'id'): string | undefined;
export function seenState(raw: string | undefined, kind: 'count' | 'id'): number | string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (kind === 'id' && ID.test(value)) return value;
  if (kind === 'count' && COUNT.test(value) && Number.isSafeInteger(Number(value))) return Number(value);
  throw new BadRequestException("This entry's screen state could not be read. Reload and try again.");
}

/** The audit payload every pinned act writes, so the ops read can tell the two kinds of send apart. */
export function seenPinPayload(seen: number | string | undefined): { seenPin: 'present' | 'absent' } {
  return { seenPin: seen === undefined ? 'absent' : 'present' };
}

/**
 * The claim's revision, read in its OWN statement after the bill lock.
 *
 * Not the `LEFT JOIN` inside `lockBill`'s `FOR UPDATE OF b`: after a lock wait PostgreSQL re-checks
 * only the locked row, and the joined revision comes from the snapshot taken before the wait. A
 * separate statement under READ COMMITTED takes its snapshot after the lock was granted, so it sees
 * every commit that held the lock first — which is what makes the comparison authoritative, rather
 * than whichever coarser lock a writer happens to take.
 */
export async function claimRevision(tx: Prisma.TransactionClient, projectId: string, billId: string): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ revision: number }>>`
    SELECT "revision" FROM "VendorBillRevision"
     WHERE "projectId" = ${projectId} AND "billId" = ${billId}`;
  return rows[0]?.revision ?? 0;
}

export const ADVANCE_MOVED = 'Another advance to this vendor was recorded after your screen loaded, so this one may repeat it. Reload, check the advances, and pay again if it is still needed.';
export const MEASUREMENTS_MOVED = "This line's measurements changed after your screen loaded, so this entry may repeat one already recorded. Reload and try again.";
export const ATTRIBUTION_MOVED = "This line's cost head was changed after your screen loaded. Reload and try again.";

/** A pinned value against the one read under the lock. `undefined` is the unpinned send. */
export function assertSeen(pinned: number | string | undefined, actual: number | string, message: string): void {
  if (pinned !== undefined && pinned !== actual) throw new ConflictException(message);
}
