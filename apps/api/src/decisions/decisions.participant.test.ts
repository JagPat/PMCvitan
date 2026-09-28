import { describe, it, expect, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { DecisionsParticipant } from './decisions.participant';

/**
 * 4d-ii-a / A5d (§A.2, P39) — the decisions-owned open-holder answer: the delivered open set
 * (`pending`/`change`) now answers the ARCHITECT role designation too, and a SEPARATE awaiting-countersign
 * set answers 4d-i's widened guard, kept apart so the last architect's exemption can apply to it alone.
 */
describe('DecisionsParticipant.holdsOpenDecisions (4d-ii-a / A5d)', () => {
  it('answers both open sets, each over every role designation including architect', async () => {
    const wheres: unknown[] = [];
    const tx = {
      decision: {
        count: vi.fn(async ({ where }: { where: { status: unknown } }) => { wheres.push(where); return where.status === 'awaiting_countersign' ? 1 : 0; }),
        findMany: vi.fn(async ({ where }: { where: { status: unknown } }) => {
          wheres.push(where);
          return where.status === 'awaiting_countersign' ? [{ deciderKind: 'client' }] : [{ deciderKind: 'architect' }];
        }),
      },
    } as unknown as Prisma.TransactionClient;
    const answer = await new DecisionsParticipant().holdsOpenDecisions(tx, { projectId: 'p1', membershipId: 'm1' });
    expect(answer).toEqual({ named: false, heldRoles: ['architect'], namedAwaiting: true, awaitingRoles: ['client'] });
    // every read is of PUBLISHED decisions; the role reads name all three role designations
    for (const w of wheres as Array<{ publishedAt: unknown; deciderKind?: unknown }>) {
      expect(w.publishedAt).toEqual({ not: null });
      if (w.deciderKind) expect(w.deciderKind).toEqual({ in: ['client', 'pmc', 'architect'] });
    }
    expect(wheres).toContainEqual(expect.objectContaining({ status: { in: ['pending', 'change'] } }));
    expect(wheres).toContainEqual(expect.objectContaining({ status: 'awaiting_countersign' }));
  });
});
