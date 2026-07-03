import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeSnapshot(partial?: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Residence at Ambli, Ahmedabad', short: 'Residence at Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB-24', projStart: '12 Jan 2026', projEnd: '30 Sep 2026', elapsedPct: 58, todayDay: 32, milestonePct: 72 },
    decisions: [],
    activities: [],
    checklist: null,
    review: null,
    reinspectionCreated: false,
    dailyLog: null,
    notifications: [{ text: 'SERVER applied', time: 'just now', color: '#3F7A54' }],
    ...partial,
  };
}

beforeEach(() => {
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

describe('Phase 7b write-cutover — API mode routes mutations through the gateway', () => {
  it('confirmApprove calls the gateway and reconciles from the returned snapshot', async () => {
    const snap = makeSnapshot({
      decisions: [{ id: 'DL-014', title: 'Living Room Flooring', room: 'Ground Floor · Living', status: 'approved', photoSwatch: 'marble', options: [], approver: 'Mr. Shah', material: 'Italian Marble (Botticino)', date: '03 Jul 2026', cost: 140000 }],
    });
    const gw = { approveDecision: vi.fn().mockResolvedValue(snap) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().openApprove('DL-014', 1);
    s().confirmApprove();
    await flush();

    expect(gw.approveDecision).toHaveBeenCalledWith('DL-014', 1);
    expect(s().decisions.find((d) => d.id === 'DL-014')?.status).toBe('approved');
    expect(s().notifications[0].text).toBe('SERVER applied'); // snapshot applied
    expect(s().modal.type).toBeNull(); // modal closed
  });

  it('startActivity / flagMismatch route through the gateway with the right args', async () => {
    const startGw = { startActivity: vi.fn().mockResolvedValue(makeSnapshot()) };
    s()._setGateway(startGw as unknown as ApiGateway);
    s().startActivity('ACT-31');
    await flush();
    expect(startGw.startActivity).toHaveBeenCalledWith('ACT-31');

    // flagMismatch resolves the material index to its decisionId (DL-014)
    const flagGw = { flagMismatch: vi.fn().mockResolvedValue(makeSnapshot()) };
    s()._setGateway(flagGw as unknown as ApiGateway);
    s().flagMismatch(0);
    await flush();
    expect(flagGw.flagMismatch).toHaveBeenCalledWith('DL-014');
  });

  it('without a gateway (default), confirmApprove still mutates the local store', () => {
    s().openApprove('DL-014', 1);
    s().confirmApprove();
    expect(s().decisions.find((d) => d.id === 'DL-014')?.status).toBe('approved');
  });
});
