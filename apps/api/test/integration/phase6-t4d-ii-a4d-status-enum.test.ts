import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { DECISION_STATUSES } from '@vitan/shared';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4d — the status tripwire's DATABASE arm (#652's review, finding
 * 4117568496).
 *
 * The unit tripwire (`src/domain/decision-status-tripwire.test.ts`) compares the runtime list with
 * the Prisma client's enum, which is generated from `schema.prisma`: both sides are source, so a
 * migration that left a value missing or extra in PostgreSQL would still pass it. This arm reads the
 * enum the connected database actually holds, in its declared order.
 */
describe('4d-ii-a / A4d — the runtime status list is the live DecisionStatus enum (live PG)', () => {
  const db = new PrismaClient();
  afterAll(async () => { await db.$disconnect(); });

  it('pg_enum holds exactly the shared DECISION_STATUSES', async () => {
    const rows = await db.$queryRaw<Array<{ label: string }>>`
      SELECT e.enumlabel AS label
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
       WHERE t.typname = 'DecisionStatus'
       ORDER BY e.enumsortorder`;
    expect(rows.length, 'the DecisionStatus type exists').toBeGreaterThan(0);
    expect(rows.map((r) => r.label).sort()).toEqual([...DECISION_STATUSES].sort());
  });
});
