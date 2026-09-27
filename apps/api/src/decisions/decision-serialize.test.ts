import { describe, it, expect } from 'vitest';
import { serializeDecision, type DecisionRow } from './decision-serialize';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4a — the DTO's `approvalCycle` counts FINALIZED approvals, the
 * number every consultation's frozen `openCycle` is compared with (`viewerIsConsultee` on the server
 * and the client, the projection's fold). A provisional approval awaiting countersign has not ended
 * the cycle. The live-PostgreSQL arms are in `phase6-t4d-ii-a4a-consultation-cycle.test.ts`.
 */
const row = (approvalRevisions: Array<{ version: number; finalized: boolean }>, consulted = true): DecisionRow =>
  ({
    id: 'd1', projectId: 'p1', title: 'Counter', room: 'Kitchen', nodeId: null, status: 'pending',
    publishedAt: new Date('2026-09-01T00:00:00Z'), ageDays: null, photoSwatch: null,
    deciderKind: 'client', deciderMembershipId: null, deciderMembership: null,
    approvedOption: null, material: null, approver: null, onBehalfOf: null, date: null, cost: null,
    changeRequests: [], withdrawnAt: null, withdrawnByName: null, withdrawReason: null,
    options: [{ id: 'o1', optionKey: 'a', label: 'A', material: 'Granite', delta: 0, swatch: 's', photoUrl: null, recommended: true }],
    consultations: consulted
      ? [{
          id: 'c1', consulteeMembershipId: 'm1', consulteeUserId: 'u1', requestedById: 'u0', question: 'Q?',
          openCycle: 0, requestedAt: new Date('2026-09-02T00:00:00Z'), response: null,
        }]
      : [],
    approvalRevisions,
  }) as unknown as DecisionRow;

describe('serializeDecision — the approval cycle (4d-ii-a / A4a)', () => {
  it('counts finalized approvals only: a provisional one leaves the cycle where it was', () => {
    expect(serializeDecision(row([{ version: 1, finalized: false }])).approvalCycle).toBe(0);
    expect(serializeDecision(row([{ version: 1, finalized: true }, { version: 2, finalized: false }])).approvalCycle).toBe(1);
  });

  it('a finalized approval ends the cycle, as before the chain', () => {
    expect(serializeDecision(row([{ version: 1, finalized: true }, { version: 2, finalized: true }])).approvalCycle).toBe(2);
  });

  it('a decision with no thread still carries neither consultation key', () => {
    const dto = serializeDecision(row([{ version: 1, finalized: true }], false));
    expect('approvalCycle' in dto).toBe(false);
    expect('consultations' in dto).toBe(false);
  });
});
