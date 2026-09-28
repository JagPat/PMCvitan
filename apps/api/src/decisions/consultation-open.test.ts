import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DECISION_STATUSES } from '@vitan/shared';
import { CONSULTATION_OPEN_STATUSES, consultationOpen } from './consultation-open';

/**
 * 4d-ii-a / A4d — the consultation open set (#652's review, finding 4117700813). The service's
 * eligibility carve-out and the request push's claim read ONE set, and it is the set the database's
 * consultation seals admit, so a consultation on an approval awaiting countersign is neither
 * refused by the service while the seals admit it nor dropped at the push's claim.
 */
const SEALS = join(__dirname, '..', '..', 'prisma', 'migrations',
  '20271227000000_phase6_t4d_ii_consultation_finalized_cycle', 'migration.sql');

describe('the consultation open set (4d-ii-a / A4d)', () => {
  it('is exactly the set both database consultation seals admit', () => {
    const sets = [...readFileSync(SEALS, 'utf8').matchAll(/d\.status NOT IN \(([^)]*)\)/g)]
      .map((m) => [...m[1]!.matchAll(/'(\w+)'/g)].map((x) => x[1]!).sort());
    expect(sets.length, 'the request seal and the response seal').toBe(2);
    for (const set of sets) expect(set).toEqual([...CONSULTATION_OPEN_STATUSES].sort());
  });

  it('answers every status: open while the question is (pending, change, awaiting countersign), closed otherwise', () => {
    expect(DECISION_STATUSES.filter(consultationOpen).sort()).toEqual(['awaiting_countersign', 'change', 'pending']);
  });
});
