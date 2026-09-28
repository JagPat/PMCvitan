import { describe, it, expect, vi } from 'vitest';
import { DecisionsQueryService } from './decisions.query';
import type { PrismaService } from '../prisma.service';
import type { OrgsParticipant } from '../orgs/orgs.participant';

/**
 * 4d-ii-a / A5d (§A.1) — `countPending`, the Portfolio tile's count and (from A5d) the project shell's
 * badge, gains the architect role arm and the viewer's COUNTERSIGN obligations: every decision
 * awaiting countersign is an architect's, and while the chain is inactive (the kernel register reads
 * no architect) each one is STRANDED and the PMC's to resolve.
 */
function make(rows: { pendingByKind: Record<string, number>; awaiting: number; architects: number }) {
  const count = vi.fn(async ({ where }: { where: { status: string; OR?: Array<{ deciderKind: string }> } }) => {
    if (where.status === 'awaiting_countersign') return rows.awaiting;
    const kinds = where.OR ? where.OR.map((o) => o.deciderKind) : Object.keys(rows.pendingByKind);
    return kinds.reduce((n, k) => n + (rows.pendingByKind[k] ?? 0), 0);
  });
  const prisma = {
    decision: { count },
    $queryRawUnsafe: vi.fn(async () => [{ n: rows.architects }]),
  };
  return new DecisionsQueryService(prisma as unknown as PrismaService, {} as OrgsParticipant);
}

describe('countPending — the architect arm and the countersign obligations (4d-ii-a / A5d)', () => {
  const rows = { pendingByKind: { client: 2, pmc: 1, architect: 3, member: 0 }, awaiting: 4 };

  it('an ARCHITECT counts the pending decisions designated to the role AND every countersign owed', async () => {
    expect(await make({ ...rows, architects: 1 }).countPending('p1', { role: 'architect', userId: 'a1' })).toBe(3 + 4);
  });

  it('the PMC counts every pending decision, plus the STRANDED awaiting ones while no architect is active', async () => {
    expect(await make({ ...rows, architects: 0 }).countPending('p1', { role: 'pmc', userId: 'p1' })).toBe(6 + 4);
    // with an active architect the countersigns are the architect's, not the PMC's
    expect(await make({ ...rows, architects: 1 }).countPending('p1', { role: 'pmc', userId: 'p1' })).toBe(6);
  });

  it('every other viewer is unchanged: a client counts the client-held pending decisions only', async () => {
    expect(await make({ ...rows, architects: 0 }).countPending('p1', { role: 'client', userId: 'c1' })).toBe(2);
    expect(await make({ ...rows, architects: 1 }).countPending('p1', { role: 'contractor', userId: 'x1' })).toBe(0);
  });
});
