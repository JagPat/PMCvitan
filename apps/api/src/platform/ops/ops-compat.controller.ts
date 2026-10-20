import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../prisma.service';
import { Public } from '../../common/roles';
import { Throttle, ThrottleGuard } from '../../common/throttle';
import { ZodPipe } from '../../common/zod.pipe';
import { OpsTokenGuard } from './ops-token.guard';

const sinceSchema = z.object({ since: z.string().datetime({ offset: true }) }).strict();
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
 * Its own controller so the door guard runs BEFORE the rate limiter, as on {@link OpsQaController} (Codex P2 on
 * #1020): a caller without the token is refused (404 closed, 401 wrong token) and never spends the operator's limit.
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
