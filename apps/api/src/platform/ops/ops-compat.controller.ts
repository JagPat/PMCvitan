import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../prisma.service';
import { Public } from '../../common/roles';
import { Throttle, ThrottleGuard } from '../../common/throttle';
import { ZodPipe } from '../../common/zod.pipe';
import { OpsTokenGuard } from './ops-token.guard';

// Zod's offset check admits hours and minutes Date cannot read (`+24:00`, `+02:60`, `+2400`), and an offset can carry year
// 0000 or 9999 past the 4-digit range; such a `since` is refused with the same message as any other malformed one, and
// only after the shape check, so a bad value gets one issue.
// Prisma sends a Date as ISO text, which has no form for a year outside 0000-9999
const ISO_MIN = Date.parse('0000-01-01T00:00:00.000Z');
const ISO_MAX = Date.parse('9999-12-31T23:59:59.999Z');
const finiteInstant = z.string().refine((v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) && t >= ISO_MIN && t <= ISO_MAX;
}, { message: 'Invalid datetime' });
const sinceSchema = z.object({ since: z.string().datetime({ offset: true }).pipe(finiteInstant) }).strict();
type SinceInput = z.infer<typeof sinceSchema>;

/** The eight acts that carry a seen-state pin, by their audit action (#482 seen-state pins). */
export const SEEN_PIN_ACTIONS = [
  'commercial.payment.record', 'commercial.payment.reverse',
  'commercial.deduction.record', 'commercial.deduction.release',
  'commercial.advance.pay',
  'commercial.measurement.take', 'commercial.measurement.correct',
  'commercial.attribution.reattribute',
] as const;

export interface StatePinRow {
  action: string;
  pinned: number;
  absent: number;
  lastPinned: string | null;
  lastAbsent: string | null;
}

/**
 * #482 seen-state pins — `GET /ops/compat/state-pins?since=<ISO>`: for each of the eight pinned commercial acts, how
 * many committed with and without a seen-state pin since `since` (reads only `AuditLog`). Zero absent, with at least
 * one pinned, over 14 days is the condition for making the pin required (RUNBOOK §SSP).
 *
 * The same door as every `/ops` route: {@link OpsTokenGuard} first, then the rate limiter, as on {@link OpsController}
 * and {@link OpsQaController}. A caller without the token is refused (404 closed, 401 wrong token) before the limiter
 * counts it, and its wrong tokens spend the guard's own per-address and global windows, the ones every ops route
 * shares (429 over them).
 */
@Controller('ops')
@UseGuards(OpsTokenGuard, ThrottleGuard)
@Throttle(30, 60_000)
export class OpsCompatController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get('compat/state-pins')
  async statePins(@Query(new ZodPipe(sinceSchema)) query: SinceInput): Promise<{ since: string; actions: StatePinRow[] }> {
    const since = new Date(query.since);
    // grouped by the payload flag, which `groupBy` cannot reach; rows written before the pins existed
    // carry neither value and are counted as neither
    const rows = await this.prisma.$queryRaw<Array<{ action: string; pin: 'present' | 'absent'; n: number; last: Date }>>`
      SELECT "action", "payload"->>'seenPin' AS "pin", COUNT(*)::int AS "n", MAX("at") AS "last"
        FROM "AuditLog"
       WHERE "action" IN (${Prisma.join([...SEEN_PIN_ACTIONS])}) AND "at" >= ${since}
         AND "payload"->>'seenPin' IN ('present', 'absent')
       GROUP BY 1, 2`;
    const actions = SEEN_PIN_ACTIONS.map((action) => {
      const of = (pin: 'present' | 'absent') => rows.find((r) => r.action === action && r.pin === pin);
      return {
        action,
        pinned: of('present')?.n ?? 0,
        absent: of('absent')?.n ?? 0,
        lastPinned: of('present')?.last.toISOString() ?? null,
        lastAbsent: of('absent')?.last.toISOString() ?? null,
      };
    });
    return { since: since.toISOString(), actions };
  }
}
