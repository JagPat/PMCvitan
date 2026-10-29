import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma.service';

/**
 * Idempotency-Key Unit 2a (notes/idempotency-key/u2/plan.md §2) — the count that tells when the five routes below may
 * refuse a missing key (Unit 2b). Unit 1 (#1240) sends a keyless act an earlier release stored under a `legacy-` key,
 * so a request on these routes with no key, or with a `legacy-` key, means an earlier-release tab, a plain-http
 * address, or a stored act from before the keys is still being sent. 2b opens only after 7 days with none of either.
 *
 * Each route's handler calls {@link recordKeySighting} as its first statement, before the replay check, any read or
 * the command's own transaction, so a request the route then refuses is counted too. A request with any other key
 * writes nothing. The write is one upsert in its own short transaction, bounded by `statement_timeout`, outside the
 * command's transaction and lock order; it locks only the counter's row for that route, class and UTC day. It is
 * telemetry, not a gate: a write that fails is logged by its error's name and code and the command runs as before.
 *
 * Read through the operator door: `GET /ops/compat/client-keys` (RUNBOOK §IDK). Its end: 2b removes these calls when
 * it starts refusing, and a migration-only unit then drops the table (plan §6).
 */

/** The five routes, each by the command type the ledger runs it under (the table's CHECK holds exactly these). */
export const SIGHTED_COMMANDS = [
  'activities.start', 'activities.complete', 'inspections.decide', 'daily-log.flagMismatch', 'daily-log.submit',
] as const;
export type SightedCommand = (typeof SIGHTED_COMMANDS)[number];

/** The two classes counted (the table's CHECK holds exactly these). */
export const SIGHTING_CLASSES = ['absent', 'legacy'] as const;
export type SightingClass = (typeof SIGHTING_CLASSES)[number];

/** Unit 1's prefix for the key of a keyless act an earlier release stored (web `legacyActKey`). */
export const LEGACY_KEY_PREFIX = 'legacy-';

/** The bound on the counter's one statement; past it the write is abandoned and the command runs regardless. */
export const SIGHTING_STATEMENT_TIMEOUT_MS = 2_000;

const log = new Logger('CommandKeySighting');

/** `absent` for no key or an all-whitespace one (the ledger's own rule: such a header is no key), `legacy` for a
 *  Unit 1 key, and null for any other key, which is never counted. */
export function sightingClass(idempotencyKey: string | null | undefined): SightingClass | null {
  const key = idempotencyKey?.trim() || null;
  if (!key) return 'absent';
  return key.startsWith(LEGACY_KEY_PREFIX) ? 'legacy' : null;
}

/** Count this request when it carries no key or a legacy one. Never throws. */
export async function recordKeySighting(
  prisma: PrismaService,
  commandType: SightedCommand,
  idempotencyKey: string | null | undefined,
): Promise<void> {
  const cls = sightingClass(idempotencyKey);
  if (cls === null) return;
  // `day` and `lastAt` are UTC, sent as text with no zone so the session's TimeZone never shifts them (`lastAt` is
  // `timestamp(3)`, like every Prisma DateTime column)
  const iso = new Date().toISOString(); // 2026-10-29T11:08:02.123Z
  const day = iso.slice(0, 10);
  const lastAt = `${iso.slice(0, 10)} ${iso.slice(11, 23)}`;
  try {
    await prisma.$transaction([
      prisma.$executeRaw`SELECT pg_catalog.set_config('statement_timeout', ${String(SIGHTING_STATEMENT_TIMEOUT_MS)}, true)`,
      prisma.$executeRaw`
        INSERT INTO public."CommandKeySighting" AS s ("route", "class", "day", "count", "lastAt")
        VALUES (${commandType}, ${cls}, ${day}::date, 1, ${lastAt}::timestamp(3))
        ON CONFLICT ("route", "class", "day") DO UPDATE
          SET "count" = s."count" + 1, "lastAt" = GREATEST(s."lastAt", EXCLUDED."lastAt")`,
    ]);
  } catch (e) {
    const code = e instanceof Prisma.PrismaClientKnownRequestError ? e.code : (e as { code?: unknown })?.code;
    log.warn(`not counted: ${commandType} ${cls} (${e instanceof Error ? e.name : typeof e}${typeof code === 'string' ? ` ${code}` : ''})`);
  }
}
