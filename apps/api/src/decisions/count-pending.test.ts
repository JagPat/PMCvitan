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
    expect(await make({ ...rows, architects: 1 }).countPending('p1', { role: 'architect', userId: 'a1', contract: 'countersign-v1' })).toBe(3 + 4);
  });

  it('the PMC counts every pending decision, plus the STRANDED awaiting ones while no architect is active', async () => {
    expect(await make({ ...rows, architects: 0 }).countPending('p1', { role: 'pmc', userId: 'p1', contract: 'countersign-v1' })).toBe(6 + 4);
    // with an active architect the countersigns are the architect's, not the PMC's
    expect(await make({ ...rows, architects: 1 }).countPending('p1', { role: 'pmc', userId: 'p1', contract: 'countersign-v1' })).toBe(6);
  });

  it('every other viewer is unchanged: a client counts the client-held pending decisions only', async () => {
    expect(await make({ ...rows, architects: 0 }).countPending('p1', { role: 'client', userId: 'c1', contract: 'countersign-v1' })).toBe(2);
    expect(await make({ ...rows, architects: 1 }).countPending('p1', { role: 'contractor', userId: 'x1', contract: 'countersign-v1' })).toBe(0);
  });
});

describe('countPending — a reopened decision is awaiting action (#633)', () => {
  it('counts the decisions reopened by a change request with the new ones, for the PMC and for a decider', async () => {
    for (const viewer of [{ role: 'pmc' as const, userId: 'p1' }, { role: 'client' as const, userId: 'c1' }]) {
      const svc = make({ pendingByKind: { client: 1 }, awaiting: 0, architects: 1 });
      await svc.countPending('p1', viewer);
      const count = (svc as unknown as { prisma: { decision: { count: ReturnType<typeof vi.fn> } } }).prisma.decision.count;
      const open = count.mock.calls.map(([a]) => (a as { where: { status: unknown } }).where.status).filter((st) => st !== 'awaiting_countersign');
      expect(open).toEqual([{ in: ['pending', 'change'] }]);
    }
  });
});

describe('countPending — a client below countersign-v1 never counts a row it is not served (Codex 4267480469)', () => {
  const whereOf = async (contract: 'none' | 'recorded-v1' | 'countersign-v1' | undefined) => {
    const svc = make({ pendingByKind: { client: 1 }, awaiting: 0, architects: 1 });
    await svc.countPending('p1', { role: 'pmc', userId: 'p1', contract });
    const count = (svc as unknown as { prisma: { decision: { count: ReturnType<typeof vi.fn> } } }).prisma.decision.count;
    return (count.mock.calls[0][0] as { where: Record<string, unknown> }).where;
  };
  const hidden = {
    OR: [
      { deciderKind: 'architect' },
      { status: 'change', changeRequests: { some: { status: 'open', origin: { not: 'standard' } } } },
    ],
  };

  it('a lesser client leaves out every row the interceptor strips: architect-designated, or reopened by a countersign rejection', async () => {
    for (const contract of ['none', 'recorded-v1', undefined] as const) {
      expect((await whereOf(contract)).NOT).toEqual(hidden);
    }
  });

  it('a countersign-v1 client counts every reopened decision', async () => {
    expect((await whereOf('countersign-v1')).NOT).toBeUndefined();
  });

  it('a lesser client counts no awaiting-countersign row, as the interceptor strips those too (Codex 4268126498)', async () => {
    const rows = { pendingByKind: { client: 2, pmc: 1, member: 0 }, awaiting: 4, architects: 0 };
    expect(await make(rows).countPending('p1', { role: 'pmc', userId: 'p1', contract: 'recorded-v1' })).toBe(3);
    expect(await make(rows).countPending('p1', { role: 'pmc', userId: 'p1', contract: 'countersign-v1' })).toBe(3 + 4);
  });
});
